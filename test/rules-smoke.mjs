/**
 * research/rules-smoke.mjs —— 硬规则：他明说过的，必须每次都读到
 * 跑法：& "<node>" research/rules-smoke.mjs
 *
 * 🔴 需求来源（2026-10-21 晚，用户原话）：
 *   「我刚才在另一个对话里面告诉你了改没读过的文件要先读再改，你没记住，
 *     说明功能有问题」
 *
 * 查下来的事实：
 *   那条**记下来了**（preferences 第 94 行，置信度高，原话都在），
 *   但**从来没进过提示词**。
 *
 *   原因：注入是「按文件顺序取前 1560 字」，它在第 94 行被截断。
 *   141 条偏好里只有 13 条进得去；其中「用户明说 + 高置信」76 条
 *   里有 68 条读不到。
 *
 * 所以不是记性差，是**用不上**。这个测试守的就是这条线：
 *   ★ 他明说过的约束，必须每次都在注入里
 *   ★ 而且不能因为文件里位置靠后就丢掉
 */
import {
  isHardRule, extractRules, rulesText, cleanRuleText, MAX_RULES,
} from '../lib/rules.mjs'
import { parseEntryLine } from '../lib/habits.mjs'
import { MemoryStore } from '../lib/store.mjs'
import { turnRecall } from '../lib/recall-turn.mjs'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const NOW = new Date('2026-10-21T22:00:00').getTime()
const day = (n) => {
  const d = new Date(NOW - n * 86_400_000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 造一行偏好（照磁盘上的真实格式）。 */
const pref = (id, text, { conf = '高', daysAgo = 1, quote = '', evidence = '用户明说', tagDate = null } = {}) => {
  const tag = tagDate ?? day(daysAgo)
  return `- [${id}] [${tag}] ${text}（${evidence} ｜ 置信度：${conf} ｜ 原话：「${quote || '原话'}」）`
}
const mkPrefs = (rows, section = '沟通风格') =>
  `# 习惯与喜好\n\n## ${section}\n\n${rows.join('\n')}\n`

/* ══════════════ A. 什么算「硬规则」 ══════════════ */

console.log('[A1] 用户明说的祈使句 = 硬规则')
{
  const yes = [
    ['改任何文件之前必须先读一遍再编辑，不许盲改', '必须+不许'],
    ['以后不要用阿历叫我', '以后+不要'],
    ['报告里必须写一行「跳过 N 条」', '必须'],
    ['禁止写到家目录', '禁止'],
    ['记住，每次操作前先确认路径', '记住+每次'],
  ]
  for (const [text, why] of yes) {
    const e = parseEntryLine(pref('P-1', text))
    check(`认得「${why}」`, isHardRule(e) === true, text.slice(0, 24))
  }
}

console.log('\n[A2] 事实陈述 / 低置信 / 无证据 不算')
{
  const no = [
    ['他叫枫，我叫晓光', '事实陈述', { quote: '我叫枫' }],
    ['我今天在写插件', '事实陈述', { quote: '在写插件' }],
    ['他要求不要这样', '低置信', { conf: '低' }],
  ]
  for (const [text, why, opts] of no) {
    const e = parseEntryLine(pref('P-2', text, opts))
    check(`不算「${why}」`, isHardRule(e) === false, text.slice(0, 20))
  }

  // 没有原话 + 模型推断 → 不算
  const noQuote = {
    id: 'P-3', text: '他要求这样做', confidence: '高', evidence: '模型推断', quote: '', raw: '- [P-3] 他要求这样做',
  }
  check('没有原话也没有「用户明说」→ 不算', isHardRule(noQuote) === false)
}

console.log('\n[A3] ★ 打标错了也要认（真实数据的坑）')
{
  /**
   * 「改任何文件之前必须先读一遍再编辑」那条，磁盘上的原始记录是：
   *   （来源：模型记录 ｜ 置信度：高 ｜ 原话：「记住，每次想编辑哪个文件一定要先读取再编辑」）
   *
   * `evidence` 被标成了「模型推断」，但原话明显是用户亲口说的。
   * 第一版判据只看 evidence，把它排除了 —— 于是用户的要求被静默丢掉。
   *
   * 现在：**有原话就算强证据**。原话是逐字摘录，比「来源」这个标签可信。
   */
  const e = parseEntryLine(
    '- [P-MVI6PUUOG7I] [2026-10-21] 改任何文件之前必须先读一遍再编辑，不许盲改。（来源：模型记录 ｜ 置信度：高 ｜ 原话：「记住，每次想编辑哪个文件一定要先读取再编辑」）',
  )
  check('★ 标成「模型推断」但有原话 → 仍然认', isHardRule(e) === true,
    `evidence=${e.evidence} quote=${e.quote.slice(0, 12)}`)
}

/* ══════════════ B. 日期解析（位置 bug） ══════════════ */

console.log('\n[B1] ★ 日期在方括号 tag 里也要认得')
{
  /**
   * 格式 `- [P-xxx] [2026-10-21] 正文…` 里，日期在 **tag** 不在正文。
   * 原来只从正文找，这类条目 date 全是空串 → 排序时被当成「很久以前」。
   * 「先读再改」那条正好是这种格式，于是永远排不进前面。
   */
  const e = parseEntryLine('- [P-1] [2026-10-21] 改文件前先读（用户明说 ｜ 置信度：高）')
  check('tag 里的日期被取到', e.date === '2026-10-21', JSON.stringify(e.date))

  const e2 = parseEntryLine('- [P-2] [沟通风格] 改文件前先读（用户明说 ｜ 置信度：高 ｜ 2026-10-20）')
  check('小节名在 tag 里时，日期从正文取', e2.date === '2026-10-20', JSON.stringify(e2.date))
}

/* ══════════════ C. 排序：不能只看日期 ══════════════ */

console.log('\n[C1] ★ 同一天的条目要有区分度（否则排序退化成行号）')
{
  /**
   * 第一版只用新近度排序 → 同一天所有条目分数完全一样（1.191）
   * → 排序等于「文件里的顺序」→ 他最新提的要求被排到 34/82 名。
   *
   * 现在加了「约束强度」和「操作性」两个信号。
   */
  const rows = [
    pref('P-A', '他要求添加摘要模型选择功能', { daysAgo: 1 }),      // 一次性任务
    pref('P-B', '他要求每次都先读文件再改，不许盲改', { daysAgo: 1 }), // 通用约束 + 强词
    pref('P-C', '他要求实现一个插件', { daysAgo: 1 }),              // 一次性任务
  ]
  const r = extractRules({ prefs: mkPrefs(rows), now: NOW })
  const order = r.rules.map((x) => x.id)
  check('「必须/不许」那条排第一', order[0] === 'P-B', order.join(' > '))
  check('分数不是全部相同', new Set(r.rules.map((x) => x.score)).size > 1,
    JSON.stringify(r.rules.map((x) => x.score)))
}

console.log('\n[C2] 去重：同一天重复的只留一条')
{
  const rows = [
    pref('P-1', '他要求人格提示词初始预设为他的女朋友', { daysAgo: 1 }),
    pref('P-2', '他要求人格提示词初始预设为女朋友', { daysAgo: 1 }),
    pref('P-3', '他要求以后不要用阿历叫我', { daysAgo: 1 }),
  ]
  const r = extractRules({ prefs: mkPrefs(rows), now: NOW })
  check('重复的被去掉', r.stats.deduped >= 1, `去重 ${r.stats.deduped} 条`)
  check('独立的那条留着', r.rules.some((x) => x.text.includes('阿历')), JSON.stringify(r.rules.map((x) => x.text)))
}

console.log('\n[C3] 新的比旧的优先')
{
  const rows = [
    pref('P-OLD', '他要求先给结论，必须每次都说结论', { daysAgo: 120 }),
    pref('P-NEW', '他要求以后别先给结论了，直接说事', { daysAgo: 1 }),
  ]
  const r = extractRules({ prefs: mkPrefs(rows), now: NOW })
  check('新的排前面', r.rules[0].id === 'P-NEW', r.rules.map((x) => x.id).join(' > '))
}

/* ══════════════ D. 压成短句 ══════════════ */

console.log('\n[D1] 去掉元信息，只留指令')
{
  check('切掉括号元信息',
    cleanRuleText('改文件前先读（来源：模型记录 ｜ 置信度：高 ｜ 原话：「记住」）') === '改文件前先读',
    cleanRuleText('改文件前先读（来源：模型记录 ｜ 置信度：高 ｜ 原话：「记住」）'))

  check('去掉句尾句号',
    cleanRuleText('必须这样做。') === '必须这样做')

  // 正文里的括号不能误切
  const keep = cleanRuleText('报告必须写一行「跳过 N 条」（N=0 也写）')
  check('★ 正文里的括号不被误切', keep.includes('N=0 也写'), keep)

  check('超长的截断', cleanRuleText('啊'.repeat(200)).length <= 80)
}

/* ══════════════ E. 注入：必须真的进得去 ══════════════ */

console.log('\n[E1] ★★ 硬规则必须进注入 —— 而且不跟偏好列表抢预算')
{
  /**
   * 这是这次修复的核心断言。
   *
   * 造一个「偏好列表很长、目标规则排在很后面」的场景 ——
   * 正是真实数据的样子（141 条，目标在第 94 行）。
   * 修复前：目标被 clipMarkdown 截掉，注入里没有。
   * 修复后：硬规则单独成段，永远在前。
   */
  const filler = []
  for (let i = 0; i < 120; i++) {
    filler.push(pref(`P-F${i}`, `他要求在场景 ${i} 时使用方式 ${i}`, { daysAgo: 30, quote: `场${i}` }))
  }
  const target = pref('P-TARGET', '改任何文件之前必须先读一遍再编辑，不许盲改', { daysAgo: 0, quote: '记住，每次想编辑哪个文件一定要先读取再编辑' })

  const root = mkdtempSync(join(tmpdir(), 'rules-'))
  const store = new MemoryStore({ get: () => undefined }, { root })
  store.ensureLayout({ core: '# 核心\n\n## 身份与称呼\n\n- [C-1] [2026-10-20] 他叫枫（来源：模型记录 ｜ 置信度：高 ｜ 原话：「我叫枫」）\n', prefs: '', persona: '# p\n' })
  // 把目标放在最后一行 —— 最容易被截断的位置
  writeFileSync(store.prefsPath(), mkPrefs([...filler, target]), 'utf8')

  const r = turnRecall({ store, query: '改个文件', budget: 6000, recentDays: 1 })

  check('★ 注入里有「他明确要求过的」段', r.text.includes('他明确要求过的'), '')
  check('★★ 目标规则进得去（在最末尾也一样）', r.text.includes('先读一遍再编辑'),
    r.text.includes('先读一遍再编辑') ? '在' : '被截掉了')
  check('规则段在最前面（优先于偏好列表）',
    r.text.indexOf('他明确要求过的') < r.text.indexOf('他的习惯与喜好'),
    `${r.text.indexOf('他明确要求过的')} < ${r.text.indexOf('他的习惯与喜好')}`)
  check('带回统计', r.rules && r.rules.kept > 0, JSON.stringify(r.rules))

  rmSync(root, { recursive: true, force: true })
}

console.log('\n[E2] 没有硬规则时不产生空段落')
{
  const root = mkdtempSync(join(tmpdir(), 'rules-'))
  const store = new MemoryStore({ get: () => undefined }, { root })
  store.ensureLayout({ core: '# 核心\n', prefs: '', persona: '# p\n' })
  writeFileSync(store.prefsPath(), mkPrefs([pref('P-1', '他叫枫', { quote: '我叫枫' })]), 'utf8')
  const r = turnRecall({ store, query: 'x', budget: 6000, recentDays: 0 })
  check('没有规则段', !r.text.includes('他明确要求过的'), r.text.slice(0, 80))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[E3] 数量上限生效（不然会膨胀到没人读）')
{
  const rows = []
  for (let i = 0; i < 60; i++) {
    rows.push(pref(`P-${i}`, `他要求必须做第 ${i} 件事`, { daysAgo: i, quote: `第${i}件` }))
  }
  const r = extractRules({ prefs: mkPrefs(rows), now: NOW })
  check(`最多 ${MAX_RULES} 条`, r.rules.length === MAX_RULES, String(r.rules.length))
  check('记录了丢掉多少', r.stats.dropped > 0, JSON.stringify(r.stats))

  const t = rulesText(r.rules, { max: 5 })
  check('rulesText 的 max 也生效', t.split('\n').filter((l) => l.startsWith('- ')).length === 5,
    String(t.split('\n').filter((l) => l.startsWith('- ')).length))
}

console.log('\n[E4] rulesText 的措辞')
{
  const t = rulesText([{ text: '先读再改', date: '2026-10-21' }])
  check('有标题', t.includes('他明确要求过的'), '')
  check('说了「必须遵守」', /必须遵守/.test(t), '')
  check('说清是他说过的', /说过/.test(t), '')
  check('不是让他解释的口吻', /别解释/.test(t), '')
}

/* ══════════════ F. 真实数据回归 ══════════════ */

console.log('\n[F1] ★ 真实 preferences.md：那条「先读再改」必须进注入')
{
  let prefs = ''
  let core = ''
  try {
    prefs = readFileSync(join(process.env.USERPROFILE || '.', '.dsh', 'memory', 'preferences', 'preferences.md'), 'utf8')
    core = readFileSync(join(process.env.USERPROFILE || '.', '.dsh', 'memory', 'core', 'memories.md'), 'utf8')
  } catch { /* 没有就跳过 */ }

  if (!prefs.trim()) {
    console.log('  ⏭  没有真实 preferences.md，跳过')
  } else {
    const r = extractRules({ prefs, core, now: Date.now() })
    check('能提出规则', r.rules.length > 0, `${r.rules.length} 条，候选 ${r.stats.candidates}`)

    const target = r.rules.find((x) => x.id === 'P-MVI6PUUOG7I' || x.text.includes('先读一遍再编辑'))
    check('★★ 「先读再改」在规则里', Boolean(target),
      target ? `排名 ${r.rules.indexOf(target) + 1}` : '不在')
    check('★★ 排名靠前（前 12）', target ? r.rules.indexOf(target) < 12 : false,
      target ? String(r.rules.indexOf(target) + 1) : '')

    // 走完整的注入链路
    const root = mkdtempSync(join(tmpdir(), 'rules-'))
    const store = new MemoryStore({ get: () => undefined }, { root })
    store.ensureLayout({ core, prefs, persona: '# p\n' })
    writeFileSync(store.prefsPath(), prefs, 'utf8')
    writeFileSync(store.corePath(), core, 'utf8')
    const out = turnRecall({ store, query: '改文件', budget: 6000, recentDays: 1 })
    check('★★★ 真实注入里含「先读一遍再编辑」', out.text.includes('先读一遍再编辑'),
      out.text.includes('先读一遍再编辑') ? '在' : '不在')
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
