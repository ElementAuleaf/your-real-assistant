/**
 * lib/persona.mjs —— 人格的两层结构
 * ============================================================================
 * 需求（2026-10-21）：「将人格分为核心人格与外层人格」
 *
 *   核心人格  —— 从 persona.md 的 `## 核心块` 读出来，**永远不变**。
 *               身份、称呼、铁律、怎么说话的总基调。所有会话完全一致。
 *   外层人格  —— 由心情决定（lib/mood.mjs），**每个会话各自生成**，
 *               只决定措辞、句长、语气词，绝不影响正确性和信息量。
 *
 * 为什么要分两层：
 *   只有一层的话，「今天心情不好」就会变成不好好回答的借口。
 *   分开之后，外层再波动，核心的人格底座不动 —— 她还是那个会给你把事办完的人。
 * ============================================================================
 */

/** @returns {string} 要注入系统提示词的核心人格正文 */
export function personaCore(markdown) {
  const src = String(markdown || '')
  if (!src.trim()) return ''
  const m = /^##\s*核心块.*$/m.exec(src)
  if (!m) return stripHtmlComments(src).trim()
  const start = m.index + m[0].length
  const rest = src.slice(start)
  // 结束于下一个二级标题或分隔线
  const endM = /^(?:---+\s*$|##\s)/m.exec(rest)
  const block = endM ? rest.slice(0, endM.index) : rest
  return stripHtmlComments(block).trim()
}

/** 取可调参数表里的一个值（给状态页显示用）。 */
export function personaParam(markdown, name) {
  const re = new RegExp(`\\|\\s*\`?${escapeRe(name)}\`?\\s*\\|\\s*([^|]+?)\\s*\\|`)
  const m = re.exec(String(markdown || ''))
  return m ? m[1].trim() : ''
}

/**
 * @deprecated 已于 2026-10-21 删除。
 *
 * 这里原本有一个 `composePersona({ coreBlock, moodText })`，只拼「核心 + 心情」两层。
 * 2.3.0 加习惯层、2.4.0 把优先级说明改成动态层数之后，
 * 这个职责被 `lib/persona-params.mjs` 的 `composeWithParams` 完全接管：
 *
 *   composePersona      → 核心 + 心情（两层，写死）
 *   composeWithParams   → 核心 + 参数 + 习惯 + 心情（层数动态）  ← 真正在用的
 *
 * 它当时唯一的调用方是 `custom-tests/persona-layers-smoke.mjs`，
 * 而那个测试测的是过时的两层结构 —— 也就是说「测试全绿」并不代表真实链路对。
 * 现在那个测试改成直接验 `composeWithParams`，这个函数一起删掉。
 *
 * 保留这段说明而不是静默删除，是因为「为什么删」比「删了什么」更容易忘。
 */

function stripHtmlComments(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '')
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
