import { API } from './constants.mjs'
import { setClientTraceSession, tracedFetch } from './diagnostic-events.mjs'
const React = require('react')
const h = React.createElement
const SUCCESSOR = 'https://github.com/TZYCeng/DSH-The-Model-List'
const has = (features, flag) => Array.isArray(features) && features.includes(flag)
const button = (label, click, disabled = false) => h('button', { className: 'mvp_button mvp_button--quiet', type: 'button', onClick: click, disabled }, label)
const css = `.mvp_support{margin:6px 0;color:var(--dsw-alias-label-primary);font-size:12px}.mvp_supportLine{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.mvp_support .mvp_supportHint{font-size:11px;color:var(--dsw-alias-label-secondary)}.mvp_support summary,.mvp_support input{cursor:pointer}.mvp_support .mvp_supportList{max-height:13rem;overflow:auto;display:grid;gap:2px;padding:4px;background:var(--dsw-alias-bg-layer-1);border-radius:5px}.mvp_supportList code{overflow-wrap:anywhere;font:11px/1.4 ui-monospace,monospace}.mvp_supportAbout{margin-top:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:9px}.mvp_supportAbout summary{font-weight:500}.mvp_supportAbout a{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:2px}.mvp_supportResult{margin-top:6px;overflow-wrap:anywhere}`

async function supportRequest(endpoint, signal, body) {
  const fetcher = endpoint.startsWith('diagnostics') ? fetch : tracedFetch
  const response = await fetcher(API + '/' + endpoint, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const reply = await response.json()
  if (reply?.ok !== true || !reply.value || typeof reply.value !== 'object') throw new Error('Invalid status')
  return reply.value
}
// Abort obsolete reads; don't allow a pre-toggle response to put an old switch state back.
function useSupportRequest(enabled, receive) {
  const [state, update] = React.useState({ data: null, busy: false, error: false })
  const ref = React.useRef({ previous: null, active: true })
  React.useEffect(() => { ref.current.active = true; return () => { ref.current.active = false; ref.current.previous?.abort() } }, [enabled])
  const call = async (path, body, { silent = false } = {}) => {
    if (!enabled || !ref.current.active) return
    const slot = ref.current
    // A poll/open/second click must not overtake an in-flight POST. Aborting our
    // wait would not undo the server side of a toggle or clear.
    if (slot.mutation) return
    if (body) slot.mutation = true
    slot.previous?.abort()
    const controller = new AbortController()
    slot.previous = controller
    const timeout = setTimeout(() => controller.abort(), 8500)
    if (!silent) update(s => ({ ...s, busy: true, error: false }))
    try {
      const data = await supportRequest(path, controller.signal, body)
      if (slot.active && slot.previous === controller) { receive?.(data); update({ data, busy: false, error: false }) }
    } catch { if (slot.active && slot.previous === controller) update(s => ({ ...s, busy: false, error: true })) }
    finally { clearTimeout(timeout); if (slot.previous === controller) { slot.previous = null; slot.mutation = false } }
  }
  return { ...state, call, idle: () => ref.current.previous === null }
}

export function DebugPanel({ t, features }) {
  const supported = has(features, 'diagnostics')
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(null)
  const s = useSupportRequest(supported, data => setClientTraceSession(data.enabled ? data.epoch : null))
  const load = () => s.call('diagnostics' + (open ? '?detail=1' : ''))
  React.useEffect(() => { if (supported) void load() }, [open, supported])
  React.useEffect(() => {
    if (!supported || !open || !s.data?.enabled) return
    const timer = setInterval(() => { if (s.idle()) void s.call('diagnostics?detail=1', undefined, { silent: true }) }, 3000)
    return () => clearInterval(timer)
  }, [open, supported, s.data?.enabled])
  if (!supported) return null
  const data = s.data, enabled = !!data?.enabled, entries = Array.isArray(data?.events) ? data.events : []
  const toggle = () => { setCopied(null); void s.call('diagnostics', { action: 'toggle', enabled: !enabled, detail: open }) }
  const copy = async () => { try { await navigator.clipboard.writeText(entries.map(e => JSON.stringify(e)).join('\n')); setCopied('support.copied') } catch { setCopied('support.error') } }
  return h('div', { className: 'mvp_support' }, h('style', null, css),
    h('div', { className: 'mvp_supportLine' }, h('label', { className: 'mvp_supportLine' },
      h('input', { type: 'checkbox', role: 'switch', checked: enabled, 'aria-checked': enabled, disabled: !data || s.busy, 'aria-label': t('support.debugSwitch'), onChange: toggle }), t('support.debug')),
      enabled ? h('small', { role: 'status' }, t('support.traceOn')) : null,
      h('button', { className: 'mvp_button mvp_button--quiet', type: 'button', 'aria-expanded': open, disabled: s.busy, onClick: () => { setCopied(null); setOpen(!open) } }, t(open ? 'support.hide' : 'support.view')),
      s.error ? h('span', { role: 'alert' }, t('support.error'), button(t('support.refresh'), load, s.busy)) : null),
    open ? h('div', { className: 'mvp_supportResult' }, h('p', { className: 'mvp_supportHint' }, t('support.debugHint')),
      data?.file ? h('p', { className: 'mvp_supportHint' }, t('support.file', { path: data.file })) : null,
      data?.diskError ? h('p', { role: 'alert' }, t('support.diskError')) : null,
      data?.dropped ? h('span', { className: 'mvp_supportHint' }, t('support.dropped', { count: data.dropped })) : null,
      entries.length ? h('div', { className: 'mvp_supportList', tabIndex: 0, 'aria-label': t('support.debug') }, entries.slice().reverse().map(e => h('code', { key: e.seq },
        new Date(e.at).toLocaleTimeString() + '  ' + e.origin + ' · ' + e.module + ' / ' + e.step + '  ' + JSON.stringify(e.data)))) : h('p', { className: 'mvp_supportHint' }, t('support.empty')),
      h('div', { className: 'mvp_supportLine' }, button(t('support.copy'), copy, !entries.length), button(t('support.clear'), () => { setCopied(null); void s.call('diagnostics', { action: 'clear' }) }, !entries.length || s.busy), copied ? h('span', { role: 'status' }, t(copied)) : null)) : null)
}

export function AboutPanel({ t, features }) {
  const supported = has(features, 'versionInfo')
  const [open, setOpen] = React.useState(false)
  const s = useSupportRequest(supported)
  React.useEffect(() => { if (open && supported) void s.call('version?check=1') }, [open, supported])
  const v = s.data
  const label = v?.comparison === 0 ? 'support.same' : v?.comparison > 0 ? 'support.ahead' : 'support.update'
  return h('details', { className: 'mvp_support mvp_supportAbout', open, onToggle: e => setOpen(e.currentTarget.open) },
    h('summary', null, t('support.about')), open ? h('div', { className: 'mvp_supportResult' },
      supported ? h('div', { className: 'mvp_supportLine', role: 'status' },
        h('span', null, t('support.current') + ': ' + (v?.current ?? '—')), h('span', null, t('support.latest') + ': ' + (v?.latest ?? (s.busy ? t('support.checking') : t('support.unavailable')))),
        v?.latest && !v.error && !s.error ? h('small', null, t(label)) : null,
        v?.error || s.error ? h('small', { role: 'status' }, t('support.checkFailed') + (v?.latest && Number.isFinite(v?.checkedAt) ? ' · ' + t('support.cached') + ' ' + new Date(v.checkedAt).toLocaleString() : '')) : null,
        button(t('support.check'), () => void s.call('version?check=1'), s.busy)) : h('p', null, t('support.old')),
      h('p', null, t('support.frozen')),
      h('p', null, t('support.roadmap')),
      h('p', null, h('a', { href: SUCCESSOR, target: '_blank', rel: 'noopener noreferrer' }, t('support.successor')))) : null)
}
