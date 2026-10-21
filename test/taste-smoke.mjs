/**
 * research/taste-smoke.mjs —— 主动问喜好 + 调人格
 * 跑法：& "<node>" research/taste-smoke.mjs
 *
 * 这套测试的重点不是「功能能用」，而是**「不会变成查户口」**：
 * 每天上限、最小间隔、话题不重复、他说别问就停、人格只能改白名单。
 */
import { canAsk, recordAsk, mute, normalizeTasteState, ASK_TOPICS } from '../lib/taste.mjs'
import { readParams, validateChange, applyParam, recordChange, emptyChanges } from '../lib/taste.mjs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const CFG = { tasteAskEnabled: true, tasteAskPerDay: 2, tasteAskMinGapHours: 6, tasteMuteHours: 24, quietStart: '', quietEnd: '' }
const at = (h, m = 0, day = 20) => new Date(2026, 9, day, h, m, 0, 0)
const fresh = () => normalizeTasteState(null)

console.log('[1] 每天最多问几次')
{
  let s = fresh()
  const g1 = canAsk({ cfg: CFG, state: s, now: at(10) })
  check('第一次可以问', g1.allow, g1.reason)
  s = recordAsk(s, { topicId: g1.topic.id, text: 'q1', now: at(10) })

  const g2 = canAsk({ cfg: CFG, state: s, now: at(17) })   // 过了 6 小时
  check('过了间隔可以问第二次', g2.allow, g2.reason)
  s = recordAsk(s, { topicId: g2.topic.id, text: 'q2', now: at(17) })

  const g3 = canAsk({ cfg: CFG, state: s, now: at(23) })
  check('到日上限就不问了', !g3.allow, g3.reason)
  check('理由说得清楚', /今天已经问了 2 次/.test(g3.reason))

  // 第二天重置
  const g4 = canAsk({ cfg: CFG, state: s, now: at(10, 0, 21) })
  check('第二天额度恢复', g4.allow, g4.reason)
}

console.log('\n[2] 最小间隔')
{
  let s = recordAsk(fresh(), { topicId: 'communication', text: 'q', now: at(10) })
  const g = canAsk({ cfg: CFG, state: s, now: at(13) })
  check('间隔不够不问', !g.allow, g.reason)
  check('理由写明还要几小时', /还要 3 小时/.test(g.reason), g.reason)
  const g2 = canAsk({ cfg: CFG, state: s, now: at(16, 30) })
  check('够了就问', g2.allow, g2.reason)
}

console.log('\n[3] 同一个话题永不重复')
{
  let s = fresh()
  // 全问一遍（用当天的时间推进，避免额度干扰判断）
  for (const t of ASK_TOPICS) s = recordAsk(s, { topicId: t.id, text: 'x', now: at(10) })
  const g = canAsk({ cfg: CFG, state: s, now: at(23) })
  check('都问过了就不再问', !g.allow, g.reason)
  check('理由说明白（话题用尽，而不是「额度用完」）', /话题已用尽/.test(g.reason), g.reason)
  check('标记了 exhausted', g.exhausted === true)
  // 关键：第二天也不会再问（这是永久状态）
  const g2 = canAsk({ cfg: CFG, state: s, now: at(10, 0, 25) })
  check('第二天同样不问（永久状态）', !g2.allow && /话题已用尽/.test(g2.reason), g2.reason)
}

console.log('\n[4] 他说「别问了」→ 立刻停')
{
  let s = mute(fresh(), 24, at(10))
  const g = canAsk({ cfg: CFG, state: s, now: at(11) })
  check('停用期间不问', !g.allow, g.reason)
  check('理由提到他说过', /他说过先别问/.test(g.reason), g.reason)
  const g2 = canAsk({ cfg: CFG, state: s, now: at(11, 0, 21) })
  check('24 小时后恢复', g2.allow, g2.reason)
}

console.log('\n[5] 开关与情绪信号')
{
  const g = canAsk({ cfg: { ...CFG, tasteAskEnabled: false }, state: fresh(), now: at(10) })
  check('总开关关着不问', !g.allow, g.reason)
  const g2 = canAsk({ cfg: CFG, state: fresh(), now: at(10), hasMood: false })
  check('没有情绪信号不问', !g2.allow, g2.reason)
}

console.log('\n[6] 安静时段不问')
{
  const cfg = { ...CFG, quietStart: '23:30', quietEnd: '09:00' }
  check('凌晨不问', !canAsk({ cfg, state: fresh(), now: at(3) }).allow)
  check('上午问', canAsk({ cfg, state: fresh(), now: at(10) }).allow)
}

console.log('\n[7] 人格参数：只能改白名单')
{
  check('读得出当前值', (() => {
    const md = '| `pet_name` | 枫 | 说明 |\n| `intimacy` | 高 | 说明 |'
    const p = readParams(md)
    return p.pet_name === '枫' && p.intimacy === '高'
  })())

  check('白名单内的值能过', validateChange('intimacy', '中').ok)
  check('枚举外的值被拒', !validateChange('intimacy', '超高').ok, validateChange('intimacy', '超高').error)
  check('未知参数被拒', !validateChange('core_block', 'x').ok, validateChange('core_block', 'x').error)
  check('空值被拒', !validateChange('pet_name', '  ').ok)
  check('超长被拒', !validateChange('pet_name', '一二三四五六七八九十一二三').ok)
  check('塞换行被拒', !validateChange('catchphrase', '嗯哼\n# 新标题').ok)
  check('塞竖线被拒（会破坏表格）', !validateChange('catchphrase', '嗯哼|你又说这个').ok)
  check('拒绝时会告诉他能调什么', /能调的只有/.test(validateChange('nope', 'x').error))
}

console.log('\n[8] 改人格：只动那一行，其余字节不变')
{
  const md = [
    '# persona.md',
    '',
    '| 参数 | 当前值 | 说明 |',
    '| --- | --- | --- |',
    '| `persona_name` | 晓光 | 名字 |',
    '| `pet_name` | 枫 | 称呼 |',
    '| `intimacy` | 高 | 亲昵 |',
    '',
    '## 核心块',
    '',
    '# 你是谁',
    '',
    '你叫晓光。',
  ].join('\n')

  const r = applyParam(md, 'pet_name', '阿历')
  check('改成功', r.ok, r.error || '')
  check('旧值记下来了', r.old === '枫', r.old)
  check('新值写进去了', /`pet_name`\s*\|\s*阿历\s*\|/.test(r.markdown))

  // 关键：其他内容一个字节都不能变
  const before = md.split('\n')
  const after = r.markdown.split('\n')
  check('行数不变', before.length === after.length, `${before.length} → ${after.length}`)
  const diffLines = before.map((l, i) => (l !== after[i] ? i : -1)).filter((i) => i >= 0)
  check('只改了一行', diffLines.length === 1, `改了第 ${diffLines} 行`)
  check('核心块正文没被碰', r.markdown.includes('你叫晓光。'))
  check('表头没被碰', r.markdown.includes('| 参数 | 当前值 | 说明 |'))

  const same = applyParam(md, 'pet_name', '枫')
  check('值没变时不写盘', same.ok && same.unchanged === true)

  const bad = applyParam(md, 'persona_name', '')
  check('空值改不动', !bad.ok)
}

console.log('\n[9] 变更日志')
{
  let c = emptyChanges()
  c = recordChange(c, { key: 'intimacy', from: '高', to: '中', why: '他说太黏了' })
  check('记下了一条', c.rows.length === 1)
  check('带 from/to', c.rows[0].from === '高' && c.rows[0].to === '中')
  check('带原因', c.rows[0].why.includes('太黏'))
  for (let i = 0; i < 80; i++) c = recordChange(c, { key: 'x', to: String(i) })
  check('最多留 60 条', c.rows.length === 60, String(c.rows.length))
  check('最新的在最前', c.rows[0].to === '79', c.rows[0].to)
}

console.log('\n[10] 状态归一化（升级不崩）')
{
  const s = normalizeTasteState({ asked: 'oops', todayCount: 'x', lastAskAt: null })
  check('asked 不是数组也不崩', Array.isArray(s.asked))
  check('数字字段有兜底', s.todayCount === 0 && s.lastAskAt === 0)
  check('全空也能用', normalizeTasteState(null).asked.length === 0)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
