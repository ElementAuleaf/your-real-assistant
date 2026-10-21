/**
 * research/habits-smoke.mjs —— 长期记忆 → 说话习惯
 * 跑法：& "<node>" research/habits-smoke.mjs
 *
 * 需求（2026-10-21 晚，用户原话）：
 *   「增加长期记忆模块，并测试在对话过程中她的说话方式是否会
 *     根据记忆与我的偏好逐渐更改」
 *
 * 所以这个测试的重点不是「函数能跑」，而是**真的会变**：
 *   A. 提炼对不对（说话方式 vs 具体任务，不能混）
 *   B. 证据链（凭什么要求她这么说）
 *   C. 冲突时听新的（他改主意了，旧偏好要被压掉）
 *   D. **逐渐更改**：往记忆里加一条 → 注入文本真的跟着变
 *   E. 优先级：习惯层不许越过核心人格的铁律
 */
import {
  DIMENSIONS, parseEntryLine, parseEntries, looksLikeSpeech, dimensionsOf,
  extractHabits, habitsText, HabitStore, freshness, FRESHNESS_HALF_LIFE_DAYS,
} from '../lib/habits.mjs'
import { composeWithParams } from '../lib/persona-params.mjs'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const NOW = new Date('2026-10-21T20:00:00').getTime()
const day = (n) => {
  const d = new Date(NOW - n * 86_400_000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 造一行偏好（格式照着磁盘上的真实样子）。 */
const pref = (id, section, text, { conf = '高', daysAgo = 1, quote = '', evidence = '用户明说' } = {}) =>
  `- [${id}] [${section}] ${text}（${evidence} ｜ 置信度：${conf} ｜ ${day(daysAgo)}${quote ? ` ｜ 原话：「${quote}」` : ''}）`

const mkPrefs = (rows) => `# 习惯与喜好\n\n> 由插件维护\n\n## 沟通风格\n\n${rows.join('\n')}\n`

/* ══════════════ A. 解析 ══════════════ */

console.log('[A1] 解析真实格式的条目')
{
  const e = parseEntryLine(pref('P-AAA111', '沟通风格', '他要求回答先给结论', { conf: '高', daysAgo: 3, quote: '先给结论' }))
  check('拿到编号', e.id === 'P-AAA111', e.id)
  check('拿到小节', e.tag === '沟通风格', e.tag)
  check('正文不带元信息', e.text === '他要求回答先给结论', e.text)
  check('拿到置信度', e.confidence === '高', e.confidence)
  check('拿到日期', /^\d{4}-\d{2}-\d{2}$/.test(e.date), e.date)
  check('拿到原话', e.quote === '先给结论', e.quote)
  check('证据来源', e.evidence === '用户明说', e.evidence)

  // 第二种格式：编号后面是日期
  const e2 = parseEntryLine('- [C-BBB222] [2026-10-20] 他叫枫（来源：模型记录 ｜ 置信度：高）')
  check('日期式编号也能解析', e2.id === 'C-BBB222' && e2.text === '他叫枫', `${e2.id} / ${e2.text}`)

  check('非条目行返回 null', parseEntryLine('## 沟通风格') === null)
  check('空行返回 null', parseEntryLine('') === null)
}

console.log('\n[A2] 整份文件按小节切开')
{
  /**
   * ⚠️ 用**段落式** markdown 造数据，不要用 mkPrefs()。
   *    mkPrefs() 把所有行塞进同一个「## 沟通风格」小节 —— 它测的是「格式」，
   *    测不了「小节切换」。这里要验的正是小节切换，所以手写。
   */
  const md = [
    '# 习惯与喜好',
    '',
    '## 沟通风格',
    '',
    pref('P-1', '沟通风格', '他要求先说结论'),
    '',
    '## 雷区',
    '',
    pref('P-2', '雷区', '别老问我在不在'),
    '',
  ].join('\n')
  const es = parseEntries(md)
  check('取到 2 条', es.length === 2, String(es.length))
  check('小节名跟着条目走', es[0].section === '沟通风格' && es[1].section === '雷区',
    es.map((x) => `${x.id}@${x.section}`).join(' | '))
}

/* ══════════════ B. 分类：说话方式 vs 具体任务 ══════════════ */

console.log('\n[B1] 说话方式要认出来')
{
  const yes = [
    ['他不喜欢回答语气太严肃像ai，希望像女朋友正常说话', 'plain_speech'],
    ['他要求回答先给结论再展开', 'conclusion_first'],
    ['别老问我在不在', 'no_question'],
    ['他偏好回答按人格化而非工单式罗列', 'personalized'],
    ['他说别用emoji', 'no_emoji'],
    ['他要求报告写成清单每条一两行', 'report_shape'],
    ['有话说直接说，别绕弯子', 'direct'],
  ]
  for (const [t, wantDim] of yes) {
    const d = dimensionsOf(t)
    check(`认出「${t.slice(0, 14)}…」→ ${wantDim}`, d.includes(wantDim), d.join(',') || '没认出')
  }
}

console.log('\n[B2] 具体任务不能混进来（这是最容易做砸的地方）')
{
  const no = [
    '他要求AI在日常对话中主动问他的喜好并调整AI人格',   // 功能需求
    '他要求每个会话回答问题时都调用一次最近的记忆',       // 功能需求
    '他要求每10分钟自动写入记忆且不要手动存记忆',         // 功能需求
    '他指定判重表使用特定绝对路径且禁止写到家目录',       // 技术细节
    '他正在实现可主动问喜好且改人格的工具',               // 功能需求
    '他要求别用那个插件',                                 // 一次性决定
    '他要求不要修改他动过的README.md',                    // 一次性决定
  ]
  for (const t of no) {
    check(`挡住「${t.slice(0, 16)}…」`, dimensionsOf(t).length === 0, dimensionsOf(t).join(',') || '已挡住')
  }

  check('looksLikeSpeech 对功能需求返回 false', looksLikeSpeech('他要求给插件加一个工具') === false)
  check('looksLikeSpeech 对说话要求返回 true', looksLikeSpeech('别老问我在不在') === true)
}

console.log('\n[B3] 维度表本身没病')
{
  check('每个维度都有 id/label/group/re/instruction',
    DIMENSIONS.every((d) => d.id && d.label && d.group && d.re instanceof RegExp && d.instruction))
  check('id 不重复', new Set(DIMENSIONS.map((d) => d.id)).size === DIMENSIONS.length)
  /**
   * 单方分组是**允许**的：`structure`/`format` 这类只可能有一种说法
   * （「先结论」不存在反面），分组只是为了将来可能加反面时能直接互斥。
   * 所以这里验的是「有互斥组存在」，不是「每组都有两方」。
   */
  const groups = {}
  for (const d of DIMENSIONS) groups[d.group] = (groups[d.group] || 0) + 1
  check('存在多成员的互斥组', Object.values(groups).some((n) => n >= 2), JSON.stringify(groups))
  check('长度组有正反两面', groups.length === 2, String(groups.length))
  check('语气组有正反两面', groups.tone === 2, String(groups.tone))
  check('每条指令都讲「怎么说」不讲「做什么」',
    DIMENSIONS.every((d) => !/^实现|^写一个|^安装|^部署/.test(d.instruction)))
}

/* ══════════════ C. 提炼 ══════════════ */

console.log('\n[C1] 从偏好里提炼出习惯，带证据')
{
  const prefs = mkPrefs([
    pref('P-1', '沟通风格', '他要求回答先给结论再展开', { daysAgo: 2, quote: '先结论，后展开' }),
    pref('P-2', '沟通风格', '他不喜欢回答语气太严肃，希望口语一点', { daysAgo: 5, quote: '说人话' }),
    pref('P-3', '沟通风格', '他要求报告写成薄版每条一两行', { daysAgo: 1 }),
  ])
  const r = extractHabits({ prefs, now: NOW })
  const ids = r.habits.map((h) => h.id)
  check('提炼出 conclusion_first', ids.includes('conclusion_first'), ids.join(','))
  check('提炼出 plain_speech', ids.includes('plain_speech'), ids.join(','))
  check('提炼出 brevity', ids.includes('brevity'), ids.join(','))
  check('统计说得清', r.stats.speechEntries === 3 && r.stats.taskEntries === 0,
    `speech=${r.stats.speechEntries} task=${r.stats.taskEntries}`)

  const cf = r.habits.find((h) => h.id === 'conclusion_first')
  check('带支持数', cf.support === 1, String(cf.support))
  check('带最新日期', Boolean(cf.latest), cf.latest)
  check('带证据条目', cf.evidence.length >= 1 && cf.evidence[0].id === 'P-1', JSON.stringify(cf.evidence[0]))
  check('带原话', cf.quotes.includes('先结论，后展开'), cf.quotes.join('/'))
}

console.log('\n[C2] 多条支持同一件事 → 分更高')
{
  const one = extractHabits({ prefs: mkPrefs([pref('P-1', '沟通风格', '他要先给结论', { daysAgo: 2 })]), now: NOW })
  const two = extractHabits({
    prefs: mkPrefs([
      pref('P-1', '沟通风格', '他要先给结论', { daysAgo: 2 }),
      pref('P-2', '沟通风格', '他说结论放在前面再展开', { daysAgo: 3 }),
    ]),
    now: NOW,
  })
  const a = one.habits.find((h) => h.id === 'conclusion_first')
  const b = two.habits.find((h) => h.id === 'conclusion_first')
  check('两条支持 > 一条支持', b.score > a.score, `${a.score} → ${b.score}`)
  check('支持数对', b.support === 2, String(b.support))
}

console.log('\n[C3] 置信度与新近度参与计分')
{
  const hi = extractHabits({ prefs: mkPrefs([pref('P-1', '沟通风格', '他要先给结论', { conf: '高', daysAgo: 2 })]), now: NOW })
  const lo = extractHabits({ prefs: mkPrefs([pref('P-1', '沟通风格', '他要先给结论', { conf: '低', daysAgo: 2 })]), now: NOW })
  check('高置信 > 低置信', hi.habits[0].score > lo.habits[0].score, `${hi.habits[0].score} vs ${lo.habits[0].score}`)

  const fresh45 = freshness(day(0), NOW)
  const old45 = freshness(day(45), NOW)
  const old90 = freshness(day(90), NOW)
  check('今天的记忆系数 = 1', Math.abs(fresh45 - 1) < 0.01, fresh45.toFixed(3))
  check('45 天前减半', Math.abs(old45 - 0.5) < 0.02, old45.toFixed(3))
  check('90 天前再减半', Math.abs(old90 - 0.25) < 0.02, old90.toFixed(3))
  check('半衰期常量就是 45 天', FRESHNESS_HALF_LIFE_DAYS === 45)

  const newOne = extractHabits({ prefs: mkPrefs([pref('P-1', '沟通风格', '他要先给结论', { daysAgo: 1 })]), now: NOW })
  const oldOne = extractHabits({ prefs: mkPrefs([pref('P-1', '沟通风格', '他要先给结论', { daysAgo: 120 })]), now: NOW })
  check('新记忆分更高', newOne.habits[0].score > oldOne.habits[0].score,
    `${newOne.habits[0].score} vs ${oldOne.habits[0].score}`)
}

/* ══════════════ D. 冲突：他改主意了 ══════════════ */

console.log('\n[D1] 同一组互斥：分高的赢，旧的被压掉并留痕')
{
  // 先说「详细点」，后说「一两行就够」—— 后者更新更近
  const prefs = mkPrefs([
    pref('P-OLD', '沟通风格', '他要求回答详细一点，别省略', { daysAgo: 60 }),
    pref('P-NEW', '沟通风格', '他说以后一两行就够，别写长', { daysAgo: 1 }),
  ])
  const r = extractHabits({ prefs, now: NOW })
  const ids = r.habits.map((h) => h.id)
  check('精简赢了', ids.includes('brevity'), ids.join(','))
  check('详细被压掉（同一组只留一个）', !ids.includes('detail'), ids.join(','))
  check('被压的有记录', r.overridden.some((o) => o.id === 'detail' && o.lostTo === 'brevity'),
    JSON.stringify(r.overridden))
  check('被压的记录了分数', r.overridden[0].score > 0, String(r.overridden[0].score))
}

console.log('\n[D2] 反过来也一样（新的详细压掉旧的精简）')
{
  const prefs = mkPrefs([
    pref('P-OLD', '沟通风格', '他要求一两行就够，要薄版', { daysAgo: 60 }),
    pref('P-NEW', '沟通风格', '他说以后详细一点讲清楚', { daysAgo: 1 }),
  ])
  const ids = extractHabits({ prefs, now: NOW }).habits.map((h) => h.id)
  check('这次详细赢', ids.includes('detail') && !ids.includes('brevity'), ids.join(','))
}

console.log('\n[D3] 不同组之间不互相压')
{
  const prefs = mkPrefs([
    pref('P-1', '沟通风格', '他要先给结论'),
    pref('P-2', '沟通风格', '他说一两行就够'),
    pref('P-3', '沟通风格', '别用emoji'),
  ])
  const ids = extractHabits({ prefs, now: NOW }).habits.map((h) => h.id)
  check('结构组和长度组共存', ids.includes('conclusion_first') && ids.includes('brevity'), ids.join(','))
  check('emoji 组也在', ids.includes('no_emoji'), ids.join(','))
}

/* ══════════════ E. 注入文本 ══════════════ */

console.log('\n[E1] 注入文本说清了「这不是设定」和优先级')
{
  const t = habitsText(extractHabits({
    prefs: mkPrefs([pref('P-1', '沟通风格', '他要先给结论', { quote: '先结论' })]),
    now: NOW,
  }).habits)
  check('有标题', t.includes('他希望你这么说话'))
  check('说明来自长期记忆', /长期记忆/.test(t))
  check('写了「不是凭空加的设定」', /不是凭空|不是设定/.test(t))
  check('写了「风格不是底线」', /风格.*不是底线|不是底线/.test(t))
  check('写了诚实信息不减少', /诚实|信息.*一条.*不少/.test(t))
  check('有条目指令', t.includes('先给结论'))
}

console.log('\n[E2] 空习惯不产出噪音')
{
  check('空数组 → 空串', habitsText([]) === '')
  check('null → 空串', habitsText(null) === '')
  check('全是在讲任务的偏好 → 空串', habitsText(extractHabits({
    prefs: mkPrefs([pref('P-1', '沟通风格', '他要求给插件加一个工具')]),
    now: NOW,
  }).habits) === '')
}

console.log('\n[E3] max 生效，按分数排序')
{
  const prefs = mkPrefs([
    pref('P-1', '沟通风格', '他要先给结论', { daysAgo: 1 }),
    pref('P-2', '沟通风格', '他说一两行就够', { daysAgo: 20 }),
    pref('P-3', '雷区', '别用emoji', { daysAgo: 40 }),
    pref('P-4', '沟通风格', '别老问我在不在', { daysAgo: 30 }),
  ])
  const r = extractHabits({ prefs, now: NOW })
  const t = habitsText(r.habits, { max: 2 })
  const bullets = t.split('\n').filter((l) => l.startsWith('- **'))
  check('只输出 2 条', bullets.length === 2, String(bullets.length))
  check('第一条是分最高的', bullets[0].includes(r.habits[0].label), `${bullets[0]} vs ${r.habits[0].label}`)
  check('分数确实降序', r.habits.every((h, i, a) => i === 0 || a[i - 1].score >= h.score))
}

/* ══════════════ F. 「逐渐更改」—— 需求的核心 ══════════════ */

console.log('\n[F1] 往记忆里加一条 → 注入文本立刻跟着变（这就是「逐渐更改」）')
{
  const core = '# 核心块\n\n你叫晓光。'

  // 第 1 天：只有「先给结论」
  const day1 = mkPrefs([pref('P-1', '沟通风格', '他要求先给结论再展开', { daysAgo: 3 })])
  const h1 = extractHabits({ prefs: day1, now: NOW })
  const t1 = habitsText(h1.habits)
  const inj1 = composeWithParams({ coreBlock: core, params: {}, habitText: t1, moodText: '## 你现在的状态\n\n平静。' })

  check('第 1 天有「先结论」', t1.includes('结论'), t1.slice(0, 60))
  check('第 1 天没有「说人话」', !t1.includes('说人话'), '')
  check('注入里含习惯层', inj1.includes('他希望你这么说话'))

  // 第 2 天：他又说了「说人话」
  const day2 = mkPrefs([
    pref('P-1', '沟通风格', '他要求先给结论再展开', { daysAgo: 3 }),
    pref('P-2', '沟通风格', '他说以后说人话，别像AI', { daysAgo: 0, quote: '说人话' }),
  ])
  const h2 = extractHabits({ prefs: day2, now: NOW })
  const t2 = habitsText(h2.habits)
  const inj2 = composeWithParams({ coreBlock: core, params: {}, habitText: t2, moodText: '## 你现在的状态\n\n平静。' })

  check('第 2 天多出「说人话」', t2.includes('说人话') || t2.includes('口语'), t2.slice(0, 80))
  check('注入文本真的变了', inj1 !== inj2)
  check('变化就是那一层', inj2.includes('他希望你这么说话') && t2 !== t1)
  check('旧习惯还在（不是替换）', t2.includes('结论'), t2.slice(0, 80))
}

console.log('\n[F2] 他改主意 → 注入文本跟着反过来')
{
  const core = '# 核心块\n\n你叫晓光。'

  const before = mkPrefs([pref('P-1', '沟通风格', '他说一两行就够，别写长', { daysAgo: 40 })])
  const tBefore = habitsText(extractHabits({ prefs: before, now: NOW }).habits)
  check('改主意前：要精简', tBefore.includes('短') || tBefore.includes('一两行'), tBefore.slice(0, 70))

  const after = mkPrefs([
    pref('P-1', '沟通风格', '他说一两行就够，别写长', { daysAgo: 40 }),
    pref('P-2', '沟通风格', '他改主意了，以后详细一点讲清楚', { daysAgo: 0, quote: '详细一点' }),
  ])
  const rAfter = extractHabits({ prefs: after, now: NOW })
  const tAfter = habitsText(rAfter.habits)
  check('改主意后：要详细', tAfter.includes('展开') || tAfter.includes('详细'), tAfter.slice(0, 70))
  check('不再要求精简', !/一两行|别写长/.test(tAfter), tAfter.slice(0, 70))
  check('旧的被标成 overridden', rAfter.overridden.some((o) => o.id === 'brevity'), JSON.stringify(rAfter.overridden))
  void composeWithParams
  void core
}

console.log('\n[F3] 老偏好不会突然消失（只是被新的压过）')
{
  // 没有冲突时，90 天前的偏好仍然在
  const prefs = mkPrefs([pref('P-OLD', '沟通风格', '他要先给结论', { daysAgo: 90 })])
  const r = extractHabits({ prefs, now: NOW })
  check('90 天前的偏好仍然生效', r.habits.some((h) => h.id === 'conclusion_first'), r.habits.map((h) => h.id).join(','))
  check('但分数被新近度压低了', r.habits[0].score < 0.5, String(r.habits[0].score))
}

/* ══════════════ G. 快照：让「逐渐」有据可查 ══════════════ */

console.log('\n[G1] 快照只在变了才写')
{
  const dir = mkdtempSync(join(tmpdir(), 'habit-'))
  const store = new HabitStore(join(dir, 'habits.json'))
  check('初始为空', store.current().length === 0)

  const r1 = store.snapshot([{ id: 'conclusion_first', score: 1 }], { now: NOW })
  check('第一次算变了', r1.changed === true)
  check('记录 added', r1.added.includes('conclusion_first'), r1.added.join(','))
  check('落盘', store.save())

  const r2 = store.snapshot([{ id: 'conclusion_first', score: 1 }], { now: NOW + 1000 })
  check('没变就不写', r2.changed === false, JSON.stringify(r2))

  const r3 = store.snapshot([{ id: 'conclusion_first', score: 1 }, { id: 'plain_speech', score: 0.9 }], { now: NOW + 2000 })
  check('加了新习惯算变了', r3.changed === true && r3.added.includes('plain_speech'), r3.added.join(','))

  const r4 = store.snapshot([{ id: 'plain_speech', score: 0.9 }], { now: NOW + 3000 })
  check('掉了习惯算变了', r4.changed === true && r4.removed.includes('conclusion_first'), r4.removed.join(','))
  store.save()
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[G2] 演化轨迹能看出「这些天怎么变的」')
{
  const dir = mkdtempSync(join(tmpdir(), 'habit-'))
  const file = join(dir, 'habits.json')
  // 手工造三天快照
  writeFileSync(file, JSON.stringify({
    snapshots: [
      { at: NOW - 2 * 86400_000, day: '2026-10-19', habits: ['conclusion_first'], scores: {} },
      { at: NOW - 86400_000, day: '2026-10-20', habits: ['conclusion_first', 'plain_speech'], scores: {} },
      { at: NOW, day: '2026-10-21', habits: ['plain_speech'], scores: {} },
    ],
  }), 'utf8')
  const store = new HabitStore(file)
  const d = store.drift()
  check('三天三条', d.length === 3, String(d.length))
  check('第一天加了 conclusion_first', d[0].added.includes('conclusion_first'), JSON.stringify(d[0]))
  check('第二天加了 plain_speech', d[1].added.includes('plain_speech'), JSON.stringify(d[1]))
  check('第三天掉了 conclusion_first', d[2].removed.includes('conclusion_first'), JSON.stringify(d[2]))
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[G3] 快照有上限，不会无限涨')
{
  const dir = mkdtempSync(join(tmpdir(), 'habit-'))
  const store = new HabitStore(join(dir, 'h.json'))
  for (let i = 0; i < 30; i++) {
    store.snapshot([{ id: `x${i}`, score: 1 }], { now: NOW + i * 1000, keep: 10 })
  }
  check('最多留 10 条', store.data.snapshots.length === 10, String(store.data.snapshots.length))
  check('留的是最后 10 条', store.current()[0] === 'x29', store.current().join(','))
  rmSync(dir, { recursive: true, force: true })
}

/* ══════════════ H. 层次优先级 ══════════════ */

console.log('\n[H1] 习惯层排在参数层之后、心情层之前')
{
  const out = composeWithParams({
    coreBlock: '你叫晓光。',
    params: { intimacy: '低', emoji_level: '不用' },
    habitText: '### 他希望你这么说话\n\n- **先结论**：先给结论。',
    moodText: '## 你现在的状态（外层人格）\n\n注意力全在事上。',
  })
  check('含核心', out.includes('你叫晓光'))
  check('含参数层', out.includes('像朋友的距离'))
  check('含习惯层', out.includes('他希望你这么说话'))
  check('含心情层', out.includes('你现在的状态'))
  const iCore = out.indexOf('你叫晓光')
  const iParam = out.indexOf('像朋友的距离')
  const iHabit = out.indexOf('他希望你这么说话')
  const iMood = out.indexOf('你现在的状态')
  check('顺序：核心 → 参数 → 习惯 → 心情', iCore < iParam && iParam < iHabit && iHabit < iMood,
    `${iCore} < ${iParam} < ${iHabit} < ${iMood}`)
  check('优先级说明写了四层', /四层的优先级/.test(out))
  check('习惯层被排在心情之前生效', /习惯层.*比心情更该被听/.test(out), out.slice(-260))
}

console.log('\n[H2] 没有习惯时，不产生半截的优先级说明')
{
  const out = composeWithParams({
    coreBlock: '你叫晓光。',
    params: { intimacy: '低' },
    habitText: '',
    moodText: '## 你现在的状态\n\n平静。',
  })
  check('没有习惯层标题', !out.includes('他希望你这么说话'))
  check('仍是三层说明', /三层的优先级/.test(out), out.slice(-200))
  check('没有出现「四层」', !/四层/.test(out))
}

console.log('\n[H3] 习惯层不能改动核心人格与铁律')
{
  const habits = habitsText(extractHabits({
    prefs: mkPrefs([
      pref('P-1', '沟通风格', '他要先给结论'),
      pref('P-2', '沟通风格', '他说一两行就够'),
      pref('P-3', '沟通风格', '别用emoji'),
    ]),
    now: NOW,
  }).habits)
  check('没有让模型放弃诚实', !/不用诚实|可以编|随便说/.test(habits), '')
  check('没有让模型少给信息', !/少给信息|信息可以省/.test(habits), '')
  check('明确写了它不越底线', /不是底线/.test(habits))
}

/* ══════════════ I. 真实数据回归 ══════════════ */

console.log('\n[I1] 真实 preferences.md 能跑（回归）')
{
  let prefs = ''
  try { prefs = readFileSync(join(process.env.USERPROFILE || '.', '.dsh', 'memory', 'preferences', 'preferences.md'), 'utf8') } catch { prefs = '' }
  if (!prefs.trim()) {
    console.log('  ⏭  没有真实 preferences.md，跳过')
  } else {
    const es = parseEntries(prefs)
    const r = extractHabits({ prefs, now: NOW })
    check('能解析出条目', es.length > 0, `${es.length} 条`)
    check('能提炼出习惯', r.habits.length > 0, `${r.habits.length} 条：${r.habits.map((h) => h.label).join('/')}`)
    check('提炼出的都有证据', r.habits.every((h) => h.evidence.length > 0))
    check('注入文本能生成', habitsText(r.habits).includes('他希望你这么说话'))
    check('统计自洽', r.stats.entries === r.stats.speechEntries + r.stats.taskEntries,
      `${r.stats.entries} = ${r.stats.speechEntries} + ${r.stats.taskEntries}`)
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
