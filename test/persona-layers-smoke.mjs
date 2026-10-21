/**
 * research/persona-layers-smoke.mjs —— 人格各层的组装与优先级
 * 跑法：& "<node>" research/persona-layers-smoke.mjs
 *
 * 🔴 2026-10-21 重写。
 *
 * 原来这个测试用 `persona.mjs` 的 `composePersona`，验「核心 + 心情」两层。
 * 但 2.3.0 加了习惯层、2.4.0 把优先级说明改成动态层数之后，
 * 真正在用的是 `persona-params.mjs` 的 `composeWithParams` —— 四层：
 *
 *     ① 核心人格（我是谁、底线）
 *     ② 参数层（称呼/亲昵度/口癖）
 *     ③ 习惯层（他真实的口味，从长期记忆提炼）
 *     ④ 心情层（这一刻的语气）
 *
 * `composePersona` 因此成了死函数（全仓只有这个测试在调它），已删除。
 * 这个测试现在直接验真在用的那个 —— 否则「测试全绿」是假的。
 */
import { personaCore } from '../lib/persona.mjs'
import { composeWithParams } from '../lib/persona-params.mjs'
import { moodById, moodInjectionText, MOODS } from '../lib/mood.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const HABIT = '### 他希望你这么说话\n\n- **先结论**：先给结论再展开。'
const PARAMS = { intimacy: '低', emoji_level: '不用', technical_tone: '放松口语', catchphrase: '嗯哼 / 你又说这个', reassure_style: '先问细节，再给建议' }

console.log('[1] 从真实 persona.md 取核心块')
{
  let md = ''
  try { md = readFileSync(join(homedir(), '.dsh', 'memory', 'persona.md'), 'utf8') } catch { md = '' }
  if (!md.trim()) {
    console.log('  ⏭  没有真实 persona.md，用构造的')
    md = '## 核心块\n\n# 你是谁\n\n你叫晓光，他叫枫。\n'
  }
  const core = personaCore(md)
  check('取到了核心块', core.length > 50, `${core.length} 字`)
  check('不含 HTML 注释', !core.includes('<!--'))
}

const core = '# 你是谁\n\n你叫晓光，他叫枫。'

console.log('\n[2] 四层齐全时的顺序')
{
  const out = composeWithParams({
    coreBlock: core,
    params: PARAMS,
    habitText: HABIT,
    moodText: moodInjectionText(moodById('happy')),
  })
  check('有核心人格标题', out.includes('## 核心人格（不变的那一层）'))
  check('有参数层', out.includes('按你的设定调整'))
  check('有习惯层', out.includes('他希望你这么说话'))
  check('有心情层', out.includes('你现在的状态（外层人格）'))

  const iCore = out.indexOf('## 核心人格')
  const iParam = out.indexOf('按你的设定调整')
  const iHabit = out.indexOf('他希望你这么说话')
  const iMood = out.indexOf('你现在的状态')
  check('顺序：核心 → 参数 → 习惯 → 心情', iCore < iParam && iParam < iHabit && iHabit < iMood,
    `${iCore} < ${iParam} < ${iHabit} < ${iMood}`)

  check('优先级说明写了四层', /四层的优先级/.test(out), out.slice(-260))
  check('核心排第 1', /1\.\s*核心人格/.test(out))
  check('习惯排在心情之前生效', /习惯层.*比心情更该被听/.test(out))
  check('明确禁止因状态少给信息', /不许因为/.test(out))
}

console.log('\n[3] 层数是动态的（不写死「四层」）')
{
  const two = composeWithParams({ coreBlock: core, params: {}, habitText: '', moodText: moodInjectionText(MOODS.calm) })
  check('只有核心+心情时说「二层」', /二层的优先级/.test(two), two.slice(-180))
  check('没有习惯层标题', !two.includes('他希望你这么说话'))
  check('不声称有习惯层', !/习惯层/.test(two))

  const three = composeWithParams({ coreBlock: core, params: {}, habitText: HABIT, moodText: '' })
  check('核心+习惯时说「二层」', /二层的优先级/.test(three), three.slice(-200))
  check('没有心情层', !three.includes('你现在的状态'))
  check('提到了习惯层', /习惯层/.test(three))
}

console.log('\n[4] 空核心也要能用')
{
  const out = composeWithParams({ coreBlock: '', params: {}, habitText: '', moodText: moodInjectionText(MOODS.calm) })
  check('有兜底说明', out.includes('人格文件是空的'))
  check('心情仍然注入', out.includes('你现在的状态'))
}

console.log('\n[5] 所有心情都能组进去')
{
  let ok = true
  for (const id of Object.keys(MOODS)) {
    const t = composeWithParams({ coreBlock: core, params: PARAMS, habitText: HABIT, moodText: moodInjectionText(MOODS[id]) })
    if (!t.includes(MOODS[id].tone.slice(0, 8))) { ok = false; console.log('   失败:', id) }
    if (t.length < core.length) { ok = false; console.log('   组装后比核心还短:', id) }
  }
  check('7 个主要心情都 OK', ok)
}

console.log('\n[6] 负面心情压不过核心与习惯')
{
  const negatives = ['unhappy', 'angry', 'sad', 'despair']
  let ok = true
  for (const id of negatives) {
    const t = composeWithParams({ coreBlock: core, params: PARAMS, habitText: HABIT, moodText: moodInjectionText(MOODS[id]) })
    const has1 = t.includes('你现在的状态')
    const has2 = t.includes('核心人格赢')
    const has3 = /信息量|准确性/.test(t)
    const has4 = /习惯层.*比心情更该被听/.test(t)
    if (!(has1 && has2 && has3 && has4)) {
      ok = false
      console.log(`   ${id} 缺: ${!has1 ? '心情段 ' : ''}${!has2 ? '核心赢 ' : ''}${!has3 ? '信息量声明 ' : ''}${!has4 ? '习惯优先于心情' : ''}`)
    }
  }
  check('负面心情不会削弱核心与习惯', ok, negatives.join('/'))
}

console.log('\n[7] 习惯层不许越过底线')
{
  const t = composeWithParams({ coreBlock: core, params: {}, habitText: HABIT, moodText: '' })
  check('写了「风格不是底线」', /不是底线|一条不少/.test(t), t.slice(-200))
  check('没有允许少给信息', !/(可以|允许)(少给|省略)/.test(t))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
