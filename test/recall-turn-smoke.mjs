/**
 * research/recall-turn-smoke.mjs —— 每轮召回 + 日期文件夹归拢
 * 跑法：& "<node>" research/recall-turn-smoke.mjs
 *
 * 验四件事：
 *   A. 日期文件夹真的收进 days/ 了，老数据能迁过来，不丢
 *   B. 每轮召回：核心/偏好永远在，相关的旧记忆能捞出来
 *   C. 检索词提取对中文有用（没有空格也能切）
 *   D. 召回命中会续期，但不该把墓碑捞回来
 */
import { MemoryStore, splitEntries, DAYS_DIR } from '../lib/store.mjs'
import { turnRecall, keywordsOf } from '../lib/recall-turn.mjs'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const mkStore = () => {
  const root = mkdtempSync(join(tmpdir(), 'dm-recall-'))
  const store = new MemoryStore({ get: () => undefined }, { root })
  store.ensureLayout({
    core: '# 核心记忆（永不遗忘）\n\n## 身份与称呼\n\n- [C-X] [2026-10-21] 他叫枫，她叫晓光\n',
    prefs: '# 习惯与喜好\n\n## 沟通风格\n\n- [P-X] [沟通风格] 他喜欢先结论后展开\n',
    persona: '# persona\n',
  })
  return { store, root }
}

/* ══════════════ A. 日期文件夹归拢 ══════════════ */

console.log('[A1] 新数据写进 days/YYYY-MM-DD')
{
  const { store, root } = mkStore()
  const r = store.appendDaily({
    summary: '他在做心情模块，要求不要随机。',
    keywords: ['心情', '随机'],
    title: '心情模块',
    when: new Date('2026-10-21T10:00:00'),
  })
  check('dayDir 指向 days/', store.dayDir(r.day).includes(DAYS_DIR), store.dayDir(r.day))
  check('文件真的落在 days/ 下', existsSync(join(root, 'days', r.day, 'conversations.md')))
  check('根目录下没有裸的日期文件夹', !existsSync(join(root, r.day)))
  check('listDays 认得它', store.listDays().includes(r.day), store.listDays().join(','))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[A2] 老数据（根目录下的日期文件夹）自动迁移')
{
  const { store, root } = mkStore()
  // 手工造一份「老布局」：根目录下直接一个日期文件夹
  const legacyDay = '2026-10-19'
  mkdirSync(join(root, legacyDay), { recursive: true })
  writeFileSync(join(root, legacyDay, 'conversations.md'), [
    `# ${legacyDay} 对话记忆`,
    '',
    '## 旧记忆',
    '',
    '- id: `D-OLD1`',
    '- 关键词: 迁移 / 老数据',
    '',
    '这是一条迁移前就存在的记忆。',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, legacyDay, '.meta.json'), JSON.stringify({
    day: legacyDay,
    entries: {
      'D-OLD1': {
        id: 'D-OLD1', createdAt: 1, firstSeen: 1, lastReviewed: Date.now(),
        lastSeen: 1, stability: 86400, reviews: 0, decayed: false, keywords: ['迁移'],
      },
    },
  }), 'utf8')

  check('迁移前：老文件夹在根目录', existsSync(join(root, legacyDay)))
  const moved = store.migrateDayDirs()
  check('migrateDayDirs 报告迁移了 1 个', moved.length === 1, moved.join(','))
  check('迁移后：在 days/ 下', existsSync(join(root, 'days', legacyDay)))
  check('迁移后：根目录那个不见了', !existsSync(join(root, legacyDay)))
  check('内容完整搬过去了', store.readDayMeta(legacyDay).entries['D-OLD1'] !== undefined)
  const text = store.readDayMeta(legacyDay)
  check('meta 没丢条目', Object.keys(text.entries).length === 1)

  // 幂等：再跑一次不报错、不多搬
  const again = store.migrateDayDirs()
  check('重复迁移是幂等的', again.length === 0, again.join(','))

  // 目标已存在时不能覆盖
  const { store: s2, root: root2 } = mkStore()
  mkdirSync(join(root2, 'days', '2026-10-18'), { recursive: true })
  writeFileSync(join(root2, 'days', '2026-10-18', 'conversations.md'), '新数据', 'utf8')
  mkdirSync(join(root2, '2026-10-18'), { recursive: true })
  writeFileSync(join(root2, '2026-10-18', 'conversations.md'), '老数据', 'utf8')
  s2.migrateDayDirs()
  const kept = readdirSync(join(root2, 'days', '2026-10-18'))
  check('目标已存在时不覆盖', existsSync(join(root2, '2026-10-18')), kept.join(','))
  rmSync(root, { recursive: true, force: true })
  rmSync(root2, { recursive: true, force: true })
}

console.log('\n[A3] 遗留的日期文件夹也不会被「看不见」')
{
  const { store, root } = mkStore()
  // 模拟迁移失败（文件被占用）—— 根目录仍然留着一个日期文件夹
  mkdirSync(join(root, '2026-10-17'), { recursive: true })
  writeFileSync(join(root, '2026-10-17', 'conversations.md'), '## x\n\n- id: `D-Z`\n\n留着的内容\n', 'utf8')
  check('listDays 同时扫 days/ 和根目录', store.listDays().includes('2026-10-17'), store.listDays().join(','))
  rmSync(root, { recursive: true, force: true })
}

/* ══════════════ B. 检索词 ══════════════ */

console.log('\n[B1] 中文没空格也能切出检索词')
{
  const k1 = keywordsOf('心情模块现在是怎么做的')
  check('中文长句切出片段', k1.length >= 2, k1.join('/'))
  check('不长于 12 字', k1.every((x) => x.length <= 12))

  const k2 = keywordsOf('把 desktop-memory 的 mood.mjs 改一下')
  check('英文标识符能提出', k2.some((x) => /desktop|memory|mood/i.test(x)), k2.join('/'))

  check('空文本返回空', keywordsOf('').length === 0)
  check('单字被过滤', keywordsOf('嗯').length === 0, keywordsOf('嗯').join(','))
  check('标点不算词', keywordsOf('，。！？').length === 0)
  check('有上限', keywordsOf('一 二 三 四 五 六 七 八 九 十 十一 十二', 3).length <= 3)
}

/* ══════════════ C. 每轮召回 ══════════════ */

console.log('\n[C1] 核心与偏好永远在（不管问什么）')
{
  const { store, root } = mkStore()
  const r = turnRecall({ store, query: '完全不相关的问题 xyz', budget: 6000 })
  check('含核心层', r.text.includes('核心（永不遗忘）'))
  check('含偏好层', r.text.includes('他的习惯与喜好'))
  check('含核心里的具体内容', r.text.includes('他叫枫'))
  check('含偏好里的具体内容', r.text.includes('先结论后展开'))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[C2] 相关的旧记忆能被捞出来（原来的固定注入做不到这点）')
{
  const { store, root } = mkStore()
  // 造三条不相邻的记忆，只有一条关于「心情」
  store.appendDaily({
    summary: '他在做心情模块，明确要求不要用随机数，要从对话里决定。',
    keywords: ['心情', '随机', '对话'],
    title: '心情模块',
    when: new Date('2026-10-15T10:00:00'),   // 6 天前，不在「最近 3 天」里
  })
  store.appendDaily({
    summary: '他在装 B 站插件，调了一晚上的接口。',
    keywords: ['B站', '插件'],
    title: 'B站插件',
    when: new Date('2026-10-16T10:00:00'),
  })

  const hit = turnRecall({ store, query: '心情模块现在还是随机的吗？', budget: 6000, recentDays: 1 })
  check('捞出了关于心情的那条', hit.text.includes('心情模块') || hit.text.includes('不要用随机数'), hit.text.slice(0, 120))
  check('related 计数 > 0', hit.related > 0, String(hit.related))
  check('检索词里有「心情」类片段', hit.terms.some((t) => t.includes('心情')), hit.terms.join('/'))

  const miss = turnRecall({ store, query: '今天天气怎么样', budget: 6000, recentDays: 1 })
  check('不相关的问题不硬凑旧记忆', !miss.text.includes('不要用随机数'), `related=${miss.related}`)
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[C3] 命中会续期（相当于「想起来一次」）')
{
  const { store, root } = mkStore()
  const saved = store.appendDaily({
    summary: '他要求把日期文件夹收进一个大文件夹。',
    keywords: ['日期文件夹', '目录'],
    title: '目录归拢',
    when: new Date('2026-10-10T10:00:00'),
  })
  const before = store.readDayMeta(saved.day).entries[saved.id]
  // 把它的保持率压到很低（假装 20 天没回顾）
  const meta = store.readDayMeta(saved.day)
  meta.entries[saved.id] = { ...before, lastReviewed: Date.now() - 20 * 86400_000, stability: 86400 }
  store.writeDayMeta(saved.day, meta)
  const beforeR = store.readDayMeta(saved.day).entries[saved.id].reviews

  turnRecall({ store, query: '日期文件夹要放哪儿', budget: 6000, review: true })
  const after = store.readDayMeta(saved.day).entries[saved.id]
  check('回顾次数涨了', Number(after.reviews) > Number(beforeR), `${beforeR} → ${after.reviews}`)
  check('lastReviewed 更新了', Number(after.lastReviewed) > Number(before.lastReviewed))

  // review:false 就不该动它
  const before2 = store.readDayMeta(saved.day).entries[saved.id].reviews
  turnRecall({ store, query: '日期文件夹要放哪儿', budget: 6000, review: false })
  const after2 = store.readDayMeta(saved.day).entries[saved.id].reviews
  check('review:false 不续期', Number(after2) === Number(before2), `${before2} → ${after2}`)
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[C4] 墓碑不该被捞回来占上下文')
{
  const { store, root } = mkStore()
  const saved = store.appendDaily({
    summary: '这是一条已经完全淡忘的旧记忆，只剩墓碑。',
    keywords: ['淡忘', '墓碑'],
    title: '淡忘的旧事',
    when: new Date('2026-09-01T10:00:00'),
  })
  const meta = store.readDayMeta(saved.day)
  meta.entries[saved.id] = { ...meta.entries[saved.id], level: 'tombstone', lastReviewed: 0, stability: 1 }
  store.writeDayMeta(saved.day, meta)
  const r = turnRecall({ store, query: '淡忘 墓碑', budget: 6000, recentDays: 0 })
  check('墓碑内容不进上下文', !r.text.includes('已经完全淡忘的旧记忆'), r.text.includes('墓碑') ? '出现了' : '没出现')
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[C5] 预算与最近兜底')
{
  const { store, root } = mkStore()
  for (let i = 0; i < 12; i++) {
    store.appendDaily({
      summary: `这是第 ${i} 条很长的记忆内容，`.repeat(8),
      keywords: [`k${i}`],
      title: `条目${i}`,
      when: new Date('2026-10-20T10:00:00'),
    })
  }
  const small = turnRecall({ store, query: '', budget: 2000, recentDays: 3 })
  check('预算被尊重（小预算不会爆）', small.text.length <= 2000 * 1.4, String(small.text.length))
  check('小预算下核心层还在', small.text.includes('核心（永不遗忘）'))
  check('最近兜底有内容', small.recent > 0, String(small.recent))

  const r0 = turnRecall({ store, query: '', budget: 6000, recentDays: 0 })
  check('recentDays=0 时不带近期段', !r0.text.includes('近期（最近'), r0.text.slice(0, 60))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[C6] 每轮都调一次：同一 store 连续调不会互相污染')
{
  const { store, root } = mkStore()
  store.appendDaily({ summary: '关于 hy3 模型路由的记忆。', keywords: ['hy3', '路由'], title: 'hy3 路由', when: new Date('2026-10-14T10:00:00') })
  store.appendDaily({ summary: '关于心情模块不要随机的记忆。', keywords: ['心情', '随机'], title: '心情不随机', when: new Date('2026-10-13T10:00:00') })

  const a = turnRecall({ store, query: 'hy3 路由怎么了', budget: 6000, recentDays: 0 })
  const b = turnRecall({ store, query: '心情还是随机的吗', budget: 6000, recentDays: 0 })
  check('第一次捞到 hy3', a.text.includes('hy3') || a.text.includes('路由'), a.terms.join('/'))
  check('第二次捞到心情', b.text.includes('心情'), b.terms.join('/'))
  check('两次结果不一样（按问的走）', a.text !== b.text)
  rmSync(root, { recursive: true, force: true })
}

/* ══════════════ D. 落盘格式没被改坏 ══════════════ */

console.log('\n[D1] 迁移后条目还能被拆回来')
{
  const { store, root } = mkStore()
  const r = store.appendDaily({
    summary: '一条普通记忆。',
    keywords: ['测试'],
    title: '格式检查',
    when: new Date('2026-10-21T10:00:00'),
  })
  const blocks = splitEntries(require$read(store.dayFile(r.day)))
  check('拆回 1 条', blocks.length === 1, String(blocks.length))
  check('id 对得上', blocks[0].id === r.id, blocks[0].id)
  check('正文在', blocks[0].body.includes('一条普通记忆'))
  rmSync(root, { recursive: true, force: true })
}

import { readFileSync } from 'node:fs'
function require$read(p) { return readFileSync(p, 'utf8') }

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
