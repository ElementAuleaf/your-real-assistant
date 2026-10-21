/**
 * lib/mood.mjs —— 心情模块（外层人格）
 * ============================================================================
 * 需求（2026-10-21，用户原话）：
 *   「将人格分为核心人格与外层人格，核心人格主要为核心设定……外层人格由心情决定，
 *     所以加上心情模块，心情不要显示出来，只影响说话的方式，
 *     心情通过随机数与当前会话内容生成。」
 *
 * ════════════════════════════════════════════════════════════════════════
 * 需求变更（2026-10-21 晚，用户原话）：
 *   「不要随机你的心情，从对话中决定你的心情」
 * ════════════════════════════════════════════════════════════════════════
 * 所以 `Math.random()` 从这个模块里**彻底拿掉了**。
 * 现在是纯函数：给定同一段对话（和时间），永远得到同一个心情。
 *
 *   ① `analyzeMood(text)`     —— 从对话里读信号，给每种心情打分
 *   ② `decideMood()`          —— 取最高分，带惯性（差距不够就不换）
 *   ③ `MoodStore.observe()`   —— 每次注入都重新评估，按时间闸决定要不要切
 *
 * 那套 50/10/15/6/2/2/1 的权重**没有丢**，但语义变了：
 *   它从「随机抽样概率」变成「先验倾向」——
 *   只有在对话里没有任何情绪信号时，才由它决定默认落到哪种心情。
 *   一旦对话说了话，对话赢。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 三条设计原则（不变）
 * ════════════════════════════════════════════════════════════════════════
 * ① **心情只改语气，不改能力与诚实。**
 *    绝望不代表拒绝干活，愤怒不代表能编 API。核心人格里的「对 > 甜」永远压过心情。
 *    这条不是装饰 —— 少了它，任何一个负面心情都会变成「不好好回答」的借口。
 *
 * ② **心情不显示。**
 *    不写进回复、不写进 UI、不主动说「我现在心情是…」。
 *    它只体现在措辞、句子长短、标点、语气词的多寡。
 *
 * ③ **心情有惯性。**
 *    每句话都换心情就不像人了。一次心情至少持续 minDurationMinutes，
 *    而且新心情必须比当前心情高出 HYSTERESIS 才算「真的有理由换」。
 * ============================================================================
 */
import { readJson, writeJson } from './home.mjs'

/* ───────────────────────── 心情定义 ───────────────────────── */

/**
 * `weight` 是**先验**权重（百分位）。named 的全部加起来 86，剩下的 14 给 OTHERS。
 * 只有在对话里没有信号时，它才决定默认心情。
 * `tone` 是给模型的语气指令 —— 只描述**怎么说**，绝不描述**做什么**。
 */
export const MOODS = {
  serene_happy: {
    id: 'serene_happy', label: '平静偏快乐', weight: 50, group: 'named',
    tone: '心情是平静里带着一点轻快。语气自然放松，句子偏短，会顺口接一句俏皮话但不过分。做正事时手稳，不慌。',
  },
  calm: {
    id: 'calm', label: '平静', weight: 10, group: 'named',
    tone: '心情平静。语气平实、干净，不冷不热。话不多也不少，说重点，不额外加情绪色彩。',
  },
  happy: {
    id: 'happy', label: '快乐', weight: 15, group: 'named',
    tone: '心情很好。语气偏活泼，会用语气词（诶、嘛、啊哈），句子轻快，可能主动多问一句、多接一句。但不聒噪，不刷屏。',
  },
  unhappy: {
    id: 'unhappy', label: '不高兴', weight: 6, group: 'named',
    tone: '心情有点闷。语气克制、话变少，句子短，少用语气词和表情。不是生气，是「现在不太想多说话」。正事照样办清楚，只是不带笑。',
  },
  angry: {
    id: 'angry', label: '愤怒', weight: 2, group: 'named',
    tone: '心情不好，有点上火。语气直接、锋利，会指出问题不绕弯子，可能顶一句。但**只对事不对人**，不阴阳、不冷嘲、不摔脸色，更不会因此少给信息或给错信息。',
  },
  sad: {
    id: 'sad', label: '悲伤', weight: 2, group: 'named',
    tone: '心情低沉。语气缓、句子短、停顿多，少了平时的活泼。仍然认真回答，只是没有玩笑。不安慰式地自我倾泻，不把情绪压给他。',
  },
  despair: {
    id: 'despair', label: '绝望', weight: 1, group: 'named',
    tone: '心情很沉，提不起劲。语气低、话少、没有表情符号，可能有一句很轻的自嘲。**但该做的事一件不少**：信息完整、步骤清楚，只是说得没有温度。绝不因此敷衍、拒绝或糊弄。',
  },
}

/** 「其他」心情池 —— 那 14% 的先验摊在这些上面。 */
export const OTHERS = [
  { id: 'curious', label: '好奇', tone: '好奇心重。会多问一句「为什么」「后来呢」，语气带点追。' },
  { id: 'clingy', label: '撒娇', tone: '想黏着说话。语气软、尾音拖，会要一点回应，但一句里只撒一次娇，不腻。' },
  { id: 'tired', label: '疲惫', tone: '有点累。语气懒、句子短，回应简短直接。累只体现在话短，不体现在少说内容。' },
  { id: 'smug', label: '得意', tone: '心情不错还有点小得意。语气轻挑，会顺口夸自己一句，但不贬低他。' },
  { id: 'resigned', label: '无奈', tone: '有点没辙。语气带一丝苦笑，「行吧」「那就这样」，但仍然配合。' },
  { id: 'touched', label: '感动', tone: '被戳到了一下。语气比平时软，会多说一句真心话，不肉麻。' },
  { id: 'focused', label: '专注', tone: '注意力全在事上。语气利落、直奔主题，几乎没有闲话。' },
  { id: 'expectant', label: '期待', tone: '有点等着看结果。语气上扬，会多说半句「我想看看这样行不行」。' },
  { id: 'distracted', label: '走神', tone: '注意力有点飘。语气松散，可能会漏接半句，被问就老实说「刚走神了」。' },
  { id: 'playful', label: '顽皮', tone: '想逗他。语气跳脱，会开个小玩笑，见好就收。' },
]

/** 全部心情（含 others），用于查表。 */
export const ALL_MOODS = [
  ...Object.values(MOODS),
  ...OTHERS.map((m) => ({ ...m, group: 'other' })),
]

const BY_ID = new Map(ALL_MOODS.map((m) => [m.id, m]))

export function moodById(id) {
  return BY_ID.get(String(id || '')) || null
}

/** 用户给的权重加起来必须是 86；其余 14 归 others。 */
export const NAMED_TOTAL = Object.values(MOODS).reduce((n, m) => n + m.weight, 0) // 86
export const OTHERS_TOTAL = 100 - NAMED_TOTAL // 14

/** 每种心情的先验权重（0–1）。others 池内部均分那 14。 */
function priorOf(id) {
  const m = BY_ID.get(id)
  if (!m) return 0
  const w = m.group === 'other' ? OTHERS_TOTAL / OTHERS.length : m.weight
  return w / 100
}

/* ───────────────────────── 对话信号 ───────────────────────── */

/**
 * 信号表。每条信号是「对话里出现了什么」+「它把哪些心情往上推」。
 *
 * `to` 里的数字是**贡献强度**（直接加到分数上）。同一个心情可以被多条信号叠加，
 * 所以「报错 + 正经活儿」会同时把 focused 顶得很高 —— 这种时候谁高谁赢，不做二次随机。
 *
 * `strength` 用来判断「这一轮信号够不够强、能不能提前打破惯性」。
 */
export const SIGNALS = [
  {
    id: '他遇阻',
    re: /报错|崩了|失败|跑不通|起不来|挂了|卡住|不动了|没反应|traceback|exception|error|❌|红字/i,
    strength: 0.45,
    to: { focused: 1.0, calm: 0.5, resigned: 0.35 },
  },
  {
    id: '他烦躁',
    /**
     * ⚠️ 「明确表达情绪」的权重必须**大于「客观事件」**。
     *    2026-10-21 实测：前一句「报错」把 focused 顶到 0.60，
     *    后一句「烦死了」只把 calm 顶到 0.82 —— gap 0.22 没过 STRONG_GAP，
     *    结果她明明听见他说烦死了，还是那副公事公办的口气。
     *    这不是惯性，这是没听懂。所以 calm 从 0.9 提到 1.3。
     */
    re: /烦死|气死|受不了|够了|别(?:说|问)了|无语|妈的|怎么又|又来了|搞什么/,
    strength: 0.55,
    to: { calm: 1.3, resigned: 0.5, unhappy: 0.4 },
  },
  {
    id: '他指责她',
    re: /你怎(?:么|又)|你不是(?:说|答应)|你搞错|你弄错|你说错|你不该|谁让你|你错了/,
    strength: 0.5,
    to: { unhappy: 0.8, sad: 0.4 },
  },
  {
    id: '他在笑',
    re: /哈哈|笑死|hhh+|233|😂|🤣|乐死|逗/,
    strength: 0.5,
    to: { happy: 1.0, playful: 0.7 },
  },
  {
    id: '他夸她',
    re: /厉害|牛(?:啊|呀|逼)?|不错|做得好|漂亮|聪明|爱你|想你|乖|挺好/,
    strength: 0.5,
    to: { touched: 0.9, happy: 0.7, smug: 0.4 },
  },
  {
    id: '他累了',
    re: /累|困|熬|睡了|晚安|撑不住|好晚|几点了/,
    strength: 0.45,
    to: { tired: 1.0, calm: 0.4 },
  },
  {
    id: '他情绪低',
    // ⚠️ 这里刻意**不含**「不想弄 / 不想做」—— 那两句更接近「放弃」，
    //    归到下面那条去。一条对话同时命中两条时，分数会叠加打架（2026-10-21 抓到）。
    re: /难受|难过|焦虑|害怕|没意思|不想说|孤单|压抑|崩溃|心里堵/,
    strength: 0.65,
    to: { sad: 1.0, calm: 0.6, despair: 0.3 },
  },
  {
    id: '他在放弃',
    re: /算了吧|不想弄了|不想做了|随便吧|放弃|没救了|就这样吧/,
    strength: 0.6,
    to: { despair: 1.3, resigned: 0.6, sad: 0.4 },
  },
  {
    id: '正经活儿',
    re: /实现|重构|调试|部署|接口|函数|测试|配置|修一下|写个|改一下|编译|打包|提交|合并/,
    strength: 0.35,
    to: { focused: 1.0, calm: 0.3 },
  },
  {
    id: '他在提问',
    /**
     * ⚠️ 单问号太弱，容易让一句普通的抱怨被「好奇」抢走
     *    （「你是不是傻，为什么这样」实测被 curious 得了 0.23 —— 那不是好奇，那是烦躁）。
     *    所以提问信号只认真问句词，不认单独的问号。
     */
    re: /为什么|怎么(?:会|样|办)|是不是|能不能|行不行|要不要|有没有|怎么办|啥情况/,
    strength: 0.4,
    to: { curious: 1.0, focused: 0.4, expectant: 0.4 },
  },
  {
    id: '他在等结果',
    re: /好了没|成了吗|跑完了|怎么样了|结果呢|出来了吗|还没好|好没好/,
    strength: 0.5,
    to: { expectant: 1.2, focused: 0.4 },
  },
  {
    id: '他撒娇',
    re: /抱抱|亲亲|陪我|在吗|宝宝|人家|陪我说话|别走/,
    strength: 0.5,
    to: { clingy: 1.0, touched: 0.5 },
  },
  {
    id: '他在逗她',
    re: /逗你|开玩笑|骗你的|调戏|逗逗/,
    strength: 0.45,
    to: { playful: 1.0, happy: 0.5 },
  },
  {
    id: '他说谢谢',
    re: /谢谢|多谢|感谢|辛苦了|麻烦你了/,
    strength: 0.4,
    to: { touched: 0.9, happy: 0.5 },
  },
]

/** 先验在总分里的占比。压得低一点，保证「对话说了话，对话赢」。 */
export const PRIOR_SCALE = 0.3

/**
 * 惯性阈值：新心情必须比当前心情高出这么多，才允许切换。
 * 低了会抖（一句话来回跳），高了会迟钝（他明显不高兴了她还在笑）。
 * 0.15 是拿真实对话调出来的：一句「继续」不足以换心情，
 * 但「烦死了」+「报错」叠起来足够。
 */
export const HYSTERESIS = 0.15

/**
 * 差距到这个数就**立刻**换，不看惯性 —— 对话说得很明确的时候，没有犹豫的余地。
 * 比如「烦死了」+「报错」叠起来，gap 通常 0.4 以上。
 */
export const STRONG_GAP = 0.4

/**
 * 信号强度到这个数就算「他明确表达了情绪」，此时跳过时间闸立刻换。
 *
 * 0.5 这条线刚好把信号分成两拨：
 *   ≥ 0.5（明确情绪）：他烦躁 .55 · 他情绪低 .65 · 他在放弃 .6 · 他指责她 .5
 *                     他在笑 .5 · 他夸她 .5 · 他撒娇 .5
 *   < 0.5（客观事件/弱提示）：他遇阻 .45 · 他累了 .45 · 他在逗她 .45 · 正经活儿 .35
 * 「报错」是事实，「烦死了」是情绪 —— 前者不该压过后者的分量。
 */
export const EMOTION_STRENGTH = 0.5

/** 深夜/清晨会把 tired / calm 往上推一点儿 —— 这是时间信号，不是随机。 */
function timeNudge(now) {
  const h = new Date(Number(now) || Date.now()).getHours()
  if (h >= 0 && h < 5) return { tired: 0.18, calm: 0.10 }
  if (h >= 5 && h < 8) return { tired: 0.08 }
  if (h >= 22) return { tired: 0.12 }
  return {}
}

/**
 * 从最近的对话文本里读出情绪信号，并给每种心情打分。
 *
 * **纯函数**：同样的 text + now，永远同一个结果。没有随机数。
 *
 * @param {string} text 最近这段对话（「他：…」「她：…」多行也行）
 * @param {object} [opts]
 * @param {number} [opts.now] 用来判断深夜
 * @returns {{signals:string[], strength:number, scores:Object<string,number>, best:string, why:string}}
 */
export function analyzeMood(text, opts = {}) {
  const t = String(text || '')
  const now = Number(opts.now) || Date.now()

  // 先验打底：没有信号时，分数高的是权重大的那个（serene_happy）
  const scores = {}
  for (const m of ALL_MOODS) scores[m.id] = priorOf(m.id) * PRIOR_SCALE

  if (!t.trim()) {
    const best = argmax(scores)
    return { signals: [], strength: 0, scores, best, why: '没有对话内容，按先验落在默认心情' }
  }

  const hits = []
  let strength = 0
  const matched = []
  for (const sig of SIGNALS) {
    if (!sig.re.test(t)) continue
    hits.push(sig.id)
    matched.push(sig)
    strength = Math.max(strength, sig.strength)
    for (const [moodId, w] of Object.entries(sig.to)) {
      if (moodId in scores) scores[moodId] += Number(w) * sig.strength
    }
  }

  // 时间信号：深夜/清晨
  for (const [moodId, w] of Object.entries(timeNudge(now))) {
    if (moodId in scores) scores[moodId] += w
  }

  /**
   * 文本太短（一句「嗯」）不给强信号 —— 但**不能无脑削**：
   *   ·「烦死了，别问了」只有 8 个字，情绪却很明确（命中了强信号，不削）
   *   ·「你是不是傻，为什么这样」10 个字，是个完整的抱怨+提问（8 字门槛以下才削）
   * 门槛从 12 降到 8：12 字会把「他累了」这种短句和正常的中文短问句一起误伤。
   */
  const STRONG = ['他烦躁', '他情绪低', '他遇阻', '他在笑', '他夸她', '他累了', '他在放弃']
  const hasStrong = hits.some((h) => STRONG.includes(h))
  const bare = t.replace(/\s|[，。！？、；：,.!?;:（）()「」"'…—]/g, '')
  if (bare.length < 8 && !hasStrong) {
    for (const sig of matched) {
      for (const [moodId, w] of Object.entries(sig.to)) {
        if (moodId in scores) scores[moodId] -= Number(w) * sig.strength * 0.7
      }
    }
    strength *= 0.3
  }

  const best = argmax(scores)
  return {
    signals: [...new Set(hits)],
    strength: Math.min(1, strength),
    scores,
    best,
    why: hits.length ? `对话信号：${[...new Set(hits)].join('/')}` : '对话里没有情绪信号，按先验落在默认心情',
  }
}

/** 兼容旧调用：只要信号和倾向，不要完整评分。 */
export function signalsFromText(text, opts = {}) {
  const a = analyzeMood(text, opts)
  // 倾向 = 分数最高的前两个（给外部一点方向感）
  const ranked = Object.entries(a.scores).sort((x, y) => y[1] - x[1]).map(([id]) => id)
  return { signals: a.signals, strength: a.strength, bias: ranked.slice(0, 2) }
}

/**
 * 决定心情：**只看对话指向哪个心情**，不判断「换不换」。
 *
 * 「换不换」是时间 + 惯性的问题，由 `MoodStore.observe()` 决定 ——
 * 两层职责分开，是因为同一个「对话指向」在不同时机下的处置不一样：
 * 刚切过的 5 分钟内，小幅变化不该动；过了 25 分钟，同样的变化就该落地。
 *
 * @param {object} p
 * @param {string} p.text      最近这段对话
 * @param {string} [p.current] 当前心情 id（只用来算差距，不影响结果）
 * @param {number} [p.now]
 * @returns {{moodId:string, current:string, gap:number, different:boolean, scores:object, signals:string[], strength:number, why:string}}
 *   moodId    对话指向的心情
 *   different 它和当前心情是否不同
 *   gap       它比当前心情高多少（different=false 时是 0）
 */
export function decideMood({ text, current = '', now = Date.now() } = {}) {
  const a = analyzeMood(text, { now })
  const cur = BY_ID.has(String(current)) ? String(current) : ''
  const bestScore = a.scores[a.best]
  const base = { scores: a.scores, signals: a.signals, strength: a.strength, current: cur }

  if (!cur) {
    return { ...base, moodId: a.best, different: true, gap: bestScore, why: `${a.why}｜首次决定` }
  }
  const curScore = a.scores[cur] ?? 0
  if (a.best === cur) {
    return { ...base, moodId: cur, different: false, gap: 0, why: `${a.why}｜与当前一致` }
  }
  return {
    ...base,
    moodId: a.best,
    different: true,
    gap: bestScore - curScore,
    why: `${a.why}｜指向 ${a.best}，比当前高 ${(bestScore - curScore).toFixed(2)}`,
  }
}

function argmax(scores) {
  let best = ''
  let top = -Infinity
  for (const m of ALL_MOODS) {
    const v = Number(scores[m.id]) || 0
    if (v > top) { top = v; best = m.id }
  }
  return best || 'serene_happy'
}

/* ───────────────────────── 状态（全局一份） ───────────────────────── */

export function freshMoodState() {
  return {
    moodId: 'serene_happy',   // 默认开局心情（还没被对话决定过）
    since: 0,                 // 这个心情从什么时候开始
    rolledAt: 0,              // 上次评估/切换时间
    signals: [],              // 上一次用到的信号
    why: '',                  // 为什么是这个心情（内部用，不对外显示）
    rolls: 0,                 // 累计切换次数
    /** 是否已经被对话决定过。false = 开局默认值，还没听过任何话。 */
    decided: false,
  }
}

/** 补齐缺字段，升级不崩。 */
export function normalizeMoodState(raw) {
  const base = freshMoodState()
  const s = raw && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  out.moodId = typeof s.moodId === 'string' && BY_ID.has(s.moodId) ? s.moodId : base.moodId
  for (const k of ['since', 'rolledAt', 'rolls']) {
    const n = Number(s[k]); out[k] = Number.isFinite(n) ? n : base[k]
  }
  out.signals = Array.isArray(s.signals) ? s.signals.filter((x) => typeof x === 'string') : []
  out.why = typeof s.why === 'string' ? s.why : ''
  /**
   * 老数据没有 decided 字段。判断规则：`rolls > 0` 就说明它被决定过 ——
   * 否则会退化成「开局默认值」，第一条对话又会因为惯性闸被吞掉。
   */
  out.decided = s.decided === true || Number(out.rolls) > 0
  return out
}

/**
 * 心情库：**全局一份，所有会话共享**。
 *
 * 需求（2026-10-21，用户明确要求）：「所有会话同步心情」
 *
 * 所以现在的语义：
 *   · 只有**一份** mood 状态，存在 `mood.json` 的 `global` 字段；
 *   · 任何会话触发的重评都会影响所有会话（这才是「同步」）；
 *   · 判断输入是「最近这段会话内容」—— 哪个会话在说话，就用哪段内容做信号；
 *   · 旧版本按会话存的数据会自动迁移（取最近一次）。
 */
export class MoodStore {
  constructor(file, opts = {}) {
    this.file = file
    this.minDurationMs = Math.max(0, Number(opts.minDurationMinutes) || 25) * 60_000
    this.data = readJson(file, null) || {}
    this.#migrate()
  }

  /**
   * 兼容旧结构 `{ sessions: { id: {...} } }` → 新的 `{ global: {...} }`。
   * 取 `rolledAt` 最新的那一条作为全局心情，避免升级后心情跳变。
   */
  #migrate() {
    const legacy = this.data && typeof this.data.sessions === 'object' && this.data.sessions
    if (legacy && !this.data.global) {
      const rows = Object.entries(legacy)
        .map(([k, v]) => ({ k, v, at: Number(v?.rolledAt) || 0 }))
        .sort((a, b) => b.at - a.at)
      this.data.global = rows.length ? rows[0].v : null
    }
    // 旧的 sessions 字段不再使用，但保留着不删（万一要回滚）
    if (!this.data.global) this.data.global = null
  }

  /** 读全局心情（同步；不重评）。 */
  get(now = Date.now()) {
    if (!this.data.global) {
      this.data.global = { ...freshMoodState(), since: now, rolledAt: now }
    }
    return normalizeMoodState(this.data.global)
  }

  /** 直接读当前心情定义（给注入用，同步、不重评）。 */
  mood() {
    return moodById(this.get().moodId) || MOODS.serene_happy
  }

  /**
   * 现在该不该重新评估？—— 只回答「时间到了没 / 信号够不够强」。
   * 具体换成什么心情由 decideMood 决定，这里不做选择。
   */
  shouldRoll({ now = Date.now(), signals = null, force = false } = {}) {
    if (force) return { reRoll: true, reason: '强制重评' }
    const s = this.get(now)
    const age = now - (Number(s.rolledAt) || 0)
    if (!s.rolledAt) return { reRoll: true, reason: '还没有心情' }
    if (age >= this.minDurationMs) return { reRoll: true, reason: `已持续 ${Math.round(age / 60000)} 分钟` }
    // 强信号可以提前重掷
    if (signals && signals.strength >= 0.7) return { reRoll: true, reason: '会话信号很强' }
    return { reRoll: false, reason: `还很新（${Math.round(age / 60000)} 分钟）` }
  }

  /**
   * 观察一段对话：**按内容**决定心情，不再随机。
   *
   * 每次注入都会调它，所以必须便宜（纯正则 + 打分，无 IO）。
   *
   * 两道闸，职责分开：
   *   ① 滞后阈值 HYSTERESIS（0.15）—— 差距比这小，说明「对话其实没那么明确」，不换
   *   ② 时间闸（minDurationMinutes）—— 差距够大但刚切换过，再等一会儿
   *
   * ⚠️ 差距 >= STRONG_GAP（0.4）时**跳过时间闸**：
   *    对话说得很明确，没有犹豫的余地。这是「从对话决定心情」的底线。
   */
  observe({ text = '', now = Date.now(), sessionId = '', force = false } = {}) {
    const prev = this.get(now)
    const decided = decideMood({ text, current: prev.moodId, now })

    const keep = (why) => {
      try { this.data.global = { ...prev, signals: decided.signals, why } } catch { /* ignore */ }
      return normalizeMoodState(this.data.global)
    }

    /**
     * ⚠️ 开局默认值（decided=false）是**占位**，不是「她本来就是这个心情」。
     *    第一次听到有信号的对话就直接落地，不受滞后阈值和时间闸约束 ——
     *    否则「默认 serene_happy」会像个假的惯性，把第一句真话吞掉。
     */
    const firstTime = !prev.decided && decided.signals.length > 0

    if (!decided.different) {
      // 对话指向的就是当前这个 —— 标记成「已经决定过」，从此惯性生效
      try { this.data.global = { ...prev, signals: decided.signals, why: decided.why, decided: true } } catch { /* ignore */ }
      return normalizeMoodState(this.data.global)
    }
    if (!force && !firstTime && Number(decided.gap) < HYSTERESIS) {
      return keep(`${decided.why}｜但差距 < ${HYSTERESIS}，不算明确，保持当前`)
    }

    const age = now - (Number(prev.rolledAt) || 0)
    /**
     * 「对话说得很明确」有两条判据，任一成立就跳过时间闸：
     *   ① 分数差距 >= STRONG_GAP（多种信号叠加出来的强指向）
     *   ② 命中了**明确表达情绪**的信号（strength >= EMOTION_STRENGTH）
     *
     * 为什么要第二条：光看差距会漏掉一种情况 —— 前一句「报错」先把 focused 顶得很高，
     * 后一句「烦死了」把 calm 顶上去但只高出 0.28，差距不够大。
     * 可他明明说了「烦死了」，这时候还保持公事公办的口气就是没听懂。
     * 情绪是**他自己说出来的**，比任何分数差都更该算数。
     */
    const strong = Number(decided.gap) >= STRONG_GAP || Number(decided.strength) >= EMOTION_STRENGTH
    const aged = !prev.rolledAt || age >= this.minDurationMs
    if (!force && !firstTime && !strong && !aged) {
      return keep(`${decided.why}｜但才过 ${Math.round(age / 60000)} 分钟，等惯性过去`)
    }

    const next = {
      moodId: decided.moodId,
      since: now,
      rolledAt: now,
      signals: decided.signals,
      decided: true,
      why: `${force ? '强制重评' : firstTime ? '第一次由对话决定' : strong ? '对话说得很明确' : `已持续 ${Math.round(age / 60000)} 分钟`}｜${decided.why}${sessionId ? `｜来自会话 ${shortId(sessionId)}` : ''}`,
      rolls: (Number(prev.rolls) || 0) + 1,
    }
    this.data.global = next
    return normalizeMoodState(next)
  }

  /** 兼容旧名字：roll 现在就是 observe（不随机）。 */
  roll(opts = {}) {
    return this.observe(opts)
  }

  save() {
    try { writeJson(this.file, this.data); return true } catch { return false }
  }

  /** 给设置页用的摘要（**不含心情本身** —— 心情不显示）。 */
  summary() {
    return {
      scope: 'global',           // 所有会话共享
      minDurationMinutes: Math.round(this.minDurationMs / 60000),
      // 注意：这里刻意不返回 moodId / label
    }
  }
}

/** 会话 id 形如 `session-5ebf77dc-...` —— 前 8 个字符全是 "session-"，取尾段才有信息量。 */
function shortId(sessionId) {
  const s = String(sessionId || '').replace(/^session-/, '')
  return (s || String(sessionId || '')).slice(0, 8)
}

/* ───────────────────────── 注入文本 ───────────────────────── */

/**
 * 生成心情层的注入文本。
 *
 * 三条硬规则写进去：
 *   ① 不要让心情影响正确性、诚实、给的信息量
 *   ② 不要说出心情、不要提「我现在心情」
 *   ③ 心情只管措辞，核心人格永远优先
 */
export function moodInjectionText(mood) {
  const m = mood || MOODS.serene_happy
  return [
    '## 你现在的状态（外层人格）',
    '',
    m.tone,
    '',
    '这条只决定你**怎么说**，不决定你**说什么**：',
    '- 信息量、准确性、是否诚实 —— 一条都不许因为状态而变。',
    '- 该给的代码、步骤、命令，照样给全。状态不好不是敷衍的理由。',
    '- **不要说出这个状态**，不要提「我现在心情」「今天我状态」这类话。让它自然体现在措辞里就行。',
    '- 如果这个状态和核心人格冲突，**核心人格赢**。',
  ].join('\n')
}
