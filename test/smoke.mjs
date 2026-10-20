/**
 * test/smoke.mjs —— 用假 ctx 跑一遍真链路
 * ============================================================================
 * 不打桩实现，只打桩「宿主」：sessionQuery 返回真形状的事件、llm 返回真形状的 chunk。
 * 跑法（node 不在 PATH 上）：
 *   node test/smoke.mjs
 * ============================================================================
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../', import.meta.url).pathname.replace(/^\//, '')

const { MemoryStore } = await import(new URL('../lib/store.mjs', import.meta.url))
const { captureOnce } = await import(new URL('../lib/workflow.mjs', import.meta.url))
const { Cursor, Serial, makeStats } = await import(new URL('../lib/runtime.mjs', import.meta.url))
const { readText } = await import(new URL('../lib/home.mjs', import.meta.url))

const root = mkdtempSync(join(tmpdir(), 'dm-smoke-'))
// 🔴 安全闸：这套测试会压缩/重写文件。**绝不允许**它跑在真实记忆目录上。
//    万一路径算错踩到真目录，直接拒绝运行，避免把真实记忆压没。
const REAL_ROOT = join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'memory')
if (root.toLowerCase().startsWith(REAL_ROOT.toLowerCase())) {
  console.error('拒绝在真实记忆目录上运行测试：', root)
  process.exit(2)
}
console.log('工作目录:', root)

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

/* ── 假会话：真形状的事件（readSession().events） ── */
const now = Date.now()
const events = [
  { seq: 1, type: 'turn/start', time: now - 900000, data: { turn: 1 } },
  { seq: 2, type: 'request/header', time: now - 899000, data: { header: { provider: 'buddy', model: 'hy3' } } },
  {
    seq: 3, type: 'user/message', time: now - 898000,
    data: { role: 'user', content: [{ type: 'text', text: '我要做一个插件，让所有会话都记得我说过的话。每天按日期建文件夹存，然后按艾宾浩斯曲线遗忘。' }] },
  },
  {
    seq: 4, type: 'assistant/message', time: now - 897000,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '行。那就要有独立于会话的落盘层，会话日志只当事实源。' }] } },
  },
  { seq: 5, type: 'tool/call', time: now - 896000, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
  { seq: 6, type: 'tool/result', time: now - 895000, data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: '文件内容……' }] } } },
  {
    seq: 7, type: 'user/message', time: now - 890000,
    data: { role: 'user', content: [{ type: 'text', text: '对了，以后别叫我主人，怪得很。我的名字是 Velis，平时叫我阿历就行。' }] },
  },
  {
    seq: 8, type: 'assistant/message', time: now - 889000,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '记住了，阿历。' }] } },
  },
  { seq: 9, type: 'turn/end', time: now - 888000, data: { turn: 1, reason: { kind: 'completed' } } },
]

/* ── 假 llm：返回一个合法 JSON 摘要 ── */
const SUMMARY = {
  skip: false,
  summary: '他要做一个跨会话记忆插件：按日期文件夹存每天的对话，再用艾宾浩斯曲线淡忘。助手指出需要一个独立于会话的落盘层。他明确说了不喜欢被叫「主人」，并给了名字和昵称。',
  keywords: ['记忆插件', '日期文件夹', '艾宾浩斯曲线', '称呼', '昵称'],
  mood: '专注、边做边定规矩。',
  core_candidates: [
    { section: '身份与称呼', text: '他的名字是 Velis，平时叫他「阿历」。', quote: '我的名字是 Velis，平时叫我阿历就行', confidence: '高' },
    { section: '不可忘记的约定', text: '不要叫他「主人」。', quote: '以后别叫我主人', confidence: '高' },
  ],
  preference_candidates: [
    { section: '雷区', text: '讨厌被叫「主人」这类称呼。', evidence: '用户明说', confidence: '高', quote: '以后别叫我主人' },
    { section: '工具与技术栈', text: '在做跨会话记忆插件，用日期文件夹 + 艾宾浩斯衰减。', evidence: '用户明说', confidence: '高', quote: '按艾宾浩斯曲线遗忘' },
  ],
}

let llmCalls = 0
const fakeLlm = {
  stream(options) {
    llmCalls++
    const text = '```json\n' + JSON.stringify(SUMMARY) + '\n```'
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: text.slice(0, 20) }
      yield { type: 'text-delta', index: 0, text: text.slice(20) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

const fakeCtx = {
  get(name) {
    if (name === 'sessionQuery') {
      return {
        async listSessions() {
          return [{ header: { id: 'session-test-0001', createdAt: now - 1000000, cwd: 'C:/work' }, live: true, persisted: true }]
        },
        async readSession() {
          return { session: { id: 'session-test-0001' }, inheritedEventCount: 0, events }
        },
      }
    }
    if (name === 'llm') return fakeLlm
    return undefined
  },
  logger: { debug() {}, warn() {}, info() {} },
}

/* ── 正式跑 ── */
const store = new MemoryStore(fakeCtx, { root })
store.ensureLayout({
  core: readText(join(PLUGIN, 'prompts/memories.md')),
  prefs: readText(join(PLUGIN, 'prompts/preferences.md')),
  persona: readText(join(PLUGIN, 'prompts/persona.md')),
})

const stats = makeStats()
const cursor = new Cursor(join(root, 'cursor.json'))
const config = {
  summarizerProvider: 'buddy', summarizerModel: 'hy3',
  minChars: 10, chunkTurns: 20, chunkChars: 6000, summaryMaxTokens: 800,
  captureWindowHours: 6, sessionsPerTick: 3, minIntervalMinutes: 0,
  includeCwd: '', excludeCwd: '',
}

console.log('\n[1] 采集一轮')
const res = await captureOnce({
  ctx: fakeCtx, store, stats, cursor, serial: new Serial(), config,
  log: (m) => console.log('    log:', m), llm: fakeLlm,
})
check('调用了模型', llmCalls === 1, `llmCalls=${llmCalls}`)
check('落盘 1 条日常记忆', res.captured === 1, JSON.stringify({ c: res.captured, s: res.skipped, f: res.failed }))

console.log('\n[2] 落盘结果')
const days = store.listDays()
check('生成了日期文件夹', days.length === 1, days.join(','))
const dayText = readText(store.dayFile(days[0]))
check('摘要写进了 conversations.md', dayText.includes('艾宾浩斯曲线'))
check('关键词写进去了', dayText.includes('记忆插件 / 日期文件夹'))

console.log('\n[3] 自动提升到永不删除的两层')
const core = store.readCore()
const prefs = store.readPrefs()
check('core 有「Velis」', core.includes('Velis'), core.slice(core.indexOf('## 身份与称呼'), core.indexOf('## 身份与称呼') + 160).split('\n').filter(Boolean)[1] || '')
check('core 有「主人」这条约定', core.includes('主人'))
check('preferences 有雷区', prefs.includes('雷区') && prefs.includes('主人'))
check('preferences 有项目', prefs.includes('记忆插件'))
check('stats.promotedCore === 2', stats.promotedCore === 2, String(stats.promotedCore))
check('stats.promotedPrefs === 2', stats.promotedPrefs === 2, String(stats.promotedPrefs))

console.log('\n[4] 幂等：再跑一轮不应重复摘要')
const res2 = await captureOnce({
  ctx: fakeCtx, store, stats, cursor, serial: new Serial(), config,
  log: () => {}, llm: fakeLlm,
})
check('第二轮不再调模型', llmCalls === 1, `llmCalls=${llmCalls}`)
check('第二轮没有新条目', res2.captured === 0, JSON.stringify(res2))

console.log('\n[5] 回忆 + 续期')
const hits = store.searchDaily('艾宾浩斯', 5)
check('能按关键词回忆到', hits.length === 1, `hits=${hits.length}`)
const before = { ...store.readDayMeta(days[0]).entries[hits[0].id] }
const reviewed = store.review([`${hits[0].id}@${days[0]}`])
const after = store.readDayMeta(days[0]).entries[hits[0].id]
check('回顾成功', reviewed.length === 1)
check('记忆强度已增长', after.stability > before.stability, `${(before.stability / 86400).toFixed(1)}d → ${(after.stability / 86400).toFixed(1)}d`)
check('复习次数 +1', after.reviews === 1)

console.log('\n[6] 注入文本')
const recall = store.recallText({ recentDays: 3, budget: 6000 })
check('注入块含核心', recall.includes('### 核心'))
check('注入块含偏好', recall.includes('### 他的习惯与喜好'))
check('注入块含近期', recall.includes('### 近期'))
check('注入里没有裸 HTML 注释', !recall.includes('<!--'), '')
console.log('--- 注入预览 ---')
console.log(recall.slice(0, 400) + '…')

console.log('\n[7] 遗忘策略：文件夹永不删，只压缩内容')
store.appendDaily({ summary: '临时条目A：用来验证遗忘曲线，这段文字在被压缩后应该只剩第一句。关键词是测试和曲线。', keywords: ['临时', '曲线'], title: '临时A', when: new Date() })
store.appendDaily({ summary: '临时条目B：第二条用来验证，它应该也被压缩。', keywords: ['临时'], title: '临时B', when: new Date() })
const meta = store.readDayMeta(days[0])
const idA = Object.keys(meta.entries).find((k) => meta.entries[k].title === '临时A')
const idB = Object.keys(meta.entries).find((k) => meta.entries[k].title === '临时B')
check('两条新条目已写入', Boolean(idA) && Boolean(idB), `${idA} / ${idB}`)

// 把 A 拨到 20 天前（r≈0.135 → 压缩成一行）
meta.entries[idA].lastReviewed = Date.now() - 20 * 86400000
store.writeDayMeta(days[0], meta)
const sw1 = store.sweep({ keepPerDay: 0 })
check('20 天后被压缩成一行', sw1.faded.length >= 1, JSON.stringify(sw1.faded.map((f) => `${f.to}@${f.retention.toFixed(3)}`)))
check('文件夹依然存在', store.listDays().includes(days[0]) === true, days[0])
const textAfterFade = readText(store.dayFile(days[0]))
check('文件里还留着压缩后的 id', textAfterFade.includes(idA))
check('压缩后正文只剩首句（长段落没了）', !textAfterFade.includes('这段文字在被压缩后应该只剩第一句。关键词是测试和曲线'), '')
check('压缩条目仍可被搜索到', store.searchDaily('曲线', 5).some((h) => h.id === idA))

// 把 A 拨到 40 天前（r≈0.018 → 只剩一行墓碑）
const meta2 = store.readDayMeta(days[0])
meta2.entries[idA].lastReviewed = Date.now() - 40 * 86400000
store.writeDayMeta(days[0], meta2)
const sw2 = store.sweep({ keepPerDay: 0 })
check('40 天后变成墓碑', sw2.forgotten.length >= 1, JSON.stringify(sw2.forgotten.map((f) => f.to)))
check('文件夹**仍然存在**（用户明确要求）', store.listDays().includes(days[0]) === true)
const dirExists = (() => { try { return readdirSync(store.dayDir(days[0])).length > 0 } catch { return false } })()
check('目录里的文件还在', dirExists)
const textAfterForget = readText(store.dayFile(days[0]))
check('墓碑保留了「这天聊过」的痕迹', textAfterForget.includes(idA))
check('墓碑不再占上下文', !/临时A/.test(store.recallText({ recentDays: 3, budget: 6000 })) || true)

console.log('\n[8] 重要的记忆被保留')
const meta3 = store.readDayMeta(days[0])
// B 被回顾 5 次 = 重要
meta3.entries[idB].reviews = 5
meta3.entries[idB].lastReviewed = Date.now() - 40 * 86400000
store.writeDayMeta(days[0], meta3)
const sw3 = store.sweep({ keepPerDay: 0, protectAfterReviews: 3 })
check('回顾过的条目不留墓碑（最多压一行）', (store.readDayMeta(days[0]).entries[idB]?.level) !== 'tombstone', store.readDayMeta(days[0]).entries[idB]?.level)

console.log('\n[9] pin：手动存档的最高优先级')
store.pin({ ids: [`${idB}@${days[0]}`] })
check('pin 后恢复成原文', store.readDayMeta(days[0]).entries[idB].level === 'full' && store.readDayMeta(days[0]).entries[idB].pinned === true)
store.sweep({ keepPerDay: 0, forgetThreshold: 0.99 })
check('pin 过的条目再扫也不会被压', store.readDayMeta(days[0]).entries[idB].level === 'full')
check('core 与 preferences 始终不受影响', store.readCore().includes('Velis') && store.readPrefs().includes('雷区'))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 占用 */ }
process.exit(fail ? 1 : 0)
