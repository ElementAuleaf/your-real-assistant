/**
 * lib/recall-turn.mjs —— 每一轮都调一次「最近的记忆」
 * ============================================================================
 * 需求（2026-10-21 晚，用户原话）：
 *   「让每个会话回答问题时都调用一次最近的记忆」
 *
 * 和原来的注入有什么区别：
 *
 *   原来：`store.recallText()` 每次注入都给**同样**的一段
 *         （core + preferences + 最近 N 天的全部日常记忆）。
 *         好处是稳，坏处是：今天聊到「心情模块」，注入里却没有关于心情模块的那条记忆 ——
 *         因为它不在最近 3 天，而注入又不看**这一句问的是什么**。
 *
 *   现在：每轮都跑一次检索。输入是这一轮他刚说的话，输出是
 *         ① 一直在的那两层（core / preferences，永不遗忘，永远全给）
 *         ② **和这句话相关的**日常记忆（走索引，按相关度排序）
 *         ③ 最近几天的记忆兜底（哪怕不相关，最近的事也该在场）
 *
 * 三条硬约束：
 *   ① **必须是同步的** —— systemPrompt 的 section text 是同步函数，不能 await。
 *      所以只能走 `store.searchIndex()`（读小 JSON），不能走会读全文的那条路。
 *   ② **必须便宜** —— 每轮都跑，不能每轮都把所有日期文件夹读一遍。
 *      索引只在条目数变化时重建，正常情况就是读几个几 KB 的 JSON。
 *   ③ **必须不吵** —— 命中就续期（相当于「想起来一次」），但不写日志刷屏。
 * ============================================================================
 */
import { clipMarkdown, formatRecallEntry, splitEntries } from './store.mjs'
import { extractRules, rulesText, MAX_RULES } from './rules.mjs'
import { readText } from './home.mjs'

/**
 * 从一句话里挑出可检索的片段。
 *
 * ⚠️ 中文没有空格，这件事没有「正确」的解法 —— 只有「够用」的解法。
 *
 * 2026-10-21 走过的弯路：一开始只切 3 字滑窗，结果
 *   「心情模块现在还是随机的吗」→ 心情模 / 模块现 / 现在还 / 还是随 / 随机的
 * 五个碎片**没有一个是完整的词**，索引里的「心情」「随机」一个都命中不了。
 *
 * 现在改成同时给三种粒度：
 *   ① 2 字窗口 —— 覆盖「心情」「随机」「模块」这类双字词
 *   ② 3 字窗口 —— 覆盖「日期文件夹」这类偏正结构的一部分
 *   ③ 整段（≤ 6 字）—— 「心情模块」「日期文件夹」这种短语整体
 * 命中靠 `scoreEntry()` 两边都试着匹配，碎片多不算错，能捞着才算数。
 */
export function keywordsOf(text, max = 14) {
  const t = String(text || '')
  if (!t.trim()) return []
  const out = []
  const seen = new Set()
  const push = (s) => {
    const v = String(s || '').trim()
    if (v.length < 2 || v.length > 12) return
    if (seen.has(v)) return
    seen.add(v)
    out.push(v)
  }

  // ① 英文/数字词（含 mood.mjs 这种带点的）
  for (const m of t.matchAll(/[a-zA-Z][a-zA-Z0-9_.-]{1,24}/g)) push(m[0])
  // ② 字母+汉字的混合词：B站、C盘、v2版本 —— 上面那条正则只吃字母，会把「站」丢掉
  for (const m of t.matchAll(/[a-zA-Z]{1,4}[\u4e00-\u9fa5]{1,4}/g)) push(m[0])

  // ③ 中文块：按标点/空格切开，逐块做 2 字 / 3 字滑窗
  for (const seg of t.split(/[\s，。！？、；：,.!?;:()[\]{}"'`~@#$%^&*+=<>|\\/]+/)) {
    const s = seg.trim()
    if (!s) continue
    if (!/[\u4e00-\u9fa5]/.test(s)) continue
    if (s.length <= 6) push(s)                       // 短块整体收
    for (let i = 0; i + 2 <= s.length; i++) push(s.slice(i, i + 2))
    for (let i = 0; i + 3 <= s.length; i++) push(s.slice(i, i + 3))
  }

  // 长句里靠前的片段更可能是主题，所以按出现顺序取前 max 个（不去排序）
  return out.slice(0, max)
}

/**
 * 给一条索引条目打分。
 *
 * **两边都试**：既看「检索词在条目里」，也看「条目的关键词在这句话里」。
 * 后者是关键 —— 索引里存的是「心情」「随机」这种干净词，
 * 而检索词是「心情模」「随机的」这种碎片，只有反向匹配才捞得着。
 *
 * @param {object} entry   索引里的 entries[i]（含 title/brief/keywords）
 * @param {string[]} terms keywordsOf() 的产物
 * @param {string} raw     这一轮的原始文本（反向匹配用）
 */
export function scoreEntry(entry, terms, raw = '') {
  const hay = `${entry.title || ''} ${entry.brief || ''} ${(entry.keywords || []).join(' ')}`.toLowerCase()
  const text = String(raw || '').toLowerCase()
  let score = 0
  for (const term of terms || []) {
    const tl = String(term).toLowerCase()
    if (!tl) continue
    if (hay.includes(tl)) score += 3
    for (const k of entry.keywords || []) {
      const kl = String(k).toLowerCase()
      if (!kl) continue
      // 条目关键词出现在这一轮的原始问题里 —— 强证据
      if (text.includes(kl)) score += 4
      // 反过来：检索词包含条目关键词（「心情模块」包含「心情」）
      if (tl.includes(kl) && kl.length >= 2) score += 2
    }
    if ((entry.title || '').toLowerCase().includes(tl)) score += 2
  }
  return score
}

/**
 * 一轮的召回。
 *
 * @param {object} p
 * @param {object} p.store        MemoryStore
 * @param {string} p.query        这一轮他说的话（最近的用户消息）
 * @param {number} [p.budget]     总字符预算
 * @param {number} [p.recentDays] 兜底给最近几天
 * @param {number} [p.related]    相关命中给几条
 * @param {boolean} [p.review]    命中后是否续期
 * @returns {{text:string, hits:number, related:number, recent:number, keywords:string[], terms:string[]}}
 */
export function turnRecall({
  store, query = '', budget = 6000, recentDays = 3, related = 4, review = true, ruleLimit = MAX_RULES,
} = {}) {
  let ruleStats = null
  const b = Math.max(1200, Number(budget) || 6000)
  const terms = keywordsOf(query, 8)

  /* ① 硬规则：他明说过的行为约束 —— 永远给，不参与预算角逐 */
  /**
   * 🔴 2026-10-21 晚，用户抓到「我告诉你了改文件要先读再改，你没记住」。
   *
   * 查下来那条**记着**（preferences 第 94 行，置信度高，原话都在），
   * 但**从来没进过提示词** —— 因为注入是「按文件顺序取前 1560 字」，
   * 而它在第 94 行，被截断了。
   *
   * 141 条偏好里只有 13 条进得去，其中「用户明说 + 高置信」76 条里
   * 有 68 条读不到。所以不是记性差，是**用不上**。
   *
   * 现在硬规则单独成段、单独算预算，**不跟偏好列表抢**。
   * 偏好列表是「参考资料」，截断没关系；
   * 硬规则是「行为约束」，被截断就等于不存在。
   */
  const parts = []
  try {
    const r = extractRules({
      prefs: store.readPrefs(),
      core: store.readCore(),
      now: Date.now(),
      max: Math.max(4, Number(ruleLimit) || MAX_RULES),
    })
    const rt = rulesText(r.rules, { max: r.rules.length })
    if (rt) parts.push(rt)
    ruleStats = r.stats
  } catch { /* 规则提取失败不能挡住其他记忆 */ }

  /* ② 永不遗忘的两层：贪心一点也给（这是地基） */
  const coreText = clipMarkdown(store.readCore(), Math.floor(b * 0.30))
  const prefText = clipMarkdown(store.readPrefs(), Math.floor(b * 0.22))
  if (coreText.trim()) parts.push(`### 核心（永不遗忘）\n\n${coreText.trim()}`)
  if (prefText.trim()) parts.push(`### 他的习惯与喜好（永不遗忘）\n\n${prefText.trim()}`)

  /* ② 和这句话相关的日常记忆（走索引，同步、便宜） */
  const relatedHits = []
  if (terms.length) {
    const seen = new Set()
    for (const day of store.listDays()) {
      let idx = null
      try { idx = store.readDayIndex(day) } catch { idx = null }
      if (!idx) continue
      for (const e of idx.entries || []) {
        const k = `${e.id}@${day}`
        if (seen.has(k)) continue
        const score = scoreEntry(e, terms, query)
        if (score <= 0) continue
        seen.add(k)
        relatedHits.push({
          day,
          id: e.id,
          title: e.title,
          brief: e.brief,
          keywords: e.keywords,
          level: e.level,
          pinned: e.pinned,
          score,
        })
      }
    }
    relatedHits.sort((a, c) => (Number(c.score) || 0) - (Number(a.score) || 0))
    // 分数太低的不要 —— 否则「随便什么词都沾一点」会成为噪音
    const top = Number(relatedHits[0]?.score) || 0
    const floor = Math.max(3, top * 0.35)
    relatedHits.length = Math.min(
      relatedHits.filter((h) => Number(h.score) >= floor).length,
      related,
    )
  }

  if (relatedHits.length) {
    // 回读原文（只回读命中的那几天，不扫全部）
    const byDay = new Map()
    for (const h of relatedHits) {
      if (!byDay.has(h.day)) byDay.set(h.day, [])
      byDay.get(h.day).push(h)
    }
    const lines = []
    const reviewed = []
    for (const [day, hits] of byDay) {
      let blocks = []
      try { blocks = splitEntries(readText(store.dayFile(day), '')) } catch { blocks = [] }
      const meta = store.readDayMeta(day)
      for (const h of hits) {
        const blk = blocks.find((x) => x.id === h.id)
        if (!blk) continue
        const m = meta.entries[h.id] || {}
        const level = m.pinned ? 'full' : (m.level || 'full')
        if (level === 'tombstone' && !m.pinned) continue   // 墓碑不占上下文
        lines.push(formatRecallEntry({ ...blk, day, m }))
        reviewed.push(`${h.id}@${day}`)
      }
    }
    if (lines.length) {
      parts.push(`### 和他这句话有关的旧记忆\n\n${clipMarkdown(lines.join('\n'), Math.floor(b * 0.28))}`)
    }
    // 命中就续期 —— 「想起来一次」本来就是记忆强度这件事的一部分
    if (review && reviewed.length) {
      try { store.review(reviewed) } catch { /* 续期失败不影响注入 */ }
    }
  }

  /* ③ 最近几天兜底：哪怕不相关，最近的事也该在场 */
  const recent = Math.max(0, Number(recentDays) || 0)
  let recentCount = 0
  if (recent > 0) {
    const rest = b - parts.join('\n\n').length
    const dayBudget = Math.max(600, rest)
    const now = Date.now()
    const days = store.listDays().slice(0, recent)
    const chunks = []
    for (const day of days) {
      let blocks = []
      try { blocks = splitEntries(readText(store.dayFile(day), '')) } catch { blocks = [] }
      if (!blocks.length) continue
      const meta = store.readDayMeta(day)
      const kept = blocks
        .map((x) => ({ ...x, day, m: meta.entries[x.id] || {} }))
        .filter((x) => (x.m.pinned ? true : (x.m.level || 'full') !== 'tombstone'))
        .map((x) => formatRecallEntry(x))
      if (!kept.length) continue
      recentCount += kept.length
      chunks.push(`#### ${day}\n\n${clipMarkdown(kept.join('\n'), Math.floor(dayBudget / Math.max(1, days.length)))}`)
    }
    if (chunks.length) parts.push(`### 近期（最近 ${days.length} 天）\n\n${chunks.join('\n\n')}`)
  }

  return {
    text: parts.join('\n\n'),
    hits: relatedHits.length,
    related: relatedHits.length,
    recent: recentCount,
    keywords: relatedHits.map((h) => h.title).filter(Boolean),
    terms,
    rules: ruleStats,
  }
}
