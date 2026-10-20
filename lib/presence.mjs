/**
 * lib/presence.mjs —— 「他最近在哪个会话里」
 * ============================================================================
 * 为什么需要这个文件：
 *   `SessionRecord` 里**没有 updatedAt**（只有 header.createdAt），
 *   所以「哪个会话最近动过」只能自己记：
 *     ① `session/event` 每次 append 都会 fire → 更新内存里的水位；
 *     ② 水位另外落盘一份 activity.json，**重启之后还知道昨天最后聊的是哪儿**。
 *
 * 另外这里负责「他多久没说话了」——判断「要不要找他」最重要的一个信号，
 * 因为刚说完话的时候再插一句是骚扰，沉默很久了才值得开口。
 * ============================================================================
 */
import { readJson, writeJson } from './home.mjs'

/** 内存 + 落盘的活动水位。 */
export class Presence {
  constructor(file) {
    this.file = file
    this.bySession = readJson(file, {}) || {}
    this.dirty = false
  }

  /** 记一条事件：只更新水位，不做任何异步工作（这个在 fire-and-forget 监听里跑）。 */
  touch(sessionId, { seq = 0, time = Date.now(), role = '' } = {}) {
    const id = String(sessionId || '')
    if (!id) return
    const cur = this.bySession[id] || {}
    const next = {
      ...cur,
      seq: Math.max(Number(cur.seq) || 0, Number(seq) || 0),
      at: Math.max(Number(cur.at) || 0, Number(time) || 0),
    }
    // 只记录「他自己说的话」，用来算「他多久没开口」
    if (role === 'user') next.lastUserAt = Math.max(Number(cur.lastUserAt) || 0, Number(time) || 0)
    if (role === 'assistant') next.lastAssistantAt = Math.max(Number(cur.lastAssistantAt) || 0, Number(time) || 0)
    this.bySession[id] = next
    this.dirty = true
    if (Object.keys(this.bySession).length > 400) this.#prune()
  }

  #prune(keep = 200) {
    const entries = Object.entries(this.bySession)
      .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
      .slice(0, keep)
    this.bySession = Object.fromEntries(entries)
  }

  /** 最近有活动的会话（按最后活动时间倒序）。 */
  recent(limit = 10) {
    return Object.entries(this.bySession)
      .map(([id, v]) => ({ sessionId: id, at: Number(v?.at) || 0, lastUserAt: Number(v?.lastUserAt) || 0 }))
      .filter((x) => x.at > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, limit))
  }

  /** 最近活动的那个会话 id（没有就空串）。 */
  mostRecent() {
    const r = this.recent(1)
    return r.length ? r[0].sessionId : ''
  }

  /** 他上一次在某会话里开口距今多少分钟（没有任何记录返回 null）。 */
  silentMinutes(sessionId, nowMs = Date.now()) {
    const v = sessionId ? this.bySession[sessionId] : null
    if (!v) return null
    const lastUser = Number(v.lastUserAt) || 0
    if (!lastUser) return null
    return Math.max(0, Math.round((nowMs - lastUser) / 60_000))
  }

  save() {
    if (!this.dirty) return false
    try { writeJson(this.file, this.bySession); this.dirty = false; return true } catch { return false }
  }
}
