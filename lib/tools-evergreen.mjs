/**
 * lib/tools-evergreen.mjs —— 给模型的「改记忆文件」工具
 * ============================================================================
 * 需求（2026-10-21）：
 *   「preference.md，persona.md 都要可以被修改，
 *     而且 preference.md 里面我正在进行的项目那一类里面的记录可以在我完成后删掉」
 *
 * 三个工具：
 *   list_memory  列出某一层（core / preferences）的所有条目 + 编号
 *   edit_memory  按编号改 / 标记完成 / 删除 / 恢复
 *
 * 为什么要「按编号」：文件会随别的条目增删而行号漂移。
 * 按行号改是经典事故源 —— 删错一条，或者改到别人头上。
 * ============================================================================
 */
import {
  listItems, findItem, markDone, removeItem, editItem,
  pushTrash, findTrash, restoreTrash, ensureSection,
} from './evergreen-edit.mjs'

const safe = (v) => {
  if (v === undefined || v === null) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const out = () => ({
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, result) => [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
})

/** 项目完成后默认挪到这个小节。 */
export const DONE_SECTION = '已完成的项目'

/**
 * @param {object} p
 * @param {()=>string} p.readCore
 * @param {()=>string} p.readPrefs
 * @param {(kind:'core'|'preferences', text:string)=>void} p.writeEvergreen
 * @param {()=>object} p.getTrash
 * @param {(t:object)=>void} p.setTrash
 * @param {(m:string)=>void} p.log
 */
export function makeEvergreenTools({ readCore, readPrefs, writeEvergreen, getTrash, setTrash, log }) {
  const read = (layer) => (layer === 'core' ? readCore() : readPrefs())

  const listTool = {
    name: 'list_memory',
    description: [
      '列出「永不删除」的两层记忆里的所有条目，带编号。',
      '',
      '什么时候用：',
      '- 要改某条记忆之前，先看看它的编号和现在写的是什么',
      '- 他说「那个项目做完了」——先列出来确认是哪一条',
      '',
      'layer: core（核心记忆）或 preferences（习惯与喜好）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['core', 'preferences'], description: '哪一层，默认 preferences' },
        section: { type: 'string', description: '只看某一个小节（可选），比如「正在进行的项目」' },
      },
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const layer = a.layer === 'core' ? 'core' : 'preferences'
      const text = read(layer)
      let items = listItems(text)
      const sec = String(a.section || '').trim()
      if (sec) items = items.filter((x) => x.section.includes(sec))
      return safe({
        ok: true,
        layer,
        count: items.length,
        items: items.map((x) => ({
          id: x.id,
          section: x.section,
          body: x.body.slice(0, 160),
        })),
        hint: '改/删/标记完成都用这些 id，不要用行号。',
      })
    },
  }

  const editTool = {
    name: 'edit_memory',
    description: [
      '修改「永不删除」那一层记忆里的某一条（按编号）。',
      '',
      'action:',
      '- `done`   标记完成：状态写成「已完成」，并从「正在进行的项目」挪到「已完成的项目」',
      '- `remove` 删除这一条（进回收站，可以 undo）',
      '- `edit`   改内容（保留编号和小节名）',
      '- `restore` 从回收站恢复某条（用它的编号）',
      '',
      '什么时候用：',
      '- 他说「这个项目做完了」「那个不用记了」→ done 或 remove',
      '- 记错了、写歪了 → edit',
      '',
      '⚠️ 一次只改一条。改完跟他说一声改了什么，一句话就行。',
      '⚠️ 不确定是哪一条就先 `list_memory` 看一眼，别猜编号。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['done', 'remove', 'edit', 'restore'], description: '做什么' },
        layer: { type: 'string', enum: ['core', 'preferences'], description: '哪一层，默认 preferences' },
        id: { type: 'string', description: '条目编号，例如 P-MVF8IP8TZZ0' },
        content: { type: 'string', description: 'action=edit 时的新内容（不填则不改内容）' },
        moveTo: { type: 'string', description: 'action=done 时挪到哪个小节，默认「已完成的项目」' },
      },
      required: ['action', 'id'],
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const layer = a.layer === 'core' ? 'core' : 'preferences'
      const id = String(a.id || '').trim()
      const action = String(a.action || '').trim()
      if (!id) return safe({ ok: false, error: 'id 不能为空' })

      const text = read(layer)
      if (!findItem(text, id)) {
        return safe({
          ok: false,
          error: `在 ${layer} 里找不到编号 ${id}。先用 list_memory 列一下，别猜。`,
        })
      }

      // ── 恢复 ──
      if (action === 'restore') {
        const entry = findTrash(getTrash(), id)
        if (!entry) return safe({ ok: false, error: `回收站里没有 ${id}` })
        const r = restoreTrash(text, entry)
        if (!r.ok) return safe({ ok: false, error: r.error })
        writeEvergreen(layer, r.text)
        log(`恢复 ${id} 到 ${layer}/${entry.section}`)
        return safe({ ok: true, action: 'restore', id, section: entry.section, note: `已恢复到「${entry.section}」。` })
      }

      // ── 标记完成 ──
      if (action === 'done') {
        const moveTo = String(a.moveTo || DONE_SECTION).trim()
        // 先把「已完成的项目」小节补上
        let base = ensureSection(text, moveTo)
        const r = markDone(base, id, { moveTo })
        if (!r.ok) return safe({ ok: false, error: r.error })
        writeEvergreen(layer, r.text)
        log(`标记完成 ${id} → ${moveTo}`)
        return safe({
          ok: true, action: 'done', id, to: moveTo,
          note: `已标记完成，并挪到「${moveTo}」。他要是想彻底删掉，再用 remove。`,
        })
      }

      // ── 删除 ──
      if (action === 'remove') {
        const r = removeItem(text, id)
        if (!r.ok) return safe({ ok: false, error: r.error })
        writeEvergreen(layer, r.text)
        // 进回收站，能恢复
        setTrash(pushTrash(getTrash(), {
          file: layer, id, section: r.item.section, raw: r.removed,
        }))
        log(`删除 ${id}（${layer}/${r.item.section}），已进回收站`)
        return safe({
          ok: true, action: 'remove', id, section: r.item.section,
          note: '已删除，同时放进了回收站 —— 说错了还能用 restore 找回。',
        })
      }

      // ── 改内容 ──
      if (action === 'edit') {
        const content = String(a.content || '').trim()
        if (!content) return safe({ ok: false, error: 'action=edit 需要 content' })
        const r = editItem(text, id, content)
        if (!r.ok) return safe({ ok: false, error: r.error })
        writeEvergreen(layer, r.text)
        log(`改 ${id}: ${String(r.from).slice(0, 30)} → ${String(r.to).slice(0, 30)}`)
        return safe({ ok: true, action: 'edit', id, from: r.from, to: r.to, note: '已改，下一个请求生效。' })
      }

      return safe({ ok: false, error: `不认识的 action：${action}（可用 done / remove / edit / restore）` })
    },
  }

  return [listTool, editTool]
}
