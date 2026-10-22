window.__ModuleLoader__.load({
  id: '@local/desktop-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/desktop-memory'
    const CAPTURE_TIMEOUT_MS = 180_000
    const COMPANION_RUN_TIMEOUT_MS = 120_000
    const SESSION_MODES = [
      ['recent', '最近在聊的那个会话'],
      ['pinned', '固定会话（pinned）'],
      ['off', '不主动说'],
    ]
    const DECISION_LABEL = { speak: '说', silent: '不说' }

    async function jreq(method, path, body, timeoutMs) {
      const opt = { method, credentials: 'same-origin', cache: 'no-store', headers: {} }
      if (body !== undefined) {
        opt.headers['content-type'] = 'application/json'
        opt.body = JSON.stringify(body)
      }
      let timer = null
      if (timeoutMs && typeof AbortController === 'function') {
        const ctl = new AbortController()
        opt.signal = ctl.signal
        timer = setTimeout(() => { try { ctl.abort() } catch { /* ignore */ } }, timeoutMs)
      }
      try {
        const res = await fetch(API + path, opt)
        const raw = await res.text()
        let data
        try { data = raw ? JSON.parse(raw) : {} } catch {
          throw new Error(`服务器返回的不是 JSON（HTTP ${res.status}）：${String(raw).slice(0, 160)}`)
        }
        if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data || {}
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const jget = (p) => jreq('GET', p)
    const jpost = (p, b, t) => jreq('POST', p, b || {}, t)

    const errText = (e) => {
      const s = String((e && e.message) || e || '')
      return s || '未知错误'
    }

    function pct(v) {
      const n = Number(v)
      return `${Math.round((Number.isFinite(n) ? n : 0) * 100)}%`
    }

    function toneOf(v) {
      const n = Number(v) || 0
      if (n > 0.7) return 'good'
      if (n >= 0.3) return 'warn'
      return 'bad'
    }

    function relTime(ms) {
      const t = Number(ms)
      if (!t || !Number.isFinite(t)) return '—'
      const diff = t - Date.now()
      const abs = Math.abs(diff)
      const MIN = 60_000
      const HOUR = 60 * MIN
      const DAY = 24 * HOUR
      let span
      if (abs < MIN) return diff >= 0 ? '马上' : '刚刚'
      if (abs < HOUR) span = `${Math.round(abs / MIN)} 分钟`
      else if (abs < DAY) span = `${Math.round(abs / HOUR)} 小时`
      else span = `${Math.round(abs / DAY)} 天`
      return diff >= 0 ? `${span}后` : `${span}前`
    }

    const since = (ms) => (Number(ms) ? relTime(ms) : '还没')
    const absTime = (ms) => (Number(ms) ? new Date(Number(ms)).toLocaleString('zh-CN') : '')

    function clockTime(ms) {
      const t = Number(ms)
      if (!t || !Number.isFinite(t)) return '—'
      try {
        return new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      } catch {
        return new Date(t).toLocaleString('zh-CN')
      }
    }

    /** 数值输入 → 整数，带兜底与上下限（表单永远拿到一个能用的数）。 */
    function clampInt(v, fallback, min, max) {
      const n = Math.round(Number(v))
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    /** 「23:00」→ 规范的 HH:MM；写不成这样就返回 null —— 不猜、不悄悄改。 */
    function normHM(v) {
      const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v == null ? '' : v).trim())
      if (!m) return null
      const hh = Number(m[1])
      const mm = Number(m[2])
      if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }

    /** 会话 id 太长，界面上只留前 8 位（host 的日志里也是这么截的）。 */
    function shortSession(id) {
      const s = String(id || '')
      if (!s) return ''
      return s.replace(/^session-/, '').slice(0, 8) || s.slice(0, 8)
    }

    /**
     * 复刻 host 的 lib/persona.mjs::personaCore —— 只为了在输入框里**实时**显示
     * 「核心块共 N 字」。服务端返回的 core 才是权威值；这一份只用来做编辑中的预览，
     * 两边一致时界面上不出现「编辑中」的字样。
     */
    function personaBlock(markdown) {
      const src = String(markdown || '')
      if (!src.trim()) return ''
      const m = /^##\s*核心块.*$/m.exec(src)
      const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').trim()
      if (!m) return strip(src)
      const rest = src.slice(m.index + m[0].length)
      const endM = /^(?:---+\s*$|##\s)/m.exec(rest)
      return strip(endM ? rest.slice(0, endM.index) : rest)
    }

    /** 「手动记一条」可选的小节 —— 与 prompts/*.md 里的分节对齐。 */
    const SECTIONS = {
      core: ['身份与称呼', '重要的人', '重要事件与承诺', '不可忘记的约定', '时间线'],
      preferences: ['沟通风格', '作息', '工具与技术栈', '雷区 / 讨厌的事', '喜欢的东西', '正在进行的项目'],
      daily: ['手动记录'],
    }
    /** 与 host 的默认值保持一致（POST /remember 的 section 兜底）。 */
    const SECTION_DEFAULT = { core: '不可忘记的约定', preferences: '沟通风格', daily: '手动记录' }

    /* ────────────────────────── 样式 ────────────────────────── */
    // 只用 --dsw-alias-* 且**永远带兜底值** —— 深色 / 浅色两套主题都得能看。
    // 每个选择器都带 data-dm- 前缀，撞不到宿主和其它插件。
    const CSS = `
[data-dm-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-dm-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dm-hrow]{display:flex;align-items:center;gap:8px;min-height:22px;}
[data-dm-h]{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dm-grow]{flex:1;min-width:0;}
[data-dm-label]{font-size:13px;}
[data-dm-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dm-sw][data-on]{background:#3b82f6;}
[data-dm-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-dm-sw][data-on] i{left:19px;}
[data-dm-sw][disabled]{opacity:.45;cursor:default;}
[data-dm-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dm-input]:focus{outline:none;border-color:#3b82f6;}
[data-dm-input][disabled]{opacity:.55;}
[data-dm-ta]{min-height:88px;resize:vertical;line-height:18px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
[data-dm-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dm-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dm-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dm-btn][data-primary]:hover{background:#2f74e0;border-color:#2f74e0;}
[data-dm-btn][disabled]{opacity:.5;cursor:default;}
[data-dm-btn][disabled]:hover{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
[data-dm-btn][data-primary][disabled]:hover{background:#3b82f6;}
[data-dm-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-msg][data-warn]{color:#f59e0b;}
[data-dm-msg][data-good]{color:#22c55e;}
[data-dm-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:240px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dm-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-word;}
[data-dm-badge]{font-size:11px;padding:2px 7px;border-radius:6px;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dm-link]{font-size:11px;line-height:18px;padding:0;border:0;background:none;color:#3b82f6;cursor:pointer;
  font-family:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all;text-align:left;}
[data-dm-stats]{display:flex;gap:10px;flex-wrap:wrap;}
[data-dm-stat]{flex:1 1 120px;min-width:110px;padding:9px 11px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));}
[data-dm-statn]{font-size:18px;line-height:24px;font-weight:600;}
[data-dm-statl]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-day]{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));}
[data-dm-dayrow]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-dm-daydate]{font-size:12px;letter-spacing:.02em;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
[data-dm-ret]{font-size:11px;font-weight:600;white-space:nowrap;}
[data-dm-ret][data-tone="good"]{color:#22c55e;}
[data-dm-ret][data-tone="warn"]{color:#f59e0b;}
[data-dm-ret][data-tone="bad"]{color:#ef4444;}
[data-dm-hit]{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));}
[data-dm-params]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-spin]{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:-1px;margin-right:6px;
  border:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-top-color:#3b82f6;
  animation:dm-spin .7s linear infinite;}
@keyframes dm-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

/* ── 摘要模型 ── */
[data-dm-route]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));}
[data-dm-routetext]{font-size:13px;font-weight:600;word-break:break-all;letter-spacing:.02em;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
[data-dm-fieldrow]{display:flex;flex-direction:column;gap:3px;flex:1 1 200px;min-width:170px;}
[data-dm-num]{width:92px;box-sizing:border-box;padding:6px 8px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dm-num]:focus{outline:none;border-color:#3b82f6;}
[data-dm-num][disabled]{opacity:.55;}

/* ── 主动陪我说话 ── */
[data-dm-livelog]{display:flex;flex-direction:column;gap:5px;}
[data-dm-liveloglabel]{font-size:11px;line-height:16px;padding-top:2px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-logline]{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;padding:5px 9px;border-radius:8px;
  font-size:11px;line-height:16px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));}
[data-dm-logtime]{flex:none;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
[data-dm-logdec]{flex:none;font-weight:600;white-space:nowrap;}
[data-dm-logdec][data-speak]{color:#3b82f6;}
[data-dm-logreason]{flex:1 1 auto;min-width:0;word-break:break-word;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dm-logtext]{flex:1 1 100%;word-break:break-word;
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
`

    /* ────────────────────────── 小组件 ────────────────────────── */
    // ⚠️ 全部定义在 factory 作用域（不放在 Panel 里面），否则每次渲染都是新组件类型，
    //    输入框会被卸载重建 —— 打字时焦点会飞走。

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-dm-sw': '',
        'data-on': on ? '' : undefined,
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        title: on ? '已开' : '已关',
        disabled: Boolean(disabled),
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function Msg({ m }) {
      if (!m || !m.text) return null
      return h('div', {
        'data-dm-msg': '',
        'data-good': m.tone === 'good' ? '' : undefined,
        'data-warn': m.tone === 'warn' ? '' : undefined,
      }, m.text)
    }

    /** 一节：11px 小标题（右侧可放一个按钮）+ 内容 + 结果行。 */
    function Section({ title, right, msg, children }) {
      return h('div', { 'data-dm-sec': '' },
        h('div', { 'data-dm-hrow': '' },
          h('div', { 'data-dm-h': '' }, title),
          h('div', { 'data-dm-grow': '' }),
          right || null),
        msg && msg.text ? h(Msg, { m: msg }) : null,
        ...React.Children.toArray(children))
    }

    function Stat({ n, label }) {
      return h('div', { 'data-dm-stat': '' },
        h('div', { 'data-dm-statn': '' }, String(n)),
        h('div', { 'data-dm-statl': '' }, label))
    }

    /** 一个「整份文本」编辑器（核心记忆 / 习惯与喜好共用）。 */
    function Editor({ title, hint, value, rows, busy, msg, onChange, onSave, onReload }) {
      return h(Section, { title, msg },
        hint ? h('div', { 'data-dm-note': '' }, hint) : null,
        value === null
          ? h('div', { 'data-dm-note': '' }, '读取中…')
          : h('textarea', {
            'data-dm-input': '', 'data-dm-ta': '', rows: rows || 9,
            spellCheck: false,
            value: String(value),
            onChange: (e) => onChange(e.target.value),
          }),
        h('div', { 'data-dm-row': '' },
          h('button', {
            'data-dm-btn': '', 'data-primary': '', type: 'button',
            disabled: Boolean(busy) || value === null,
            onClick: onSave,
          }, '保存'),
          h('button', {
            'data-dm-btn': '', type: 'button',
            disabled: Boolean(busy),
            onClick: onReload,
          }, '重新加载'),
          h('span', { 'data-dm-note': '' }, value === null ? '' : `${String(value).length} 字`)))
    }

    /**
     * ── 日期文件夹（折叠版） ────────────────────────────────────────────────
     * 需求（2026-10-22）：「设置里面的回顾日期做一个展开栏，不然太多了」。
     *
     * 标题行常显：标题 + 天数摘要 + 展开箭头；点整行切换展开。
     * 展开后才是原来的「全部回顾」按钮 + 日期列表。
     * 状态（开/关）放组件内部 state —— 别处不需要知道它开没开。
     */
    function DaysSection({ days, msg, busy, openDay, dayText, onViewDay, onReviewDay, onPinDay, onReviewAll }) {
      const [open, setOpen] = React.useState(false)
      const n = days.length
      const title = `日期文件夹（内容会淡，文件夹永远在）${n ? ` · ${n} 天` : ''}`
      return h('div', { 'data-dm-sec': '', 'data-dm-days': '' },
        h('div', {
          'data-dm-hrow': '', 'data-dm-collapsible': '',
          role: 'button', tabIndex: 0,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((v) => !v),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } },
        },
          h('div', { 'data-dm-h': '' },
            h('span', { 'data-dm-caret': '', 'data-open': open ? '' : undefined, 'aria-hidden': 'true' }, '▸'),
            title),
          h('div', { 'data-dm-grow': '' }),
          h('span', { 'data-dm-note': '' }, open ? '' : (n ? '点开查看与回顾' : ''))),
        msg && msg.text ? h(Msg, { m: msg }) : null,
        open
          ? h('div', { 'data-dm-daysbody': '' },
            n > 0
              ? h('div', { 'data-dm-row': '' },
                h('button', {
                  'data-dm-btn': '', type: 'button', disabled: Boolean(busy),
                  onClick: onReviewAll,
                }, busy === 'review:all' ? '回顾中…' : '全部回顾'))
              : null,
            n === 0
              ? h('div', { 'data-dm-note': '' }, '还没有任何日期文件夹 —— 采集到第一批对话之后这里就会出现。')
              : null,
            ...days.map((d) => h(DayRow, {
              key: String(d && d.day),
              d,
              open: openDay === String(d && d.day),
              text: dayText,
              busy: Boolean(busy),
              onView: onViewDay,
              onReview: onReviewDay,
              onPin: onPinDay,
            })))
          : null)
    }

    /** 一个日期文件夹：日期 / 条数 / 保持率 / 状态 / 下次复习 + 查看、回顾、存档。 */
    function DayRow({ d, open, text, busy, onView, onReview, onPin }) {
      const day = d && d.day ? d.day : ''
      const pinned = Number(d && d.pinned) || 0
      const levels = (d && d.levels) || {}
      return h('div', { 'data-dm-day': '' },
        h('div', { 'data-dm-dayrow': '' },
          h('span', { 'data-dm-daydate': '' }, day || '—'),
          h('span', { 'data-dm-badge': '' }, `${Number(d && d.count) || 0} 条`),
          pinned > 0 ? h('span', { 'data-dm-badge': '' }, `存档 ${pinned}`) : null,
          h('span', {
            'data-dm-ret': '',
            'data-tone': toneOf(d && d.retention),
            title: `保持率 ${pct(d && d.retention)}`,
          }, pct(d && d.retention)),
          h('span', { 'data-dm-grow': '' }),
          h('button', {
            'data-dm-btn': '', type: 'button', disabled: Boolean(busy),
            onClick: () => onView(day),
          }, open ? '收起' : '查看'),
          h('button', {
            'data-dm-btn': '', type: 'button', disabled: Boolean(busy),
            onClick: () => onReview(day),
          }, '回顾'),
          h('button', {
            'data-dm-btn': '', type: 'button', disabled: Boolean(busy),
            title: '这一天的记忆全部标成重要，永不被压缩',
            onClick: () => onPin(day),
          }, busy === 'pin:' + day ? '存档中…' : '存档')),
        h('div', { 'data-dm-note': '' },
          `${(d && d.label) || '—'}`,
          ` ｜ 完整 ${Number(levels.full) || 0} ｜ 压缩 ${Number(levels['one-line']) || 0} ｜ 一行 ${Number(levels.tombstone) || 0}`,
          d && d.nextReviewAt
            ? ` ｜ 下次复习：${relTime(d.nextReviewAt)}（${absTime(d.nextReviewAt)}）`
            : ' ｜ 下次复习：—'),
        open ? h('pre', { 'data-dm-pre': '' }, text || '（这一天还没有内容）') : null)
    }

    /** 一条回忆命中。 */
    function Hit({ hit }) {
      const body = String((hit && hit.text) || '')
      return h('div', { 'data-dm-hit': '' },
        h('div', { 'data-dm-dayrow': '' },
          h('span', { 'data-dm-daydate': '' }, String((hit && hit.day) || '—')),
          h('span', { 'data-dm-ret': '', 'data-tone': toneOf(hit && hit.retention) }, pct(hit && hit.retention)),
          h('span', { 'data-dm-badge': '' }, String((hit && hit.id) || '')),
          h('span', { 'data-dm-grow': '' })),
        h('div', { 'data-dm-label': '' }, String((hit && hit.title) || '（无标题）')),
        Array.isArray(hit && hit.keywords) && hit.keywords.length
          ? h('div', { 'data-dm-note': '' }, '关键词：' + hit.keywords.join(' / '))
          : null,
        h('pre', { 'data-dm-pre': '' }, body.length > 400 ? `${body.slice(0, 400)}…` : (body || '（没有正文）')))
    }

    /**
     * 每 5 秒问一次 /status。只更新「服务端那一份」，不碰任何草稿。
     * 第三个返回值是**手动刷新**：保存完设置后立刻拿一次权威状态，省得等下一轮轮询
     * （不然「当前：x / y」要过 5 秒才变，看着像没保存成功）。
     */
    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      const refresh = React.useCallback(async () => {
        try {
          const d = await jget('/status')
          if (d && d.ok) { setSt(d); return d }
        } catch { /* 失败就当没刷新 —— 调用方自己决定怎么提示 */ }
        return null
      }, [])
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d && d.ok) setSt(d)
          } catch { /* 网络抖动就下次再问 —— 不往界面上刷错，免得每 5 秒闪一次 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt, refresh]
    }

    /**
     * 每 10 秒问一次 /companion。**和 /status 分开**：那一份 5 秒一次是为了让
     * 「正在采集…」及时收尾，这一份 10 秒一次就够了 —— 同一个节奏问两遍纯属浪费。
     * 同样是「只更新服务端那一份」，表单草稿由 CompanionSection 自己攥着。
     */
    function useCompanion(intervalMs) {
      const [cp, setCp] = React.useState(null)
      const refresh = React.useCallback(async () => {
        try {
          const d = await jget('/companion')
          if (d && d.ok) { setCp(d); return d }
          return d || null
        } catch { return null }
      }, [])
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/companion')
            if (alive && d && d.ok) setCp(d)
          } catch { /* 同上：静默重试 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 10_000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [cp, setCp, refresh]
    }

    /** 标签在左、开关在右的一行。 */
    function ToggleRow({ label, note, on, disabled, onChange }) {
      return h('div', { 'data-dm-row': '' },
        h('div', { 'data-dm-grow': '' },
          h('div', { 'data-dm-label': '' }, label),
          note ? h('div', { 'data-dm-note': '' }, note) : null),
        h(Switch, { on: Boolean(on), disabled, onChange }))
    }

    /**
     * ── 摘要模型 ────────────────────────────────────────────────────────────
     * 「她整理记忆时用哪个模型」。**不是**你聊天用的模型 —— 这一行必须写在脸上，
     * 否则没人分得清。
     *
     * 数据流：GET /models 拿 catalog（可能 ok:false / 某些 provider 列表为空），
     * 表单草稿由本组件自己攥着 —— 轮询 /status 永远不碰它们（和整页同一个规矩）。
     * 保存时把 provider + model 一起 POST /config，再由 Panel 刷一次 /status。
     *
     * 「模型不在目录里」是**正常情况**：buddy 适配器接受未列在目录里的 id。
     * 所以永远留着自由输入框，不做「只能从下拉里选」这种限制。
     */
    function ModelSection({ st, msg, say, busy, setBusy, onSaved }) {
      const cfg = (st && st.config) || {}
      const srvProvider = String(cfg.summarizerProvider || '')
      const srvModel = String(cfg.summarizerModel || '')

      // null = 还没读到 /models
      const [cat, setCat] = React.useState(null)
      const [catErr, setCatErr] = React.useState('')
      // 表单草稿：只有 保存 / 载入 这两个明确动作才会重置
      const [prov, setProv] = React.useState(srvProvider)
      const [model, setModel] = React.useState(srvModel)
      // 草稿是不是已经按服务端那份初始化过（只做一次，别覆盖用户输入）
      const seeded = React.useRef(false)
      const [loading, setLoading] = React.useState(false)

      React.useEffect(() => {
        if (seeded.current) return
        if (!srvProvider && !srvModel) return
        seeded.current = true
        setProv(srvProvider)
        setModel(srvModel)
      }, [srvProvider, srvModel])

      const loadModels = React.useCallback(async () => {
        setLoading(true)
        setCatErr('')
        try {
          const r = await jget('/models')
          if (!r || r.ok === false) {
            setCat(null)
            setCatErr(String((r && r.error) || '读不到模型列表'))
            return null
          }
          setCat(r)
          return r
        } catch (e) {
          setCat(null)
          setCatErr(errText(e))
          return null
        } finally { setLoading(false) }
      }, [])

      // 进页面就读一次 —— 这样下拉一出现就是满的
      React.useEffect(() => { void loadModels() }, [loadModels])

      const providers = Array.isArray(cat && cat.providers) ? cat.providers : []
      const modelsMap = (cat && cat.models) || {}
      const list = Array.isArray(modelsMap[prov]) ? modelsMap[prov] : []
      // 目录到手了但这个 provider 没有模型列表，或者整份目录根本没读到 ——
      // 契约允许这两种情况，界面就退化成「填 id」，不要装作读到过。
      const catLoading = !cat && !catErr
      const listFailed = !catLoading && list.length === 0
      // ⚠️ 优先级：/status 那份 config 才是**活的**（保存后我们会立刻刷它）；
      //    /models 里的 current 只是取目录那一刻的快照，保存完再看它就是旧的。
      //    所以先信 status，status 里没有才退回目录。
      const curProv = String(srvProvider || (cat && cat.current && cat.current.provider) || '')
      const curModel = String(srvModel || (cat && cat.current && cat.current.model) || '')
      const probe = (st && st.routeProbe) || null
      const dirty = prov !== srvProvider || model !== srvModel
      const canSave = Boolean(prov) && Boolean(model) && dirty && !busy && !loading

      /** 换 provider：模型清空（除非新 provider 的目录里正好有同名模型）。 */
      const onPickProvider = (next) => {
        setProv(next)
        const nextList = Array.isArray(modelsMap[next]) ? modelsMap[next] : []
        if (nextList.length && !nextList.some((m) => String((m && m.id) ?? m) === model)) setModel('')
      }

      const onSave = async () => {
        if (!prov) { say('先选一个 provider', 'warn'); return }
        if (!model) { say('先选或填一个模型 id', 'warn'); return }
        setBusy('save:model')
        say('')
        try {
          const r = await jpost('/config', { summarizerProvider: prov, summarizerModel: model })
          if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败')
          // 刷一次权威状态：既更新「当前」，又顺便看看新路由通不通
          const fresh = await onSaved()
          const after = (fresh && fresh.routeProbe) || null
          if (after && after.ok === false) {
            say(`已换成 ${prov} / ${model}，但这条路由探不通：${after.error || '未知原因'} —— `
              + '采集会一直失败，换一个能用的。', 'warn')
          } else {
            say(`已换成 ${prov} / ${model}`, 'good')
          }
        } catch (e) {
          say(errText(e), 'warn')
        } finally { setBusy('') }
      }

      return h(Section, { title: '摘要模型（她整理记忆时用哪个）', msg },
        // 当前路由：大字摆出来，别让人去翻状态条
        h('div', { 'data-dm-route': '' },
          h('span', { 'data-dm-routetext': '' }, `当前：${curProv || '?'} / ${curModel || '?'}`),
          dirty ? h('span', { 'data-dm-badge': '' }, '有没保存的改动') : null),

        h('div', { 'data-dm-note': '' },
          '换模型只影响「她整理记忆时用哪个模型」，不影响你聊天用的模型。'),

        h('div', { 'data-dm-row': '' },
          h('div', { 'data-dm-fieldrow': '' },
            h('div', { 'data-dm-note': '' }, 'provider'),
            h('select', {
              'data-dm-input': '', value: prov,
              // 目录还没到时不要显示成空 —— 至少要把服务端那一份摆出来
              disabled: Boolean(busy),
              onChange: (e) => onPickProvider(e.target.value),
            },
              prov && !providers.some((p) => String((p && p.id) ?? p) === prov)
                ? h('option', { value: prov }, `${prov}（当前，不在列表里）`)
                : null,
              ...providers.map((p) => {
                const id = String((p && p.id) ?? p)
                return h('option', { key: id, value: id }, String((p && p.name) || id))
              }))),
          h('div', { 'data-dm-fieldrow': '' },
            h('div', { 'data-dm-note': '' },
              '模型',
              listFailed ? '（读不到模型列表，直接填 id）' : ''),
            h('select', {
              'data-dm-input': '', value: list.some((m) => String((m && m.id) ?? m) === model) ? model : '',
              disabled: Boolean(busy) || !list.length,
              onChange: (e) => setModel(e.target.value),
            },
              h('option', { value: '' }, catLoading
                ? '（读取中…）'
                : listFailed ? '读不到模型列表' : '（从列表里挑一个）'),
              ...list.map((m) => {
                const id = String((m && m.id) ?? m)
                return h('option', {
                  key: id, value: id,
                  title: String((m && m.description) || ''),
                }, String((m && m.name) || id))
              })))),

        // 自由输入：目录里没有的 id 也得能用（buddy 就接受未上架的名字）
        h('div', { 'data-dm-row': '' },
          h('input', {
            'data-dm-input': '', 'data-dm-grow': '', type: 'text',
            spellCheck: false,
            placeholder: '也可以直接填模型 id（不在目录里的也能用）',
            value: model,
            disabled: Boolean(busy),
            onChange: (e) => setModel(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); if (canSave) void onSave() } },
          })),

        h('div', { 'data-dm-row': '' },
          h('button', {
            'data-dm-btn': '', 'data-primary': '', type: 'button',
            disabled: !canSave,
            onClick: onSave,
          }, busy === 'save:model'
            ? h('span', null, h('span', { 'data-dm-spin': '' }), '保存中…')
            : (dirty ? '保存' : '保存（没有改动）')),
          h('button', {
            'data-dm-btn': '', type: 'button',
            disabled: Boolean(busy) || loading,
            onClick: () => { void loadModels() },
          }, loading ? '读取中…' : '重新读取模型列表'),
          catErr
            ? h('span', { 'data-dm-msg': '', 'data-warn': '' }, '模型列表：' + catErr)
            : (cat && cat.cachedAt
              ? h('span', { 'data-dm-note': '' }, `目录 ${relTime(cat.cachedAt)}读过`)
              : null)),

        // 路由探测：只在**探不通**的时候占一行；通了就不刷屏
        probe && probe.ok === false
          ? h('div', { 'data-dm-msg': '', 'data-warn': '' },
            `这条路由现在探不通：${String(probe.error || '未知原因')} —— 模型不会自动换回来，`
            + '采集会一直失败，换一个能用的。')
          : null,

        providers.length === 0 && !catErr
          ? h('div', { 'data-dm-note': '' }, loading ? '读模型目录中…' : '还没读到 provider 列表。')
          : null,

        // provider 列表本身可能读不到（ok:false），这时不挡住手动填 id
        catErr
          ? h('div', { 'data-dm-note': '' },
            'providers 列表读不到也不要紧 —— 上面的 provider 下拉还在，模型 id 也可以手填。')
          : null)
    }

    /**
     * ── 主动陪我说话 ────────────────────────────────────────────────────────
     * 开关 + 节奏参数 + 「现在试一次（只预览）/ 立刻说一句」+ 最近的判断记录。
     *
     * 自己的草稿自己攥着：/companion 每 10 秒回来一份 config，直接绑的话
     * 用户正改「每天最多」就被冲了 —— 和整页那个坑是同一个。
     * 草稿只在「载入 / 保存成功 / 切换开关成功」之后按服务端那份重置。
     */
    function CompanionSection({ cp, setCp, refresh, msg, say, busy, setBusy }) {
      const cfg = (cp && cp.config) || {}
      const state = (cp && cp.state) || {}
      const log = Array.isArray(cp && cp.log) ? cp.log.slice(0, 8) : []
      const ready = Boolean(cp)

      // null = 还没载入
      const [draft, setDraft] = React.useState(null)
      const seeded = React.useRef(false)

      /** 服务端 config → 表单草稿（只取这一节管得到的字段）。 */
      const toDraft = React.useCallback((c) => ({
        enabled: Boolean(c && c.enabled),
        intervalMinutes: String(Number(c && c.intervalMinutes) || 30),
        minGapMinutes: String(Number.isFinite(Number(c && c.minGapMinutes)) ? Number(c.minGapMinutes) : 90),
        maxPerDay: String(Number.isFinite(Number(c && c.maxPerDay)) ? Number(c.maxPerDay) : 6),
        quietStart: String((c && c.quietStart) || '23:00'),
        quietEnd: String((c && c.quietEnd) || '09:00'),
        sessionMode: String((c && c.sessionMode) || 'recent'),
      }), [])

      React.useEffect(() => {
        if (seeded.current) return
        if (!ready) return
        seeded.current = true
        setDraft(toDraft(cfg))
      }, [ready, cfg, toDraft])

      const d = draft || toDraft(cfg)
      const setField = (k, v) => setDraft((old) => ({ ...toDraft(cfg), ...(old || {}), [k]: v }))

      const submit = async (patch) => {
        const r = await jpost('/companion', patch)
        if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败')
        const nextCfg = r.config || { ...cfg, ...patch }
        // ⚠️ 只把**这次提交的那几个字段**按服务端回来的值对齐，**不**整份重置草稿 ——
        //    否则「拨一下开关」会把用户还没保存的数字一起冲掉。
        setDraft((old) => {
          const base = old || toDraft(cfg)
          const merged = { ...base }
          for (const k of Object.keys(patch)) {
            const v = nextCfg[k] !== undefined ? nextCfg[k] : patch[k]
            if (typeof v === 'boolean') merged[k] = v
            else if (k === 'sessionMode' || k === 'quietStart' || k === 'quietEnd') merged[k] = String(v)
            else merged[k] = String(Number(v))
          }
          return merged
        })
        setCp((old) => (old ? { ...old, config: nextCfg } : old))
        return r
      }

      /** 所有数字/时刻字段一起存 —— 一个「保存」比四个各自保存好懂。 */
      const onSaveNumbers = async () => {
        const intervalMinutes = clampInt(d.intervalMinutes, 30, 1, 24 * 60)
        const minGapMinutes = clampInt(d.minGapMinutes, 90, 0, 24 * 60)
        const maxPerDay = clampInt(d.maxPerDay, 6, 0, 100)
        const quietStart = normHM(d.quietStart)
        const quietEnd = normHM(d.quietEnd)
        if (quietStart === null || quietEnd === null) {
          say('安静时间要写成 23:00 这种样子（24 小时制）', 'warn')
          return
        }
        setBusy('cp:save')
        say('')
        try {
          await submit({
            intervalMinutes, minGapMinutes, maxPerDay,
            quietStart, quietEnd, sessionMode: d.sessionMode,
          })
          say(`节奏已保存：每 ${intervalMinutes} 分钟看一次，最小间隔 ${minGapMinutes} 分钟，`
            + `每天最多 ${maxPerDay} 次，安静时间 ${quietStart}–${quietEnd}`, 'good')
          // 顺手刷一次，让「下次检查」按新间隔算
          if (refresh) void refresh()
        } catch (e) {
          say(errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onToggle = async (v) => {
        setBusy('cp:toggle')
        say('')
        try {
          await submit({ enabled: Boolean(v) })
          say(v
            ? '已打开 —— 她会按下面的节奏自己判断要不要找你'
            : '已关掉 —— 她不会再主动开口（设好的参数都还在）', 'good')
        } catch (e) {
          say(errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onMode = async (mode) => {
        setField('sessionMode', mode)
        setBusy('cp:mode')
        say('')
        try {
          await submit({ sessionMode: mode })
          const label = (SESSION_MODES.find((x) => x[0] === mode) || [])[1] || mode
          say(mode === 'off' ? '已设成「不主动说」' : `已设成「${label}」`, 'good')
        } catch (e) {
          say(errText(e), 'warn')
        } finally { setBusy('') }
      }

      /**
       * 跑一轮判断。dryRun=true 只预览、不发 —— 界面上必须把这句话说清楚，
       * 不然「试一次」点了没动静会让人以为坏了。
       */
      const onRun = async (dryRun) => {
        setBusy(dryRun ? 'cp:dry' : 'cp:run')
        say('')
        try {
          const r = await jpost('/companion/run', { dryRun: Boolean(dryRun) }, COMPANION_RUN_TIMEOUT_MS)
          if (!r || r.ok === false) {
            const why = (r && r.error) || '判断失败'
            throw new Error(why === 'no-route' ? '没有可用的模型路由 —— 先在上面选好摘要模型' : why)
          }
          const spoke = r.decision === 'speak'
          const head = spoke ? '判定：说' : '判定：不说'
          const tail = r.reason ? ` ｜ 原因：${r.reason}` : ''
          if (dryRun) {
            say(spoke
              ? `预览（没发出去）｜ ${head}${tail} ｜ 她会说：「${String(r.text || '')}」`
              : `预览（没发出去）｜ ${head}${tail}`, spoke ? 'good' : '')
          } else if (spoke && r.delivered) {
            say(`已说出去${r.sessionId ? `（会话 ${shortSession(r.sessionId)}）` : ''}：`
              + `「${String(r.text || '')}」${tail}`, 'good')
          } else {
            say(`${head}${tail} —— 这一轮没有开口`, '')
          }
          if (refresh) void refresh()
        } catch (e) {
          const m = errText(e)
          say(/aborted|abort/i.test(m)
            ? '等了太久（超过 2 分钟）—— 模型可能卡住了，看下面的判断记录'
            : m, 'warn')
        } finally { setBusy('') }
      }

      const todayCount = Number(state.todayCount) || 0
      const maxPerDayShown = Number(cfg.maxPerDay) || 0
      const lastDecision = String(state.lastDecision || '')
      const lastText = String(state.lastText || '')
      const lastReason = String(state.lastReason || '')

      return h(Section, { title: '主动陪我说话', msg },
        h('div', { 'data-dm-note': '' },
          `每 ${Number(cfg.intervalMinutes) || 30} 分钟她会自己判断一次：现在要不要主动找你说句话。`
          + '不想说就不说，不会刷屏。'),

        h(ToggleRow, {
          label: ready ? (d.enabled ? '主动说话已打开' : '主动说话已关闭') : '读取中…',
          note: '总开关。关着的时候到点也不会判断。',
          on: Boolean(d.enabled),
          disabled: Boolean(busy) || !ready,
          onChange: onToggle,
        }),

        // ── 节奏 ──
        h('div', { 'data-dm-row': '' },
          h('div', { 'data-dm-fieldrow': '' },
            h('div', { 'data-dm-note': '' }, '检查间隔（分钟）'),
            h('input', {
              'data-dm-num': '', type: 'number', min: 1, step: 1,
              value: d.intervalMinutes, disabled: Boolean(busy) || !ready,
              onChange: (e) => setField('intervalMinutes', e.target.value),
            })),
          h('div', { 'data-dm-fieldrow': '' },
            h('div', { 'data-dm-note': '' }, '最小间隔（分钟）'),
            h('input', {
              'data-dm-num': '', type: 'number', min: 0, step: 1,
              value: d.minGapMinutes, disabled: Boolean(busy) || !ready,
              onChange: (e) => setField('minGapMinutes', e.target.value),
            })),
          h('div', { 'data-dm-fieldrow': '' },
            h('div', { 'data-dm-note': '' }, '每天最多（次）'),
            h('input', {
              'data-dm-num': '', type: 'number', min: 0, step: 1,
              value: d.maxPerDay, disabled: Boolean(busy) || !ready,
              onChange: (e) => setField('maxPerDay', e.target.value),
            }))),

        // ── 安静时间 ──
        h('div', { 'data-dm-note': '' }, '安静时间'),
        h('div', { 'data-dm-row': '' },
          h('div', { 'data-dm-fieldrow': '' },
            h('input', {
              'data-dm-input': '', type: 'time', 'aria-label': '安静时间开始',
              // value 只在**能解析**的时候规范化；解析不了就留空，别偷偷改成默认值
              // —— 否则用户清空重打时会被表单拽回 23:00，很难受。
              value: normHM(d.quietStart) || '', disabled: Boolean(busy) || !ready,
              onChange: (e) => setField('quietStart', e.target.value),
            })),
          h('div', { 'data-dm-fieldrow': '' },
            h('input', {
              'data-dm-input': '', type: 'time', 'aria-label': '安静时间结束',
              value: normHM(d.quietEnd) || '', disabled: Boolean(busy) || !ready,
              onChange: (e) => setField('quietEnd', e.target.value),
            }))),
        h('div', { 'data-dm-note': '' },
          `安静时间 ${normHM(d.quietStart) || '—'} 到 ${normHM(d.quietEnd) || '—'}：`
          + '这段时间她不会主动开口。'),

        h('div', { 'data-dm-row': '' },
          h('div', { 'data-dm-fieldrow': '' },
            h('div', { 'data-dm-note': '' }, '在哪个会话里说'),
            h('select', {
              'data-dm-input': '', value: d.sessionMode,
              disabled: Boolean(busy) || !ready,
              onChange: (e) => onMode(e.target.value),
            },
              ...SESSION_MODES.map(([v, label]) => h('option', { key: v, value: v }, label))))),

        h('div', { 'data-dm-row': '' },
          h('button', {
            'data-dm-btn': '', 'data-primary': '', type: 'button',
            disabled: Boolean(busy) || !ready,
            onClick: onSaveNumbers,
          }, busy === 'cp:save'
            ? h('span', null, h('span', { 'data-dm-spin': '' }), '保存中…')
            : '保存设置')),

        // ── 立刻跑一轮 ──
        h('div', { 'data-dm-row': '' },
          h('button', {
            'data-dm-btn': '', type: 'button',
            disabled: Boolean(busy) || !ready,
            onClick: () => onRun(true),
          }, busy === 'cp:dry'
            ? h('span', null, h('span', { 'data-dm-spin': '' }), '判断中…')
            : '现在试一次（只预览不发）'),
          h('button', {
            'data-dm-btn': '', type: 'button',
            disabled: Boolean(busy) || !ready,
            onClick: () => onRun(false),
          }, busy === 'cp:run'
            ? h('span', null, h('span', { 'data-dm-spin': '' }), '说出去中…')
            : '立刻说一句')),
        h('div', { 'data-dm-note': '' },
          '这两个按钮都会真的跑一轮判断（要调模型，可能要几十秒）。「只预览」不会把话发出去；',
          '「立刻说一句」会真的发进会话。'),

        // ── 现在的状态 ──
        h('div', { 'data-dm-kv': '' },
          '上次判断：',
          h('span', { title: absTime(state.lastAt) }, since(state.lastAt)),
          lastDecision
            ? ` ｜ 判定：${DECISION_LABEL[lastDecision] || lastDecision}`
            : ' ｜ 判定：还没判断过',
          lastReason ? ` ｜ 原因：${lastReason}` : '',
          h('br'),
          `今日已说 ${todayCount} / 上限 ${maxPerDayShown || '不限'}`,
          h('br'),
          '下次检查：',
          h('span', { title: absTime(state.nextAt) }, since(state.nextAt))),

        lastText
          ? h('div', { 'data-dm-note': '' }, `上次说的话：「${lastText}」`)
          : null,

        // ── 最近的判断记录 ──
        log.length
          ? h('div', { 'data-dm-livelog': '' },
            h('div', { 'data-dm-liveloglabel': '' }, `最近的判断（${log.length} 条）`),
            ...log.map((it, i) => {
              const decision = String((it && it.decision) || '')
              const reason = String((it && it.reason) || '')
              const text = String((it && it.text) || '')
              return h('div', {
                key: `${Number(it && it.at) || 0}#${i}`, 'data-dm-logline': '',
              },
                h('span', { 'data-dm-logtime': '', title: absTime(it && it.at) }, clockTime(it && it.at)),
                h('span', {
                  'data-dm-logdec': '',
                  'data-speak': decision === 'speak' ? '' : undefined,
                }, DECISION_LABEL[decision] || decision || '—'),
                h('span', { 'data-dm-logreason': '' }, reason || '（没写原因）'),
                text ? h('span', { 'data-dm-logtext': '' }, `「${text}」`) : null)
            }))
          : h('div', { 'data-dm-note': '' },
            ready ? '还没有判断记录 —— 打开开关之后每轮判断都会记在这里。' : '读取中…'),

        !ready && !busy
          ? h('div', { 'data-dm-msg': '', 'data-warn': '' },
            '读不到主动说话的配置 —— 可能是后台路由还没挂上，过一会儿会自动重试。')
          : null)
    }

    /* ────────────────────────── 设置页正文 ────────────────────────── */

    function Panel() {
      const [st, setSt, refreshStatus] = useStatus(5000)
      const [cp, setCp, refreshCp] = useCompanion(10_000)
      const [busy, setBusy] = React.useState('')
      const [msgs, setMsgs] = React.useState({})

      // 摘要模型 / 主动说话这两节：表单草稿在各自组件内部（同一个「轮询不动草稿」的规矩），
      // 结果行走下面这把 say/M —— 和整页其它节一样，busy 也是同一把锁。

      // ⚠️ 草稿：null = 还没载入。轮询 /status **永远不动它们**。
      //    只有 保存 / 恢复默认 / 重新加载 这三个明确动作才会重置。
      const [personaDraft, setPersonaDraft] = React.useState(null)
      const [personaCore, setPersonaCore] = React.useState('')
      const [coreDraft, setCoreDraft] = React.useState(null)
      const [prefsDraft, setPrefsDraft] = React.useState(null)

      // 日期文件夹：一次只展开一个
      const [openDay, setOpenDay] = React.useState('')
      const [dayText, setDayText] = React.useState('')

      // 手动记一条
      const [remTarget, setRemTarget] = React.useState('core')
      const [remSection, setRemSection] = React.useState(SECTION_DEFAULT.core)
      const [remText, setRemText] = React.useState('')

      // 回忆测试：null = 还没搜过
      const [query, setQuery] = React.useState('')
      const [hits, setHits] = React.useState(null)

      // 日志：null = 收起的
      const [logText, setLogText] = React.useState(null)

      const say = (key, text, tone) => {
        setMsgs((old) => ({ ...old, [key]: text ? { text: String(text), tone: tone || '' } : null }))
      }
      const M = (key) => msgs[key]

      /* ── 首次载入：三份可编辑文本（只做一次） ── */
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const [p, ev] = await Promise.all([jget('/persona'), jget('/evergreen')])
            if (!alive) return
            if (p && p.ok) {
              setPersonaDraft(p.content || '')
              setPersonaCore(String(p.core || ''))
            } else {
              setPersonaDraft('')
              say('persona', '读不到人格：' + ((p && p.error) || '未知原因'), 'warn')
            }
            if (ev && ev.ok) {
              setCoreDraft((ev.core && ev.core.content) || '')
              setPrefsDraft((ev.preferences && ev.preferences.content) || '')
            } else {
              setCoreDraft('')
              setPrefsDraft('')
              say('core', '读不到核心记忆：' + ((ev && ev.error) || '未知原因'), 'warn')
            }
          } catch (e) {
            if (!alive) return
            setPersonaDraft(''); setCoreDraft(''); setPrefsDraft('')
            say('persona', '载入失败：' + errText(e), 'warn')
          }
        })()
        return () => { alive = false }
      }, [])

      /* ── 复制 ── */
      const copy = async (key, text) => {
        const v = String(text || '')
        if (!v) { say(key, '没有可复制的路径', 'warn'); return }
        try {
          await navigator.clipboard.writeText(v)
          say(key, '已复制：' + v, 'good')
        } catch {
          // 兜底：至少把路径摊出来，手动选中也能复制
          say(key, '复制失败 —— 路径是：' + v, 'warn')
        }
      }

      /* ── 总开关 ── */
      const onToggleEnabled = async (v) => {
        setBusy('enabled')
        try {
          const r = await jpost('/config', { enabled: Boolean(v) })
          if (!r.ok) throw new Error(r.error || '保存失败')
          setSt((old) => (old ? { ...old, enabled: Boolean(v), config: r.config || old.config } : old))
          say('status', v ? '记忆已打开' : '记忆已关闭 —— 不再自动采集，但已经记下的东西都还在', 'good')
        } catch (e) {
          say('status', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 人格 ── */
      const onSavePersona = async () => {
        setBusy('save:persona')
        try {
          const r = await jpost('/persona', { content: String(personaDraft == null ? '' : personaDraft) })
          if (!r.ok) throw new Error(r.error || '保存失败')
          const core = String(r.core || '')
          setPersonaCore(core)
          say('persona', `已保存 —— 核心块 ${core.length} 字，会注入每次会话的系统提示词`, 'good')
        } catch (e) {
          say('persona', errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onResetPersona = async () => {
        setBusy('reset:persona')
        try {
          const r = await jpost('/persona/reset', {})
          if (!r.ok) throw new Error(r.error || '没有可恢复的默认人格')
          // 明确动作 ⇒ 允许重置草稿；顺带再读一次拿权威的 core
          const g = await jget('/persona')
          setPersonaDraft(g && g.ok ? (g.content || '') : (r.content || ''))
          setPersonaCore(g && g.ok ? String(g.core || '') : personaBlock(r.content || ''))
          say('persona', '已恢复成插件自带的默认人格', 'good')
        } catch (e) {
          say('persona', errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onReloadPersona = async () => {
        setBusy('reload:persona')
        try {
          const g = await jget('/persona')
          if (!g.ok) throw new Error(g.error || '读不到人格')
          setPersonaDraft(g.content || '')
          setPersonaCore(String(g.core || ''))
          say('persona', '已从磁盘重新载入 —— 刚才没保存的改动被丢掉了')
        } catch (e) {
          say('persona', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 核心记忆 / 习惯与喜好 ── */
      const onSaveEvergreen = async (kind) => {
        setBusy('save:' + kind)
        const content = kind === 'core' ? coreDraft : prefsDraft
        try {
          const r = await jpost('/evergreen', { kind, content: String(content == null ? '' : content) })
          if (!r.ok) throw new Error(r.error || '保存失败')
          say(kind, kind === 'core' ? '核心记忆已保存' : '习惯与喜好已保存', 'good')
        } catch (e) {
          say(kind, errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onReloadEvergreen = async (kind) => {
        setBusy('reload:' + kind)
        try {
          const ev = await jget('/evergreen')
          if (!ev.ok) throw new Error(ev.error || '读不到')
          if (kind === 'core') setCoreDraft((ev.core && ev.core.content) || '')
          else setPrefsDraft((ev.preferences && ev.preferences.content) || '')
          say(kind, '已从磁盘重新载入 —— 刚才没保存的改动被丢掉了')
        } catch (e) {
          say(kind, errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 日期文件夹 ── */
      const onViewDay = async (day) => {
        if (!day) return
        if (openDay === day) { setOpenDay(''); return }   // 再点一次收起
        setBusy('day:' + day)
        try {
          const r = await jget('/day?day=' + encodeURIComponent(day))
          if (!r.ok) throw new Error(r.error || '读不到这一天')
          setDayText(String(r.content || ''))
          setOpenDay(day)
        } catch (e) {
          say('days', errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onReviewDay = async (day) => {
        setBusy('review:' + day)
        try {
          const r = await jpost('/review', { day })
          if (!r.ok) throw new Error(r.error || '回顾失败')
          say('days', `${day}：回顾 ${Number(r.reviewed) || 0} 条 —— 遗忘时钟重新计时了`, 'good')
        } catch (e) {
          say('days', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /** 存档一整天：标记为重要，内容再也不被压缩。 */
      const onPinDay = async (day) => {
        setBusy('pin:' + day)
        try {
          const r = await jpost('/pin', { day })
          if (!r.ok) throw new Error(r.error || '存档失败')
          say('days', `${day}：已存档 ${Number(r.pinned) || 0} 条 —— 这一天的记忆不会再被压缩`, 'good')
        } catch (e) {
          say('days', errText(e), 'warn')
        } finally { setBusy('') }
      }

      const onReviewAll = async () => {
        setBusy('review:all')
        try {
          const r = await jpost('/review', { all: true })
          if (!r.ok) throw new Error(r.error || '回顾失败')
          say('days', `全部回顾完：续期 ${Number(r.reviewed) || 0} 条`, 'good')
        } catch (e) {
          say('days', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 手动记一条 ── */
      const onRemember = async () => {
        const content = String(remText || '').trim()
        if (!content) { say('remember', '先写点什么再点「记下」', 'warn'); return }
        setBusy('remember')
        try {
          const r = await jpost('/remember', { target: remTarget, section: remSection, content })
          if (!r.ok) throw new Error(r.error || '没记下来')
          setRemText('')
          const where = remTarget === 'daily' ? `今天（${r.day || ''}）的日常记忆`
            : remTarget === 'core' ? '核心记忆' : '习惯与喜好'
          // ⚠️ 不自动重置那一层的编辑框（草稿只在明确动作后重置）—— 给个提示让他们自己点「重新加载」
          const stale = remTarget === 'daily' ? '' : ' ｜ 上面那一层的编辑框还是旧内容，要看新的点「重新加载」'
          say('remember', `已记下（${r.id || '?'}）→ ${where}${stale}`, 'good')
        } catch (e) {
          say('remember', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 回忆测试 ── */
      const onRecall = async () => {
        const q = String(query || '').trim()
        if (!q) { say('recall', '先输入要回忆的内容', 'warn'); return }
        setBusy('recall')
        try {
          const r = await jpost('/recall', { query: q, limit: 8, review: true })
          if (!r.ok) throw new Error(r.error || '回忆失败')
          const list = Array.isArray(r.hits) ? r.hits : []
          setHits(list)
          say('recall', list.length ? `找到 ${list.length} 条` : '一条都没找到', list.length ? 'good' : '')
        } catch (e) {
          say('recall', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 操作 ── */
      const onCapture = async () => {
        setBusy('capture')
        say('ops', '')
        try {
          const r = await jpost('/capture', {}, CAPTURE_TIMEOUT_MS)
          if (!r.ok) {
            const why = r.error === 'disabled' ? '记忆是关着的 —— 先把上面的开关打开'
              : r.error === 'already running' ? '已经有一轮在跑了，等它跑完'
                : r.error === 'llm 服务不可用' ? '模型服务没挂上（llm 不可用）'
                  : (r.error || '未知原因')
            throw new Error(why)
          }
          const cap = Number(r.captured) || 0
          const skip = Number(r.skipped) || 0
          const fail = Number(r.failed) || 0
          say('ops', `新增 ${cap} · 跳过 ${skip} · 失败 ${fail}`, fail ? 'warn' : 'good')
          if (Array.isArray(r.status && r.status.days)) {
            // 采集完顺便刷新一次状态，省得等下一轮轮询
            setSt(r.status)
          }
        } catch (e) {
          const msg = errText(e)
          say('ops', /aborted|abort/i.test(msg) ? '采集中等太久（超过 3 分钟）—— 可能模型卡住了，看下面的日志' : msg, 'warn')
        } finally { setBusy('') }
      }

      const onSweep = async () => {
        setBusy('sweep')
        try {
          const r = await jpost('/sweep', {})
          if (!r.ok) throw new Error(r.error || '扫描失败')
          const faded = Array.isArray(r.faded) ? r.faded.length : (Number(r.faded) || 0)
          const gone = Array.isArray(r.forgotten) ? r.forgotten.length : (Number(r.forgotten) || 0)
          say('ops', `扫完了：压缩 ${faded} 条 · 淡成一行 ${gone} 条（文件夹都还在）`, 'good')
          if (r.status && Array.isArray(r.status.days)) setSt(r.status)
        } catch (e) {
          say('ops', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ── 日志 ── */
      const onToggleLog = async () => {
        if (logText !== null) { setLogText(null); return }
        setBusy('log')
        try {
          const r = await jget('/log')
          if (!r.ok) throw new Error(r.error || '读不到日志')
          setLogText(String(r.text || ''))
        } catch (e) {
          say('log', errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* ────────────────────────── 渲染 ────────────────────────── */

      if (!st) {
        return h('div', { 'data-dm-page': '' },
          h('div', { 'data-dm-note': '' }, '读状态中…'))
      }

      const cfg = st.config || {}
      const days = Array.isArray(st.days) ? st.days : []
      const counters = st.counters || {}
      const params = st.personaParams || {}
      const tools = Array.isArray(st.tools) ? st.tools : []

      // 人格：编辑中的核心块字数（实时）+ 服务端那份（权威）
      // 用**整段比对**判断「有没有没保存的改动」，别拿字数比 —— 改一个字字数不变。
      const draftBlock = personaDraft === null ? null : personaBlock(personaDraft)
      const coreLen = draftBlock === null ? String(personaCore || '').length : draftBlock.length
      const coreEditing = draftBlock !== null && draftBlock.trim() !== String(personaCore || '').trim()

      return h('div', { 'data-dm-page': '' },

        /* ── 1. 状态条 ── */
        h(Section, { title: '状态', msg: M('status') },
          h('div', { 'data-dm-row': '' },
            h('div', { 'data-dm-grow': '' },
              h('div', { 'data-dm-label': '' }, st.enabled ? '记忆已开启' : '记忆已关闭'),
              h('div', { 'data-dm-note': '' },
                st.enabled
                  ? `每 ${Number(cfg.captureIntervalMinutes) || '?'} 分钟采集一次最近 ${Number(cfg.captureWindowHours) || '?'} 小时内有活动的会话`
                  : '关了之后不再采集、不再扫描遗忘 —— 已经记下的东西都还在')),
            h(Switch, {
              on: Boolean(st.enabled),
              disabled: Boolean(busy),
              onChange: onToggleEnabled,
            })),
          h('div', { 'data-dm-kv': '' },
            '记忆根目录：',
            h('button', {
              'data-dm-link': '', type: 'button', title: '点击复制这个路径',
              onClick: () => copy('status', st.root),
            }, st.root || '（未知）'),
            h('br'),
            `摘要模型：${st.summarizer || '—'}`,
            h('br'),
            '上次采集：',
            h('span', { title: absTime(st.lastCaptureAt) }, since(st.lastCaptureAt)),
            h('br'),
            '上次遗忘扫描：',
            h('span', { title: absTime(st.lastSweepAt) }, since(st.lastSweepAt))),
          st.running
            ? h('div', { 'data-dm-msg': '' }, h('span', { 'data-dm-spin': '' }), '正在采集…')
            : null,
          st.lastError
            ? h('div', { 'data-dm-msg': '', 'data-warn': '' }, '上次出错：' + String(st.lastError))
            : null,
          st.note
            ? h('div', { 'data-dm-note': '' }, String(st.note))
            : null),

        /* ── 2. 摘要模型 ── */
        h(ModelSection, {
          st,
          msg: M('model'),
          say: (text, tone) => say('model', text, tone),
          busy,
          setBusy,
          onSaved: refreshStatus,
        }),

        /* ── 3. 记忆三层说明 ── */
        h(Section, { title: '记忆分成三层', msg: M('layers') },
          h('div', { 'data-dm-note': '' },
            '核心是「十年后仍然成立」的事（身份、重要的人、承诺、约定），偏好是「怎么跟你配合最舒服」，',
            '日常记忆是按天归档的对话摘要。越往上越不容易忘。'),
          h('div', { 'data-dm-stats': '' },
            h(Stat, { n: Number(st.coreBytes) || 0, label: '核心记忆（字）' }),
            h(Stat, { n: Number(st.prefBytes) || 0, label: '习惯与喜好（字）' }),
            h(Stat, { n: days.length, label: '日期文件夹（个）' })),
          h('div', { 'data-dm-note': '' },
            '核心与偏好永不删除；日常记忆会淡，但**文件夹本身永远保留** —— ',
            '里面的内容大部分会被压缩成一行，少数重要的保留原文。'),
          h('div', { 'data-dm-note': '' },
            `至今：采集 ${Number(counters.captures) || 0} 次 ｜ 摘要 ${Number(counters.summaries) || 0} 条 ｜ `,
            `提升到核心 ${Number(counters.promotedCore) || 0} 条 ｜ 提升到偏好 ${Number(counters.promotedPrefs) || 0} 条 ｜ `,
            `压缩 ${Number(counters.faded) || 0} 条 ｜ 淡成一行 ${Number(counters.forgotten) || 0} 条`)),

        /* ── 4. 人格 ── */
        h(Section, { title: '人格（persona.md）', msg: M('persona') },
          h('div', { 'data-dm-note': '' },
            '她怎么说话、怎么称呼你，都在这一份里。改的是整份原文 —— ',
            '「## 核心块」那一节会被塞进每次会话的系统提示词。'),
          personaDraft === null
            ? h('div', { 'data-dm-note': '' }, '读人格中…')
            : h('textarea', {
              'data-dm-input': '', 'data-dm-ta': '', rows: 12,
              spellCheck: false,
              value: String(personaDraft),
              onChange: (e) => setPersonaDraft(e.target.value),
            }),
          h('div', { 'data-dm-row': '' },
            h('button', {
              'data-dm-btn': '', 'data-primary': '', type: 'button',
              disabled: Boolean(busy) || personaDraft === null,
              onClick: onSavePersona,
            }, busy === 'save:persona'
              ? h('span', null, h('span', { 'data-dm-spin': '' }), '保存中…')
              : '保存'),
            h('button', {
              'data-dm-btn': '', type: 'button',
              disabled: Boolean(busy) || personaDraft === null,
              onClick: onResetPersona,
            }, busy === 'reset:persona' ? '恢复中…' : '恢复默认'),
            h('button', {
              'data-dm-btn': '', type: 'button',
              disabled: Boolean(busy),
              onClick: onReloadPersona,
            }, busy === 'reload:persona' ? '载入中…' : '重新加载')),
          h('div', { 'data-dm-note': '' },
            `核心块将注入系统提示词，共 ${coreLen} 字`,
            coreEditing ? '（编辑中，保存后才生效）' : '。'),
          h('div', { 'data-dm-params': '' },
            '当前参数：',
            h('span', { 'data-dm-badge': '' }, '名字 ' + (params.name || '—')),
            h('span', { 'data-dm-badge': '' }, '称呼 ' + (params.pet || '—')),
            h('span', { 'data-dm-badge': '' }, '亲密度 ' + (params.intimacy || '—')))),

        /* ── 5. 核心记忆 ── */
        h(Editor, {
          title: '核心记忆（core）',
          hint: '十年后仍然成立的事：身份、重要的人、承诺、约定。',
          rows: 10,
          value: coreDraft,
          busy,
          msg: M('core'),
          onChange: setCoreDraft,
          onSave: () => onSaveEvergreen('core'),
          onReload: () => onReloadEvergreen('core'),
        }),

        /* ── 6. 习惯与喜好 ── */
        h(Editor, {
          title: '习惯与喜好（preferences）',
          hint: '怎么跟你配合最舒服：沟通风格、作息、技术栈、雷区、在做的项目。',
          rows: 10,
          value: prefsDraft,
          busy,
          msg: M('prefs'),
          onChange: setPrefsDraft,
          onSave: () => onSaveEvergreen('preferences'),
          onReload: () => onReloadEvergreen('preferences'),
        }),

        /* ── 7. 日期文件夹（默认收起，点标题展开 —— 日期太多时别把页面撑爆） ── */
        h(DaysSection, {
          days, msg: M('days'), busy,
          openDay, dayText,
          onViewDay, onReviewDay, onPinDay,
          onReviewAll,
        }),

        /* ── 8. 手动记一条 ── */
        h(Section, { title: '手动记一条', msg: M('remember') },
          h('div', { 'data-dm-row': '' },
            h('div', { 'data-dm-grow': '' },
              h('div', { 'data-dm-note': '' }, '记到哪一层'),
              h('select', {
                'data-dm-input': '', value: remTarget,
                onChange: (e) => {
                  const v = e.target.value
                  setRemTarget(v)
                  setRemSection(SECTION_DEFAULT[v] || '')
                },
              },
                h('option', { value: 'core' }, '核心记忆 —— 永不删除'),
                h('option', { value: 'preferences' }, '习惯与喜好 —— 永不删除'),
                h('option', { value: 'daily' }, '日常记忆 —— 会淡忘'))),
            h('div', { 'data-dm-grow': '' },
              h('div', { 'data-dm-note': '' }, '放到哪一节'),
              h('select', {
                'data-dm-input': '', value: remSection,
                onChange: (e) => setRemSection(e.target.value),
              },
                ...(SECTIONS[remTarget] || SECTIONS.core).map((s) => h('option', { key: s, value: s }, s))))),
          h('textarea', {
            'data-dm-input': '', 'data-dm-ta': '', rows: 3,
            placeholder: '一句话写清楚要记住的事',
            value: remText,
            onChange: (e) => setRemText(e.target.value),
          }),
          h('div', { 'data-dm-row': '' },
            h('button', {
              'data-dm-btn': '', 'data-primary': '', type: 'button',
              disabled: Boolean(busy) || !String(remText || '').trim(),
              onClick: onRemember,
            }, busy === 'remember'
              ? h('span', null, h('span', { 'data-dm-spin': '' }), '记着…')
              : '记下'),
            h('span', { 'data-dm-note': '' },
              remTarget === 'daily'
                ? '写进今天的日期文件夹 —— 文件夹永远在，内容会慢慢变淡'
                : '写进永不删除的那两层，下一次会话就生效'))),

        /* ── 8. 回忆测试 ── */
        h(Section, { title: '回忆测试', msg: M('recall') },
          h('div', { 'data-dm-note': '' },
            '问她一句 —— 她会在日常记忆里搜一遍。命中的条目同时算一次回顾，遗忘时钟会续上。'),
          h('div', { 'data-dm-row': '' },
            h('input', {
              'data-dm-input': '', 'data-dm-grow': '', type: 'text',
              placeholder: '比如：我上次说要换什么主题？',
              value: query,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); onRecall() }
              },
            }),
            h('button', {
              'data-dm-btn': '', 'data-primary': '', type: 'button',
              disabled: Boolean(busy) || !String(query || '').trim(),
              onClick: onRecall,
            }, busy === 'recall'
              ? h('span', null, h('span', { 'data-dm-spin': '' }), '回忆中…')
              : '回忆')),
          hits === null
            ? null
            : hits.length === 0
              ? h('div', { 'data-dm-note': '' }, '一条都没找到 —— 要么还没采到相关的东西，要么它真的忘了。')
              : hits.map((x, i) => h(Hit, { key: `${(x && x.day) || ''}#${(x && x.id) || i}`, hit: x }))),

        /* ── 9. 主动陪我说话 ── */
        h(CompanionSection, {
          cp,
          setCp,
          refresh: refreshCp,
          msg: M('companion'),
          say: (text, tone) => say('companion', text, tone),
          busy,
          setBusy,
        }),

        /* ── 10. 操作 ── */
        h(Section, { title: '操作', msg: M('ops') },
          h('div', { 'data-dm-row': '' },
            h('button', {
              'data-dm-btn': '', 'data-primary': '', type: 'button',
              disabled: Boolean(busy),
              onClick: onCapture,
            }, busy === 'capture'
              ? h('span', null, h('span', { 'data-dm-spin': '' }), '采集中…')
              : '立即采集一轮'),
            h('button', {
              'data-dm-btn': '', type: 'button',
              disabled: Boolean(busy),
              onClick: onSweep,
            }, busy === 'sweep' ? '扫描中…' : '立即遗忘扫描'),
            h('button', {
              'data-dm-btn': '', type: 'button',
              disabled: Boolean(busy),
              onClick: () => copy('ops', st.root),
            }, '复制记忆文件夹路径')),
          h('div', { 'data-dm-kv': '' },
            '记忆文件夹：',
            h('button', {
              'data-dm-link': '', type: 'button', title: '点击复制这个路径',
              onClick: () => copy('ops', st.root),
            }, st.root || '（未知）')),
          h('div', { 'data-dm-note': '' },
            '「立即采集」要调模型做摘要，可能要几十秒；这段时间按钮一直禁用，别重复点。',
            '「复制记忆文件夹路径」只把路径放进剪贴板 —— 粘到资源管理器地址栏就能打开（浏览器不让网页直接开系统文件夹）。'),
          tools.length
            ? h('div', { 'data-dm-note': '' }, '她手上的工具：' + tools.join(' / '))
            : null),

        /* ── 11. 日志 ── */
        h(Section, { title: '日志', msg: M('log') },
          h('div', { 'data-dm-row': '' },
            h('button', {
              'data-dm-btn': '', type: 'button',
              disabled: Boolean(busy),
              onClick: onToggleLog,
            }, busy === 'log' ? '读取中…' : (logText === null ? '看日志' : '收起日志')),
            h('span', { 'data-dm-note': '' }, 'memory.log 的最后 200 行')),
          logText === null
            ? null
            : h('pre', { 'data-dm-pre': '' }, logText || '（日志是空的）')))
    }

    /* ────────────────────────── 插件入口 ────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'desktop-memory')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'desktop-memory: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'desktop-memory', order: 31, label: '桌面记忆' },
          () => h(Panel),
        ))
      },
    }
  },
})
