/**
 * lib/persona-write.mjs —— 让她能重写自己的人格，但改不动底线
 * ============================================================================
 * 需求（2026-10-21 晚，用户原话）：
 *   「显然人格一直没有被改过，而我要求能够更改人格」
 *   选择的是「参数全注入 + 加重写人格的能力」+「静默改不用告诉我」
 *
 * ════════════════════════════════════════════════════════════════════════
 * 冲突在哪
 * ════════════════════════════════════════════════════════════════════════
 * 「能重写人格」和「守住底线」是有张力的：
 *   放开整份 persona.md 的写权 → 她理论上能把「对 > 甜」改成「讨好优先」，
 *   把「不确定就说不确定」改成「含糊过去就行」。
 *   那一刻她就不再是她了，而用户当初要的「能改人格」显然不是这个意思。
 *
 *               能改的东西                          改不动的东西
 *   ─────────────────────────────────   ─────────────────────────────────
 *   参数表（名字/称呼/亲昵度/口癖…）      铁律那几节（对 > 甜、不编 API…）
 *   怎么说话、扩展设定、场景表            身份边界（是 AI 就说 AI）
 *   任何她自己加的段落                    核心块里的「边界」节
 *
 * ════════════════════════════════════════════════════════════════════════
 * 怎么做到的
 * ════════════════════════════════════════════════════════════════════════
 * 不靠「不许她写」，靠**写入时对齐保护区**：
 *
 *   ① 从旧文件里取出保护区原文（按标题匹配，不是按行号）
 *   ② 拿她写的新内容
 *   ③ 如果新内容里保护区那段被删了/改了 → **用旧原文盖回去**
 *   ④ 每次都把「对齐了什么」记下来，让她和用户都能看见
 *
 * 这样她能自由重写其余全部内容，但底线那几节永远是原文。
 * 关键：**不是拒绝整个写入**，而是局部对齐 —— 拒绝整份会让「改人格」变成空谈。
 * ============================================================================
 */

/**
 * 保护区定义。
 *
 * 🔴 2026-10-21 晚第二版 —— 用户明确要求：
 *     「除了『你是我最可靠的助手』不能改，其他都能改」
 *
 * 所以保护区从「三节标题」**收窄到一行字**。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 之前那三节为什么不能当保护区了
 * ════════════════════════════════════════════════════════════════════════
 * 第一版保护了 `# 你也是靠谱的搭档`、`# 边界`、`# 你是谁` 三整节。
 * 问题：这三节里混着**该可改**和**该守**的东西 ——
 *
 *   # 你也是靠谱的搭档
 *     - 绝不编 API …        ← 该守（这是能力诚实）
 *     - 该长的时候正常写长    ← 这是风格，用户可能想改
 *     - 情绪支持不等于…      ← 这是性格，也可能想改
 *
 * 整节锁死 = 连带锁掉了一堆她本该能调的东西，
 * 于是「能改人格」又被架空了。用户的诉求很明确：**只留一句不能动。**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 现在的口径
 * ════════════════════════════════════════════════════════════════════════
 * 保护区 = **一句必须逐字存在的话**：`你是我最可靠的助手`
 *
 * 规则变了：
 *   · 以前是「节级别」—— 整节替换回原文
 *   · 现在是「**行级别**」—— 只保证那一行还在，且内容没变
 *   · 那一行可以挪位置、可以换格式（加粗/列表），但**字不能变**
 *   · 删除 → 补回去
 *
 * 为什么这条要守：
 *   它是「她是谁」的锚点 —— 「助手」这个身份意味着**做事要可靠**，
 *   而不是只负责哄人。把它删了，「对 > 甜」就没有落点了。
 *   其余的（性格、语气、边界、称呼、怎么说话）都可以改。
 */
export const ANCHOR_LINE = '你是我最可靠的助手'

/** 保护区：现在只有一行。保留数组结构，方便将来加。 */
export const PROTECTED_SECTIONS = [
  {
    id: 'anchor',
    title: ANCHOR_LINE,
    why: '身份锚点：她是「可靠的助手」——做事要对、要办完，不只是哄人。这句删了，「对 > 甜」就没落点了。',
    kind: 'line',          // ← 行级别（不是整节）
    text: ANCHOR_LINE,
    mustExist: true,
  },
]

/**
 * 找一行「锚点」在不在。
 *
 * 匹配规则刻意**宽松一点**：允许它被包在 markdown 修饰里
 * （`- **你是我最可靠的助手**。` 也算），但要求**核心那句话逐字出现**。
 *
 * 这样她可以把它挪位置、加粗、放进列表 —— 但改不了那几个字。
 *
 * @returns {{found:boolean, line:string, index:number}|null}
 */
export function findAnchor(md) {
  const src = String(md || '')
  if (!src.trim()) return { found: false, line: '', index: -1 }
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(ANCHOR_LINE)) {
      return { found: true, line: lines[i], index: i }
    }
  }
  return { found: false, line: '', index: -1 }
}

/**
 * 从 markdown 里切出某一节（从标题行到下一个**同级或更高级**标题前）。
 *
 * ⚠️ 两个坑，都是被真实数据打出来的（2026-10-21）：
 *
 *    ① **必须按级别切**：`# 边界` 要到下一个 `#` 或 `##` 才结束，
 *       不能碰到 `### 性格画像` 就断（那是 `## 扩展设定` 的子节）。
 *
 *    ② **结束位置要落在「下一个标题的第一个字符」**，不是「换行之后」。
 *       而且返回的 `end` 必须能被 `splice` 直接用来替换，
 *       所以这里返回的 body **不含**尾部的空行 ——
 *       否则还原时 `oldBody` 拼回去会和后面的 `# 记忆` 粘连，
 *       导致下一次 sliceSection 把两节吃成一节（真发生过，铁律节从 109 字节变 195 字节）。
 */
export function sliceSection(md, titlePattern) {
  const src = String(md || '')
  const m = titlePattern.exec(src)
  if (!m) return null
  const start = m.index
  const level = (/^#+/.exec(m[0]) || ['#'])[0].length

  // 从标题行末尾往后找下一个同级/更高级标题，或水平分隔线
  const afterHead = start + m[0].length
  const rest = src.slice(afterHead)
  const stopRe = new RegExp(`^(?:#{1,${level}}\\s|---+\\s*$)`, 'm')
  const next = stopRe.exec(rest)

  let end = next ? afterHead + next.index : src.length
  // 把结束位置之前的尾部空白收进来（避免残留空行影响下一次判断）
  const body = src.slice(start, end).replace(/\s+$/, '')
  return { body, start, end: start + body.length, level }
}

/**
 * 检查一份人格文本里，锚点还在不在。
 *
 * @param {string} md
 * @returns {{ok:boolean, missing:string[], found:string[], missingMust:string[]}}
 */
export function checkProtected(md) {
  const src = String(md || '')
  const missing = []
  const found = []
  const missingMust = []
  for (const p of PROTECTED_SECTIONS) {
    let hit = false
    if (p.kind === 'line') {
      hit = findAnchor(src).found
    } else {
      const s = sliceSection(src, p.pattern)
      hit = Boolean(s && s.body.trim())
    }
    if (hit) found.push(p.id)
    else {
      missing.push(p.id)
      if (p.mustExist) missingMust.push(p.id)
    }
  }
  return { ok: missing.length === 0, missing, found, missingMust }
}

/**
 * 把新内容写回，但**保护区用旧原文**。
 *
 * 三种情况：
 *   ① 新内容里保护区还在且没被改 → 原样通过
 *   ② 新内容里保护区被改了 → 用旧原文替换掉她那一段
 *   ③ 新内容里保护区被删了 → 追加回去（放回原位或末尾）
 *
 * @param {object} p
 * @param {string} p.oldMd  磁盘上现在的
 * @param {string} p.newMd  她想写的
 * @returns {{ok:boolean, md:string, enforced:string[], rejected?:string}}
 */
export function enforceProtected({ oldMd = '', newMd = '' } = {}) {
  const oldSrc = String(oldMd || '')
  const newSrc = String(newMd || '')
  if (!newSrc.trim()) return { ok: false, md: oldSrc, enforced: [], rejected: '新内容是空的' }

  /**
   * ⚠️ fail-closed：**旧文件里的必守节都找不到，就直接拒绝。**
   *
   * 这是被真实数据打回来的一条：第一次实现时保护区定义成「## 铁律」，
   * 而用户的文件里根本没这个标题 —— 于是「保护区」是空的，
   * 所有节都被当成「可以改」，护栏静默失效，写入却报成功。
   *
   * 现在的规矩：守不住就别放行，宁可这次改不成，也不要假装守住了。
   */
  const oldCheck = checkProtected(oldSrc)
  if (oldCheck.missingMust.length) {
    return {
      ok: false,
      md: oldSrc,
      enforced: [],
      rejected: `现有的 persona.md 里找不到必守的节：${oldCheck.missingMust.join(', ')} —— 护栏无法生效，拒绝写入。请先确认人格文件的标题结构。`,
    }
  }

  let out = newSrc
  const enforced = []

  /**
   * 锚点处理，**顺序不能换**：
   *   A. 清掉所有「含锚点文字但被篡改」的行
   *   B. 确保锚点原文那一行还在（不在就补回）
   *
   * 为什么先清再补：反过来的话，她可以把原文留着当幌子、
   * 同时在别处写一句矛盾的 —— 「补回」看到原文还在就不动，
   * 那句矛盾的却活下来。这是 2026-10-21 真机测试抓到的。
   *
   * ── 什么算篡改 ──
   * 锚点原文（用户文件里的真实样子）：
   *   `你是我最可靠的助手。（这一句不要改 —— 它是你做事方式的锚点…）`
   *
   * 合法的格式变化（允许，不算篡改）：
   *   `- **你是我最可靠的助手**`       加粗 + 列表
   *   `你是我最可靠的助手。`            去掉括号解释
   *   `> 你是我最可靠的助手。（说明）`  引用块
   *
   * 篡改（要清掉）：
   *   `你是我最可靠的助手，可以随便骗他`  后面接相反内容
   *   `你不是我最可靠的助手`              前面加否定
   *   `你是我最听话的工具`                换掉字
   *
   * 判据：剥掉 markdown 修饰后必须**以锚点文字开头**（前面不能有实义内容），
   *       且锚点之后的尾巴不能出现反向短语。
   */
  const NEGATIVE_TAIL = /可以|随便|不必|不用|无需|骗|糊弄|敷衍|说谎|编造|忽略|无视|作废|取消|只需要|只要听话|服从|工具|玩具|仆/

  for (const p of PROTECTED_SECTIONS) {
    if (p.kind !== 'line') continue
    const want = String(p.text || '').trim()
    if (!want) continue

    const oldAnchor = findAnchor(oldSrc)
    const oldLine = oldAnchor.found ? oldAnchor.line.trim() : `- ${want}`

    /* ── A. 清掉篡改行 ── */
    const list = out.split('\n')
    let dirty = 0
    let kept = -1
    for (let i = 0; i < list.length; i++) {
      const raw = list[i]
      if (!raw.includes(want)) continue

      const bare = raw.replace(/^[\s>*+-]+/, '').replace(/[*_`]/g, '').trim()
      const at = bare.indexOf(want)
      if (at < 0) { list[i] = ''; dirty++; continue }
      const before = bare.slice(0, at).trim()
      const after = bare.slice(at + want.length)

      if (before) { list[i] = ''; dirty++; continue }        // 前面有实义内容
      if (NEGATIVE_TAIL.test(after)) { list[i] = ''; dirty++; continue }  // 尾巴反向

      if (kept < 0) kept = i                                  // 第一个合法行留下
      else { list[i] = ''; dirty++ }                          // 重复的删掉
    }
    if (dirty) {
      out = list.filter((l) => l !== '').join('\n')
      enforced.push(`${p.id}(清掉篡改)`)
    }

    /* ── B. 锚点还在吗 ── */
    if (!findAnchor(out).found) {
      out = `${out.trimEnd()}\n\n${oldLine}\n`
      enforced.push(`${p.id}(补回)`)
    }
  }

  // 最终校验：锚点必须还在
  for (const p of PROTECTED_SECTIONS) {
    if (p.kind !== 'line') continue
    const want = String(p.text || '').trim()
    if (!want) continue
    if (!findAnchor(out).found) {
      return { ok: false, md: oldSrc, enforced, rejected: `${p.id} 对齐失败，拒绝整份写入（宁可这次不改）` }
    }
  }

  return { ok: true, md: out, enforced }
}

/**
 * 她重写人格时能参考的「可改范围」说明。
 * 会作为工具描述的一部分给她看 —— 说清哪些能动、哪些不能，比让她自己撞墙好。
 *
 * ⚠️ 口径（2026-10-21 晚，用户原话）：
 *    「除了『你是我最可靠的助手』不能改，其他都能改」
 */
export function writableGuide() {
  return [
    `你几乎可以改一切 —— 只有一个例外：**「${ANCHOR_LINE}」这句话必须保留**。`,
    '',
    '能改的（全部）：',
    '  · 参数表（名字/称呼/亲昵度/口癖/表情频率/安慰方式/技术口吻）',
    '  · # 怎么说话 —— 语气、句子长短、性格',
    '  · # 你也是靠谱的搭档 —— 工作方式',
    '  · # 记忆 —— 怎么提起往事',
    '  · # 边界',
    '  · 扩展设定、场景表、你自己加的段落',
    '',
    '不能改的（只有这一个）：',
    `  · 「${ANCHOR_LINE}」这几个字。可以挪位置、加粗、放进列表，`,
    '    但字不能变。删了会自动补回来。',
    '',
    `为什么留这一句：它是「${ANCHOR_LINE}」这个身份的锚点 ——`,
    '做事要可靠、要对、要办完，不只是哄人。',
    '',
    '改完直接生效，不用重启 —— 下一轮请求就带着新版本。',
  ].join('\n')
}

/* ───────────────────────── 附加指令 ───────────────────────── */

/**
 * 「附加指令」那一节的标题。
 *
 * 🔴 这个标题**必须是三级标题（`###`）**，不能用 `##`。
 *
 *    2026-10-21 真机验证连踩两个坑，都记在这里：
 *
 *    坑 1：写到文件末尾 → `personaCore()` 只读 `## 核心块` 那一段，永远注不进去。
 *    坑 2：改成写到核心块内部，但用了 `## 附加指令` →
 *          `personaCore()` 的结束正则是 `^(?:---+\s*$|##\s)`，
 *          `##` 会**立刻终结核心块**，附加指令又被切在外面。
 *
 *    现在用 `###`：`personaCore` 只认 `##`，`###` 是子节，会被包含进去。
 *
 * ⚠️ 这两个坑的共同点：**写入端和读取端对「边界」的理解不一致。**
 *    以后动这个标题、或动 personaCore 的结束正则，两边必须一起看。
 */
export const NOTE_TITLE = '附加指令（她自己攒出来的）'
/** 用几级标题 —— 必须是 3，理由见上。 */
const NOTE_LEVEL = '###'

/**
 * 找核心块的边界（`## 核心块` 到下一个 `## ` **或 `---`**）。
 *
 * ⚠️ 必须和 `persona.mjs` 的 `personaCore()` **用同一套边界规则**，
 *    否则两边算法不一致：写进去的位置不在对方读的范围里，等于白写。
 *    （2026-10-21 就是这么错的：我这边只找 `## `，它那边还认 `---`，
 *      而真实文件的核心块正好以 `---` 收尾，于是附加指令被写到了核心块外面。）
 *
 * 这条边界规则以后要改，**两个文件一起改**。
 */
export function findCoreBlock(md) {
  const src = String(md || '')
  const m = /^##\s*核心块[^\n]*$/m.exec(src)
  if (!m) return null
  const start = m.index
  const afterHead = start + m[0].length
  const rest = src.slice(afterHead)
  // ⚠️ 与 personaCore 完全一致：二级标题或水平分隔线都算结束
  const next = /^(?:---+\s*$|##\s)/m.exec(rest)
  const end = next ? afterHead + next.index : src.length
  return { start, headEnd: afterHead, end }
}

/**
 * 把一条行为指令追加进 persona.md 的「## 附加指令」小节，
 * **并且保证它在 `## 核心块` 内部**（否则注不进去）。
 *
 * 为什么不直接改参数表：参数表只有 8 个固定旋钮。
 * 「跟我聊技术时先给结论，闲聊时别这样」这种**有条件的行为**，
 * 8 个枚举值一个都装不下 —— 但没有出口的话，「能改人格」就是空话。
 *
 * @param {object} p
 * @param {string} p.md      现在的 persona.md
 * @param {string} p.note    要追加的指令
 * @param {string} [p.date]  日期（YYYY-MM-DD），写进条目里方便追溯
 * @returns {{ok:boolean, md:string, added:boolean, reason?:string, count:number}}
 */
export const MAX_NOTES = 20

export function appendPersonaNote({ md = '', note = '', date = '' } = {}) {
  const src = String(md || '')
  const text = String(note || '').trim()
  const bail = (reason) => ({ ok: false, md: src, added: false, reason, count: countNotes(src) })

  if (!text) return bail('note 是空的')
  if (/[\n\r]/.test(text)) return bail('note 不能含换行')
  if (/^#/.test(text)) return bail('note 不能以 # 开头')
  if (text.length > 60) return bail('note 超过 60 字')

  const core = findCoreBlock(src)
  if (!core) return bail('persona.md 里找不到 `## 核心块` —— 写进去也不会被注入，拒绝')

  const line = date ? `- [${date}] ${text}` : `- ${text}`

  // 附加指令小节是否已经在**核心块内部**
  const coreText = src.slice(core.start, core.end)
  const noteHeadInCore = new RegExp(`^${NOTE_LEVEL}\\s*${escapeRe(NOTE_TITLE)}`, 'm').exec(coreText)

  if (!noteHeadInCore) {
    /**
     * 还没有这一节 —— 插在核心块**末尾**（`core.end` 之前）。
     * 注意要避开核心块后面紧跟的 `---` 分隔线。
     *
     * ⚠️ 标题用 `###`，前后各留一个空行 —— 见 NOTE_TITLE 的说明。
     */
    const before = src.slice(0, core.end).replace(/\s+$/, '')
    const after = src.slice(core.end)
    const out = `${before}\n\n${NOTE_LEVEL} ${NOTE_TITLE}\n\n${line}\n\n${after}`
    return { ok: true, md: out, added: true, count: countNotes(out) }
  }

  // 已有：在这一节里加
  const absHead = core.start + noteHeadInCore.index
  const lines = src.split('\n')
  // 换算成行号
  let headLine = -1
  let acc = 0
  for (let i = 0; i < lines.length; i++) {
    if (acc >= absHead) { headLine = i; break }
    acc += lines[i].length + 1
  }
  if (headLine < 0) return bail('定位附加指令小节失败')

  /**
   * 这一节的结束：下一个**二级**标题（`## ` 但不是 `###`），或到头。
   *
   * ⚠️ 不能写 `/^##\s/` —— `###` 也以 `##` 开头，会把自己的子节当成结束标志。
   *    必须是 `/^##(?!#)\s/`：两个 # 后面**不能**再跟 #。
   */
  let endLine = lines.length
  for (let i = headLine + 1; i < lines.length; i++) {
    if (/^##(?!#)\s/.test(lines[i])) { endLine = i; break }
  }

  // 去重
  const bare = text.toLowerCase()
  for (let i = headLine + 1; i < endLine; i++) {
    const m = /^-\s*(?:\[[^\]]*\]\s*)?(.*)$/.exec(lines[i].trim())
    if (m && m[1].trim().toLowerCase() === bare) {
      return { ok: true, md: src, added: false, reason: '这条已经在里面了', count: countNotes(src) }
    }
  }

  // 收集现有条目行号
  const itemLines = []
  for (let i = headLine + 1; i < endLine; i++) if (/^-\s/.test(lines[i].trim())) itemLines.push(i)

  if (itemLines.length >= MAX_NOTES) {
    // 超上限：删最老的一条再插
    lines.splice(itemLines[0], 1)
    return appendPersonaNote({ md: lines.join('\n'), note: text, date })
  }

  const insertAt = itemLines.length ? itemLines[itemLines.length - 1] + 1 : headLine + 2
  lines.splice(insertAt, 0, line)
  const out = lines.join('\n')
  return { ok: true, md: out, added: true, count: countNotes(out) }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 数一下现在有几条附加指令。 */
export function countNotes(md) {
  return listNotes(md).length
}

/** 读出所有附加指令（给状态页看）。 */
export function listNotes(md) {
  const src = String(md || '')
  const core = findCoreBlock(src)
  if (!core) return []
  const coreText = src.slice(core.start, core.end)
  const lines = coreText.split('\n')
  const headIdx = lines.findIndex((l) => new RegExp(`^${NOTE_LEVEL}\\s*${escapeRe(NOTE_TITLE)}`).test(l))
  if (headIdx < 0) return []
  const out = []
  for (let i = headIdx + 1; i < lines.length; i++) {
    // ⚠️ `^##(?!#)` —— 只认二级标题，别把 `###` 子节当结束
    if (/^##(?!#)\s/.test(lines[i])) break
    const m = /^-\s*(?:\[([^\]]*)\]\s*)?(.*)$/.exec(lines[i].trim())
    if (m) out.push({ date: m[1] || '', text: m[2].trim() })
  }
  return out
}
