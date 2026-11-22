import { useSource } from './hooks.mjs'

const React = require('react')
const h = React.createElement
const terms = ['target', 'evidence', 'routes', 'cost', 'undo', 'privacy', 'limit']
const outcomes = ['pending', 'written', 'skipped', 'failed']
const PAGE = 40
const failText = (e) => String(e?.message ?? e)
// A settled-but-unverified dispatch is a subset of the Host's `failed` bucket.
// A pending dispatch and a pre-dispatch refusal are different outcomes. The
// specific read-back code is also usable with older Hosts lacking the flag.
const unverifiedWrite = (row) => row.status === 'failed' && (row.outcomeUnknown === true || row.reason === 'settings-unverified')

function reasonText(code, t) {
  if (!code) return ''
  const key = 'bulk.reason.' + code
  const own = t(key)
  if (own !== key) return own
  const shared = 'override.reason.' + code
  const other = t(shared)
  return other !== shared ? other : t('bulk.reason.other', { code: String(code) })
}

/** Full authorization scope is inspectable (including identical IDs on different routes) without a giant initial DOM. */
export function BulkRows({ rows, preview = false, t }) {
  const [limit, setLimit] = React.useState(PAGE)
  const [open, setOpen] = React.useState(false)
  if (!Array.isArray(rows) || !rows.length) return null
  const label = t(preview ? 'bulk.previewList' : 'bulk.receiptList', { count: rows.length })
  return h('details', { className: 'mvp_checkerDetails mvp_bulkItems', open,
    onToggle: (event) => setOpen(event.currentTarget.open) },
    h('summary', null, label),
    open ? h('ol', { tabIndex: 0, 'aria-label': label }, rows.slice(0, limit).map((row, i) => {
      const levels = (ids, key) => Array.isArray(ids) && ids.some(id => typeof id === 'string')
        ? t(key, { levels: ids.filter(id => typeof id === 'string').join(' / ') }) : null
      const unknown = !preview && unverifiedWrite(row)
      const stoppedBecause = !preview && row.authorized === false && typeof row.authorizationReason === 'string' && row.authorizationReason
      const detail = [typeof row.authorized === 'boolean' && !stoppedBecause ? t(row.authorized ? 'bulk.inScope' : 'bulk.outScope') : null,
        t('bulk.status.' + (unknown ? 'unverified' : outcomes.includes(row.status) ? row.status : 'unknown')),
        unknown ? t(row.reason === 'settings-unverified' ? 'bulk.reason.settings-unverified' : 'bulk.reason.dispatch-unconfirmed') : reasonText(row.reason, t),
        levels(row.efforts, 'bulk.levels'), row.status === 'pending' ? levels(row.additions, 'bulk.toFill') : null,
        row.status === 'written' ? levels(row.writtenEfforts, 'bulk.writtenLevels') : null, levels(row.unresolvedEfforts, 'bulk.unresolved'),
        typeof row.source === 'string' && row.source ? t('bulk.source', { source: row.source }) : null,
        stoppedBecause ? t('bulk.authorizationStopped', { reason: reasonText(stoppedBecause, t) }) : null]
      return h('li', { key: JSON.stringify([row.provider, row.model, i]) },
        h('div', { className: 'mvp_bulkKey' }, t('bulk.provider', { id: row.provider }), ' · ', t('bulk.model', { id: row.model })),
        h('div', { className: 'mvp_bulkMeta' }, detail.filter(Boolean).join(' · ')))
    })) : null,
    open && limit < rows.length ? h('div', null,
      h('span', null, t('bulk.listPosition', { shown: limit, total: rows.length })), ' ',
      h('button', { type: 'button', className: 'mvp_button', onClick: () => setLimit(limit + PAGE) },
        t('bulk.listMore', { count: Math.min(PAGE, rows.length - limit) }))) : null,
  )
}

function termsView(t) {
  return h('dl', { className: 'mvp_bulkTerms' }, terms.map((key) => h(React.Fragment, { key },
    h('dt', null, t('bulk.terms.' + key + '.title')), h('dd', null, t('bulk.terms.' + key + '.body')))))
}

/** Native showModal confines focus/inerts the page; no CSS-only dialog or fallback that could bypass confirmation. */
export function BulkConfirmDialog({ review, t, close, agree, expired, trigger, onUnavailable }) {
  const ref = React.useRef(null), cancel = React.useRef(null)
  const title = React.useId(), intro = React.useId()
  React.useLayoutEffect(() => {
    const node = ref.current
    const original = trigger.current
    try { node.showModal(); cancel.current.focus({ preventScroll: true }); node.scrollTop = 0 } catch { onUnavailable(); return }
    return () => { node.close(); if (original?.isConnected) original.focus({ preventScroll: true }) }
  }, [])
  const keyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    // Native dialogs keep pointer/assistive input outside inert. Wrap Tab as well (some browsers otherwise reach the chrome).
    if (event.key !== 'Tab') return
    const focusable = Array.from(ref.current.querySelectorAll('button:not(:disabled),summary,[tabindex="0"]'))
      .filter(node => node.getClientRects().length > 0)
    const first = focusable[0], last = focusable.at(-1), focused = ref.current.ownerDocument.activeElement
    if (first && event.shiftKey && focused === first) { event.preventDefault(); last.focus() }
    else if (last && !event.shiftKey && focused === last) { event.preventDefault(); first.focus() }
  }
  const data = review.data
  return h('dialog', { ref, className: 'mvp_bulkDialog', 'aria-labelledby': title, 'aria-describedby': intro, 'aria-modal': true,
    onCancel: (event) => { event.preventDefault(); close() }, onKeyDown: keyDown },
    h('div', { className: 'mvp_bulkContent' },
      h('h3', { id: title }, t('bulk.review')), h('p', { id: intro }, t('bulk.intro')),
      data ? h('div', null, h('strong', null, t('bulk.previewCounts', data)),
        h('p', null, t('bulk.scopeCount', { count: data.scopeCount })), h(BulkRows, { rows: data.rows, preview: true, t })) : null,
      review.error ? h('p', { role: 'alert' }, t('bulk.previewError', { message: review.error })) : !data ? h('p', { role: 'status' }, t('bulk.previewLoading')) : null,
      termsView(t),
      data && (expired || data.scopeCount === 0) ? h('p', { role: 'status' }, t(expired ? 'bulk.expired' : 'bulk.noScope')) : null,
    ),
    h('div', { className: 'mvp_bulkActions' },
      h('button', { type: 'button', ref: cancel, autoFocus: true, className: 'mvp_button', onClick: close }, t('bulk.cancel')),
      h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: !data?.scopeCount || expired,
        onClick: () => { if (data?.scopeCount && !expired) agree() } }, t('bulk.agree')),
    ),
  )
}

export function BulkEffortsControl({ api, t, canUse }) {
  const state = useSource(api)
  const [review, setReview] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [expired, setExpired] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(null)
  const opener = React.useRef(null), previewing = React.useRef(null), action = React.useRef(null)
  const hint = React.useId()
  const value = state.snapshot, enabled = value?.enabled === true
  const close = () => {
    previewing.current?.abort(); previewing.current = null
    setReview(null); setExpired(false)
  }
  React.useEffect(() => () => { previewing.current?.abort(); previewing.current = null; action.current = null }, [api])
  React.useEffect(() => {
    if (!review?.data || review.epoch !== state.epoch) return
    const remaining = review.data.expiresAt - Date.now()
    if (remaining <= 0) { setExpired(true); return }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [review, state.epoch])
  React.useEffect(() => { if (review && (review.epoch !== state.epoch || enabled || !canUse)) close() }, [review, state.epoch, enabled, canUse])

  const open = async () => {
    if (previewing.current || action.current || review || !canUse || state.pending || state.status !== 'ready' || !value || enabled) return
    const ctl = new AbortController(), epoch = state.epoch
    previewing.current = ctl
    setError(null); setExpired(false); setReview({ epoch, controller: ctl })
    try {
      const data = await api.preview(ctl.signal)
      if (previewing.current === ctl && api.getSnapshot().epoch === epoch) setReview({ epoch, data, controller: ctl })
    } catch (e) {
      if (previewing.current === ctl && !ctl.signal.aborted) setReview({ epoch, error: failText(e) })
    }
  }
  const send = async (kind, ticket) => {
    if (action.current) return
    const marker = {}; action.current = marker
    const epoch = api.getSnapshot().epoch
    setError(null); setSubmitting(kind)
    try { if (kind === 'enable') await api.enable(ticket); else await api.disable() } catch (e) {
      if (action.current === marker && api.getSnapshot().epoch === epoch) {
        setError(t('bulk.actionError', { message: failText(e) }))
        // A timed-out POST may still have been dispatched. Read status, never retry the write or silently obtain another ticket.
        void api.load()
      }
    } finally {
      if (action.current === marker) { action.current = null; setSubmitting(null) }
    }
  }
  const agree = () => {
    const current = api.getSnapshot(), data = review?.data
    // A detached confirmation must never authorize a ticket from an earlier dialog on this same Host.
    if (!data || previewing.current !== review.controller) return
    if (expired || data.expiresAt <= Date.now() || data.scopeCount < 1 || !previewing.current || previewing.current.signal.aborted ||
        action.current || !canUse || current.epoch !== review.epoch || current.pending || current.status !== 'ready' || current.snapshot?.enabled !== false) {
      setExpired(true); return
    }
    close(); void send('enable', data.ticket)
  }
  // Disabling only stops future dispatches. Keep it reachable even if refreshing the catalog or a receipt failed.
  const locked = !!submitting || !!action.current || state.pending || !value || (!enabled && (!canUse || value.running || state.status !== 'ready'))
  const counts = value?.counts
  const unverified = value?.rows?.filter(unverifiedWrite).length ?? 0
  return h('section', { className: 'mvp_bulkSection', 'aria-label': t('bulk.title') },
    h('div', { className: 'mvp_applyRow' },
      h('button', { type: 'button', role: 'switch', ref: opener, className: 'mvp_switch', 'aria-checked': enabled,
        'aria-label': t('bulk.title'), 'aria-describedby': hint, 'aria-disabled': locked, onClick: () => {
          if (locked || review || action.current) return
          if (enabled) void send('disable'); else void open()
        } }, h('span', { className: 'mvp_thumb' })),
      h('div', { className: 'mvp_applyText' }, h('span', { className: 'mvp_applyTitle' }, t('bulk.title')),
        h('span', { className: 'mvp_applyHint', id: hint, role: 'status' }, t(submitting ? 'bulk.submitting' : state.error ? 'bulk.unconfirmed' :
          !value ? 'bulk.unknown' : enabled ? 'bulk.onHint' : 'bulk.offHint')))),
    state.lostReply ? h('div', { className: 'mvp_banner mvp_banner--warn', role: 'alert' }, t('bulk.previousHost'), ' ',
      h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: api.clearLostReply }, t('bulk.dismiss'))) : null,
    enabled ? h('details', { className: 'mvp_checkerDetails' }, h('summary', null, t('bulk.scopeDetails')),
      h('p', null, t('bulk.scopeCount', { count: value.scopeCount })), termsView(t)) : null,
    error || state.error ? h('div', { className: 'mvp_usageHint mvp_usageHint--warn', role: 'alert' },
      error ?? t('bulk.readError', { message: state.error }), ' ',
      h('button', { className: 'mvp_button mvp_button--quiet', type: 'button', disabled: state.pending || state.refreshing,
        onClick: () => { setError(null); void api.load() } }, t('bulk.retry'))) : null,
    value?.running ? h('div', { className: 'mvp_usageHint', role: 'status' }, t('bulk.running')) : null,
    counts && state.status === 'ready' && (enabled || value.rows?.length || outcomes.some(k => counts[k] > 0)) ? h('div', null,
      h('div', { className: 'mvp_checkerProgressText', role: 'status' }, unverified ? t('bulk.receiptUnverified',
        { ...counts, failed: counts.failed - unverified, unverified }) : t('bulk.receipt', counts)),
      unverified ? h('div', { className: 'mvp_checkerOptionNote', role: 'status' }, t('bulk.verifyManually')) : null,
      h(BulkRows, { rows: value.rows, t })) : null,
    review && review.epoch === state.epoch && !enabled && canUse ? h(BulkConfirmDialog, { review, t, close, agree, expired, trigger: opener,
      onUnavailable: () => { close(); setError(t('bulk.dialogUnavailable')) } }) : null,
  )
}
