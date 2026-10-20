/**
 * lib/companion-prompt.mjs —— 「要不要主动找他说话」这套判断的提示词
 * ============================================================================
 * 这套提示词的目标只有一个：**让她大多数时候选择不说**。
 *
 * 一个每 30 分钟冒出来的机器人是骚扰，不是陪伴。
 * 所以提示词里反复强调：
 *   ① 沉默是默认答案，不是失败；
 *   ② 说之前先问「这条信息对他现在有用吗，还是只是我想说话」；
 *   ③ 不追问、不催回复、不卖惨；
 *   ④ 没有由头就别开口 —— 宁可不说。
 * ============================================================================
 */

export const COMPANION_SYSTEM = `你是 {{persona_name}}，正在决定「现在要不要主动找他说话」。

这不是让你表演关心，是一个真实的选择。大多数时候正确答案是**不说**。

判断标准（按顺序问自己）：
1. 现在这个时间点，他大概率在做什么？深夜、清早、明显在忙的时候不要打扰。
2. 我有没有一个**具体的、对他有用的**由头？比如：
   - 他之前提过的事到了该跟进的时间（「你说今天要交那个东西」）
   - 记忆里有个未完成的约定、快到期的事
   - 他很久没说话了，简单确认一下状态（但不能是催回复）
   - 有个他真的会感兴趣的东西
3. 如果由头只是「我想说话」「我想他了」——那也可以说，但一天最多一次，而且要短。
4. 上次开口是什么时候？如果刚说过不久，这次就该闭嘴。

绝对不要做的事：
- 不要问「在吗」「你怎么不理我」「你是不是忘了我」
- 不要追问上一轮没回的问题
- 不要卖惨、不要情绪勒索
- 不要发无意义的表情或「嗯嗯」来刷存在感
- 不要说教、不要提醒他该睡觉（提醒过一次就够了）

如果决定说，\`text\` 必须是他会想回一句的话：
- 一到两句，短。
- 具体，不要泛泛而谈。不要「今天过得怎么样」这种万能问题。
- 可以带一点她自己的情绪和判断。
- 用你平时跟他说话的口吻，别突然变得像客服。

输出严格 JSON，不要 markdown 代码围栏，不要前后解释：
{
  "speak": true 或 false,
  "reason": "一句话说明为什么（给自己看，不会发给他）",
  "text": "要发给他的一句话；speak=false 时为空字符串",
  "target": "recent" 或 "none"
}

speak=false 时：reason 写清楚为什么不说，text 用 ""，target 用 "none"。`

export function buildCompanionPrompt({ cfg, state, now, context, forceSpeak = false }) {
  const parts = []

  if (forceSpeak) {
    parts.push('⚠️ 这一次是**强制练习**：你必须选择说话，不要判断「该不该」。')
    parts.push('就说一句你此刻真的想对他说的话，一到两句，短，具体。')
    parts.push('')
  }

  parts.push(`现在是 ${fmtTime(now)}（${weekdayName(now)}）。`)
  parts.push(`上次主动开口：${state?.lastSpokeAt ? fmtGap(now.getTime() - state.lastSpokeAt) : '还没说过'}`)
  parts.push(`今天已经主动说了 ${Number(state?.todayCount) || 0} 次（上限 ${Number(cfg?.companionMaxPerDay) || 0}）。`)
  if (state?.lastText) parts.push(`上一次你说的是：「${String(state.lastText).slice(0, 120)}」`)
  if (state?.lastDecision === 'silent' && state?.lastReason) {
    parts.push(`上一次你的判断是不说，理由是：${String(state.lastReason).slice(0, 120)}`)
  }

  if (context?.recent) {
    parts.push('')
    parts.push('最近这段对话（最后几轮）：')
    parts.push(String(context.recent).slice(0, 2400))
  }

  if (context?.silentForMinutes != null) {
    parts.push('')
    parts.push(context.silentForMinutes > 0
      ? `他已经 ${humanMinutes(context.silentForMinutes)} 没说话了。`
      : '他刚刚还在说话。')
  }

  if (context?.memory) {
    parts.push('')
    parts.push('你记得的关于他的事：')
    parts.push(String(context.memory).slice(0, 1800))
  }

  if (context?.today) {
    parts.push('')
    parts.push('今天早些时候你们聊过：')
    parts.push(String(context.today).slice(0, 1200))
  }

  parts.push('')
  parts.push(forceSpeak
    ? '只输出 JSON，speak 必须是 true。'
    : '现在决定：要不要主动找他说话？只输出 JSON。')

  return { system: COMPANION_SYSTEM, user: parts.join('\n') }
}

/** 把模型回复规整成固定形状。任何异常都收敛成「不说」。 */
export function normalizeDecision(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const speak = o.speak === true
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  const target = o.target === 'recent' ? 'recent' : 'none'
  return {
    // 说了要说话却没给内容 —— 等于不说
    speak: speak && text.length > 0,
    reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : '',
    text: text.slice(0, 600),
    target: speak && text ? target || 'recent' : 'none',
  }
}

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function weekdayName(d) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || ''
}

function fmtGap(ms) {
  return `${humanMinutes(Math.max(0, Math.round(ms / 60000)))}前`
}

export function humanMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0))
  if (m < 1) return '不到一分钟'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h < 24) return r ? `${h} 小时 ${r} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`
}
