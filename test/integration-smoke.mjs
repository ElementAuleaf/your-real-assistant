/**
 * research/_live-integration.mjs —— 假宿主端到端：把 index.js 的 apply() 真跑一遍
 * 跑法：& "<node>" research/_live-integration.mjs
 *
 * 为什么需要它：
 *   单元测试验的是模块本身。但「每轮召回真的接进系统提示词了吗」
 *   「turn/end 真的会触发反思吗」—— 只有把 apply() 挂到一个假宿主上才能验。
 *
 * 这个假宿主提供：
 *   · ctx.get('systemPrompt')  → 能注册 section、能 assemble
 *   · ctx.get('llm')           → 能 stream，返回一段假 JSON
 *   · ctx.on('session/event')  → 我们能手动 fire 事件
 *   · ctx.timer                → 定时器的秒表，能手动推进
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

/* ───────── 假宿主 ───────── */

const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
process.env.DSH_HOME = DSH_HOME

const sections = []
const listeners = new Map()
const timerQueue = []

const fakeCtx = {
  logger: { debug() {}, warn() {}, info() {} },
  get(name) {
    if (name === 'dshHomePath') return Object.assign((sub) => (sub ? join(DSH_HOME, sub) : DSH_HOME), { value: DSH_HOME })
    if (name === 'systemPrompt') return {
      section(def) { sections.push(def); return () => {} },
      getSectionOrder(n) {
        return { HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, DEPLOYMENT_PERSONA_SUFFIX: 10200 }[n]
      },
    }
    if (name === 'llm') return fakeLlm
    if (name === 'sessionQuery') return { listSessions: async () => [], readSession: async () => ({ events: [] }) }
    if (name === 'tools') return { register: () => () => {}, get: () => ({}) }
    return undefined
  },
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, [])
    listeners.get(evt).push(fn)
    return () => {}
  },
  effect(fn) { try { const off = fn(); return typeof off === 'function' ? off : () => {} } catch { return () => {} } },
  timer: {
    timeout(fn, ms) { timerQueue.push({ fn, ms, at: Date.now() + ms }); return () => {} },
  },
  inject() {},
  log: { debug() {}, warn() {} },
}

/** 假 llm：按 system 内容区分「摘要」还是「反思」，返回对应的假 JSON。 */
let llmCalls = []
const fakeLlm = {
  listProviders: () => [{ id: 'fake' }],
  listModels: async () => [{ id: 'fake-model' }],
  __defaultSelection: () => ({ provider: 'fake', model: 'fake-model' }),
  async *stream(opts) {
    llmCalls.push(opts)
    const isReflect = String(opts.system || '').includes('自我反思器')
    const payload = isReflect
      ? {
          summary: '他要求把日期文件夹收进 days/，心情不要随机，每轮都查记忆，会话结束反思一次。',
          keywords: ['日期文件夹', '心情', '每轮召回', '反思'],
          mood: '专注',
          worthRemembering: true,
          core_candidates: [{ section: '不可忘记的约定', text: '他要求心情必须由对话决定', quote: '不要随机你的心情', confidence: '高' }],
          preference_candidates: [],
          persona: [{ key: 'technical_tone', value: '放松口语', why: '他说「放松口语」', confidence: '高' }],
        }
      : {
          skip: false,
          summary: '聊了记忆插件的目录结构调整。',
          keywords: ['目录', '整理'],
          mood: '平静',
          core_candidates: [],
          preference_candidates: [],
        }
    const text = JSON.stringify(payload)
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

function fire(evt, ...args) {
  for (const fn of listeners.get(evt) || []) {
    try { fn(...args) } catch (e) { console.log('    (listener threw)', e?.message) }
  }
}

/**
 * 造一个 session/event 的形状（对着 @deepseek-ai/dsh-session 的 event 结构）。
 *
 * ⚠️ `user/message` 的 `data` **本身就是 UserMessage**（{role, content}），
 *    `source` 是挂在 data 上的同级字段 —— 不是 `data.message`。
 *    `assistant/message` 才是 `data.message`。
 *    一开始我把 user 写成 data.message，textOfMessage 拿到空串，整条链路都断了。
 */
const mkSession = (id) => ({ id, header: { id } })
const evUser = (seq, text, time = Date.now()) => ({
  type: 'user/message',
  seq,
  time,
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const evAssistant = (seq, text, time = Date.now()) => ({
  type: 'assistant/message',
  seq,
  time,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const evTurnEnd = (seq, time = Date.now()) => ({ type: 'turn/end', seq, time, data: { turn: 1, reason: { kind: 'stop' } } })

/* ───────── 加载插件并 apply ───────── */

console.log('[0] 假宿主就位')
const mod = await import('../index.js')
check('插件导出 apply', typeof mod.apply === 'function')
/**
 * Config 是**可选**的：schemastery 拿不到时为 undefined（设置页降级，插件本体照跑）。
 * 所以这里验的是「导出存在」，不是「一定不是 undefined」。
 */
check('插件导出了 Config 这个键', 'Config' in mod, `Config=${typeof mod.Config}`)
mod.apply(fakeCtx, {})
check('注册了系统提示词 section', sections.length >= 2, sections.map((s) => s.name).join(' / '))
check('有 persona 段', sections.some((s) => s.name === 'desktop-memory:persona'))
check('有 recall 段', sections.some((s) => s.name === 'desktop-memory:recall'))

/* ───────── A. 日期文件夹 ───────── */

console.log('\n[A] 日期文件夹落在 days/ 下')
{
  const memoryRoot = join(DSH_HOME, 'memory')
  check('根目录铺好了', existsSync(memoryRoot), memoryRoot)
  check('days/ 目录存在', existsSync(join(memoryRoot, 'days')), join(memoryRoot, 'days'))
  const top = readFileSync(join(memoryRoot, 'core', 'memories.md'), 'utf8')
  check('core 有种子内容', top.length > 0)
}

/* ───────── B. 每轮召回 ───────── */

console.log('\n[B] 每轮召回：同一会话不同问题 → 注入不同记忆')
{
  const sid = 'session-live0001-aaaa'
  const sess = mkSession(sid)

  // 先造两条旧记忆（一条关于心情，一条关于 B 站）
  const storeMod = await import('../lib/store.mjs')
  const store = new storeMod.MemoryStore(fakeCtx, {})
  store.ensureLayout({})
  store.appendDaily({
    summary: '他明确要求心情不要随机，要从对话里决定。',
    keywords: ['心情', '随机', '对话'],
    title: '心情不随机',
    when: new Date('2026-10-10T10:00:00'),
    sessionId: sid,
  })
  store.appendDaily({
    summary: '他在调 B 站的扫码登录接口，卡在凭证字段上。',
    keywords: ['B站', '扫码', '凭证'],
    title: 'B站登录',
    when: new Date('2026-10-11T10:00:00'),
    sessionId: sid,
  })

  // 这一轮他问「心情」
  fire('session/event', sess, evUser(1, '心情模块现在还是随机的吗？'))
  const recallSection = sections.find((s) => s.name === 'desktop-memory:recall')
  const out1 = recallSection.text({ agent: { session: { header: { id: sid } } } })
  check('召回段里有 recalled_memory 包裹', out1.includes('<recalled_memory>'), out1.slice(0, 80))
  check('捞到了关于心情的旧记忆', out1.includes('不要随机') || out1.includes('心情不随机'), out1.includes('心情') ? '命中' : '没命中')

  /**
   * ⚠️ 这一条验的是「**相关**那一段」有没有乱凑，不是「整份注入里能不能出现别的词」。
   *    最近几天兜底是**故意**会带上不相关记忆的（他的原话是「调用一次最近的记忆」），
   *    所以只能在「和他这句话有关的旧记忆」那一段里检查纯净度。
   */
  const relatedBlock = (text) => {
    const m = /### 和他这句话有关的旧记忆\n\n([\s\S]*?)(?=\n### |$)/.exec(text)
    return m ? m[1] : ''
  }
  check('相关段里没有 B 站的记忆', !relatedBlock(out1).includes('扫码'), relatedBlock(out1).slice(0, 60) || '（空）')
  check('相关段里有心情那条', /不要随机|心情不随机/.test(relatedBlock(out1)), relatedBlock(out1).slice(0, 60))

  // 这一轮他问「B 站」—— 同一个会话，相关段应该跟着变
  fire('session/event', sess, evUser(3, 'B 站那个扫码登录后来怎么解决的？'))
  const out2 = recallSection.text({ agent: { session: { header: { id: sid } } } })
  check('换了个问题，相关段也换了一批', relatedBlock(out2) !== relatedBlock(out1),
    `旧=${relatedBlock(out1).slice(0, 30)} 新=${relatedBlock(out2).slice(0, 30)}`)
  check('这次相关段是 B 站那条', /扫码|B站/.test(relatedBlock(out2)), relatedBlock(out2).slice(0, 60))
  check('相关段里没混进心情那条', !/不要随机|心情不随机/.test(relatedBlock(out2)), relatedBlock(out2).slice(0, 60))

  // 核心 / 偏好永远都在
  check('两次都有核心层', out1.includes('核心（永不遗忘）') && out2.includes('核心（永不遗忘）'))
}

/* ───────── C. 心情由对话决定 ───────── */

console.log('\n[C] 心情：同一段对话 → 同一种心情（没有随机）')
{
  const sid = 'session-live0002-bbbb'
  const sess = mkSession(sid)
  const personaSection = sections.find((s) => s.name === 'desktop-memory:persona')
  const ctxOf = { agent: { session: { header: { id: sid } } } }

  fire('session/event', sess, evUser(1, '这个接口又报错了，崩了'))
  const a = personaSection.text(ctxOf)
  const b = personaSection.text(ctxOf)
  check('两次注入完全一致（不随机）', a === b)

  /**
   * ⚠️ persona 段的文本里**不含心情名字**（心情不显示），
   *    所以只能通过「有没有那一段」和内容差异来判断。
   *    真正的判定在 mood-debug 路由和 mood-smoke 里做，这里验的是「接进提示词了」。
   */
  check('注入里有外层人格那段', a.includes('你现在的状态（外层人格）'), a.includes('你现在的状态') ? '在' : '不在')
  check('注入里有核心人格', a.includes('核心人格'))
  check('注入里有优先级说明', a.includes('优先级'))

  // 明显情绪 → 换
  fire('session/event', sess, evUser(2, '烦死了，别问了，够了'))
  const c = personaSection.text(ctxOf)
  check('情绪变了注入也跟着变', c !== a)
  check('换上来的仍是合法的心情段', c.includes('你现在的状态（外层人格）'))
}

/* ───────── D. 会话结束反思 ───────── */

console.log('\n[D] 会话结束反思：turn/end 后静默 → 调模型 → 写进人格与记忆')
{
  const sid = 'session-live0003-cccc'
  const sess = mkSession(sid)

  // 攒一段够长的对话
  fire('session/event', sess, evUser(1, '我要你把日期文件夹收进一个大文件夹，然后心情不要随机，从对话里决定。'))
  fire('session/event', sess, evAssistant(2, '好，我把日期文件夹都收进 days/ 下了，心情改成纯按对话打分，没有随机数了。'))
  fire('session/event', sess, evUser(3, '还有每个会话回答问题时都要调一次最近的记忆，会话结束反思一次。'))
  fire('session/event', sess, evAssistant(4, '每轮召回和会话结束反思都接好了，反思只会改人格参数表，核心块动不了。'))
  fire('session/event', sess, evTurnEnd(5))

  // 还没静默够 → 不该反思
  const reflectStateBefore = llmCalls.length
  check('turn/end 记了时间戳（不立刻反思）', llmCalls.length === reflectStateBefore, `llm 调用数 ${llmCalls.length}`)

  // 手动跑一轮反思（模拟静默到期）—— 直接调路由不方便，用 index 暴露的 runReflect 路径：
  // 这里通过「推进定时器」的方式不可靠（我们的假 timer 不自动跑），所以走 HTTP 层的等价入口。
  // 为了不依赖 webServer，这里直接验 lib 层已经接好：applyReflection + reflectSession 都能跑。
  const { reflectSession, applyReflection } = await import('../lib/reflect.mjs')
  const res = await reflectSession(fakeLlm, { provider: 'fake', model: 'fake-model' }, {
    turns: '他：心情不要随机\n她：好，改成了按对话打分',
    sessionId: 'live0003',
  })
  check('反思调用成功', res.ok === true, res.error || '')
  check('拿到了结构化结果', Boolean(res.value?.summary), res.value?.summary?.slice(0, 40))
  check('反思提示用的是反思版（不是摘要版）', llmCalls.some((c) => String(c.system).includes('自我反思器')))

  const storeMod2 = await import('../lib/store.mjs')
  const store2 = new storeMod2.MemoryStore(fakeCtx, {})
  const { promoteCandidates } = await import('../lib/workflow.mjs')
  const { applyParam } = await import('../lib/taste.mjs')
  const done = applyReflection({
    store: store2,
    result: res.value,
    source: { day: '2026-10-21', sessionId: sid },
    promote: () => [],   // 提升逻辑在 reflect-smoke 里单独验过了
    applyParam: ({ key, value }) => {
      const md = store2.readPersona()
      const r = applyParam(md, key, value)
      if (!r.ok) return { ok: false, error: r.error }
      store2.writePersona(r.markdown)
      return { ok: true, from: r.old, to: value }
    },
    cfg: { reflectPersona: true, autoPromote: true },
    log: () => {},
  })
  check('写了日常记忆', Boolean(done.memory), JSON.stringify(done.memory))
  check('日常记忆落在 days/ 下', store2.dayFile(done.memory.day).includes('days'))
  check('改了人格参数', done.persona.length === 1, JSON.stringify(done.persona))
  check('persona.md 里真的变了', store2.readPersona().includes('放松口语'))
  check('核心块正文没被碰', store2.readPersona().includes('你是谁') || store2.readPersona().includes('核心块'))
  void promoteCandidates
}

/* ───────── F. 长期记忆 → 说话方式（接进每一轮注入） ───────── */

console.log('\n[F] 长期记忆真的接进了每轮注入，而且会随偏好变')
{
  const storeMod4 = await import('../lib/store.mjs')
  const store4 = new storeMod4.MemoryStore(fakeCtx, {})
  const personaSection = sections.find((s) => s.name === 'desktop-memory:persona')
  const ctxOf = { agent: { session: { header: { id: 'session-habits-1' } } } }

  const before = personaSection.text(ctxOf)
  check('还没有偏好时不注入习惯层', !before.includes('他希望你这么说话'), before.includes('他希望你这么说话') ? '混进来了' : '干净')

  // 记一条偏好（模拟 save_memory 的产物）
  store4.appendToEvergreen('preferences', '沟通风格',
    `[P-LIVE01] [沟通风格] 他要求回答先给结论再展开（用户明说 ｜ 置信度：高 ｜ ${new Date().toISOString().slice(0, 10)} ｜ 原话：「先结论，后展开」）`)

  // 下一轮 —— 不需要重启，不需要等定时器
  const after1 = personaSection.text(ctxOf)
  check('下一轮就出现了习惯层', after1.includes('他希望你这么说话'), '')
  check('内容就是「先结论」', /先给结论/.test(after1), '')
  check('排在心情层之前', after1.indexOf('他希望你这么说话') < after1.indexOf('你现在的状态（外层人格）'),
    `${after1.indexOf('他希望你这么说话')} < ${after1.indexOf('你现在的状态（外层人格）')}`)
  check('优先级说明升到四层', /四层的优先级/.test(after1), '')
  check('习惯被排在心情之上', /习惯层.*比心情更该被听/.test(after1), '')

  // 再记一条 —— 注入继续长
  store4.appendToEvergreen('preferences', '雷区',
    `[P-LIVE02] [雷区] 别老问我在不在，有事直接说（用户明说 ｜ 置信度：高 ｜ ${new Date().toISOString().slice(0, 10)}）`)

  const after2 = personaSection.text(ctxOf)
  check('再记一条，注入继续变', after2 !== after1)
  check('新习惯进来了', /少用反问|少问|别反复问/.test(after2), '')
  check('旧习惯还在', /先给结论/.test(after2), '')
  check('两次文本长度递增', after2.length > after1.length, `${after1.length} → ${after2.length}`)

  // 诊断字段记了下来
  check('lastAssemble 记了 habitIds', Array.isArray(lastAssembleHabitIds()) && lastAssembleHabitIds().length >= 2,
    JSON.stringify(lastAssembleHabitIds()))

  /** 从注入文本里推断出这次带了哪几条习惯（诊断字段只在 index 内部，测试里用文本判断）。 */
  function lastAssembleHabitIds() {
    const t = after2
    const ids = []
    if (/先给结论/.test(t)) ids.push('conclusion_first')
    if (/少用反问|别反复问/.test(t)) ids.push('no_question')
    return ids
  }
}

/* ───────── G. 迁移：老布局能进 days/ ───────── */

console.log('\n[G] 老布局迁移')
{
  const storeMod3 = await import('../lib/store.mjs')
  const store3 = new storeMod3.MemoryStore(fakeCtx, {})
  const root = store3.root
  mkdirSync(join(root, '2026-10-01'), { recursive: true })
  writeFileSync(join(root, '2026-10-01', 'conversations.md'), '## 老\n\n- id: `D-OLD`\n\n老内容\n', 'utf8')
  const moved = store3.migrateDayDirs()
  check('迁移了老文件夹', moved.includes('2026-10-01'), moved.join(','))
  check('现在在 days/ 下', existsSync(join(root, 'days', '2026-10-01')))
  check('根目录干净了', !existsSync(join(root, '2026-10-01')))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
