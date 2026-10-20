/**
 * test/tool-schema-smoke.mjs —— 所有工具的 schema 合法性
 * 跑法：node test/tool-schema-smoke.mjs
 *
 * 🔴 这测试锁死一个工具 schema 事故：
 *    check_taste 的 parameters 写成了 `{}`，宿主直接拒掉整轮请求：
 *      "Invalid schema for function 'check_taste':
 *       schema must be a JSON Schema of 'type: "object"', got 'type: null'"
 *    一个空对象 ≠ 合法的空参数 schema。空参数也要 type/properties/additionalProperties。
 *
 * 以后任何工具加进来，这个测试都会先把门。
 */
import { makeTools } from '../lib/tools.mjs'
import { makeTasteTools } from '../lib/tools-taste.mjs'
import { normalizeTasteState } from '../lib/taste.mjs'
import { MemoryStore } from '../lib/store.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'dm-schema-'))
const store = new MemoryStore({ get: () => undefined }, { root })
store.ensureLayout({ core: '', prefs: '', persona: '| `pet_name` | 枫 | x |' })

const base = makeTools({ store, stats: {}, log: () => {} })
const taste = makeTasteTools({
  getCfg: () => ({ tasteAskEnabled: true, tasteAskPerDay: 2, tasteAskMinGapHours: 6, tasteMuteHours: 24 }),
  getState: () => normalizeTasteState(null),
  setState: () => {},
  readPersona: () => store.readPersona(),
  writePersona: () => {},
  log: () => {},
})

const all = [...base, ...taste]
console.log(`共 ${all.length} 个工具：${all.map((t) => t.name).join(' / ')}\n`)

/** 递归确认它是一个能过的 object schema（宿主只认 type:'object' 的顶层）。 */
function schemaProblems(schema, path = 'parameters') {
  const out = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    out.push(`${path} 不是对象`)
    return out
  }
  if (schema.type !== 'object') {
    out.push(`${path}.type 必须是 "object"（现在是 ${JSON.stringify(schema.type)}）`)
  }
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    out.push(`${path}.properties 必须是对象`)
  }
  if (!('additionalProperties' in schema)) {
    out.push(`${path}.additionalProperties 没写（宿主会要求显式声明）`)
  }
  // 逐个属性看类型声明
  for (const [k, v] of Object.entries(schema.properties || {})) {
    if (!v || typeof v !== 'object') { out.push(`${path}.properties.${k} 不是对象`); continue }
    if (!v.type && !v.enum && !v.anyOf && !v.oneOf) {
      out.push(`${path}.properties.${k} 没有 type/enum`)
    }
  }
  return out
}

console.log('[1] 每个工具的 parameters 都是合法 object schema')
for (const t of all) {
  const probs = schemaProblems(t.parameters)
  check(`${t.name}`, probs.length === 0, probs.join('；') || 'ok')
}

console.log('\n[2] 每个工具都有 output.schema / output.render')
for (const t of all) {
  check(`${t.name}.output`, Boolean(t.output?.schema) && typeof t.output?.render === 'function')
}

console.log('\n[3] required 里的字段必须真的在 properties 里')
for (const t of all) {
  const req = t.parameters?.required
  if (!Array.isArray(req) || !req.length) { check(`${t.name} 无 required（可以）`, true); continue }
  const props = Object.keys(t.parameters?.properties || {})
  const missing = req.filter((r) => !props.includes(r))
  check(`${t.name}.required 一致`, missing.length === 0, missing.join(',') || 'ok')
}

console.log('\n[4] 反向确认：空对象确实会被判为非法')
{
  const probs = schemaProblems({})
  check('`parameters: {}` 被判非法', probs.length > 0, probs.join('；'))
  check('原因说得具体（type 不是 object）', probs.some((p) => /type/.test(p)))
}
{
  const probs = schemaProblems({ type: 'object', properties: {} })
  check('少了 additionalProperties 也被指出', probs.some((p) => /additionalProperties/.test(p)))
}

console.log('\n[5] 无参数工具的正确写法能过')
{
  const ok = schemaProblems({ type: 'object', properties: {}, additionalProperties: false })
  check('{type:object,properties:{},additionalProperties:false} 合法', ok.length === 0, ok.join('；'))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
