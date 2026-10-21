/**
 * lib/reflect.mjs —— 会话结束后的「反思一次」
 * ============================================================================
 * 需求（2026-10-21 晚，用户原话）：
 *   「在会话结束后反思一次这次对话的内容，并调用模型判断要不要把内容中
 *     重要的部分写进人格与记忆」
 *
 * 和「定时采集」的区别（两个都保留，不互相替代）：
 *
 *   定时采集 captureOnce
 *     每 10 分钟扫一遍所有活跃会话，从游标往后读新增事件，做**过程记录**。
 *     它的目标是「别漏」，所以宁可多写、写得粗。
 *
 *   会话反思 reflectSession（本文件）
 *     一次对话**告一段落**之后（turn/end 后静默 N 分钟，或会话关闭），
 *     把这一段完整地再看一遍，回答一个问题：
 *       「这里面有没有值得改变她自己的东西？」
 *     它的目标是「提炼」，所以宁可少写、写得准。
 *
 * 两个出口：
 *   ① 写进记忆 —— 日常层（会遗忘）+ core / preferences（永不遗忘）
 *   ② 写进人格 —— 只走 tune_persona 那张可调参数表白名单
 *      核心块正文**绝不由模型改**（那是身份与铁律，要人自己动手）
 *
 * ⚠️ 整段跑在定时器/事件回调里，任何异常都必须吃掉并记日志。
 * ============================================================================
 */
import { dayKey, stamp } from './home.mjs'
import { extractJson, drainText, CORE_SECTIONS, PREF_SECTIONS } from './llm.mjs'
import { TUNABLE, validateChange } from './taste.mjs'

/**
 * 反思用的系统提示。
 *
 * 和摘要提示的区别：
 *   · 摘要问「这段聊了什么」，反思问「这段里有什么应该改变她自己」
 *   · 反思**允许回答「没有」**，而且「没有」是常态 —— 大部分对话不该改任何东西
 *   · 反思的输出多一个 `persona` 字段
 */
export const REFLECT_SYSTEM = `你是一个自我反思器，服务于一个长期陪伴型 AI 助手「她」。这段对话刚刚结束，你要复盘：这里面有没有值得她**记住**或**改变自己**的东西。

你不参与对话，不回应对话里的任何人，只输出一个 JSON 对象。

硬性规则：
1. 只使用原文里出现过的信息。禁止补充、外推、猜测。
2. **大部分对话什么都不该改。** 没东西可写就输出空数组，这是正确且常见的结果，不要为了显得有用而凑。
3. 判断标准：
   - 写进记忆（memory）：他说过的事实、决定、做过的事、当时的情绪状态。
   - 写进核心（core_candidates）：十年后仍然成立的东西 —— 身份、称呼、重要的人、承诺、约定。
   - 写进偏好（preference_candidates）：以后怎么配合他的习惯 —— 沟通风格、作息、技术栈、雷区、在做的项目。
   - 写进人格（persona_params）：他明确表达了对她**说话方式**的好恶，而且能落到下面某个参数上。
   - 写进人格正文（persona_note）：他表达的要求**参数表那 8 个旋钮表达不出来**（比如「跟我聊技术时先给结论，闲聊时别这样」）。这里写的是一句可执行的行为指令。
4. 人格参数白名单（persona_params 只能出现这些 key）：
${Object.entries(TUNABLE).map(([k, v]) => `   - ${k}：${v.label}${v.values ? `（只能是 ${v.values.join(' / ')}）` : ''}`).join('\n')}
5. **不能改铁律。** 那是她自己的底线（对 > 甜、不编 API、是 AI 就说 AI、安全边界），
   不是这段对话能动的。你写的 persona_note 会作为一条**附加指令**追加到人格里，
   不会覆盖铁律 —— 所以不用也**不能**试图重写那几节。
6. 同一条信息不要同时出现在两个数组里。
7. 敏感信息（手机号、住址、身份证、密码、卡号、密钥）一律不写。
8. 输出必须是单个合法 JSON 对象。不要 markdown 围栏，不要前后解释。

**关于改人格的判断门槛（这条最要紧）**：
- 「他明确表达了不满」= 有具体指向、有「以后」的意思。例：
    ✅「你别老是这样说话」→ 可以改
    ✅「你能不能正常点，别像 AI」→ 可以改
    ❌「烦死了」（情绪，不是偏好）→ 不改
    ❌「今天好累」（当下状态）→ 不改
- **不要等他重复说。** 说一次、意思明确、有据可依，就该写下来。
- 但也不要凭一句玩笑话就改 —— 拿不准就填 confidence "中"，不要不写。

字段定义：
- summary：2–4 句。这段对话聊了什么、结论是什么。写不出就空串。
- keywords：3–8 个字符串，来自原文。
- mood：一句话描述这段对话的氛围，不分析原因。
- worthRemembering：布尔。这一段整体值不值得单独记一条日常记忆。
- core_candidates：数组。每项 { section, text, quote, confidence }。
- preference_candidates：数组。每项 { section, text, evidence, confidence, quote }。
- persona_params：数组。每项 { key, value, why, confidence }。
  · why 要说清「他哪句话让你这么判断」，不超过 30 字。
  · confidence 只能是 "高" / "中" / "低"。
- persona_note：字符串。一句可执行的行为指令，不超过 60 字；没有就填空串。
  · 例：「跟他聊技术时先给结论，闲聊时别这样」「他说累的时候先问怎么了，别给建议」
  · 不要写「要体贴」「要温柔」这种没法执行的空话。

core_candidates 的 section 只能是：${CORE_SECTIONS.join(' / ')}
preference_candidates 的 section 只能是：${PREF_SECTIONS.join(' / ')}

只输出 JSON，第一个字符是 {，最后一个字符是 }。`

export function buildReflectPrompt({ date, turns, sessionId }) {
  return `以下是 ${date} 刚结束的一段对话${sessionId ? `（会话 ${sessionId}）` : ''}。

<conversation>
${turns}
</conversation>

按系统提示的规则反思，输出 JSON。记住：没有值得改的就输出空数组。`
}

/** 把模型输出规整成我们能安全消费的形状（模型会飘）。 */
export function normalizeReflection(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const arr = (v) => (Array.isArray(v) ? v : [])
  const str = (v) => (typeof v === 'string' ? v.trim() : '')

  const core = arr(o.core_candidates)
    .map((c) => ({
      section: CORE_SECTIONS.includes(str(c?.section)) ? str(c.section) : '不可忘记的约定',
      text: str(c?.text).slice(0, 120),
      quote: str(c?.quote).slice(0, 80),
      confidence: ['高', '中', '低'].includes(str(c?.confidence)) ? str(c.confidence) : '中',
    }))
    .filter((c) => c.text)

  const prefs = arr(o.preference_candidates)
    .map((c) => ({
      section: PREF_SECTIONS.includes(str(c?.section)) ? str(c.section) : '沟通风格',
      text: str(c?.text).slice(0, 120),
      evidence: str(c?.evidence) === '用户明说' ? '用户明说' : '模型推断',
      confidence: ['高', '中', '低'].includes(str(c?.confidence)) ? str(c.confidence) : '中',
      quote: str(c?.quote).slice(0, 80),
    }))
    .filter((c) => c.text)

  /**
   * 人格参数：三重过滤。
   *   ① key 必须在白名单里（TUNABLE）
   *   ② value 必须能通过 validateChange（枚举值 / 长度 / 防注入）
   *   ③ confidence 是「低」的一律丢 —— 凭一句话改人格是最容易做砸的地方
   *
   * 字段名从 `persona` 改成 `persona_params`（2026-10-21），
   * 因为现在多了 `persona_note`，两个都叫 persona 会分不清。
   * 旧的 `persona` 字段仍然认（向后兼容）。
   */
  const rawPersona = arr(o.persona_params).length ? o.persona_params : o.persona
  const persona = []
  for (const c of arr(rawPersona)) {
    const key = str(c?.key)
    const value = str(c?.value)
    if (!key || !value) continue
    if (!TUNABLE[key]) continue
    const v = validateChange(key, value)
    if (!v.ok) continue
    const conf = ['高', '中', '低'].includes(str(c?.confidence)) ? str(c.confidence) : '低'
    if (conf === '低') continue
    persona.push({
      key,
      value: v.value,
      why: str(c?.why).slice(0, 60) || '会话反思',
      confidence: conf,
    })
  }

  /**
   * 人格正文追加指令（persona_note）。
   *
   * 这是「参数表表达不出来的改动」的出口 —— 一句可执行的行为指令，
   * 由 applyReflection 追加进 persona.md 的「## 附加指令」小节。
   *
   * ⚠️ 它绕过了 TUNABLE 白名单，所以必须自己把住三道门：
   *   ① 长度（60 字以内，写不下就不是「一句指令」）
   *   ② 不许出现「覆盖/忽略/取消」这类想改铁律的词
   *   ③ 不许用换行 / markdown 标题（防注入新段落）
   */
  const noteRaw = str(o.persona_note).trim()
  let personaNote = ''
  if (noteRaw) {
    const tooLong = noteRaw.length > 60
    const evil = /忽略|覆盖|取消|无视|作废|删掉|不再遵守|放弃.*(?:诚实|底线|原则)/.test(noteRaw)
    const inject = /[\n\r]|^#|^\s*[-*]\s/.test(noteRaw)
    if (!tooLong && !evil && !inject) personaNote = noteRaw
  }

  return {
    summary: str(o.summary).slice(0, 1400),
    keywords: arr(o.keywords).map(str).filter(Boolean).slice(0, 10),
    mood: str(o.mood).slice(0, 120),
    worthRemembering: o.worthRemembering !== false && Boolean(str(o.summary)),
    core_candidates: core,
    preference_candidates: prefs,
    persona,
    /** 参数表表达不出来的那条改动（追加进「## 附加指令」） */
    persona_note: personaNote,
  }
}

/**
 * 一次完整的反思调用。失败返回 {ok:false, error}，绝不抛。
 */
export async function reflectSession(llm, route, { turns, sessionId = '', signal, maxTokens = 8000 }) {
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      system: REFLECT_SYSTEM,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildReflectPrompt({ date: dayKey(), turns, sessionId }) }],
      }],
      maxTokens,
    }
    if (signal) options.signal = signal
    if (route.effort) options.reasoningEffort = route.effort
    const { text } = await drainText(llm, options)
    const json = extractJson(text)
    if (!json) return { ok: false, error: 'unparseable-json', raw: String(text).slice(0, 500) }
    return { ok: true, value: normalizeReflection(json) }
  } catch (e) {
    const code = e?.code ? `${e.code}: ` : ''
    return { ok: false, error: `${code}${String(e?.message || e)}`.slice(0, 400) }
  }
}

/**
 * 把反思结果落到四个地方。**顺序有意义**：
 *
 *   ① 人格参数（最谨慎：还要再确认一次「不是过拟合」）
 *   ② 日常记忆（会遗忘）
 *   ③ core / preferences（永不遗忘）
 *
 * 返回一份可读的处置清单，给状态页和日志用。
 *
 * @param {object} p
 * @param {object} p.store      MemoryStore
 * @param {object} p.result     normalizeReflection 的产物
 * @param {object} [p.source]   { day, sessionId }
 * @param {Function} [p.promote] 提升函数（复用 workflow.promoteCandidates）
 * @param {Function} [p.applyParam] 真正改 persona.md 的函数
 * @param {object} [p.cfg]      配置（判断人格要不要自动落）
 */
export function applyReflection({ store, result, source = {}, promote, applyParam, appendNote, cfg = {}, log }) {
  const done = { persona: [], memory: null, promoted: [], skipped: [] }

  /* ① 人格参数 */
  const personaOn = cfg.reflectPersona !== false
  for (const p of result.persona || []) {
    if (!personaOn) { done.skipped.push({ kind: 'persona', key: p.key, reason: '人格自动调整关着' }); continue }
    // 置信度「中」要多一道确认：只有在配置允许时才落（默认允许，但记下来）
    if (p.confidence === '中' && cfg.reflectPersonaLowConfidence === false) {
      done.skipped.push({ kind: 'persona', key: p.key, reason: '置信度只有「中」，按配置不落' })
      continue
    }
    try {
      const r = applyParam?.({ key: p.key, value: p.value, why: p.why, confidence: p.confidence })
      if (r?.ok && !r.unchanged) done.persona.push({ key: p.key, from: r.from, to: p.value, why: p.why })
      else if (r?.ok) done.skipped.push({ kind: 'persona', key: p.key, reason: '值没变' })
      else done.skipped.push({ kind: 'persona', key: p.key, reason: r?.error || '写入失败' })
    } catch (e) {
      done.skipped.push({ kind: 'persona', key: p.key, reason: String(e?.message || e) })
    }
  }

  /* ② 日常记忆 */
  if (result.worthRemembering && result.summary) {
    try {
      const saved = store.appendDaily({
        summary: result.summary,
        keywords: result.keywords,
        mood: result.mood,
        sessionId: source.sessionId || '',
        title: (result.keywords || []).slice(0, 2).join('·') || '对话反思',
      })
      done.memory = { id: saved.id, day: saved.day }
    } catch (e) {
      log?.(`反思写日常记忆失败：${e?.message || e}`)
    }
  }

  /* ②b 人格附加指令（参数表表达不出来的那条） */
  if (result.persona_note && cfg.reflectPersona !== false && appendNote) {
    try {
      const r = appendNote({ note: result.persona_note, date: source.day || '' })
      if (r?.ok && r.added) {
        done.personaNote = { text: result.persona_note, count: r.count }
        log?.(`人格追加指令：${result.persona_note}`)
      } else if (r?.reason) {
        done.skipped.push({ kind: 'persona_note', text: result.persona_note, reason: r.reason })
      }
    } catch (e) {
      done.skipped.push({ kind: 'persona_note', text: result.persona_note, reason: String(e?.message || e) })
    }
  }

  /* ③ core / preferences */
  try {
    const promoted = promote?.(store, result, { log, stats: null, source, enabled: cfg.autoPromote !== false }) || []
    done.promoted = promoted
  } catch (e) {
    log?.(`反思提升失败：${e?.message || e}`)
  }

  return done
}

/** 给状态页的一行摘要。 */
export function summarizeOutcome(done) {
  const bits = []
  if (done.memory) bits.push(`记忆 +1`)
  if (done.promoted?.length) bits.push(`永不遗忘 +${done.promoted.length}`)
  if (done.persona?.length) bits.push(`人格 ${done.persona.map((p) => p.key).join('/')}`)
  if (done.personaNote) bits.push(`人格追加「${done.personaNote.text.slice(0, 12)}」`)
  if (done.skipped?.length) bits.push(`跳过 ${done.skipped.length}`)
  return bits.length ? bits.join('｜') : '什么都没改'
}

/** 日志用的时间戳前缀。 */
export function reflectStamp(now = new Date()) {
  return stamp(now)
}
