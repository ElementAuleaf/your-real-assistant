/**
 * research/news-smoke.mjs —— 伴聊「今日资讯」抓取的纯逻辑测试
 * 跑法：& "<node>" research/news-smoke.mjs
 * 全部注入假 fetch，不碰网。
 */
import {
  parseFeedXml, summarizeNews, fetchTodayNews, fetchFeed, DEFAULTS,
} from '../lib/news.mjs'

let pass = 0
let fail = 0
const check = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
  else { fail++; console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`) }
}

const RSS = `<?xml version="1.0"?>
<rss><channel>
<item><title>第一条新闻</title><link>https://a.example/1</link><pubDate>Wed, 21 Oct 2026 12:00:00 GMT</pubDate></item>
<item><title><![CDATA[带 CDATA 的第二条]]></title><link>https://a.example/2</link><pubDate>Wed, 21 Oct 2026 13:00:00 GMT</pubDate></item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Atom 条目甲</title><link href="https://b.example/1"/><published>2026-10-21T14:00:00Z</published></entry>
<entry><title>Atom 条目乙</title><link href="https://b.example/2"/><updated>2026-10-21T15:00:00Z</updated></entry>
</feed>`

console.log('[1] 解析 RSS / Atom')
{
  const r = parseFeedXml(RSS)
  check('RSS 抽出 2 条', r.length === 2, JSON.stringify(r.map((x) => x.title)))
  check('CDATA 被剥掉', r[1].title === '带 CDATA 的第二条', r[1].title)
  check('pubDate 解析成时间戳', r[0].published > 0, String(r[0].published))

  const a = parseFeedXml(ATOM)
  check('Atom 也认（entry/link@href/published）', a.length === 2 && a[0].title === 'Atom 条目甲', JSON.stringify(a.map((x) => x.title)))

  check('空输入不炸', parseFeedXml('').length === 0 && parseFeedXml(null).length === 0)
  check('没有条目的 XML 给空数组', parseFeedXml('<rss><channel></channel></rss>').length === 0)
}

console.log('\n[2] summarizeNews：新鲜度 / 去重 / 截断')
{
  const now = Date.parse('2026-10-21T15:00:00Z')
  const h = (ago) => now - ago * 3600_000
  const items = [
    { title: '新的甲', feed: 'A', published: h(2) },
    { title: '新的甲', feed: 'B', published: h(3) },   // 同标题 → 去重
    { title: '隔天的', feed: 'A', published: h(40) },  // 太旧 → 丢
    { title: '没时间的', feed: 'B', published: 0 },     // 无日期 → 保留（宁可信有）
    { title: '新的乙', feed: 'B', published: h(1) },
  ]
  const s = summarizeNews({ items, now, freshHours: 30 })
  check('5 条里去重 1、过期 1 → 剩 3 条', s.items === 3, JSON.stringify(s))
  check('隔天的被丢', !s.text.includes('隔天的'))
  check('无日期的保留', s.text.includes('没时间的'))
  check('来源聚合', s.sources.includes('A') && s.sources.includes('B'), s.sources.join(','))

  const few = summarizeNews({ items: items.slice(0, 2), maxItems: 1, now })
  check('maxItems 生效', few.items === 1)

  const big = summarizeNews({
    items: Array.from({ length: 50 }, (_, i) => ({ title: `标题${i}字`.repeat(10), feed: 'X', published: h(1) })),
    maxChars: 300, now,
  })
  check('超长被截断到 maxChars 内（含省略号）', big.text.length <= 301, String(big.text.length))
}

console.log('\n[3] fetchFeed：超时 / HTTP 错误 / 注入')
{
  const ok = await fetchFeed({ url: 'https://x/feed', fetchImpl: async () => ({ ok: true, text: async () => RSS }) })
  check('正常抓到', ok.ok && ok.items.length === 2)

  const bad = await fetchFeed({ url: 'https://x/feed', fetchImpl: async () => ({ ok: false, status: 503 }) })
  check('HTTP 503 → ok:false 带原因', !bad.ok && /503/.test(bad.error), bad.error)

  const boom = await fetchFeed({ url: 'https://x/feed', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  check('网络异常 → 不抛，带原因', !boom.ok && /ECONNREFUSED/.test(boom.error))

  const noFetch = await fetchFeed({ url: 'https://x/feed', fetchImpl: null })
  check('没有 fetch → 不炸', !noFetch.ok)

  // 超时：fetchImpl 永远挂着，靠 AbortController 掐 —— 假实现监听 signal
  const slow = await fetchFeed({
    url: 'https://x/feed', timeoutMs: 1000,
    fetchImpl: (url, opts) => new Promise((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      // 永不 resolve
    }),
  })
  check('慢源被超时掐掉', !slow.ok, slow.error)
}

console.log('\n[4] fetchTodayNews：并发 / 缓存 / 全挂')
{
  const feeds = [{ name: 'A', url: 'https://a/rss' }, { name: 'B', url: 'https://b/atom' }]
  const impl = async (url) => ({
    ok: true,
    text: async () => (String(url).includes('a/') ? RSS : ATOM),
  })
  const cache = { at: 0, text: '', items: 0, sources: [] }
  const r1 = await fetchTodayNews({ feeds, fetchImpl: impl, cache, timeoutMs: 3000 })
  check('两源合并出条目', r1.items > 2 && r1.text.length > 0, `items=${r1.items}`)
  check('写进缓存', cache.at > 0 && cache.text === r1.text)

  // 第二次走缓存：fetchImpl 一旦被调用就计数，缓存命中时必须为 0
  let calls = 0
  const counting = async (...a) => { calls++; return impl(...a) }
  const r2 = await fetchTodayNews({ feeds, fetchImpl: counting, cache, timeoutMs: 3000 })
  check('缓存命中不再真抓', r2.cached === true && calls === 0, `calls=${calls}`)
  check('缓存内容一致', r2.text === r1.text)

  const allDown = await fetchTodayNews({
    feeds, fetchImpl: async () => { throw new Error('down') }, timeoutMs: 2000,
  })
  check('全部源挂了 → 空文本但不炸', allDown.text === '' && allDown.items === 0)

  const none = await fetchTodayNews({ feeds: [], fetchImpl: impl })
  check('没配源 → 空', none.text === '')
}

console.log('\n[5] 默认值合理性')
check('默认源非空且都是 https', DEFAULTS.feeds.length >= 3 && DEFAULTS.feeds.every((f) => /^https:\/\//.test(f.url)))
check('缓存 10 分钟', DEFAULTS.cacheMs === 600_000)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
