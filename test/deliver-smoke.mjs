/**
 * test/deliver-smoke.mjs —— 单独验证「话能不能递进会话」
 * 跑法：node test/deliver-smoke.mjs
 *
 * 用假 ctx 复现宿主的形状：agents.get(id) → agent.followup(msg)。
 * 真实模型那条路另外测（会真的往会话里发东西），这里只测投递机制。
 */
import { deliverToSession, pickTargetSession, isUsable, loadCreateUserMessage } from '../lib/deliver.mjs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

/** 造一个假宿主：一个会话、一个 agent、followup 记录收到的消息。 */
function makeCtx({ live = true, depth = 0, throwOnFollowup = false } = {}) {
  const sent = []
  const sessionId = 'session-test-0001'
  const agent = {
    session: { header: { id: sessionId, delegationDepth: depth } },
    async followup(msg) {
      if (throwOnFollowup) throw new Error('driver busy')
      sent.push(msg)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => (live && id === sessionId ? agent : undefined),
          list: () => (live ? [agent] : []),
        }
      }
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            return [{ header: { id: sessionId, createdAt: Date.now(), cwd: 'C:/w' }, live, persisted: true }]
          },
        }
      }
      return undefined
    },
  }
  return { ctx, sent, sessionId, agent }
}

const makeMessage = (input) => ({ id: 'test-msg', role: 'user', content: input.content, source: input.source })

console.log('[1] 会话可用性判断')
{
  const { ctx, sessionId } = makeCtx()
  check('在线会话 → 可用', isUsable(ctx, sessionId).ok, isUsable(ctx, sessionId).why)
  check('不存在的会话 → 不可用', !isUsable(ctx, 'session-nope').ok)
  const sub = makeCtx({ depth: 2 })
  check('子代理会话 → 不可用', !isUsable(sub.ctx, sub.sessionId).ok, isUsable(sub.ctx, sub.sessionId).why)
  const dead = makeCtx({ live: false })
  check('不在线 → 不可用', !isUsable(dead.ctx, dead.sessionId).ok, isUsable(dead.ctx, dead.sessionId).why)
}

console.log('\n[2] 真的递进去')
{
  const { ctx, sent, sessionId } = makeCtx()
  const r = await deliverToSession({ ctx, sessionId, text: '在忙吗？', makeMessage })
  check('deliver ok', r.ok === true, r.error || '')
  check('followup 被调用了一次', sent.length === 1)
  const msg = sent[0] || {}
  check('是 user 角色', msg.role === 'user')
  check('正文就是那句话', msg.content?.[0]?.text === '在忙吗？', JSON.stringify(msg.content))
  check('source.kind = companion', msg.source?.kind === 'companion', JSON.stringify(msg.source))
}

console.log('\n[3] 失败路径')
{
  const { ctx, sessionId } = makeCtx()
  const r = await deliverToSession({ ctx, sessionId: 'session-nope', text: 'x', makeMessage })
  check('没有目标会话 → 明确报错', r.ok === false && /不可用/.test(r.error || ''), r.error)
}
{
  const { ctx, sent, sessionId } = makeCtx({ throwOnFollowup: true })
  const r = await deliverToSession({ ctx, sessionId, text: 'x', makeMessage })
  check('followup 抛错 → 被吃掉并返回失败', r.ok === false && r.error === 'driver busy', r.error)
  check('没有留下半条消息', sent.length === 0)
}

console.log('\n[4] 挑会话')
{
  const { ctx, sessionId } = makeCtx()
  const presence = { recent: () => [{ sessionId, at: Date.now() }] }
  const pick = await pickTargetSession({ ctx, presence, mode: 'recent' })
  check('从活动水位里挑到会话', pick.sessionId === sessionId, pick.reason)
}
{
  const { ctx, sessionId } = makeCtx()
  const presence = { recent: () => [] }
  const pick = await pickTargetSession({ ctx, presence, mode: 'recent' })
  check('水位空时退回 sessionQuery', pick.sessionId === sessionId, pick.reason)
}
{
  const { ctx, sessionId } = makeCtx()
  const presence = { recent: () => [{ sessionId, at: Date.now() }] }
  const pick = await pickTargetSession({ ctx, presence, mode: 'off' })
  check('mode=off 时不挑会话', pick.sessionId === '')
}

console.log('\n[5] createUserMessage 兜底')
{
  const fallback = await loadCreateUserMessage({ get: () => undefined })
  check('拿不到宿主导出时仍返回一个函数', typeof fallback === 'function')
  const msg = fallback({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'companion' } })
  check('兜底消息有 role/content/source', msg.role === 'user' && Array.isArray(msg.content) && msg.source.kind === 'companion')
  check('兜底消息有 id', typeof msg.id === 'string' && msg.id.length > 0)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
