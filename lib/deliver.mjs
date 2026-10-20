/**
 * lib/deliver.mjs —— 把「她想说的那句话」真的递进会话
 * ============================================================================
 * 核心决策：**用 `agent.followup(createUserMessage(...))`，不用 schedule 服务。**
 *
 * 为什么不走 `ctx.schedule.create()`（它其实也能唤醒）：
 *   ① 投递正文会被宿主包成 `[SCHEDULE REMINDER] … "This is a scheduled message from the user"
 *      … reminder_prompt_json: "…"` —— 陪伴场景漏味；
 *   ② Web UI 会把它渲染成「自动化任务」的折叠卡，一眼就能看出是机器定时任务。
 *   用户要的是「她自己开口」，不是「一个提醒弹出来」。
 *
 * 为什么必须是 followup 而不是 inject：
 *   `inject` 是 next-step + **不唤醒**；只有 `followup` 会开一个新 turn。
 *   只 inject 的话，这句话会在收件箱里躺着，直到他下次说话才被顺带看到 ——
 *   等于什么都没发生。
 *
 * ⚠️ 依赖的签名（已对着宿主源码核实）：
 *   `Agent.followup(message: UserMessage)`
 *   `createUserMessage({ content: ContentBlock[], source: {...} })`
 *   `ctx.agents.get(sessionId)` / `ctx.agents.list()`（**创建顺序，不是活跃度**）
 * ============================================================================
 */

/** 尽量从宿主那棵树里借到 createUserMessage；借不到就自己造一个等价对象。 */
export async function loadCreateUserMessage(ctx) {
  // ① 先问宿主有没有现成的服务/工具
  try {
    const viaCtx = ctx?.get?.('createUserMessage')
    if (typeof viaCtx === 'function') return viaCtx
  } catch { /* ignore */ }

  // ② 直接 import —— 平级 workspace 里通常能解析到
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod?.createUserMessage === 'function') return mod.createUserMessage
  } catch { /* 拿不到就走下面的兜底 */ }

  // ③ 兜底：按 MessageBase 的形状自己拼。宿主只要求它是一个合法 UserMessage：
  //    { role:'user', content: ContentBlock[], source: { kind } }，外加一个 id。
  return (input) => ({
    id: `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: Array.isArray(input?.content) ? input.content : [{ type: 'text', text: String(input?.text || '') }],
    source: input?.source || { kind: 'companion' },
  })
}

/**
 * 挑一个「该在哪个会话里说话」。
 *
 * ⚠️ 宿主**拿不到**「他现在看的是哪个会话」——没有服务/字段/事件表达 UI 焦点。
 *    所以只能退化成「最近有活动的会话」：先看我们自己的 presence 水位，
 *    再退回 sessionQuery 的列表顺序（listSessions 是 newest-first，按 createdAt）。
 *
 * @returns {Promise<{sessionId:string, reason:string} | {sessionId:'', reason:string}>}
 */
export async function pickTargetSession({ ctx, presence, mode = 'recent' }) {
  if (mode === 'off') return { sessionId: '', reason: '会话模式设成了「不主动说」' }

  // ① 我们自己记的水位最准（session/event 每次 append 都推）
  const recent = presence?.recent?.(20) || []
  if (recent.length) {
    for (const r of recent) {
      const live = isUsable(ctx, r.sessionId)
      if (live.ok) return { sessionId: r.sessionId, reason: `最近活动的会话（${live.why}）` }
    }
  }

  // ② 退回 sessionQuery：newest-first
  try {
    const sq = ctx?.get?.('sessionQuery')
    if (sq && typeof sq.listSessions === 'function') {
      const records = (await sq.listSessions()) || []
      for (const rec of records) {
        const id = rec?.header?.id
        if (!id) continue
        if (rec?.header?.origin === 'subagent') continue
        const live = isUsable(ctx, id)
        if (live.ok) return { sessionId: id, reason: `最新的会话（${live.why}）` }
      }
    }
  } catch { /* 走空 */ }

  return { sessionId: '', reason: '找不到可以说话的会话' }
}

/** 这个会话现在能不能被她插一句话进去。 */
export function isUsable(ctx, sessionId) {
  const agents = ctx?.get?.('agents')
  if (!agents || typeof agents.get !== 'function') return { ok: false, why: 'agents 服务不可用' }
  let agent = null
  try { agent = agents.get(String(sessionId)) } catch { agent = null }
  if (!agent) return { ok: false, why: '会话不在线（没打开过）' }
  if (typeof agent.followup !== 'function') return { ok: false, why: '这个 agent 不支持 followup' }
  // 子代理会话不插话（那是别的 agent 在干活）
  try {
    const depth = Number(agent?.session?.header?.delegationDepth) || 0
    if (depth > 0) return { ok: false, why: '子代理会话' }
  } catch { /* ignore */ }
  return { ok: true, why: '在线' }
}

/**
 * 真正把话递进去。
 * @returns {Promise<{ok:boolean, sessionId?:string, error?:string, via?:string}>}
 */
export async function deliverToSession({ ctx, sessionId, text, makeMessage, log = () => {} }) {
  if (!sessionId) return { ok: false, error: 'no-target-session' }
  const usable = isUsable(ctx, sessionId)
  if (!usable.ok) return { ok: false, error: `会话不可用：${usable.why}` }

  const agent = ctx.get('agents').get(String(sessionId))
  const message = makeMessage({
    content: [{ type: 'text', text: String(text) }],
    // 自己的 source kind：既不是 'user'，也不是宿主的 'schedule'。
    // 好处：`api-session/activity` 只在 source.kind === 'user' 时推进，
    // 所以她这一句**不会**把会话的活跃度搅乱。
    source: { kind: 'companion' },
  })

  try {
    await agent.followup(message)
    log(`companion 已递话到 ${String(sessionId).slice(0, 12)}`)
    return { ok: true, sessionId: String(sessionId), via: 'followup' }
  } catch (e) {
    log(`companion followup 失败：${e?.message || e}`)
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}
