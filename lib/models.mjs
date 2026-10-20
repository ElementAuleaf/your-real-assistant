/**
 * lib/models.mjs —— 给设置页用的「有哪些 provider / 模型」
 * ============================================================================
 * 两条已核实的事实决定了这里的写法：
 *   ① `ctx.llm.listProviders()` 是**同步**的，返回 `LlmProviderInfo[]`；
 *   ② `ctx.llm.listModels(provider)` 会走 `registration()` —— provider 没注册会抛
 *      `NO_ADAPTER`，而且适配器没加载完时**可能一直挂着**。
 *
 * 所以：
 *   · 每个 provider 单独 try/catch，一个挂了不影响别的；
 *   · 每个调用都套超时，绝不把设置页拖死；
 *   · 结果缓存 60 秒，避免页面每 5 秒轮询就把所有适配器问一遍。
 * ============================================================================
 */

const CACHE_MS = 60_000
let cache = { at: 0, value: null }

/** 给一个 promise 套超时；超时返回 fallback，不抛。 */
function withTimeout(p, ms, fallback) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const t = setTimeout(() => finish(fallback), ms)
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); finish(v) },
      () => { clearTimeout(t); finish(fallback) },
    )
  })
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   providers: Array<{id:string, name:string}>,
 *   models: Record<string, Array<{id:string,name:string,description?:string}>>,
 *   failures: Array<{provider:string, error:string}>,
 *   cachedAt: number,
 *   error?: string,
 * }>}
 */
export async function listRoutes(llm, { force = false, perProviderMs = 4000 } = {}) {
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, providers: [], models: {}, failures: [], cachedAt: 0, error: 'llm 服务不可用' }
  }
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value

  let raw = []
  try {
    raw = llm.listProviders() || []   // 同步，不 await
  } catch (e) {
    return { ok: false, providers: [], models: {}, failures: [], cachedAt: 0, error: String(e?.message || e) }
  }

  const providers = raw.map((p) => ({
    id: String(p?.id ?? p?.name ?? p ?? ''),
    name: String(p?.name ?? p?.id ?? p ?? ''),
  })).filter((p) => p.id)

  const models = {}
  const failures = []

  // 串行地问，每个都带超时。provider 通常只有个位数，够快。
  for (const p of providers) {
    if (typeof llm.listModels !== 'function') { models[p.id] = []; continue }
    const res = await withTimeout(
      llm.listModels(p.id),
      perProviderMs,
      { __timeout: true },
    )
    if (res && res.__timeout) {
      failures.push({ provider: p.id, error: `读模型列表超时（>${perProviderMs}ms）` })
      models[p.id] = []
      continue
    }
    if (!Array.isArray(res)) {
      failures.push({ provider: p.id, error: '读模型列表失败' })
      models[p.id] = []
      continue
    }
    models[p.id] = res.map((m) => ({
      id: String(m?.id ?? m ?? ''),
      name: String(m?.name ?? m?.id ?? m ?? ''),
      ...(m?.description ? { description: String(m.description) } : {}),
    })).filter((m) => m.id)
  }

  const value = { ok: true, providers, models, failures, cachedAt: Date.now() }
  cache = { at: Date.now(), value }
  return value
}

/** 换 provider/model 之后强制刷新一次缓存，让设置页立刻反映新选择。 */
export function invalidateRoutes() {
  cache = { at: 0, value: null }
}
