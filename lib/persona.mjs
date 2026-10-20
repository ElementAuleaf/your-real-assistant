/**
 * lib/persona.mjs —— 从 persona.md 里取出「核心块」
 * ============================================================================
 * persona.md 既是给人改的文档，也是插件读的数据源。约定：
 *   文件里 `## 核心块` 之后、下一个 `---` 或 `## ` 之前的内容，就是注入用的那一块。
 * 拿不到这个标记就整份当核心块用（宁可注入多了，也不要人格突然消失）。
 * ============================================================================
 */

/** @returns {string} 要注入系统提示词的人格正文 */
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

function stripHtmlComments(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '')
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
