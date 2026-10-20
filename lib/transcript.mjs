/**
 * lib/transcript.mjs —— 从会话日志里读出「人话」
 * ============================================================================
 * ⚠️ 这里最容易踩的坑：拿 `sessionQuery.listEvents()` 的返回值当消息用。
 * 那个接口返回的是 **SessionEventRecord**（只有 sessionId / seq / type / time / surface），
 * **根本没有 content 字段** ⇒ eventText() 永远返回 ''，于是自动沉淀一条都写不出来。
 *
 * 正确姿势：`readSession(id)` 拿到完整事件，再从 `data` 里取消息：
 *   user/message      → data          （UserMessage：{role, content:[{type:'text',text}]}）
 *   assistant/message  → data.message  （AssistantMessage）
 *   tool/result        → 跳过（工具输出不是他说的话）
 * ============================================================================
 */

/** 从一条消息里取纯文本（content 可能是字符串、段落数组、或带 text 的对象）。 */
export function textOfMessage(m) {
  try {
    if (typeof m === 'string') return m
    if (!m || typeof m !== 'object') return ''
    if (Array.isArray(m.content)) {
      let out = ''
      for (const b of m.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') out += b.text
      }
      return out
    }
    if (typeof m.content === 'string') return m.content
    if (typeof m.text === 'string') return m.text
    return ''
  } catch { return '' }
}

/** 去掉 harness 往用户消息里塞的运行时上下文块，别让摘要器把系统提醒当成人话。 */
export function stripRuntime(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<runtime-context>[\s\S]*?<\/runtime-context>/g, '')
    .trim()
}

/**
 * 把事件流折成 [{role:'他'|'她', text, seq, time}]。
 * @param {Array} events readSession().events
 */
export function toTurns(events) {
  const out = []
  if (!Array.isArray(events)) return out
  const ordered = events.slice().sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0))
  for (const ev of ordered) {
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type === 'user/message') {
      // 只收「人说的话」，relay / 子代理消息 / 系统注入的都不算
      const source = ev.data?.source
      if (source && source.kind && source.kind !== 'user') continue
      const t = stripRuntime(textOfMessage(ev.data))
      if (!t) continue
      out.push({ role: '他', text: t, seq: Number(ev.seq) || 0, time: Number(ev.time) || 0 })
    } else if (ev.type === 'assistant/message') {
      const t = textOfMessage(ev.data?.message ?? ev.data)
      if (!t) continue
      out.push({ role: '她', text: t, seq: Number(ev.seq) || 0, time: Number(ev.time) || 0 })
    }
  }
  return out
}

/** 摘要用的纯文本：把轮次拼成「他：…」/「她：…」，顺手把超长的代码块压掉。 */
export function renderTurns(turns, { maxChars = 12000, stripCode = true } = {}) {
  const clean = (t) => {
    let s = String(t || '')
    if (stripCode) {
      s = s.replace(/```[\s\S]*?```/g, (m) => (m.length > 400 ? '\n```（代码已省略）\n```' : m))
      s = s.replace(/^(?: {2,}|\t).*$/gm, (m) => (m.trim() ? '' : m)) // 缩进代码块
    }
    return s.replace(/\n{3,}/g, '\n\n').trim()
  }
  const lines = turns.map((t) => `${t.role}：${clean(t.text)}`)
  let text = lines.join('\n\n')
  if (text.length > maxChars) {
    // 超长时保留头尾（开头定题，结尾定结论）
    const head = text.slice(0, Math.floor(maxChars * 0.6))
    const tail = text.slice(-Math.floor(maxChars * 0.35))
    text = `${head}\n\n…（中间省略）…\n\n${tail}`
  }
  return text
}

/** 按轮数/字数切块，给摘要器一块一块吃。 */
export function chunkTurns(turns, { maxTurns = 20, maxChars = 6000 } = {}) {
  const chunks = []
  let cur = []
  let size = 0
  for (const t of turns) {
    const len = t.text.length + 8
    if (cur.length && (cur.length >= maxTurns || size + len > maxChars)) {
      chunks.push(cur)
      cur = []
      size = 0
    }
    cur.push(t)
    size += len
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** 会话里最近一次请求用的路由（provider/model）—— 作为配置缺省时的兜底。 */
export function latestRoute(events) {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'request/header' || !ev.data || typeof ev.data !== 'object') continue
    const h = ev.data.header && typeof ev.data.header === 'object' ? ev.data.header : ev.data
    const provider = h.provider
    const model = h.model
    if (typeof provider === 'string' && provider && typeof model === 'string' && model) return { provider, model }
  }
  return null
}
