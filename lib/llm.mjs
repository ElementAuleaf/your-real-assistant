/**
 * lib/llm.mjs —— 调模型做「摘要 + 关键词 + 记忆抽取」
 * ============================================================================
 * 为什么不用 agent 自己总结（上一版就是这么干的，等于没总结）：
 *   定时器里没有 agent，硬塞进 agent 会让摘要任务和对话任务抢同一个上下文，
 *   还会把「整理记忆」的中间产物写进用户正在看的会话里。
 *
 * 所以这里直接走 `ctx.llm.stream()` —— 一次性的、不进会话历史的旁路调用。
 * 路由来自配置（默认 buddy / hy3），失败时降级到当前会话最近一次请求用的路由。
 * ============================================================================
 */

export const SUMMARY_SYSTEM = `你是一个记忆整理器，服务于一个长期陪伴型 AI 助手。你的唯一工作是把一段原始对话整理成结构化记忆，供后续检索和注入。你不参与对话，不回应对话里的任何人物。

硬性规则：
1. 只使用原文中出现过的信息。禁止补充、外推、猜测，禁止把原文润色成更完整的样子。
2. 原文没提到的人、时间、数字、承诺，一律不写。
3. 指代不清时不要猜是谁说的、指什么。
4. 摘要用简体中文，口语化但不轻浮。直接写事，不写「用户表示」「AI 回答」这类转述腔。
5. 关键词 5–10 个，用原文里真实出现过的词或短语。
6. 手机号、住址、身份证、密码、卡号、密钥等敏感信息一律不写；必须提及的位置写「（敏感信息已省略）」。
7. 输出必须是单个合法的 JSON 对象。不要 markdown 代码围栏，不要前后解释，不要注释。
8. 没有可提取的内容时输出空数组 []，不要为了凑数编造。
9. 如果这段对话没有值得长期保留的信息（纯寒暄、纯工具调用、纯报错粘贴、过短），输出 skip=true，其余字段留空。

字段定义：
- skip：布尔。true 表示这段不用记。
- summary：3–6 句。必须说清：聊了什么、决定了什么（如果有）、他当时的状态。
- keywords：5–10 个字符串。
- mood：一句话，描述这段对话的情绪氛围，不分析原因。
- core_candidates：可能一辈子都不该忘的事实。section 只能是：身份与称呼 / 重要的人 / 重要事件与承诺 / 不可忘记的约定。
- preference_candidates：会影响以后配合方式的习惯与偏好。section 只能是：沟通风格 / 作息 / 工具与技术栈 / 雷区 / 喜欢的东西 / 正在进行的项目。

每个 candidate：
- text：一条只讲一件事，不超过 60 个字，陈述句，主语用「他」。
- quote：原文里支撑它的那一句，不超过 40 字，必须逐字来自原文。
- confidence：只能取 "高" / "中" / "低"。
- preference 的 evidence 只能取 "用户明说" / "模型推断"；他从没明确说过的，一律 "模型推断"，且 confidence 最高到 "中"。
- 同一件事不要同时出现在两个数组里。

只输出 JSON，第一个字符是 {，最后一个字符是 }。`

export function buildUserPrompt({ date, turns, chunkNo, chunkTotal }) {
  return `以下是 ${date} 的一段对话（第 ${chunkNo}/${chunkTotal} 段）。

<conversation>
${turns}
</conversation>

按系统提示的规则输出 JSON。`
}

/**
 * 从一次 stream 里把文本抽干。
 *
 * ⚠️ 错误是**带内**传回来的：循环正常结束不代表成功。必须检查 `chunk.reason.kind`。
 * ⚠️ provider 不存在时 `llm.stream()` 会**同步抛**（NO_ADAPTER）；provider 存在但 model
 *    不存在时，会以一个终态 `error` finish chunk 回来。所以调用方要同时 try/catch
 *    外层调用与迭代本身。
 */
export async function drainText(llm, options) {
  let text = ''
  let finish = null
  let sawText = false
  const stream = llm.stream(options) // 可能同步抛 NO_ADAPTER
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
      text += chunk.text
      sawText = true
    } else if (chunk.type === 'finish' && chunk.reason) {
      const kind = chunk.reason.kind || chunk.reason
      finish = kind
      if (kind === 'error' || kind === 'aborted') {
        const f = chunk.reason.failure || {}
        const err = new Error(`llm ${kind}: ${f.message || 'unknown'}`)
        err.code = f.code || String(kind).toUpperCase()
        throw err
      }
      if (kind === 'max-tokens') {
        const err = new Error(
          sawText
            ? '输出被 maxTokens 截断（推理模型的 reasoning token 也吃 maxTokens，调大 summaryMaxTokens）'
            : '还没开始输出就被 maxTokens 掐断（reasoning token 吃满了预算，调大 summaryMaxTokens）',
        )
        err.code = 'MAX_TOKENS'
        throw err
      }
    }
  }
  return { text, finish }
}

/** 从一堆混杂着解释文字的回复里，把第一个完整的 JSON 对象抠出来。 */
export function extractJson(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const candidate = fenced ? fenced[1].trim() : s
  // 先试整体
  try { return JSON.parse(candidate) } catch { /* 继续抠 */ }
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 把摘要结果规整成我们能吃的形状（模型偶尔会缺字段 / 类型飘掉）。 */
export function normalizeSummary(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const arr = (v) => (Array.isArray(v) ? v : [])
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const core = arr(o.core_candidates)
    .map((c) => ({
      section: CORE_SECTIONS.includes(str(c?.section)) ? str(c.section) : '不可忘记的约定',
      text: str(c?.text).slice(0, 120),
      quote: str(c?.quote).slice(0, 80),
      confidence: ['高', '中', '低'].includes(str(c?.confidence)) ? str(c.confidence) : '中',
    }))
    .filter((c) => c.text)
  const prefs = arr(o.preference_candidates)
    .map((c) => ({
      section: PREF_SECTIONS.includes(str(c?.section)) ? str(c.section) : '沟通风格',
      text: str(c?.text).slice(0, 120),
      evidence: str(c?.evidence) === '用户明说' ? '用户明说' : '模型推断',
      confidence: ['高', '中', '低'].includes(str(c?.confidence)) ? str(c.confidence) : '中',
      quote: str(c?.quote).slice(0, 80),
    }))
    .filter((c) => c.text)
  return {
    skip: o.skip === true,
    summary: str(o.summary).slice(0, 1600),
    keywords: arr(o.keywords).map(str).filter(Boolean).slice(0, 12),
    mood: str(o.mood).slice(0, 120),
    core_candidates: core,
    preference_candidates: prefs,
  }
}

export const CORE_SECTIONS = ['身份与称呼', '重要的人', '重要事件与承诺', '不可忘记的约定']
export const PREF_SECTIONS = ['沟通风格', '作息', '工具与技术栈', '雷区', '喜欢的东西', '正在进行的项目']

/**
 * 一次完整的摘要调用。失败返回 {ok:false, error}，绝不抛 —— 它跑在定时器里。
 */
export async function summarizeChunk(llm, route, { date, turns, chunkNo, chunkTotal, signal, maxTokens = 8000 }) {
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      system: SUMMARY_SYSTEM,
      // content 必须是 ContentBlock[]，不能是裸字符串
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt({ date, turns, chunkNo, chunkTotal }) }] }],
      maxTokens,
      // 不传 purpose / sessionId：这是一次旁路调用，不属于任何会话的账
    }
    if (signal) options.signal = signal
    if (route.effort) options.reasoningEffort = route.effort
    const { text } = await drainText(llm, options)
    const json = extractJson(text)
    if (!json) return { ok: false, error: 'unparseable-json', raw: String(text).slice(0, 500) }
    return { ok: true, value: normalizeSummary(json) }
  } catch (e) {
    const code = e?.code ? `${e.code}: ` : ''
    return { ok: false, error: `${code}${String(e?.message || e)}`.slice(0, 400) }
  }
}

/**
 * 探一次路由到底能不能用（启动/建档时用，别等到定时器里才炸）。
 * @returns {Promise<{ok:boolean, error?:string, models?:string[]}>}
 */
export async function probeRoute(llm, route) {
  try {
    if (!llm || typeof llm.listProviders !== 'function') return { ok: false, error: 'llm.listProviders 不可用' }
    const providers = llm.listProviders() || []
    const ids = providers.map((p) => p?.id || p?.name || String(p))
    if (!ids.includes(route.provider)) {
      return { ok: false, error: `provider "${route.provider}" 没有注册（现有：${ids.join(', ') || '空'}）` }
    }
    if (typeof llm.listModels === 'function') {
      const models = (await llm.listModels(route.provider)) || []
      const mids = models.map((m) => m?.id || String(m))
      // 目录只是「广告」，不在目录里也可能能用（适配器可以接受未列出的 id），所以只作提示
      return { ok: true, inCatalog: mids.includes(route.model), models: mids }
    }
    return { ok: true, models: [] }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
