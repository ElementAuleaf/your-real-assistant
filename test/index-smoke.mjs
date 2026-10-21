/**
 * research/index-smoke.mjs —— 日期索引 + 人格参数传导
 * 跑法：& "<node>" research/index-smoke.mjs
 *
 * 两部分：
 *   A. 每个日期文件夹的索引（概要、关键词、检索走索引）
 *   B. tune_persona 改的参数**真的进提示词**（这是 2026-10-21 修的那个假生效）
 */
import { MemoryStore, splitEntries } from '../lib/store.mjs'
import { paramsToInstructions, composeWithParams } from '../lib/persona-params.mjs'
import { readParams } from '../lib/taste.mjs'
import { readText } from '../lib/home.mjs'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

/* ══════════════ A. 日期索引 ══════════════ */

const root = mkdtempSync(join(tmpdir(), 'dm-idx-'))
const store = new MemoryStore({ get: () => undefined }, { root })
store.ensureLayout({
  core: readText(new URL('../prompts/memories.md', import.meta.url).pathname.replace(/^\//, '')),
  prefs: readText(new URL('../prompts/preferences.md', import.meta.url).pathname.replace(/^\//, '')),
  persona: readText(new URL('../prompts/persona.md', import.meta.url).pathname.replace(/^\//, '')),
})

console.log('[A1] 写入记忆时自动建索引')
const r1 = store.appendDaily({
  summary: '他要求给记忆加索引，方便查找。我做了按日期的索引文件。',
  keywords: ['索引', '记忆', '查找'],
  title: '记忆索引',
  when: new Date('2026-10-21T10:00:00'),
})
const r2 = store.appendDaily({
  summary: '他在调试 hy3 模型的路由问题，发现 provider 名字和模型名字不是一回事。',
  keywords: ['hy3', '路由', 'provider'],
  title: 'hy3 路由',
  when: new Date('2026-10-21T15:00:00'),
})

const idxFile = store.dayIndexFile(r1.day)
check('索引文件已生成', existsSync(idxFile), idxFile)
const idx = store.readDayIndex(r1.day)
check('索引里有条目', idx.count === 2, String(idx.count))
check('每条有概要', idx.entries.every((e) => e.brief && e.brief.length > 0))
check('每条有关键词', idx.entries.every((e) => Array.isArray(e.keywords)))
check('有关键词汇总', Array.isArray(idx.keywords) && idx.keywords.length > 0, idx.keywords.slice(0, 5).join('/'))
check('有当天概览', Boolean(idx.overview), idx.overview)
check('概览不超过 160 字', idx.overview.length <= 160)
check('索引不含完整正文（比原文件小）', idxFile.length < store.dayFile(r1.day).length
  || (() => { try { return readFileSync(idxFile).length < readFileSync(store.dayFile(r1.day)).length } catch { return false } })())

console.log('\n[A2] 索引检索')
{
  const hits = store.searchIndex('hy3', 5)
  check('搜 hy3 有命中', hits.length >= 1, `${hits.length} 条`)
  check('命中的是 hy3 那条', hits[0].title.includes('hy3'), hits[0].title)
  check('命中结果带 brief', Boolean(hits[0].brief))
  check('命中结果带 day', Boolean(hits[0].day))

  const none = store.searchIndex('完全不存在的词xyz', 5)
  check('搜不到就是空', none.length === 0)

  const empty = store.searchIndex('', 5)
  check('空 query 返回空', empty.length === 0)
}

console.log('\n[A3] 索引与正文一致')
{
  const text = readText(store.dayFile(r1.day))
  const blocks = splitEntries(text)
  const idx2 = store.readDayIndex(r1.day)
  check('条目数和正文一致', idx2.entries.length === blocks.length, `${idx2.entries.length} vs ${blocks.length}`)
  const idsMatch = blocks.every((b) => idx2.entries.some((e) => e.id === b.id))
  check('id 全部对得上', idsMatch)
}

console.log('\n[A4] 压缩后索引跟着更新')
{
  const meta = store.readDayMeta(r1.day)
  const id = Object.keys(meta.entries)[0]
  meta.entries[id].lastReviewed = Date.now() - 40 * 86400000
  store.writeDayMeta(r1.day, meta)
  store.sweep({ keepPerDay: 0 })
  const after = store.readDayIndex(r1.day)
  const target = after.entries.find((e) => e.id === id)
  check('索引里该条的 level 变成 tombstone', target && target.level === 'tombstone', target ? target.level : '找不到')
}

console.log('\n[A5] 索引能让检索变快（先扫索引再看正文）')
{
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) store.searchIndex('索引', 5)
  const idxMs = Date.now() - t0
  const t1 = Date.now()
  for (let i = 0; i < 200; i++) store.searchDaily('索引', 5)
  const fullMs = Date.now() - t1
  console.log(`   索引检索 200 次: ${idxMs}ms ｜ 全量扫 200 次: ${fullMs}ms`)
  check('索引不慢于全量扫', idxMs <= fullMs + 50, `${idxMs}ms vs ${fullMs}ms`)
}

/* ══════════════ B. 人格参数传导 ══════════════ */

console.log('\n[B1] 参数能变成行为指令')
{
  const defaults = { intimacy: '高', emoji_level: '偶尔一个', catchphrase: '嗯哼 / 你又说这个', reassure_style: '先问细节，再给建议', technical_tone: '先结论，后展开' }
  /**
   * 🔴 2026-10-21 晚改口径：**默认值也注入**。
   *
   * 原来是「只追加非默认值」，理由是「默认值的行为已经写在核心块里了」。
   * 但事实是核心块没写「亲昵度现在是高还是中」这种离散设置 ——
   * 8 个参数里 6 个是默认值就全被跳过，她看到的设定只有一行，
   * 于是「改人格」等于没改（用户的反馈：「人格一直没有被改过」）。
   *
   * 所以这里断言反过来：**全默认值也必须产出完整的 8 条**。
   */
  const insDefault = paramsToInstructions(defaults)
  check('★ 全默认值也产出指令（不再跳过）', insDefault !== '', insDefault.slice(0, 50))
  check('★ 全默认值有 5 条（这 5 个键都在）',
    insDefault.split('\n').filter((l) => l.trim().startsWith('- ')).length === 5,
    String(insDefault.split('\n').filter((l) => l.trim().startsWith('- ')).length))

  const changed = { ...defaults, technical_tone: '放松口语' }
  const ins = paramsToInstructions(changed)
  check('改了 technical_tone 就有指令', ins.includes('放松口语'), ins)
  check('指令以行为句子形式给出', ins.includes('技术回答的口吻'))

  const more = paramsToInstructions({ ...defaults, intimacy: '低', emoji_level: '不用' })
  check('intimacy 有对应行为', more.includes('像朋友的距离'))
  check('emoji 有对应行为', more.includes('不要') && more.includes('emoji'))

  const cp = paramsToInstructions({ ...defaults, catchphrase: '诶 / 嘛' })
  check('口癖被拆成列表', cp.includes('「诶」') && cp.includes('「嘛」'), cp)
}

console.log('\n[B2] 组装后参数真的进注入文本')
{
  const core = '# 你是谁\n\n你叫晓光。'
  const params = { intimacy: '高', emoji_level: '偶尔一个', catchphrase: '嗯哼', reassure_style: '先问细节，再给建议', technical_tone: '放松口语' }
  const out = composeWithParams({ coreBlock: core, params, moodText: '## 你现在的状态\n\n心情不错。' })
  check('含核心块', out.includes('你叫晓光'))
  check('含参数层', out.includes('放松口语'))
  check('含心情层', out.includes('心情不错'))
  check('核心在参数前', out.indexOf('你是谁') < out.indexOf('放松口语'))
  check('参数在心情前', out.indexOf('放松口语') < out.indexOf('心情不错'))
  check('有优先级说明', out.includes('优先级'))
}

console.log('\n[B3] 参数段在「没有心情层」时也照样注入')
{
  /**
   * 原断言是「默认参数不制造噪音 → 没有追加段」。
   * 口径改了（默认值也注入），所以现在验的是另一件更要紧的事：
   * **没有心情层的时候，参数层不能被顺手丢掉**。
   */
  const core = '# 你是谁\n\n你叫晓光。'
  const defaults = { intimacy: '高', emoji_level: '偶尔一个', catchphrase: '嗯哼 / 你又说这个', reassure_style: '先问细节，再给建议', technical_tone: '先结论，后展开' }
  const out = composeWithParams({ coreBlock: core, params: defaults, moodText: '' })
  check('★ 没有心情层时参数段仍在', out.includes('按你的设定调整'), out.slice(0, 80))
  check('参数条数完整', out.split('\n').filter((l) => l.trim().startsWith('- ')).length >= 5,
    String(out.split('\n').filter((l) => l.trim().startsWith('- ')).length))
  check('仍然有核心块', out.includes('你叫晓光'))
}

console.log('\n[B4] 端到端：改磁盘上的 persona.md → 注入文本变化')
{
  /**
   * ⚠️ 不能直接改 `prompts/persona.md` —— 那是**模板**，
   *    发布包里它的参数表是空的（真实值在用户的 ~/.dsh/memory/persona.md）。
   *    所以这里自己写一份带值的临时 persona 到 store 里再改。
   */
  store.writePersona([
    '# persona.md',
    '',
    '## 可调参数',
    '',
    '| 参数 | 当前值 | 说明 |',
    '| --- | --- | --- |',
    '| `technical_tone` | 先结论，后展开 | 口吻 |',
    '| `intimacy` | 高 | 亲昵 |',
    '',
    '---',
    '',
    '## 核心块',
    '',
    '# 你是谁',
    '',
    '你叫晓光。',
  ].join('\n'))

  const before = readParams(store.readPersona())
  check('初始值读到「先结论，后展开」', before.technical_tone === '先结论，后展开', before.technical_tone)

  // 模拟 tune_persona：改 technical_tone
  const md = store.readPersona()
  const next = md.replace(/(\|\s*`technical_tone`\s*\|\s*)([^|]*?)(\s*\|)/, '$1特别简洁$3')
  store.writePersona(next)
  const after = readParams(store.readPersona())
  check('磁盘上的值变了', after.technical_tone === '特别简洁', after.technical_tone)
  check('确实和之前不同', before.technical_tone !== after.technical_tone, before.technical_tone + ' → ' + after.technical_tone)
  const injected = composeWithParams({ coreBlock: '你是谁', params: after, moodText: '' })
  check('新值进了注入文本', injected.includes('特别简洁'))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 占用 */ }

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
