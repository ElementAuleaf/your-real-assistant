/**
 * test/config-merge-smoke.mjs —— 配置优先级回归测试
 * 跑法：node test/config-merge-smoke.mjs
 *
 * 🔴 这个测试锁死一个配置优先级 bug：
 *    用户已经在设置页把「主动陪聊」打开了，插件一重载又变回关闭。
 *    根因是 `{ ...用户存档, ...补丁默认值 }` —— 补丁后写，把用户的设置盖回去了。
 *
 * 优先级必须是：代码兜底 < 补丁默认 < **用户存档**
 */
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const SRC = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

console.log('[1] 源码里的合并顺序')
check('用户存档展开在补丁之后',
  /\.\.\.patchCfg,\s*\.\.\.savedCfg/.test(SRC),
  '必须是 { ...补丁, ...用户存档 }')
check('没有残留「补丁在后」的写法',
  !/\.\.\.readJson\(cfgFile,\s*\{\}\),\s*\.\.\./.test(SRC),
  '旧的 {...存档, ...config} 必须消失')
check('DEFAULTS 在最底层', /\.\.\.DEFAULTS,\s*\.\.\.patchCfg/.test(SRC))

console.log('\n[2] 行为验证（复刻合并逻辑，不依赖宿主）')
// 和 index.js 里 normalize 同样的语义：逐字段按默认值类型挑
const DEFAULTS = { companionEnabled: false, companionIntervalMinutes: 30, summarizerProvider: 'buddy' }
function normalize(src) {
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = src?.[k]
    if (v === undefined || v === null) continue
    if (typeof DEFAULTS[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
    else if (typeof DEFAULTS[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
    else if (typeof DEFAULTS[k] === 'string') { if (typeof v === 'string') out[k] = v }
  }
  return out
}
const merge = (saved, patch) => normalize({ ...DEFAULTS, ...patch, ...saved })

{
  const saved = { companionEnabled: true }          // 用户在页面上打开了
  const patch = { companionEnabled: false }         // 补丁里的出厂默认
  const r = merge(saved, patch)
  check('用户开了 → 重载后仍然是开', r.companionEnabled === true, String(r.companionEnabled))
}
{
  const r = merge({}, { companionEnabled: false })
  check('没人开过 → 用补丁默认（关）', r.companionEnabled === false)
}
{
  const r = merge({}, {})
  check('都没有 → 用代码默认（关）', r.companionEnabled === false)
}
{
  const r = merge({ companionIntervalMinutes: 45 }, { companionIntervalMinutes: 30 })
  check('数字字段同样是用户赢', r.companionIntervalMinutes === 45, String(r.companionIntervalMinutes))
}
{
  const r = merge({ companionEnabled: true }, {})
  check('补丁没这个字段时也不丢', r.companionEnabled === true)
}

console.log('\n[3] 反向确认：这个 bug 真的能复现（否则测试是假的）')
{
  // 旧写法：{ ...saved, ...patch }
  const oldWay = normalize({ ...DEFAULTS, ...{ companionEnabled: true }, ...{ companionEnabled: false } })
  check('旧写法确实会把 true 变成 false', oldWay.companionEnabled === false,
    '这证明旧代码就是 bug 源')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
