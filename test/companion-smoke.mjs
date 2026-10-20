/**
 * test/companion-smoke.mjs —— 主动陪聊的决策逻辑测试
 * 跑法：node test/companion-smoke.mjs
 *
 * 这套测试一件重要的事：**确认「不说」是大多数时候的正确结果**。
 */
import { runCompanionOnce, precheck, inQuietHours, parseDecision, normalizeState, freshState, todayKey } from '../lib/companion.mjs'
import { normalizeDecision, buildCompanionPrompt, humanMinutes } from '../lib/companion-prompt.mjs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const CFG = {
  companionEnabled: true,
  companionIntervalMinutes: 30,
  companionMinGapMinutes: 90,
  companionMaxPerDay: 6,
  companionQuietStart: '23:30',
  companionQuietEnd: '09:00',
  companionSessionMode: 'recent',
  companionMaxTokens: 2000,
}

const at = (h, m = 0) => { const d = new Date(2026, 9, 20, h, m, 0, 0); return d }

console.log('[1] 安静时段')
check('23:45 在安静时段内', inQuietHours(at(23, 45), '23:30', '09:00'))
check('03:00 在安静时段内', inQuietHours(at(3, 0), '23:30', '09:00'))
check('08:59 在安静时段内', inQuietHours(at(8, 59), '23:30', '09:00'))
check('09:00 已经出了安静时段', !inQuietHours(at(9, 0), '23:30', '09:00'))
check('14:00 不在安静时段', !inQuietHours(at(14, 0), '23:30', '09:00'))
check('起止相同 = 没有安静时段', !inQuietHours(at(3, 0), '09:00', '09:00'))
check('时间格式错就当作没有安静时段', !inQuietHours(at(3, 0), '', '09:00'))

console.log('\n[2] 前置检查（三重刹车）')
const fresh = { ...freshState(), day: todayKey(at(14)), todayCount: 0, lastSpokeAt: 0 }
check('总开关关着 → 不说', precheck({ cfg: { ...CFG, companionEnabled: false }, state: fresh, now: at(14) }).speak === false)
check('安静时段 → 不说', precheck({ cfg: CFG, state: fresh, now: at(3) }).speak === false)
check('正常条件下通过前置检查', precheck({ cfg: CFG, state: fresh, now: at(14) }).speak === true)
check('达到每日上限 → 不说',
  precheck({ cfg: CFG, state: { ...fresh, todayCount: 6 }, now: at(14) }).speak === false)
check('不同日期重置计数',
  precheck({ cfg: CFG, state: { ...fresh, day: '2024-01-01', todayCount: 99 }, now: at(14) }).speak === true)
check('最小间隔没到 → 不说',
  precheck({ cfg: CFG, state: { ...fresh, lastSpokeAt: at(13, 30).getTime() }, now: at(14) }).speak === false,
  precheck({ cfg: CFG, state: { ...fresh, lastSpokeAt: at(13, 30).getTime() }, now: at(14) }).reason)
check('最小间隔已过 → 通过',
  precheck({ cfg: CFG, state: { ...fresh, lastSpokeAt: at(12, 0).getTime() }, now: at(14) }).speak === true)

console.log('\n[3] 模型决定「不说」时什么都不做')
{
  const fakeLlm = makeLlm({ speak: false, reason: '他刚刚还在忙，没有由头', text: '', target: 'none' })
  let delivered = 0
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: fakeLlm,
    pickRoute: async () => ({ provider: 'buddy', model: 'hy3' }),
    gatherContext: async () => ({ recent: '他：在写插件', silentForMinutes: 5 }),
    deliver: async () => { delivered++; return { ok: true } },
    now: at(14),
  })
  check('决策 = silent', r.decision === 'silent', r.reason)
  check('没有发送任何东西', delivered === 0)
}

console.log('\n[4] 模型决定「说」时真的发出去')
{
  const fakeLlm = makeLlm({ speak: true, reason: '他提过今天要交东西', text: '你说的那个东西今天要交了吧？', target: 'recent' })
  let got = null
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: fakeLlm,
    pickRoute: async () => ({ provider: 'buddy', model: 'hy3' }),
    gatherContext: async () => ({ recent: '他：今天要交那个东西', silentForMinutes: 120 }),
    deliver: async (text) => { got = text; return { ok: true, sessionId: 'session-abc' } },
    now: at(14),
  })
  check('决策 = speak', r.decision === 'speak')
  check('delivered = true', r.delivered === true)
  check('发出去的正是那句话', got === '你说的那个东西今天要交了吧？', got)
}

console.log('\n[5] dryRun 只预览不发送')
{
  const fakeLlm = makeLlm({ speak: true, reason: 'x', text: '预览用的句子', target: 'recent' })
  let delivered = 0
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: fakeLlm,
    pickRoute: async () => ({ provider: 'buddy', model: 'hy3' }),
    gatherContext: async () => ({}),
    deliver: async () => { delivered++; return { ok: true } },
    dryRun: true, now: at(14),
  })
  check('dryRun 也给出决策', r.decision === 'speak')
  check('dryRun 不发送', delivered === 0)
  check('dryRun 带回预览文本', r.text === '预览用的句子')
}

console.log('\n[6] 各种坏情况的兜底')
{
  // 说要说，但没给文本 → 等于不说
  const fakeLlm = makeLlm({ speak: true, reason: '想说话', text: '   ', target: 'recent' })
  let delivered = 0
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: fakeLlm,
    pickRoute: async () => ({ provider: 'buddy', model: 'hy3' }),
    gatherContext: async () => ({}),
    deliver: async () => { delivered++; return { ok: true } },
    now: at(14),
  })
  check('要说话但没内容 → 当作不说', r.decision === 'silent', r.reason)
  check('也没发送', delivered === 0)
}
{
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: makeLlm(null),
    pickRoute: async () => null,
    gatherContext: async () => ({}), deliver: async () => ({ ok: true }), now: at(14),
  })
  check('没有模型路由 → ok:false，不崩', r.ok === false && r.error === 'no-route')
}
{
  const boom = { stream() { throw new Error('NO_ADAPTER') } }
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: boom,
    pickRoute: async () => ({ provider: 'nope', model: 'x' }),
    gatherContext: async () => ({}), deliver: async () => ({ ok: true }), now: at(14),
  })
  check('模型同步抛错 → 被吃掉，返回 silent', r.decision === 'silent' && r.ok === false)
}
{
  const fakeLlm = makeLlm({ speak: true, reason: 'x', text: '会失败的一句', target: 'recent' })
  const r = await runCompanionOnce({
    cfg: CFG, state: fresh, llm: fakeLlm,
    pickRoute: async () => ({ provider: 'buddy', model: 'hy3' }),
    gatherContext: async () => ({}),
    deliver: async () => ({ ok: false, error: 'no-target-session' }),
    now: at(14),
  })
  check('发送失败 → delivered:false 且带错误', r.delivered === false && r.error === 'no-target-session')
}

console.log('\n[7] JSON 解析容错')
check('纯 JSON', parseDecision('{"speak":false,"reason":"x"}').speak === false)
check('代码围栏包着', parseDecision('```json\n{"speak":true,"reason":"y","text":"hi"}\n```').text === 'hi')
check('前后有废话', parseDecision('好的，我的判断是：{"speak":true,"reason":"z","text":"hey"} 就这样').text === 'hey')
check('完全不是 JSON → 不说话', parseDecision('我觉得还是算了吧').speak === false)
check('空字符串 → 不说话', parseDecision('').speak === false)
check('speak 是字符串 "true" 不认', parseDecision('{"speak":"true","text":"hi"}').speak === false)

console.log('\n[8] 提示词与工具函数')
{
  const p = buildCompanionPrompt({ cfg: CFG, state: { ...fresh, lastSpokeAt: at(12).getTime(), todayCount: 2 }, now: at(14), context: { recent: '他：你好', silentForMinutes: 120 } })
  check('提示词含当前时间', /14:00/.test(p.user))
  check('提示词含每日次数', /2 次/.test(p.user))
  check('提示词含「他已经 2 小时没说话」', /2 小时/.test(p.user))
  check('system 里强调沉默是默认', /大多数时候正确答案是\*\*不说\*\*/.test(p.system))
  check('humanMinutes 正常', humanMinutes(90) === '1 小时 30 分钟', humanMinutes(90))
}

console.log('\n[9] 状态归一化（升级不崩）')
check('全空也能归一化', normalizeState(null).todayCount === 0)
check('缺字段补齐', normalizeState({ lastSpokeAt: 123 }).todayCount === 0 && normalizeState({ lastSpokeAt: 123 }).lastSpokeAt === 123)
check('log 不是数组也不崩', Array.isArray(normalizeState({ log: 'oops' }).log))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)

/** 造一个假 llm，把给定对象当 JSON 吐出来 */
function makeLlm(obj, { textMode = 'fence' } = {}) {
  return {
    stream() {
      const body = obj === null ? 'not json at all' : JSON.stringify(obj)
      const text = textMode === 'fence' ? '```json\n' + body + '\n```' : body
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: text.slice(0, 12) }
        yield { type: 'text-delta', index: 0, text: text.slice(12) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}
