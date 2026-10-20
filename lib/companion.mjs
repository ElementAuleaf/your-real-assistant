/**
 * lib/companion.mjs —— 「她自己决定要不要找你说话」
 * ============================================================================
 * 它不是「每 30 分钟无条件发一条」，而是**先判断、再决定**：
 *
 *   到点了 → 收集上下文（现在几点、最近在聊什么、上次开口是什么时候、今天说了几次、
 *            有没有安静时段、记忆里的近况）
 *        → 让模型回答一个严格 JSON：{ speak: bool, reason: str, text: str, target: 'recent'|'none' }
 *        → speak=false：什么都不做（这是大多数轮次的正常结果）
 *        → speak=true ：把这句话作为**她自己的一条消息**递进会话
 *
 * 设计上的几条硬规矩：
 *   ① 默认关闭。会主动往会话里塞消息的功能，必须人自己开。
 *   ② 有频率上限 + 最小间隔 + 安静时段，三重刹车，绝不刷屏。
 *   ③ 判断用的模型和聊天用的模型分开可配（默认跟随摘要模型）。
 *   ④ 所有失败都吞掉并记日志 —— 它跑在定时器里。
 * ============================================================================
 */
import { buildCompanionPrompt, normalizeDecision } from './companion-prompt.mjs'

/** 本地时间 `HH:MM` → 当天分钟数；解析失败返回 null。 */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 现在是否落在安静时段里（支持跨零点，比如 23:30–09:00）。 */
export function inQuietHours(now, start, end) {
  const s = minutesOf(start)
  const e = minutesOf(end)
  if (s === null || e === null) return false
  if (s === e) return false // 起止相同 = 没有安静时段
  const cur = now.getHours() * 60 + now.getMinutes()
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)
}

/** 今天的日期键（本地）。 */
export function todayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** companion 的运行状态（落盘，重启不丢「今天说了几次」）。 */
export function freshState() {
  return {
    lastAt: 0,            // 上次**判断**的时刻
    lastSpokeAt: 0,       // 上次**真的开口**的时刻
    lastDecision: '',     // 'speak' | 'silent' | ''
    lastReason: '',
    lastText: '',
    lastSessionId: '',
    day: '',              // 计数归属的日期
    todayCount: 0,        // 今天说了几次
    log: [],              // 最近若干次判断
  }
}

/** 把一次判断写进状态（落盘前的纯内存变更）。 */
export function recordOutcome(state, outcome, now = new Date()) {
  const s = state
  s.lastAt = now.getTime()
  s.lastDecision = outcome.decision === 'speak' ? 'speak' : 'silent'
  s.lastReason = String(outcome.reason || '').slice(0, 300)
  if (outcome.decision === 'speak') {
    s.lastText = String(outcome.text || '').slice(0, 600)
    if (outcome.delivered) {
      s.lastSpokeAt = now.getTime()
      s.lastSessionId = String(outcome.sessionId || '')
      const day = todayKey(now)
      if (s.day !== day) { s.day = day; s.todayCount = 0 }
      s.todayCount = (Number(s.todayCount) || 0) + 1
    }
  }
  s.log = Array.isArray(s.log) ? s.log : []
  s.log.push({
    at: now.getTime(),
    decision: s.lastDecision,
    reason: s.lastReason,
    text: outcome.decision === 'speak' ? String(outcome.text || '').slice(0, 200) : '',
    delivered: Boolean(outcome.delivered),
    dryRun: Boolean(outcome.dryRun),
    error: outcome.error ? String(outcome.error).slice(0, 200) : '',
  })
  if (s.log.length > 40) s.log = s.log.slice(-40)
  return s
}

/** 下次该检查的时刻（毫秒）；界面用来显示「下次检查：…」 */
export function nextCheckAt(cfg, state) {
  const interval = Math.max(1, Number(cfg?.companionIntervalMinutes) || 30) * 60_000
  const base = Number(state?.lastAt) || Date.now()
  return base + interval
}
export function normalizeState(raw) {
  const base = freshState()
  const s = raw && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  for (const k of Object.keys(base)) {
    if (k === 'log') { out.log = Array.isArray(s.log) ? s.log.slice(-40) : [] ; continue }
    if (typeof base[k] === 'number') { const n = Number(s[k]); out[k] = Number.isFinite(n) ? n : base[k] }
    else if (typeof base[k] === 'string') out[k] = typeof s[k] === 'string' ? s[k] : base[k]
  }
  return out
}

/**
 * 决定这一轮要不要开口 —— **纯函数**，不碰网络不碰磁盘，方便单测。
 *
 * @returns {{speak:false, reason:string} | {speak:true, reason:string}}
 */
export function precheck({ cfg, state, now = new Date(), ignoreEnabled = false }) {
  if (!cfg.companionEnabled && !ignoreEnabled) return { speak: false, reason: '总开关关着' }
  if (cfg.companionSessionMode === 'off') return { speak: false, reason: '会话模式设成「不主动说」' }

  if (inQuietHours(now, cfg.companionQuietStart, cfg.companionQuietEnd)) {
    return { speak: false, reason: `现在是安静时段（${cfg.companionQuietStart}–${cfg.companionQuietEnd}）` }
  }

  const day = todayKey(now)
  const count = state.day === day ? Number(state.todayCount) || 0 : 0
  const max = Math.max(0, Number(cfg.companionMaxPerDay) || 0)
  if (max > 0 && count >= max) return { speak: false, reason: `今天已经说了 ${count} 次，到上限了` }

  const gapMs = Math.max(0, Number(cfg.companionMinGapMinutes) || 0) * 60_000
  if (gapMs > 0 && state.lastSpokeAt && now.getTime() - state.lastSpokeAt < gapMs) {
    const left = Math.ceil((gapMs - (now.getTime() - state.lastSpokeAt)) / 60_000)
    return { speak: false, reason: `距离上次开口还不到最小间隔（还要 ${left} 分钟）` }
  }

  return { speak: true, reason: '通过前置检查，交给模型判断' }
}

/**
 * 跑一轮：前置检查 → 让模型决定 → （可选）真的说出去。
 *
 * @param {object} p
 * @param {object} p.cfg
 * @param {object} p.state
 * @param {object} p.llm                 ctx.get('llm')
 * @param {(route)=>Promise<object|null>} p.pickRoute 返回 {provider,model} 或 null
 * @param {(cfg)=>Promise<object|null>}  p.gatherContext 收集上下文（时间/最近对话/记忆）
 * @param {(text, ctx)=>Promise<object>} p.deliver 把那句话递进会话；返回 {ok, sessionId?, error?}
 * @param {boolean} p.dryRun 只判断不发送
 * @param {Function} p.log
 * @returns {Promise<object>} 判断结果，永远不抛
 */
export async function runCompanionOnce({
  cfg, state, llm, pickRoute, gatherContext, deliver, dryRun = false, log = () => {}, now = new Date(), ignoreEnabled = false, forceSpeak = false,
}) {
  const pre = precheck({ cfg, state, now, ignoreEnabled })
  if (!pre.speak) {
    return { ok: true, decision: 'silent', reason: pre.reason, dryRun, skippedBy: 'precheck' }
  }

  let route = null
  try { route = await pickRoute(cfg) } catch { route = null }
  if (!route || !route.provider || !route.model) {
    return { ok: false, decision: 'silent', reason: '没有可用的模型路由', dryRun, error: 'no-route' }
  }

  let context = {}
  try { context = (await gatherContext(cfg)) || {} } catch (e) {
    log(`companion 收集上下文失败：${e?.message || e}`)
    context = {}
  }

  const prompt = buildCompanionPrompt({ cfg, state, now, context, forceSpeak })
  let decision = null
  try {
    decision = await askModel({ llm, route, prompt, maxTokens: Number(cfg.companionMaxTokens) || 2000 })
  } catch (e) {
    log(`companion 判断失败：${e?.message || e}`)
    return { ok: false, decision: 'silent', reason: '模型调用失败', dryRun, error: String(e?.message || e).slice(0, 200) }
  }

  if (!decision || decision.speak !== true) {
    return {
      ok: true,
      decision: 'silent',
      reason: (decision && decision.reason) || '模型决定不说话',
      text: '',
      dryRun,
    }
  }

  const text = String(decision.text || '').trim()
  if (!text) {
    return { ok: true, decision: 'silent', reason: '模型说要说话，但没给出内容', dryRun }
  }

  if (dryRun) {
    return { ok: true, decision: 'speak', reason: decision.reason || '', text, dryRun, delivered: false }
  }

  let out = { ok: false, error: 'not-delivered' }
  try { out = (await deliver(text, { sessionId: decision.sessionId, context })) || { ok: false } } catch (e) {
    out = { ok: false, error: String(e?.message || e) }
  }

  if (!out.ok) {
    log(`companion 发送失败：${out.error || 'unknown'}`)
    return { ok: false, decision: 'speak', reason: decision.reason || '', text, dryRun, delivered: false, error: out.error }
  }

  return {
    ok: true,
    decision: 'speak',
    reason: decision.reason || '',
    text,
    dryRun,
    delivered: true,
    sessionId: out.sessionId || '',
  }
}

/**
 * 问模型：现在要不要开口？只接受严格 JSON。
 * 错误是带内传回来的（finish chunk），所以要显式检查。
 */
export async function askModel({ llm, route, prompt, maxTokens = 2000, signal }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 不可用')
  let text = ''
  const options = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
    maxTokens,
  }
  if (signal) options.signal = signal

  const stream = llm.stream(options) // 可能同步抛 NO_ADAPTER
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason) {
      const kind = chunk.reason.kind || chunk.reason
      if (kind === 'error' || kind === 'aborted') {
        const f = chunk.reason.failure || {}
        const err = new Error(`llm ${kind}: ${f.message || 'unknown'}`)
        err.code = f.code || String(kind).toUpperCase()
        throw err
      }
      if (kind === 'max-tokens') {
        const err = new Error('判断被 maxTokens 截断（推理模型吃预算，调大 companionMaxTokens）')
        err.code = 'MAX_TOKENS'
        throw err
      }
    }
  }
  return parseDecision(text)
}

/** 从模型回复里抠出严格 JSON；抠不出来就当「不说话」。 */
export function parseDecision(raw) {
  const s = String(raw || '').trim()
  if (!s) return normalizeDecision(null)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const candidate = fenced ? fenced[1].trim() : s
  const start = candidate.indexOf('{')
  if (start < 0) return normalizeDecision(null)
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return normalizeDecision(JSON.parse(candidate.slice(start, i + 1))) } catch { return normalizeDecision(null) }
      }
    }
  }
  return normalizeDecision(null)
}
