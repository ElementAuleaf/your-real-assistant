/**
 * lib/ebbinghaus.mjs —— 艾宾浩斯遗忘曲线（真正按曲线走，而不是「到期就删」）
 * ============================================================================
 * 设计要点（这是上一版最大的逻辑错误，这里必须写清楚）：
 *
 * ❌ 上一版：每个文件夹一个 created 时间戳，`created` 一改就重来 —— 等于「只要保存过就永远年轻」
 * ❶ 一个文件夹里可能有几十条记忆，它们的年龄不一样，共用一个时钟是错的。
 * ❷ 每次写入都重置整个文件夹的时钟，会让老记忆陪着新记忆一起续命。
 * ❸ 忘了就 `rm -rf` 整组，没有「模糊记忆」这个中间态。
 *
 * ✅ 这一版：
 * ・**每条记忆各自的 `lastReviewed`**（存在 `.meta.json` 里，按 id 索引）。
 * ・曲线用**保持率** r(t) = exp(-t / S)，S 为记忆强度（stability）。
 *   每成功回顾一次，S 乘以 (1 + 间隔系数)，这就是「间隔重复」的本质。
 * ・r 低于 `forgetThreshold`（默认 0.30）才掉下一档：**先降级，不删**。
 *   降级 = 内容压缩成一行摘要 + 标记 `decayed`，仍然能被检索到，只是权重低。
 * ・低于 `deleteThreshold`（默认 0.06）才真的删除。
 * ・`core` / `preferences` 两个目录压根不参与这套计算 —— 它们没有 S，也不会过期。
 *
 * 间隔窗口沿用经典艾宾浩斯复习点（20 分钟 / 1 小时 / 9 小时 / 1 天 / 2 天 / 6 天 / 31 天），
 * 但只用来**提示什么时候该复习**；真正决定留不留的是保持率。
 * ============================================================================
 */

/** 经典复习点（秒）。下标即「第几次复习」。 */
export const REVIEW_MARKS_S = [
  20 * 60,        // 20 分钟
  60 * 60,        // 1 小时
  9 * 60 * 60,    // 9 小时
  24 * 60 * 60,   // 1 天
  2 * 24 * 3600,  // 2 天
  6 * 24 * 3600,  // 6 天
  31 * 24 * 3600, // 31 天
]

/** 每次成功回忆，强度乘这个系数（间隔重复的常见取法 1.6–2.2）。 */
export const GROWTH = 1.8
/**
 * 初始强度：10 天。
 * 取这个值是为了对上「约 31 天忘掉」的直觉：
 *   r(t) = exp(-t/S)，S=10 天时
 *     · 约 1 周   r≈0.50（还记得）
 *     · 约 12 天  r≈0.30（开始模糊，降级）
 *     · 约 31 天  r≈0.045（真的忘掉，删除）
 * 经典艾宾浩斯的原始曲线（几小时内忘掉 60%）是无意义音节的结果套到人身上会太狠。
 */
export const BASE_STABILITY_S = 10 * 24 * 3600
/** 强度上限：约 400 天。再往上就没有「遗忘」可言了，该进 core。 */
export const MAX_STABILITY_S = 400 * 24 * 3600

/** 保持率 r(t) = exp(-t / S)。 */
export function retention(elapsedS, stabilityS) {
  const s = Math.max(1, Number(stabilityS) || BASE_STABILITY_S)
  const t = Math.max(0, Number(elapsedS) || 0)
  return Math.exp(-t / s)
}

/** 记一次成功回忆：强度增长，并记录复习次数。 */
export function reinforce(entry, nowMs = Date.now()) {
  const e = entry || {}
  const stability = Math.min(MAX_STABILITY_S, Math.max(BASE_STABILITY_S, Number(e.stability) || BASE_STABILITY_S) * GROWTH)
  return {
    ...e,
    stability,
    reviews: (Number(e.reviews) || 0) + 1,
    lastReviewed: nowMs,
    lastSeen: nowMs,
  }
}

/**
 * 纯函数：给定条目和当前时间，算出它应该处在哪一档。不写盘，方便单测。
 *
 * 三档（**永远不删文件**，只是内容越来越单薄）：
 *   keep  清晰      —— 原文照旧
 *   fade  开始模糊  —— 压缩成一行（保留摘要首句 + 关键词）
 *   forget 基本忘掉  —— 只留一句话、一行，作为「这天确实聊过」的墓碑
 *
 * 存档条目（pinned / 被回顾次数很多的）不会被 forget，最多压缩到一行。
 *
 * @returns {{entry: object, action: 'keep'|'fade'|'forget', retention: number}}
 */
export function evaluate(entry, nowMs = Date.now(), opts = {}) {
  const fadeThreshold = num(opts.fadeThreshold, 0.30)
  const forgetThreshold = num(opts.forgetThreshold, 0.06)
  const firstSeen = num(entry?.firstSeen, num(entry?.lastReviewed, nowMs))
  const lastReviewed = num(entry?.lastReviewed, firstSeen)
  const stability = num(entry?.stability, BASE_STABILITY_S)
  const r = retention((nowMs - lastReviewed) / 1000, stability)

  // 手动存档的（.keep / pinned）不参与遗忘
  if (entry?.pinned) {
    if (entry?.level !== 'full') return { entry: { ...entry, level: 'full', decayed: false, decayedAt: undefined }, action: 'keep', retention: r }
    return { entry, action: 'keep', retention: r }
  }

  // 回顾过很多次 = 重要的东西，最多压到一行，绝不留墓碑
  const important = num(entry?.reviews, 0) >= num(opts.protectAfterReviews, 3)

  if (r <= forgetThreshold) {
    if (entry?.level === 'tombstone') return { entry, action: 'keep', retention: r }
    if (important) {
      if (entry?.level === 'one-line') return { entry, action: 'keep', retention: r }
      return { entry: { ...entry, level: 'one-line', decayed: true, decayedAt: nowMs }, action: 'fade', retention: r }
    }
    return { entry: { ...entry, level: 'tombstone', decayed: true, decayedAt: nowMs, forgottenAt: nowMs }, action: 'forget', retention: r }
  }

  if (r <= fadeThreshold) {
    if (entry?.level === 'one-line') return { entry, action: 'keep', retention: r }
    return { entry: { ...entry, level: 'one-line', decayed: true, decayedAt: nowMs }, action: 'fade', retention: r }
  }

  // 保持率回到及格线以上：如果之前被压过，恢复完整
  if (entry?.level && entry.level !== 'full') {
    return { entry: { ...entry, level: 'full', decayed: false }, action: 'keep', retention: r }
  }
  return { entry, action: 'keep', retention: r }
}

/** 下一次该复习的时刻（毫秒时间戳），按经典复习点 + 当前强度推算。 */
export function nextReviewAt(entry) {
  const last = num(entry?.lastReviewed, Date.now())
  const reviews = num(entry?.reviews, 0)
  const stability = num(entry?.stability, BASE_STABILITY_S)
  // 已越过所有经典复习点之后，就按保持率 0.5 的时刻来安排
  if (reviews >= REVIEW_MARKS_S.length) return last + stability * Math.LN2 * 1000
  return last + REVIEW_MARKS_S[reviews] * 1000
}

/** 给界面/提示词用的人类可读状态。 */
export function stageLabel(entry, nowMs = Date.now()) {
  const r = retention((nowMs - num(entry?.lastReviewed, nowMs)) / 1000, num(entry?.stability, BASE_STABILITY_S))
  if (entry?.level === 'tombstone') return `只剩一行（保持率 ${(r * 100).toFixed(0)}%）`
  if (entry?.level === 'one-line') return `压缩成一行（保持率 ${(r * 100).toFixed(0)}%）`
  if (r >= 0.75) return '清晰'
  if (r >= 0.45) return '有点淡'
  if (r >= 0.30) return '快忘了'
  return `随时会忘（保持率 ${(r * 100).toFixed(0)}%）`
}

/** 条目在注入/展示时实际保留多少内容。 */
export function levelOf(entry) {
  const l = entry?.level
  return l === 'tombstone' || l === 'one-line' ? l : 'full'
}

/**
 * 挑出「这一天里最重要的几条」，用于 keepPerDay 的保留策略。
 *
 * 排序依据（高到低）：
 *   1. pinned（手动存档）
 *   2. 回顾次数
 *   3. 保持率
 *   4. 关键词数量（信息量）
 *
 * @param {Array<{id:string, entry:object}>} items
 * @param {number} keepCount 保留几条
 * @param {number} nowMs
 * @returns {Set<string>} 要保留完整原文的 id
 */
export function pickImportant(items, keepCount, nowMs = Date.now()) {
  const n = Math.max(0, Number(keepCount) || 0)
  if (!items?.length) return new Set()
  const scored = items.map(({ id, entry }) => {
    const r = retention((nowMs - num(entry?.lastReviewed, nowMs)) / 1000, num(entry?.stability, BASE_STABILITY_S))
    return {
      id,
      pinned: entry?.pinned ? 1 : 0,
      reviews: num(entry?.reviews, 0),
      r,
      kws: Array.isArray(entry?.keywords) ? entry.keywords.length : 0,
    }
  })
  scored.sort((a, b) =>
    (b.pinned - a.pinned) ||
    (b.reviews - a.reviews) ||
    (b.r - a.r) ||
    (b.kws - a.kws))
  return new Set(scored.slice(0, n).map((s) => s.id))
}

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const DEFAULTS = {
  fadeThreshold: 0.30,
  forgetThreshold: 0.06,
  baseStabilityS: BASE_STABILITY_S,
}
