/**
 * lib/workflow.mjs —— 采集一轮：读会话 → 摘要 → 落盘 → 提升
 * ============================================================================
 * 这是整个插件的核心循环。每 N 分钟跑一次：
 *
 *   1. 列会话（sessionQuery.listSessions）
 *   2. 对每个「最近有活动」的会话，从游标位置往后读新增事件
 *   3. 折成「他：…」「她：…」的轮次
 *   4. 按块调模型做摘要（skip=true 的块直接丢）
 *   5. 摘要写进 `YYYY-MM-DD/conversations.md`，条目带独立的遗忘时钟
 *   6. core_candidates / preference_candidates 自动提升进永不删除的那两层
 *
 * ⚠️ 全过程在定时器里，任何异常都必须吃掉并记日志。
 * ============================================================================
 */
import { join } from 'node:path'
import { dayKey, stamp, slug, readText, exists, nextId } from './home.mjs'
import { toTurns, renderTurns, chunkTurns, latestRoute } from './transcript.mjs'
import { summarizeChunk } from './llm.mjs'

export { nextId }

/** 会话是否值得看：有活动时间与会话头即可。 */
function sessionId(rec) {
  // ⚠️ SessionRecord 的形状是 { header, live, persisted } —— **没有** sessionId / id / updatedAt。
  return rec?.header?.id || rec?.sessionId || rec?.id || ''
}

function sessionCwd(rec) {
  return rec?.header?.cwd || ''
}

function sessionCreatedAt(rec) {
  return Number(rec?.header?.createdAt) || 0
}

/**
 * 跑一轮采集。
 * @param {object} opts
 * @param {Map<string,{seq:number,time:number}>} [opts.activity] session/event 推上来的活动水位
 * @returns {Promise<{captured:number, skipped:number, failed:number, details:Array}>}
 */
export async function captureOnce({
  ctx, store, stats, cursor, serial, config, log, llm, activity, signal,
}) {
  const result = { captured: 0, skipped: 0, failed: 0, details: [] }
  const aborted = () => Boolean(signal?.aborted)
  const sq = ctx.get?.('sessionQuery')
  if (!sq || typeof sq.listSessions !== 'function') {
    result.note = 'sessionQuery 不可用，这一轮跳过'
    return result
  }

  let records = []
  try {
    records = (await sq.listSessions()) || []
  } catch (e) {
    log(`listSessions 失败：${e?.message || e}`)
    result.failed += 1
    return result
  }

  const allowCwd = config.includeCwd || ''
  const skipCwd = config.excludeCwd || ''
  const now = Date.now()
  const maxAgeMs = Math.max(1, Number(config.captureWindowHours) || 6) * 3600 * 1000
  const perTick = Math.max(1, Number(config.sessionsPerTick) || 3)

  const candidates = []
  for (const rec of records) {
    const id = sessionId(rec)
    if (!id) continue
    const cwd = sessionCwd(rec)
    if (allowCwd && cwd && !String(cwd).toLowerCase().includes(String(allowCwd).toLowerCase())) continue
    if (skipCwd && cwd && String(cwd).toLowerCase().includes(String(skipCwd).toLowerCase())) continue
    // 子代理会话不记（它们不是「他」说的话）
    if (rec?.header?.origin === 'subagent') continue
    // 最近动过的优先：优先用 session/event 的水位，没有就退回 createdAt
    const act = activity?.get?.(id)
    const freshAt = Number(act?.time) || Number(act?.at) || sessionCreatedAt(rec)
    candidates.push({ rec, id, cwd, freshAt })
  }

  candidates.sort((a, b) => (b.freshAt || 0) - (a.freshAt || 0))

  let handled = 0
  for (const { rec, id, cwd } of candidates) {
    if (handled >= perTick) break
    if (aborted()) { result.aborted = true; break }
    const prev = cursor.get(id)
    // 同一会话在 minIntervalMinutes 内不重复处理（防止一轮里反复摘要）
    const lastAt = Number(prev?.at) || 0
    const minGap = Math.max(60_000, (Number(config.minIntervalMinutes) || 20) * 60_000)
    if (lastAt && now - lastAt < minGap) continue

    let events = []
    try {
      if (typeof sq.readSession === 'function') {
        const snap = await sq.readSession(id)
        events = snap?.events || snap?.log || (Array.isArray(snap) ? snap : [])
      } else if (typeof sq.listEvents === 'function') {
        events = (await sq.listEvents(id)) || []
      }
    } catch (e) {
      result.failed += 1
      log(`读会话 ${id.slice(0, 8)} 失败：${e?.message || e}`)
      continue
    }
    if (!Array.isArray(events) || !events.length) continue

    const turns = toTurns(events)
    if (!turns.length) { cursor.set(id, { seq: maxSeq(events) }); continue }

    // 只处理游标之后的
    const fromSeq = Number(prev?.seq) || 0
    const fresh = fromSeq ? turns.filter((t) => t.seq > fromSeq) : turns
    const lastTime = fresh.length ? fresh[fresh.length - 1].time : 0
    if (lastTime && now - lastTime > maxAgeMs) { cursor.set(id, { seq: maxSeq(events) }); continue }
    if (!fresh.length) continue

    // 太短的对话不浪费一次模型调用
    const chars = fresh.reduce((n, t) => n + t.text.length, 0)
    if (chars < (Number(config.minChars) || 200)) { cursor.set(id, { seq: maxSeq(events) }); result.skipped += 1; continue }

    handled += 1

    // 摘要路由：配置优先，其次会话最近一次请求的路由
    const route = resolveRoute(config, events, llm)
    if (!route) {
      log('没有可用的模型路由（配置里没填，会话里也没有 request/header），跳过')
      result.failed += 1
      continue
    }
    stats.lastModel = `${route.provider}/${route.model}`

    const chunks = chunkTurns(fresh, { maxTurns: Number(config.chunkTurns) || 20, maxChars: Number(config.chunkChars) || 6000 })
    let capturedThis = 0
    let hardFailed = false
    let lastOkSeq = fromSeq
    for (let i = 0; i < chunks.length; i++) {
      if (aborted()) { result.aborted = true; break }
      const chunk = chunks[i]
      const rendered = renderTurns(chunk)
      const when = new Date(chunk[chunk.length - 1]?.time || Date.now())
      const res = await serial.push(() => summarizeChunk(llm, route, {
        date: dayKey(when),
        turns: rendered,
        chunkNo: i + 1,
        chunkTotal: chunks.length,
        maxTokens: Number(config.summaryMaxTokens) || 8000,
        signal,
      })) || { ok: false, error: 'queue-returned-nothing' }
      if (!res.ok) {
        result.failed += 1
        stats.lastError = `${stamp()} 摘要失败：${res.error}`
        const code = String(res.error || '')
        // 输出被截断 / 路由不存在 / 写权限 —— 重试多少次都一样。
        // 不推进游标 = 下一轮再来，那就成了死循环（2026-10-19 真撞上过）。
        if (/^(MAX_TOKENS|NO_ADAPTER|EACCES|EPERM)/.test(code)) {
          hardFailed = true
          log(`摘要失败（不可重试，跳过本块并推进游标）：${res.error}`)
          break
        }
        log(`摘要失败（${route.provider}/${route.model}）：${res.error}`)
        continue
      }
      lastOkSeq = Math.max(lastOkSeq, chunk[chunk.length - 1]?.seq || lastOkSeq)
      const s = res.value
      if (s.skip) { result.skipped += 1; continue }

      const title = deriveTitle(s, chunk)
      const saved = store.appendDaily({
        summary: s.summary,
        keywords: s.keywords,
        mood: s.mood,
        sessionId: id,
        title,
        when,
      })
      result.captured += 1
      capturedThis += 1
      stats.captures += 1
      stats.summaries += 1

      // ── 自动提升 ──
      const promoted = promoteCandidates(store, s, {
        log,
        stats,
        source: { day: saved.day, sessionId: id },
        enabled: config.autoPromote !== false,
      })
      result.details.push({
        sessionId: String(id).replace(/^session-/, '').slice(0, 8),
        day: saved.day,
        id: saved.id,
        title,
        keywords: s.keywords,
        promoted,
      })
    }

    // 推进游标：不管成功还是硬失败都要推进。
    // 不推进 = 下一轮又从同一处撞同一面墙，日志会被刷爆（今天真发生了）。
    cursor.set(id, { seq: hardFailed ? maxSeq(events) : Math.max(lastOkSeq, fromSeq), cwd })
    if (capturedThis) {
      result.details.push({ note: `会话 ${id.slice(0, 8)} 共 ${capturedThis} 条` })
    }
  }

  cursor.prune()
  cursor.save()
  stats.lastCaptureAt = Date.now()
  return result
}

/**
 * 把摘要里的候选写进 core / preferences。
 * 去重靠「已经出现过相同文本」这个朴素判断 —— 宁可漏记，也不要同一句话刷屏。
 */
export function promoteCandidates(store, summary, { log, stats, source, enabled = true }) {
  const promoted = []
  if (!enabled) return promoted
  const guard = (file, text) => {
    const existing = readText(file, '')
    // 取内容主体比对（忽略编号/日期/来源这些会变的部分）
    const probe = String(text).slice(0, 24)
    return !existing.includes(probe)
  }

  for (const c of summary.core_candidates || []) {
    if (!guard(store.corePath(), c.text)) continue
    const id = nextId('C')
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const line = `[${id}] [${day}] ${c.text}（来源：${source.day} 对话 ｜ 置信度：${c.confidence}${c.quote ? ` ｜ 原话：「${c.quote}」` : ''}）`
    store.appendToEvergreen('core', c.section, line)
    stats.promotedCore += 1
    promoted.push({ layer: 'core', id, section: c.section, text: c.text })
    log(`自动提升 core/${c.section}：${c.text.slice(0, 40)}`)
  }

  for (const c of summary.preference_candidates || []) {
    if (!guard(store.prefsPath(), c.text)) continue
    const id = nextId('P')
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const line = `[${id}] [${c.section}] ${c.text}（${c.evidence} ｜ 置信度：${c.confidence} ｜ ${day}${c.quote ? ` ｜ 原话：「${c.quote}」` : ''}）`
    store.appendToEvergreen('preferences', c.section, line)
    stats.promotedPrefs += 1
    promoted.push({ layer: 'preferences', id, section: c.section, text: c.text })
    log(`自动提升 preferences/${c.section}：${c.text.slice(0, 40)}`)
  }
  return promoted
}

function resolveRoute(config, events, llm) {
  const p = String(config.summarizerProvider || '').trim()
  const m = String(config.summarizerModel || '').trim()
  if (p && m) return { provider: p, model: m }
  const r = latestRoute(events)
  if (r) return r
  // 最后兜底：默认模型服务里当前选的那个
  try {
    const sel = llm?.__defaultSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
  } catch { /* ignore */ }
  return null
}

function maxSeq(events) {
  let max = 0
  for (const e of events || []) {
    const s = Number(e?.seq) || 0
    if (s > max) max = s
  }
  return max
}

/** 给这一块起个短标题：优先关键词，其次首句。 */
function deriveTitle(summary, chunk) {
  const kw = (summary.keywords || []).slice(0, 2).join('·')
  if (kw) return kw.slice(0, 30)
  const first = String(summary.summary || '').split(/[。！？\n]/)[0] || ''
  return first.slice(0, 24) || '对话'
}
