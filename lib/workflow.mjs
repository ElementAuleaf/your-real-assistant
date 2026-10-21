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
import { dayKey, stamp, readText, nextId } from './home.mjs'
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
  ctx, store, stats, cursor, serial, config, log, llm, activity, signal, onAttempt,
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
    const route = await resolveRoute(config, events, llm)
    if (!route) {
      log('没有可用的模型路由（配置里没填，会话里也没有 request/header），跳过')
      result.failed += 1
      continue
    }
    stats.lastModel = `${route.provider}/${route.model}`
    if (route.via === 'model-fallback') {
      log(`配置的 provider "${route.wanted || ''}" 没注册，改用 "${route.provider}" 跑模型 ${route.model}`)
    }

    const chunks = chunkTurns(fresh, { maxTurns: Number(config.chunkTurns) || 20, maxChars: Number(config.chunkChars) || 6000 })
    let capturedThis = 0
    let hardFailed = false
    let lastOkSeq = fromSeq
    for (let i = 0; i < chunks.length; i++) {
      if (aborted()) { result.aborted = true; break }
      const chunk = chunks[i]
      const rendered = renderTurns(chunk)
      const when = new Date(chunk[chunk.length - 1]?.time || Date.now())
      const t0 = Date.now()
      const res = await serial.push(() => summarizeChunk(llm, route, {
        date: dayKey(when),
        turns: rendered,
        chunkNo: i + 1,
        chunkTotal: chunks.length,
        maxTokens: Number(config.summaryMaxTokens) || 8000,
        signal,
      })) || { ok: false, error: 'queue-returned-nothing' }
      const elapsed = Date.now() - t0
      if (!res.ok) {
        result.failed += 1
        stats.lastError = `${stamp()} 摘要失败：${res.error}`
        // 留下来当证据：失败也要能看出用的哪个路由、错在哪
        try {
          onAttempt?.({
            ok: false, provider: route.provider, model: route.model,
            ms: elapsed, sessionId: id, error: res.error,
          })
        } catch { /* ignore */ }
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
      // 成功也要留证据 —— 这是「hy3 真跑了」的唯一凭据
      try {
        onAttempt?.({
          ok: true, provider: route.provider, model: route.model,
          ms: elapsed, sessionId: id, chunks: 1,
          sample: s.skip ? '(skip)' : String(s.summary || '').slice(0, 120),
        })
      } catch { /* ignore */ }
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
    /**
     * ⚠️ 「有原话」就该算「用户明说」。
     *
     * 2026-10-21 的真实事故：模型把「改任何文件之前必须先读一遍再编辑」
     * 这条的 evidence 标成了「模型推断」—— 但它的原话是
     * 「记住，每次想编辑哪个文件一定要先读取再编辑」，那明明是用户说的。
     *
     * 结果：这条被下游的「只认用户明说」过滤掉，永远不进提示词。
     * 用户第二天问「我告诉你了你怎么没记住」。
     *
     * 打标错了不该由下游背锅。这里做一次纠正：
     * **有逐字原话 = 用户明说**（原话是摘录，比「来源」这个标签可信）。
     */
    const evidence = String(c.evidence || '') === '用户明说' || String(c.quote || '').trim()
      ? '用户明说'
      : '模型推断'
    const line = `[${id}] [${c.section}] ${c.text}（${evidence} ｜ 置信度：${c.confidence} ｜ ${day}${c.quote ? ` ｜ 原话：「${c.quote}」` : ''}）`
    store.appendToEvergreen('preferences', c.section, line)
    stats.promotedPrefs += 1
    promoted.push({ layer: 'preferences', id, section: c.section, text: c.text })
    log(`自动提升 preferences/${c.section}：${c.text.slice(0, 40)}`)
  }
  return promoted
}

/**
 * 决定这一轮用哪条路由摘要。
 *
 * 🔴 2026-10-20 的用户投诉「让你用 hy3 摘要怎么不实现」就出在这里：
 *    原来只要配置里填了 `buddy/hy3` 就无条件返回它。可 `buddy` 这个 provider
 *    在某些时刻是**没注册**的（插件启动太早 / 通道临时掉了），于是每次摘要都
 *    撞 `NO_ADAPTER`，一条都写不出来。而用户要的其实是「**用 hy3 这个模型**」，
 *    不是「用 buddy 这个 provider 名字」。
 *
 * ⚠️ 最容易写错的地方：**provider 名字和模型名字不是一回事**。
 *
 * 解析顺序（从「尊重用户意图」到「尽量能跑」）：
 *   ① provider + model 都填了，provider 也在 → 直接用
 *   ② provider 没了，但**别的 provider 里有同名模型** → 换过去（保住「用这个模型」的意图）
 *   ②b 只填了 provider → 从它的目录里取第一个模型
 *   ②c 只填了模型 → 找哪个 provider 有这个模型
 *   ③ 用户明确指定了模型，但整台机器上都没有 → **不硬凑**，退回配置让问题暴露
 *   ④ 什么都没配（新装常态）→ 会话路由 → llm 默认 → 扫目录挑第一条能用的
 *
 * 分界线很清楚：
 *   · 「同名模型换个 provider」→ 满足他的意图，可以做；
 *   · 「随便找个别的模型顶上」→ 篡改他的意图，绝对不做。
 */
async function resolveRoute(config, events, llm) {
  const p = String(config.summarizerProvider || '').trim()
  const m = String(config.summarizerModel || '').trim()

  let ids = []
  try {
    const providers = llm?.listProviders?.() || []
    ids = providers.map((x) => String(x?.id ?? x?.name ?? x ?? '')).filter(Boolean)
  } catch { ids = [] }

  if (p && m) {
    // ① provider 在就照用
    // llm 服务拿不到 provider 列表时（极少数）：直接信配置
    if (!ids.length) return { provider: p, model: m, via: 'config' }
    if (ids.includes(p)) return { provider: p, model: m, via: 'config' }

    // ② provider 没了 —— 找同名模型的其它 provider（模型名和 provider 名经常对不上）
    const fallback = await findProviderForModel(llm, ids, m)
    if (fallback) return { provider: fallback, model: m, via: 'model-fallback', wanted: p }

    /**
     * ⚠️ 用户明确指定了这个模型、但整台机器上都没有 —— **不许偷偷换成别的模型**。
     *    这里直接退回配置，让「模型不可用」这个事实暴露在状态页和证据链里。
     */
    return { provider: p, model: m, via: 'config' }
  }

  // ②b 只填了 provider、没填模型 → 从该 provider 的目录里取第一个
  if (p && !m) {
    if (ids.includes(p)) {
      const first = await firstModelOf(llm, p)
      if (first) return { provider: p, model: first, via: 'provider-first-model' }
    }
    // 指定的 provider 不存在，但用户表达了「用这个 provider」的意图 → 退回配置暴露问题
    if (ids.length) return { provider: p, model: m, via: 'config' }
  }

  // ②c 只填了模型、没填 provider → 找哪个 provider 有这个模型
  if (!p && m) {
    const owner = await findProviderForModel(llm, ids, m)
    if (owner) return { provider: owner, model: m, via: 'model-lookup' }
    if (ids.length) return { provider: p, model: m, via: 'config' }
  }

  // ③ 什么都没配（首次安装的常态）：退到会话最近一次请求用的路由
  const r = latestRoute(events)
  if (r) return { ...r, via: 'session' }

  // ④ 默认模型服务里当前选的那个
  try {
    const sel = llm?.__defaultSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model, via: 'default' }
  } catch { /* ignore */ }

  // ⑤ 还不行：扫一遍目录，挑第一个真的有模型的 provider
  const auto = await pickAnyRoute(llm, ids)
  if (auto) return { ...auto, via: 'auto' }

  return null
}

/** 取某个 provider 目录里的第一个模型 id。 */
export async function firstModelOf(llm, provider, perProviderMs = 2500) {
  if (!llm || typeof llm.listModels !== 'function') return ''
  const list = await raceTimeout(
    Promise.resolve().then(() => llm.listModels(provider)),
    perProviderMs,
    null,
  )
  if (!Array.isArray(list)) return ''
  for (const x of list) {
    const id = String(x?.id ?? x ?? '')
    if (id) return id
  }
  return ''
}

/** 扫一遍 provider 列表，挑第一个真的有模型的。 */
async function pickAnyRoute(llm, providerIds) {
  for (const id of providerIds || []) {
    const model = await firstModelOf(llm, id)
    if (model) return { provider: id, model }
  }
  return null
}

/**
 * 按「用户想要的模型」解析出一条能用的路由 —— 给 index.js 的探针复用。
 * provider 名变了也能落到同名模型上。
 */
export async function resolveSummarizerRoute(llm, cfg) {
  const r = await resolveRoute({ summarizerProvider: cfg.summarizerProvider, summarizerModel: cfg.summarizerModel }, [], llm)
  return r || { provider: cfg.summarizerProvider, model: cfg.summarizerModel, via: 'config' }
}

/**
 * 在已注册的 provider 里找一个真的带这个模型的。
 *
 * ⚠️ `llm.listModels()` 是 **async** 的（`Promise<LlmModelInfo[]>`），而且某个适配器
 *    没加载完时可能挂住。所以：
 *      · 必须 await；
 *      · 每个 provider 套一个短超时，问不动就跳过，绝不让它拖住整轮采集。
 */
export async function findProviderForModel(llm, providerIds, model, perProviderMs = 2500) {
  if (!llm || typeof llm.listModels !== 'function') return ''
  for (const id of providerIds) {
    const list = await raceTimeout(
      Promise.resolve().then(() => llm.listModels(id)),
      perProviderMs,
      null,
    )
    if (!Array.isArray(list)) continue
    const ids = list.map((x) => String(x?.id ?? x ?? ''))
    if (ids.includes(model)) return id
  }
  return ''
}

/** 给 promise 套超时，超时返回 fallback（不抛）。 */
function raceTimeout(p, ms, fallback) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const t = setTimeout(() => finish(fallback), ms)
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); finish(v) },
      () => { clearTimeout(t); finish(fallback) },
    )
  })
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
