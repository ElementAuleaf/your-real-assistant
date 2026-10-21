/**
 * lib/proof.mjs —— 「摘要到底用哪个模型跑的」的证据链
 * ============================================================================
 * 为什么要这个：
 *   2026-10-20，用户打开设置页看到「provider "buddy" 没有注册」，以为 hy3 摘要根本没实现。
 *   实际上摘要是好的 —— 是**启动探测**跑在适配器注册之前，拿到一个过期快照，
 *   然后这个快照被无限期缓存，界面就一直在撒谎。
 *
 *   光修探测不够。用户需要能**自己看见证据**：每次摘要用的哪个 provider/model、
 *   什么时候、耗时多久、成功还是失败。所以把它落盘，重启也不丢。
 *
 *   `counters` 是内存的，重启清零 —— 那不能当证据。这个文件才是。
 * ============================================================================
 */
import { readJson, writeJson, stamp } from './home.mjs'

const MAX_ROWS = 40

export function emptyProof() {
  return {
    /** 最近一次成功的摘要（界面上直接展示这一条） */
    lastOk: null,
    /** 最近一次失败（如果有） */
    lastFail: null,
    /** 最近若干次尝试，最新在前 */
    rows: [],
  }
}

export function normalizeProof(raw) {
  const base = emptyProof()
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    lastOk: o.lastOk && typeof o.lastOk === 'object' ? o.lastOk : null,
    lastFail: o.lastFail && typeof o.lastFail === 'object' ? o.lastFail : null,
    rows: Array.isArray(o.rows) ? o.rows.slice(0, MAX_ROWS) : [],
  }
}

/** 记一次摘要尝试。成功失败都记，失败要能看出错在哪。 */
export function record(proof, attempt) {
  const row = {
    at: Date.now(),
    stamp: stamp(),
    ok: Boolean(attempt.ok),
    provider: String(attempt.provider || ''),
    model: String(attempt.model || ''),
    ms: Number(attempt.ms) || 0,
    chunks: Number(attempt.chunks) || 0,
    sessionId: attempt.sessionId ? String(attempt.sessionId).replace(/^session-/, '').slice(0, 8) : '',
    // 失败原因（成功时为空）
    error: attempt.ok ? '' : String(attempt.error || '').slice(0, 300),
    // 成功时留一点内容，便于肉眼确认「这是模型写的，不是原文摘录」
    sample: attempt.ok ? String(attempt.sample || '').slice(0, 120) : '',
  }
  const p = normalizeProof(proof)
  p.rows = [row, ...p.rows].slice(0, MAX_ROWS)
  if (row.ok) p.lastOk = row
  else p.lastFail = row
  return p
}

/** 落盘 / 读取。 */
export function readProof(file) {
  return normalizeProof(readJson(file, null))
}

export function saveProof(file, proof) {
  try { writeJson(file, normalizeProof(proof)); return true } catch { return false }
}

/**
 * 给人看的一句话结论。设置页直接显示这个。
 *
 * ⚠️ 关键设计：**成功记录优先于探测结果。**
 *    探测只是「这一刻 provider 注册了没」，而成功记录是「真的跑通了」。
 *    有了成功记录，就不该再拿一个过期的探测失败去吓用户。
 */
export function verdict(proof, probe) {
  const p = normalizeProof(proof)
  if (p.lastOk) {
    const age = Date.now() - p.lastOk.at
    return {
      state: 'ok',
      text: `已跑通：${p.lastOk.provider}/${p.lastOk.model} · ${ago(age)} · ${(p.lastOk.ms / 1000).toFixed(1)}s`,
      provider: p.lastOk.provider,
      model: p.lastOk.model,
    }
  }
  if (p.lastFail) {
    return {
      state: 'fail',
      text: `上次失败：${p.lastFail.provider}/${p.lastFail.model} — ${p.lastFail.error || '未知错误'}`,
      provider: p.lastFail.provider,
      model: p.lastFail.model,
    }
  }
  if (probe && probe.ok === false) {
    return { state: 'unknown', text: `还没跑过摘要；探测说：${probe.error || '不可用'}`, provider: '', model: '' }
  }
  if (probe && probe.ok) {
    return {
      state: 'ready',
      text: `路由就绪（还没跑过摘要）：${probe.provider || ''}/${probe.model || ''}`.replace(/^\/|\/$/g, ''),
      provider: probe.provider || '',
      model: probe.model || '',
    }
  }
  return { state: 'unknown', text: '还没跑过摘要', provider: '', model: '' }
}

function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
