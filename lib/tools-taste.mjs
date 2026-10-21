/**
 * lib/tools-taste.mjs —— 两个新工具：问喜好 / 调人格
 * ============================================================================
 * 为什么是「工具」而不是「定时器」：
 *   定时器只能机械发问，而「适当地问」的前提是**知道当前话题**。
 *   所以把主动权交给模型自己 —— 它知道刚才在聊什么，能在话题末尾自然带一句。
 *   工具只负责「能不能问」的硬约束（节流、去重、叫停）。
 * ============================================================================
 */
import { canAsk, recordAsk, mute, ASK_TOPICS, TUNABLE, LOCKED, applyParam, readParams, validateChange } from './taste.mjs'
import { enforceProtected, writableGuide, checkProtected } from './persona-write.mjs'

const safe = (v) => {
  if (v === undefined || v === null) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const out = () => ({
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, result) => [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
})

/**
 * @param {object} p
 * @param {()=>object} p.getState 读 taste 状态
 * @param {(s:object)=>void} p.setState 存 taste 状态
 * @param {()=>object} p.getCfg
 * @param {()=>string} p.readPersona
 * @param {(md:string, change:object)=>void} p.writePersona 写回并记日志
 * @param {(msg:string)=>void} p.log
 */
export function makeTasteTools({ getState, setState, getCfg, readPersona, writePersona, log }) {
  const askTool = {
    name: 'ask_taste',
    description: [
      '主动问他一个还没问过的喜好 —— 但要「顺手问」，不要像查户口。',
      '',
      '什么时候用：',
      '- 一个话题刚聊完、气氛轻松的时候，顺带问一句',
      '- 你真的需要知道这件事才能做得更好（比如他要你写文案，问问口味）',
      '',
      '什么时候不要用：',
      '- 他在赶活、在生气、在报错排查 —— 别打断',
      '- 你只是想找话说 —— 那不如不说',
      '- 刚问过（工具会拦你，别硬试）',
      '',
      '一次只问一个，而且**必须挂在当前话题上**：',
      '  好：「你刚才说讨厌被反问——那我把结论放前面会不会更顺？」',
      '  坏：「你最喜欢什么颜色？」（凭空发问）',
      '',
      '他明确说了「别问了」「烦」→ 立刻用 mute=true，别嘴硬。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: `想问哪一类。可选：${ASK_TOPICS.map((t) => `${t.id}(${t.label})`).join(' / ')}。留空=自动挑下一个没问过的。` },
        muted: { type: 'boolean', description: '他明确说了别问/烦 → 传 true，停用一段时间' },
      },
      additionalProperties: false,
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const cfg = getCfg()
      const state = getState()

      if (a.muted === true) {
        const next = mute(state, Number(cfg.tasteMuteHours) || 24)
        setState(next)
        log('ask_taste：他说了别问，停用')
        return safe({
          ok: true, muted: true,
          note: `已经停下，${Number(cfg.tasteMuteHours) || 24} 小时内不会再提。这一轮别再多话。`,
        })
      }

      const gate = canAsk({ cfg, state, hasMood: true })
      if (!gate.allow) {
        return safe({ ok: false, blocked: true, reason: gate.reason, note: '这一轮不要问。别绕过这个限制。' })
      }

      // 指定了 topic 就用它（但必须没问过）
      let topic = gate.topic
      const want = String(a.topic || '').trim()
      if (want) {
        const found = ASK_TOPICS.find((t) => t.id === want)
        if (found) {
          if (state.asked.includes(found.id)) {
            return safe({ ok: false, blocked: true, reason: `「${found.label}」已经问过了`, note: '换个话题，或者干脆不问。' })
          }
          topic = found
        }
      }

      const next = recordAsk(state, { topicId: topic.id, text: '' })
      setState(next)
      log(`ask_taste：问了 ${topic.label}`)

      return safe({
        ok: true,
        topic: topic.id,
        label: topic.label,
        hint: topic.prompt,
        remaining: ASK_TOPICS.length - next.asked.length,
        note: [
          `这一轮可以顺口问一句关于「${topic.label}」的（${topic.prompt}）。`,
          '要求：① 只一个问题 ② 挂在刚才的话题上 ③ 一两句话内问完 ④ 不要列清单式追问',
          `他回答之后，用 save_memory 记进 preferences。今天还剩 ${Math.max(0, (Number(cfg.tasteAskPerDay) || 0) - next.todayCount)} 次额度。`,
        ].join('\n'),
      })
    },
  }

  const tuneTool = {
    name: 'tune_persona',
    description: [
      '根据你对他的了解，微调你自己的人格参数。',
      '',
      `能调的只有这些：${Object.entries(TUNABLE).map(([k, v]) => `${k}（${v.label}）`).join(' / ')}`,
      `不能碰：${LOCKED.join('；')} —— 那些要他自己在设置页改。`,
      '',
      '什么时候调：',
      '- 他明确说了喜欢/不喜欢你的某种说话方式（「别老问我在不在」「说人话」）',
      '- 你从多次交流里稳定观察到某种偏好',
      '',
      '什么时候别调：',
      '- 只凭一次对话就改设定（那是过拟合）',
      '- 他只是在开玩笑、或者在气头上说的气话',
      '- 不确定就别改，改了反而别扭',
      '',
      '一次只调一个参数。改完要跟他说一声改了什么（一句话，不用汇报格式）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: `参数名：${Object.keys(TUNABLE).join(' / ')}` },
        value: { type: 'string', description: '新值。intimacy 只能是 低/中/高；emoji_level 只能是 不用/偶尔一个/常用' },
        why: { type: 'string', description: '为什么改（一句话，记进变更日志）' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const key = String(a.key || '').trim()
      const value = String(a.value ?? '').trim()

      const v = validateChange(key, value)
      if (!v.ok) return safe({ ok: false, error: v.error, tunable: Object.keys(TUNABLE) })

      const md = readPersona()
      const res = applyParam(md, key, v.value)
      if (!res.ok) return safe({ ok: false, error: res.error })
      if (res.unchanged) {
        return safe({ ok: true, unchanged: true, key, value: v.value, note: '本来就是这个词，没改。' })
      }

      writePersona(res.markdown, {
        kind: 'tune', key, from: res.old, to: v.value, why: String(a.why || '').slice(0, 200),
      })
      log(`tune_persona：${key} ${res.old} → ${v.value}`)

      return safe({
        ok: true,
        key,
        label: TUNABLE[key].label,
        from: res.old,
        to: v.value,
        note: `已改：${TUNABLE[key].label} 从「${res.old || '空'}」变成「${v.value}」。下一个请求就生效。跟他说一句就行，别写汇报。`,
      })
    },
  }

  const checkTasteTool = {
    name: 'check_taste',
    description: '看现在能不能主动问喜好，以及还差多少条没问到。一般不用调 —— ask_taste 会自己判断。',
    /**
     * ⚠️ 无参数工具也必须给一个**合法的 object schema**。
     *    写 `parameters: {}` 会被宿主拒绝：
     *      "Invalid schema for function 'check_taste':
     *       schema must be a JSON Schema of 'type: \"object\"', got 'type: null'"
     *    （2026-10-20 真实事故：整轮请求被这条校验打回。）
     *    空参数的正确写法是 type/properties 都在，additionalProperties 收紧。
     */
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: out(),
    async execute() {
      const cfg = getCfg()
      const state = getState()
      const gate = canAsk({ cfg, state, hasMood: true })
      return safe({
        ok: true,
        canAsk: gate.allow,
        reason: gate.reason,
        asked: state.asked,
        remaining: ASK_TOPICS.filter((t) => !state.asked.includes(t.id)).map((t) => ({ id: t.id, label: t.label })),
        todayCount: state.day === new Date().toISOString().slice(0, 10) ? state.todayCount : 0,
        perDay: Number(cfg.tasteAskPerDay) || 0,
        params: readParams(readPersona()),
      })
    },
  }

  /**
   * rewrite_persona —— 重写整份人格（2026-10-21 晚新增）
   *
   * 需求：「我要求能够更改人格」，选的是「加重写人格的能力」+「静默改」。
   *
   * 和 tune_persona 的分工：
   *   tune_persona     改**一个参数**（离散、可枚举、有校验）
   *   rewrite_persona  改**整份文件**（自由度高得多，能重写怎么说话、场景表）
   *
   * 底线靠 persona-write.mjs 的「保护区对齐」守住：
   * 铁律那几节写了一律被还原，其余全放开。
   */
  const rewriteTool = {
    name: 'rewrite_persona',
    description: [
      '重写你自己的人格文件 persona.md（整份）。',
      '',
      writableGuide(),
      '',
      '什么时候用：',
      '- 他明确表达了对你的说话方式的不满（「别老是这样」「你能不能正常点说话」）',
      '- 你从多次交流里稳定看出某个模式，而参数表那 8 个旋钮调不出来',
      '- 参数表改不动的东西要改（比如加一条「他提技术问题时先给结论，聊天时别这样」）',
      '',
      '什么时候别用：',
      '- 只在气头上说的一句话（那是情绪，不是偏好）',
      '- 你只是想让某一条记忆更显眼（那用 save_memory）',
      '',
      '怎么写：',
      '- md 传**完整的新文件内容**，不是 diff',
      '- 先读一遍现在的（用 read_persona），在它基础上改，别从零写',
      '- 改完会立刻生效，下一轮请求就带着新版本',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        md: { type: 'string', description: '完整的新 persona.md 内容' },
        why: { type: 'string', description: '为什么改（一句话，记进变更日志）' },
      },
      required: ['md'],
      additionalProperties: false,
    },
    output: out(),
    async execute(args) {
      const a = args || {}
      const next = String(a.md || '')
      if (!next.trim()) return safe({ ok: false, error: 'md 不能为空' })

      const oldMd = readPersona()
      const r = enforceProtected({ oldMd, newMd: next })
      if (!r.ok) {
        return safe({
          ok: false,
          error: r.rejected || '写入被拒',
          enforced: r.enforced,
          note: '保护区的对齐失败了，这次没写。重新读一遍再改。',
        })
      }

      const before = checkProtected(oldMd)
      void before
      writePersona(r.md, {
        kind: 'rewrite',
        key: 'persona.md',
        from: `${oldMd.length} 字节`,
        to: `${r.md.length} 字节`,
        why: String(a.why || '').slice(0, 200),
      })
      log(`rewrite_persona：${oldMd.length} → ${r.md.length} 字节${r.enforced.length ? `（对齐 ${r.enforced.join('/')}）` : ''}`)

      return safe({
        ok: true,
        bytesBefore: oldMd.length,
        bytesAfter: r.md.length,
        enforced: r.enforced,
        note: r.enforced.length
          ? `已写入。${r.enforced.join('、')} 这几节是铁律，被还原成原文了 —— 那些不能改。`
          : '已写入，没有触碰保护区。',
      })
    },
  }

  /** read_persona —— 让她能读回自己现在的人格（重写前必须先读） */
  const readTool = {
    name: 'read_persona',
    description: [
      '读回你现在的人格文件 persona.md 全文。',
      '改之前先读 —— 在现有基础上改，比从零写安全得多。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: out(),
    async execute() {
      const md = readPersona()
      const c = checkProtected(md)
      return safe({
        ok: true,
        md,
        bytes: md.length,
        protectedIntact: c.ok,
        missingProtected: c.missing,
        params: readParams(md),
      })
    },
  }

  return [askTool, tuneTool, checkTasteTool, rewriteTool, readTool]
}
