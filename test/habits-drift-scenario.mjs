/**
 * research/habits-drift-scenario.mjs —— 真实场景：说话方式会随偏好逐渐变吗？
 * 跑法：& "<node>" research/habits-drift-scenario.mjs
 *
 * 这不是单元测试，是一次**模拟对话**：
 * 按真实时间顺序往记忆里加偏好，观察每一轮「她收到的说话指令」变成什么样。
 * 用的都是你真实说过的那类话，日期是我编的，但机制是真的。
 *
 * 要回答的问题只有一个：
 *   「聊着聊着，她的说话方式会不会真的跟着我的偏好改？」
 */
import { extractHabits, habitsText, HabitStore, parseEntries } from '../lib/habits.mjs'
import { composeWithParams } from '../lib/persona-params.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'drift-'))
const habitStore = new HabitStore(join(dir, 'habits.json'))

/** 一天的毫秒。 */
const DAY = 86_400_000
const T0 = new Date('2026-10-01T20:00:00').getTime()
const at = (n) => T0 + n * DAY
const dstr = (n) => {
  const d = new Date(at(n))
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 往记忆里加一条偏好（模拟 save_memory / 反思写入的产物）。 */
const rows = []
let seq = 0
const remember = ({ day, text, section = '沟通风格', conf = '高', quote = '', evidence = '用户明说' }) => {
  const id = `P-SCEN${String(++seq).padStart(3, '0')}`
  rows.push(`- [${id}] [${section}] ${text}（${evidence} ｜ 置信度：${conf} ｜ ${dstr(day)}${quote ? ` ｜ 原话：「${quote}」` : ''}）`)
  return id
}
const prefsMd = () => [
  '# 习惯与喜好',
  '',
  '> 由插件维护，也可以手改。',
  '',
  '## 沟通风格',
  '',
  ...rows,
  '',
].join('\n')

/**
 * 这一轮她实际会收到什么。
 *
 * @param {number} day        第几天
 * @param {object} [opts]
 * @param {boolean} [opts.snap] 要不要往演化轨迹里记一笔（只有「顺着时间走」时才记）
 *
 * ⚠️ `snap` 这个开关是必要的：后面的回看断言会**重新计算**早期某一天，
 *    那时候记忆已经全是 20 天后的了 —— 算出来的当然是最终习惯。
 *    如果那次重算也写快照，历史轨迹会被覆盖成「第一天就有全部习惯」，全是假的。
 *    （2026-10-21 自测就是这么被自己骗到的。）
 */
const round = (day, { snap = true } = {}) => {
  const r = extractHabits({ prefs: prefsMd(), now: at(day) })
  const text = habitsText(r.habits, { max: 8 })
  const injected = composeWithParams({
    coreBlock: '你叫晓光，他叫枫。',
    params: { intimacy: '高', technical_tone: '放松口语' },
    habitText: text,
    moodText: '## 你现在的状态（外层人格）\n\n心情平静。',
  })
  if (snap) habitStore.snapshot(r.habits, { now: at(day) })
  return { habits: r.habits, text, injected, overridden: r.overridden, stats: r.stats }
}

const labels = (r) => r.habits.map((h) => h.label).join('/') || '（无）'

/* ══════════════════════════════════════════════════════════════ */

console.log('═══ 模拟一段 20 天的对话 ═══\n')

console.log('第 1 天｜他第一次说：先给结论')
{
  remember({ day: 0, text: '他要求回答先给结论再展开', quote: '先结论，后展开' })
  const r = round(0)
  console.log(`   习惯：${labels(r)}`)
  check('提炼出「先结论」', r.habits.some((h) => h.id === 'conclusion_first'), labels(r))
  check('注入里出现了这条要求', r.injected.includes('先给结论'), '')
  check(`统计：${r.stats.speechEntries} 条说话 / ${r.stats.taskEntries} 条任务`, r.stats.speechEntries === 1)
}

console.log('\n第 4 天｜他说「说人话，别像 AI」')
{
  remember({ day: 3, text: '他说回答说人话，别像AI一样', quote: '说人话' })
  const r = round(3)
  console.log(`   习惯：${labels(r)}`)
  check('多了「说人话」', r.habits.some((h) => h.id === 'plain_speech'), labels(r))
  check('「先结论」还在（不是替换）', r.habits.some((h) => h.id === 'conclusion_first'), labels(r))
  check('注入里两条都在', r.injected.includes('先给结论') && /口语|人话/.test(r.injected), '')
}

console.log('\n第 7 天｜他说日报要写成薄版')
{
  remember({ day: 6, text: '他要求日报写成薄版，每条一两行', section: '沟通风格', quote: '日报写成薄版：每条一两行' })
  const r = round(6)
  console.log(`   习惯：${labels(r)}`)
  check('提炼出「精简」', r.habits.some((h) => h.id === 'brevity'), labels(r))
  check('提炼出「汇报形状」', r.habits.some((h) => h.id === 'report_shape'), labels(r))
  check('三条并列，没有互相压', r.habits.length >= 3, String(r.habits.length))
}

console.log('\n第 10 天｜他说「别老问我在不在」')
{
  remember({ day: 9, text: '别老问我在不在，有事直接说', section: '雷区', quote: '别老问我在不在' })
  const r = round(9)
  console.log(`   习惯：${labels(r)}`)
  check('提炼出「少反问」', r.habits.some((h) => h.id === 'no_question'), labels(r))
  check('提炼出「直说」', r.habits.some((h) => h.id === 'direct'), labels(r))
}

console.log('\n第 14 天｜【改主意】他说以后要详细一点')
{
  const before = round(13)
  console.log(`   改之前：${labels(before)}`)
  const hadBrevity = before.habits.some((h) => h.id === 'brevity')
  check('改之前确实要求精简', hadBrevity, hadBrevity ? '有' : '没有')

  remember({ day: 13, text: '他改主意了，以后回答详细一点讲清楚', quote: '详细一点' })
  const after = round(13)
  console.log(`   改之后：${labels(after)}`)
  check('现在要求详细', after.habits.some((h) => h.id === 'detail'), labels(after))
  check('不再要求精简（被同组压掉）', !after.habits.some((h) => h.id === 'brevity'), labels(after))
  check('记录了压掉谁', after.overridden.some((o) => o.id === 'brevity'), JSON.stringify(after.overridden.map((o) => `${o.id}→${o.lostTo}`)))
  check('注入文本跟着反过来', /详细|展开/.test(after.injected) && !/一两行|别写长/.test(after.injected), '')
  check('其他习惯没被误伤', after.habits.some((h) => h.id === 'plain_speech') && after.habits.some((h) => h.id === 'no_question'), labels(after))
}

console.log('\n第 20 天｜他说「别用 emoji」')
{
  remember({ day: 19, text: '他说回复别用 emoji', quote: '别用emoji' })
  const r = round(19)
  console.log(`   习惯：${labels(r)}`)
  check('提炼出「别用表情」', r.habits.some((h) => h.id === 'no_emoji'), labels(r))
}

console.log('\n─── 最终注入给她的那段（就是她真正看到的东西）───\n')
{
  const r = round(20)
  const start = r.injected.indexOf('### 他希望你这么说话')
  const end = r.injected.indexOf('**')
  console.log(r.injected.slice(start, start + 900))
  console.log('\n─── 优先级说明 ───')
  console.log(r.injected.slice(r.injected.lastIndexOf('**') - 20).slice(0, 500))
}

console.log('\n═══ 关键断言 ═══\n')

console.log('[1] 说话方式确实随记忆在变')
{
  /**
   * ⚠️ 早期状态要**重放**：只拿第 1 天那条记忆去算。
   *    直接调 round(0) 会用「20 天后的全部记忆 + 第 0 天的时间戳」，
   *    结果当然是最终习惯 —— 这是这个场景最容易写错的地方
   *    （我自己就写错过一次）。
   */
  const firstRowOnly = ['# 习惯与喜好', '', '## 沟通风格', '', rows[0], ''].join('\n')
  const early = extractHabits({ prefs: firstRowOnly, now: at(0) }).habits.map((h) => h.id)
  const late = round(20, { snap: false }).habits.map((h) => h.id)
  check('第 1 天只有 1 条习惯', early.length === 1, early.join(','))
  check('第 20 天有 5 条以上', late.length >= 5, late.join(','))
  check('第 20 天多了早期没有的', late.some((x) => !early.includes(x)), late.filter((x) => !early.includes(x)).join(','))
  check('早期的「先结论」一直在', late.includes('conclusion_first'), late.join(','))
}

console.log('\n[2] 注入文本每一轮都比上一轮更贴近他')
{
  /** 逐天重放：只取那天及之前记下的偏好，算出**当时**的注入文本。 */
  const days = [0, 3, 6, 9, 13, 19]
  const texts = days.map((d) => {
    const upto = rows.filter((row) => {
      const m = /(\d{4})-(\d{2})-(\d{2})/.exec(row)
      if (!m) return false
      return Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00`) <= at(d) + 12 * 3600_000
    })
    const md = ['# 习惯与喜好', '', '## 沟通风格', '', ...upto, ''].join('\n')
    return habitsText(extractHabits({ prefs: md, now: at(d) }).habits, { max: 8 })
  })
  check('6 个时间点，文本都在变', new Set(texts).size >= 5, `${new Set(texts).size} 种`)
  check('注入文本整体在涨（要求越来越多）', texts[texts.length - 1].length > texts[0].length,
    `${texts[0].length} → ${texts[texts.length - 1].length}`)
  check('最后一条包含了「别用表情」', texts[texts.length - 1].includes('emoji') || texts[texts.length - 1].includes('表情'), '')
}

console.log('\n[3] 演化轨迹（drift）能看出每天怎么变的')
{
  const d = habitStore.drift()
  check('记录了多天', d.length >= 5, String(d.length))
  check('每天都有 added 或 removed 字段', d.every((x) => Array.isArray(x.added) && Array.isArray(x.removed)))
  const changedDays = d.filter((x) => x.added.length || x.removed.length)
  check('至少有几天真的变了', changedDays.length >= 3, String(changedDays.length))
  console.log('\n   逐日轨迹：')
  for (const row of d) {
    const bits = []
    if (row.added.length) bits.push(`+${row.added.join('+')}`)
    if (row.removed.length) bits.push(`−${row.removed.join('−')}`)
    console.log(`     ${row.day}  ${bits.join(' ') || '（无变化）'}   现在：${row.habits.join('/') || '（空）'}`)
  }
}

console.log('\n[4] 说话方式变了，但底线没变')
{
  const r = round(20, { snap: false })
  check('核心人格还在', r.injected.includes('你叫晓光'))
  check('参数层还在', r.injected.includes('按你的设定调整') || r.injected.includes('亲昵'))
  /**
   * ⚠️ 不能直接搜「少给信息」这个词 —— 注入里那句「不许少给信息」本身就含它。
   *    要验的是「没有**允许**她少给信息」的句子，所以得带着否定词一起看。
   */
  check('没有允许她少给信息', !/(可以|允许|不用)(少给|省略)(信息|内容)/.test(r.injected), '')
  check('没有允许她放弃诚实', !/(可以|允许|不用)(骗|编|撒)/.test(r.injected), '')
  check('明确写了「不许因为状态少给信息」', /不许.*少给信息/.test(r.injected), '')
  check('明确写了「风格不是底线」', /不是底线|一条不少/.test(r.injected))
}

console.log('\n[5] 任务型记忆没有污染说话方式')
{
  const all = parseEntries(prefsMd())
  const r = extractHabits({ prefs: prefsMd(), now: at(20) })
  /**
   * 这 20 天记了 6 条记忆（「日报薄版」那一条同时产出「精简」和「汇报形状」两个维度）：
   *   先结论 / 说人话 / 日报薄版 / 别老问 / 详细 / 别用emoji
   */
  check('这 20 天一共记了 6 条', all.length === 6, String(all.length))
  check('全部被认成说话方式（这一轮故意都是）', r.stats.speechEntries === 6, String(r.stats.speechEntries))
  check('一条能产出多个维度', r.habits.length >= all.length, `${all.length} 条记忆 → ${r.habits.length} 条习惯`)

  // 混入一条功能需求：不该影响说话方式
  const withTask = prefsMd() + '\n- [P-TASK1] [沟通风格] 他要求给插件加一个导出工具（用户明说 ｜ 置信度：高 ｜ ' + dstr(19) + '）\n'
  const r2 = extractHabits({ prefs: withTask, now: at(20) })
  check('功能需求被算成任务', r2.stats.taskEntries === 1, String(r2.stats.taskEntries))
  check('习惯条数没变', r2.habits.length === r.habits.length, `${r.habits.length} → ${r2.habits.length}`)
  check('任务条目数对', r2.stats.entries === 7, String(r2.stats.entries))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
