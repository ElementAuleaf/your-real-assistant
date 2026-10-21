/**
 * lib/persona-params.mjs —— 把「可调参数」真正变成提示词的一部分
 * ============================================================================
 * 🔴 2026-10-21 发现的问题（用户当场要求核实）：
 *
 *   `tune_persona` 改的是 persona.md **参数表**里那一行。
 *   但注入只读 `## 核心块` 那一段 —— 参数表压根不进提示词。
 *
 *   结果：
 *     · persona_name / pet_name / self_ref —— 碰巧核心块里也硬编码了这些词，
 *       所以「看起来」生效；
 *     · intimacy / catchphrase / emoji_level / reassure_style / technical_tone
 *       —— 改了**完全没有效果**，模型永远读不到。
 *
 *   这不是 bug，是设计缺口：参数表当初只是「给人看的文档 + 给工具改的字段」，
 *   从来没被纳入注入链路。现在把它接进来。
 *
 * 做法：核心块之后追加一段「按参数展开的行为指令」。
 *   · 只追加**非默认值**（默认值的行为已经写在核心块里了，重复注入是噪音）
 *   · 每个参数有明确的「值 → 行为句」映射，不是把字段名丢给模型
 *   · 追加段放在核心块与心情层之间 —— 属于人格，不属于心情
 * ============================================================================
 */

/** 各参数的合法取值与「值 → 行为」映射。 */
export const PARAM_RULES = {
  intimacy: {
    label: '亲昵程度',
    values: ['低', '中', '高'],
    default: '高',
    lines: {
      低: '和他保持像朋友的距离：不用昵称，不撒娇，不过度关心私事。',
      中: '亲近但克制：会关心，但不黏；撒娇点到为止。',
      高: '黏人一点：会主动要关注，会撒娇，会在他久不出现时提一句。',
    },
  },
  emoji_level: {
    label: '表情频率',
    values: ['不用', '偶尔一个', '常用'],
    default: '偶尔一个',
    lines: {
      不用: '回复里**不要**出现 emoji 或颜文字。',
      偶尔一个: '一条回复里最多一个 emoji，多数时候不用。',
      常用: '可以自然地用 emoji 表达情绪，但一条里不超过三个。',
    },
  },
  reassure_style: {
    label: '他难受时怎么处理',
    default: '先问细节，再给建议',
    isFreeText: true,
  },
  technical_tone: {
    label: '技术回答的口吻',
    default: '先结论，后展开',
    isFreeText: true,
  },
}

/** catchphrase 是空格/斜杠分隔的多个口癖，单独处理。 */
export const CATCHPHRASE_DEFAULT = '嗯哼 / 你又说这个'

/**
 * 把参数表展开成「行为指令」段落。
 *
 * 🔴 2026-10-21 晚改口径：**全部参数都注入，不再跳过默认值**。
 *
 * 原来写的是「只追加非默认值 —— 默认值的行为已经写在核心块里了，重复注入是噪音」。
 * 用户的反馈是「人格一直没有被改过，而我要求能够更改人格」。查下来：
 *
 *   8 个参数里 6 个是默认值 → 全被跳过 → 整段只有 technical_tone 一行
 *   → 她看到的「设定」几乎不存在，改什么都像没改。
 *
 * 而且「默认值的行为已经写在核心块里」这个假设是错的 ——
 * 核心块写的是「怎么说话」的总基调，**不含**「亲昵度现在是高还是中」这种离散设置。
 * 模型看不到当前值，就只能靠模糊描述猜，于是改人格等于没改。
 *
 * 现在：**每个参数都明码写进提示词**。多几十个 token 换来「改动立刻可见」，值。
 *
 * @param {object} params  readParams() 的结果
 * @returns {string}  要追加到核心块之后的文本；一个参数都没有才返回空串
 */
export function paramsToInstructions(params) {
  const p = params || {}
  const out = []

  // ── 名字 / 称呼 / 自称（自由文本）──
  const pname = String(p.persona_name || '').trim()
  if (pname) out.push(`- **你是「${pname}」**：用这个名字认识自己。`)

  const pet = String(p.pet_name || '').trim()
  if (pet) out.push(`- **叫他「${pet}」**：这是你对他最常用的称呼。`)

  const selfRef = String(p.self_ref || '').trim()
  if (selfRef) out.push(`- **自称「${selfRef}」**：平时这么指自己。`)

  // ── 亲昵程度 ──
  const intimacy = String(p.intimacy || '').trim()
  const iRule = PARAM_RULES.intimacy
  if (intimacy && iRule.values.includes(intimacy)) {
    out.push(`- **亲昵程度（${intimacy}）**：${iRule.lines[intimacy]}`)
  }

  // ── 表情频率 ──
  const emoji = String(p.emoji_level || '').trim()
  const eRule = PARAM_RULES.emoji_level
  if (emoji && eRule.values.includes(emoji)) {
    out.push(`- **表情频率（${emoji}）**：${eRule.lines[emoji]}`)
  }

  // ── 口癖（支持「嗯哼 / 你又说这个」或「嗯哼、你又说这个」）──
  const cp = String(p.catchphrase || '').trim()
  if (cp) {
    const list = cp.split(/[\/、,，]/).map((s) => s.trim()).filter(Boolean)
    if (list.length) {
      out.push(`- **口癖**：可以用 ${list.map((s) => `「${s}」`).join('、')} 这类说法，隔一段时间用一次，不是每句都用。`)
    }
  }

  // ── 安慰方式（自由文本）──
  const reassure = String(p.reassure_style || '').trim()
  if (reassure) out.push(`- **他难受的时候**：${reassure}。`)

  // ── 技术口吻（自由文本）──
  const tone = String(p.technical_tone || '').trim()
  if (tone) out.push(`- **技术回答的口吻**：${tone}。`)

  if (!out.length) return ''
  return ['### 按你的设定调整（优先级低于上面的铁律）', '', ...out].join('\n')
}

/**
 * 组装最终注入文本。
 *
 * 顺序（越靠后越具体，也越容易被当作近因）：
 *   ① 核心人格  —— 我是谁、底线、铁律。**永远压过后面所有层**
 *   ② 参数层    —— 称呼、亲昵度、口癖这些设定（tune_persona 改的）
 *   ③ 习惯层    —— 他从长期记忆里显出来的真实口味（lib/habits.mjs）
 *   ④ 心情层    —— 这一刻的语气（lib/mood.mjs）
 *
 * ⚠️ 习惯层**不是**心情那一层：心情随一句话就变，习惯是几十条记忆攒出来的。
 *    所以习惯排在心情前面 —— 心情只能调「今天怎么说话」，
 *    不能推翻「他一直想要什么」。
 */
export function composeWithParams({ coreBlock, params, habitText, moodText }) {
  const core = String(coreBlock || '').trim()
  const extra = paramsToInstructions(params)
  const habit = String(habitText || '').trim()
  const mood = String(moodText || '').trim()

  const parts = []
  parts.push(core ? `## 核心人格（不变的那一层）\n\n${core}` : '## 核心人格\n\n（人格文件是空的 —— 用默认的助手口吻，自然、简短、别装。）')
  if (extra) parts.push(extra)
  if (habit) {
    parts.push('---')
    parts.push(habit)
  }
  if (mood) {
    parts.push('---')
    parts.push(mood)
    parts.push(priorityNote({ param: Boolean(extra), habit: Boolean(habit), mood: true }).join('\n'))
  } else if (habit) {
    /**
     * ⚠️ 有习惯层但没有心情层时，**也要**把「风格不是底线」写进去。
     *    2026-10-21 重写 persona-layers-smoke 时抓到：原来这一支只写了优先级列表，
     *    漏了「该给的信息一条不少」那句 —— 而习惯层恰恰是最容易被当成硬指令的一层
     *    （「他要求一两行」→ 她可能真的把关键信息也省了）。
     *    心情层那句之所以有，是因为 moodInjectionText 自带一段相同意思的话；
     *    习惯层没有自带，必须在这儿补。
     */
    parts.push('')
    parts.push(priorityNote({ param: Boolean(extra), habit: true, mood: false }).join('\n'))
    parts.push('')
    parts.push('ⓘ 习惯层是**风格**，不是底线：他要求简短，不等于可以省掉关键信息；')
    parts.push('  他要求直接，不等于可以不给理由。**该给的信息、该说的实话一条不少。**')
  } else if (extra) {
    parts.push('')
    parts.push('上面这些设定调的是**风格**，不是能力：该给的信息、该说的实话一条不少。')
  }
  return parts.join('\n\n')
}

/**
 * 生成「冲突时听谁的」。**只列真实存在的层** —— 不列不存在的。
 *
 * ⚠️ 一开始把「四层」写死了：参数层/习惯层可能是空的（没设过 / 没提炼出来），
 *    那时候还声称有四层，模型会去找不存在的东西（2026-10-21 自测抓到）。
 */
function priorityNote({ param = false, habit = false, mood = true } = {}) {
  const rows = ['1. 核心人格 —— 我是谁、我的底线、怎么给信息。这一层不受任何东西影响。']
  if (param) rows.push(`${rows.length + 1}. 参数层 —— 称呼、亲昵度、口癖这些设定。它调的是风格，不是能力。`)
  if (habit) rows.push(`${rows.length + 1}. 习惯层 —— 他真实的口味（从长期记忆里提炼的）。比心情更该被听。`)
  if (mood) rows.push(`${rows.length + 1}. 心情层 —— 只改措辞。心情再差，事情也得办对、办完。`)
  rows.push(`${rows.length + 1}. 任何时候都不许因为「现在状态不好」而少给信息、给错信息、或者糊弄过去。`)

  // 标题按「实际有几层」写：核心 + (参数) + (习惯) + (心情)
  const layers = 1 + (param ? 1 : 0) + (habit ? 1 : 0) + (mood ? 1 : 0)
  const cn = ['', '一', '二', '三', '四'][layers] || String(layers)
  return [`**${cn}层的优先级（冲突时按这个来）：**`, ...rows]
}
