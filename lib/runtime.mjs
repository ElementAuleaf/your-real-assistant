/**
 * lib/runtime.mjs —— 定时器 / 队列 / 会话游标
 * ============================================================================
 * ⚠️ 这个文件里的每一个回调都在**定时器里**跑。未捕获异常会带走整个 DSH 进程
 *    （上一版 dsh-bili-scroll 在 2026-10-14 就是这么炸的）。所以：
 *    ① 所有 tick 一律 try/catch，catch 里只写日志；
 *    ② 同一时刻只允许一个 tick 在跑（busy 标志），慢的摘要不会叠起来；
 *    ③ 摘要是**按会话游标**做的：记住每个会话处理到哪个 seq，只处理新增部分。
 * ============================================================================
 */
import { readJson, writeJson, stamp } from './home.mjs'

/**
 * 一个不会自我叠加的循环。返回 stop()。
 *
 * ⚠️ 关于 ctx.timer 的两个坑（已对着线上服务核实）：
 *   ① `ctx.timer.timeout(cb, ms)` 返回的**就是**一个 Cordis effect 清理函数，
 *      **不存在** `ctx.timer.clearTimeout`。所以不要再把它包一层 ctx.effect，
 *      也不要写 `ctx.timer.clearTimeout && ...` 那种永远为假的守卫。
 *   ② `timeout()` 触发时自己就 dispose 了，循环必须**重新挂一次**。
 */
export function every(ctx, intervalMs, fn, { immediate = false } = {}) {
  let stopped = false
  let busy = false
  let stop = null

  const tick = async () => {
    if (stopped) return
    if (busy) return
    busy = true
    try { await fn() } catch (e) {
      try { ctx?.logger?.warn?.(`[desktop-memory] tick failed: ${e?.stack || e}`) } catch { /* ignore */ }
    } finally { busy = false }
    if (!stopped) stop = ctx.timer.timeout(() => { void tick() }, intervalMs)
  }

  if (immediate) void tick()
  else stop = ctx.timer.timeout(() => { void tick() }, intervalMs)

  return () => {
    stopped = true
    try { stop?.() } catch { /* ignore */ }
    stop = null
  }
}

/** 会话处理游标：{ [sessionId]: { seq, at, lastTurns } } */
export class Cursor {
  constructor(file) {
    this.file = file
    this.data = readJson(file, {}) || {}
  }

  get(sessionId) {
    return this.data[sessionId] || null
  }

  set(sessionId, value) {
    this.data[sessionId] = { ...(this.data[sessionId] || {}), ...value, at: Date.now() }
  }

  save() {
    try { writeJson(this.file, this.data) } catch { /* 游标丢了顶多重复摘要一次 */ }
  }

  /** 只保留最近 N 个会话，别让游标文件无限膨胀。 */
  prune(max = 400) {
    const keys = Object.keys(this.data)
    if (keys.length <= max) return
    keys
      .map((k) => [k, Number(this.data[k]?.at) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(max)
      .forEach(([k]) => { delete this.data[k] })
  }
}

/**
 * 串行队列：摘要请求一次只发一个。
 * 定时器 + 手动触发 + 多个会话同时到达时，并发打模型很容易撞限流。
 *
 * ⚠️ 一个任务失败不能毒死整条队列：这里 catch 掉的是**队列自身的传播**，
 *    任务的返回值/异常仍由调用方通过 push() 的返回值拿。
 */
export class Serial {
  constructor() { this.tail = Promise.resolve() }

  push(task) {
    const run = this.tail.then(() => task()).catch(() => undefined)
    this.tail = run
    return run
  }
}

/** 给状态页/日志用的运行快照。 */
export function makeStats() {
  return {
    startedAt: Date.now(),
    lastTickAt: 0,
    lastSweepAt: 0,
    lastCaptureAt: 0,
    captures: 0,
    summaries: 0,
    promotedCore: 0,
    promotedPrefs: 0,
    faded: 0,
    forgotten: 0,
    lastError: '',
    lastModel: '',
    running: false,
    runningSince: 0,
    note: '',
  }
}

export function noteError(stats, e) {
  stats.lastError = `${stamp()} ${String(e?.message || e).slice(0, 300)}`
}
