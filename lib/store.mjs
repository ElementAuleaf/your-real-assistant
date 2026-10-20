/**
 * lib/store.mjs —— 记忆的落盘结构
 * ============================================================================
 * 目录布局（根目录默认 `<DSH_HOME>/memory`）：
 *
 *   memory/
 *     core/memories.md          永不删除 · 核心记忆（身份、重要的人、承诺、约定）
 *     preferences/preferences.md 永不删除 · 习惯与喜好
 *     persona.md                人格设定（可被设置页编辑 / 被模型自己改写）
 *     YYYY-MM-DD/
 *        conversations.md       当天的对话摘要（每条一个 id）
 *        .meta.json             每条记忆的遗忘状态（stability / lastReviewed / decayed）
 *     index/
 *        keywords.json          关键词 → 记忆 id 的倒排索引（给 recall_memory 用）
 *     log/
 *        memory.log             运行日志（出问题时能查）
 * ============================================================================
 */
import { join } from 'node:path'
/**
 * ⚠️ 这个文件**故意不 import rmSync / rm / unlink**。
 *    策略要求：日期文件夹永远不删。没有删除函数，就不会有人手滑加一句 rm。
 */
import { readdirSync, statSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs'
import {
  memoryRoot, writeText, readText, readJson, writeJson, exists,
  dayKey, stamp, clock, slug, nextId, CORE_FILE, PREFS_FILE, PERSONA_FILE,
} from './home.mjs'
import { BASE_STABILITY_S, evaluate, reinforce, nextReviewAt, retention, stageLabel, pickImportant } from './ebbinghaus.mjs'

export const CORE_DIR = 'core'
export const PREFS_DIR = 'preferences'
export const INDEX_DIR = 'index'
export const LOG_DIR = 'log'

/** 日期文件夹名可用性：必须是 `YYYY-MM-DD`。 */
export function isDay(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(name || ''))
}

/** 记忆系统的门面。每次操作都重新读盘，不做长时间缓存 —— 记忆必须与其他进程/手改保持一致。 */
export class MemoryStore {
  constructor(ctx, opts = {}) {
    this.ctx = ctx
    this.configuredRoot = opts.root
    this.logEnabled = opts.log !== false
  }

  get root() {
    return memoryRoot(this.ctx, this.configuredRoot)
  }

  path(...parts) {
    return join(this.root, ...parts)
  }

  log(line) {
    if (!this.logEnabled) return
    try {
      const dir = this.path(LOG_DIR)
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'memory.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
    } catch { /* 日志写不进去不影响主流程 */ }
  }

  /* ───────────────────────── 永不删除的两层 ───────────────────────── */

  corePath() { return this.path(CORE_DIR, CORE_FILE) }
  prefsPath() { return this.path(PREFS_DIR, PREFS_FILE) }
  personaPath() { return this.path(PERSONA_FILE) }

  readCore() { return readText(this.corePath(), '') }
  readPrefs() { return readText(this.prefsPath(), '') }
  readPersona() { return readText(this.personaPath(), '') }

  /**
   * 把条目追加到 core / preferences 的对应小节。
   * 万一分节不存在就新建 —— 用户手改过文件也不至于写丢。
   */
  appendToEvergreen(kind, section, body) {
    const isCore = kind === 'core'
    const file = isCore ? this.corePath() : this.prefsPath()
    let text = readText(file, '')
    if (!text.trim()) {
      text = isCore
        ? '# 核心记忆（永不遗忘）\n\n> 由插件维护，也可以手改。\n\n'
        : '# 习惯与喜好\n\n> 由插件维护，也可以手改。\n\n'
    }
    const head = `## ${section}`
    const line = `- ${body}`
    const idx = text.indexOf(head)
    if (idx < 0) {
      text = `${text.trimEnd()}\n\n${head}\n\n${line}\n`
    } else {
      // 插到该小节最后一个列表项之后
      const after = text.slice(idx + head.length)
      const nextHeading = after.indexOf('\n## ')
      const end = nextHeading < 0 ? text.length : idx + head.length + nextHeading
      const seg = text.slice(idx, end).trimEnd()
      text = `${text.slice(0, idx)}${seg}\n${line}\n${text.slice(end)}`
    }
    writeText(file, text)
    return file
  }

  writePersona(content) {
    return writeText(this.personaPath(), String(content ?? ''))
  }

  /** 首次运行铺好目录与占位文件（不覆盖已有内容）。 */
  ensureLayout(seed = {}) {
    mkdirSync(this.path(CORE_DIR), { recursive: true })
    mkdirSync(this.path(PREFS_DIR), { recursive: true })
    mkdirSync(this.path(INDEX_DIR), { recursive: true })
    if (!exists(this.corePath()) && seed.core) writeText(this.corePath(), seed.core)
    if (!exists(this.prefsPath()) && seed.prefs) writeText(this.prefsPath(), seed.prefs)
    if (!exists(this.personaPath()) && seed.persona) writeText(this.personaPath(), seed.persona)
    return this.root
  }

  /* ───────────────────────── 会遗忘的日记层 ───────────────────────── */

  dayDir(day) { return this.path(day) }
  dayFile(day) { return this.path(day, 'conversations.md') }
  dayMeta(day) { return this.path(day, '.meta.json') }

  readDayMeta(day) {
    const m = readJson(this.dayMeta(day), null)
    return m && typeof m === 'object' && m.entries ? m : { day, entries: {} }
  }

  writeDayMeta(day, meta) {
    return writeJson(this.dayMeta(day), meta)
  }

  /** 列出所有日期文件夹，最新在前。 */
  listDays() {
    let names = []
    try { names = readdirSync(this.root) } catch { return [] }
    const out = []
    for (const n of names) {
      if (!isDay(n)) continue
      try { if (!statSync(this.path(n)).isDirectory()) continue } catch { continue }
      out.push(n)
    }
    return out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  }

  /**
   * 追加一条日常记忆。
   * @returns {{id:string, day:string, file:string}}
   */
  appendDaily({ summary, keywords = [], mood = '', sessionId = '', title = '', when = new Date() }) {
    const day = dayKey(when)
    mkdirSync(this.dayDir(day), { recursive: true })
    const id = nextId('D')
    const body = renderDailyEntry({ id, summary, keywords, mood, sessionId, title, when })
    const file = this.dayFile(day)
    const prev = readText(file, '')
    const header = prev.trim() ? '' : `# ${day} 对话记忆\n\n> 会沿艾宾浩斯曲线淡去。想留下就用 save_memory 提升到 core / preferences。\n\n`
    writeText(file, `${prev.trimEnd()}${prev.trim() ? '\n\n' : ''}${header}${body}`)

    const meta = this.readDayMeta(day)
    meta.day = day
    meta.entries[id] = {
      id,
      createdAt: when.getTime(),
      firstSeen: when.getTime(),
      lastReviewed: when.getTime(),
      lastSeen: when.getTime(),
      stability: BASE_STABILITY_S,
      reviews: 0,
      decayed: false,
      keywords: keywords.slice(0, 12),
      title: title || '',
      sessionId,
    }
    this.writeDayMeta(day, meta)
    this.log(`daily +${id} ${day} ${title || ''}`)
    return { id, day, file }
  }

  /** 全天记忆里搜一遍（给 recall_memory 用）。 */
  searchDaily(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase()
    const days = this.listDays()
    const hits = []
    for (const day of days) {
      const text = readText(this.dayFile(day), '')
      if (!text) continue
      const meta = this.readDayMeta(day)
      for (const block of splitEntries(text)) {
        const hay = `${block.title} ${block.body}`.toLowerCase()
        const score = scoreMatch(hay, q, block.keywords)
        if (score <= 0) continue
        const m = meta.entries[block.id] || {}
        hits.push({ day, ...block, ...m, score, retention: retention((Date.now() - (m.lastReviewed || Date.now())) / 1000, m.stability) })
      }
      if (hits.length > limit * 6) break
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  /** 回顾：把命中的条目续期（这才是真正重置遗忘时钟的地方）。 */
  review(ids = [], { allDays = false } = {}) {
    const now = Date.now()
    const reviewed = []
    const days = allDays ? this.listDays() : []
    if (!allDays) {
      const byDay = new Map()
      for (const id of ids) {
        const day = String(id).split('@')[1]
        if (!day) continue
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push(String(id).split('@')[0])
      }
      for (const [day, list] of byDay) this.#reviewDay(day, list, now, reviewed)
    } else {
      for (const day of days) this.#reviewDay(day, null, now, reviewed)
    }
    this.log(`review ${allDays ? 'all' : reviewed.length} entr${reviewed.length === 1 ? 'y' : 'ies'}`)
    return reviewed
  }

  #reviewDay(day, list, now, out) {
    const meta = this.readDayMeta(day)
    let touched = false
    const ids = list && list.length ? list : Object.keys(meta.entries)
    for (const id of ids) {
      const e = meta.entries[id]
      if (!e) continue
      meta.entries[id] = reinforce(e, now)
      out.push(`${id}@${day}`)
      touched = true
    }
    if (touched) this.writeDayMeta(day, meta)
  }

  /**
   * 存档：把某几条标成「重要的」，从此不再被压缩，永远是原文。
   * 这是「保留少部分重要的记忆」那个「重要」的手动开关。
   * @param {{ids?: string[], day?: string}} opts
   */
  pin({ ids = [], day } = {}) {
    const pinned = []
    const days = day ? [day] : this.listDays()
    const wanted = new Set(ids.map((x) => String(x).split('@')[0]))
    for (const d of days) {
      const meta = this.readDayMeta(d)
      const targets = wanted.size
        ? Object.keys(meta.entries).filter((id) => wanted.has(id))
        : Object.keys(meta.entries)
      if (!targets.length) continue
      for (const id of targets) {
        const e = meta.entries[id]
        if (!e) continue
        meta.entries[id] = { ...e, pinned: true, level: 'full', decayed: false, pinnedAt: Date.now() }
        pinned.push(`${id}@${d}`)
      }
      this.writeDayMeta(d, meta)
      this.#rewriteDayFile(d, meta)
    }
    if (pinned.length) this.log(`pin ${pinned.length}`)
    return pinned
  }

  /** 取消存档。 */
  unpin({ ids = [], day } = {}) {
    const out = []
    const days = day ? [day] : this.listDays()
    const wanted = new Set(ids.map((x) => String(x).split('@')[0]))
    for (const d of days) {
      const meta = this.readDayMeta(d)
      const targets = wanted.size ? Object.keys(meta.entries).filter((id) => wanted.has(id)) : []
      for (const id of targets) {
        const e = meta.entries[id]
        if (!e) continue
        meta.entries[id] = { ...e, pinned: false, pinnedAt: undefined }
        out.push(`${id}@${d}`)
      }
      if (targets.length) { this.writeDayMeta(d, meta); this.#rewriteDayFile(d, meta) }
    }
    return out
  }

  /**
   * 扫一遍遗忘曲线。
   *
   * 核心规则（这条不能改）：
   *    **文件夹永远不删**。忘掉的是「里面的内容」——
   *    大部分条目会被压缩成一行，少数重要的保留原文。
   *    一个日期文件夹即使全忘了，也会留一个空壳 + 一行说明（「这天聊过，细节已淡去」）。
   *
   * 保留谁：
   *   ① `pinned`（手动存档 / .keep）—— 永远完整；
   *   ② 被回顾过 ≥ protectAfterReviews 次的 —— 最多压成一行，不留墓碑；
   *   ③ 其余按曲线走：keep → one-line → tombstone。
   *
   * ⚠️ 必须在 try/catch 里调用 —— 它在定时器回调里跑，抛出去会带走宿主进程。
   */
  sweep(opts = {}) {
    const now = Date.now()
    const fadeThreshold = Number(opts.fadeThreshold) || 0.30
    const forgetThreshold = Number(opts.forgetThreshold) || 0.06
    const protectAfterReviews = Number.isFinite(Number(opts.protectAfterReviews)) ? Number(opts.protectAfterReviews) : 3
    const keepPerDay = Number.isFinite(Number(opts.keepPerDay)) ? Number(opts.keepPerDay) : 5

    const faded = []
    const forgotten = []
    const kept = []
    const protectedIds = []
    const days = this.listDays()

    for (const day of days) {
      const meta = this.readDayMeta(day)
      let metaChanged = false
      let fileChanged = false

      // ① 先按曲线算出每条该在哪一档
      for (const [id, entry] of Object.entries(meta.entries)) {
        const r = evaluate(entry, now, { fadeThreshold, forgetThreshold, protectAfterReviews })
        const before = entry.pinned ? 'pinned' : (entry.level || 'full')
        const after = r.entry?.level || 'full'

        if (r.action === 'fade' && before !== after) {
          meta.entries[id] = r.entry
          metaChanged = true
          fileChanged = true
          faded.push({ id: `${id}@${day}`, day, retention: r.retention, to: after })
        } else if (r.action === 'forget' && before !== after) {
          meta.entries[id] = r.entry
          metaChanged = true
          fileChanged = true
          forgotten.push({ id: `${id}@${day}`, day, retention: r.retention, to: after })
        } else if (r.entry !== entry) {
          meta.entries[id] = r.entry
          metaChanged = true
        } else {
          kept.push({ id: `${id}@${day}`, day, level: before })
        }
      }

      // ② 「每天留几条完整的」：把最重要的 keepPerDay 条恢复成原文
      if (keepPerDay > 0) {
        const items = Object.entries(meta.entries).map(([id, entry]) => ({ id, entry }))
        const important = pickImportant(items, keepPerDay, now)
        for (const id of important) {
          const e = meta.entries[id]
          if (!e) continue
          if (e.pinned) { protectedIds.push(`${id}@${day}`); continue }
          const shouldProtect = Number(e.reviews) >= protectAfterReviews
          // 已经压成一行的，如果它在这一天里排进前几名，也恢复成一行以上？不 ——
          // 只有「够重要」的才恢复，避免把刚压下去的又弹回来。
          if (shouldProtect && e.level && e.level !== 'full') {
            meta.entries[id] = { ...e, level: 'full', decayed: false }
            metaChanged = true
            fileChanged = true
            protectedIds.push(`${id}@${day}`)
          } else if (shouldProtect) {
            protectedIds.push(`${id}@${day}`)
          }
        }
      }

      if (metaChanged) this.writeDayMeta(day, meta)
      if (fileChanged) this.#rewriteDayFile(day, meta)
    }

    if (faded.length) this.log(`sweep 压缩 ${faded.length}`)
    if (forgotten.length) this.log(`sweep 淡忘 ${forgotten.length}`)
    if (protectedIds.length) this.log(`sweep 保留原样 ${protectedIds.length}`)
    return { faded, forgotten, kept, protected: protectedIds, days: days.length }
  }

  /**
   * 按条目当前的 level 重写 conversations.md。
   * ⚠️ 只重写内容，**目录本身绝不删除**。
   * ⚠️ 压缩后的条目必须保留 `- id:`，否则下一轮 splitEntries() 认不出它，
   *    元信息就成了孤儿（这一条是自测里抓出来的）。
   * ⚠️ **重写前先备份**。压缩是破坏性的：一旦原文被压成一行，原文就再也没有了。
   *    一旦备份缺失又压错了，就只能靠 meta 里的关键词重建。备份是最后一道防线。
   */
  #rewriteDayFile(day, meta) {
    const file = this.dayFile(day)
    const prev = readText(file, '')
    validateDayFile(day, this.dayDir(day), prev)
    const blocks = splitEntries(prev)
    if (!blocks.length && !prev.trim()) return

    // 备份到 <root>/backup/<day>/<时间戳>.md，最多留 5 份
    try {
      const dir = join(this.root, 'backup', day)
      mkdirSync(dir, { recursive: true })
      writeText(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), prev)
      const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
      for (const old of files.slice(0, Math.max(0, files.length - 5))) {
        try { unlinkSync(join(dir, old)) } catch { /* 删不掉就算了 */ }
      }
    } catch { /* 备份失败不能挡住主流程 */ }

    const pieces = []
    for (const b of blocks) {
      const m = meta.entries[b.id] || {}
      const level = m.pinned ? 'full' : (m.level || 'full')
      if (level === 'full') {
        pieces.push(b.raw)
      } else if (level === 'one-line') {
        pieces.push(renderCompressedEntry(b, { tombstone: false }))
      } else {
        pieces.push(renderCompressedEntry(b, { tombstone: true }))
      }
    }

    const header = `# ${day} 对话记忆\n\n> 会沿艾宾浩斯曲线淡去：大部分内容被压缩成一行，少数重要的保留原文。\n> 这个文件夹本身**不会被删除**。\n\n`
    const body = pieces.length
      ? pieces.join('\n\n')
      : `## 这天聊过\n\n> 细节已经淡去了，只记得这天说过话。\n`
    writeText(file, `${header}${body}\n`)
  }

  /* ───────────────────────── 回忆（注入用） ───────────────────────── */

  /**
   * 生成注入到系统提示词的记忆块。
   * 顺序按「越靠后越新」：核心 → 偏好 → persona 之外的近期日记。
   */
  recallText(opts = {}) {
    const recentDays = Math.max(1, Number(opts.recentDays) || 3)
    const budget = Math.max(1200, Number(opts.budget) || 6000)
    const coreText = clipMarkdown(this.readCore(), Math.floor(budget * 0.34))
    const prefText = clipMarkdown(this.readPrefs(), Math.floor(budget * 0.26))
    const parts = []
    if (coreText.trim()) parts.push(`### 核心（永不遗忘）\n\n${coreText.trim()}`)
    if (prefText.trim()) parts.push(`### 他的习惯与喜好（永不遗忘）\n\n${prefText.trim()}`)
    const rest = budget - parts.join('\n\n').length
    const dayBudget = Math.max(600, rest)
    const days = this.listDays().slice(0, recentDays)
    const now = Date.now()
    for (const day of days) {
      const meta = this.readDayMeta(day)
      const text = readText(this.dayFile(day), '')
      const blocks = splitEntries(text)
      if (!blocks.length) continue
      const kept = blocks
        .map((b) => ({ ...b, day, m: meta.entries[b.id] || {} }))
        .map((b) => ({ ...b, r: retention((now - Number(b.m.lastReviewed || now)) / 1000, b.m.stability) }))
        // 完全淡去的墓碑不占上下文；压缩成一行的还留着，但只给一行
        .filter((b) => (b.m.pinned ? true : (b.m.level || 'full') !== 'tombstone'))
        .map((b) => formatRecallEntry(b))
      if (!kept.length) continue
      parts.push(`### 近期（${day}）\n\n${clipMarkdown(kept.join('\n'), Math.floor(dayBudget / Math.max(1, days.length)))}`)
    }
    return parts.join('\n\n')
  }

  /** 状态页要的数据。 */
  status() {
    const days = this.listDays()
    const now = Date.now()
    const rows = days.map((day) => {
      const meta = this.readDayMeta(day)
      const ids = Object.keys(meta.entries)
      let best = 0
      let worst = 1
      let nextAt = null
      const levels = { full: 0, 'one-line': 0, tombstone: 0 }
      let pinnedCount = 0
      for (const id of ids) {
        const e = meta.entries[id]
        const r = retention((now - Number(e.lastReviewed || now)) / 1000, e.stability)
        best = Math.max(best, r)
        worst = Math.min(worst, r)
        const n = nextReviewAt(e)
        if (nextAt === null || n < nextAt) nextAt = n
        const lv = e.pinned ? 'full' : (e.level || 'full')
        if (lv in levels) levels[lv] += 1
        if (e.pinned) pinnedCount += 1
      }
      return {
        day,
        count: ids.length,
        retention: ids.length ? Number(worst.toFixed(3)) : 0,
        best: Number(best.toFixed(3)),
        label: ids.length ? stageLabel(meta.entries[ids[0]], now) : '空',
        nextReviewAt: nextAt,
        levels,
        pinned: pinnedCount,
        files: (() => { try { return readdirSync(this.dayDir(day)) } catch { return [] } })(),
      }
    })
    return {
      root: this.root,
      days: rows,
      coreBytes: (this.readCore() || '').length,
      prefBytes: (this.readPrefs() || '').length,
      personaBytes: (this.readPersona() || '').length,
    }
  }
}

/* ───────────────────────── 纯函数 ───────────────────────── */

/**
 * 重写前的完整性检查：压缩前必须**认得清**这个文件。
 *
 * 为什么要有它：如果 splitEntries() 因为格式不对只认出 0 条，
 * 重写就会把整份文件清空成一句「这天聊过」——**原文全没了**。
 * 所以这里做硬校验：文件本来有内容、却一条都没解析出来 → 拒绝重写。
 */
function validateDayFile(day, dir, prev) {
  const text = String(prev || '')
  if (!text.trim()) return true
  const blocks = splitEntries(text)
  if (blocks.length > 0) return true
  // 文件里有实质内容（不只是标题/说明），却解析不出任何条目
  const substantial = text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>'))
    .join('').length
  if (substantial > 80) {
    throw new Error(`refusing to rewrite ${day}: ${blocks.length} entries parsed from ${text.length} chars — 疑似格式不匹配，宁可不动`)
  }
  return true
}

export function renderDailyEntry({ id, summary, keywords, mood, sessionId, title, when }) {
  const kws = (keywords || []).filter(Boolean).join(' / ')
  const meta = [
    `- id: \`${id}\``,
    `- 时间: ${stamp(when)}`,
    // 会话 id 形如 `session-7e07...`，前 8 个字符全是 "session-" —— 取尾段才有信息量
    sessionId ? `- 会话: \`${String(sessionId).replace(/^session-/, '').slice(0, 8) || String(sessionId).slice(0, 8)}\`` : '',
    kws ? `- 关键词: ${kws}` : '',
    mood ? `- 氛围: ${mood}` : '',
  ].filter(Boolean)
  // ⚠️ 标题与元信息之间、元信息与正文之间**必须有空行**：
  //    splitEntries() 靠它把「元信息」和「他说的内容」切干净。
  return `${title ? `## ${title}` : `## ${dayKey(when)} ${clock(when)}`}\n\n${meta.join('\n')}\n\n${String(summary || '').trim()}\n`
}

/** 把 conversations.md 拆回一条条记忆。 */
export function splitEntries(text) {
  const src = String(text || '')
  if (!src.trim()) return []
  const out = []
  const parts = src.split(/\n(?=## )/)
  for (const part of parts) {
    if (!part.startsWith('## ')) continue
    const titleM = /^##\s+(.+)$/m.exec(part)
    const idM = /- id:\s*`([^`]+)`/.exec(part)
    const kwM = /- 关键词:\s*(.+)/.exec(part)
    const moodM = /- 氛围:\s*(.+)/.exec(part)
    // 正文 = 元信息列表中最后一行之后的内容
    const metaLines = [...part.matchAll(/^- (?:id|时间|会话|关键词|氛围):.*$/gm)]
    const lastMeta = metaLines.length ? metaLines[metaLines.length - 1] : null
    const body = lastMeta ? part.slice(lastMeta.index + lastMeta[0].length).trim() : part.trim()
    out.push({
      id: idM ? idM[1] : '',
      title: titleM ? titleM[1].trim() : '',
      keywords: kwM ? kwM[1].split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean) : [],
      mood: moodM ? moodM[1].trim() : '',
      body,
      raw: part.trim(),
    })
  }
  return out
}

export function scoreMatch(hay, query, keywords = []) {
  if (!query) return 0
  const terms = query.split(/\s+/).filter(Boolean)
  let score = 0
  for (const t of terms) {
    if (!t) continue
    if (hay.includes(t)) score += 3
    for (const k of keywords) if (String(k).toLowerCase().includes(t)) score += 2
  }
  return score
}

/** 把 markdown 里给「人」看的 HTML 注释去掉 —— 这些是脚手架，不该占注入预算。 */
export function stripScaffold(markdown) {
  return String(markdown || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 「压缩后」的条目长什么样。
 * tombstone：只留日期 + 标题，一行，证明「这天确实聊过」。
 * one-line ：留摘要首句 + 关键词。
 */
export function renderCompressedEntry(block, { tombstone = false } = {}) {
  const title = block.title || '对话'
  if (tombstone) {
    return `## ${title}\n\n- id: \`${block.id}\`\n\n> 细节已淡去，只记得这天聊过。`
  }
  const firstLine = String(block.body || '')
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter(Boolean)[0] || ''
  const kws = (block.keywords || []).slice(0, 5).join(' / ')
  // 保留 `- id:` / `- 关键词:` 这两个 key，splitEntries() 才认得出它
  const parts = [`## ${title}`, '', `- id: \`${block.id}\``]
  if (kws) parts.push(`- 关键词: ${kws}`)
  parts.push('')
  if (firstLine) parts.push(`${firstLine.slice(0, 120)}${firstLine.length > 120 ? '…' : ''}`)
  parts.push('', '> 已经模糊了，只剩这些。')
  return parts.join('\n')
}

export function clipMarkdown(text, maxLen) {
  const s = stripScaffold(text)
  if (s.length <= maxLen) return s
  const cut = s.slice(0, maxLen)
  const lastBreak = cut.lastIndexOf('\n- ')
  return `${lastBreak > maxLen * 0.5 ? cut.slice(0, lastBreak) : cut}\n…（已截断）`
}

export function formatRecallEntry(b) {
  const body = String(b.body || '').replace(/\n{2,}/g, '\n').trim()
  const day = b.day || b.m?.day || ''
  const title = b.title || '对话'
  const level = b.m?.pinned ? 'full' : (b.m?.level || 'full')
  if (level === 'one-line') {
    return `- ${day}｜${title}（记不太清了）：${body.slice(0, 80)}`
  }
  return `- ${day}｜${title}：${body.slice(0, 220)}`
}
