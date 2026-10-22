/**
 * lib/news.mjs —— 给伴聊抓「今日资讯」
 * ============================================================================
 * 需求（2026-10-22，用户原话）：
 *   「主动说话的内容改为去网上搜索今日相关资讯后询问我」
 *
 * 原来的伴聊只会从「记忆 + 最近对话」里找由头，聊几天就没话了。
 * 现在每轮判断前先抓一份今日资讯塞进上下文，她开口就有真东西可聊。
 *
 * 设计：
 *   ① 不用宿主的搜索工具 —— 那些挂在 agent 会话里，定时器里没有 agent。
 *      直接走 RSS（不需要 key、没有配额、文本干净）。
 *   ② 多源并发，单个源失败不挡整体 —— 有一家通就够了。
 *   ③ 超时短（默认 12s）—— 慢源宁可放弃，别拖住整轮判断。
 *   ④ 纯函数 + 注入 fetchImpl，测试不碰网。
 *   ⑤ 带缓存（默认 10 分钟）—— 判断每 30 分钟一轮，新闻不用每轮都真去抓。
 * ============================================================================
 */

/** 内置源：中文科技/综合，XML 都很小、更新勤。想加源往这里放就行。 */
export const DEFAULT_FEEDS = [
  { name: '36氪', url: 'https://36kr.com/feed' },
  { name: '少数派', url: 'https://sspai.com/feed' },
  { name: 'V2EX', url: 'https://www.v2ex.com/index.xml' },
  { name: '阮一峰周刊', url: 'https://www.ruanyifeng.com/blog/atom.xml' },
]

export const DEFAULTS = {
  feeds: DEFAULT_FEEDS,
  timeoutMs: 12_000,
  maxItems: 8,
  maxChars: 1600,
  /** 只收多少小时内的条目 —— 「今日」资讯，隔天的没意义 */
  freshHours: 30,
  /** 缓存多少毫秒（判断 30 分钟一轮，10 分钟缓存足够新） */
  cacheMs: 10 * 60_000,
}

/** 一个极小的 XML 文本抽取：拿 <title>/<link>/<pubDate>。 */
export function parseFeedXml(xml) {
  const out = []
  if (!xml) return out
  // RSS2 <item>…</item> 或 Atom <entry>…</entry>
  const blocks = [
    ...String(xml).matchAll(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi),
  ].map((m) => m[0])
  for (const block of blocks) {
    const tag = (name) => {
      const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block)
      if (!m) return ''
      // CDATA 优先
      const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(m[1])
      return decodeXml((cdata ? cdata[1] : m[1]).trim())
    }
    const title = tag('title')
    if (!title) continue
    const link = tag('link') || tag('guid') || ''
    const pubRaw = tag('pubDate') || tag('published') || tag('updated') || ''
    out.push({ title: title.slice(0, 120), link: String(link).slice(0, 300), published: parseDate(pubRaw) })
  }
  return out
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function parseDate(s) {
  if (!s) return 0
  const t = Date.parse(String(s).trim())
  return Number.isFinite(t) ? t : 0
}

/**
 * 抓一个源。
 * @param {object} p
 * @param {Function} [p.fetchImpl] 注入的 fetch（默认全局 fetch）
 * @returns {Promise<{ok:boolean, items:Array, error?:string}>}
 */
export async function fetchFeed({ url, name = '', timeoutMs = DEFAULTS.timeoutMs, fetchImpl, signal } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!f || !url) return { ok: false, items: [], error: 'no-fetch-or-url' }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, Math.max(1000, timeoutMs)) : null
  // 外部 signal 一并挂上（采集循环被中止时这里也跟着停）
  const onOuterAbort = () => { try { ctrl?.abort() } catch { /* ignore */ } }
  try {
    signal?.addEventListener?.('abort', onOuterAbort)
    if (signal?.aborted) ctrl?.abort()
    const res = await f(url, {
      signal: ctrl?.signal,
      headers: { 'user-agent': 'dsh-desktop-memory/2.7 (companion news)' },
      redirect: 'follow',
    })
    if (!res?.ok) return { ok: false, items: [], error: `HTTP ${res?.status ?? '?'}` }
    const xml = await res.text()
    return { ok: true, items: parseFeedXml(xml).map((it) => ({ ...it, feed: name })) }
  } catch (e) {
    return { ok: false, items: [], error: String(e?.message || e).slice(0, 120) }
  } finally {
    if (timer) clearTimeout(timer)
    try { signal?.removeEventListener?.('abort', onOuterAbort) } catch { /* ignore */ }
  }
}

/**
 * 把「一份份源」整合成给模型看的资讯摘要。
 * @returns {{text:string, items:number, sources:string[]}}
 */
export function summarizeNews({ items, maxItems = DEFAULTS.maxItems, maxChars = DEFAULTS.maxChars, freshHours = DEFAULTS.freshHours, now = Date.now() }) {
  const cutoff = now - Math.max(1, freshHours) * 3600_000
  const fresh = (items || [])
    .filter((it) => it?.title && (!it.published || it.published >= cutoff))
    // 去重：同标题只留一条
    .filter((it, i, arr) => arr.findIndex((x) => x.title === it.title) === i)
  const seen = new Set()
  const picked = []
  for (const it of fresh) {
    if (picked.length >= maxItems) break
    const key = String(it.title).slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(it)
  }
  const sources = [...new Set(picked.map((it) => it.feed).filter(Boolean))]
  if (!picked.length) return { text: '', items: 0, sources: [] }
  const lines = picked.map((it) => {
    const d = it.published ? new Date(it.published) : null
    const hm = d ? `（${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}）` : ''
    return `- ${it.title}${hm}`
  })
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return { text, items: picked.length, sources }
}

/**
 * 抓一轮今日资讯（多源并发 + 缓存）。
 * 失败返回空文本 —— 搜不到资讯不挡判断，只是这一轮没得聊新闻。
 *
 * @param {object} p
 * @param {Function} [p.fetchImpl] 注入
 * @param {object}   [p.cache]     { at, text } 形状的缓存对象（调用方持有，落不落盘随意）
 * @returns {Promise<{text:string, items:number, sources:string[], cached:boolean, at:number}>}
 */
export async function fetchTodayNews({
  feeds = DEFAULTS.feeds, fetchImpl, signal,
  timeoutMs = DEFAULTS.timeoutMs, maxItems = DEFAULTS.maxItems,
  maxChars = DEFAULTS.maxChars, freshHours = DEFAULTS.freshHours,
  cache = null, cacheMs = DEFAULTS.cacheMs, now = Date.now(), log = () => {},
} = {}) {
  if (cache && Number(cache.at) && String(cache.text) && now - Number(cache.at) < cacheMs) {
    return { text: String(cache.text), items: Number(cache.items) || 0, sources: cache.sources || [], cached: true, at: Number(cache.at) }
  }

  const list = (Array.isArray(feeds) ? feeds : []).slice(0, 8)
  if (!list.length) return { text: '', items: 0, sources: [], cached: false, at: now }

  const results = await Promise.all(
    list.map((f) => fetchFeed({ url: f.url, name: f.name || f.url, timeoutMs, fetchImpl, signal })
      .catch((e) => ({ ok: false, items: [], error: String(e?.message || e) }))),
  )
  const items = results.flatMap((r) => r.items || [])
  const failed = results.filter((r) => !r.ok).length
  if (failed) log(`资讯：${failed}/${list.length} 个源没抓到`)
  const sum = summarizeNews({ items, maxItems, maxChars, freshHours, now })
  const out = { text: sum.text, items: sum.items, sources: sum.sources, cached: false, at: now }
  if (cache && sum.text) {
    cache.at = out.at
    cache.text = out.text
    cache.items = out.items
    cache.sources = out.sources
  }
  return out
}
