/**
 * lib/taste.mjs —— 主动了解他：问喜好 + 调整自己的人格
 * ============================================================================
 * 需求（2026-10-20）：
 *   「能够在日常对话中适当地主动问我一些喜好，并调整你自己的人格」
 *
 * 两个动作，两套节流：
 *   A. `ask_taste`  —— 主动问一个还没问过的喜好
 *   B. `tune_persona` —— 根据观察到的偏好，微调人格参数
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么需要节流（这是这个功能唯一的难点）
 * ════════════════════════════════════════════════════════════════════════
 * 「主动问喜好」这个需求，做砸的方式只有一种：变成查户口。
 *   ——「你最喜欢什么颜色？」「你平时喜欢吃什么？」「你周末都干什么？」
 * 三句话之后他就不想聊了。所以硬约束：
 *
 *   ① **一次只问一个**，而且必须挂在当前话题上（不是凭空发问）
 *   ② **每天最多 N 次**（默认 2）
 *   ③ **两次之间至少隔 M 小时**（默认 6）
 *   ④ **已经问过的话题永不重复**（问过就记下，从候选里划掉）
 *   ⑤ 他明确说过「别问了」「烦」→ **立刻停用一段时间**
 *   ⑥ 他在忙 / 情绪不好 / 刚被打断过 → 这一轮不问
 *
 * ════════════════════════════════════════════════════════════════════════
 * 人格调整的安全边界
 * ════════════════════════════════════════════════════════════════════════
 * 她能改的是 `persona.md` 里那张可调参数表（名字/称呼/亲昵度/口癖/自称/表情频率/
 * 安慰方式/技术口吻）。**核心块正文她不能直接改** —— 那是身份与铁律，
 * 要改必须人在设置页里改。
 *
 * 每次改都记进 `persona-changes.json`，可回滚、可追溯。
 * ============================================================================
 */
import { stamp, dayKey } from './home.mjs'
import { inQuietHours } from './companion.mjs'

/** 可被她调整的参数（白名单 —— 不在这张表里的一律拒绝）。 */
export const TUNABLE = {
  persona_name: { label: '她的名字', kind: 'text', max: 12 },
  pet_name: { label: '她对你的称呼', kind: 'text', max: 12, knob: '亲昵程度最大的旋钮' },
  intimacy: { label: '亲昵程度', kind: 'enum', values: ['低', '中', '高'] },
  catchphrase: { label: '口癖', kind: 'text', max: 30 },
  self_ref: { label: '自称', kind: 'text', max: 8 },
  emoji_level: { label: '表情频率', kind: 'enum', values: ['不用', '偶尔一个', '常用'] },
  reassure_style: { label: '他难受时怎么处理', kind: 'text', max: 30 },
  technical_tone: { label: '技术回答的口吻', kind: 'text', max: 30 },
}

/** 她**不能**碰的东西 —— 这些要人在设置页里改。 */
export const LOCKED = [
  '核心块正文（# 你是谁 / 怎么说话 / 边界 那几节）',
  '铁律（对 > 甜 那一整段）',
  '扩展设定里的样例',
]

export const ASK_TOPICS = [
  { id: 'communication', label: '沟通口味', prompt: '喜欢先听结论还是先听过程' },
  { id: 'tools', label: '工具偏好', prompt: '习惯用什么工具、什么语言' },
  { id: 'rhythm', label: '作息', prompt: '什么时候最清醒、什么时候不想被打扰' },
  { id: 'taboo', label: '雷区', prompt: '有什么事让他特别烦' },
  { id: 'comfort', label: '安慰方式', prompt: '难受的时候希望被怎么对待' },
  { id: 'work', label: '在做的项目', prompt: '手头在做什么' },
  { id: 'likes', label: '喜欢的东西', prompt: '真正喜欢、会主动去做的事' },
  { id: 'dislikes', label: '不喜欢的东西', prompt: '明确讨厌的事' },
]

const STATE_DEFAULT = {
  /** 已经问过的话题 id */
  asked: [],
  /** 上次问的时间 */
  lastAskAt: 0,
  /** 今天问了几次 */
  day: '',
  todayCount: 0,
  /** 他叫停的时间（在那之后暂时不问） */
  mutedUntil: 0,
  /** 上一次问的原话（避免措辞重复） */
  lastAskText: '',
  /** 累计了解到多少条偏好（给界面看进度） */
  learned: 0,
}

export function normalizeTasteState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const out = { ...STATE_DEFAULT }
  out.asked = Array.isArray(s.asked) ? s.asked.filter((x) => typeof x === 'string') : []
  out.lastAskAt = Number(s.lastAskAt) || 0
  out.day = typeof s.day === 'string' ? s.day : ''
  out.todayCount = Number(s.todayCount) || 0
  out.mutedUntil = Number(s.mutedUntil) || 0
  out.lastAskText = typeof s.lastAskText === 'string' ? s.lastAskText : ''
  out.learned = Number(s.learned) || 0
  return out
}

/**
 * 现在能不能问一句？ —— 纯函数，不碰磁盘不碰网络。
 *
 * @returns {{allow:boolean, reason:string, topic?:object}}
 */
export function canAsk({ cfg, state, now = new Date(), hasMood = true }) {
  const s = normalizeTasteState(state)
  const t = now.getTime()

  if (cfg.tasteAskEnabled === false) return { allow: false, reason: '主动问喜好关着' }
  if (t < s.mutedUntil) {
    const mins = Math.ceil((s.mutedUntil - t) / 60000)
    return { allow: false, reason: `他说过先别问了，还有 ${mins} 分钟` }
  }
  if (!hasMood) return { allow: false, reason: '还没有可参考的情绪信号' }

  // 安静时段不问
  if (cfg.quietStart && cfg.quietEnd && inQuietHours(now, cfg.quietStart, cfg.quietEnd)) {
    return { allow: false, reason: '安静时段' }
  }

  /**
   * 先看「还有没有话题可问」再看额度。
   *
   * ⚠️ 顺序是有讲究的：话题问尽是一个**永久状态**，额度用完只是**今天**的事。
   *    如果先报额度，用户看到的是「今天已经问了 8 次」，会以为明天还能继续问；
   *    实际上该问的全问过了，明天也不会再问。先报真实原因。
   */
  const left = ASK_TOPICS.filter((x) => !s.asked.includes(x.id))
  if (!left.length) return { allow: false, reason: '该问的都问过了（话题已用尽）', exhausted: true }

  // 每天上限
  const day = dayKey(now)
  const count = s.day === day ? s.todayCount : 0
  const max = Math.max(0, Number(cfg.tasteAskPerDay) || 0)
  if (max > 0 && count >= max) return { allow: false, reason: `今天已经问了 ${count} 次` }

  // 最小间隔（小时）
  const gapMs = Math.max(0, Number(cfg.tasteAskMinGapHours) || 0) * 3600_000
  if (gapMs && s.lastAskAt && t - s.lastAskAt < gapMs) {
    const leftH = Math.ceil((gapMs - (t - s.lastAskAt)) / 3600_000)
    return { allow: false, reason: `距离上次问还不到间隔（还要 ${leftH} 小时）` }
  }

  return { allow: true, reason: '可以问', topic: left[0], remaining: left.length }
}

/** 记一次「问过了」。 */
export function recordAsk(state, { topicId, text, now = new Date() }) {
  const s = normalizeTasteState(state)
  const day = dayKey(now)
  if (s.day !== day) { s.day = day; s.todayCount = 0 }
  s.todayCount += 1
  s.lastAskAt = now.getTime()
  s.lastAskText = String(text || '').slice(0, 200)
  if (topicId && !s.asked.includes(topicId)) s.asked.push(topicId)
  return s
}

/** 他叫停了 —— 停用一段时间（默认 24 小时）。 */
export function mute(state, hours = 24, now = new Date()) {
  const s = normalizeTasteState(state)
  s.mutedUntil = now.getTime() + Math.max(1, hours) * 3600_000
  return s
}

/* ───────────────────── 人格参数读写 ───────────────────── */

/** 从 markdown 里读出参数表当前值。 */
export function readParams(markdown) {
  const src = String(markdown || '')
  const out = {}
  for (const key of Object.keys(TUNABLE)) {
    const re = new RegExp(`\\|\\s*\`?${key}\`?\\s*\\|\\s*([^|]*?)\\s*\\|`)
    const m = re.exec(src)
    if (m) out[key] = m[1].trim()
  }
  return out
}

/** 校验一个参数改动，返回 {ok, value|error}。 */
export function validateChange(key, value) {
  const spec = TUNABLE[key]
  if (!spec) {
    return { ok: false, error: `"${key}" 不在可调范围内。能调的只有：${Object.keys(TUNABLE).join(' / ')}` }
  }
  const v = String(value ?? '').trim()
  if (!v) return { ok: false, error: '值不能为空' }
  if (spec.kind === 'enum') {
    if (!spec.values.includes(v)) {
      return { ok: false, error: `"${key}" 只能是：${spec.values.join(' / ')}` }
    }
    return { ok: true, value: v }
  }
  if (v.length > spec.max) return { ok: false, error: `"${key}" 最多 ${spec.max} 个字（现在是 ${v.length}）` }
  // 防注入：不允许塞换行、表格分隔符、markdown 标题
  if (/[\n\r|#]/.test(v)) return { ok: false, error: `"${key}" 不能包含换行、竖线或 #` }
  return { ok: true, value: v }
}

/**
 * 改一个参数并写回 markdown。**只改表格那一行**，其余一个字节都不动。
 * @returns {{ok:boolean, markdown?:string, old?:string, error?:string}}
 */
export function applyParam(markdown, key, value) {
  const v = validateChange(key, value)
  if (!v.ok) return { ok: false, error: v.error }

  const src = String(markdown || '')
  if (!src.trim()) return { ok: false, error: 'persona.md 是空的' }

  const before = readParams(src)
  const old = before[key] ?? ''
  if (old === v.value) return { ok: true, markdown: src, old, unchanged: true }

  // 只替换这一行的「当前值」列
  const re = new RegExp(`(\\|\\s*\`?${key}\`?\\s*\\|\\s*)([^|]*?)(\\s*\\|)`)
  if (!re.test(src)) {
    return { ok: false, error: `persona.md 里找不到 ${key} 这一行（参数表被改过？）` }
  }
  const next = src.replace(re, `$1${v.value}$3`)
  return { ok: true, markdown: next, old }
}

/* ───────────────────── 改动日志（可回滚） ───────────────────── */

export function emptyChanges() {
  return { rows: [] }
}

export function recordChange(changes, row) {
  const c = changes && Array.isArray(changes.rows) ? changes : emptyChanges()
  c.rows = [{
    at: Date.now(),
    stamp: stamp(),
    kind: String(row.kind || 'tune'),
    key: String(row.key || ''),
    from: String(row.from ?? ''),
    to: String(row.to ?? ''),
    why: String(row.why || '').slice(0, 200),
    by: String(row.by || 'self'),
  }, ...c.rows].slice(0, 60)
  return c
}
