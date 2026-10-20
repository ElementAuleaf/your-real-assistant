/**
 * test/summary-route-smoke.mjs —— 摘要路由解析 + 证据链
 * 跑法：node test/summary-route-smoke.mjs
 *
 * 🔴 这套测试锁死摘要路由的一个陷阱：
 *    provider 在某些时刻没注册，而代码只会死用配置里的 provider 名，
 *    于是每次摘要都撞 NO_ADAPTER。用户要的是**某个具体模型**，不是 provider 这个壳。
 */
import { resolveSummarizerRoute, findProviderForModel } from '../lib/workflow.mjs'
import { record, normalizeProof, verdict, emptyProof } from '../lib/proof.mjs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

/** 造一个 llm：providers 列表 + 每个 provider 的模型（**异步**，和真宿主一致） */
function makeLlm(providers, models) {
  return {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (p) => models[p] || [],
  }
}

console.log('[1] provider 在的时候照用配置')
{
  const llm = makeLlm(['buddy', 'our-free-model'], { buddy: [{ id: 'hy3' }], 'our-free-model': [] })
  const r = await resolveSummarizerRoute(llm, { summarizerProvider: 'buddy', summarizerModel: 'hy3' })
  check('用的是 buddy/hy3', r.provider === 'buddy' && r.model === 'hy3', `${r.provider}/${r.model} via=${r.via}`)
  check('via = config', r.via === 'config')
}

console.log('\n[2] provider 没了，但别处有同名模型 → 自动换过去')
{
  // 这就是真实场景：buddy 掉了，但 our-free-model 里也有 hy3
  const llm = makeLlm(
    ['deepseek-official', 'our-free-model'],
    { 'deepseek-official': [{ id: 'deepseek-flash' }], 'our-free-model': [{ id: 'hy3' }, { id: 'glm-5.3' }] },
  )
  const r = await resolveSummarizerRoute(llm, { summarizerProvider: 'buddy', summarizerModel: 'hy3' })
  check('仍然拿到 hy3', r.model === 'hy3', `${r.provider}/${r.model}`)
  check('provider 换成了 our-free-model', r.provider === 'our-free-model', r.provider)
  check('via = model-fallback', r.via === 'model-fallback')
  check('记下了原本想要的 provider', r.wanted === 'buddy', String(r.wanted))
}

console.log('\n[3] provider 没了、别处也没有这个模型 → 不要瞎换')
{
  const llm = makeLlm(['our-free-model'], { 'our-free-model': [{ id: 'glm-5.3' }] })
  const r = await resolveSummarizerRoute(llm, { summarizerProvider: 'buddy', summarizerModel: 'hy3' })
  // 没有任何 provider 有 hy3，且没有会话路由 → 退回配置（让失败暴露出来，而不是静默换模型）
  check('没有同名模型时不硬凑', !r || r.model === 'hy3', r ? `${r.provider}/${r.model} via=${r.via}` : 'null')
}

console.log('\n[4] llm 服务拿不到 provider 列表时，信配置')
{
  const llm = { listProviders: () => [], listModels: async () => [] }
  const r = await resolveSummarizerRoute(llm, { summarizerProvider: 'buddy', summarizerModel: 'hy3' })
  check('空列表时按配置走', r.provider === 'buddy' && r.model === 'hy3')
}

console.log('\n[5] findProviderForModel 的健壮性（async）')
{
  const llm = {
    listProvides: () => [],
    listProviders: () => [{ id: 'a' }, { id: 'b' }],
    listModels: async (p) => {
      if (p === 'a') throw new Error('NO_ADAPTER')   // 一个 provider 问不动
      if (p === 'b') return [{ id: 'hy3' }]
      return []
    },
  }
  check('跳过报错的 provider，继续找', (await findProviderForModel(llm, ['a', 'b'], 'hy3')) === 'b')
  check('找不到返回空串', (await findProviderForModel(llm, ['a', 'b'], 'nope')) === '')
  check('listModels 不是数组也不崩', (await findProviderForModel({ listModels: async () => 'oops' }, ['x'], 'hy3')) === '')
}
{
  // 挂住的 adapter：必须被超时切断，不然整轮采集就卡这儿了
  const llm = {
    listModels: (p) => (p === 'stuck' ? new Promise(() => {}) : Promise.resolve([{ id: 'hy3' }])),
  }
  const t0 = Date.now()
  const got = await findProviderForModel(llm, ['stuck', 'ok'], 'hy3', 300)
  const ms = Date.now() - t0
  check('挂住的 provider 被超时跳过', got === 'ok', got)
  check('没有真的等死', ms < 2000, `${ms}ms`)
}

console.log('\n[6] 证据链')
{
  let p = emptyProof()
  check('初始没有记录', p.lastOk === null && p.rows.length === 0)

  p = record(p, { ok: false, provider: 'buddy', model: 'hy3', ms: 120, error: 'NO_ADAPTER: no adapter' })
  check('失败被记下', p.lastFail && p.lastFail.ok === false)
  check('失败带错误原因', /NO_ADAPTER/.test(p.lastFail.error))

  p = record(p, { ok: true, provider: 'our-free-model', model: 'hy3', ms: 46500, chunks: 1, sample: '他想着让所有会话都记住自己说的话。' })
  check('成功被记下', p.lastOk && p.lastOk.ok === true)
  check('成功记录了真实耗时', p.lastOk.ms === 46500)
  check('留了内容样本（能看出是模型写的）', p.lastOk.sample.includes('记住自己说的话'))
  check('按时间倒序，最新在前', p.rows[0].ok === true && p.rows[1].ok === false)
  check('失败记录还在（没被成功冲掉）', p.lastFail.error.includes('NO_ADAPTER'))

  // 结论：成功优先于过期的探测
  const v = verdict(p, { ok: false, error: 'provider "buddy" 没有注册' })
  check('有成功记录时，结论是「已跑通」', v.state === 'ok', v.text)
  check('结论里带模型名', v.text.includes('hy3'), v.text)
  check('不会被过期探测吓到', !v.text.includes('没有注册'))
}
{
  // 从没成功过，但探测失败 → 说实话
  const p = record(emptyProof(), { ok: false, provider: 'buddy', model: 'hy3', error: 'NO_ADAPTER' })
  const v = verdict(p, { ok: false, error: 'provider "buddy" 没有注册' })
  check('没成功过时如实显示失败', v.state === 'fail', v.text)
}
{
  const v = verdict(emptyProof(), { ok: true, provider: 'buddy', model: 'hy3' })
  check('探测就绪但没跑过 → ready', v.state === 'ready', v.text)
}

console.log('\n[7] 证据行数上限（别无限涨）')
{
  let p = emptyProof()
  for (let i = 0; i < 80; i++) p = record(p, { ok: true, provider: 'x', model: 'y', ms: 1 })
  check('最多留 40 行', p.rows.length === 40, String(p.rows.length))
  check('normalize 也能截断', normalizeProof({ rows: new Array(100).fill({ ok: true }) }).rows.length === 40)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
