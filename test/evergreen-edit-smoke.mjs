/**
 * research/evergreen-edit-smoke.mjs —— core / preferences 的细粒度编辑
 * 跑法：& "<node>" research/evergreen-edit-smoke.mjs
 *
 * 重点：
 *   ① 按编号操作，不按行号（行号会漂移）
 *   ② 只改那一行，其余字节不动
 *   ③ 项目能标记完成、能删、能恢复
 */
import {
  listItems, findItem, markDone, removeItem, editItem,
  splitSections, ensureSection, pushTrash, findTrash, restoreTrash, emptyTrash,
} from '../lib/evergreen-edit.mjs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log('  ✅ ' + n + (x ? ' — ' + x : '')) }
  else { fail++; console.log('  ❌ ' + n + (x ? ' — ' + x : '')) }
}

/** 贴近真实格式的样本（编号后带内联小节名）。 */
const SAMPLE = [
  '# 习惯与喜好',
  '',
  '## 沟通风格',
  '',
  '- [P-AAA] [沟通风格] 他喜欢先听结论。（用户明说 ｜ 置信度：高 ｜ 2026-10-19）',
  '- [P-BBB] [沟通风格] 他讨厌被反问。（用户明说 ｜ 置信度：高 ｜ 2026-10-19）',
  '',
  '## 正在进行的项目',
  '',
  '- [P-CCC] [正在进行的项目] 他在做记忆插件。（模型推断 ｜ 置信度：中 ｜ 2026-10-20）',
  '- [P-DDD] [正在进行的项目] 他在调 hy3 路由。（用户明说 ｜ 置信度：高 ｜ 2026-10-20）',
  '- [P-EEE] [正在进行的项目] 他在写发布脚本。（模型推断 ｜ 置信度：中 ｜ 2026-10-20）',
  '',
].join('\n')

console.log('[1] 解析')
{
  const items = listItems(SAMPLE)
  check('解析出 5 条', items.length === 5, String(items.length))
  const ccc = items.find((x) => x.id === 'P-CCC')
  check('找得到 P-CCC', Boolean(ccc))
  check('小节名正确', ccc.section === '正在进行的项目', ccc.section)
  check('内联 tag 也解析了', ccc.tag === '正在进行的项目', ccc.tag)
  check('正文不含编号和 tag', !ccc.body.includes('P-CCC') && !ccc.body.includes('[正在进行的项目]'), ccc.body.slice(0, 30))
  check('空文本返回空', listItems('').length === 0)
  check('查不到的 id 返回 null', findItem(SAMPLE, 'P-ZZZ') === null)
}

console.log('\n[2] 标记完成')
{
  const r = markDone(SAMPLE, 'P-CCC', { date: '2026-10-21' })
  check('ok', r.ok === true, r.error || '')
  const line = r.text.split('\n').find((l) => l.includes('P-CCC'))
  check('写了「已完成」', line.includes('已完成'), line.slice(-40))
  check('带日期', line.includes('2026-10-21'))
  check('行数不变', r.text.split('\n').length === SAMPLE.split('\n').length)
  check('其他条目没动', r.text.includes('他讨厌被反问') && r.text.includes('他在调 hy3 路由'))
  check('编号还在', line.includes('[P-CCC]'))
}

console.log('\n[2b] 标记完成并挪到「已完成的项目」')
{
  const base = ensureSection(SAMPLE, '已完成的项目')
  check('补上了小节', base.includes('## 已完成的项目'))
  const r = markDone(base, 'P-CCC', { date: '2026-10-21', moveTo: '已完成的项目' })
  check('ok', r.ok === true, r.error || '')
  const items = listItems(r.text)
  const ccc = items.find((x) => x.id === 'P-CCC')
  check('挪到新小节了', ccc.section === '已完成的项目', ccc.section)
  check('原小节少一条', items.filter((x) => x.section === '正在进行的项目').length === 2)
  check('内容保留', r.text.includes('他在做记忆插件'))
}

console.log('\n[2c] 重复标记不重复加')
{
  const once = markDone(SAMPLE, 'P-CCC', { date: '2026-10-21' })
  const twice = markDone(once.text, 'P-CCC', { date: '2026-10-22' })
  check('第二次是 unchanged', twice.unchanged === true)
  check('没有重复的「已完成」', (twice.text.match(/已完成/g) || []).length === 1)
}

console.log('\n[3] 删除')
{
  const before = SAMPLE.split('\n').length
  const r = removeItem(SAMPLE, 'P-DDD')
  check('ok', r.ok === true)
  check('少了一行', r.text.split('\n').length === before - 1)
  check('该条消失', !r.text.includes('P-DDD'))
  check('别的还在', r.text.includes('P-CCC') && r.text.includes('P-EEE'))
  check('返回了被删的原始行（可以恢复）', Boolean(r.removed) && r.removed.includes('P-DDD'))
  check('小节标题还在', r.text.includes('## 正在进行的项目'))
  check('删不存在的给错误', removeItem(SAMPLE, 'P-ZZZ').ok === false)
}

console.log('\n[4] 改内容')
{
  const r = editItem(SAMPLE, 'P-CCC', '他在做一个跨会话记忆插件，已经能跑了。')
  check('ok', r.ok === true, r.error || '')
  const line = r.text.split('\n').find((l) => l.includes('P-CCC'))
  check('新内容进去了', line.includes('已经能跑了'))
  check('编号保留', line.includes('[P-CCC]'))
  check('内联 tag 保留', line.includes('[正在进行的项目]'))
  check('行数不变', r.text.split('\n').length === SAMPLE.split('\n').length)
  check('返回 from/to', r.from.includes('记忆插件') && r.to.includes('已经能跑了'))
  check('空内容被拒', editItem(SAMPLE, 'P-CCC', '  ').ok === false)
  check('换行被拒', editItem(SAMPLE, 'P-CCC', 'a\nb').ok === false)
}

console.log('\n[5] 回收站')
{
  let trash = emptyTrash()
  const r = removeItem(SAMPLE, 'P-EEE')
  trash = pushTrash(trash, { file: 'preferences', id: 'P-EEE', section: r.item.section, raw: r.removed })
  check('进了回收站', trash.rows.length === 1)
  check('记录了原始行', trash.rows[0].raw.includes('P-EEE'))
  check('记录了小节', trash.rows[0].section === '正在进行的项目')

  const entry = findTrash(trash, 'P-EEE')
  check('按 id 找得到', Boolean(entry))

  const restored = restoreTrash(r.text, entry)
  check('恢复 ok', restored.ok === true)
  check('条目回来了', restored.text.includes('P-EEE'))
  check('回到原小节', listItems(restored.text).find((x) => x.id === 'P-EEE').section === '正在进行的项目')

  // 已存在就不重复插
  const again = restoreTrash(restored.text, entry)
  check('重复恢复不重复插', again.unchanged === true)
  check('只出现一次', (again.text.match(/P-EEE/g) || []).length === 1)
}

console.log('\n[6] 行号漂移不影响（核心设计目标）')
{
  // 先删掉前面一条，让 P-CCC 的行号变了
  const afterDelete = removeItem(SAMPLE, 'P-AAA')
  check('前面的条目没了', !afterDelete.text.includes('P-AAA'))
  // 仍然按编号能找到并修改
  const r = editItem(afterDelete.text, 'P-CCC', '改过了')
  check('行号变了但还能按编号改', r.ok === true, r.error || '')
  check('改对了那一条', r.text.split('\n').find((l) => l.includes('P-CCC')).includes('改过了'))
  check('没误伤别的', r.text.includes('他讨厌被反问'))
}

console.log('\n[7] 边界')
{
  check('空文本 listItems 不崩', Array.isArray(listItems('')))
  check('没有小节的条目不会被算进来', listItems('随便一行\n- [P-XXX] 没有小节').length === 0)
  check('ensureSection 已存在就不重复加',
    (ensureSection(SAMPLE, '沟通风格').match(/## 沟通风格/g) || []).length === 1)
  check('splitSections 返回所有小节', splitSections(SAMPLE).sections.length === 2)
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
