/**
 * lib/evergreen-edit.mjs —— 让 core / preferences 可以被**细粒度**编辑
 * ============================================================================
 * 需求（2026-10-21）：
 *   「preference.md，persona.md 都要可以被修改，
 *     而且 preference.md 里面我正在进行的项目那一类里面的记录可以在我完成后删掉」
 *
 * 问题在哪：
 *   文件本来就能整份写（POST /evergreen 会覆盖）。但**整份覆盖是危险且不好用的**：
 *     · 模型要改一条，就得重写整个文件，很容易把别的条目弄丢；
 *     · 人在页面上点「删掉这个项目」，不该动其他条目；
 *     · 没有「删掉但留下痕迹」的概念 —— 历史全没了。
 *
 * 所以这里提供**按条目**的操作，全部是「定位那一行 → 只改那一行」：
 *   done   标记完成：状态改成「已完成 YYYY-MM-DD」，从「正在进行的项目」挪走
 *   remove 删除：物理删掉那一行（用户明确要求可以删）
 *   edit   修改：只改内容部分，保留编号与元信息
 *   restore 撤销删除：从回收记录里恢复（防止手滑）
 *
 * ⚠️ 每条记忆有稳定编号 `[P-xxxx]` / `[C-xxxx]`，所有操作都按编号定位，
 *    不按行号（行号会随别的条目增删而变，是经典事故源）。
 * ============================================================================
 */

/**
 * 解析一行记忆。
 *
 * ⚠️ 真实格式有两种（2026-10-21 对着磁盘确认过）：
 *   ① `- [P-MVF8D1JY7V7] [沟通风格] 内容……（元信息）`
 *      —— 编号后面**还带一个方括号小节名**（自动提升写出来的就是这种）
 *   ② `- [C-001] [2026-10-21] 内容……`
 *      —— 编号后面跟日期
 *   所以不能假设编号后直接是正文。
 *
 * @returns {{id:string, tag:string, body:string, raw:string}|null}
 */
function parseLine(line) {
  const m = /^\s*-\s*\[([A-Z]-\w+)\]\s*(?:\[([^\]]*)\]\s*)?(.*)$/.exec(line)
  if (!m) return null
  return {
    id: m[1],
    tag: (m[2] || '').trim(),   // 内联小节名或日期
    body: m[3].trim(),
    raw: line,
  }
}

/** 把 markdown 按 `## 小节` 切开，保留每个小节的起止行号。 */
export function splitSections(text) {
  const src = String(text || '')
  const lines = src.split('\n')
  const sections = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^##\s+/.test(l)) {
      if (cur) cur.end = i
      cur = { title: l.replace(/^##\s+/, '').trim(), start: i, end: lines.length, items: [] }
      sections.push(cur)
      continue
    }
    const it = parseLine(l)
    if (it && cur) cur.items.push({ ...it, line: i })
  }
  if (cur) cur.end = lines.length
  return { lines, sections }
}

/** 列出所有条目（带所属小节）。 */
export function listItems(text) {
  const { sections } = splitSections(text)
  const out = []
  for (const s of sections) {
    for (const it of s.items) {
      out.push({ id: it.id, section: s.title, tag: it.tag, body: it.body, line: it.line })
    }
  }
  return out
}

/** 找一条记忆（按编号）。 */
export function findItem(text, id) {
  return listItems(text).find((x) => x.id === String(id || '').trim()) || null
}

/**
 * 标记完成：把状态写进正文尾部，并（可选）挪到「已完成」小节。
 *
 * @returns {{ok:boolean, text?:string, error?:string, item?:object}}
 */
export function markDone(text, id, { date = todayStr(), moveTo = '' } = {}) {
  const found = findItem(text, id)
  if (!found) return { ok: false, error: `找不到编号 ${id}` }

  const src = String(text || '')
  const lines = src.split('\n')
  const line = lines[found.line]

  // 已经有「已完成」就别重复打标
  if (/已完成/.test(line)) return { ok: true, text: src, item: found, unchanged: true }

  // 去掉已有的「状态：进行中」这类尾巴，再追加完成标记
  let next = line.replace(/[｜|]\s*状态[:：]\s*[^）)]*/g, '')
  next = next.replace(/\s*）\s*$/, `｜状态：已完成 ${date}）`)
  // 如果原来没有「（…）」包裹，就在末尾补一个
  if (!/[）)]\s*$/.test(next)) next = `${next}（状态：已完成 ${date}）`

  lines[found.line] = next
  let out = lines.join('\n')

  // 挪到「已完成」小节（如果指定了且存在）
  if (moveTo) {
    out = moveItemToSection(out, found.id, moveTo)
  }
  return { ok: true, text: out, item: found, to: moveTo || found.section }
}

/** 删除一条（物理删掉那一行）。 */
export function removeItem(text, id) {
  const found = findItem(text, id)
  if (!found) return { ok: false, error: `找不到编号 ${id}` }
  const lines = String(text || '').split('\n')
  const removed = lines[found.line]
  lines.splice(found.line, 1)
  return { ok: true, text: lines.join('\n'), item: found, removed }
}

/**
 * 改一条的内容（保留编号与内联小节名/日期，只替换正文）。
 */
export function editItem(text, id, newBody) {
  const found = findItem(text, id)
  if (!found) return { ok: false, error: `找不到编号 ${id}` }
  const body = String(newBody || '').trim()
  if (!body) return { ok: false, error: '内容不能为空' }
  if (/[\n\r]/.test(body)) return { ok: false, error: '内容不能包含换行' }

  const lines = String(text || '').split('\n')
  // 保留「- [ID] 」以及可选的「[tag] 」
  const prefix = /^(\s*-\s*\[[A-Z]-\w+\]\s*(?:\[[^\]]*\]\s*)?)/.exec(lines[found.line])
  if (!prefix) return { ok: false, error: '这一行格式不对，改不动' }
  lines[found.line] = prefix[1] + body
  return { ok: true, text: lines.join('\n'), item: found, from: found.body, to: body }
}

/** 把某条挪到另一个小节末尾。 */
export function moveItemToSection(text, id, targetSection) {
  const found = findItem(text, id)
  if (!found) return text
  if (found.section === targetSection) return text

  const lines = String(text || '').split('\n')
  const raw = lines[found.line]
  lines.splice(found.line, 1)

  // 重新定位目标小节的最后一行
  const { sections, lines: fresh } = splitSections(lines.join('\n'))
  const target = sections.find((s) => s.title === targetSection)
  if (!target) {
    // 没有这个小节就新建在末尾
    const out = fresh.join('\n').trimEnd() + `\n\n## ${targetSection}\n\n${raw}\n`
    return out
  }
  const insertAt = target.start + 1 + target.items.length
  fresh.splice(insertAt, 0, raw)
  return fresh.join('\n')
}

/** 确保某个小节存在（不存在就追加）。 */
export function ensureSection(text, title) {
  const { sections } = splitSections(text)
  if (sections.some((s) => s.title === title)) return text
  return String(text || '').trimEnd() + `\n\n## ${title}\n\n`
}

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ───────────────────────── 回收站 ───────────────────────── */

/**
 * 删除是可撤销的：每次 remove 都往回收记录里塞一份。
 * 用户明确说「完成后可以删掉」，那就该能删 —— 但手滑也要能找回来。
 */
export function emptyTrash() {
  return { rows: [] }
}

export function pushTrash(trash, row) {
  const t = trash && Array.isArray(trash.rows) ? trash : emptyTrash()
  t.rows = [{
    at: Date.now(),
    stamp: stampOf(),
    file: String(row.file || ''),      // 'preferences' | 'core'
    id: String(row.id || ''),
    section: String(row.section || ''),
    raw: String(row.raw || ''),        // 原始那一行，原样恢复
  }, ...t.rows].slice(0, 100)
  return t
}

/** 从回收记录里取回一条。 */
export function findTrash(trash, id) {
  const rows = (trash && trash.rows) || []
  return rows.find((r) => r.id === String(id || '').trim()) || null
}

/** 把一条回收记录插回文件对应小节末尾。 */
export function restoreTrash(text, entry) {
  if (!entry) return { ok: false, error: '回收记录为空' }
  const raw = String(entry.raw || '')
  if (!raw.trim()) return { ok: false, error: '回收记录里没有内容' }
  // 已经存在就不重复插
  if (findItem(text, entry.id)) return { ok: true, text, unchanged: true }

  const { sections, lines } = splitSections(text)
  const target = sections.find((s) => s.title === entry.section)
  if (!target) {
    return { ok: true, text: String(text || '').trimEnd() + `\n\n## ${entry.section}\n\n${raw}\n` }
  }
  const insertAt = target.start + 1 + target.items.length
  lines.splice(insertAt, 0, raw)
  return { ok: true, text: lines.join('\n') }
}

function stampOf() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
