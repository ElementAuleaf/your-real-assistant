/**
 * lib/home.mjs —— 「记忆的家」在哪、怎么读写
 * ============================================================================
 * 记忆落盘位置默认是 `$DSH_HOME/memory`（可在设置里改）。
 * ⚠️ 不要用 `os.homedir()` 拼路径：DSH 桌面版的 home 由 `DSH_HOME` 决定，
 *    直接拼 `~` 会写到一个 DSH 根本不知道的地方，等于数据丢了。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 解析 DSH home：优先环境变量，其次 `ctx.dshHomePath()`，最后退回 `~/.dsh`。 */
export function dshHome(ctx) {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return resolve(String(env).trim())
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p()
      if (v) return resolve(String(v))
    } else if (typeof p === 'string' && p) {
      return resolve(p)
    }
  } catch { /* 拿不到就走兜底 */ }
  return join(homedir(), '.dsh')
}

/** 记忆根目录。`configured` 为空时用 `<dshHome>/memory`。 */
export function memoryRoot(ctx, configured) {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  const dir = raw ? resolve(raw) : join(dshHome(ctx), 'memory')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const SUBDIRS = {
  core: 'core',           // 永不删除：核心记忆
  preferences: 'preferences', // 永不删除：习惯与喜好
  daily: '',              // YYYY-MM-DD/ 会遗忘
}

export const CORE_FILE = 'memories.md'
export const PREFS_FILE = 'preferences.md'
export const PERSONA_FILE = 'persona.md'

export function exists(p) {
  try { statSync(p); return true } catch { return false }
}

export function readText(p, fallback = '') {
  try { return readFileSync(p, 'utf8') } catch { return fallback }
}

/**
 * 原子写：先写临时文件再 rename。
 * 定时器和工具回调都有可能同时写同一份文件；直接 writeFile 会有被读到半截内容的风险。
 */
export function writeText(p, content) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try { renameSync(tmp, p) } catch (e) {
    // Windows 上目标被占用时 rename 会失败 —— 退一步直接覆盖
    try { writeFileSync(p, content, 'utf8') } catch { /* 真写不进去就算了 */ }
    try { if (existsSync(tmp)) { /* 留着也没用 */ } } catch { /* ignore */ }
  }
  return p
}

export function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

export function writeJson(p, value) {
  return writeText(p, JSON.stringify(value, null, 2))
}

/** 本地日期 `YYYY-MM-DD`（一定要用本地时区，UTC 会在晚上 8 点后跳到第二天）。 */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 本地时间 `YYYY-MM-DD HH:mm` */
export function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${dayKey(now)} ${p(now.getHours())}:${p(now.getMinutes())}`
}

export function clock(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(now.getHours())}:${p(now.getMinutes())}`
}

/** 文件名安全化：去掉 Windows 非法字符，限长。 */
export function slug(s, max = 40) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return out || 'note'
}

/** 记忆条目的编号：`C-XXXX` / `P-XXXX` / `D-XXXX`，时间有序、不重复。 */
export function nextId(prefix = 'M') {
  const t = Date.now().toString(36).toUpperCase()
  const r = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `${prefix}-${t}${r}`
}
