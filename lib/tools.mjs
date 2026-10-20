/**
 * lib/tools.mjs —— 暴露给模型的三个工具
 * ============================================================================
 * save_memory   把重要的东西写进永不删除的 core / preferences（或被标记为重要的日常记忆）
 * recall_memory 按关键词回忆：跨所有日期文件夹找，命中就顺便续期
 * review_memory 回顾续期：显式重置遗忘时钟
 *
 * ⚠️ 工具的返回值必须是「无损 JSON」—— 塞函数、循环引用、类实例都会报
 *    `value is not lossless JSON`。这里统一走 safe()。
 * ============================================================================
 */
import { stamp, nextId } from './home.mjs'

/**
 * ⚠️ 工具契约（对着线上 tools 服务核实）：
 * ・`ToolDefinition` **必须**带 `output: { schema, render }`，否则 register() 直接抛
 *   `tool "X" must declare output { schema, render, presentationMeta? }`。
 * ・`execute()` 返回的是**原始的无损 JSON 值**（会被按 output.schema 校验 → 冻结 →
 *   再交给 output.render 渲染成模型看的 content）。**不要**自己返回
 *   `{content:[{type:'text'}]}` —— 那是 render 的产物。
 * ・返回里不能有函数 / 类实例 / 循环引用 / undefined，否则报 "value is not lossless JSON"。
 */
const safe = (v) => {
  if (v === undefined || v === null) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const out = () => ({
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, result) => [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
})

export function makeTools({ store, stats, onSaved, log }) {
  const saveTool = {
    name: 'save_memory',
    description: [
      '把值得长期记住的东西写进「永不删除」的两层记忆。',
      '',
      '什么时候必须用：他说了长期有效的偏好、雷区、承诺、重要的人、关键决定，或者他说「记下来」「这个很重要」。',
      '不写进去 = 默许它在约 31 天后随着日常记忆一起淡掉。',
      '',
      'target 选哪个：',
      '- core：十年后仍然成立的事实（身份、称呼、重要的人、承诺、约定、时间线节点）',
      '- preferences：影响以后怎么配合他的习惯（沟通风格、作息、技术栈、雷区、在做的项目）',
      '- daily：这次对话本身值得标一个「别忘」，会写进今天的文件夹并立刻续期',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['core', 'preferences', 'daily'], description: '写到哪一层，默认 core。' },
        section: { type: 'string', description: '小节名。core 可选：身份与称呼 / 重要的人 / 重要事件与承诺 / 不可忘记的约定；preferences 可选：沟通风格 / 作息 / 工具与技术栈 / 雷区 / 喜欢的东西 / 正在进行的项目。' },
        content: { type: 'string', description: '一条只讲一件事，60 字以内，陈述句。' },
        quote: { type: 'string', description: '可选：他的原话，用于以后追溯。' },
        confidence: { type: 'string', enum: ['高', '中', '低'], description: '置信度，默认高（他说过的）。' },
      },
      required: ['content'],
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const target = ['core', 'preferences', 'daily'].includes(String(a.target)) ? String(a.target) : 'core'
      const content = String(a.content || '').trim()
      if (!content) return safe({ ok: false, error: 'content 不能为空' })
      const section = String(a.section || '').trim() || (target === 'core' ? '不可忘记的约定' : '沟通风格')
      const conf = ['高', '中', '低'].includes(String(a.confidence)) ? String(a.confidence) : '高'
      const quote = String(a.quote || '').trim()
      const now = new Date()
      const id = nextId(target === 'core' ? 'C' : target === 'preferences' ? 'P' : 'D')
      const line = `[${id}] [${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}] ${content}` +
        `（来源：模型记录 ｜ 置信度：${conf}${quote ? ` ｜ 原话：「${quote.slice(0, 80)}」` : ''}）`

      if (target === 'daily') {
        const r = store.appendDaily({
          summary: content,
          keywords: [section],
          mood: '',
          title: section,
          when: now,
        })
        stats.captures += 1
        log(`tool save_memory daily ${r.id}`)
        return safe({ ok: true, target, id: r.id, day: r.day, note: '已写进今天的日常记忆并立即续期。' })
      }

      const file = store.appendToEvergreen(target, section, line)
      if (target === 'core') stats.promotedCore += 1
      else stats.promotedPrefs += 1
      log(`tool save_memory ${target}/${section} ${id}`)
      try { onSaved?.(target, section, content) } catch { /* ignore */ }
      return safe({
        ok: true,
        target,
        id,
        file,
        section,
        note: '已写入永不删除的一层记忆，下一次会话就会带着它开始。',
      })
    },
  }

  const recallTool = {
    name: 'recall_memory',
    description: [
      '按关键词回忆以前聊过的事。跨所有日期文件夹搜索，命中后会自动给这些记忆续期（相当于「想起来一次」）。',
      '什么时候用：他提到「上次」「之前那个」「你还记得吗」，或者你需要确认一个细节而不是凭印象猜。',
      '也可以直接用记忆里已经加载的摘要；这个工具是用来翻更早、更细的东西的。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔。支持中英文。' },
        limit: { type: 'number', description: '返回几条，默认 6，最多 20。' },
        review: { type: 'boolean', description: '命中后是否续期，默认 true。' },
      },
      required: ['query'],
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const query = String(a.query || '').trim()
      if (!query) return safe({ ok: false, error: 'query 不能为空' })
      const limit = Math.max(1, Math.min(Number(a.limit) || 6, 20))
      const hits = store.searchDaily(query, limit)
      const doReview = a.review !== false
      const ids = hits.map((h) => `${h.id}@${h.day}`).filter((x) => !x.startsWith('@'))
      const reviewed = doReview ? store.review(ids) : []
      log(`tool recall_memory "${query}" → ${hits.length} hit(s)`)
      return safe({
        ok: true,
        query,
        hitCount: hits.length,
        reviewed: reviewed.length,
        hits: hits.map((h) => ({
          day: h.day,
          id: h.id,
          title: h.title,
          keywords: h.keywords,
          retention: Number((h.retention ?? 0).toFixed(2)),
          text: String(h.body || '').slice(0, 600),
        })),
        note: hits.length ? (reviewed.length ? `命中 ${reviewed.length} 条并已续期。` : '命中，但未续期。') : '没找到；如实告诉他「这个我没记下来」，不要编。',
      })
    },
  }

  const reviewTool = {
    name: 'review_memory',
    description: [
      '回顾续期：让最近的日常记忆重新变清晰，并按经典间隔把记忆强度往上提。',
      '什么时候用：他主动提起往事、你们一起复盘、或者你意识到某段记忆快要淡掉了。',
      '可选 keep=true 表示「这条很重要，别压缩」—— 会把命中的记忆钉住，永远是原文。',
      '注意：日常记忆淡去时**文件夹不会消失**，只是里面的内容被压缩成一行；',
      '要永久保留必须用 save_memory 提升到 core / preferences。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'array', items: { type: 'string' }, description: '要回顾的日期（YYYY-MM-DD）。留空=最近 3 天。' },
        all: { type: 'boolean', description: 'true = 回顾所有日常记忆。' },
        keep: { type: 'boolean', description: 'true = 同时把这些记忆钉住（永不压缩）。' },
      },
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      let ids = []
      if (a.all) {
        const r = store.review([], { allDays: true })
        const pinned = a.keep ? store.pin({ ids: r.map((x) => x) }) : []
        log(`tool review_memory all → ${r.length}${a.keep ? ` (pinned ${pinned.length})` : ''}`)
        return safe({
          ok: true, mode: 'all', reviewed: r.length, pinned: pinned.length,
          note: `所有日常记忆已续期${a.keep ? '，并全部钉住' : ''}。`,
        })
      }
      const days = Array.isArray(a.days) && a.days.length
        ? a.days.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        : store.listDays().slice(0, 3)
      for (const day of days) {
        const meta = store.readDayMeta(day)
        ids.push(...Object.keys(meta.entries).map((id) => `${id}@${day}`))
      }
      const reviewed = store.review(ids)
      const pinned = a.keep ? store.pin({ ids: reviewed }) : []
      log(`tool review_memory ${days.join(',')} → ${reviewed.length}${a.keep ? ` (pinned ${pinned.length})` : ''}`)
      return safe({
        ok: true,
        days,
        reviewed: reviewed.length,
        pinned: pinned.length,
        note: reviewed.length
          ? `已回顾 ${reviewed.length} 条，遗忘时钟重置${a.keep ? `，其中 ${pinned.length} 条已钉住` : ''}。`
          : '这些日期里没有记忆可回顾。',
      })
    },
  }

  return [saveTool, recallTool, reviewTool]
}
