/**
 * research/tools-smoke.mjs —— 验证工具契约（output / execute 返回原始 JSON）
 * 跑法：& "<node>" research/tools-smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { makeTools } = await import(new URL('../lib/tools.mjs', import.meta.url))
const { MemoryStore } = await import(new URL('../lib/store.mjs', import.meta.url))
const { readText } = await import(new URL('../lib/home.mjs', import.meta.url))

const root = mkdtempSync(join(tmpdir(), 'dm-tools-'))
const store = new MemoryStore({ get: () => undefined }, { root })
store.ensureLayout({
  core: readText(new URL('../prompts/memories.md', import.meta.url).pathname.replace(/^\//, '')),
  prefs: readText(new URL('../prompts/preferences.md', import.meta.url).pathname.replace(/^\//, '')),
  persona: readText(new URL('../prompts/persona.md', import.meta.url).pathname.replace(/^\//, '')),
})

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const tools = makeTools({ store, stats: { promotedCore: 0, promotedPrefs: 0, captures: 0 }, log: () => {} })
console.log('tools:', tools.map((t) => t.name).join(', '))

console.log('\n[1] 契约字段')
for (const t of tools) {
  check(`${t.name} 声明了 output.schema`, Boolean(t.output?.schema))
  check(`${t.name} 声明了 output.render`, typeof t.output?.render === 'function')
  check(`${t.name} 有 parameters`, Boolean(t.parameters) && typeof t.parameters === 'object')
  check(`${t.name} 有 description`, typeof t.description === 'string' && t.description.length > 20)
}

console.log('\n[2] save_memory')
const save = tools.find((t) => t.name === 'save_memory')
const r1 = await save.execute({ target: 'core', section: '身份与称呼', content: '他叫 Velis。', quote: '我叫 Velis' })
check('返回原始 JSON 对象，不是 content 块', r1 && !Array.isArray(r1.content) && r1.ok === true, JSON.stringify(r1).slice(0, 100))
const rendered = save.output.render({}, r1)
check('output.render 能吃下这个返回', Array.isArray(rendered) && rendered[0].type === 'text')
check('core 里出现了这条', store.readCore().includes('他叫 Velis'))
check('保存后能序列化（无损 JSON）', (() => { try { JSON.parse(JSON.stringify(r1)); return true } catch { return false } })())

console.log('\n[3] recall_memory')
const recall = tools.find((t) => t.name === 'recall_memory')
store.appendDaily({ summary: '聊了艾宾浩斯曲线和日期文件夹。', keywords: ['艾宾浩斯', '日期文件夹'], title: '记忆插件' })
const r2 = await recall.execute({ query: '艾宾浩斯', limit: 5 })
check('搜到了', r2.ok && r2.hitCount === 1, `hitCount=${r2.hitCount}`)
check('返回可渲染', recall.output.render({}, r2)?.[0]?.type === 'text')

console.log('\n[4] review_memory')
const review = tools.find((t) => t.name === 'review_memory')
const r3 = await review.execute({ all: true })
check('全部回顾成功', r3.ok && r3.reviewed >= 1, `reviewed=${r3.reviewed}`)
const r4 = await review.execute({ days: ['2026-01-01'] })
check('空日期也不炸', r4.ok === true)

console.log('\n[5] 错误输入')
check('save_memory 空内容被拒', (await save.execute({ content: '  ' })).ok === false)
check('recall_memory 空 query 被拒', (await recall.execute({ query: '' })).ok === false)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
