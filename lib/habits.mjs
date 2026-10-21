/**
 * lib/habits.mjs —— 说话习惯：从长期记忆里炼出「她该怎么说话」
 * ============================================================================
 * 需求（2026-10-21 晚，用户原话）：
 *   「增加长期记忆模块，并测试在对话过程中她的说话方式是否会
 *     根据记忆与我的偏好逐渐更改」
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么要这一层 —— 先说清缺的是什么
 * ════════════════════════════════════════════════════════════════════════
 * 记忆系统原本已经有三层（core / preferences / 每日），也一直在写。
 * 但 2026-10-21 晚对着磁盘一查，preferences.md 已经 **29KB / 123 条**，
 * 而注入时的做法是：
 *
 *     clipMarkdown(readPrefs(), 6000 * 0.26)   // 只留前 1560 字
 *
 * 也就是说 —— **123 条里只有开头一小截进得了提示词，其余全部看不见。**
 * 记忆存下来了，「她」却用不上。这是他抱怨「记了但没起作用」的真正原因。
 *
 * 更麻烦的是语义：那 123 条里混着两类完全不同的东西 ——
 *   · 「B站日报写成薄版」—— 具体任务的做法，只在做那件事时有用
 *   · 「先说结论」「别老问我在不在」—— 这是**说话方式**，每一句都该遵守
 * 混在一张平铺列表里，模型分不出哪些是"永远的态度"、哪些是"这次的活"。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 这一层做什么
 * ════════════════════════════════════════════════════════════════════════
 * 把「散落的偏好条目」压成「少量、可执行、按证据强弱排序的说话习惯」：
 *
 *   123 条偏好
 *     → 逐条判断：这条管的是「说话方式」还是「具体任务」？
 *     → 说话方式那部分按维度归并（同类合一条）
 *     → 每条计分：有多少条记忆支持 × 置信度 × 新近度
 *     → 同一维度上的相反说法，分高的赢（他改主意了，就听新的）
 *     → 取前 N 条，生成一段注入文本
 *
 * **它是纯函数**：给定记忆和时间，永远得到同一批习惯 —— 所以能测，
 * 也能对比「昨天 vs 今天」看出说话方式到底变没变。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 「逐渐更改」是怎么发生的（这是需求的核心）
 * ════════════════════════════════════════════════════════════════════════
 * 不是靠某个定时任务重写文件，而是三道叠加：
 *
 *   ① **每轮重算** —— 每轮注入都重新读偏好、重新算习惯。新记一条，下一轮就变。
 *   ② **新近度加权** —— 45 天半衰期。老偏好不会突然消失，但会被新说法压过去。
 *   ③ **冲突分组** —— 同一维度互相排斥。他先说「详细点」，后说「一两行就够」，
 *      后者分高就覆盖前者，前者不会永远赖在那儿。
 *
 * 再加一份 `habits.json` 快照：每次算完存一份摘要，
 * 于是「上个月她说话是这样，这个月变成那样」有据可查 —— 这就是「逐渐」的证据。
 * ============================================================================
 */
import { readJson, writeJson, dayKey } from './home.mjs'

/* ───────────────────────── 维度表 ───────────────────────── */

/**
 * 一个维度 = 一类说话方式 + 识别它的说法 + 它给出的指令。
 *
 * `group` 是**互斥组**：同一组里只能有一条生效。
 * 比如「精简」和「详细」都是 length 组 —— 他不可能同时要两者，
 * 后来的那条应该压过前面的。
 *
 * `re` 只匹配「说话方式」的**特征说法**。宁可漏判，也不要误判 ——
 * 把「B站日报写成薄版」当成「全局要精简」是很糟的错误：
 * 她会在所有场合都往短里说，而那条其实只管日报。
 */
export const DIMENSIONS = [
  {
    id: 'brevity', label: '精简', group: 'length',
    re: /短句|简短|说短|短一点|短些|一两行|一句话|别写长|别铺开|别啰嗦|不要长篇|精简|简洁|薄版|别废话|少废话|别写长摘要/,
    instruction: '句子短，能一两行说完就别铺开；不写大段铺垫和总结。',
  },
  {
    id: 'detail', label: '详细', group: 'length',
    re: /详细(?:点|一点|说)|多写(?:点|一点)|讲清楚|说全|展开说|别省略|完整(?:点|地)/,
    instruction: '该展开的展开，把前因后果和边界情况都写出来，别只给结论。',
  },
  {
    id: 'conclusion_first', label: '先结论', group: 'structure',
    // 「结论放在前面」「先讲结果再解释」都算 —— 中缀别写死
    re: /先(?:给|说|写)?结论|结论(?:放|摆|写)?在?前|先说结果|先讲结果|先答后解释|先给答案/,
    instruction: '**先给结论/结果，再展开理由**。别从背景铺垫起。',
  },
  {
    id: 'no_question', label: '少反问', group: 'interaction',
    re: /别(?:老|再)?(?:反问|追问|一直问|问)|不要(?:反问|追问)|少问|别问我在不在|别确认|不用确认|别查户口|防查户口|别纠结(?:已)?问过/,
    instruction: '少用反问句和确认句。能自己判断的就判断，别反复问「要不要」「是不是」。',
  },
  {
    id: 'ask_more', label: '多问', group: 'interaction',
    re: /多问(?:我|一句)|不确定就问|该问就问|拿不准就问/,
    instruction: '不确定的时候主动问一句，别自己猜着往下做。',
  },
  {
    id: 'no_repeat', label: '别重复', group: 'interaction2',
    re: /别(?:再)?(?:重复|纠结|翻旧账|反复提)|已回答过|说过的(?:别|不要)再|不要再提/,
    instruction: '说过的事别再重复问、别再纠结。他回答过的就当已经解决。',
  },
  {
    id: 'plain_speech', label: '说人话', group: 'tone',
    re: /说人话|口语|别像\s*AI|别像机器人|别官方|别客套|放松(?:点|口语|分析)|别念稿|自然(?:点|一点)|别端着|太严肃|不严肃|别太正经|像女朋友|正常说话|别像在写报告|别做技术分析/,
    instruction: '用口语，别端着。不要「首先/其次/综上所述」那套，也不要客服腔、别像在写报告。',
  },
  {
    id: 'formal', label: '正式', group: 'tone',
    re: /正式(?:点|一点)|书面|严肃(?:点|一点)|别太随意/,
    instruction: '用正式、书面的说法，别用口语和网络词。',
  },
  {
    id: 'personalized', label: '像个人', group: 'tone3',
    re: /人格化|别工单|别罗列|别一条条列|像人(?:一样)?(?:说|聊)|别机械|有温度|别模板/,
    instruction: '像个人那样说，不要工单式罗列、不要模板腔。该有语气就有语气。',
  },
  {
    id: 'no_emoji', label: '别用表情', group: 'emoji',
    re: /别(?:用|发)\s*(?:表情|emoji)|不要\s*emoji|少用表情|别发图|别用颜文字|不用表情/,
    instruction: '不要 emoji、颜文字、表情包。',
  },
  {
    id: 'emoji_ok', label: '可以用表情', group: 'emoji',
    re: /可以用表情|多用表情|发个表情|加点表情|表情包(?:可以|行)/,
    instruction: '可以自然地用 emoji 和表情包，但一条里别堆。',
  },
  {
    id: 'direct', label: '直说', group: 'tone2',
    re: /直接(?:说|点|一点)|别绕|不绕弯|别铺垫|直说|有话直说|别委婉/,
    instruction: '有话直说，别绕弯子、别铺垫、别先夸一段再讲问题。',
  },
  {
    id: 'no_flattery', label: '别捧', group: 'tone2',
    re: /别(?:夸|捧|拍马屁)|不用夸|别奉承|别恭维/,
    instruction: '别夸我、别捧场。直接说事。',
  },
  {
    id: 'call_by_name', label: '叫名字', group: 'address',
    re: /叫(?:我|他)?「|称呼我|称呼他|喊我|叫我|他叫「|我称呼他为|我称呼他为/,
    instruction: '该叫名字的时候叫名字，别一直「你」来「你」去。',
  },
  {
    id: 'report_shape', label: '汇报形状', group: 'format',
    re: /报告的?写成|日报|汇报(?:要|写成)|写成(?:薄版|清单)|表格|列表(?:形式|呈现)|每条一两行/,
    instruction: '需要汇报时用清单/表格这类结构化形式，别写成散文。',
  },
  {
    id: 'no_hedging', label: '别含糊', group: 'certainty',
    re: /别含糊|别(?:说)?可能|给确定(?:的)?答案|别模棱两可|不要也许/,
    instruction: '能确定就直说确定；真不确定就明说哪一部分不确定，别用「可能/也许」糊过去。',
  },
]

/**
 * 判断一条记忆到底是不是「说话方式」。
 *
 * ⚠️ 这一步比正则本身更要紧。2026-10-21 实测：只靠 DIMENSIONS 的正则，
 *    「他要求AI在日常对话中主动问他的喜好并调整AI人格」被误判成 `ask_more` ——
 *    那是一条**功能需求**（要给插件加个能力），不是「她该多问」的口味。
 *    误判的代价很实在：她会在所有场合都去反问，而那条其实跟说话无关。
 *
 * 所以加两道门：
 *   ① 必须含有「说话」的痕迹（回答/语气/措辞/称呼… 或者对说话方式的祈使）
 *   ② 如果它明显在讲**实现某功能**（工具/模块/接口/写入…），且没有强说话痕迹 → 判成任务
 */
/**
 * 说话方式的**痕迹词**。
 *
 * ⚠️ 「祈使句」本身就是痕迹 —— 「别老问我在不在」「少说两句」「直接说」
 *    没有一个「语气」类的名词，但它百分之百是在讲怎么说话。
 *    一开始漏了这一类，导致「别老问我在不在」被拦掉（2026-10-21 抓到）。
 */
const SPEECH_CUE = /回答|回复|语气|说法|措辞|口吻|说话|表达|称呼|说人话|口语|正式|严肃|简短|详细|一句话|一两行|精简|简洁|薄版|日报|汇报|emoji|表情|人格化|工单|罗列|模板|像女朋友|像\s*AI|别(?:说|问|夸|绕|铺垫|反问|重复|纠结|端着|像|用表情|发表情|老问|一直问)|不要(?:说|问|绕|长篇)|少(?:说|问)|多(?:说|讲|问)|直接说|先给结论|结论(?:放|摆|写)?在?前|先说结果|先讲结果|展开说|别含糊|确定(?:的)?答案/

/**
 * 「方向性」的判据：有些句子即使没出现「回答/语气」这类词，
 * 只要它在描述**信息该怎么组织**（先结论、简短、详细、别铺垫…），
 * 它就是在讲说话方式。只靠名词痕迹会漏掉一大类。
 */
const SPEECH_SHAPE = /先(?:给|说|讲)?(?:结论|结果|答案)|结论(?:放|摆|写)?在?前|一两行|一句话说|别写长|别铺垫|别绕|精简|简洁|详细(?:点|一点)|展开(?:说|讲)|别省略|别重复|别含糊|说人话|口语|像女朋友|人格化/

/**
 * 判断一条记忆到底是不是「说话方式」。
 *
 * ⚠️ 这一步比正则本身更要紧。2026-10-21 实测：只靠 DIMENSIONS 的正则，
 *    「他要求AI在日常对话中主动问他的喜好并调整AI人格」被误判成 `ask_more` ——
 *    那是一条**功能需求**（要给插件加个能力），不是「她该多问」的口味。
 *
 * 所以加三道门：
 *   ① 必须含有「说话」的痕迹（回答/语气/措辞… 或者对说话方式的祈使）
 *   ② 或者含有「信息形状」的描述（先结论 / 一两行 / 详细点…）
 *   ③ 如果它明显在讲**实现某功能**（工具/模块/接口/写入…），且没有强说话痕迹 → 判成任务
 */
const TASK_CUE = /实现|工具|模块|插件|功能|接口|写入|落盘|存储|调用|路径|配置项|注册|字段|测试|重构|部署|数据库|索引|参数表/

export function looksLikeSpeech(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  const cued = SPEECH_CUE.test(t) || SPEECH_SHAPE.test(t)
  if (!cued) return false
  // 讲功能的，除非同时有很硬的说话痕迹（「写成薄版」「像女朋友说话」这种），否则不算
  if (TASK_CUE.test(t) && !/说人话|像女朋友|像\s*AI|口语|语气|措辞|口吻|写成薄版|每条一两行|人格化|工单/.test(t)) {
    return false
  }
  return true
}

const BY_ID = new Map(DIMENSIONS.map((d) => [d.id, d]))

export function dimensionById(id) {
  return BY_ID.get(String(id || '')) || null
}

/** 置信度权重。他说过的话比模型推断的重。 */
const CONFIDENCE_WEIGHT = { 高: 1, 中: 0.7, 低: 0.4 }

/** 新近度半衰期（天）。45 天 —— 一个半月前提的偏好还算是「他的口味」，但会被新说法压过。 */
export const FRESHNESS_HALF_LIFE_DAYS = 45

/* ───────────────────────── 解析偏好条目 ───────────────────────── */

/**
 * 解析 preferences.md / memories.md 里的一行条目。
 *
 * 真实格式（2026-10-21 对着磁盘确认过，有两种）：
 *   `- [P-MVF8D1JY7V7] [沟通风格] 内容……（用户明说 ｜ 置信度：高 ｜ 2026-10-19 ｜ 原话：「…」）`
 *   `- [C-MVG5DWCBGUW] [2026-10-20] 内容……（来源：模型记录 ｜ 置信度：高 ｜ 原话：「…」）`
 *
 * ⚠️ 编号后面可能跟**小节名**，也可能跟**日期** —— 不能假设。
 */
export function parseEntryLine(line) {
  const m = /^\s*-\s*\[([A-Z]-\w+)\]\s*(?:\[([^\]]*)\]\s*)?(.+)$/.exec(String(line || ''))
  if (!m) return null
  const id = m[1]
  const tag = (m[2] || '').trim()
  let body = m[3].trim()

  // 置信度
  const conf = /置信度[:：]\s*([高中低])/.exec(body)
  const confidence = conf ? conf[1] : '中'

  /**
   * 日期：**先看 tag，再看正文**。
   *
   * ⚠️ 2026-10-21 抓到的真 bug：格式 `- [P-xxx] [2026-10-21] 正文…` 里，
   *    日期在**方括号 tag** 里，不在正文中。原来只从 body 找，
   *    于是这类条目 `date` 全是空串，排序时被当成「很久以前」。
   *
   *    「改任何文件之前必须先读一遍再编辑」那条正好是这种格式，
   *    结果它永远排不进前 24 名 —— 明明是他最新提的要求。
   */
  let date = ''
  const tagDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tag)
  if (tagDate) {
    date = `${tagDate[1]}-${tagDate[2]}-${tagDate[3]}`
  } else {
    const dateM = /(\d{4})-(\d{2})-(\d{2})/.exec(body)
    date = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : ''
  }

  // 证据来源
  const evidence = /用户明说/.test(body) ? '用户明说' : '模型推断'

  // 原话（可能带中文引号）
  const quoteM = /原话[:：]\s*[「"]([^」"]*)[」"]/.exec(body)
  const quote = quoteM ? quoteM[1].trim() : ''

  // 正文 = 最后一个「（」之前的部分
  const paren = body.lastIndexOf('（')
  const text = (paren > 0 ? body.slice(0, paren) : body).trim()

  return { id, tag, text, confidence, date, evidence, quote, raw: String(line).trim() }
}

/** 从一整份 markdown 里取出所有条目（带小节名）。 */
export function parseEntries(markdown) {
  const out = []
  let section = ''
  for (const line of String(markdown || '').split('\n')) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) { section = h[1].trim(); continue }
    const it = parseEntryLine(line)
    if (it) out.push({ ...it, section })
  }
  return out
}

/* ───────────────────────── 分类 & 计分 ───────────────────────── */

/** 一条偏好落在哪些维度上（可能 0 个，也可能 2 个）。 */
export function dimensionsOf(text) {
  const t = String(text || '')
  if (!t.trim()) return []
  // 先过「这到底是不是说话方式」那道门 —— 否则功能需求会污染口味判断
  if (!looksLikeSpeech(t)) return []
  const hits = []
  for (const d of DIMENSIONS) {
    if (d.re.test(t)) hits.push(d.id)
  }
  return hits
}

/** 新近度系数：0 天 = 1，45 天 = 0.5，90 天 = 0.25。没有日期按「很久以前」算但不太狠。 */
export function freshness(dateStr, now = Date.now()) {
  const t = Date.parse(`${dateStr}T12:00:00`)
  if (!Number.isFinite(t)) return 0.6
  const days = Math.max(0, (now - t) / 86_400_000)
  return Math.pow(0.5, days / FRESHNESS_HALF_LIFE_DAYS)
}

/**
 * 从记忆里提炼说话习惯。
 *
 * **纯函数**：同样的输入（记忆 + 时间）永远同样的输出。这是能测的前提。
 *
 * @param {object} p
 * @param {string} p.prefs     preferences.md 全文
 * @param {string} [p.core]    memories.md 全文（也参与，但权重打折：core 讲事实，少见说话方式）
 * @param {number} [p.now]
 * @param {number} [p.minSupport] 至少几条记忆支持才算数（默认 1）
 * @returns {{habits:Array, groups:object, stats:object}}
 */
export function extractHabits({ prefs = '', core = '', now = Date.now(), minSupport = 1 } = {}) {
  const prefEntries = parseEntries(prefs).map((e) => ({ ...e, source: 'preferences', weightScale: 1 }))
  // core 里的条目也扫一遍，但打折 —— 它是「十年后仍成立的事实」，不是说话口味
  const coreEntries = parseEntries(core).map((e) => ({ ...e, source: 'core', weightScale: 0.5 }))
  const entries = [...prefEntries, ...coreEntries]

  /** dimId → { support, score, entries[], latest } */
  const buckets = new Map()

  for (const e of entries) {
    const dims = dimensionsOf(e.text)
    if (!dims.length) continue
    const w = (CONFIDENCE_WEIGHT[e.confidence] ?? 0.7) * e.weightScale * freshness(e.date, now)
    for (const dimId of dims) {
      let b = buckets.get(dimId)
      if (!b) { b = { support: 0, score: 0, entries: [], latest: '' }; buckets.set(dimId, b) }
      b.support += 1
      b.score += w
      b.entries.push(e)
      if (!b.latest || e.date > b.latest) b.latest = e.date
    }
  }

  /** 组内互斥：同一 group 只留分最高的那个。 */
  const byGroup = new Map()
  for (const [dimId, b] of buckets) {
    const d = BY_ID.get(dimId)
    if (!d) continue
    const cur = { dimId, dim: d, support: b.support, score: b.score, entries: b.entries, latest: b.latest }
    const prev = byGroup.get(d.group)
    if (!prev || cur.score > prev.score) byGroup.set(d.group, cur)
  }

  const habits = [...byGroup.values()]
    .filter((h) => h.support >= minSupport)
    .sort((a, b) => b.score - a.score)
    .map((h) => ({
      id: h.dimId,
      label: h.dim.label,
      group: h.dim.group,
      instruction: h.dim.instruction,
      support: h.support,
      score: Number(h.score.toFixed(3)),
      latest: h.latest,
      // 证据：给他看「凭什么这么要求你」
      evidence: h.entries
        .slice()
        .sort((a, b) => (b.date > a.date ? 1 : -1))
        .slice(0, 3)
        .map((e) => ({ id: e.id, text: e.text.slice(0, 60), date: e.date, confidence: e.confidence, source: e.source })),
      quotes: h.entries.map((e) => e.quote).filter(Boolean).slice(0, 2),
    }))

  /** 被互斥规则压掉的那些 —— 存起来，诊断「他改主意了」时有据可查。 */
  const overridden = []
  for (const [dimId, b] of buckets) {
    const d = BY_ID.get(dimId)
    if (!d) continue
    const winner = byGroup.get(d.group)
    if (winner && winner.dimId !== dimId) {
      overridden.push({
        id: dimId, label: d.label, group: d.group,
        score: Number(b.score.toFixed(3)), support: b.support,
        lostTo: winner.dimId,
      })
    }
  }

  const scoped = entries.filter((e) => !dimensionsOf(e.text).length).length

  return {
    habits,
    overridden,
    stats: {
      entries: entries.length,
      speechEntries: entries.length - scoped,
      taskEntries: scoped,
      dimensions: buckets.size,
      habits: habits.length,
      topScore: habits[0]?.score ?? 0,
    },
  }
}

/**
 * 生成注入文本。
 *
 * 原则：
 *   · 只给**有证据的**习惯，不编；
 *   · 每条带支持数和最新日期 —— 模型能看到「这条有多硬」；
 *   · 明确写清它和人格参数的优先级关系，否则两条会打架。
 *
 * @param {Array} habits extractHabits().habits
 * @param {object} [opts]
 */
export function habitsText(habits, { max = 8, withEvidence = false } = {}) {
  const list = (habits || []).slice(0, max)
  if (!list.length) return ''

  const lines = [
    '### 他希望你这么说话（从长期记忆里提炼的，不是设定）',
    '',
  ]
  for (const h of list) {
    const meta = []
    if (h.support > 1) meta.push(`${h.support} 条记忆支持`)
    if (h.latest) meta.push(`最近 ${h.latest}`)
    const tail = meta.length ? `（${meta.join('｜')}）` : ''
    lines.push(`- **${h.label}**：${h.instruction}${tail}`)
    if (withEvidence && h.quotes?.length) {
      lines.push(`  - 他原话：${h.quotes.map((q) => `「${q.slice(0, 40)}」`).join(' ')}`)
    }
  }

  lines.push(
    '',
    '这段是**从他自己说过的偏好里归纳出来的**，不是凭空加的设定。它比人格参数表更具体、更近 ——',
    '所以说话方式听这一段；但**它是风格，不是底线**：诚实、正确、该给的信息一条都不会因此减少。',
    '如果某条和你判断的「他真正需要」冲突，先按这条说，必要时再说明你的判断。',
  )
  return lines.join('\n')
}

/* ───────────────────────── 快照：让「逐渐」有据可查 ───────────────────────── */

/**
 * 习惯快照库。
 *
 * 每次算完存一份「这一刻是哪几条习惯」。
 * 于是可以做两件事：
 *   ① 状态页显示「她的说话方式这些天变了什么」
 *   ② 测试里证明「记忆变了 → 习惯跟着变」（而不是只靠我嘴上说）
 *
 * ⚠️ 只存摘要（id + 分数），不存全文 —— 快照会一直涨，全文太占地方。
 */
export class HabitStore {
  constructor(file) {
    this.file = file
    this.data = readJson(file, null) || { snapshots: [] }
    if (!Array.isArray(this.data.snapshots)) this.data.snapshots = []
  }

  /** 当前生效的习惯 id 列表。 */
  current() {
    const last = this.data.snapshots[this.data.snapshots.length - 1]
    return last ? last.habits.slice() : []
  }

  /**
   * 存一份快照。
   * 只有**真的变了**才追加 —— 否则每分钟一条，文件会爆炸。
   *
   * @returns {{changed:boolean, added:string[], removed:string[], snapshot?:object}}
   */
  snapshot(habits, { now = Date.now(), keep = 400 } = {}) {
    const ids = (habits || []).map((h) => h.id)
    const prev = this.current()
    const added = ids.filter((x) => !prev.includes(x))
    const removed = prev.filter((x) => !ids.includes(x))
    const sameOrder = ids.length === prev.length && ids.every((x, i) => x === prev[i])
    if (sameOrder && this.data.snapshots.length) {
      return { changed: false, added: [], removed: [] }
    }
    const snap = {
      at: now,
      day: dayKey(new Date(now)),
      habits: ids,
      scores: Object.fromEntries((habits || []).map((h) => [h.id, h.score])),
    }
    this.data.snapshots.push(snap)
    if (this.data.snapshots.length > keep) {
      this.data.snapshots = this.data.snapshots.slice(-keep)
    }
    return { changed: true, added, removed, snapshot: snap }
  }

  save() {
    try { writeJson(this.file, this.data); return true } catch { return false }
  }

  /**
   * 演化轨迹：把快照按天折叠，只留每天最后一条。
   * 给状态页和测试看「这些天她的说话方式怎么变的」。
   */
  drift() {
    const byDay = new Map()
    for (const s of this.data.snapshots) {
      byDay.set(s.day || dayKey(new Date(s.at)), s)
    }
    const rows = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, s]) => ({ day, habits: s.habits, scores: s.scores }))

    // 逐日对比，标出「这天加了什么 / 掉了什么」
    const out = []
    let prev = []
    for (const r of rows) {
      out.push({
        day: r.day,
        habits: r.habits,
        added: r.habits.filter((x) => !prev.includes(x)),
        removed: prev.filter((x) => !r.habits.includes(x)),
      })
      prev = r.habits
    }
    return out
  }
}
