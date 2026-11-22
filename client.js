/**
 * Assembled by scripts/build-client.mjs from client-src/*.mjs — the sources
 * are the readable place; this file must not be edited by hand.
 */
window.__ModuleLoader__.load({
  id: "@tzyc/dsh-model-visibility",
  factory(require) {
    const cache = new Map()
    const definitions = new Map()
    const define = (name, factory) => {
      definitions.set(name, factory)
    }
    const moduleRequire = (name) => {
      if (!definitions.has(name)) return require(name)
      if (cache.has(name)) return cache.get(name)
      if (cache.has(name + ':pending')) {
        throw new Error('client bundles may not require "' + name + '" cyclically')
      }
      cache.set(name + ':pending', true)
      const module = { exports: {} }
      definitions.get(name)(moduleRequire, module, module.exports)
      cache.set(name, module.exports)
      return module.exports
    }
  // -------------------------------------------------------- catalog-store
  define("catalog-store", function (require, module, exports) {
    const { API } = require("constants")
    const { clientTrace, tracedFetch } = require("diagnostic-events")

    /** A separate key space from the composer visibility keys. */
    function overrideIdentity(provider, model) {
      return JSON.stringify([provider, model])
    }

    const failureText = (error) => String(error?.message ?? error)
    const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
    const abortReason = () => Object.assign(new Error('The Host connection or request changed.'), { name: 'AbortError' })

    async function httpFailure(response) {
      let code, message
      try {
        const error = (await response.json())?.error
        code = error?.code
        message = error?.message
      } catch { /* a non-JSON error still has an HTTP status */ }
      return Object.assign(new Error(`HTTP ${response.status}${code || message ? ` (${[code, message].filter(Boolean).join(': ')})` : ''}`),
        { status: response.status, code })
    }

    /** Scope the deadline to the *whole* operation, including a stalled body or a Remote fallback that ignores abort. */
    function bounded(controller, timeoutMs, operation) {
      const { signal } = controller
      let rejectAbort
      const aborted = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason ?? abortReason()) })
      signal.addEventListener('abort', rejectAbort, { once: true })
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('Host request timed out.'), { name: 'TimeoutError' })), timeoutMs)
      let task
      try { signal.throwIfAborted(); task = operation(signal) } catch (error) { task = Promise.reject(error) }
      return Promise.race([task, aborted]).finally(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', rejectAbort)
      })
    }

    async function request(path, signal, payload) {
      const response = await tracedFetch(API + path, {
        headers: payload === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
        ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
      })
      if (!response.ok) throw await httpFailure(response)
      const body = await response.json()
      if (body?.ok !== true || !record(body.value)) throw new Error('Malformed Host response.')
      return body.value
    }

    /**
     * All four mirrors share the same ownership rules. Explicit UI refresh is allowed;
     * unsolicited events only mark a mirror dirty. Only an observer may start that
     * background read/poll. A connection reset invalidates *writes* as well as reads:
     * losing a response does not revoke a mutation the former Host already received.
     */
    function mirror({ name, initial, read, cadence, warnOnLost, timeoutMs = 25_000 }) {
      let state = { ...initial, epoch: 0 }, reader = null, writer = null
      let dirty = 0, queued = null, timer = null, period = 0, disposed = false, lostReply = false
      const listeners = new Set()
      const publish = (patch) => {
        state = { ...patch, epoch: state.epoch, ...(warnOnLost ? { lostReply } : {}) }
        for (const fn of listeners) fn()
      }
      const stopTimer = () => { clearInterval(timer); timer = null; period = 0 }
      const rearm = () => {
        const next = !disposed && listeners.size > 0 ? cadence?.(state) ?? 0 : 0
        if (next === period) return
        stopTimer()
        if (next > 0) {
          period = next
          timer = setInterval(() => { void load() }, next)
          timer?.unref?.()
        }
      }
      const dropReader = () => {
        const previous = reader
        reader = null
        if (previous) previous.controller.abort(abortReason())
      }
      const load = (options = {}) => {
        if (disposed || writer) return Promise.resolve()
        const priority = Math.max(dirty, options.reload ? 2 : options.fresh ? 1 : 0)
        if (reader && !options.reload && !options.supersede && priority <= reader.priority) return reader.promise
        dropReader()
        dirty = -1
        const job = { controller: new AbortController(), priority }
        reader = job
        const traceRead = !cadence || state.status !== 'ready' || priority > 0
        if (traceRead) clientTrace(name, 'read', { mode: priority === 2 ? 'reload' : priority === 1 ? 'fresh' : 'normal' })
        job.promise = bounded(job.controller, timeoutMs, (signal) => read(signal, priority)).then((next) => {
          if (reader !== job) return
          publish({ ...initial, ...next, status: 'ready', error: null, refreshing: false })
          if (traceRead) clientTrace(name, 'received', { status: 'ready' })
        }).catch((error) => {
          if (reader !== job) { if (traceRead) clientTrace(name, 'discard', {}); return }
          publish({ ...state, status: 'error', refreshing: false, error: failureText(error) })
          clientTrace(name, 'read-failed', { status: error.status })
        }).finally(() => { if (reader === job) reader = null; rearm() })
        // Do not wake a whole section for every successful poll's intermediate state.
        if (!cadence || state.status !== 'ready') publish({ ...state, status: state.status === 'ready' ? 'ready' : 'loading', refreshing: true })
        return job.promise
      }
      const scheduleRead = () => {
        if (!listeners.size || writer || disposed) return Promise.resolve()
        return queued ??= Promise.resolve().then(() => {
          queued = null
          if (!disposed && listeners.size && dirty >= 0) return load()
        })
      }
      const invalidate = ({ fresh = false, reset = false } = {}) => {
        if (disposed) return Promise.resolve()
        dirty = Math.max(dirty, reader?.priority ?? 0, fresh ? 1 : 0)
        dropReader()
        if (reset) {
          const previous = writer
          writer = null
          if (previous && warnOnLost?.(previous.action)) lostReply = true
          previous?.controller.abort(abortReason())
          state = { ...initial, epoch: state.epoch + 1 }
          publish(state)
          rearm()
        }
        return scheduleRead()
      }
      const mutate = async (action, operation, accept, onError, signal) => {
        if (disposed || writer) throw new Error('A Host request is unavailable or already pending.')
        if (signal?.aborted) throw signal.reason ?? abortReason()
        dropReader()
        const job = { controller: new AbortController(), action }
        writer = job
        const abort = () => job.controller.abort(signal.reason ?? abortReason())
        signal?.addEventListener('abort', abort, { once: true })
        publish({ ...state, pending: true, refreshing: false, error: null })
        // Never log request bodies, tickets, config values, headers, URLs, or error text.
        clientTrace(name, action + '.send', {})
        try {
          const value = await bounded(job.controller, timeoutMs, operation)
          if (writer !== job || disposed) throw abortReason()
          const next = accept?.(value) ?? state
          publish({ ...next, pending: false, refreshing: false, error: null })
          clientTrace(name, action + '.settled', { enabled: value?.enabled, written: value?.counts?.written, runId: value?.state?.runId })
          return value
        } catch (error) {
          if (writer === job) {
            const next = onError?.(error) ?? state
            publish({ ...next, pending: false, refreshing: false })
            clientTrace(name, action + '.not-confirmed', { status: error.status })
          }
          throw error
        } finally {
          signal?.removeEventListener('abort', abort)
          if (writer === job) {
            writer = null
            if (dirty >= 0) void scheduleRead()
          }
          rearm()
        }
      }
      return {
        getSnapshot: () => state, load, invalidate, mutate,
        clearLostReply() { if (lostReply) { lostReply = false; publish(state) } },
        subscribe(fn) {
          if (disposed) return () => {}
          const first = !listeners.size
          listeners.add(fn)
          if (first) { void load(); rearm() }
          return () => {
            listeners.delete(fn)
            if (!listeners.size) {
              dirty = Math.max(dirty, reader?.priority ?? 0)
              dropReader()
              stopTimer()
            }
          }
        },
        dispose() {
          disposed = true; listeners.clear(); stopTimer(); dropReader()
          const previous = writer
          writer = null
          previous?.controller.abort(abortReason())
        },
      }
    }

    function createCatalog(ctx, options) {
      const initial = { status: 'idle', groups: [], failures: [], providers: [], learned: null, error: null, detailsError: null, source: null, generatedAt: 0 }
      const store = mirror({ name: 'catalog', initial, timeoutMs: options?.timeoutMs ?? 90_000,
        read: async (signal, priority) => {
          try {
            const query = priority === 2 ? '?fresh=1&reload=1' : priority === 1 ? '?fresh=1' : ''
            const value = await request('/models' + query, signal)
            if (!Array.isArray(value.groups)) throw new Error('Malformed capability catalog.')
            return { groups: value.groups, failures: Array.isArray(value.failures) ? value.failures : [],
              providers: Array.isArray(value.providers) ? value.providers : [], learned: record(value.learned) ? value.learned : null,
              source: 'host', generatedAt: Number.isFinite(value.generatedAt) ? value.generatedAt : 0 }
          } catch (error) {
            signal.throwIfAborted()
            const response = await ctx.remote.session.modelCatalog()
            if (response?.ok !== true) throw new Error(failureText(response?.error?.message ?? 'Catalog unavailable.'))
            const value = response.value ?? {}
            // Only genuine adapter declarations belong in the request ladder.
            const groups = Array.isArray(value.groups) ? value.groups.map((group) => ({ ...group,
              models: Array.isArray(group.models) ? group.models.map((model) => Array.isArray(model.reasoning?.efforts) && model.reasoning.efforts.length > 0
                ? { ...model, requestReasoning: model.reasoning } : model) : [] })) : []
            return { groups, failures: Array.isArray(value.failures) ? value.failures : [], source: 'catalog', detailsError: failureText(error) }
          }
        },
      })
      return { ...store, refresh: () => store.load({ fresh: true }), reload: () => store.load({ reload: true }),
        afterChange: ({ fresh = true } = {}) => store.load({ fresh, supersede: true }) }
    }

    function createOverrides(options) {
      const initial = { status: 'idle', entries: [], revisions: null, available: null, error: null, pending: false, refreshing: false }
      const unavailable = { ...initial, status: 'ready', available: false }
      const readyState = (value) => {
        if (!Array.isArray(value?.overrides)) throw new Error('Malformed override list.')
        if (!Array.isArray(value.revisions)) return unavailable
        const revisions = new Map()
        for (const item of value.revisions) {
          if (typeof item?.provider !== 'string' || typeof item.model !== 'string' ||
              typeof item.revision !== 'string' || item.revision === '') throw new Error('Malformed override revisions.')
          const key = overrideIdentity(item.provider, item.model)
          if (revisions.has(key)) throw new Error('Duplicate override revision.')
          revisions.set(key, item.revision)
        }
        if (value.overrides.length !== revisions.size || value.overrides.some((entry) =>
          !revisions.has(overrideIdentity(entry?.provider, entry?.model)))) throw new Error('Missing override revision.')
        return { ...unavailable, available: true, entries: value.overrides, revisions }
      }
      const store = mirror({ name: 'overrides', initial, timeoutMs: options?.timeoutMs,
        read: async (signal) => {
          try { return readyState(await request('/overrides', signal)) } catch (error) {
            if (error.status === 404) return unavailable
            throw error
          }
        },
      })
      const write = async (payload, expectedRevision) => {
        const state = store.getSnapshot()
        if (state.status !== 'ready' || !state.available || state.pending) throw new Error('Override list is not ready.')
        if ((state.revisions.get(overrideIdentity(payload.provider, payload.model)) ?? null) !== expectedRevision) {
          throw Object.assign(new Error('Override changed.'), { status: 409 })
        }
        return store.mutate(payload.remove ? 'remove' : 'save', (signal) => request('/overrides', signal, { ...payload, expectedRevision }), readyState,
          (error) => error.status === 404 ? unavailable : { ...state, status: 'error', error: failureText(error) })
      }
      return { ...store, save: write, remove: (provider, model, revision) => write({ remove: true, provider, model }, revision) }
    }

    const emptySnapshot = () => ({ status: 'idle', snapshot: null, error: null, pending: false })
    const snapshotOf = (value) => ({ status: 'ready', snapshot: value })

    function createUsageApi(options) {
      const store = mirror({ name: 'usage', initial: emptySnapshot(), timeoutMs: options?.timeoutMs,
        read: async (signal) => snapshotOf(await request('/usage', signal)),
        cadence: (state) => state.snapshot?.computing ? 3_000 : 30_000,
      })
      return { ...store, refresh: () => store.load() }
    }

    function verifyValue(value) {
      if (!record(value?.state)) throw new Error('Malformed verification snapshot.')
      return snapshotOf(value)
    }

    function createVerifyApi(options) {
      const store = mirror({ name: 'verify', initial: emptySnapshot(), timeoutMs: options?.timeoutMs,
        read: async (signal) => verifyValue(await request('/verify', signal)),
        cadence: ({ snapshot }) => snapshot?.state?.running || snapshot?.state?.pendingWrite ? 2_000 : 60_000,
      })
      const post = (action, payload) => store.mutate(action, (signal) => request('/verify', signal, payload), verifyValue,
        (error) => ({ ...store.getSnapshot(), status: 'error', error: failureText(error) })).catch((error) => {
        // Timeout does not mean the Host rejected the write. Refresh observed state; never replay a start/cancel.
        if (error?.name !== 'AbortError') void store.invalidate()
        throw error
      })
      const bulk = createBulkEffortsApi(options)
      return { ...store, bulk, start: (payload) => post('start', payload),
        cancel(runId) {
          const current = store.getSnapshot().snapshot?.state?.runId
          // Do not silently substitute the latest ID: the user clicked *their* displayed run.
          if ((current ?? undefined) !== runId) return Promise.reject(Object.assign(new Error('The verification run changed.'), { status: 409 }))
          return post('cancel', runId === undefined ? { cancel: true } : { cancel: true, runId })
        },
        dispose() { store.dispose(); bulk.dispose() },
      }
    }

    /** The preview ticket lives only in the open confirmation, never in preferences, traces, or a cached GET. */
    function createBulkEffortsApi(options) {
      const outcomes = ['pending', 'written', 'skipped', 'failed']
      const count = (n) => Number.isSafeInteger(n) && n >= 0
      const validRows = (rows) => Array.isArray(rows) && rows.every(row => record(row) && outcomes.includes(row.status) &&
        typeof row.provider === 'string' && row.provider !== '' && typeof row.model === 'string' && row.model !== '') &&
        new Set(rows.map(row => overrideIdentity(row.provider, row.model))).size === rows.length
      const valueOf = (value) => {
        if (typeof value?.enabled !== 'boolean' || typeof value.running !== 'boolean') throw new Error('Malformed bulk-effort status.')
        const { rows, counts } = value
        if (!validRows(rows) || !record(counts) || !outcomes.every(k => count(counts[k]) && counts[k] === rows.filter(r => r.status === k).length) ||
            (value.enabled && !count(value.scopeCount))) throw Object.assign(new Error('Incomplete bulk-effort receipt.'), { code: 'bulk/receipt' })
        return snapshotOf(value)
      }
      const store = mirror({ name: 'bulk-efforts', initial: emptySnapshot(), timeoutMs: options?.timeoutMs, warnOnLost: (action) => action !== 'preview',
        read: async (signal) => valueOf(await request('/bulk-efforts', signal)),
        cadence: (state) => state.snapshot?.running ? 2_000 : state.snapshot?.enabled ? 10_000 : 60_000,
      })
      const change = (action, ticket) => store.mutate(action, (signal) => request('/bulk-efforts', signal, ticket ? { action, ticket } : { action }),
        valueOf, (error) => ({ ...store.getSnapshot(), status: 'error', error: failureText(error) }))
      return { ...store,
        async preview(signal) {
          const value = await store.mutate('preview', (requestSignal) => request('/bulk-efforts', requestSignal, { action: 'preview' }), null, null, signal)
          const { rows, scopeCount, total, eligible, skipped, expiresAt } = value
          if (typeof value.ticket !== 'string' || !value.ticket || !Number.isFinite(expiresAt) ||
              ![total, eligible, skipped, scopeCount].every(count) || eligible + skipped !== total || !validRows(rows) || rows.length !== total ||
              rows.some(row => typeof row.authorized !== 'boolean' || row.status === 'written' || (row.status === 'pending' && !row.authorized)) ||
              rows.filter(row => row.status === 'pending').length !== eligible || rows.filter(row => row.authorized).length !== scopeCount) {
            throw new Error('Incomplete bulk-effort preview; nothing was authorized.')
          }
          return value
        },
        enable(ticket) {
          if (typeof ticket !== 'string' || !ticket) return Promise.reject(new Error('A confirmed preview ticket is required.'))
          return change('enable', ticket)
        },
        disable: () => change('disable'),
      }
    }


    exports.overrideIdentity = overrideIdentity
    exports.createCatalog = createCatalog
    exports.createOverrides = createOverrides
    exports.createUsageApi = createUsageApi
    exports.createVerifyApi = createVerifyApi
    exports.createBulkEffortsApi = createBulkEffortsApi
  })

  // -------------------------------------------------------- checker-bulk
  define("checker-bulk", function (require, module, exports) {
    const { useSource } = require("hooks")

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
    function BulkRows({ rows, preview = false, t }) {
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
    function BulkConfirmDialog({ review, t, close, agree, expired, trigger, onUnavailable }) {
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

    function BulkEffortsControl({ api, t, canUse }) {
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


    exports.BulkRows = BulkRows
    exports.BulkConfirmDialog = BulkConfirmDialog
    exports.BulkEffortsControl = BulkEffortsControl
  })

  // -------------------------------------------------------- checker-dict
  define("checker-dict", function (require, module, exports) {
    /** Checker-only copy; merged with the base and support dictionaries in the entry. */
    const CHECKER_ZH = {
      'checker.scopeNow': '范围不随本页筛选改变：当前目录 {routes} 个提供商，最多 {ids} 个不同模型 ID。宿主开始时重新列举、去重并跳过不需重查的记录。',
      'checker.reliable': '本轮可靠导入 {count} 个（含精确公开证据）',
      'checker.sourceFailures': '有 {count} 条来源读取失败；见下方公开目录。这是来源条数，不是模型数。「未知」仅表示没有查到可靠结论，不代表不支持。',
      'checker.writeWarning': '已开启写回：本轮可能持久修改提供商的空白输入或上下文配置。',
      'checker.fullWarning': '本轮会重查已有记录。使用校验员时可能增加用量。',
      'checker.stopNoId': '尚未取得本轮标识，暂不能安全取消。',
      'bulk.title': '一键填入已查到的思考档位',
      'bulk.offHint': '先看本机预览；不同意就不写入。',
      'bulk.onHint': '已授权本次宿主运行；关闭只停止后续补填，不撤销已写设置。',
      'bulk.unknown': '正在读取总开关状态…', 'bulk.unconfirmed': '当前状态未知，请重新读取。',
      'bulk.submitting': '正在提交，请等待宿主回执…', 'bulk.scopeDetails': '查看本次授权说明',
      'bulk.previousHost': '与原宿主的连接在提交后重置，结果未知。请回原宿主核对回执，不要重复提交。',
      'bulk.dismiss': '知道了', 'bulk.receiptDamaged': '回执不完整，不能确认逐项结果。',
      'bulk.retry': '重新读取状态',
      'bulk.readError': '无法确认总开关状态：{message}',
      'bulk.actionError': '未能确认操作结果：{message}。请先核对状态和回执，不要重复提交。',
      'bulk.previewError': '未能取得完整预览，没有授权写入：{message}',
      'bulk.previewLoading': '正在读取本机路由与已有证据；还没有写入任何设置。',
      'bulk.noScope': '没有可以授权的目标。关闭此窗口不会更改设置。',
      'bulk.expired': '预览已过期或状态已变化。请取消，重新打开总开关核对新预览。',
      'bulk.dialogUnavailable': '当前浏览器不能安全打开确认窗口，没有授权写入。',
      'bulk.review': '写入前，先核对这份清单',
      'bulk.intro': '这是菜单，不是试吃报告。只有点「同意并开启」才会写入，并允许下述范围内的后续补填。',
      'bulk.previewCounts': '本机预览：共 {total} 条路由模型；本次可立即补填 {eligible}，本次跳过 {skipped}。',
      'bulk.scopeCount': '授权范围：{count} 条路由模型（含等待证据的目标）。未列入授权的目标不会随开关自动加入。',
      'bulk.terms.target.title': '会改哪里，什么时候改？',
      'bulk.terms.target.body': '确认后，将已有可靠档位填入清单中的提供商模型配置，而不只是改本页标签。本次宿主运行期间，你后来主动核验出新档位时，也可在同一授权范围内补缺；不会因此自动发起核验。',
      'bulk.terms.evidence.title': '资料不是实测',
      'bulk.terms.evidence.body': '档位来自已有的目录声明或有依据的核验记录。这里不向目标模型发测试请求，也不会验证每个档位真的有效。缺证据、协议不兼容或归属不明时跳过。',
      'bulk.terms.routes.title': '同名模型不等于同一路由',
      'bulk.terms.routes.body': '按「提供商＋模型 ID」逐项核对，不按同名复制。已有手工映射、明确禁用和受保护设置保留；新增路由或关键配置变化需重新预览并同意。仍可手工编辑。',
      'bulk.terms.cost.title': '要付的是哪一笔？',
      'bulk.terms.cost.body': '预览和填设置本身不产生模型费用。以后在对话里选用档位时，中转可能拒绝或忽略参数；更多思考可能更慢、消耗更多 Token 并增加费用。',
      'bulk.terms.undo.title': '开关能关，墨水不会自己消失',
      'bulk.terms.undo.body': '关闭或重载插件会停止后续派发。已派发的写入仍可能完成；已写配置会保留。需要还原时，请在提供商设置中按原值手动恢复；重要配置请先留存。',
      'bulk.terms.privacy.title': '数据会去哪里？',
      'bulk.terms.privacy.body': '预览只从当前宿主读取本机清单，不对外联网、不调用校验员、不计费，不会把对话或密钥发给目录站点。另行启动联网核验时，所选校验员和搜索服务可能收到待查模型 ID。',
      'bulk.terms.limit.title': '不发「免死金牌」',
      'bulk.terms.limit.body': '回执确认的是设置写入，不是上游能力或费用保证；不能绕过提供商规则、限额或故障。请按回执核对，关键任务先保留可用配置。',
      'bulk.cancel': '取消，不写入', 'bulk.agree': '同意并开启',
      'bulk.previewList': '核对逐项预览（{count}）', 'bulk.receiptList': '逐项回执（{count}）',
      'bulk.listMore': '再显示 {count} 条', 'bulk.listPosition': '显示 {shown}/{total}',
      'bulk.provider': '提供商：{id}', 'bulk.model': '模型：{id}', 'bulk.levels': '档位：{levels}', 'bulk.source': '证据：{source}',
      'bulk.inScope': '在授权范围内', 'bulk.outScope': '不在授权范围', 'bulk.authorizationStopped': '后续补填已停止：{reason}',
      'bulk.toFill': '将补填：{levels}', 'bulk.writtenLevels': '已回读：{levels}', 'bulk.unresolved': '未填入：{levels}',
      'bulk.reason.already-mapped': '已有映射，无需补填', 'bulk.reason.unmapped-efforts': '没有安全的档位参数映射',
      'bulk.reason.protocol-unmapped': '当前协议没有可确认的参数映射', 'bulk.reason.non-chat': '不是对话模型',
      'bulk.reason.manual-protected': '已有手工配置，保留原值', 'bulk.reason.reasoning-disabled': '已明确禁用思考',
      'bulk.reason.reference-alias': '别名只作参考', 'bulk.reason.reference-mismatch': '证据与目标身份不符',
      'bulk.reason.model-ambiguous': '不能唯一确定模型条目', 'bulk.reason.route-default': '保留现有路由默认值',
      'bulk.reason.dispatched': '设置请求已派发，等待确认', 'bulk.reason.verified': '已写入并回读核对',
      'bulk.reason.partial': '仅部分档位已写入并回读', 'bulk.reason.evidence-changed': '证据已变化',
      'bulk.reason.target-changed': '目标配置已变化，需重新授权', 'bulk.reason.read-unavailable': '无法读取当前配置或证据',
      'bulk.reason.disabled': '总开关已关闭', 'bulk.reason.disposed': '插件已重载或停止', 'bulk.reason.write-failed': '写入未获确认',
      'bulk.reason.inherited-ladder': '保留继承的档位映射', 'bulk.reason.reference-nonchat': '非对话目标不写入参考档位',
      'bulk.receipt': '批量回执：已写 {written} · 跳过 {skipped} · 失败 {failed} · 待确认 {pending}',
      'bulk.receiptUnverified': '批量回执：已写 {written} · 跳过 {skipped} · 失败 {failed} · 结果未知 {unverified} · 待确认 {pending}',
      'bulk.verifyManually': '标为「结果未知」的写入已派发，可能已生效。请到对应的提供商设置逐项核对，勿重试。批量填入不会另外保存个人覆盖。',
      'bulk.status.unverified': '结果未知', 'bulk.reason.settings-unverified': '已派发，未能回读确认',
      'bulk.reason.dispatch-unconfirmed': '已派发，但无法核实是否生效',
      'bulk.reason.prior-write-unverified': '此前派发的写入结果未知，本次不再派发。请到提供商设置核对，勿重试。',
      'bulk.running': '正在处理，以逐项回执为准。', 'bulk.status.pending': '待处理', 'bulk.status.written': '已写',
      'bulk.status.skipped': '跳过', 'bulk.status.failed': '失败', 'bulk.status.unknown': '状态待核对',
      'bulk.reason.awaiting-evidence': '等待可靠档位证据', 'bulk.reason.ready': '已有可填档位', 'bulk.reason.other': '原因：{code}',
    }

    const CHECKER_EN = {
      'checker.scopeNow': 'Page filters do not limit this run: the current catalog has {routes} providers and up to {ids} distinct model IDs. The Host lists them again at start, deduplicates IDs and skips records not due for a recheck.',
      'checker.reliable': 'Reliably imported this run: {count} models with exact public evidence',
      'checker.sourceFailures': '{count} source reads failed; see Public catalogs below. These are source entries, not model failures. “Unknown” means there was no reliable conclusion, not that the capability is unsupported.',
      'checker.writeWarning': 'Provider write-back on: this run may persist missing input or context settings.',
      'checker.fullWarning': 'This run rechecks existing records. Checker usage may increase.',
      'checker.stopNoId': 'The current run ID is not available yet; cancellation is not safe.',
      'bulk.title': 'Fill in discovered reasoning levels',
      'bulk.offHint': 'Review a local preview first. Nothing is written without your consent.',
      'bulk.onHint': 'Authorized for this Host run. Turning this off stops future fills; it does not undo settings already written.',
      'bulk.unknown': 'Reading the switch state…', 'bulk.unconfirmed': 'The current state is unknown. Read it again.',
      'bulk.submitting': 'Submitting; waiting for the Host receipt…', 'bulk.scopeDetails': 'Review this authorization',
      'bulk.previousHost': 'The connection to the previous Host reset after dispatch. Its outcome is unknown. Check the receipt on that Host; do not submit again.',
      'bulk.dismiss': 'Dismiss', 'bulk.receiptDamaged': 'The receipt is incomplete. Individual outcomes could not be confirmed.',
      'bulk.retry': 'Read status again',
      'bulk.readError': 'Could not confirm the switch state: {message}',
      'bulk.actionError': 'The result was not confirmed: {message}. Check the state and receipt before submitting again.',
      'bulk.previewError': 'Could not obtain a complete preview. No write was authorized: {message}',
      'bulk.previewLoading': 'Reading local routes and existing evidence. No settings have been written.',
      'bulk.noScope': 'There are no targets to authorize. Closing this window changes nothing.',
      'bulk.expired': 'The preview expired or the state changed. Cancel and reopen the switch to review a new preview.',
      'bulk.dialogUnavailable': 'This browser cannot safely open the confirmation dialog. No write was authorized.',
      'bulk.review': 'Review the list before writing',
      'bulk.intro': 'This is a menu, not a taste test. Only “Agree and enable” writes settings and authorizes later fills within the scope below.',
      'bulk.previewCounts': 'Local preview: {total} route/model entries; {eligible} can be filled now, {skipped} skipped this time.',
      'bulk.scopeCount': 'Authorization covers {count} route/model entries, including those waiting for evidence. New targets are never enrolled automatically.',
      'bulk.terms.target.title': 'What changes, and when?',
      'bulk.terms.target.body': 'Confirmation fills supported gaps in the listed provider model settings, not just labels on this page. During this Host run, later verification that you start can fill newly supported gaps in the same scope. This switch does not start a verification run.',
      'bulk.terms.evidence.title': 'References are not live tests',
      'bulk.terms.evidence.body': 'Levels come from catalog declarations or supported verification records. No test requests are sent to target models; the levels are not proven to work on your endpoint. Missing evidence, incompatible protocols and unclear ownership are skipped.',
      'bulk.terms.routes.title': 'One name can lead to different routes',
      'bulk.terms.routes.body': 'Review each provider and exact model ID as a pair. Existing manual mappings, explicit opt-outs and protected settings are kept. New routes or changes to critical settings require another preview and confirmation. You can still edit manually.',
      'bulk.terms.cost.title': 'What could it cost?',
      'bulk.terms.cost.body': 'Previewing and filling settings incur no model fees. In a later conversation, a relay might reject or ignore the parameter. More reasoning may increase latency, token use and cost.',
      'bulk.terms.undo.title': 'The switch turns off; the ink stays',
      'bulk.terms.undo.body': 'Turning this off or reloading the plugin stops new writes. Already dispatched writes may still finish, and settings already written persist. To undo them, restore their original values manually in provider settings. Keep a copy of important settings first.',
      'bulk.terms.privacy.title': 'Where does the data go?',
      'bulk.terms.privacy.body': 'The preview reads a local inventory from this Host only. No external network, checker call or bill; it does not send conversations or credentials to catalog sites. A separate online verification you start may send model IDs to your checker and search service.',
      'bulk.terms.limit.title': 'Not a free pass',
      'bulk.terms.limit.body': 'A receipt confirms settings writes, not upstream support or pricing. This does not bypass provider rules, quotas or outages. Check the receipt and retain a working configuration for critical tasks.',
      'bulk.cancel': 'Cancel, write nothing', 'bulk.agree': 'Agree and enable',
      'bulk.previewList': 'Inspect preview entries ({count})', 'bulk.receiptList': 'Inspect receipt entries ({count})',
      'bulk.listMore': 'Show {count} more', 'bulk.listPosition': 'Showing {shown}/{total}',
      'bulk.provider': 'Provider: {id}', 'bulk.model': 'Model: {id}', 'bulk.levels': 'Levels: {levels}', 'bulk.source': 'Evidence: {source}',
      'bulk.inScope': 'Within scope', 'bulk.outScope': 'Outside scope', 'bulk.authorizationStopped': 'Future fills stopped: {reason}',
      'bulk.toFill': 'To fill: {levels}', 'bulk.writtenLevels': 'Confirmed by read-back: {levels}', 'bulk.unresolved': 'Not filled: {levels}',
      'bulk.reason.already-mapped': 'Already mapped; nothing to fill', 'bulk.reason.unmapped-efforts': 'No safe mapping for these levels',
      'bulk.reason.protocol-unmapped': 'No confirmed parameter mapping for this protocol', 'bulk.reason.non-chat': 'Not a chat model',
      'bulk.reason.manual-protected': 'Existing manual settings retained', 'bulk.reason.reasoning-disabled': 'Reasoning explicitly disabled',
      'bulk.reason.reference-alias': 'Alias evidence is advisory only', 'bulk.reason.reference-mismatch': 'Evidence does not identify this target',
      'bulk.reason.model-ambiguous': 'Model entry is not unique', 'bulk.reason.route-default': 'Existing route default retained',
      'bulk.reason.dispatched': 'Settings write dispatched; awaiting confirmation', 'bulk.reason.verified': 'Written and confirmed by read-back',
      'bulk.reason.partial': 'Only some levels were written and confirmed', 'bulk.reason.evidence-changed': 'Evidence changed',
      'bulk.reason.target-changed': 'Target settings changed; review again', 'bulk.reason.read-unavailable': 'Current settings or evidence could not be read',
      'bulk.reason.disabled': 'Switch turned off', 'bulk.reason.disposed': 'Plugin stopped or reloaded', 'bulk.reason.write-failed': 'Write not confirmed',
      'bulk.reason.inherited-ladder': 'Inherited level mappings retained', 'bulk.reason.reference-nonchat': 'No reference levels written to a non-chat target',
      'bulk.receipt': 'Batch receipt: {written} written · {skipped} skipped · {failed} failed · {pending} pending',
      'bulk.receiptUnverified': 'Batch receipt: {written} written · {skipped} skipped · {failed} failed · {unverified} outcome unknown · {pending} pending',
      'bulk.verifyManually': 'Writes marked “outcome unknown” were dispatched and may have taken effect. Check each one in its provider settings; do not retry. Bulk fill does not save a separate local override.',
      'bulk.status.unverified': 'Outcome unknown', 'bulk.reason.settings-unverified': 'Dispatched; read-back did not confirm the write',
      'bulk.reason.dispatch-unconfirmed': 'Dispatched; could not verify whether the write took effect',
      'bulk.reason.prior-write-unverified': 'An earlier dispatched write has an unknown outcome. Not sent again. Check provider settings; do not retry.',
      'bulk.running': 'Processing. Check the individual receipts for the outcome.', 'bulk.status.pending': 'Pending', 'bulk.status.written': 'Written',
      'bulk.status.skipped': 'Skipped', 'bulk.status.failed': 'Failed', 'bulk.status.unknown': 'Unconfirmed',
      'bulk.reason.awaiting-evidence': 'Waiting for reliable level evidence', 'bulk.reason.ready': 'A supported level is available', 'bulk.reason.other': 'Reason: {code}',
    }


    exports.CHECKER_ZH = CHECKER_ZH
    exports.CHECKER_EN = CHECKER_EN
  })

  // -------------------------------------------------------- checker-style
  define("checker-style", function (require, module, exports) {
    /** Modal stays inside the settings section; native top-layer placement avoids a portal or global DOM writes. */
    const CHECKER_CSS = `
    .mvp_bulkSection{margin-top:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}
    .mvp_bulkSection .mvp_applyRow{border-bottom:0}
    .mvp_bulkSection .mvp_switch[aria-disabled="true"]{opacity:.55;cursor:default}
    .mvp_bulkDialog{box-sizing:border-box;width:min(38rem,calc(100% - 24px));max-height:calc(100% - 24px);max-height:min(82dvh,46rem);overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0;font:inherit;font-size:13px;line-height:1.55;overflow-wrap:anywhere}
    .mvp_bulkDialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent)}
    .mvp_bulkContent{padding:16px 20px 4px}
    .mvp_bulkContent h3{margin:0 0 4px;font-size:16px;line-height:1.45}
    .mvp_bulkContent p{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}
    .mvp_bulkTerms{margin:8px 0 16px}
    .mvp_bulkTerms dt{margin-top:8px;font-weight:600}
    .mvp_bulkTerms dd{margin:0;color:var(--dsw-alias-label-secondary)}
    .mvp_bulkActions{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
    .mvp_bulkActions .mvp_button{height:auto;min-height:30px;white-space:normal}
    .mvp_bulkItems{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
    .mvp_bulkItems summary{cursor:pointer;max-width:100%;color:var(--dsw-alias-label-primary)}
    .mvp_bulkItems ol{margin:6px 0;padding-inline-start:2em;max-height:12rem;overflow:auto;scrollbar-gutter:stable}
    .mvp_bulkItems li{padding:3px 0}
    .mvp_bulkItems summary:focus-visible,.mvp_bulkItems ol:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .mvp_bulkKey{font-weight:500;color:var(--dsw-alias-label-primary)}
    .mvp_bulkMeta{font-size:12px;color:var(--dsw-alias-label-secondary)}
    `

    exports.CHECKER_CSS = CHECKER_CSS
  })

  // -------------------------------------------------------- checker-view
  define("checker-view", function (require, module, exports) {
    const { formatTokens, bucketTotalOf, checkerRoutesOf, checkerModelsOf, checkerScopeOf } = require("pure")
    const { useSource } = require("hooks")
    const { BulkEffortsControl } = require("checker-bulk")

    const React = require('react')
    const h = React.createElement

    const PICK_KEY = 'dsh-model-visibility:checker-pick:v1'
    const SOURCE_MODES = ['public', 'supplement', 'checker']
    const MAX_ACTIVE_BATCH_LINES = 3
    const MAX_ERROR_LINES = 3
    const MAX_ERROR_LENGTH = 140
    /** Mirrors lib/check-catalog MAX_CONCURRENCY. */
    const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8]
    const RUN_PHASES = ['listing', 'public', 'checker', 'verifying', 'cancelled']
    const BATCH_STAGES = ['checker', 'search', 'fetch', 'writeBack', 'flush']

    function readPick() {
      let parsed
      try {
        parsed = JSON.parse(window.localStorage.getItem(PICK_KEY))
      } catch (_error) {
        // Storage availability is optional for this preference.
      }
      const concurrency = parsed?.concurrency
      return {
        provider: typeof parsed?.provider === 'string' ? parsed.provider : '',
        model: typeof parsed?.model === 'string' ? parsed.model : '',
        // The legacy choices are also kept for older Hosts that still control web access separately.
        mode: SOURCE_MODES.includes(parsed?.mode) ? parsed.mode : undefined,
        webSearch: parsed?.webSearch !== false,
        useChecker: parsed?.useChecker !== false,
        writeBack: parsed?.writeBack === true,
        fuzzyMatch: typeof parsed?.fuzzyMatch === 'boolean' ? parsed.fuzzyMatch : undefined,
        concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(8, Math.trunc(concurrency) || 1) : 2,
      }
    }

    function persistPick(pick) {
      try {
        window.localStorage.setItem(PICK_KEY, JSON.stringify(pick))
      } catch (_error) {
        // Storage availability is optional for this preference.
      }
    }

    function shortError(message) {
      const line = String(message).replace(/\s+/g, ' ').trim()
      return line.length > MAX_ERROR_LENGTH ? line.slice(0, MAX_ERROR_LENGTH - 1) + '…' : line
    }

    function errorsView(errors, t, alert) {
      function errorList(entries, shorten) {
        return h('ul', { className: 'mvp_errorList' }, entries.map((entry, index) =>
          h('li', { key: index }, shorten ? shortError(entry) : String(entry))))
      }
      const visible = errors.slice(0, MAX_ERROR_LINES)
      const hasDetails = errors.length > visible.length || visible.some((entry) => shortError(entry) !== String(entry))
      return h('div', { className: 'mvp_checkerErrors' },
        h('div', { role: alert ? 'alert' : undefined },
          h('div', { className: 'mvp_checkerErrorsTitle' }, t('checker.errorTitle')),
          errorList(visible, true),
        ),
        hasDetails ? h('details', { className: 'mvp_checkerDetails' },
          h('summary', null, t('checker.errorDetails', { count: errors.length })),
          errorList(errors, false),
        ) : null,
      )
    }

    function routeLabel(checker) {
      return checker?.provider && checker?.model ? `${checker.provider}/${checker.model}` : null
    }

    function VerifyPanel({ verify, catalog, t, canUse, canFullScan = false, canSetMode = false, canSetSourceMode = false, onFinished }) {
      const state = useSource(verify)
      const [pick, setPick] = React.useState(readPick)
      const [open, setOpen] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      // A full scan is an opt-in for one start, not a saved preference.
      const [fullScan, setFullScan] = React.useState(false)
      const modeGroup = React.useId()
      const modeHint = React.useId()

      const features = Array.isArray(catalog?.learned?.features) ? catalog.learned.features : []
      const canBulk = features.includes('bulkEfforts') && !!verify.bulk
      const scopeHint = React.useId()
      const requiresRunId = features.includes('runId')

      const progress = state.snapshot?.state
      const running = progress?.running === true
      const pending = state.pending === true
      const stateUnknown = ['idle', 'loading', 'error'].includes(state.status)
      const locked = running || pending || stateUnknown
      const stopping = running && progress.phase === 'cancelled'
      const pendingWrite = progress?.pendingWrite
      const latestWrite = progress?.latestWriteSettlement
      // Respect a previous opt-out: switching an offline legacy run to the new online default would change its cost.
      const storedMode = pick.mode ?? (pick.useChecker && pick.webSearch ? 'supplement' : 'public')
      const runMode = SOURCE_MODES.includes(progress?.mode) ? progress.mode : null
      const shownMode = running && runMode !== null ? runMode : storedMode
      const usesChecker = canSetSourceMode ? shownMode !== 'public' : !canSetMode || pick.useChecker
      const usesCatalog = !canSetSourceMode || shownMode !== 'checker'
      const autoFullScan = canSetSourceMode && shownMode === 'checker'
      const fuzzyMatch = pick.fuzzyMatch ?? canSetSourceMode
      const writeBack = usesChecker && pick.writeBack
      const groups = catalog?.groups
      const routeOptions = React.useMemo(() => checkerRoutesOf(groups), [groups])
      const selectedRoute = running && progress?.checker ? progress.checker : pick
      const route = routeOptions.find((entry) => entry.id === selectedRoute.provider) ?? null
      const models = React.useMemo(() => checkerModelsOf((groups ?? []).find((group) => group.id === selectedRoute.provider)),
        [groups, selectedRoute.provider])
      const validModel = models.some((model) => model.id === selectedRoute.model)
      const missingChecker = usesChecker && (route === null || !validModel)
      const excludedId = usesChecker && validModel ? selectedRoute.model : undefined
      const scope = React.useMemo(() => checkerScopeOf(groups, excludedId), [groups, excludedId])
      const runId = typeof progress?.runId === 'string' && progress.runId !== '' ? progress.runId : undefined
      const cancelLocked = pending || stopping || (requiresRunId && runId === undefined)
      const showWriteWarning = running ? progress?.writeBack === true : writeBack
      const showFullWarning = running ? progress?.fullScan === true : autoFullScan || (canFullScan && fullScan)

      React.useEffect(() => {
        if (running || !canFullScan || autoFullScan) setFullScan(false)
      }, [running, canFullScan, autoFullScan])

      const lastFinished = React.useRef(progress?.finishedAt)
      React.useEffect(() => {
        if (running || progress?.finishedAt === undefined || lastFinished.current === progress.finishedAt) return
        lastFinished.current = progress.finishedAt
        onFinished?.()
      }, [running, progress?.finishedAt, onFinished])

      const lastWrite = React.useRef(latestWrite?.finishedAt)
      React.useEffect(() => {
        if (latestWrite?.finishedAt === undefined || lastWrite.current === latestWrite.finishedAt) return
        lastWrite.current = latestWrite.finishedAt
        if (latestWrite.written === true && !running) onFinished?.()
      }, [latestWrite?.finishedAt, running, onFinished])

      if (!canUse && !running && !pending && !progress && !state.error) {
        return h('div', { className: 'mvp_banner' }, t('checker.catalogNeeded'))
      }

      const commit = (next) => {
        setPick(next)
        persistPick(next)
      }

      const run = () => {
        if (!canUse || locked || missingChecker || verify.getSnapshot().epoch !== state.epoch) return
        setMessage(null)
        setFullScan(false)
        verify.start({
          ...(usesChecker ? { provider: pick.provider, model: pick.model } : {}),
          writeBack,
          ...(canSetSourceMode
            ? { mode: shownMode, fuzzyMatch: usesCatalog && fuzzyMatch }
            : {
                webSearch: usesChecker && pick.webSearch,
                ...(canSetMode ? { useChecker: usesChecker, fuzzyMatch } : {}),
              }),
          concurrency: pick.concurrency,
          fullScan: autoFullScan || (canFullScan && fullScan),
        }).catch((error) => setMessage(String(error?.message ?? error)))
      }

      const cancel = () => {
        if (!running || cancelLocked || verify.getSnapshot().epoch !== state.epoch) return
        setMessage(null)
        verify.cancel(runId).catch((error) => {
          setOpen(true)
          setMessage(String(error?.message ?? error))
        })
      }

      const counts = {
        processed: progress?.processed ?? progress?.done ?? 0,
        total: progress?.total ?? 0,
        valid: progress?.done ?? 0,
        unknown: progress?.unknown ?? 0,
        failed: progress?.failed ?? 0,
        skippedKnown: progress?.skippedKnown ?? 0,
        searchCalls: progress?.searchCalls ?? 0,
        fetchCalls: progress?.fetchCalls ?? 0,
        tokens: formatTokens(bucketTotalOf(progress?.tokenUsage)),
      }
      const finished = ['done', 'cancelled', 'error'].includes(progress?.phase)
      const allSkipped = progress?.phase === 'done' && counts.total === 0 && counts.skippedKnown > 0
      const writeBackSkipped = progress?.writeBack === true && progress?.fullScan !== true && counts.skippedKnown > 0
      const runningPhase = RUN_PHASES.includes(progress?.phase) ? progress.phase : 'verifying'
      let summary = t('checker.idle')
      if (running) summary = t('checker.running', { phase: t('checker.phase.' + runningPhase) })
      else if (pending) summary = t('checker.starting')
      else if (progress?.phase === 'error') summary = t('checker.runFailed')
      else if (progress?.phase === 'cancelled') summary = t('checker.cancelled')
      else if (allSkipped) summary = t('checker.allSkipped', counts)
      else if (finished) summary = t('checker.finished')
      if (runMode !== null && progress?.phase !== 'idle' && !pending) summary += ' · ' + t('checker.mode.' + runMode)
      if ((running || finished) && !allSkipped && counts.total > 0) {
        summary += ' · ' + t('checker.progress', counts)
      }

      const routing = []
      if (Number.isFinite(progress?.catalogTargets)) routing.push(t('checker.catalogTargets', { count: progress.catalogTargets }))
      if (runMode !== 'checker' && Number.isFinite(progress?.catalogMatches)) {
        routing.push(t('checker.catalogMatches', { count: progress.catalogMatches }))
      }
      if (runMode !== 'checker' && Number.isFinite(progress?.publicReliable) && progress?.phase !== 'idle') {
        routing.push(t('checker.reliable', { count: progress.publicReliable }))
      }
      if (Number.isFinite(progress?.checkerTargets)) routing.push(t('checker.checkerTargets', { count: progress.checkerTargets }))
      if (routeLabel(progress?.checker) !== null && runMode !== 'public') {
        routing.push(t('checker.usedRoute', { target: routeLabel(progress.checker) }))
      }
      const searchBackends = ['dsh-free-search', 'host-web'].flatMap((backend) => {
        const count = progress?.searchBackends?.[backend]
        return Number.isFinite(count) && count > 0 ? [t('checker.searchBackend.' + backend, { count })] : []
      })
      const activeBatches = running && Array.isArray(progress?.batches)
        ? progress.batches.filter((batch) => batch.status === 'running') : []
      const notices = [...new Set([message, state.error].filter((error) => error != null))]
      const errors = [...new Set([...notices, ...(Array.isArray(progress?.errors) ? progress.errors : [])])]
      const sources = Array.isArray(progress?.sources) ? progress.sources : []
      const sourceFailures = progress?.sourceFailures ?? sources.filter((s) => ['http', 'failed', 'too-large', 'bad-json'].includes(s.status)).length
      const showWebUsage = runMode !== 'public' && progress?.useChecker !== false && (counts.searchCalls > 0 || counts.fetchCalls > 0 || counts.tokens !== '0' || (counts.total > 0 && progress?.checkerTargets !== 0))

      const checkbox = (key, checked, change) => h('label', { className: 'mvp_check', title: t(key + 'Title') },
        h('input', { type: 'checkbox', checked, disabled: locked, 'aria-label': t(key),
          onChange: (event) => change(event.target.checked) }),
        h('span', null, t(key)),
      )
      const select = (key, value, options, change, { placeholder, disabled, title } = {}) => h('label', { className: 'mvp_field', title },
        h('span', { className: 'mvp_fieldLabel' }, t(key)),
        h('select', { className: 'mvp_select', value, disabled: locked || disabled, 'aria-label': t(key),
          onChange: (event) => change(event.target.value) },
        placeholder ? h('option', { value: '' }, t(placeholder)) : null,
        options.map(([id, name]) => h('option', { key: id, value: id }, name)),
        ),
      )

      return h('div', { className: 'mvp_checker' },
        h('div', { className: 'mvp_checkerBar' },
          h('button', { type: 'button', className: 'mvp_checkerHead', 'aria-expanded': open, onClick: () => setOpen(!open) },
            h('span', { className: 'mvp_chevron', 'aria-hidden': true }, open ? '▾' : '▸'),
            h('span', { className: 'mvp_checkerTitle' }, t('checker.title')),
            h('span', { className: 'mvp_checkerSummary', 'aria-live': 'polite', 'aria-atomic': true }, summary),
            errors.length > 0 ? h('span', { className: 'mvp_badge' }, t('checker.errorBadge', { count: errors.length })) : null,
          ),
          running ? h('button', { type: 'button', className: 'mvp_button', disabled: cancelLocked,
            title: t(requiresRunId && !runId ? 'checker.stopNoId' : 'checker.cancelTitle'), onClick: cancel }, t(stopping ? 'checker.stopping' : 'checker.cancel')) : null,
        ),
        pendingWrite?.waitEnded != null ? h('div', { className: 'mvp_usageHint mvp_usageHint--warn mvp_checkerNotice', role: 'status' },
          t('checker.pendingWrite', { target: routeLabel(pendingWrite) })) : null,
        open ? h('div', { className: 'mvp_checkerBody' },
          !canUse ? h('p', { className: 'mvp_checkerHint' }, t('checker.catalogNeeded')) : null,
          canSetSourceMode ? h('fieldset', { className: 'mvp_checkerModes', disabled: locked, 'aria-describedby': modeHint },
            h('legend', { className: 'mvp_fieldLabel' }, t('checker.sourceMode')),
            SOURCE_MODES.map((mode) => h('label', { key: mode, className: 'mvp_checkerMode' },
              h('input', { type: 'radio', name: modeGroup, value: mode, checked: shownMode === mode, disabled: locked,
                onChange: () => { setFullScan(false); commit({ ...pick, mode }) } }),
              h('span', null, t('checker.mode.' + mode)),
            )),
          ) : null,
          h('p', { id: modeHint, className: 'mvp_checkerHint' }, t(canSetSourceMode
            ? 'checker.hint.' + shownMode : usesChecker ? 'checker.description' : 'checker.publicDescription')),
          h('div', { className: 'mvp_checkerForm' },
            !canSetSourceMode && canSetMode ? checkbox('checker.useChecker', usesChecker, (useChecker) => commit({ ...pick, useChecker })) : null,
            usesChecker ? select('checker.provider', route?.id ?? '',
              routeOptions.map((entry) => [entry.id, entry.name]), (provider) => commit({ ...pick, provider, model: '' }),
              { placeholder: 'checker.chooseProvider' }) : null,
            usesChecker ? select('checker.model', validModel ? selectedRoute.model : '',
              models.map((model) => [model.id, model.name ?? model.id]), (model) => commit({ ...pick, model }),
              { placeholder: 'checker.chooseModel', disabled: route === null }) : null,
          ),
          !locked && canUse && missingChecker ? h('p', { className: 'mvp_checkerHint mvp_checkerNotice' },
            routeOptions.length === 0 ? t(canSetMode || canSetSourceMode ? 'checker.noRoute' : 'checker.noLegacyRoute') : t('checker.chooseRoute')) : null,
          h('div', { className: 'mvp_checkerNotice', id: scopeHint },
            h('div', { className: 'mvp_checkerProgressText' }, t('checker.scopeNow', scope)),
            showWriteWarning ? h('div', { className: 'mvp_checkerOptionNote' }, t('checker.writeWarning')) : null,
            showFullWarning ? h('div', { className: 'mvp_checkerOptionNote' }, t('checker.fullWarning')) : null),
          !running ? h('button', { type: 'button', className: 'mvp_button mvp_button--accent', 'aria-describedby': scopeHint,
            disabled: !canUse || locked || missingChecker, title: t('checker.startTitle'), onClick: run },
            t(usesChecker ? 'checker.start' : 'checker.startPublic')) : null,
          usesChecker || canSetMode || canSetSourceMode || canFullScan ? h('details', { className: 'mvp_checkerDetails' },
            h('summary', null, t('checker.advanced')),
            h('div', { className: 'mvp_checkerAdvanced' },
              usesCatalog && (canSetSourceMode || canSetMode)
                ? checkbox('checker.fuzzyMatch', running ? progress?.fuzzyMatch ?? fuzzyMatch : fuzzyMatch,
                    (fuzzyMatch) => commit({ ...pick, fuzzyMatch })) : null,
              canFullScan && !autoFullScan
                ? checkbox('checker.fullScan', running ? progress?.fullScan === true : fullScan, setFullScan) : null,
              usesChecker ? checkbox('checker.writeBack', running ? progress?.writeBack === true : writeBack,
                (writeBack) => commit({ ...pick, writeBack })) : null,
              usesChecker && !canSetSourceMode ? checkbox('checker.webSearch', running ? progress?.webSearch ?? pick.webSearch : pick.webSearch,
                (webSearch) => commit({ ...pick, webSearch })) : null,
              usesChecker ? select('checker.concurrency', String(running ? progress?.concurrency ?? pick.concurrency : pick.concurrency),
                CONCURRENCY_CHOICES.map((count) => [String(count), t('checker.concurrencyValue', { count })]),
                (concurrency) => commit({ ...pick, concurrency: Number(concurrency) }), { title: t('checker.concurrencyTitle') }) : null,
            ),
            usesChecker ? h('div', { className: 'mvp_usageHint' }, t('checker.resultsScope')) : null,
            usesChecker && (running ? progress?.writeBack === true : writeBack) && !autoFullScan && !(running ? progress?.fullScan : fullScan)
              ? h('div', { className: 'mvp_usageHint' }, t('checker.writeBackScope')) : null,
          ) : null,
          (running || finished) && counts.total > 0 ? h('div', { className: 'mvp_checkerProgress' },
            running ? h('div', { className: 'mvp_progressBar', role: 'progressbar', 'aria-label': t('checker.progressLabel'),
              'aria-valuemin': 0, 'aria-valuemax': counts.total, 'aria-valuenow': counts.processed }, h('span', {
              className: 'mvp_progressFill', style: { width: Math.min(100, Math.round((counts.processed / counts.total) * 100)) + '%' },
            })) : null,
            h('span', { className: 'mvp_checkerProgressText' }, t('checker.outcomes', counts)),
          ) : null,
          routing.length > 0 ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' }, routing.join(' · ')) : null,
          (running || finished) && showWebUsage
            ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' },
              t('checker.webCalls', counts), ' · ', t('checker.tokens', counts),
              searchBackends.length > 0 ? ' · ' + t('checker.searchBreakdown', { breakdown: searchBackends.join(' · ') }) : null,
            ) : null,
          sourceFailures > 0 ? h('div', { className: 'mvp_usageHint mvp_checkerNotice mvp_checkerOptionNote' },
            t('checker.sourceFailures', { count: sourceFailures })) : null,
          (!Number.isFinite(progress?.publicReliable) && progress?.publicOnly > 0) || (progress?.aliasMatches ?? 0) > 0
            ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' }, [
              !Number.isFinite(progress?.publicReliable) && progress?.publicOnly > 0 ? t('checker.catalogResults', { count: progress.publicOnly }) : null,
              progress?.aliasMatches > 0 ? t('checker.aliasMatches', { count: progress.aliasMatches }) : null,
            ].filter(Boolean).join(' · ')) : null,
          latestWrite?.finishedAt != null ? h('div', { className: 'mvp_usageHint mvp_checkerNotice',
            title: latestWrite.message || latestWrite.reason }, t(latestWrite.written === true
            ? 'checker.lateWriteApplied' : 'checker.lateWriteNotApplied', { target: routeLabel(latestWrite) })) : null,
          writeBackSkipped ? h('div', { className: 'mvp_usageHint mvp_checkerNotice' },
            t('checker.writeBackSkipped', { count: counts.skippedKnown })) : null,
          errors.length > 0 ? errorsView(errors, t, notices.length > 0) : null,
          activeBatches.length > 0 ? h('div', { className: 'mvp_sources', 'aria-label': t('checker.activeBatches') },
            h('div', { className: 'mvp_sourcesTitle' }, t('checker.activeBatches')),
            h('ul', { className: 'mvp_sourceList' }, activeBatches.slice(0, MAX_ACTIVE_BATCH_LINES).map((batch, index) =>
              h('li', { key: index },
                h('span', { className: 'mvp_sourceState' }, BATCH_STAGES.includes(batch.stage)
                  ? t('checker.stage.' + batch.stage) : String(batch.stage ?? t('checker.stage.checker'))),
                h('span', { className: 'mvp_sourceName' }, Array.isArray(batch.ids) ? batch.ids.map(String).join(', ') : ''),
              ))),
            activeBatches.length > MAX_ACTIVE_BATCH_LINES ? h('div', { className: 'mvp_usageHint' },
              t('checker.activeMore', { count: activeBatches.length - MAX_ACTIVE_BATCH_LINES })) : null,
          ) : null,
          sources.length > 0 ? h('details', { className: 'mvp_checkerDetails' },
            h('summary', null, t('checker.sourcesTitle'), ' · ', t('checker.sourceSummary', {
              complete: sources.filter((source) => ['ok', 'empty'].includes(source.status)).length, total: sources.length,
            })),
            h('ul', { className: 'mvp_sourceList' }, sources.map((source, index) =>
              h('li', { key: index, className: ['ok', 'empty'].includes(source.status) ? 'mvp_source--ok' : 'mvp_source--bad' },
                h('span', { className: 'mvp_sourceName' }, String(source.name)),
                h('span', { className: 'mvp_sourceState' }, t('checker.source.' + String(source.status))),
                source.attempts > 1 ? h('span', { className: 'mvp_sourceCount' }, t('checker.sourceAttempts', { count: source.attempts })) : null,
                source.models > 0 ? h('span', { className: 'mvp_sourceCount' }, t('checker.sourceModels', { count: source.models })) : null,
                source.message ? h('span', { className: 'mvp_sourceMsg', title: String(source.message) }, shortError(source.message)) : null,
              ))),
          ) : null,
          canBulk ? h(BulkEffortsControl, { api: verify.bulk, t, canUse }) : null,
        ) : null,
      )
    }


    exports.VerifyPanel = VerifyPanel
  })

  // -------------------------------------------------------- composer-filter
  define("composer-filter", function (require, module, exports) {
    const { hiddenIndex } = require("visibility-codec")
    const { clientTrace } = require("diagnostic-events")
    const { FIELD } = require("constants")

    const EMPTY = Object.freeze([])
    function hiddenListOf(snapshot) {
      const value = snapshot && snapshot.value
      return value && Array.isArray(value[FIELD]) ? value[FIELD] : EMPTY
    }

    /** Patch one method while preserving its previous own/inherited shape. */
    function replaceMethod(target, name, wrapper) {
      const original = Object.getOwnPropertyDescriptor(target, name)
      Object.defineProperty(target, name, {
        configurable: original?.configurable ?? true,
        enumerable: original?.enumerable ?? false,
        writable: original && 'writable' in original ? original.writable : true,
        value: wrapper,
      })
      return () => {
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper) return
        if (original) Object.defineProperty(target, name, original)
        else delete target[name]
      }
    }

    /**
     * Filter the existing directory store without swapping any subscriptions.
     * Notify through the underlying SnapshotStore so seats already subscribed at
     * attach time (and those still mounted during removal) see the transition.
     */
    function patchDirectoryStore(store, form) {
      const readBase = store.getSnapshot.bind(store)
      const publishBase = typeof store.set === 'function' ? store.set.bind(store) : null
      let active = true
      let snapshot = null
      let lastBase
      let lastList
      let hidden

      const build = (baseSnapshot) => {
        const selection = baseSnapshot.current
        const groups = []
        let changed = false
        for (const group of baseSnapshot.groups ?? []) {
          const all = group.models ?? []
          const models = all.filter((model) => !hidden.hasRoute(group.id, model.id) ||
            (selection?.provider === group.id && selection.model === model.id))
          if (models.length === all.length) groups.push(group)
          else {
            changed = true
            if (models.length > 0) groups.push({ ...group, models })
          }
        }
        return changed ? { ...baseSnapshot, groups } : baseSnapshot
      }

      const current = () => {
        const baseSnapshot = readBase()
        if (!active) return baseSnapshot
        const list = hiddenListOf(form.getSnapshot())
        if (baseSnapshot === lastBase && list === lastList) return snapshot
        if (list !== lastList) hidden = hiddenIndex(list)
        const next = build(baseSnapshot)
        // Keep the external-store snapshot stable when a hidden-list edit didn't
        // affect this particular directory (e.g. its current model is retained).
        const sameGroups = baseSnapshot === lastBase && next !== baseSnapshot && snapshot !== baseSnapshot &&
          next.groups.length === snapshot.groups.length && next.groups.every((group, index) => {
            const prior = snapshot.groups[index]
            return group === prior || (group.id === prior.id && group.models.length === prior.models.length &&
              group.models.every((model, modelIndex) => model === prior.models[modelIndex]))
          })
        lastBase = baseSnapshot
        lastList = list
        if (!sameGroups) snapshot = next
        return snapshot
      }

      // Capture the pre-attach snapshot so the initial emit notifies even existing subscribers.
      snapshot = readBase()
      let published = snapshot
      const restoreSnapshot = replaceMethod(store, 'getSnapshot', current)
      const notify = () => { if (publishBase) publishBase({ ...readBase() }) }

      return {
        emit() {
          if (published === current()) return
          notify()
          published = current()
        },
        restore({ notifyReaders = true } = {}) {
          if (!active) return
          const changed = current() !== readBase()
          active = false
          restoreSnapshot()
          if (changed && notifyReaders) notify()
          snapshot = lastBase = lastList = hidden = null
        },
      }
    }

    /** Patch live and future directories without retaining closed sessions. */
    function installComposerFilter(scope, form) {
      const models = scope.modelDirectories
      const original = models.directoryFor
      if (typeof original !== 'function') return

      scope.effect(() => {
        const records = new Map()
        const ensure = (directory) => {
          const store = directory?.store
          if (!store || records.has(store)) return directory
          let record
          try {
            record = patchDirectoryStore(store, form)
            let restoreDispose
            const stop = (notifyReaders) => {
              records.delete(store)
              clientTrace('composer', 'detach', { count: records.size })
              restoreDispose?.()
              record.restore({ notifyReaders })
            }
            const dispose = directory.dispose
            if (typeof dispose !== 'function') throw new Error('Directory has no scope disposer')
            restoreDispose = replaceMethod(directory, 'dispose', function (...args) {
              stop(false)
              return dispose.apply(this, args)
            })
            records.set(store, { emit: record.emit, stop })
            clientTrace('composer', 'attach', { count: records.size })
            record.emit()
          } catch (_error) {
            // An unwritable store or directory must not break model selection.
            const installed = records.get(store)
            if (installed) installed.stop(false)
            else record?.restore({ notifyReaders: false })
          }
          return directory
        }

        let restoreResolver
        try {
          restoreResolver = replaceMethod(models, 'directoryFor', function (sessionId) {
            return ensure(original.call(this, sessionId))
          })
        } catch (_error) {
          return
        }
        const live = models.live?.directories?.values
        if (live instanceof Set) for (const directory of live) ensure(directory)
        const stopForm = form.subscribe(() => {
          for (const record of records.values()) record.emit()
        })

        return () => {
          restoreResolver()
          stopForm()
          for (const record of records.values()) record.stop(true)
        }
      }, 'model-visibility: filtered model directory')
    }


    exports.patchDirectoryStore = patchDirectoryStore
    exports.installComposerFilter = installComposerFilter
  })

  // -------------------------------------------------------- constants
  define("constants", function (require, module, exports) {
    /** Dictionary namespace owned by this plugin. */
    const NS = 'model-visibility'
    /** Host entry id from cordis.patch.yml; also the settings namespace. */
    const ENTRY = 'model-visibility'
    /** Config field persisted by the Host settings document. */
    const FIELD = 'hidden'
    /** Settings section id. */
    const SECTION_ID = 'model-visibility'
    /**
     * Same-origin route the Host half registers through `connection.fetch`.
     * Resolved against the page base so a reverse-proxy prefix is preserved.
     */
    const API = (() => {
      if (typeof document === 'undefined') return '/api/dsh-model-visibility'
      try {
        return new URL('api/dsh-model-visibility', document.baseURI).pathname
      } catch (_error) {
        return '/api/dsh-model-visibility'
      }
    })()


    exports.NS = NS
    exports.ENTRY = ENTRY
    exports.FIELD = FIELD
    exports.SECTION_ID = SECTION_ID
    exports.API = API
  })

  // -------------------------------------------------------- css
  define("css", function (require, module, exports) {
    const CSS = `
    /* ---------------------------------------------------------------- shell */
    .mvp_page{box-sizing:border-box;width:100%;height:100%;min-height:0;flex-direction:column;display:flex;overflow-y:auto;padding-bottom:24px}

    /* --------------------------------------------------------------- header */
    .mvp_head{flex:none;align-items:center;gap:12px;padding:2px 0 10px;display:flex;flex-wrap:wrap}
    .mvp_headMain{flex:1;min-width:0;align-items:baseline;gap:10px;display:flex;flex-wrap:wrap}
    .mvp_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
    .mvp_summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
    .mvp_summary--dim{color:var(--dsw-alias-label-tertiary)}
    .mvp_headActions{flex:none;align-items:center;gap:6px;display:flex;flex-wrap:wrap}
    .mvp_about{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin-bottom:10px;padding:8px 12px;background:transparent;background:color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent)}
    .mvp_aboutP{color:var(--dsw-alias-label-secondary);margin:0 0 6px;font-size:12px;line-height:18px}
    .mvp_aboutP:last-child{margin-bottom:0}

    /* -------------------------------------------------------------- buttons */
    .mvp_button{box-sizing:border-box;height:26px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 9px;font-family:inherit;font-size:12px;line-height:18px}
    .mvp_button--quiet{color:var(--dsw-alias-label-secondary);border-color:transparent}
    .mvp_button--quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
    .mvp_button--accent{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)}
    .mvp_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
    .mvp_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .mvp_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.6}

    /* ---------------------------------------------------------------- usage */
    .mvp_usage{flex:none;color:var(--dsw-alias-label-secondary);align-items:center;gap:3px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:4px 0;font-size:12px;line-height:18px;display:flex;flex-wrap:wrap}
    /* A permanent second line prevents a scan/export/error from moving every model below it.
       Use scrollable overflow rather than clipping a long diagnostic at narrow widths / large text. */
    .mvp_usageStatus{display:flex;flex:0 0 100%;height:1.6em;min-height:1.6em;min-width:0;overflow:auto;align-items:baseline;gap:0 1em;line-height:1.5;font-size:11px;scrollbar-width:thin;color:var(--dsw-alias-label-secondary)}
    .mvp_usageStatusText{flex:none;white-space:nowrap}
    .mvp_usage--off{color:var(--dsw-alias-label-tertiary)}
    .mvp_usageLabel{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:6px;flex:none;display:inline-flex}
    .mvp_usageComputing{color:var(--dsw-alias-brand-primary);font-size:11px}
    .mvp_usageRanges{flex:1;min-width:0;align-items:baseline;gap:16px;display:flex;flex-wrap:wrap}
    .mvp_stat{align-items:baseline;gap:5px;display:inline-flex;white-space:nowrap}
    /* The dash on a cold read and the formatted count on the next read take the same slot. */
    .mvp_usageRanges .mvp_statValue{display:inline-block;min-inline-size:5.2ch}
    .mvp_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}
    .mvp_statValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:13px;font-weight:500}
    .mvp_stat--total .mvp_statValue{color:var(--dsw-alias-brand-primary)}
    .mvp_usageActions{flex:none;align-items:center;gap:4px;display:flex}
    .mvp_usageHint{width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
    .mvp_usageHint--warn{color:var(--dsw-alias-state-error-primary)}

    /* --------------------------------------------------------------- filters */
    .mvp_filters{flex:none;align-items:center;gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 0;display:flex;flex-wrap:wrap}
    .mvp_searchInput{box-sizing:border-box;flex:1 1 180px;min-width:150px;max-width:320px;height:26px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 8px;font-family:inherit;font-size:12px}
    .mvp_searchInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
    .mvp_filterGroup{align-items:center;gap:4px;display:flex;flex-wrap:wrap}
    .mvp_filterGroup--push{margin-left:auto}
    .mvp_filter{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 9px;font-family:inherit;font-size:11px;line-height:16px}
    .mvp_filter[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent)}
    .mvp_filter:hover:not([aria-pressed="true"]){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
    .mvp_filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .mvp_contextSelect{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-family:inherit;font-size:11px}

    /* ------------------------------------------------------- applyInput row */
    .mvp_applyRow{flex:none;align-items:center;gap:10px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:8px 0;display:flex}
    .mvp_applyText{flex:1;min-width:0;align-items:baseline;gap:8px;display:flex;flex-wrap:wrap}
    .mvp_applyTitle{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
    .mvp_applyHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}

    /* --------------------------------------------------------------- banners */
    .mvp_banner{flex:none;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin:8px 0;padding:6px 10px;font-size:12px;line-height:18px}
    .mvp_banner--warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent)}
    .mvp_banner--error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent)}
    .mvp_note{flex:none;color:var(--dsw-alias-label-tertiary);padding:6px 0;font-size:11px;line-height:16px}

    /* ---------------------------------------------------------------- groups */
    .mvp_groups{flex:none;flex-direction:column;display:flex}
    .mvp_group{flex:none;flex-direction:column;display:flex}
    .mvp_groupHead{justify-content:space-between;align-items:center;gap:12px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:10px 0 6px;display:flex}
    .mvp_groupTitle{flex:1;min-width:0;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:0;align-items:baseline;column-gap:8px;row-gap:2px;padding:0;font-family:inherit;font-size:13px;font-weight:500;line-height:20px;display:flex;flex-wrap:wrap}
    .mvp_groupTitle:hover .mvp_groupName{color:var(--dsw-alias-brand-primary)}
    .mvp_groupTitle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
    .mvp_chevron{flex:none;align-self:center;width:12px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
    .mvp_groupName{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
    .mvp_groupCount{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
    .mvp_groupCap{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:3px;font-size:11px;font-weight:400;display:inline-flex}
    .mvp_sep{opacity:.5}
    .mvp_kindCount{font-variant-numeric:tabular-nums}
    .mvp_kindCount--image{color:var(--dsw-alias-state-business-primary)}
    .mvp_kindCount--video{color:var(--dsw-alias-state-success-primary)}
    .mvp_kindCount--other{color:var(--dsw-alias-state-warn-primary)}
    .mvp_groupProbe{color:var(--dsw-alias-label-tertiary);border:.5px dashed var(--dsw-alias-border-l2);border-radius:4px;max-width:100%;white-space:nowrap;text-overflow:ellipsis;padding:0 5px;font-size:10px;line-height:15px;overflow:hidden}
    .mvp_groupProbe--warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}

    /* ------------------------------------------------------------------ rows */
    .mvp_row{justify-content:space-between;align-items:center;gap:16px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:8px 0 8px 6px;display:flex}
    .mvp_row--off .mvp_rowTitle{color:var(--dsw-alias-label-secondary)}
    .mvp_visibilityLabel{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}
    .mvp_row--gen{background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 3%, transparent)}
    .mvp_row--kind-image{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 70%, transparent)}
    .mvp_row--kind-video{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, transparent)}
    .mvp_row--kind-embedding{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, transparent)}
    .mvp_row--kind-rerank{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, transparent)}
    .mvp_row--kind-audio{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary))}
    .mvp_row--kind-classifier{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-error-secondary) 60%, transparent)}
    .mvp_row--kind-translation{box-shadow:inset 2px 0 0 var(--dsw-alias-border-l2)}
    .mvp_rowText{flex-direction:column;gap:3px;min-width:0;display:flex}
    .mvp_rowHead{align-items:baseline;gap:8px;min-width:0;display:flex;flex-wrap:wrap}
    .mvp_rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
    .mvp_rowMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%;font-size:11px;line-height:18px;overflow:hidden}
    .mvp_rowActions{flex:none;align-items:center;gap:6px;display:flex}
    .mvp_editButton{height:24px;padding:0 8px;font-size:11px}

    /* ---------------------------------------------------------------- switch */
    .mvp_switch{position:relative;flex:none;box-sizing:border-box;width:34px;height:19px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background-color .15s ease}
    .mvp_switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
    .mvp_switch:disabled{opacity:.45;cursor:default}
    .mvp_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .mvp_thumb{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px var(--dsw-alias-border-l2);transition:transform .15s ease}
    .mvp_switch[aria-checked="true"] .mvp_thumb{transform:translateX(15px)}
    .mvp_switch[aria-checked="false"] .mvp_thumb{background:var(--dsw-alias-label-secondary)}

    /* ------------------------------------------------------------------ tags */
    .mvp_tags{flex-wrap:wrap;align-items:center;gap:4px;display:flex}
    .mvp_tag{box-sizing:border-box;max-width:100%;height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;align-items:center;padding:0 5px;font-size:10px;line-height:15px;display:inline-flex;overflow:hidden;text-overflow:ellipsis}
    .mvp_tag--accent{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)}
    .mvp_tag--vision{color:var(--dsw-alias-state-business-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)}
    .mvp_tag--kind{font-weight:500}
    .mvp_tag--kind-image{color:var(--dsw-alias-state-business-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent)}
    .mvp_tag--kind-video{color:var(--dsw-alias-state-success-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent)}
    .mvp_tag--kind-embedding{color:var(--dsw-alias-state-warn-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent)}
    .mvp_tag--kind-rerank{color:var(--dsw-alias-state-error-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent)}
    .mvp_tag--kind-audio{color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary));background:transparent;background:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary)) 12%, transparent);border-color:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary)) 50%, transparent)}
    .mvp_tag--kind-classifier{color:var(--dsw-alias-state-error-secondary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-secondary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-secondary) 55%, transparent)}
    .mvp_tag--kind-translation{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}
    .mvp_tag--kind-unknown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
    .mvp_tag--inferred{border-style:dashed}
    .mvp_tag--muted{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l1)}

    /* --------------------------------------------------------------- editor */
    .mvp_editor{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin:4px 0 8px;padding:10px 12px;background:transparent;background:color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent)}
    .mvp_editorHead{margin-bottom:8px}
    .mvp_editorTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
    .mvp_editorSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
    .mvp_editorGrid{flex-wrap:wrap;align-items:flex-start;gap:8px 14px;display:flex}
    .mvp_field{flex-direction:column;gap:3px;min-width:140px;display:flex}
    .mvp_field--wide{flex:1 1 100%}
    .mvp_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
    .mvp_select,.mvp_number{box-sizing:border-box;height:26px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;font-family:inherit;font-size:12px}
    .mvp_chips{flex-wrap:wrap;gap:4px;display:flex}
    .mvp_chip{box-sizing:border-box;height:23px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 9px;font-family:inherit;font-size:11px}
    .mvp_chip[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent)}
    .mvp_chip:disabled{opacity:.45;cursor:default}
    .mvp_check{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;line-height:18px;display:inline-flex;cursor:pointer}
    .mvp_editorNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
    .mvp_editorError{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;margin-top:6px}
    .mvp_editorFooter{justify-content:space-between;align-items:flex-end;gap:12px;margin-top:10px;display:flex;flex-wrap:wrap}
    .mvp_editorActions{align-items:center;gap:6px;display:flex}

    /* -------- shared list, field sources, confirmation and status surfaces */
    .mvp_page > *{min-width:0}
    .mvp_modelBlock{flex:none;min-width:0}
    .mvp_listTools{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:4px 0;font-size:12px}
    .mvp_details{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
    .mvp_details summary{cursor:pointer;width:fit-content;max-width:100%}
    .mvp_details p,.mvp_preview p{margin:4px 0;line-height:1.55}
    .mvp_listTools .mvp_details[open],.mvp_applyRow .mvp_details[open]{flex:1 1 100%}
    .mvp_applyRow{flex-wrap:wrap}
    .mvp_visibilityLabel,.mvp_factsButton{font-size:11px}
    .mvp_factsButton{color:var(--dsw-alias-label-secondary);background:none;border:0;font-family:inherit;cursor:pointer;padding:1px 4px;text-decoration:underline;text-underline-offset:2px}
    .mvp_facts{font-size:12px;color:var(--dsw-alias-label-secondary);padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
    .mvp_facts ul,.mvp_targetList{margin:4px 0;padding-inline-start:20px}
    .mvp_sourcesLinks{display:flex;flex-wrap:wrap;gap:4px 12px}
    .mvp_sourcesLinks a{color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}
    .mvp_receipt{flex:none;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);border-inline-start:3px solid var(--dsw-alias-brand-primary);margin:6px 0;padding:5px 10px;overflow-wrap:anywhere}
    .mvp_preview{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);border-inline-start:2px solid var(--dsw-alias-border-l2);margin-top:6px;padding:4px 10px;overflow-wrap:anywhere}
    .mvp_editor{flex:none;min-width:0;overflow-wrap:anywhere}
    .mvp_editorHead{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px}
    .mvp_editorTitle{margin:0;font-weight:550}
    .mvp_editor .mvp_field{box-sizing:border-box;max-width:100%;border:0;margin:0;padding:0;min-inline-size:0}
    .mvp_editor .mvp_fieldLabel{color:var(--dsw-alias-label-secondary)}
    .mvp_editor .mvp_editorActions,.mvp_dialog .mvp_editorActions{flex-wrap:wrap}
    .mvp_editor .mvp_editorFooter{align-items:center;gap:8px 12px}
    .mvp_editorNote{margin:4px 0}
    .mvp_details summary:focus-visible,.mvp_factsButton:focus-visible,.mvp_sourcesLinks a:focus-visible,.mvp_editor :focus-visible,.mvp_dialog :focus-visible,.mvp_contextSelect:focus-visible,.mvp_usageStatus:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .mvp_targetList{max-height:11rem;overflow:auto}
    .mvp_dialog{box-sizing:border-box;width:min(32rem,calc(100% - 32px));max-height:80dvh;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:16px 20px;font:inherit;font-size:13px;line-height:1.55;overflow-wrap:anywhere}
    .mvp_dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 35%,transparent)}
    .mvp_dialogTitle{font-size:15px;line-height:1.5;margin:0}
    .mvp_dialog .mvp_editorActions{justify-content:flex-end;margin-top:12px}
    .mvp_debug,.mvp_aboutPanel{flex:none;min-width:0}
    @media(max-width:520px){.mvp_row{gap:5px}.mvp_rowActions{gap:3px}.mvp_searchInput{width:100%;max-width:none;flex-basis:100%}.mvp_groupHead{gap:5px}.mvp_editor{padding:8px}.mvp_usageRanges{gap:4px 7px}}
    @media(prefers-reduced-motion:reduce){.mvp_thumb,.mvp_switch,.mvp_progressFill{transition:none}}

    /* --------------------------------------------------------------- checker */
    .mvp_checker{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin-top:12px;overflow:hidden}
    .mvp_checkerBar{display:flex;align-items:center;gap:6px;padding-right:4px}
    .mvp_checkerBar .mvp_button{flex-shrink:0}
    .mvp_checkerHead{box-sizing:border-box;flex:1;min-width:0;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:0;align-items:baseline;gap:4px 8px;padding:7px 10px;font-family:inherit;font-size:12px;line-height:18px;display:flex;flex-wrap:wrap}
    .mvp_checkerHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .mvp_checkerHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
    .mvp_checkerTitle{font-weight:500;flex:none}
    .mvp_checkerSummary{color:var(--dsw-alias-label-secondary);flex:1 1 120px;min-width:0;font-size:11px;font-variant-numeric:tabular-nums}
    .mvp_badge{flex:none;color:var(--dsw-alias-state-warn-primary);border:.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);border-radius:999px;padding:0 6px;font-size:10px;line-height:15px}
    .mvp_checkerBody{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px}
    .mvp_checkerModes{min-inline-size:0;border:0;margin:0 0 6px;padding:0;display:flex;flex-wrap:wrap;gap:4px 6px}
    .mvp_checkerModes legend{margin-bottom:4px;padding:0}
    .mvp_checkerMode{align-items:center;gap:5px;display:inline-flex;padding:4px 8px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font-size:12px;line-height:16px}
    .mvp_checkerMode input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
    .mvp_checkerMode:has(input:checked){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)}
    .mvp_checkerMode:has(input:disabled){cursor:default;opacity:.75}
    .mvp_checkerMode:has(input:focus-visible){outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .mvp_checkerHint{color:var(--dsw-alias-label-secondary);margin:0 0 8px;font-size:11px;line-height:16px}
    .mvp_checkerForm,.mvp_checkerAdvanced{align-items:flex-end;gap:8px;display:flex;flex-wrap:wrap}
    .mvp_checkerForm .mvp_field,.mvp_checkerAdvanced .mvp_field{min-width:0;max-width:100%}
    .mvp_checkerForm .mvp_select,.mvp_checkerAdvanced .mvp_select{min-width:120px;max-width:100%}
    .mvp_checkerAdvanced{padding:6px 0}
    .mvp_checkerAdvanced .mvp_check{min-height:26px}
    .mvp_checkerDetails{margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
    .mvp_checkerDetails summary{cursor:pointer;width:fit-content;max-width:100%}
    .mvp_checkerDetails summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .mvp_checkerOptionNote{color:var(--dsw-alias-state-warn-primary)}
    .mvp_checkerNotice{box-sizing:border-box;margin-top:5px;overflow-wrap:anywhere}
    .mvp_checkerBar + .mvp_checkerNotice{margin:0;padding:0 10px 6px}
    .mvp_checkerProgress{align-items:center;gap:5px 10px;margin-top:8px;display:flex;flex-wrap:wrap}
    .mvp_progressBar{flex:1 1 160px;min-width:120px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
    .mvp_progressFill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease;display:block}
    .mvp_checkerProgressText{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
    .mvp_checkerErrors{margin-top:10px}
    .mvp_checkerErrorsTitle{color:var(--dsw-alias-state-warn-primary);margin-bottom:4px;font-size:11px;line-height:16px}
    .mvp_errorList{max-height:150px;color:var(--dsw-alias-label-secondary);margin:0;padding-left:18px;font-size:11px;line-height:16px;overflow-y:auto}
    .mvp_errorList li{margin-bottom:3px;overflow-wrap:anywhere}
    .mvp_sources{margin-top:10px}
    .mvp_sourcesTitle{color:var(--dsw-alias-label-tertiary);margin-bottom:4px;font-size:11px;line-height:16px}
    .mvp_sourceList{max-height:150px;margin:0;padding:0;list-style:none;font-size:11px;line-height:16px;overflow-y:auto}
    .mvp_sourceList li{flex-wrap:wrap;align-items:baseline;gap:6px;padding:2px 0;display:flex}
    .mvp_sourceName{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
    .mvp_sourceState{flex:none;border-radius:4px;padding:0 4px;font-size:10px;line-height:14px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
    .mvp_source--ok .mvp_sourceState{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)}
    .mvp_source--bad .mvp_sourceState{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
    .mvp_sourceCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
    .mvp_sourceMsg{flex:1 1 100%;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}

    /* ---------------------------------------------------------------- footer */
    .mvp_footer{flex:none;align-items:center;gap:14px;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:8px;font-size:11px;line-height:16px;display:flex;flex-wrap:wrap}
    .mvp_footerItem{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
    `


    exports.CSS = CSS
  })

  // -------------------------------------------------------- diagnostic-events
  define("diagnostic-events", function (require, module, exports) {
    const { API } = require("constants")

    // Browser instrumentation is inert until this Host explicitly opens a debug session.
    // Send metadata to the same authenticated Host only. Never send a draft, request body,
    // raw result, headers, error message, credential, or endpoint URL.
    let active = null
    let buffer = []
    let timer = null
    let sending = false
    let lost = 0
    const batchMax = 40
    const keys = new Set('provider model runId requestId fields source status reason mode count total eligible skipped failed written pending processed accepted durationMs bytes groups models cached fresh enabled ok'.split(' '))
    const symbol = /^[\p{L}\p{N}_.:/+@~-]{1,120}$/u
    const secret = /(?:https?:|bearer|(?:sk-|gh[pousr]_|github_pat_|AKIA[A-Z0-9])|[A-Za-z0-9_\-]{40,})/i
    const label = (v) => typeof v === 'string' && symbol.test(v) && !secret.test(v) && !v.startsWith('/') && !v.includes('://') ? v : undefined
    const clean = (input) => {
      const out = {}
      for (const key of keys) {
        const val = input?.[key]
        if (typeof val === 'boolean' || Number.isFinite(val)) out[key] = val
        else if (key === 'fields' && Array.isArray(val)) out.fields = val.slice(0, 24).map(label).filter(Boolean)
        else if (label(val)) out[key] = label(val)
      }
      return out
    }
    function arm() {
      if (!active || sending || timer !== null || !buffer.length) return
      timer = setTimeout(flush, 250)
      timer?.unref?.()
    }
    async function flush() {
      timer = null
      if (!active || sending || !buffer.length) return
      const epoch = active
      const events = buffer.splice(0, batchMax)
      if (lost) { events.push({ module: 'client', step: 'buffer.dropped', data: { count: lost } }); lost = 0 }
      sending = true
      try {
        const res = await fetch(API + '/diagnostics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'append', epoch, events }), signal: AbortSignal.timeout(4000) })
        if (active === epoch && (res.status === 409 || res.status === 404)) setClientTraceSession(null)
      } catch { /* No retry loop and no interference with application work. */ }
      finally { sending = false; arm() }
    }
    function setClientTraceSession(epoch) {
      const next = typeof epoch === 'string' && /^[a-f0-9-]{36}$/i.test(epoch) ? epoch : null
      if (next === active) return
      active = next; buffer = []; lost = 0
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    function tracedFetch(path, options, fetchImpl = fetch) {
      if (!active || typeof globalThis.crypto?.randomUUID !== 'function') return fetchImpl(path, options)
      const session = active
      const requestId = globalThis.crypto.randomUUID()
      const module = String(path).split('?')[0].split('/').pop() || 'client'
      const start = Date.now()
      clientTrace(module, 'request.sent', { requestId, mode: options?.method === 'POST' ? 'write' : 'read' })
      return Promise.resolve().then(() => fetchImpl(path, { ...options, headers: { ...options?.headers, 'x-mv-request-id': requestId } }))
        .then(response => { if (active === session) clientTrace(module, 'reply.received', { requestId, accepted: response.ok, durationMs: Date.now() - start }); return response },
          error => { if (active === session) clientTrace(module, 'reply.unavailable', { requestId, accepted: false }); throw error })
    }
    function clientTrace(module, step, data = {}) {
      if (!active) return
      if (!label(module) || !label(step)) return
      if (buffer.length >= 200) { lost++; return }
      buffer.push({ module, step, data: clean(data) }); arm()
    }


    exports.setClientTraceSession = setClientTraceSession
    exports.tracedFetch = tracedFetch
    exports.clientTrace = clientTrace
  })

  // -------------------------------------------------------- dict
  define("dict", function (require, module, exports) {
    const DICT = {
      zh: {
        'nav': '模型显示',
        'page.title': '模型显示',
        'page.clearFilters': '清除筛选',
        'page.showMatches': "显示匹配的 {count} 个",
        'page.expandMatches': '展开匹配组',
        'page.collapseMatches': '折叠匹配组',
        'page.listHelp': '显示帮助',
        'page.listHint': "隐藏只影响聊天菜单，不会停用模型或提供商；当前会话已经选中的模型仍保留，切换后才从菜单隐藏。",
        'page.filterHint': "搜索或筛选会临时展开命中分组。组标题显示匹配数和其中可见数；批量操作只更改确认清单里的模型。",
        'page.confirmEnable': "在菜单显示 {count} 个模型？",
        'page.confirmDisable': '隐藏 {count} 个模型？',
        'page.confirmScope': '范围：{scope}。只更改下列 {count} 个模型在聊天列表中的可见性，不切换当前会话。',
        'page.confirmTargets': '查看这 {count} 个模型',
        'page.confirmChanged': '目标清单已变化。请取消并重新核对，不会写入旧清单。',
        'page.doEnable': "确认显示 {count} 个",
        'page.doDisable': '确认隐藏 {count} 个',
        'page.cancel': '取消',
        'page.scopeFiltered': '当前筛选结果',
        'page.scopeCatalog': '当前模型目录（全部分组）',
        'page.visibilityFailed': '可见性未保存。配置可能已更改或只读，请核对最新状态后重试。',
        'page.visibilityReadOnly': '模型可见性只读：当前没有可安全更新的配置版本。',
        'page.applyHelp': '适用范围',
        'page.dismissReceipt': '收起回执',
        'group.count': "菜单可见 {enabled} / {total}",
        'group.matchCount': "匹配 {matches} / {total} · 其中可见 {enabled}",
        'row.visibilityNamed': '在聊天列表显示 {provider} 的 {name}',
        'row.facts': "能力来源",
        'row.factsNamed': '查看 {name} 的能力来源',
        'row.closeFacts': "收起能力来源",
        'tag.lookupId': '匹配条目：{id}',
        'tag.relayAliasTitle': '此项来自中转站列表中的别名匹配，不是此模型 ID 的直接声明。',
        'source.public': '公开目录',
        'override.detached': '此模型当前未在列表中展开。草稿已保留，可以继续编辑或取消。',
        'override.missingRoute': '此路由已不在最新目录中。保留草稿，但不会写入已消失的模型。',
        'override.writeDetails': '写入规则与高级映射',
        'override.hasMapping': '已有手填值',
        'override.mappingScope': '手填请求值仅用于此次提供商写入，不随本地能力设置保存。',
        'override.directReference': '直接写入将采用参考档位：{levels}。实际写入以宿主回执为准。',
        'override.directScope': '只写当前模型；宿主检查可写字段，其余保留在本地。',
        'override.directOldHost': '当前宿主不支持安全直写；仍可只保存到本插件。',
        'override.localDone': '本地设置已保存；没有请求写入提供商。',
        'override.resetDone': '已清除本地覆盖；提供商设置未改动。',
        'override.providerUnconfirmed': '宿主未能确认提供商写入结果。请查看提供商设置，勿重复提交。',
        'override.localRetained': '保留本地副本：{fields}',
        'override.partialEfforts': '部分档位已写入提供商；完整档位草稿仍保存在本地。',
        'override.reason.already-mapped': '已沿用提供商已有映射，无需重复写入。',
        'override.reusedEfforts': '沿用已有映射的档位：{levels}',
        'override.ladderRetained': '完整档位草稿仍保存在本地。',
        'override.recheckLocal': '{reason}。请重新打开编辑器核对当前本地值。',
        'override.partialFields': '部分值已写入，完整草稿仍保存在本地：{fields}',
        'override.protectedFields': '已保留提供商原值：{fields}',
        'override.writeFailed': '未取得完整写入回执：{message}。请先核对最新设置，不要重复提交。',
        'override.discardTitle': '放弃未保存的修改？',
        'override.discardDescription': '模型 {name} 的草稿不会保存。',
        'override.discard': '放弃草稿',
        'override.keepEditing': '保留草稿',
        'page.description':
          '模型开关只改变聊天输入框的候选模型。当前会话已选中的模型不会被强制替换。能力标签区分已声明的值和参考信息。',
        'page.about': '说明',
        'page.aboutTitle': '展开标签含义、来源与颜色说明',
        'page.summary': "聊天菜单可见 {visible} / {total}",
        'page.matchCount': '匹配 {count} 个模型',
        'page.hiddenSummary': '已关闭 {count}',
        'page.kindSummary': '生图/生视频 {count}',
        'page.loading': '正在加载模型列表…',
        'page.empty': '暂无可用模型。',
        'page.filterEmpty': '当前筛选下没有模型。',
        'page.error': '模型列表加载失败：{message}',
        'page.saveFailed': '保存失败，请重试。',
        'page.refresh': '刷新',
        'page.refreshing': '刷新中…',
        'page.refreshTitle': '重新读取适配器与中转站的能力，跳过 TTL；可复用正在进行的探测。',
        'page.reload': '重新获取能力',
        'page.reloading': '正在获取…',
        'page.reloadTitle':
          '清空本插件的能力缓存和正在进行的读取，重新询问适配器与所有中转站；不会改动任何模型开关。适配器没有公布的思考强度仍不会凭空出现。',
        'page.reloadUnavailable': 'Host 半不支持强制重新获取；重启 DSH 后可用。',
        'page.collapseGroups': '折叠全部',
        'page.expandGroups': '展开全部',
        'page.collapseGroupsTitle': '只保留分组标题，方便跳到其他分组',
        'page.expandGroupsTitle': '展开所有被折叠的分组',
        'page.showAll': "显示全部隐藏模型（{count}）",
        'page.showAllTitle': '只启用当前目录清单中已隐藏的模型；确认前不变更。',
        'page.legend':
          '「可选思考强度」来自当前适配器；「目录参考档位」来自公开目录，不影响对话请求。上下文指输入窗口；多模态表示已标注图像能力。',
        'page.metaFallback':
          '模型能力信息暂不可用：上下文与模态显示为未知，推理档位仍来自官方目录。',
        'page.hostStale':
          'Host 半仍是旧版本：颜色与开关已更新，但「放行图像」和官方校正要等 DSH 重启（或 profile 重组）后才会生效。',
        'page.providerFailures': '部分提供方读不到模型：{names}',
        'page.probeFailures': '中转站读取失败：{names}',
        'page.probeSummary': '探测：{ok} 个中转站可读',
        'page.probeSummaryTitle': '中转站探测结果；悬停分组上的标记可看具体诊断',
        'page.probeSummaryNone': '探测：未配置可探测的路由',
        'page.learnedNote': '学习快照 {models} 条（{date}）',
        'usage.title': 'token',
        'usage.computing': '统计中…',
        'usage.none': '—',
        'usage.exportingUsage': '正在扫描并准备使用量 CSV…',
        'usage.exportingModels': '正在准备模型 CSV…',
        'usage.readFailed': '用量数据可能不完整：{message}',
        'usage.exportFailed': 'CSV 下载失败：{message}',
        'usage.detail': '非缓存输入 {input} · 输出 {output} · 缓存读 {cacheRead} · 缓存写 {cacheWrite}',
        'usage.today': '今天',
        'usage.todayTitle': '本地自然日（今天 0 点起）',
        'usage.week': '本周',
        'usage.weekTitle': '本周一 0 点起',
        'usage.month': '本月',
        'usage.monthTitle': '本月 1 日 0 点起',
        'usage.total': '总计',
        'usage.totalTitle': '保留期内按事件发生日统计；缺少时间时回退到会话创建日。',
        'usage.exportUsage': '用量 CSV',
        'usage.exportUsageTitle': '下载按天分桶、含每模型 token 分解的 CSV',
        'usage.exportModels': '模型 CSV',
        'usage.exportModelsTitle': '下载全部提供商模型的可见性与能力表',
        'usage.hostStale': '宿主半尚未提供用量统计，重启 DSH 即可启用。',
        'checker.title': '能力校验',
        'checker.sourceMode': '校验来源',
        'checker.mode.public': '只用公开目录',
        'checker.mode.supplement': '公开目录＋校验员补漏',
        'checker.mode.checker': '仅校验员联网',
        'checker.hint.public': '比对 models.dev、OpenRouter 和 Hugging Face。不调用校验员或搜索网页。',
        'checker.hint.supplement': '先比对公开目录，再由校验员联网查找未匹配的模型。可能消耗联网额度和 Token。',
        'checker.hint.checker': '跳过公开目录，由校验员联网重查全部符合条件的模型。可能消耗更多额度和 Token。',
        'checker.description': '先比对公开目录，再用校验员补漏。请在高级选项里确认是否允许联网。',
        'checker.resultsScope': '校验依据目录和资料，不实测目标模型。校验员用量计入上方统计，联网不可用时会报告错误。',
        'checker.useChecker': '使用校验员模型',
        'checker.useCheckerTitle': '关闭后只读取公开目录，不调用校验员或搜索网页。',
        'checker.fuzzyMatch': '允许后缀和别名匹配',
        'checker.fuzzyMatchTitle': '优先匹配原 ID；再按中英文名、标点和尾部规格查找同厂商模型。冲突不猜测，归一化结果只作参考。',
        'checker.publicDescription': '比对公开目录。不调用校验员或搜索网页。',
        'checker.startPublic': '读取公开目录',
        'checker.catalogTargets': '目录比对范围 {count} 个模型',
        'checker.catalogMatches': '目录匹配 {count} 个',
        'checker.checkerTargets': '交给校验员 {count} 个模型',
        'checker.usedRoute': '校验员 {target}',
        'checker.catalogResults': '目录补全 {count} 个模型',
        'checker.aliasMatches': '别名参考 {count} 个',
        'override.useReference': '填入参考档位',
        'override.useReferenceTitle': '预览来源和档位，再决定是否填入草稿；不会写入提供商。',
        'override.referencePreview': '参考档位预览',
        'override.referenceSource': '来源：{source}',
        'override.referenceAlias': '{source}（别名匹配）',
        'override.referenceLevels': '参考档位：{levels}',
        'override.referenceDraft': '草稿档位：{levels}',
        'override.referenceLimit': '最多保留 16 个档位，未填入：{levels}',
        'override.referenceFallbacks': '标准同名备选值（仅补空白映射）：{levels}',
        'override.referenceStandardScope': '仅填入当前模型草稿。参考不代表该上游支持。要使用同名备选值，还需勾选写入提供商与标准 reasoning_effort。',
        'override.referenceManualScope': '仅填入当前模型草稿。此路由不提供同名备选值。若要配置请求值，请以该路由的 API 文档为准。',
        'override.referenceOldHost': '当前 Host 无法保护已有提供商映射。参考档位只能保存在本插件。',
        'override.referenceProviderScope': '仅写入当前提供商的此模型。请核对上游支持的档位和值。部分配置若无法写入，仍可保存本地草稿。',
        'override.referenceSafeguards': '查看保留规则和撤销方式',
        'override.referencePreservation': '直接写入保留已有映射、显式禁用状态和提供商默认档位。只有兼容路由才能补全标准同名值；目录参考不证明上游接受。',
        'override.referenceRevert': '如需撤销提供商改动，请在模型提供商设置中修改该模型。「恢复自动」只清除本插件设置。',
        'override.cancelReference': '取消填入',
        'override.confirmReference': '确认填入草稿',
        'override.referenceApplied': '草稿包含参考档位。',
        'override.referenceWireBlank': '保留已有值，空白可用 {value}',
        'override.referenceDisabled': '已保留提供商明确禁用的推理配置。',
        'override.referenceNonChat': '此路由不是对话模型，未写入参考推理设置。',
        'override.referencePreservedEfforts': '这些档位保留了提供商的已有映射：{levels}',
        'override.saveLocal': '只保存本地',
        'override.saveProvider': '写入提供商',
        'override.providerConfirmTitle': '确认保存并写入模型提供商',
        'override.providerTarget': '写入目标：{provider} / {model}',
        'override.providerContext': '上下文窗口（可写时）：{value}',
        'override.providerInput': '输入模态（兼容时）：{value}',
        'override.providerDisableReasoning': '请求禁用此模型的推理。',
        'override.providerMappings': '手填映射（仅补空白）：{values}',
        'override.providerOmit': '省略上游值',
        'override.providerLocalDefault': '默认档位（仅本地）：{value}',
        'override.providerStandardEnable': '允许此模型发送标准 reasoning_effort。',
        'override.backToDraft': '返回草稿',
        'override.confirmProviderSave': '确认保存并写入',
        'tag.aliasReference': "别名参考",
        'tag.aliasReferenceTitle': "来自公开目录的别名匹配，不是精确 ID 命中，也不代表当前路由支持。",
        'checker.provider': '校验员提供商',
        'checker.model': '校验员模型',
        'checker.chooseProvider': '选择提供商',
        'checker.chooseModel': '选择模型',
        'checker.noRoute': '没有可选的校验员。请配置模型或选用公开目录。',
        'checker.noLegacyRoute': '没有可选的校验员，请先配置模型。',
        'checker.chooseRoute': '选择校验员提供商和模型后即可开始。',
        'checker.targetScope': '校验范围不受本页筛选影响。',
        'checker.advanced': '高级选项',
        'checker.writeBackEnabled': '写回已开启',
        'checker.start': '开始校验',
        'checker.startTitle': '在宿主侧后台运行校验',
        'checker.cancel': '取消',
        'checker.cancelTitle': '中止正在进行的校验',
        'checker.writeBack': '补填提供商空白配置',
        'checker.writeBackTitle':
          '开启：只为确认归属的自定义模型条目补填未配置的输入模态和上下文，不改现有值或推理映射；关闭：只更新本页和快照。',
        'checker.webSearch': '允许搜索与网页读取',
        'checker.webSearchTitle': '默认开启。允许校验员调用搜索与网页读取，可能消耗联网服务额度及模型 Token；联网不可用会报告错误。关闭后仅依据公开目录与校验员已有知识核对。',
        'checker.fullScan': '重查已有记录',
        'checker.fullScanTitle': '重查已有记录，仅本次生效。使用校验员的模式可能消耗更多额度。',
        'checker.searchBackend.dsh-free-search': 'DSH 免费搜索 {count} 次',
        'checker.searchBackend.host-web': '宿主网页搜索 {count} 次',
        'checker.allSkipped': '没有新模型需要校验 · 跳过已知 {skippedKnown}',
        'checker.searchBreakdown': '搜索来源 {breakdown}',
        'checker.idle': '未运行',
        'checker.starting': '正在提交…',
        'checker.running': '{phase}',
        'checker.finished': '已结束',
        'checker.progress': '已处理 {processed}/{total}',
        'checker.progressLabel': '校验进度',
        'checker.tokens': '{tokens} Token',
        'checker.outcomes': '有效 {valid} · 未知 {unknown} · 失败 {failed} · 跳过已知 {skippedKnown}',
        'checker.webCalls': '搜索 {searchCalls} 次 · 网页读取 {fetchCalls} 次',
        'checker.activeBatches': '活跃批次',
        'checker.activeMore': '另有 {count} 个活跃批次',
        'checker.stage.checker': '校验员核对',
        'checker.stage.search': '搜索资料',
        'checker.stage.fetch': '读取网页',
        'checker.stage.writeBack': '写入配置',
        'checker.stage.flush': '保存快照',
        'checker.errorBadge': '{count} 条错误',
        'checker.errorTitle': '本轮错误',
        'checker.errorDetails': '全部错误详情（{count} 条）',
        'checker.concurrency': '并发线程',
        'checker.concurrencyTitle': '同时发出的校验请求数。中转站限流时调低，网络快时调高（上限 8）。',
        'checker.concurrencyValue': '{count} 路',
        'checker.sourcesTitle': '公开目录',
        'checker.sourceSummary': '已读取 {complete}/{total}',
        'checker.source.ok': '已读取',
        'checker.source.empty': '无匹配',
        'checker.source.http': 'HTTP 错误',
        'checker.source.failed': '请求失败',
        'checker.source.bad-json': '非 JSON',
        'checker.source.too-large': '响应过大',
        'checker.source.pending': '等待中',
        'checker.sourceModels': '{count} 条',
        'checker.hostStale': '宿主半不支持联网校验，请重启 DSH 后使用。',
        'checker.catalogNeeded': '当前无法开启新的校验，请先恢复增强模型目录。',
        'checker.writeBackScope': '只写回本轮核验结果。需要写回以前的记录时，请开启「重查已有记录」。',
        'checker.writeBackSkipped': '已跳过 {count} 个已知模型，对应配置未写回。',
        'checker.phase.listing': '正在读取模型列表',
        'checker.phase.public': '正在读取公开目录',
        'checker.phase.checker': '校验员核对中',
        'checker.phase.verifying': '正在分批校验',
        'checker.phase.cancelled': '正在停止',
        'checker.cancelled': '已取消',
        'checker.stopping': '正在停止…',
        'checker.pendingWrite': '已提交的供应商写入仍待确认（{target}）。停止校验不会撤回这次写入。',
        'checker.lateWriteApplied': '延迟的供应商写入已完成（{target}）。',
        'checker.lateWriteNotApplied': '延迟的供应商写入未确认成功（{target}）。',
        'checker.runFailed': '校验失败',
        'checker.source.cancelled': '已取消',
        'checker.sourceAttempts': '尝试 {count} 次',
        'source.snapshot': "学习快照",
        'page.applyInput': '为符合条件的中转站模型补充图像输入',
        'page.applyInputShort': '仅补有可靠图像能力证据、且未明确声明输入模态的中转站对话模型；列表标签不代表请求会放行。',
        'page.applyInputHint':
          '开启后，只为有可靠图像能力证据且未明确声明输入模态的中转站（pi-ai）对话模型补充图像输入。列表标注不保证请求会放行，也不保证上游接受图像。关闭后不补充；不修改提供商配置。',
        'page.kindLegend':
          '类型配色：生图 蓝 · 生视频 绿 · 嵌入 橙 · 音频 紫 · 重排 红 · 审核 玫红 · 翻译 灰。「官方校正」表示目录与厂商文档不一致时以文档为准。',
        'page.searchPlaceholder': '搜索名称或 ID',
        'page.capability.multimodal': "图像输入",
        'page.capability.multimodalTitle': "筛选标有图像输入的模型；标签不是当前路由的实测结果。",
        'page.capability.reasoning': '支持推理',
        'page.capability.reasoningTitle': '只看公布了推理能力的模型',
        'page.contextLabel': '上下文至少',
        'page.context.any': '上下文不限',
        'page.context.128k': '128K+',
        'page.context.256k': '256K+',
        'page.context.512k': '512K+',
        'page.context.1m': '1M+',
        'page.filter.all': '全部',
        'page.filter.chat': '对话',
        'page.filter.image': '生图',
        'page.filter.video': '生视频',
        'page.filter.other': '其它',
        'page.visibility.label': "聊天菜单可见性",
        'page.visibility.all': "不限可见性",
        'page.visibility.enabled': "菜单可见",
        'page.visibility.disabled': "菜单隐藏",
        'group.showAll': "本组显示 {count} 个",
        'group.enabledCount': "全组菜单可见 / 模型总数",
        'group.hideAll': '本组隐藏 {count} 个',
        'group.showFiltered': "显示匹配的 {count} 个",
        'group.hideFiltered': '隐藏匹配的 {count} 个',
        'group.collapseNamed': '折叠 {name} 分组',
        'group.expandNamed': '展开 {name} 分组',
        'group.probeOk': '{models} 个模型 · {caps} 带能力',
        'group.probeNoCaps': '{models} 个模型 · 无能力字段',
        'group.probePartial': '价格接口 {models} 个',
        'group.probeFailed': '读取失败',
        'group.probeSkipped': '未探测',
        'tag.reasoning': '支持推理',
        'tag.noReasoning': '不支持推理',
        'tag.reasoningUnknown': '推理未知',
        'tag.effort': "对话可选",
        'tag.effortReference': '参考档位',
        'tag.effortPublicReference': "目录档位",
        'tag.reasoningReference': "参考支持推理",
        'tag.noReasoningReference': '参考：不支持推理',
        'tag.effortReferenceTitle': "来源：{source}。参考档位不等于当前路由可选，也不会自动发送给上游。",
        'tag.effortWireOff': '未启用 reasoning_effort',
        'tag.effortWireOffTitle': '这个 OpenAI Completions 路由明确关闭了 reasoning_effort。若上游确实支持此字段，请在模型提供商的兼容设置中启用；其他协议可能使用不同的参数。',
        'tag.context': '上下文',
        'tag.unknown': '未知',
        'tag.multimodal': "图像输入",
        'tag.textOnly': '纯文本',
        'tag.modalityUnknown': "输入未知",
        'tag.kind.image': '生图',
        'tag.kind.video': '生视频',
        'tag.kind.embedding': '嵌入',
        'tag.kind.rerank': '重排',
        'tag.kind.audio': '音频',
        'tag.kind.classifier': '审核',
        'tag.kind.translation': '翻译',
        'tag.kind.unknown': '模型',
        'tag.kindTitle': '模型类型：{kind}；类型来源：{source}',
        'tag.kindImageTitle': '图像生成模型（输出图像）；类型来源：{source}',
        'tag.kindVideoTitle': '视频生成模型（输出视频）；类型来源：{source}',
        'tag.correction': '官方校正',
        'tag.correctionTitle': '{note}\n来源：{source}',
        'tag.resolutionTitle': '模型名标注了 {value} 输出档位',
        'tag.imageInput': "图像输入",
        'tag.imageInputTitle': "资料标有图像输入；是否支持改图或参考图，请看当前提供商接口。",
        'tag.reasoningTitle': '支持推理，可用档位：{levels}（来源：{source}）',
        'tag.reasoningCatalogTitle': "来源：{source}。这是参考结论；当前路由没有报告可选档位。",
        'tag.effortTitle': "当前对话可选：{levels}；默认：{fallback}（来源：{source}）。上游是否接受仍由实际接口决定。",
        'tag.effortTitleNoFallback': "当前对话可选：{levels}（来源：{source}）。上游是否接受仍由实际接口决定。",
        'tag.contextTitle': '上下文窗口 {tokens} tokens；来源：{source}',
        'tag.modalityTitle': "输入类型：{modalities}；来源：{source}。这不是对当前路由的实测。",
        'tag.outputTitle': '输出模态：{modalities}；来源：{source}',
        'tag.unknownTitle': "没有足够资料判断。未知不等于不支持。",
        'tag.infoErrorTitle': '模型能力读取失败：{message}',
        'source.config': "提供商配置",
        'source.adapter': "当前适配器",
        'source.provider': '中转站模型列表',
        'source.catalog': '内置模型目录',
        'source.inferred': "名称推断",
        'source.official': '厂商官方文档',
        'source.manual': '手动设置',
        'source.unknown': '未知',
        'effort.off': 'off',
        'effort.minimal': 'minimal',
        'effort.low': 'low',
        'effort.medium': 'medium',
        'effort.high': 'high',
        'effort.max': 'max',
        'effort.xhigh': 'xhigh',
        'tag.manual': '手动',
        'tag.manualTitle': "至少一个能力字段使用了你的手动设置；展开「能力来源」可查看依据。",
        'row.edit': '编辑能力',
        'row.editTitle': '手动指定这个模型的类型、上下文、输入模态与思考强度',
        'override.title': '手动能力设置',
        'override.hint': '这里填写的项会覆盖自动探测结果；留空或选「自动」的项继续按原规则判断。',
        'override.kind': '模型类型',
        'override.kindAuto': '自动判断',
        'override.context': '上下文窗口',
        'override.contextPlaceholder': '留空 = 自动',
        'override.contextInvalid': '上下文窗口必须是大于 0 的整数。',
        'override.input': '输入模态',
        'override.efforts': '思考强度档位',
        'override.defaultEffort': '默认档位',
        'override.defaultEffortAuto': '不指定',
        'override.effortHint':
          '本地档位仅供参考。对话可选档位由适配器决定；此处的默认档位不会改动 Provider 的实际默认值。',
        'override.save': '保存',
        'override.saving': '保存中…',
        'override.reset': '恢复自动',
        'override.cancel': '取消',
        'override.failed': '保存失败：{message}',
        'override.unavailable': 'Host 半仍不支持手动能力设置；重启 DSH 后可用。',
        'override.provider': '同时写入模型提供商设置',
        'override.listNotReady': '等待手动设置清单加载完成',
        'override.listFailed': '无法同步手动设置清单：{message}',
        'override.retryList': '重试读取',
        'override.conflict': '此模型的手动设置已发生变化。请关闭编辑器，再打开并核对最新值后重新编辑。',
        'override.providerHint':
          '默认只保存在本插件。主动勾选后，兼容的输入模态、上下文窗口和已知上游映射可写入 Provider；其余仍保留在本地。',
        'override.providerWritten': '提供商已确认写入：{fields}',
        'override.providerSkipped': '已保存在本插件；提供商设置未写入（{reason}）。',
        'override.resetTitle': '只删除本插件的覆盖；已写入提供商设置的值不会被清除。',
        'override.field.input': '输入模态',
        'override.field.contextWindow': '上下文窗口',
        'override.field.reasoningEfforts': '思考强度',
        'override.reason.nothing': '没有可写入的字段',
        'override.reason.unsupported': '当前 Host 不支持写入提供商设置',
        'override.reason.provider-missing': '提供商设置里找不到该提供商',
        'override.reason.models-missing': '该提供商没有显式模型列表',
        'override.reason.model-missing': '该提供商的模型列表里没有这个模型',
        'override.reason.describe-failed': '读取提供商设置失败',
        'override.reason.settings-failed': '设置服务拒绝了写入',
        'override.reason.skipped': '未请求写入',
        'override.reason.local-only': '没有可安全写入的字段',
        'override.reason.revision-unavailable': '缺少可用的配置版本，已避免覆盖',
        'override.reason.config-provenance-unavailable': '无法确认设置归属',
        'override.reason.expression-backed': '字段由配置表达式提供',
        'override.reason.settings-unverified': '写入结果无法核实，本地设置已保留',
        'override.reason.provider-unverified': '无法确认当前路由的 Provider 设置归属',
        'override.reason.native-catalog': '该模型来自内置目录，没有可写的模型条目',
        'override.reason.protected': '提供商已声明这些字段，未覆盖',
        'override.reason.write-pending': '上一个写入尚未结算，本次已跳过',
        'override.reason.target-changed': '已确认的路由或配置已改变，请重新打开并核对目标',
        'override.reason.override-changed': '提交前此模型的本地设置已被修改，未写入提供商',
        'override.reason.overrides-unavailable': '提交前无法复核本地设置，未写入提供商',
        'override.field.kind': '模型类型',
        'override.field.defaultEffort': '默认档位',
        'override.localOnly': '仅保存在本插件：{fields}',
        'override.unresolvedEfforts': '这些档位没有可用的上游值：{levels}',
        'override.routeDefaultConflict': '推理配置与提供商默认档位冲突，未写入。',
        'override.inheritedLadderConflict': '为保留内置目录映射，未写入推理档位。',
        'override.wireTitle': '上游请求值',
        'override.wireHint': '通常无需填写。直写只补空缺：手填值也不会替换现有映射。要改已有值，请前往「模型提供商」设置。',
        'override.wireValue': '{level} 的上游值',
        'override.wireKeep': '留空 = 保持已有配置',
        'override.standardWire': '让此模型发送标准 reasoning_effort',
        'override.standardWireUnavailable': '同名映射仅适用于使用标准思考格式的 OpenAI Completions 显式模型条目；其他协议请按 Provider 文档配置。',
        'override.standardWireHint': '仅在上游接受 reasoning_effort 和此模型的全部发送值时勾选（包括 Provider 里已有的未选档位）。所选非 off 档位缺少映射时使用同名值；只为此模型开启。',
        'override.standardFormatConflict': '此模型未使用标准 OpenAI Completions 思考格式，未开启 reasoning_effort。',
        'override.field.supportsReasoningEffort': '允许发送 reasoning_effort',
        'override.wireOff': 'Off：使用上游省略值的语义（依协议处理）',
        'page.manualNote':
          '「手动」标签表示这项能力来自你在这个模型上的手动设置，优先于适配器、中转站与内置目录。',
        'correction.glm-5.3-text-only':
          '官方文档：GLM-5.3 仅支持文本模态；原生多模态的是 GLM-5.3-Flash / FlashX。',
        'modality.text': '文本',
        'modality.image': '图像',
        'modality.audio': '音频',
        'modality.video': '视频',
        'modality.file': '文件',
        'provider.account': 'DeepSeek 账号',
      },
      en: {
        'nav': 'Model visibility',
        'page.title': 'Model visibility',
        'page.clearFilters': 'Clear filters',
        'page.showMatches': "Show {count} matches",
        'page.expandMatches': 'Expand matching groups',
        'page.collapseMatches': 'Collapse matching groups',
        'page.listHelp': 'Visibility help',
        'page.listHint': "Hiding affects the chat picker only. It does not disable the model or provider. The active session keeps its selection; the hidden model leaves the picker after you switch.",
        'page.filterHint': "Searching or filtering temporarily expands matching groups. Group headers show matches and how many are shown. Bulk changes apply only to the confirmation list.",
        'page.confirmEnable': "Show {count} models in the picker?",
        'page.confirmDisable': 'Hide {count} models?',
        'page.confirmScope': 'Scope: {scope}. Only the {count} models listed below change visibility in the chat picker. The current session stays on its model.',
        'page.confirmTargets': 'Review these {count} models',
        'page.confirmChanged': 'The target list changed. Cancel and review the new list; the old list will not be written.',
        'page.doEnable': "Confirm showing {count}",
        'page.doDisable': 'Hide {count}',
        'page.cancel': 'Cancel',
        'page.scopeFiltered': 'current filter results',
        'page.scopeCatalog': 'current catalog (all groups)',
        'page.visibilityFailed': 'Visibility was not saved. The settings may have changed or become read-only. Review the latest state and try again.',
        'page.visibilityReadOnly': 'Model visibility is read-only: no safely writable settings revision is available.',
        'page.applyHelp': 'When this applies',
        'page.dismissReceipt': 'Dismiss receipt',
        'group.count': "Shown {enabled} / {total}",
        'group.matchCount': "{matches} / {total} match · {enabled} shown",
        'row.visibilityNamed': 'Show {name} from {provider} in the chat picker',
        'row.facts': "Sources",
        'row.factsNamed': 'Show capability sources for {name}',
        'row.closeFacts': "Close sources",
        'tag.lookupId': 'Matched entry: {id}',
        'tag.relayAliasTitle': 'This field came from a relay-list alias, not a direct declaration for this model ID.',
        'source.public': 'public catalog',
        'override.detached': 'This model is not expanded in the list. Your draft is still here; continue editing or cancel.',
        'override.missingRoute': 'This route is absent from the latest catalog. Your draft is kept, but the missing model cannot be written.',
        'override.writeDetails': 'Write rules and advanced mappings',
        'override.hasMapping': 'custom values set',
        'override.mappingScope': 'Custom request values apply to this provider write only; they are not stored with local capability settings.',
        'override.directReference': 'A direct write will use these reference levels: {levels}. The Host receipt identifies what was written.',
        'override.directScope': 'This model only. The Host checks which fields it can write; the rest stay local.',
        'override.directOldHost': 'This Host does not support safe direct writes. You can still save locally.',
        'override.localDone': 'Local settings saved. No provider write was requested.',
        'override.resetDone': 'Local overrides cleared. Provider settings were not changed.',
        'override.providerUnconfirmed': 'The Host could not confirm the provider write. Check the provider settings before submitting again.',
        'override.localRetained': 'Local copy retained: {fields}',
        'override.partialEfforts': 'Some levels were written to the provider; the complete ladder draft is retained locally.',
        'override.reason.already-mapped': 'Existing provider mappings were reused. No new write was needed.',
        'override.reusedEfforts': 'Levels using existing mappings: {levels}',
        'override.ladderRetained': 'The complete ladder draft is retained locally.',
        'override.recheckLocal': '{reason}. Reopen the editor to check the current local values.',
        'override.partialFields': 'Some values were written; the full draft remains local: {fields}',
        'override.protectedFields': 'Existing provider values kept: {fields}',
        'override.writeFailed': 'No complete write receipt: {message}. Check the latest settings before submitting again.',
        'override.discardTitle': 'Discard unsaved changes?',
        'override.discardDescription': 'Changes in the draft for {name} will not be saved.',
        'override.discard': 'Discard draft',
        'override.keepEditing': 'Keep draft',
        'page.description':
          'Model switches affect the chat picker without replacing a session’s current selection. Capability labels distinguish declared values from references.',
        'page.about': 'About',
        'page.aboutTitle': 'Show what the tags, sources and colours mean',
        'page.summary': "Shown in chat picker: {visible} / {total}",
        'page.matchCount': '{count} matching models',
        'page.hiddenSummary': '{count} hidden',
        'page.kindSummary': '{count} image/video',
        'page.loading': 'Loading model list…',
        'page.empty': 'No models available.',
        'page.filterEmpty': 'No models match this filter.',
        'page.error': 'Could not load the model list: {message}',
        'page.saveFailed': 'Could not save this change. Try again.',
        'page.refresh': 'Refresh',
        'page.refreshing': 'Refreshing…',
        'page.refreshTitle': 'Read adapter and relay capabilities again, skipping cache TTLs; may join an ongoing probe.',
        'page.reload': 'Re-fetch capabilities',
        'page.reloading': 'Re-fetching…',
        'page.reloadTitle':
          'Drops this plugin’s capability caches and any in-flight read, then asks the adapter and every relay again. Model switches are untouched; effort levels the adapter does not publish still cannot appear.',
        'page.reloadUnavailable': 'The Host half does not support a hard re-fetch; restart DSH to enable it.',
        'page.collapseGroups': 'Collapse all',
        'page.expandGroups': 'Expand all',
        'page.collapseGroupsTitle': 'Keep only group headers so other groups are easy to reach',
        'page.expandGroupsTitle': 'Expand every collapsed group',
        'page.showAll': "Show all hidden models ({count})",
        'page.showAllTitle': 'Enable only hidden models in the current catalog list, after confirmation.',
        'page.legend':
          'Selectable effort levels come from the current adapter. Public catalog reference levels do not change chat requests. Context is the input window; multimodal indicates reported image capability.',
        'page.metaFallback':
          'Model capability details are unavailable right now: context and modalities show as unknown, while effort levels still come from the shipped catalog.',
        'page.hostStale':
          'The Host half is still the previous version: the colours and switch are live, but image admission and vendor corrections take effect after DSH restarts (or the profile recomposes).',
        'page.providerFailures': 'Some providers could not be read: {names}',
        'page.probeFailures': 'Relay read failed: {names}',
        'page.probeSummary': 'Probe: {ok} relays readable',
        'page.probeSummaryTitle': 'Relay probe result; hover a group badge for its diagnostics',
        'page.probeSummaryNone': 'Probe: no route configured to probe',
        'page.learnedNote': 'Learned {models} facts ({date})',
        'usage.title': 'tokens',
        'usage.computing': 'scanning…',
        'usage.none': '—',
        'usage.exportingUsage': 'Scanning and preparing the usage CSV…',
        'usage.exportingModels': 'Preparing the models CSV…',
        'usage.readFailed': 'Usage data may be incomplete: {message}',
        'usage.exportFailed': 'CSV download failed: {message}',
        'usage.detail': 'Uncached input {input} · output {output} · cache read {cacheRead} · cache write {cacheWrite}',
        'usage.today': 'Today',
        'usage.week': 'Week',
        'usage.month': 'Month',
        'usage.total': 'Total',
        'usage.todayTitle': 'Local calendar day',
        'usage.weekTitle': 'Since Monday 00:00 local',
        'usage.monthTitle': 'Since the 1st local',
        'usage.totalTitle': 'Usage in the retention window by event date; session creation date is used only when a timestamp is missing.',
        'usage.exportUsage': 'Usage CSV',
        'usage.exportUsageTitle': 'Download a day-bucketed CSV with per-model breakdown',
        'usage.exportModels': 'Models CSV',
        'usage.exportModelsTitle': 'Download visibility and capability table of every provider model',
        'usage.hostStale': 'The Host half does not provide usage stats yet; restart DSH to enable it.',
        'checker.title': 'Capability verification',
        'checker.sourceMode': 'Verification source',
        'checker.mode.public': 'Public catalogs only',
        'checker.mode.supplement': 'Public catalogs + checker',
        'checker.mode.checker': 'Online checker only',
        'checker.hint.public': 'Compare against models.dev, OpenRouter and Hugging Face without calling a checker or searching the web.',
        'checker.hint.supplement': 'Compare against public catalogs first. The checker searches the web for unmatched models. Uses web quota and model tokens if needed.',
        'checker.hint.checker': 'The checker searches the web for all eligible models, bypassing public catalogs. May use more quota and model tokens.',
        'checker.description': 'Read public catalogs first and use a checker for the rest. See Advanced options for web access.',
        'checker.resultsScope': 'Results are based on catalogs and references, without direct tests of target models. The usage strip includes checker tokens. Unavailable web access is reported as an error.',
        'checker.useChecker': 'Use checker model',
        'checker.useCheckerTitle': 'Turn off to read public catalogs without checker calls or web search.',
        'checker.fuzzyMatch': 'Allow suffix and alias matching',
        'checker.fuzzyMatchTitle': 'Try exact IDs first, then normalize names, punctuation, and variant suffixes within the same vendor. Ambiguous matches are rejected; normalized results are references only.',
        'checker.publicDescription': 'Compare against public catalogs without calling a checker or searching the web.',
        'checker.startPublic': 'Read public catalogs',
        'checker.catalogTargets': 'Catalog lookup: {count} models',
        'checker.catalogMatches': '{count} catalog matches',
        'checker.checkerTargets': '{count} models assigned to the checker',
        'checker.usedRoute': 'Checker {target}',
        'checker.catalogResults': 'Catalog facts for {count} models',
        'checker.aliasMatches': '{count} advisory alias matches',
        'override.useReference': 'Fill from reference',
        'override.useReferenceTitle': 'Preview the source and levels before filling the draft. This does not write to a provider.',
        'override.referencePreview': 'Reference level preview',
        'override.referenceSource': 'Source: {source}',
        'override.referenceAlias': '{source} (alias match)',
        'override.referenceLevels': 'Reference levels: {levels}',
        'override.referenceDraft': 'Draft levels: {levels}',
        'override.referenceLimit': 'Maximum 16 levels. Skipped: {levels}',
        'override.referenceFallbacks': 'Standard same-name values for blank mappings: {levels}',
        'override.referenceStandardScope': 'Fills the draft for this model only. Check what your upstream supports. To use the same-name values, opt in to provider write and standard reasoning_effort.',
        'override.referenceManualScope': 'Fills the draft for this model only. Same-name values are unavailable on this route. Consult its API documentation for request values.',
        'override.referenceOldHost': 'This Host cannot protect existing provider mappings. Reference drafts can only be saved in this plugin.',
        'override.referenceProviderScope': 'Writes to this model in the selected provider only. Check the upstream levels and values. The local draft can still be saved if some provider settings cannot be written.',
        'override.referenceSafeguards': 'What is kept and how to undo',
        'override.referencePreservation': 'Direct writes preserve existing mappings, explicit disables and provider defaults. Only compatible routes can fill standard same-name values. A catalog reference does not prove upstream support.',
        'override.referenceRevert': 'To undo a provider change, edit the model in Model providers. “Use automatic” clears this plugin’s settings only.',
        'override.cancelReference': 'Cancel fill',
        'override.confirmReference': 'Fill draft',
        'override.referenceApplied': 'This draft includes reference levels.',
        'override.referenceWireBlank': 'Keep existing value or use {value} if blank',
        'override.referenceDisabled': 'Kept reasoning disabled in the provider settings.',
        'override.referenceNonChat': 'This is not a chat route; reference reasoning was not written.',
        'override.referencePreservedEfforts': 'Kept existing provider mappings for: {levels}',
        'override.saveLocal': 'Save locally only',
        'override.saveProvider': 'Write to provider',
        'override.providerConfirmTitle': 'Confirm save and provider write',
        'override.providerTarget': 'Write target: {provider} / {model}',
        'override.providerContext': 'Context window (if writable): {value}',
        'override.providerInput': 'Input modalities (if compatible): {value}',
        'override.providerDisableReasoning': 'Requests disabling reasoning for this model.',
        'override.providerMappings': 'Manually entered mappings (fill blanks only): {values}',
        'override.providerOmit': 'omit upstream value',
        'override.providerLocalDefault': 'Default level (local only): {value}',
        'override.providerStandardEnable': 'Allows standard reasoning_effort for this model.',
        'override.backToDraft': 'Back to draft',
        'override.confirmProviderSave': 'Confirm save and write',
        'tag.aliasReference': "Alias reference",
        'tag.aliasReferenceTitle': "Matched a public catalog alias, not the exact ID. This does not establish support on the current route.",
        'checker.provider': 'Checker provider',
        'checker.model': 'Checker model',
        'checker.chooseProvider': 'Select provider',
        'checker.chooseModel': 'Select model',
        'checker.noRoute': 'No checker is available. Configure a model or use public catalogs only.',
        'checker.noLegacyRoute': 'No checker is available. Configure a model first.',
        'checker.chooseRoute': 'Select a checker provider and model to start.',
        'checker.targetScope': 'Page filters do not limit which models are checked.',
        'checker.advanced': 'Advanced options',
        'checker.writeBackEnabled': 'Provider write-back on',
        'checker.start': 'Start',
        'checker.startTitle': 'Run a background verification sweep in the Host',
        'checker.cancel': 'Cancel',
        'checker.cancelTitle': 'Abort the running sweep',
        'checker.writeBack': 'Fill missing provider settings',
        'checker.writeBackTitle':
          'On: fill missing inputs and context for verified custom routes only. Existing settings and reasoning mappings are unchanged. Off: only update this page and the snapshot.',
        'checker.webSearch': 'Allow search and web-page reads',
        'checker.webSearchTitle': 'On by default. Let the checker search and read web pages; this may consume web-service quota and model tokens. Unavailable web access is reported as an error. When off, verification uses public catalogs and the checker’s existing knowledge.',
        'checker.fullScan': 'Recheck existing models',
        'checker.fullScanTitle': 'Recheck existing records for this run only. Checker modes may use more quota.',
        'checker.searchBackend.dsh-free-search': '{count} DSH Free Search calls',
        'checker.searchBackend.host-web': '{count} Host web search calls',
        'checker.allSkipped': 'No new models to verify · {skippedKnown} known skipped',
        'checker.searchBreakdown': 'Search breakdown: {breakdown}',
        'checker.idle': 'Not run yet',
        'checker.starting': 'Submitting…',
        'checker.running': '{phase}',
        'checker.finished': 'Finished',
        'checker.progress': '{processed}/{total} processed',
        'checker.progressLabel': 'Verification progress',
        'checker.tokens': '{tokens} tokens',
        'checker.outcomes': '{valid} valid · {unknown} unknown · {failed} failed · {skippedKnown} known skipped',
        'checker.webCalls': '{searchCalls} searches · {fetchCalls} web-page reads',
        'checker.activeBatches': 'Active batches',
        'checker.activeMore': '{count} more active batches',
        'checker.stage.checker': 'Checking',
        'checker.stage.search': 'Searching',
        'checker.stage.fetch': 'Reading web pages',
        'checker.stage.writeBack': 'Writing settings',
        'checker.stage.flush': 'Saving snapshot',
        'checker.errorBadge': '{count} errors',
        'checker.errorTitle': 'Errors from this run',
        'checker.errorDetails': 'Full error details ({count})',
        'checker.concurrency': 'Threads',
        'checker.concurrencyTitle':
          'How many checker requests may be in flight at once. Lower it if the relay rate-limits you, raise it on a fast link (max 8).',
        'checker.concurrencyValue': '{count}',
        'checker.sourcesTitle': 'Public catalogs',
        'checker.sourceSummary': '{complete}/{total} read',
        'checker.source.ok': 'read',
        'checker.source.empty': 'no match',
        'checker.source.http': 'HTTP error',
        'checker.source.failed': 'request failed',
        'checker.source.bad-json': 'not JSON',
        'checker.source.too-large': 'response too large',
        'checker.source.pending': 'pending',
        'checker.sourceModels': '{count}',
        'checker.hostStale': 'Restart DSH to enable verification in the Host.',
        'checker.catalogNeeded': 'New verification runs require the enriched model catalog. Refresh it and try again.',
        'checker.writeBackScope': 'Only this run’s results can be written back. Recheck existing models to include earlier results.',
        'checker.writeBackSkipped': '{count} known models were skipped and not written back.',
        'checker.phase.listing': 'Reading model list',
        'checker.phase.public': 'Reading public catalogs',
        'checker.phase.checker': 'Checking models',
        'checker.phase.verifying': 'Verifying in batches',
        'checker.phase.cancelled': 'Stopping',
        'checker.cancelled': 'Cancelled',
        'checker.stopping': 'Stopping…',
        'checker.pendingWrite': 'A provider write is still pending ({target}). Stopping verification does not undo this write.',
        'checker.lateWriteApplied': 'The delayed provider write was applied ({target}).',
        'checker.lateWriteNotApplied': 'The delayed provider write was not confirmed ({target}).',
        'checker.runFailed': 'Verification failed',
        'checker.source.cancelled': 'cancelled',
        'checker.sourceAttempts': '{count} attempts',
        'source.snapshot': "learned snapshot",
        'page.applyInput': 'Supplement image input for eligible relay models',
        'page.applyInputShort':
          'Only applies to relay chat models with reliable vision evidence and no explicit input declaration. A label does not guarantee image admission.',
        'page.applyInputHint':
          'When on, the plugin can supply image input for eligible relay (pi-ai) chat models with reliable vision evidence and no explicit input declaration. Display labels do not guarantee request admission or upstream support. Turning this off stops supplementation; no provider settings are changed.',
        'page.kindLegend':
          'Kind colours: image blue · video green · embedding orange · audio purple · rerank red · moderation rose · translation grey. “Official correction” means vendor documentation overrides a wrong catalog row.',
        'page.searchPlaceholder': 'Search name or ID',
        'page.capability.multimodal': "Image input",
        'page.capability.multimodalTitle': "Filter for models with image-input metadata; this is not a test of the current route.",
        'page.capability.reasoning': 'Reasoning',
        'page.capability.reasoningTitle': 'Only models that publish reasoning support',
        'page.contextLabel': 'Context at least',
        'page.context.any': 'Any context',
        'page.context.128k': '128K+',
        'page.context.256k': '256K+',
        'page.context.512k': '512K+',
        'page.context.1m': '1M+',
        'page.filter.all': 'All',
        'page.filter.chat': 'Chat',
        'page.filter.image': 'Image',
        'page.filter.video': 'Video',
        'page.filter.other': 'Other',
        'page.visibility.label': "Chat picker visibility",
        'page.visibility.all': "Any visibility",
        'page.visibility.enabled': "Shown in picker",
        'page.visibility.disabled': "Hidden in picker",
        'group.showAll': "Show {count} in group",
        'group.enabledCount': "Shown in picker / total in this group",
        'group.hideAll': 'Hide {count} in group',
        'group.showFiltered': "Show {count} matches",
        'group.hideFiltered': 'Hide {count} matches',
        'group.collapseNamed': 'Collapse the {name} group',
        'group.expandNamed': 'Expand the {name} group',
        'group.probeOk': '{models} models · {caps} with caps',
        'group.probeNoCaps': '{models} models · no cap fields',
        'group.probePartial': 'pricing {models} models',
        'group.probeFailed': 'read failed',
        'group.probeSkipped': 'not probed',
        'tag.reasoning': 'Reasoning',
        'tag.noReasoning': 'No reasoning',
        'tag.reasoningUnknown': 'Reasoning unknown',
        'tag.effort': "Chat levels",
        'tag.effortReference': 'Reference levels',
        'tag.effortPublicReference': "Catalog levels",
        'tag.reasoningReference': "Reference: reasoning",
        'tag.noReasoningReference': 'Reference: no reasoning',
        'tag.effortReferenceTitle': "Source: {source}. Reference levels are not controls for this route and are not sent automatically.",
        'tag.effortWireOff': 'reasoning_effort disabled',
        'tag.effortWireOffTitle': 'This OpenAI Completions route explicitly disables reasoning_effort. Enable it in provider compatibility settings only if the upstream accepts this field. Other protocols may use different fields.',
        'tag.context': 'Context',
        'tag.unknown': 'unknown',
        'tag.multimodal': "Image input",
        'tag.textOnly': 'Text only',
        'tag.modalityUnknown': "Input unknown",
        'tag.kind.image': 'Image',
        'tag.kind.video': 'Video',
        'tag.kind.embedding': 'Embedding',
        'tag.kind.rerank': 'Rerank',
        'tag.kind.audio': 'Audio',
        'tag.kind.classifier': 'Moderation',
        'tag.kind.translation': 'Translation',
        'tag.kind.unknown': 'Model',
        'tag.kindTitle': 'Model kind: {kind}; kind source: {source}',
        'tag.kindImageTitle': 'Image generation model (outputs images); kind source: {source}',
        'tag.kindVideoTitle': 'Video generation model (outputs video); kind source: {source}',
        'tag.correction': 'Official correction',
        'tag.correctionTitle': '{note}\nSource: {source}',
        'tag.resolutionTitle': 'The model name advertises a {value} output tier',
        'tag.imageInput': "Image input",
        'tag.imageInputTitle': "Metadata indicates image input. Check the current provider endpoint for image edits or reference images.",
        'tag.reasoningTitle': 'Reasoning supported; levels: {levels} (source: {source})',
        'tag.reasoningCatalogTitle': "Source: {source}. This is advisory; the current route does not report selectable levels.",
        'tag.effortTitle': "Selectable in chat: {levels}; default: {fallback} (source: {source}). Acceptance still depends on the upstream endpoint.",
        'tag.effortTitleNoFallback': "Selectable in chat: {levels} (source: {source}). Acceptance still depends on the upstream endpoint.",
        'tag.contextTitle': 'Context window {tokens} tokens; source: {source}',
        'tag.modalityTitle': "Input modalities: {modalities}; source: {source}. This does not test the current route.",
        'tag.outputTitle': 'Output modalities: {modalities}; source: {source}',
        'tag.unknownTitle': "There is not enough metadata to tell. Unknown does not mean unsupported.",
        'tag.infoErrorTitle': 'Could not read model capabilities: {message}',
        'source.config': "provider settings",
        'source.adapter': "current adapter",
        'source.provider': 'relay model list',
        'source.catalog': 'built-in model catalog',
        'source.inferred': "name-based inference",
        'source.official': 'vendor documentation',
        'source.manual': 'manual override',
        'source.unknown': 'unknown',
        'effort.off': 'off',
        'effort.minimal': 'minimal',
        'effort.low': 'low',
        'effort.medium': 'medium',
        'effort.high': 'high',
        'effort.max': 'max',
        'effort.xhigh': 'xhigh',
        'tag.manual': 'Manual',
        'tag.manualTitle':
          "At least one field uses a manual override. Open Sources to inspect each field.",
        'row.edit': 'Edit',
        'row.editTitle':
          'Set this model’s kind, context window, input modalities and effort levels by hand',
        'override.title': 'Manual capabilities',
        'override.hint':
          'Anything filled in here overrides automatic detection; blank fields and “Automatic” keep the normal rules.',
        'override.kind': 'Model kind',
        'override.kindAuto': 'Automatic',
        'override.context': 'Context window',
        'override.contextPlaceholder': 'Blank = automatic',
        'override.contextInvalid': 'The context window must be a whole number greater than 0.',
        'override.input': 'Input modalities',
        'override.efforts': 'Effort levels',
        'override.defaultEffort': 'Default level',
        'override.defaultEffortAuto': 'Unspecified',
        'override.effortHint': 'Local levels are for reference. The adapter controls selectable levels; the local default does not change actual requests.',
        'override.save': 'Save',
        'override.saving': 'Saving…',
        'override.reset': 'Use automatic',
        'override.cancel': 'Cancel',
        'override.failed': 'Could not save: {message}',
        'override.unavailable':
          'The Host half does not support manual capabilities yet; restart DSH to enable it.',
        'override.provider': 'Also write to the model provider settings',
        'override.listNotReady': 'Waiting for the override list',
        'override.listFailed': 'Could not synchronize the override list: {message}',
        'override.retryList': 'Retry list',
        'override.conflict': 'This model’s override changed. Close and reopen the editor, then review the latest values before editing again.',
        'override.providerHint': 'Saved in this plugin by default. Opt in to write compatible inputs, context and known upstream mappings; other settings stay local.',
        'override.providerWritten': 'Confirmed in provider settings: {fields}',
        'override.providerSkipped': 'Saved in this plugin; the provider settings were not written ({reason}).',
        'override.resetTitle':
          'Removes this plugin’s override only; values already written to the provider settings are kept.',
        'override.field.input': 'input modalities',
        'override.field.contextWindow': 'context window',
        'override.field.reasoningEfforts': 'effort levels',
        'override.reason.nothing': 'nothing to write',
        'override.reason.unsupported': 'this Host cannot write provider settings',
        'override.reason.provider-missing': 'the provider is missing from the settings document',
        'override.reason.models-missing': 'the provider has no explicit model list',
        'override.reason.model-missing': 'the model is missing from the provider model list',
        'override.reason.describe-failed': 'the settings document could not be read',
        'override.reason.settings-failed': 'the settings service rejected the write',
        'override.reason.skipped': 'not requested',
        'override.reason.local-only': 'no fields could be safely written',
        'override.reason.revision-unavailable': 'no usable settings revision; the write was skipped',
        'override.reason.config-provenance-unavailable': 'settings ownership cannot be confirmed',
        'override.reason.expression-backed': 'the field is backed by a configuration expression',
        'override.reason.settings-unverified': 'the settings write could not be verified; the local override was retained',
        'override.reason.provider-unverified': 'the route’s provider settings owner could not be verified',
        'override.reason.native-catalog': 'this model comes from the built-in catalog; there is no model entry to write',
        'override.reason.protected': 'the provider already declares these fields; nothing was overwritten',
        'override.reason.write-pending': 'a previous write has not settled yet, so this one was skipped',
        'override.reason.target-changed': 'the confirmed route or settings changed; reopen and review the target',
        'override.reason.override-changed': 'the local model override changed before dispatch; no provider write was sent',
        'override.reason.overrides-unavailable': 'the local override could not be rechecked before dispatch; no provider write was sent',
        'override.field.kind': 'model kind',
        'override.field.defaultEffort': 'default level',
        'override.localOnly': 'Kept in this plugin only: {fields}',
        'override.unresolvedEfforts': 'No usable upstream values for: {levels}',
        'override.routeDefaultConflict': 'Reasoning was not written because it conflicts with the provider default level.',
        'override.inheritedLadderConflict': 'Reasoning was not written to protect inherited catalog mappings.',
        'override.wireTitle': 'Upstream request values',
        'override.wireHint': 'Usually unnecessary. Direct writes only fill gaps, even for manually entered values. To replace an existing mapping, edit it in Model providers.',
        'override.wireValue': 'Upstream value for {level}',
        'override.wireKeep': 'Blank = keep existing value',
        'override.standardWire': 'Send standard reasoning_effort for this model',
        'override.standardWireUnavailable': 'Same-name mappings require an explicit model entry using standard OpenAI Completions thinking. See the provider docs for other protocols.',
        'override.standardWireHint': 'Enable only if the upstream accepts reasoning_effort and all values this model sends, including retained Provider mappings. Unmapped non-off levels use the same identifiers. Applies only to this model.',
        'override.standardFormatConflict': 'This model does not use the standard OpenAI Completions thinking format; reasoning_effort was not enabled.',
        'override.field.supportsReasoningEffort': 'allow reasoning_effort',
        'override.wireOff': 'Off: use omission semantics (protocol-dependent)',
        'page.manualNote':
          'A “Manual” tag means you set that capability on this model; it outranks the adapter, the relay and the built-in catalog.',
        'correction.glm-5.3-text-only':
          'Official docs: GLM-5.3 accepts text only; GLM-5.3-Flash / FlashX is the native multimodal variant.',
        'modality.text': 'text',
        'modality.image': 'image',
        'modality.audio': 'audio',
        'modality.video': 'video',
        'modality.file': 'file',
        'provider.account': 'DeepSeek Account',
      },
    }

    exports.DICT = DICT
  })

  // -------------------------------------------------------- editor-receipt
  define("editor-receipt", function (require, module, exports) {
    const { effortLabel } = require("format")

    /** A 200 response to the local save is not evidence of a provider write. */
    function providerWriteNote(result, t, action = {}) {
      if (action.mode === 'reset') return t('override.resetDone')
      if (action.mode === 'local') return t('override.localDone')
      const strings = (value) => Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && v !== ''))] : []
      const labels = (fields) => fields.map((field) => {
        const key = 'override.field.' + field
        const label = t(key)
        return label === key ? field : label
      }).join(' / ')
      const writtenFields = result?.written === true ? strings(result.fields) : []
      const localFields = new Set(strings(result?.localOnly))
      for (const field of strings(action.fields)) if (!writtenFields.includes(field)) localFields.add(field)
      const messages = []
      const reason = typeof result?.reason === 'string' ? result.reason : ''
      const reused = strings(result?.reusedEfforts)
      const alreadyMapped = result?.written === false && reason === 'already-mapped'
      const someExisting = !writtenFields.includes('reasoningEfforts') && (alreadyMapped || reused.length > 0)
      if (someExisting) localFields.delete('reasoningEfforts')
      // This draft's local commit once succeeded, but another edit or an unreadable file prevented
      // dispatch. The currently stored values are not necessarily this draft's values.
      if (!writtenFields.length && ['override-changed', 'overrides-unavailable'].includes(reason)) return t('override.recheckLocal', { reason: t('override.reason.' + reason) })
      if (writtenFields.length) {
        // A verified map write may have represented *some*, not all, requested levels. An overlapping
        // field must never appear under either a blanket success or an "only local" heading.
        const partial = writtenFields.filter((field) => localFields.has(field))
        const fullyWritten = writtenFields.filter((field) => !localFields.has(field))
        if (fullyWritten.length) messages.push(t('override.providerWritten', { fields: labels(fullyWritten) }))
        if (partial.includes('reasoningEfforts')) messages.push(t('override.partialEfforts'))
        const others = partial.filter((field) => field !== 'reasoningEfforts')
        if (others.length) messages.push(t('override.partialFields', { fields: labels(others) }))
        for (const field of partial) localFields.delete(field)
      } else if (alreadyMapped) {
        messages.push(t('override.reason.already-mapped'))
      } else if (!result || result.written !== false || !reason || ['settings-unverified', 'write-pending'].includes(reason)) {
        // The server may have accepted the mutation: do not tell the user to retry it.
        messages.push(t('override.providerUnconfirmed'))
        if (reason === 'write-pending') messages.push(t('override.reason.write-pending'))
      } else {
        const key = 'override.reason.' + reason
        const label = t(key)
        messages.push(t('override.providerSkipped', { reason: label === key ? reason : label }))
      }
      if (localFields.size > 0) {
        // With an unverified write the local copy is retained, but we cannot claim the fields exist *only* locally.
        messages.push(t(!writtenFields.length && (!reason || reason === 'settings-unverified' || result?.written !== false)
          ? 'override.localRetained' : 'override.localOnly', { fields: labels([...localFields]) }))
      }
      if (reused.length) messages.push(t('override.reusedEfforts', { levels: reused.map((id) => effortLabel(id, t)).join(' / ') }))
      if (someExisting && !alreadyMapped && strings(result?.localOnly).includes('reasoningEfforts')) messages.push(t('override.ladderRetained'))
      const protectedFields = strings(result?.protectedFields)
      if (protectedFields.length) messages.push(t('override.protectedFields', { fields: labels(protectedFields) }))
      const unresolved = strings(result?.unresolvedEfforts)
      if (unresolved.length) messages.push(t('override.unresolvedEfforts', { levels: unresolved.map((id) => effortLabel(id, t)).join(' / ') }))
      const conflict = {
        'route-default': 'override.routeDefaultConflict', 'inherited-ladder': 'override.inheritedLadderConflict',
        'standard-format': 'override.standardFormatConflict', 'reference-disabled': 'override.referenceDisabled',
        'reference-nonchat': 'override.referenceNonChat', 'expression-backed': 'override.reason.expression-backed',
        'config-provenance-unavailable': 'override.reason.config-provenance-unavailable',
      }[result?.reasoningConflict]
      if (typeof conflict === 'string' && (writtenFields.length || reason !== result.reasoningConflict)) messages.push(t(conflict))
      const kept = strings(result?.protectedEfforts)
      if (kept.length) messages.push(t('override.referencePreservedEfforts', { levels: kept.map((id) => effortLabel(id, t)).join(' / ') }))
      return messages.join(' · ')
    }

    exports.providerWriteNote = providerWriteNote

  })

  // -------------------------------------------------------- format
  define("format", function (require, module, exports) {
    const { FIELD } = require("constants")
    const { hiddenIndex, routeKey } = require("visibility-codec")

    const keyOf = routeKey

    function hiddenSetOf(snapshot) {
      return hiddenIndex(snapshot?.value?.[FIELD])
    }

    function providerLabel(group, t) {
      return group.id === 'deepseek-account' ? t('provider.account') : group.name
    }

    const COLLAPSE_KEY = 'dsh-model-visibility:collapsed-groups:v1'

    /** Group ids whose model lists the page keeps collapsed. */
    function readCollapsedGroups() {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY)
        if (raw === null) return new Set()
        const parsed = JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
      } catch (_error) {
        return new Set()
      }
    }

    function persistCollapsedGroups(collapsed) {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(collapsed)))
      } catch (_error) {
        // Storage can be unavailable (private mode, quota); collapsing still
        // works for this page session.
      }
    }

    function countModels(groups) {
      let total = 0
      for (const group of groups || []) total += (group.models || []).length
      return total
    }

    /** Human context size: 1048576 → "1M", 128000 → "128K". */
    function formatContext(tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return null
      if (tokens >= 1_000_000) return Math.round(tokens / 100_000) / 10 + 'M'
      if (tokens >= 1_000) return Math.round(tokens / 100) / 10 + 'K'
      return String(tokens)
    }

    /** Effort display names in catalog order. */
    function effortNames(reasoning) {
      const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const names = []
      for (const effort of efforts) {
        if (effort === null || typeof effort !== 'object') continue
        const label = effort.name || effort.id
        if (typeof label === 'string' && label !== '') names.push(label)
      }
      return names
    }

    /** Display name of the default effort, or null when none is published. */
    function defaultEffortName(reasoning) {
      if (!reasoning || typeof reasoning.defaultEffort !== 'string') return null
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const found = efforts.find((effort) => effort !== null && effort.id === reasoning.defaultEffort)
      return found && typeof found.name === 'string' && found.name !== ''
        ? found.name
        : reasoning.defaultEffort
    }

    /** Localized name of one input modality. */
    function modalityLabel(id, t) {
      const key = 'modality.' + id
      const label = t(key)
      return label === key ? id : label
    }

    /** Localized provenance label ("adapter", "relay model list", …). */
    function sourceLabel(source, t) {
      const key = 'source.' + (source || 'unknown')
      const label = t(key)
      return label === key ? t('source.unknown') : label
    }

    /** Per-field provenance recorded by the Host. */
    function sourceOf(model, field) {
      const sources = model && model.sources
      return sources && typeof sources[field] === 'string' ? sources[field] : 'unknown'
    }

    /**
     * Sources whose values are completed or inferred rather than declared.
     *
     * `public` is a cited directory, `snapshot` an independently learned result.
     * Neither is this route's declaration. Keep both dashed: reference material
     * may be useful without proving the relay accepts the capability.
     */
    function isInferredSource(source) {
      return source === 'snapshot' || source === 'public' || source === 'inferred'
    }

    /** Kind with a safe fallback for records from an older Host. */
    function kindOf(model) {
      return model && typeof model.kind === 'string' && model.kind !== '' ? model.kind : 'chat'
    }

    /** Filter bucket: chat / image / video / other. */
    function bucketOf(kind) {
      if (kind === 'image') return 'image'
      if (kind === 'video') return 'video'
      if (kind === 'chat') return 'chat'
      return 'other'
    }

    function isGenerationKind(kind) {
      return kind === 'image' || kind === 'video' || kind === 'audio'
    }

    /** Resolution tier advertised in the model id ("-4k", "2K"). */
    function resolutionOf(model) {
      const text = String((model && model.id) || '')
      const match = /(?:^|[-_/])(4k|2k|8k|uhd|hd)(?:$|[-_/])/i.exec(text)
      return match === null ? null : match[1].toUpperCase()
    }

    /** "文本 / 图像" for one modality array. */
    function modalityNames(modalities, t) {
      return (Array.isArray(modalities) ? modalities : []).map((id) => modalityLabel(id, t)).join(' / ')
    }

    /** Input modalities the manual editor can declare, in display order. */
    const OVERRIDE_MODALITIES = ['text', 'image', 'audio', 'video', 'file']

    /** Effort levels the manual editor can declare, in display order. */
    const OVERRIDE_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    /** Localized name of one effort id. */
    function effortLabel(id, t) {
      const key = 'effort.' + id
      const label = t(key)
      return label === key ? id : label
    }

    /** Model fields whose provenance can be manual. */
    function manualFieldsOf(model) {
      const sources = model && model.sources ? model.sources : {}
      return ['kind', 'reasoning', 'context', 'modalities'].filter(
        (field) => sources[field] === 'manual',
      )
    }


    exports.keyOf = keyOf
    exports.hiddenSetOf = hiddenSetOf
    exports.providerLabel = providerLabel
    exports.COLLAPSE_KEY = COLLAPSE_KEY
    exports.readCollapsedGroups = readCollapsedGroups
    exports.persistCollapsedGroups = persistCollapsedGroups
    exports.countModels = countModels
    exports.formatContext = formatContext
    exports.effortNames = effortNames
    exports.defaultEffortName = defaultEffortName
    exports.modalityLabel = modalityLabel
    exports.sourceLabel = sourceLabel
    exports.sourceOf = sourceOf
    exports.isInferredSource = isInferredSource
    exports.kindOf = kindOf
    exports.bucketOf = bucketOf
    exports.isGenerationKind = isGenerationKind
    exports.resolutionOf = resolutionOf
    exports.modalityNames = modalityNames
    exports.OVERRIDE_MODALITIES = OVERRIDE_MODALITIES
    exports.OVERRIDE_EFFORTS = OVERRIDE_EFFORTS
    exports.effortLabel = effortLabel
    exports.manualFieldsOf = manualFieldsOf
  })

  // -------------------------------------------------------- hooks
  define("hooks", function (require, module, exports) {
    const React = require('react')

    const { hiddenSetOf } = require("format")

    function subscribeOf(source) {
      return (fn) => source.subscribe(fn)
    }

    function snapshotOf(source) {
      return () => source.getSnapshot()
    }

    function useSource(source) {
      const subscribe = React.useCallback(subscribeOf(source), [source])
      const getSnapshot = React.useCallback(snapshotOf(source), [source])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    function useHidden(form) {
      const snapshot = useSource(form)
      const hidden = React.useMemo(() => hiddenSetOf(snapshot), [snapshot])
      return { hidden, snapshot }
    }

    exports.subscribeOf = subscribeOf
    exports.snapshotOf = snapshotOf
    exports.useSource = useSource
    exports.useHidden = useHidden

  })

  // -------------------------------------------------------- override-editor
  define("override-editor", function (require, module, exports) {
    const React = require('react')
    const h = React.createElement

    const { modalityLabel, effortLabel, OVERRIDE_MODALITIES, OVERRIDE_EFFORTS } = require("format")
    const { clientTrace } = require("diagnostic-events")

    function toggleItem(set, item) {
      const next = new Set(set)
      if (next.has(item)) next.delete(item)
      else next.add(item)
      return next
    }

    function ModelOverrideEditor({
      id, entry, revision, hasOverride, blocked, stale, detached, missing, name, t, overrides, onClose, onSaved, onDirty,
      canDirect = false, canMap = false, canReferencePrefill = false, routeKind, referenceEfforts = [], referenceSource = '', referenceAlias = false,
    }) {
      const [kind, setKind] = React.useState(entry.kind ?? '')
      const [context, setContext] = React.useState(entry.contextWindow === undefined ? '' : String(entry.contextWindow))
      const [input, setInput] = React.useState(() => new Set(entry.input ?? []))
      const [efforts, setEfforts] = React.useState(() => new Set((entry.efforts ?? []).map((effort) => effort.id)))
      const [noReasoning, setNoReasoning] = React.useState(entry.reasoningSupported === false)
      const [defaultEffort, setDefaultEffort] = React.useState(entry.defaultEffort ?? '')
      const [wireValues, setWireValues] = React.useState({})
      const [omitOff, setOmitOff] = React.useState(false)
      const [referenceApplied, setReferenceApplied] = React.useState(entry.referencePrefill === true)
      const [touched, setTouched] = React.useState(false)
      const [preview, setPreview] = React.useState(false)
      const [advanced, setAdvanced] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const saving = React.useRef(false)
      const title = React.useRef(null)
      const contextInput = React.useRef(null)
      const referenceButton = React.useRef(null)
      const previewHeading = React.useRef(null)
      const restoreReference = React.useRef(false)
      const titleId = React.useId()
      const previewId = React.useId()
      const advancedId = React.useId()
      const hintId = React.useId()

      // Focus only when opening the draft, never when a filter/collapse moves its row.
      React.useEffect(() => { title.current?.focus() }, [])
      React.useEffect(() => {
        if (preview) previewHeading.current?.focus()
        else if (restoreReference.current) {
          restoreReference.current = false
          referenceButton.current?.focus()
        }
      }, [preview])

      const dirty = () => {
        if (!touched) { setTouched(true); onDirty?.() }
        setError(null)
      }
      const selected = [...efforts]
      const provided = Array.isArray(referenceEfforts) ? referenceEfforts : []
      const suggested = (kind || routeKind) === 'chat' && routeKind === 'chat' && !noReasoning
        ? [...new Set(provided.map((item) => item?.id).filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)))] : []
      const standalone = !selected.length && defaultEffort ? [defaultEffort] : []
      const merged = [...new Set([...selected, ...standalone, ...suggested])].slice(0, 16)
      const skipped = suggested.filter((id) => !merged.includes(id))
      const levels = (ids) => ids.map((id) => effortLabel(id, t)).join(' / ')
      const selectedDefault = !efforts.size || efforts.has(defaultEffort) ? defaultEffort : ''
      const hasFields = Boolean(kind || context.trim() || input.size || noReasoning || selected.length || selectedDefault)
      // With an entirely blank *untouched* draft, the adjacent, visible levels are the explicit
      // one-click reference action. Never refill a ladder the user removed, or add it to an unrelated edit.
      const directReference = !hasOverride && !touched && !hasFields && suggested.length > 0 && canReferencePrefill
      const directAllowed = canDirect && (!referenceApplied || canReferencePrefill)
      const locked = busy || blocked || stale || missing
      const editingLocked = locked || preview
      const target = { provider: entry.provider, model: entry.model }
      const source = referenceSource || t('source.unknown')
      const sourceText = referenceAlias ? t('override.referenceAlias', { source }) : source
      const directLevels = directReference ? merged : selected
      const togglePreview = (open) => {
        if (!open) restoreReference.current = true
        setPreview(open)
      }
      const fillReference = () => {
        if (locked || !preview || !suggested.some((id) => merged.includes(id))) return
        dirty()
        setEfforts(new Set(merged)); setReferenceApplied(true); togglePreview(false)
        clientTrace('editor', 'reference', { status: 'draft', count: merged.length })
      }
      const fail = (failure, mode) => {
        if (failure?.status === 409) {
          setError(t('override.conflict'))
          void overrides.load()
        } else {
          setError(t(mode === 'provider' ? 'override.writeFailed' : 'override.failed', { message: String(failure?.message ?? failure) }))
        }
        clientTrace('editor', 'save', { status: failure?.status === 409 ? 'conflict' : 'failed' })
      }
      const submit = (mode) => {
        if (editingLocked || saving.current || (mode === 'reset' && !hasOverride)) return
        const direct = mode === 'provider'
        if (direct && (!directAllowed || (!hasFields && !directReference))) return
        const value = context.trim() ? Number(context) : undefined
        if (mode !== 'reset' && value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
          setError(t('override.contextInvalid')); contextInput.current?.focus(); return
        }
        const payload = { ...target, applyToProvider: direct }
        const fields = []
        if (kind) { payload.kind = kind; fields.push('kind') }
        if (value !== undefined) { payload.contextWindow = value; fields.push('contextWindow') }
        if (input.size) { payload.input = [...input]; fields.push('input') }
        const ladder = direct ? directLevels : selected
        if (noReasoning) { payload.reasoningSupported = false; fields.push('reasoningEfforts') }
        else if (ladder.length) {
          payload.efforts = ladder.map((id) => ({ id })); fields.push('reasoningEfforts')
          if (direct && canMap) {
            const mappings = Object.fromEntries(ladder.filter((id) => OVERRIDE_EFFORTS.includes(id)).flatMap((id) => {
              if (id === 'off' && omitOff) return [[id, null]]
              const wire = wireValues[id]?.trim()
              return wire ? [[id, wire]] : []
            }))
            if (Object.keys(mappings).length) payload.reasoningEffortMappings = mappings
          }
        }
        if (!noReasoning && selectedDefault) { payload.defaultEffort = selectedDefault; fields.push('defaultEffort') }
        if (referenceApplied || (direct && directReference)) payload.referencePrefill = true
        if (direct) payload.directEffort = true
        saving.current = true; setBusy(true); setError(null)
        clientTrace('editor', 'submit', { status: mode, fields, count: ladder.length })
        const send = async () => {
          try {
            const result = mode === 'reset' ? await overrides.remove(entry.provider, entry.model, revision) : await overrides.save(payload, revision)
            clientTrace('editor', 'receipt', { status: !direct ? mode : result?.provider?.written === true ? 'written' : 'not-confirmed' })
            onSaved?.(result, { mode, fields })
          } catch (failure) { fail(failure, mode) }
          finally { saving.current = false; setBusy(false) }
        }
        void send()
      }

      const chip = (id, label, pressed, disabled, action) => h('button', {
        key: id, type: 'button', className: 'mvp_chip', 'aria-pressed': pressed, disabled, onClick: () => { dirty(); action() },
      }, label)
      const labelField = (label, control) => h('label', { className: 'mvp_field' }, h('span', { className: 'mvp_fieldLabel' }, label), control)
      const select = (label, value, options, setter) => h('select', {
        className: 'mvp_select', 'aria-label': t(label), value, disabled: editingLocked,
        onChange: (event) => { dirty(); setter(event.target.value) },
      }, options.map(([id, name]) => h('option', { key: id, value: id }, name)))
      const kinds = [['', t('override.kindAuto')], ...['chat', 'image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation']
        .map((id) => [id, id === 'chat' ? t('page.filter.chat') : t('tag.kind.' + id)])]
      const defaults = [['', t('override.defaultEffortAuto')], ...[...standalone, ...selected].map((id) => [id, effortLabel(id, t)])]
      const mappable = !noReasoning && directAllowed && canMap ? selected.filter((id) => OVERRIDE_EFFORTS.includes(id)) : []
      const hasMappings = mappable.some((id) => wireValues[id]?.trim() || (id === 'off' && omitOff))
      return h('section', { id, className: 'mvp_editor', 'aria-labelledby': titleId,
        onKeyDown: (event) => {
          if (event.key === 'Escape' && preview) { event.preventDefault(); event.stopPropagation(); togglePreview(false) }
        } },
        h('div', { className: 'mvp_editorHead' },
          h('h3', { className: 'mvp_editorTitle', id: titleId, ref: title, tabIndex: -1 }, t('override.title') + ' · ' + name),
          h('span', { className: 'mvp_rowMeta', title: entry.provider + ' / ' + entry.model }, entry.provider + ' / ' + entry.model),
        ),
        detached ? h('p', { className: 'mvp_editorNote' }, t('override.detached')) : null,
        missing ? h('p', { className: 'mvp_editorError', role: 'alert' }, t('override.missingRoute')) : null,
        h('div', { className: 'mvp_editorGrid' },
          h('fieldset', { className: 'mvp_field mvp_field--wide' },
            h('legend', { className: 'mvp_fieldLabel' }, t('override.efforts')),
            h('div', { className: 'mvp_chips' },
              [...new Set([...OVERRIDE_EFFORTS, ...selected])].map((id) => chip(id, effortLabel(id, t), !noReasoning && efforts.has(id),
                editingLocked || noReasoning || (!efforts.has(id) && efforts.size >= 16), () => setEfforts(toggleItem(efforts, id)))),
              chip('no-reasoning', t('tag.noReasoning'), noReasoning, editingLocked, () => setNoReasoning(!noReasoning)),
              suggested.length ? h('button', { ref: referenceButton, type: 'button', className: 'mvp_button mvp_button--quiet',
                disabled: editingLocked, 'aria-expanded': preview, 'aria-controls': previewId, title: t('override.useReferenceTitle'),
                onClick: () => togglePreview(true),
              }, t('override.useReference')) : null,
            ),
            h('div', { id: previewId, hidden: !preview }, preview ? h('div', { className: 'mvp_preview', role: 'group', 'aria-label': t('override.referencePreview') },
              h('div', { className: 'mvp_editorTitle', tabIndex: -1, ref: previewHeading }, t('override.referencePreview')),
              h('div', null, t('override.referenceSource', { source: sourceText })),
              h('div', null, t('override.referenceLevels', { levels: levels(suggested) })),
              h('div', null, t('override.referenceDraft', { levels: levels(merged) })),
              skipped.length ? h('div', null, t('override.referenceLimit', { levels: levels(skipped) })) : null,
              h('div', { className: 'mvp_editorActions' },
                h('button', { type: 'button', className: 'mvp_button', onClick: () => togglePreview(false) }, t('override.cancelReference')),
                h('button', { type: 'button', className: 'mvp_button mvp_button--accent',
                  disabled: locked || !suggested.some((id) => merged.includes(id)), onClick: fillReference }, t('override.confirmReference')),
              ),
            ) : null),
            referenceApplied && !preview ? h('span', { className: 'mvp_editorNote', role: 'status' }, t('override.referenceApplied')) : null,
          ),
          !noReasoning && (selected.length || defaultEffort) ? labelField(t('override.defaultEffort'), select('override.defaultEffort', selectedDefault, defaults, setDefaultEffort)) : null,
          labelField(t('override.kind'), select('override.kind', kind, kinds, setKind)),
          labelField(t('override.context'), h('input', { className: 'mvp_number', type: 'number', min: '1', step: '1', ref: contextInput,
            'aria-label': t('override.context'), value: context, disabled: editingLocked, placeholder: t('override.contextPlaceholder'),
            onInput: (event) => { dirty(); setContext(event.target.value) },
          })),
          h('fieldset', { className: 'mvp_field mvp_field--wide' }, h('legend', { className: 'mvp_fieldLabel' }, t('override.input')),
            h('div', { className: 'mvp_chips' }, OVERRIDE_MODALITIES.map((id) => chip(id, modalityLabel(id, t), input.has(id), editingLocked, () => setInput(toggleItem(input, id))))),
          ),
        ),
        h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', 'aria-expanded': advanced, 'aria-controls': advancedId,
          onClick: () => setAdvanced(!advanced),
        }, t('override.writeDetails') + (hasMappings ? ' · ' + t('override.hasMapping') : '')),
        h('div', { id: advancedId, hidden: !advanced }, advanced ? h('div', { className: 'mvp_editorNote mvp_preview' },
          h('p', null, t('override.hint')), h('p', null, t('override.effortHint')),
          h('p', null, t('override.referencePreservation')), h('p', null, t('override.referenceRevert')),
          mappable.length ? h('fieldset', { className: 'mvp_field' }, h('legend', { className: 'mvp_fieldLabel' }, t('override.wireTitle')),
            h('p', null, t('override.wireHint')), h('div', { className: 'mvp_chips' }, mappable.map((id) => {
              const label = t('override.wireValue', { level: effortLabel(id, t) })
              return h('label', { className: 'mvp_field', key: id }, label,
                h('input', { type: 'text', className: 'mvp_number', 'aria-label': label, value: wireValues[id] ?? '', maxLength: 128,
                  placeholder: t('override.wireKeep'), disabled: editingLocked || (id === 'off' && omitOff),
                  onChange: (event) => { const value = event.target.value; dirty(); setWireValues((previous) => ({ ...previous, [id]: value })) },
                }),
              )
            })),
            efforts.has('off') ? h('label', { className: 'mvp_check' },
              h('input', { type: 'checkbox', checked: omitOff, disabled: editingLocked,
                onChange: (event) => { dirty(); setOmitOff(event.target.checked) } }), t('override.wireOff'),
            ) : null,
          ) : null,
        ) : null),
        stale || error ? h('div', { className: 'mvp_editorError', role: 'alert' }, stale ? t('override.conflict') : error) : null,
        h('div', { className: 'mvp_editorFooter' },
          h('div', { id: hintId, className: 'mvp_editorNote' },
            !directAllowed ? t('override.directOldHost') : directReference
              ? t('override.directReference', { levels: levels(merged) }) : t('override.directScope'),
            hasMappings ? h('div', null, t('override.mappingScope')) : null,
          ),
          h('div', { className: 'mvp_editorActions' },
            hasOverride ? h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', title: t('override.resetTitle'),
              disabled: editingLocked, onClick: () => submit('reset') }, t('override.reset')) : null,
            h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: busy || preview, onClick: onClose }, t('override.cancel')),
            h('button', { type: 'button', className: 'mvp_button', disabled: editingLocked || (!hasFields && !hasOverride),
              onClick: () => submit('local') }, t('override.saveLocal')),
            h('button', { type: 'button', className: 'mvp_button mvp_button--accent', 'aria-describedby': hintId,
              disabled: editingLocked || !directAllowed || (!hasFields && !directReference), onClick: () => submit('provider') }, t('override.saveProvider')),
            busy ? h('span', { className: 'mvp_editorNote', role: 'status' }, t('override.saving')) : null,
          ),
        ),
      )
    }

    exports.ModelOverrideEditor = ModelOverrideEditor

  })

  // -------------------------------------------------------- pure
  define("pure", function (require, module, exports) {
    /**
     * Pure helpers that never touch React or the DOM, so `node --test` can call
     * them directly.
     *
     * @module client-src/pure
     */

    const { bucketOf, keyOf, kindOf } = require("format")

    /** Number of one bucket's token sum, guarding partial buckets. */
    function bucketTotalOf(buckets) {
      if (!Array.isArray(buckets)) return 0
      return buckets.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
    }

    /** 1234567 → "1.2M"; 4096 → "4.1K"; 0/undefined → "0". */
    function formatTokens(value) {
      const tokens = Number.isFinite(value) ? value : 0
      if (tokens >= 1_000_000) {
        const millions = Math.round((tokens / 100_000)) / 10
        return Number.isInteger(millions) ? `${millions}M` : millions.toFixed(1) + 'M'
      }
      if (tokens >= 1_000) {
        const thousands = Math.round(tokens / 100) / 10
        return Number.isInteger(thousands) ? `${thousands}K` : thousands.toFixed(1) + 'K'
      }
      return String(tokens)
    }

    /** Local-calendar `YYYY-MM-DD` stamp used by the ledger's day buckets. */
    function dayKeyOf(time) {
      const date = new Date(Number.isFinite(time) ? time : Date.now())
      if (Number.isNaN(date.getTime())) return ''
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    /** First day (Monday) of the local ISO week of `time`. */
    function weekKeyOf(time) {
      const date = new Date(Number.isFinite(time) ? time : Date.now())
      const weekday = (date.getDay() + 6) % 7
      date.setDate(date.getDate() - weekday)
      return dayKeyOf(date.getTime())
    }

    /** Local calendar month prefix of `time`. */
    function monthPrefixOf(time) {
      return dayKeyOf(time).slice(0, 7)
    }

    /**
     * Apply the section's filters to one catalog.
     *
     * Mirrors the settings page exactly; the composer filter is a separate,
     * simpler pass (visibility only). Output keeps the groups in order with only
     * models matching all active filters.
     */
    function computeFilteredGroups(groups, {
      filter = 'all', query = '', multimodalOnly = false, reasoningOnly = false, minContext = 0,
      visibility = 'all', hidden,
    } = {}) {
      const normalized = String(query ?? '').trim().toLowerCase()
      const filtered = []
      for (const group of groups ?? []) {
        const models = []
        for (const model of group.models ?? []) {
          if (visibility === 'enabled' || visibility === 'disabled') {
            const isHidden = hidden?.has(keyOf(group.id, model.id)) ?? false
            if (isHidden !== (visibility === 'disabled')) continue
          }
          if (filter !== 'all' && bucket(model) !== filter) continue
          if (normalized !== '') {
            const name = String(model.name ?? '').toLowerCase()
            const id = String(model.id ?? '').toLowerCase()
            if (!name.includes(normalized) && !id.includes(normalized)) continue
          }
          if (multimodalOnly && !(Array.isArray(model.inputModalities) && model.inputModalities.includes('image'))) {
            continue
          }
          if (reasoningOnly && model.reasoningSupported !== true && !(model.requestReasoning?.efforts?.length > 0)) continue
          if (minContext > 0 && !(Number.isFinite(model.contextWindow) && model.contextWindow >= minContext)) {
            continue
          }
          models.push(model)
        }
        if (models.length > 0) filtered.push({ ...group, models })
      }
      return filtered
    }

    function bucket(model) {
      // One implementation lives in `format.mjs` as `bucketOf`; duplicating the
      // four branches here meant the filter and the tag colours could drift apart.
      return bucketOf(kindOf(model))
    }

    /** Counts per kind bucket for the whole list. */
    function countKinds(models) {
      const counts = { chat: 0, image: 0, video: 0, other: 0 }
      for (const model of models ?? []) counts[bucket(model)] += 1
      return counts
    }

    /** Trust the enriched Host's task classification. Do not guess from names (a vision-chat model can contain “image”). */
    function checkerModelsOf(group) {
      return Array.isArray(group?.models) ? group.models.filter((model) =>
        typeof model?.id === 'string' && model.id.trim() !== '' && kindOf(model) === 'chat') : []
    }

    function checkerRoutesOf(groups) {
      return (Array.isArray(groups) ? groups : []).filter((group) =>
        typeof group?.id === 'string' && group.id.trim() !== '' && checkerModelsOf(group).length > 0)
        .map((group) => ({ id: group.id, name: group.name ?? group.id }))
    }

    /** Listing deduplicates exact IDs across providers and excludes the chosen checker ID on every route. */
    function checkerScopeOf(groups, excludedModel) {
      const routes = Array.isArray(groups) ? groups : []
      const ids = new Set()
      for (const route of routes) for (const model of Array.isArray(route?.models) ? route.models : []) {
        if (typeof model?.id === 'string' && model.id !== '' && model.id !== excludedModel) ids.add(model.id)
      }
      return { routes: routes.length, ids: ids.size }
    }

    /**
     * Compact label + tooltip for one provider probe diagnostic.
     * @returns `{ label, title, failed? }` or null; `failed` marks a route the page
     *   should warn about instead of quietly annotating.
     */
    function probeOf(state, group, t) {
      const list = Array.isArray(state.providers) ? state.providers : []
      const diagnostic = list.find((item) => item && item.id === group.id)
      if (diagnostic === undefined) return null
      const details = [
        diagnostic.host ? 'host: ' + diagnostic.host : null,
        diagnostic.status ? 'status: ' + diagnostic.status : null,
        diagnostic.models ? 'models: ' + diagnostic.models : null,
        diagnostic.capabilities ? 'capabilities: ' + diagnostic.capabilities : null,
        diagnostic.message ? 'message: ' + diagnostic.message : null,
        diagnostic.pricing && diagnostic.pricing !== 'skipped' ? 'pricing: ' + diagnostic.pricing : null,
      ]
        .filter(Boolean)
        .join('\n')
      if (diagnostic.status === 'ok') {
        return {
          label:
            Number(diagnostic.capabilities) > 0
              ? t('group.probeOk', {
                  models: diagnostic.models ?? 0,
                  caps: diagnostic.capabilities,
                })
              : t('group.probeNoCaps', { models: diagnostic.models ?? 0 }),
          title: details,
        }
      }
      // The listing failed but the pricing endpoint still enumerated the route.
      if (diagnostic.status === 'partial') {
        return {
          label: t('group.probePartial', { models: diagnostic.models ?? 0 }),
          title: details,
        }
      }
      if (diagnostic.status === 'failed' || diagnostic.status === 'unauthorized') {
        return {
          label: t('group.probeFailed'),
          title: details,
          failed: true,
        }
      }
      return { label: t('group.probeSkipped'), title: details }
    }


    exports.bucketTotalOf = bucketTotalOf
    exports.formatTokens = formatTokens
    exports.dayKeyOf = dayKeyOf
    exports.weekKeyOf = weekKeyOf
    exports.monthPrefixOf = monthPrefixOf
    exports.computeFilteredGroups = computeFilteredGroups
    exports.countKinds = countKinds
    exports.checkerModelsOf = checkerModelsOf
    exports.checkerRoutesOf = checkerRoutesOf
    exports.checkerScopeOf = checkerScopeOf
    exports.probeOf = probeOf
  })

  // -------------------------------------------------------- settings-confirm
  define("settings-confirm", function (require, module, exports) {
    const React = require('react')
    const h = React.createElement

    /** Native modal: focus is confined by the browser; Escape cancels without issuing a mutation. */
    function SettingsConfirm({ title, description, changed, confirmLabel, cancelLabel, onCancel, onConfirm, targets, targetLabel, disabled }) {
      const dialog = React.useRef(null)
      const cancel = React.useRef(null)
      const headingId = React.useId()
      const descId = React.useId()
      React.useEffect(() => {
        const node = dialog.current
        if (!node) return
        if (!node.open) node.showModal()
        cancel.current?.focus()
        return () => { if (node.open) node.close() }
      }, [])
      return h('dialog', { className: 'mvp_dialog', ref: dialog, 'aria-labelledby': headingId, 'aria-describedby': descId,
        onCancel: (event) => { event.preventDefault(); onCancel() },
      }, h('h3', { className: 'mvp_dialogTitle', id: headingId }, title),
      h('p', { id: descId }, description),
      targets?.length > 0 ? h('details', { className: 'mvp_details' }, h('summary', null, targetLabel),
        h('ul', { className: 'mvp_targetList' }, targets.map(({ provider, model }) => h('li', { key: JSON.stringify([provider, model]) }, provider + ' / ' + model))),
      ) : null,
      changed ? h('p', { className: 'mvp_editorError', role: 'alert' }, changed) : null,
      h('div', { className: 'mvp_editorActions' },
        h('button', { type: 'button', className: 'mvp_button', ref: cancel, onClick: onCancel }, cancelLabel),
        h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: disabled || Boolean(changed), onClick: onConfirm }, confirmLabel),
      ))
    }

    exports.SettingsConfirm = SettingsConfirm

  })

  // -------------------------------------------------------- settings-rows
  define("settings-rows", function (require, module, exports) {
    const React = require('react')
    const h = React.createElement

    const { kindOf, isGenerationKind } = require("format")
    const { capabilityTags, tagClassOf } = require("tags")

    // URLs are links only when the user opens evidence and follows them. Never render remote media or follow list values automatically.
    function evidenceUrls(fact) {
      const urls = new Set()
      for (const text of Array.isArray(fact?.urls) ? fact.urls.slice(0, 4) : []) {
        if (typeof text !== 'string' || text.length > 2048) continue
        try {
          const url = new URL(text)
          if (url.protocol === 'https:' && !url.username && !url.password) urls.add(url.href)
        } catch { /* a malformed citation remains unlinked */ }
      }
      return [...urls]
    }

    /** Keep field provenance keyboard/touch accessible without making every tag a tab stop. */
    function ModelRowsFacts({ model, t, onClose }) {
      const tags = capabilityTags(model, t)
      return h('div', { className: 'mvp_facts' },
        h('ul', null, tags.map((tag) => {
          const urls = evidenceUrls(model.fieldEvidence?.[tag.evidenceField])
          return h('li', { key: tag.key }, h('strong', null, tag.label), tag.title ? ' — ' + tag.title : '',
            urls.length ? h('div', { className: 'mvp_sourcesLinks' }, urls.map((url) => h('a', { key: url, href: url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, url))) : null)
        })),
        h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: onClose }, t('row.closeFacts')),
      )
    }

    /** Return host elements (not an intermediate component) so the page can interleave its single keyed editor with these rows. */
    function modelRow({ model, group, rowId, shown, isEditing, canOpenEditor, exposeEditor, disabled, editDisabled, edit, toggle, facts, showFacts, editorId, t }) {
      const tags = capabilityTags(model, t)
      const kind = kindOf(model)
      const tinted = ['image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation'].includes(kind)
      return h('div', { key: 'row:' + rowId, className: 'mvp_modelBlock' },
        h('div', { className: 'mvp_row' + (isGenerationKind(kind) ? ' mvp_row--gen' : '') + (shown ? '' : ' mvp_row--off') + (tinted ? ' mvp_row--kind-' + kind : '') },
          h('div', { className: 'mvp_rowText' },
            h('div', { className: 'mvp_rowHead' },
              h('span', { className: 'mvp_rowTitle' }, model.name || model.id), model.id !== model.name && model.name ? h('span', { className: 'mvp_rowMeta' }, model.id) : null,
              !shown ? h('span', { className: 'mvp_visibilityLabel' }, t('page.visibility.disabled')) : null,
            ),
            h('div', { className: 'mvp_tags' }, tags.map((tag) => h('span', { key: tag.key, className: tagClassOf(tag), title: tag.title || undefined }, tag.label)),
              h('button', { type: 'button', className: 'mvp_factsButton', 'aria-label': t('row.factsNamed', { name: model.name || model.id }), 'aria-expanded': facts,
                onClick: () => showFacts(!facts) }, t('row.facts')),
            ),
          ),
          h('div', { className: 'mvp_rowActions' },
            exposeEditor ? h('button', { type: 'button', className: 'mvp_button mvp_editButton', 'aria-expanded': isEditing,
              'aria-controls': isEditing ? editorId : undefined, 'aria-label': t('row.edit') + ': ' + (model.name || model.id),
              title: t(canOpenEditor || isEditing ? 'row.editTitle' : 'override.listNotReady'), disabled: editDisabled || (!canOpenEditor && !isEditing), onClick: edit,
            }, t('row.edit')) : null,
            h('button', { type: 'button', role: 'switch', className: 'mvp_switch', 'aria-checked': shown, disabled,
              'aria-label': t('row.visibilityNamed', { provider: group.name || group.id, name: model.name || model.id }), onClick: toggle }, h('span', { className: 'mvp_thumb' })),
          ),
        ),
        facts ? h(ModelRowsFacts, { model, t, onClose: () => showFacts(false) }) : null,
      )
    }

    exports.modelRow = modelRow

  })

  // -------------------------------------------------------- settings-section
  define("settings-section", function (require, module, exports) {
    const React = require('react')
    const h = React.createElement

    const { keyOf, kindOf, providerLabel, countModels, sourceOf, sourceLabel, readCollapsedGroups, persistCollapsedGroups } = require("format")
    const { canWriteHidden, writeHiddenRoutes } = require("visibility-identity")
    const { overrideIdentity } = require("catalog-store")
    const { computeFilteredGroups, countKinds } = require("pure")
    const { ModelOverrideEditor } = require("override-editor")
    const { providerWriteNote } = require("editor-receipt")
    const { modelRow } = require("settings-rows")
    const { SettingsConfirm } = require("settings-confirm")
    const { useHidden, useSource } = require("hooks")
    const { UsageToolbar } = require("usage-view")
    const { VerifyPanel } = require("checker-view")
    const { DebugPanel, AboutPanel } = require("support-panels")
    const { clientTrace } = require("diagnostic-events")

    function affectedRoutes(groups, hidden, visible) {
      return groups.flatMap((group) => (group.models ?? []).filter((model) => hidden.has(keyOf(group.id, model.id)) === visible)
        .map((model) => ({ provider: group.id, model: model.id })))
    }

    function focusOrFallback(target, fallback) {
      if (target && target.isConnected !== false && !target.disabled) target.focus?.()
      else fallback?.focus?.()
    }

    function makeSection(form, catalog, overrides, usage, verify) {
      return function ModelVisibilitySection({ t }) {
        const { hidden, snapshot } = useHidden(form)
        const state = useSource(catalog)
        const overrideState = useSource(overrides)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [refreshing, setRefreshing] = React.useState(false)
        const [reloading, setReloading] = React.useState(false)
        const [collapsed, setCollapsed] = React.useState(readCollapsedGroups)
        const [matchFold, setMatchFold] = React.useState(null)
        const [editing, setEditing] = React.useState(null)
        const [receipt, setReceipt] = React.useState(null)
        const [confirm, setConfirm] = React.useState(null)
        const [facts, setFacts] = React.useState(null)
        const [filter, setFilter] = React.useState('all')
        const [visibility, setVisibility] = React.useState('all')
        const [query, setQuery] = React.useState('')
        const [multimodalOnly, setMultimodalOnly] = React.useState(false)
        const [reasoningOnly, setReasoningOnly] = React.useState(false)
        const [minContext, setMinContext] = React.useState(0)
        const editTrigger = React.useRef(null)
        const pendingFocus = React.useRef(null)
        const searchInput = React.useRef(null)
        const writeLock = React.useRef(false)
        const editorId = React.useId()
        const applyHintId = React.useId()
        const groupId = React.useId()

        React.useEffect(() => {
          if (!confirm && pendingFocus.current) {
            const target = pendingFocus.current; pendingFocus.current = null
            focusOrFallback(target, searchInput.current)
          }
        }, [confirm, editing?.id])

        const groups = state.groups
        const meta = state.learned
        const featuresKnown = state.source === 'host' && Array.isArray(meta?.features)
        const features = featuresKnown ? meta.features : []
        const supportsOverrides = features.includes('overrides')
        const overridesReady = overrideState.status === 'ready' && overrideState.available === true
        const canOpenEditor = state.status === 'ready' && supportsOverrides && overridesReady && !overrideState.pending && !overrideState.refreshing
        const canSetSourceMode = features.includes('verifySourceModes')
        const supportsVerify = canSetSourceMode || features.includes('verifyWeb')
        const verifyState = verify.getSnapshot()
        const observeVerify = !featuresKnown || features.includes('verify') || supportsVerify || verifyState.snapshot?.state?.running === true || verifyState.pending
        const entryById = React.useMemo(() => new Map(overrideState.entries.map((entry) => [overrideIdentity(entry.provider, entry.model), entry])), [overrideState.entries])
        const catalogById = React.useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
        const total = countModels(groups)
        const allKinds = React.useMemo(() => countKinds(groups.flatMap((group) => group.models ?? [])), [groups])
        const hiddenCount = React.useMemo(() => affectedRoutes(groups, hidden, true).length, [groups, hidden])
        const normalized = query.trim().toLowerCase()
        const activeFilters = Boolean(filter !== 'all' || visibility !== 'all' || normalized || multimodalOnly || reasoningOnly || minContext)
        const filterKey = JSON.stringify([filter, visibility, normalized, multimodalOnly, reasoningOnly, minContext])
        const filtered = React.useMemo(() => computeFilteredGroups(groups, { filter, visibility, query: normalized, multimodalOnly, reasoningOnly, minContext, hidden }),
          [groups, filter, visibility, normalized, multimodalOnly, reasoningOnly, minContext, hidden])
        const matchCount = countModels(filtered)
        const hiddenMatches = React.useMemo(() => affectedRoutes(filtered, hidden, true), [filtered, hidden])
        // Search results start expanded independently of the user's persisted group layout. Manual folding
        // inside this one filter still works; clearing/changing it never rewrites unfiltered preferences.
        const effectiveFold = activeFilters ? matchFold?.key === filterKey ? matchFold.groups : new Set() : collapsed
        const anyCollapsed = filtered.some((group) => effectiveFold.has(group.id))
        const setFolds = (next) => {
          if (activeFilters) setMatchFold({ key: filterKey, groups: next })
          else { setCollapsed(next); persistCollapsedGroups(next) }
        }
        const resetFilters = () => { setQuery(''); setFilter('all'); setVisibility('all'); setMultimodalOnly(false); setReasoningOnly(false); setMinContext(0); setMatchFold(null) }
        const foldOne = (id) => {
          const next = new Set(effectiveFold)
          if (next.has(id)) next.delete(id); else next.add(id)
          setFolds(next)
        }
        const foldAll = () => {
          const next = new Set(effectiveFold)
          for (const group of filtered) { if (anyCollapsed) next.delete(group.id); else next.add(group.id) }
          setFolds(next)
        }
        const hiddenWritable = canWriteHidden(form, snapshot)
        const disabled = busy || !hiddenWritable || state.status !== 'ready'
        const applyInput = snapshot.value?.applyInput !== false
        const applyDisabled = busy || snapshot.writable !== true || !features.includes('applyInput') || snapshot.status !== 'ready'
        const runWrite = (work, failText) => {
          if (writeLock.current) return
          writeLock.current = true; setBusy(true); setError(null)
          const send = async () => {
            try { if (await work() !== true) setError(t(failText)) }
            catch { setError(t(failText)) }
            finally { writeLock.current = false; setBusy(false) }
          }
          void send()
        }
        const changeVisibility = (routes, visible) => {
          if (disabled || !routes.length) return
          runWrite(() => writeHiddenRoutes(form, routes, visible), 'page.visibilityFailed')
        }
        const startConfirm = (spec, event) => { setConfirm({ ...spec, epoch: state.epoch, trigger: event?.currentTarget ?? null }) }
        const cancelConfirm = () => { pendingFocus.current = confirm?.trigger || searchInput.current; setConfirm(null) }
        const openEditor = (group, model, trigger) => {
          if (!canOpenEditor) return
          const id = overrideIdentity(group.id, model.id)
          editTrigger.current = trigger; pendingFocus.current = null
          setEditing({ id, epoch: overrideState.epoch, revision: overrideState.revisions.get(id) ?? null, entry: entryById.get(id) ?? { provider: group.id, model: model.id }, model, dirty: false })
          clientTrace('editor', 'open', { provider: group.id, model: model.id })
        }
        const closeEditor = () => { pendingFocus.current = editTrigger.current || searchInput.current; setEditing(null); editTrigger.current = null }
        const askEditor = (group, model, event) => {
          if (!canOpenEditor || overrideState.pending) return
          const id = overrideIdentity(group.id, model.id)
          const target = event?.currentTarget ?? null
          if (editing?.dirty) { startConfirm({ kind: 'discard', next: editing.id === id ? null : { group, model } }, event); return }
          if (editing?.id === id) closeEditor(); else openEditor(group, model, target)
        }
        const runCatalogAction = (hard) => {
          if (busy || reloading || (!hard && refreshing)) return
          const set = hard ? setReloading : setRefreshing
          if (hard) setRefreshing(false)
          set(true)
          Promise.resolve().then(() => { if (hard) { void overrides.load(); return catalog.reload() }; return catalog.refresh() })
            .catch(() => {}).finally(() => set(false))
        }
        const activeGroup = editing ? catalogById.get(editing.entry.provider) : null
        const currentModel = activeGroup?.models?.find((model) => model.id === editing.entry.model)
        const editorModel = currentModel || editing?.model
        const editedShown = Boolean(editing && !effectiveFold.has(editing.entry.provider) && filtered.some((group) => group.id === editing.entry.provider && group.models.some((model) => model.id === editing.entry.model)))
        const currentRevision = editing ? overrideState.revisions?.get(editing.id) ?? null : null
        const reference = editorModel?.referenceReasoning
        const evidence = editorModel?.fieldEvidence
        const proof = reference ? evidence?.referenceReasoning : evidence?.reasoningEfforts ?? evidence?.reasoning
        const referenceSource = proof?.catalog || (reference ? editorModel.referenceReasoningSource : editorModel?.reasoningCatalog) || proof?.source || sourceOf(editorModel, 'reasoning')
        const referenceLabel = ['unknown', 'config', 'provider', 'adapter', 'manual', 'inferred', 'official', 'public', 'snapshot', 'catalog'].includes(referenceSource)
          ? sourceLabel(referenceSource, t) : referenceSource
        const editor = editing ? h(ModelOverrideEditor, {
          // Never nest this element inside a group or a row: React tracks this key among the SAME siblings,
          // even when the row is filtered out, folded, removed or re-ordered by a background catalog read.
          key: 'draft:' + editing.id, id: editorId, entry: editing.entry, revision: editing.revision, hasOverride: editing.revision !== null,
          stale: editing.epoch !== overrideState.epoch || (overridesReady && currentRevision !== editing.revision), blocked: !canOpenEditor,
          detached: !editedShown, missing: state.status === 'ready' && !currentModel, name: editorModel.name || editorModel.id,
          routeKind: kindOf(editorModel), t, overrides, canMap: features.includes('reasoningMappings'),
          canDirect: features.includes('effortDirect'), canReferencePrefill: features.includes('referencePrefill'),
          referenceEfforts: kindOf(editorModel) === 'chat' ? (reference || editorModel.reasoning)?.efforts : [],
          referenceSource: referenceLabel, referenceAlias: proof?.alias === true || (Boolean(reference) && editorModel.referenceReasoningAlias === true),
          onDirty: () => setEditing((previous) => previous?.id === editing.id && !previous.dirty ? { ...previous, dirty: true } : previous),
          onClose: closeEditor,
          onSaved: (result, action) => {
            closeEditor()
            setReceipt({ route: editing.id, epoch: state.epoch, name: editing.entry.provider + ' / ' + editing.entry.model, message: providerWriteNote(result?.provider, t, action) })
            void catalog.afterChange({ fresh: false })
          },
        }) : null
        const note = receipt && receipt.epoch === state.epoch ? h('div', { key: 'write-receipt', className: 'mvp_receipt', role: 'status' }, h('strong', null, receipt.name), ' · ', receipt.message,
          h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: () => setReceipt(null) }, t('page.dismissReceipt'))) : null
        let placedReceipt = false
        const rows = []
        if (editor && !editedShown) rows.push(editor)
        for (const [index, group] of filtered.entries()) {
          const models = group.models
          const allCount = catalogById.get(group.id)?.models?.length ?? models.length
          const name = providerLabel(group, t) || group.id
          const folded = effectiveFold.has(group.id)
          const countId = groupId + '-' + index
          const off = affectedRoutes([group], hidden, true)
          const visible = off.length > 0
          const routes = visible ? off : affectedRoutes([group], hidden, false)
          const actionKey = visible ? activeFilters ? 'group.showFiltered' : 'group.showAll' : activeFilters ? 'group.hideFiltered' : 'group.hideAll'
          rows.push(h('div', { key: 'head:' + group.id, className: 'mvp_groupHead' },
            h('button', { type: 'button', className: 'mvp_groupTitle', 'aria-expanded': !folded, 'aria-describedby': countId,
              'aria-label': t(folded ? 'group.expandNamed' : 'group.collapseNamed', { name }), onClick: () => foldOne(group.id) },
              h('span', { className: 'mvp_chevron', 'aria-hidden': true }, folded ? '▸' : '▾'),
              h('span', { className: 'mvp_groupName' }, name),
              h('span', { className: 'mvp_groupCount', id: countId }, activeFilters
                ? t('group.matchCount', { matches: models.length, total: allCount, enabled: models.length - off.length })
                : t('group.count', { enabled: allCount - off.length, total: allCount })),
            ),
            h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: disabled || !routes.length,
              onClick: (event) => startConfirm({ kind: 'visibility', routes, visible, group: group.id, scope: name }, event) }, t(actionKey, { count: routes.length })),
          ))
          if (!folded) for (const model of models) {
            const id = overrideIdentity(group.id, model.id)
            const shown = !hidden.has(keyOf(group.id, model.id))
            rows.push(modelRow({ group, model, rowId: id, editorId, t, shown, disabled,
              exposeEditor: supportsOverrides && overrideState.available !== false, canOpenEditor, editDisabled: busy || overrideState.pending,
              isEditing: editing?.id === id, edit: (event) => askEditor(group, model, event),
              toggle: () => changeVisibility([{ provider: group.id, model: model.id }], !shown), facts: facts === id, showFacts: (open) => setFacts(open ? id : null),
            }))
            if (editor && editing.id === id) rows.push(editor)
            if (note && receipt.route === id) { rows.push(note); placedReceipt = true }
          }
        }
        if (note && !placedReceipt) rows.unshift(note)
        const loading = state.status === 'loading' || state.status === 'idle'
        const options = [['all', total], ['chat', allKinds.chat], ['image', allKinds.image], ['video', allKinds.video], ['other', allKinds.other]]
        const failed = (state.providers ?? []).filter((provider) => provider && (provider.status === 'failed' || provider.status === 'unauthorized'))
        const applyCap = featuresKnown && features.includes('applyInput')
        const filterButton = (key, label, pressed, action, tooltip) => h('button', { key, type: 'button', className: 'mvp_filter', 'aria-pressed': pressed, title: tooltip,
          onClick: () => { action(); clientTrace('filters', 'change', { status: key }) } }, label)
        const actionButton = (label, title, action, off, accent = false) => h('button', { type: 'button', className: 'mvp_button' + (accent ? ' mvp_button--accent' : ''),
          disabled: off, title: t(title), onClick: action }, t(label))
        const banner = (text, warn = false) => h('div', { className: 'mvp_banner' + (warn ? ' mvp_banner--warn' : ''), role: warn ? 'alert' : 'status' }, text)
        let confirmation = null
        if (confirm?.kind === 'visibility') {
          const current = affectedRoutes(confirm.group === undefined ? filtered : filtered.filter((group) => group.id === confirm.group), hidden, confirm.visible)
          const currentIds = new Set(current.map((r) => overrideIdentity(r.provider, r.model)))
          const changed = confirm.epoch !== state.epoch || currentIds.size !== confirm.routes.length || confirm.routes.some((r) => !currentIds.has(overrideIdentity(r.provider, r.model)))
          const count = confirm.routes.length
          confirmation = h(SettingsConfirm, { title: t(confirm.visible ? 'page.confirmEnable' : 'page.confirmDisable', { count }),
            description: t('page.confirmScope', { scope: confirm.scope, count }), targets: confirm.routes, targetLabel: t('page.confirmTargets', { count }),
            confirmLabel: t(confirm.visible ? 'page.doEnable' : 'page.doDisable', { count }), cancelLabel: t('page.cancel'),
            disabled, changed: changed ? t('page.confirmChanged') : null,
            onCancel: cancelConfirm, onConfirm: () => { if (disabled || changed) return; changeVisibility(confirm.routes, confirm.visible); cancelConfirm() },
          })
        } else if (confirm?.kind === 'discard') {
          confirmation = h(SettingsConfirm, { title: t('override.discardTitle'), description: t('override.discardDescription', { name: editing?.entry.model ?? '' }),
            confirmLabel: t('override.discard'), cancelLabel: t('override.keepEditing'), disabled: overrideState.pending,
            onCancel: cancelConfirm, onConfirm: () => { if (overrideState.pending) return; setConfirm(null); if (confirm.next) openEditor(confirm.next.group, confirm.next.model, confirm.trigger); else closeEditor() },
          })
        }
        return h('div', { className: 'mvp_page' },
          h('div', { className: 'mvp_head' }, h('div', { className: 'mvp_headMain' }, h('h2', { className: 'mvp_title' }, t('page.title')),
            h('span', { className: 'mvp_summary' }, total ? t('page.summary', { visible: total - hiddenCount, total }) : t(loading ? 'page.loading' : 'page.empty'))),
            h('div', { className: 'mvp_headActions' },
              actionButton(refreshing ? 'page.refreshing' : 'page.refresh', 'page.refreshTitle', () => runCatalogAction(false), busy || refreshing || reloading),
              actionButton(reloading ? 'page.reloading' : 'page.reload', features.includes('reload') ? 'page.reloadTitle' : 'page.reloadUnavailable', () => runCatalogAction(true), busy || reloading || !features.includes('reload')),
            ),
          ),
          h(DebugPanel, { key: 'debug:' + state.epoch, t, features }),
          featuresKnown && !features.includes('usage') ? h('div', { className: 'mvp_usage mvp_usage--off' }, t('usage.hostStale'), h('div', { className: 'mvp_usageStatus' })) : h(UsageToolbar, { usage, t, features }),
          h('div', { className: 'mvp_filters' },
            h('input', { className: 'mvp_searchInput', type: 'search', value: query, ref: searchInput, placeholder: t('page.searchPlaceholder'), 'aria-label': t('page.searchPlaceholder'),
              onInput: (event) => setQuery(event.target.value) }),
            h('div', { className: 'mvp_filterGroup', role: 'group', 'aria-label': t('override.kind') }, options.map(([key, count]) => filterButton(key, t('page.filter.' + key) + ' ' + count, filter === key, () => setFilter(key)))),
            h('select', { className: 'mvp_contextSelect', value: visibility, 'aria-label': t('page.visibility.label'), onChange: (event) => setVisibility(event.target.value) },
              ['all', 'enabled', 'disabled'].map((key) => h('option', { key, value: key }, t('page.visibility.' + key)))),
            h('div', { className: 'mvp_filterGroup' },
              filterButton('multimodal', t('page.capability.multimodal'), multimodalOnly, () => setMultimodalOnly(!multimodalOnly), t('page.capability.multimodalTitle')),
              filterButton('reasoning', t('page.capability.reasoning'), reasoningOnly, () => setReasoningOnly(!reasoningOnly), t('page.capability.reasoningTitle')),
              h('select', { className: 'mvp_contextSelect', value: String(minContext), 'aria-label': t('page.contextLabel'), onChange: (event) => setMinContext(Number(event.target.value)) },
                [[0, 'any'], [128000, '128k'], [256000, '256k'], [512000, '512k'], [1000000, '1m']].map(([value, key]) => h('option', { key, value: String(value) }, t('page.context.' + key)))),
            ),
          ),
          h('div', { className: 'mvp_listTools' },
            activeFilters ? h('span', { className: 'mvp_summary', role: 'status' }, t('page.matchCount', { count: matchCount })) : null,
            activeFilters ? h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: resetFilters }, t('page.clearFilters')) : null,
            h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: disabled || !hiddenMatches.length,
              onClick: (event) => startConfirm({ kind: 'visibility', visible: true, routes: hiddenMatches, scope: t(activeFilters ? 'page.scopeFiltered' : 'page.scopeCatalog') }, event) },
              t(activeFilters ? 'page.showMatches' : 'page.showAll', { count: hiddenMatches.length })),
            h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: !filtered.length, onClick: foldAll },
              t(activeFilters ? anyCollapsed ? 'page.expandMatches' : 'page.collapseMatches' : anyCollapsed ? 'page.expandGroups' : 'page.collapseGroups')),
            h('details', { className: 'mvp_details' }, h('summary', null, t('page.listHelp')), h('p', null, t('page.listHint')), h('p', null, t('page.filterHint'))),
          ),
          applyCap ? h('div', { className: 'mvp_applyRow' },
            h('button', { type: 'button', role: 'switch', className: 'mvp_switch', 'aria-checked': applyInput, 'aria-label': t('page.applyInput'), 'aria-describedby': applyHintId,
              disabled: applyDisabled, onClick: () => { if (!applyDisabled) runWrite(() => form.set('applyInput', !applyInput), 'page.saveFailed') } }, h('span', { className: 'mvp_thumb' })),
            h('span', { className: 'mvp_applyTitle' }, t('page.applyInput')),
            h('details', { className: 'mvp_details' }, h('summary', null, t('page.applyHelp')), h('p', { id: applyHintId }, t('page.applyInputHint'))),
          ) : null,
          !hiddenWritable && snapshot.status !== 'loading' && snapshot.status !== 'idle' ? banner(t('page.visibilityReadOnly')) : null,
          failed.length ? banner(t('page.probeFailures', { names: failed.map((entry) => entry.name || entry.id).join(' · ') }), true) : null,
          featuresKnown && !applyCap ? banner(t('page.hostStale')) : null,
          state.source === 'catalog' && state.detailsError ? banner(t('page.metaFallback')) : null,
          state.failures.length ? banner(t('page.providerFailures', { names: state.failures.map((entry) => entry.name || entry.id).join(' · ') }), true) : null,
          supportsOverrides && overrideState.available === false ? banner(t('override.unavailable')) : null,
          supportsOverrides && overrideState.status === 'error' ? banner(h(React.Fragment, null, t('override.listFailed', { message: overrideState.error }), ' ',
            h('button', { type: 'button', className: 'mvp_button', onClick: () => { void overrides.load() } }, t('override.retryList'))), true) : null,
          error ? banner(error, true) : null,
          state.error ? banner(t('page.error', { message: state.error }), true) : null,
          h('div', { className: 'mvp_groups' }, rows),
          !matchCount && !loading && !state.error ? h('p', { className: 'mvp_note' }, t(total && activeFilters ? 'page.filterEmpty' : 'page.empty')) : null,
          confirmation,
          observeVerify ? h(VerifyPanel, { verify, catalog: state, t, canUse: featuresKnown && state.status === 'ready' && supportsVerify, onFinished: catalog.afterChange,
            canFullScan: supportsVerify && features.includes('verifyFullScan'), canSetMode: features.includes('verifyModes'), canSetSourceMode }) : banner(t('checker.hostStale')),
          h(AboutPanel, { key: 'about:' + state.epoch, t, features }),
        )
      }
    }

    exports.makeSection = makeSection

  })

  // -------------------------------------------------------- support-dict
  define("support-dict", function (require, module, exports) {
    const SUPPORT_DICT = {
      zh: {
        'support.debug': '调试记录', 'support.traceOn': '记录中', 'support.traceOff': '未开启',
        'support.debugHint': '仅记录本机步骤、字段名和处理结果；不记录原文、上游请求值或密钥。关闭后停止采集，已有记录保留。',
        'support.debugSwitch': '开启本机调试记录', 'support.view': '查看记录', 'support.hide': '收起记录',
        'support.copy': '复制脱敏记录', 'support.copied': '已复制', 'support.clear': '清空本轮记录', 'support.refresh': '刷新',
        'support.empty': '本轮还没有记录。开启后重做一次要排查的操作。', 'support.file': '本轮本机日志：{path}',
        'support.diskError': '本机日志未能写入，仍可复制内存中的记录。', 'support.dropped': '有 {count} 条较早或超限记录未显示。',
        'support.error': '操作未完成，请重试。', 'support.about': '关于插件 · 版本与反馈', 'support.current': '当前版本', 'support.latest': 'npm 最新版',
        'support.unchecked': '尚未检查', 'support.check': '检查更新', 'support.checking': '正在检查…', 'support.unavailable': '暂时无法查询',
        'support.checkFailed': '本次检查失败，无法确认最新版', 'support.cached': '上次查询', 'support.ahead': '本地版本较新', 'support.update': '有新版本', 'support.same': '已是最新版',
        'support.star': '去 GitHub 点个 Star，让作者开心一天 ↗', 'support.bug': '去 GitHub 提交 Bug ↗', 'support.old': '重新加载新版宿主后可用。',
      },
      en: {
        'support.debug': 'Debug trace', 'support.traceOn': 'Recording', 'support.traceOff': 'Off',
        'support.debugHint': 'Records local steps, field names, and outcomes only. No raw content, upstream parameter values, or secrets. Turning it off stops collection and retains existing records.',
        'support.debugSwitch': 'Record a local debug trace', 'support.view': 'View events', 'support.hide': 'Hide events',
        'support.copy': 'Copy redacted trace', 'support.copied': 'Copied', 'support.clear': 'Clear this trace', 'support.refresh': 'Refresh',
        'support.empty': 'No events yet. Turn on recording and repeat the operation.', 'support.file': 'Local log for this run: {path}',
        'support.diskError': 'Could not write the local log. In-memory events can still be copied.', 'support.dropped': '{count} earlier or excess events are not shown.',
        'support.error': 'The action did not complete. Please retry.', 'support.about': 'About · Versions & feedback', 'support.current': 'Installed version', 'support.latest': 'Latest on npm',
        'support.unchecked': 'Not checked', 'support.check': 'Check for updates', 'support.checking': 'Checking…', 'support.unavailable': 'Unavailable',
        'support.checkFailed': 'Check failed; the latest release is unconfirmed', 'support.cached': 'Last check', 'support.ahead': 'Local version is newer', 'support.update': 'Update available', 'support.same': 'Up to date',
        'support.star': 'Give the author a star on GitHub ↗', 'support.bug': 'Report a bug on GitHub ↗', 'support.old': 'Reload the updated Host to use this feature.',
      },
    }


    exports.SUPPORT_DICT = SUPPORT_DICT
  })

  // -------------------------------------------------------- support-panels
  define("support-panels", function (require, module, exports) {
    const { API } = require("constants")
    const { setClientTraceSession, tracedFetch } = require("diagnostic-events")
    const React = require('react')
    const h = React.createElement
    const REPOSITORY = 'https://github.com/TZYCeng/dsh-model-visibility'
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

    function DebugPanel({ t, features }) {
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

    function AboutPanel({ t, features }) {
      const supported = has(features, 'versionInfo')
      const [open, setOpen] = React.useState(false)
      const s = useSupportRequest(supported)
      React.useEffect(() => { if (open && supported) void s.call('version?check=1') }, [open, supported])
      const v = s.data
      const label = v?.comparison === 0 ? 'support.same' : v?.comparison > 0 ? 'support.ahead' : 'support.update'
      const link = (path, label) => h('a', { href: REPOSITORY + path, target: '_blank', rel: 'noopener noreferrer' }, t(label))
      return h('details', { className: 'mvp_support mvp_supportAbout', open, onToggle: e => setOpen(e.currentTarget.open) },
        h('summary', null, t('support.about')), open ? h('div', { className: 'mvp_supportResult' },
          supported ? h('div', { className: 'mvp_supportLine', role: 'status' },
            h('span', null, t('support.current') + ': ' + (v?.current ?? '—')), h('span', null, t('support.latest') + ': ' + (v?.latest ?? (s.busy ? t('support.checking') : t('support.unavailable')))),
            v?.latest && !v.error && !s.error ? h('small', null, t(label)) : null,
            v?.error || s.error ? h('small', { role: 'status' }, t('support.checkFailed') + (v?.latest && Number.isFinite(v?.checkedAt) ? ' · ' + t('support.cached') + ' ' + new Date(v.checkedAt).toLocaleString() : '')) : null,
            button(t('support.check'), () => void s.call('version?check=1'), s.busy)) : h('p', null, t('support.old')),
          h('p', { className: 'mvp_supportLine' }, link('', 'support.star'), link('/issues/new', 'support.bug'))) : null)
    }


    exports.DebugPanel = DebugPanel
    exports.AboutPanel = AboutPanel
  })

  // -------------------------------------------------------- tags
  define("tags", function (require, module, exports) {
    const { kindOf, sourceOf, sourceLabel, isInferredSource, formatContext, effortNames, defaultEffortName, modalityNames, modalityLabel, resolutionOf, manualFieldsOf } = require("format")

    // Evidence belongs to a field, never to a whole row: a context alias is not proof of a ladder.
    function withEvidence(tag, model, field, t) {
      const fact = model.fieldEvidence?.[field]
      const alias = fact?.alias === true || (field === 'referenceReasoning' && model.referenceReasoningAlias === true)
      if (!fact && !alias) return tag
      const details = [tag.title, fact?.catalog, fact?.lookupId ? t('tag.lookupId', { id: fact.lookupId }) : null, alias ? t(fact?.source === 'provider' ? 'tag.relayAliasTitle' : 'tag.aliasReferenceTitle') : null]
      return { ...tag, evidenceField: field, label: tag.label + (alias ? ' · ' + t('tag.aliasReference') : ''), title: details.filter(Boolean).join(' · '),
        inferred: Boolean(tag.inferred || alias || isInferredSource(fact?.source)) }
    }

    function manualTag(model, t) {
      return manualFieldsOf(model).length === 0
        ? null
        : {
            key: 'manual',
            tone: 'accent',
            label: t('tag.manual'),
            title: t('tag.manualTitle'),
          }
    }

    /** Tags for image / video / embedding / rerank / audio / moderation models. */
    function generationTags(model, t) {
      const kind = kindOf(model)
      const kindSource = sourceOf(model, 'kind')
      const kindLabel = t('tag.kind.' + kind) === 'tag.kind.' + kind ? t('tag.kind.unknown') : t('tag.kind.' + kind)
      const titleKey = kind === 'image' ? 'tag.kindImageTitle' : kind === 'video' ? 'tag.kindVideoTitle' : 'tag.kindTitle'
      const tags = [
        {
          key: 'kind',
          tone: 'kind-' + kind,
          label: kindLabel,
          title: t(titleKey, { kind: kindLabel, source: sourceLabel(kindSource, t) }),
          inferred: isInferredSource(kindSource),
        },
      ]
      const resolution = resolutionOf(model)
      if (resolution !== null && (kind === 'image' || kind === 'video')) {
        tags.push({
          key: 'resolution',
          tone: 'neutral',
          label: resolution,
          title: t('tag.resolutionTitle', { value: resolution }),
        })
      }
      // Image editing capability is the one input fact worth showing on a
      // generation row; it never turns into the chat "multimodal" tag.
      if (kind === 'image' && Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) {
        tags.push({
          key: 'image-input',
          tone: 'neutral',
          label: t('tag.imageInput'),
          title: t('tag.imageInputTitle'),
        })
      }
      const manual = manualTag(model, t)
      if (manual !== null) tags.push(manual)
      return tags.map((tag) => tag.key === 'kind' || tag.key === 'image-input' ? withEvidence(tag, model, tag.key === 'kind' ? 'kind' : 'modalities', t) : tag)
    }

    /**
     * Per-model capability tags. The same model may know only part of its
     * capabilities: an adapter that cannot answer produces `infoError`, and the
     * unknown facts are shown as such instead of being guessed. Each tag knows
     * whether its value is a declaration (solid border) or a completion from the
     * built-in catalog / name heuristics (dashed border).
     */
    function capabilityTags(model, t) {
      const kind = kindOf(model)
      if (kind !== 'chat') return generationTags(model, t)

      const tags = []
      const reasoning = model.reasoning
      const reasoningSource = sourceOf(model, 'reasoning')
      const requestReasoning = Object.hasOwn(model, 'requestReasoning') ? model.requestReasoning
        : reasoningSource === 'config' || reasoningSource === 'adapter' ? reasoning : null
      const requestLevels = effortNames(requestReasoning)
      const referenceLevels = model.reasoningSupported === false ? [] : effortNames(reasoning)
      const sameLadder = referenceLevels.length === requestLevels.length
        && referenceLevels.every((level, index) => level === requestLevels[index])
        && reasoning?.defaultEffort === requestReasoning?.defaultEffort
      const errorTitle = typeof model.infoError === 'string' && model.infoError !== ''
        ? t('tag.infoErrorTitle', { message: model.infoError }) : t('tag.unknownTitle')

      if (model.reasoningSupported === false && requestLevels.length === 0) {
        const authoritative = reasoningSource === 'config' || reasoningSource === 'adapter'
        tags.push({ key: 'reasoning', tone: 'muted', label: t(authoritative ? 'tag.noReasoning' : 'tag.noReasoningReference'),
          title: sourceLabel(reasoningSource, t), inferred: !authoritative })
      } else if (model.reasoningSupported === true || requestLevels.length > 0) {
        tags.push({ key: 'reasoning', tone: 'accent', label: t(requestLevels.length > 0 ? 'tag.reasoning' : 'tag.reasoningReference'),
          title: requestLevels.length > 0
            ? t('tag.reasoningTitle', { levels: requestLevels.join(' / '), source: sourceLabel('adapter', t) })
            : t('tag.reasoningCatalogTitle', { source: sourceLabel(reasoningSource, t) }),
          inferred: requestLevels.length === 0 && (isInferredSource(reasoningSource) || reasoningSource === 'manual') })
      } else {
        tags.push({ key: 'reasoning', tone: 'muted', label: t('tag.reasoningUnknown'), title: errorTitle })
      }

      if (requestLevels.length > 0 && model.reasoningSupported === false) {
        tags.push({ key: 'reference-no-reasoning', tone: 'muted', inferred: true,
          label: t('tag.noReasoningReference'), title: t('tag.effortReferenceTitle', { source: sourceLabel(reasoningSource, t) }) })
      }
      if (requestLevels.length > 0) {
        const fallback = defaultEffortName(requestReasoning)
        tags.push({ key: 'effort', tone: 'neutral', label: t('tag.effort') + ' ' + requestLevels.join('/'),
          title: fallback === null
            ? t('tag.effortTitleNoFallback', { levels: requestLevels.join(' / '), source: sourceLabel('adapter', t) })
            : t('tag.effortTitle', { levels: requestLevels.join(' / '), fallback, source: sourceLabel('adapter', t) }) })
      }
      if (model.reasoningWireDisabled === true) {
        tags.push({ key: 'effort-wire-off', tone: 'muted', label: t('tag.effortWireOff'), title: t('tag.effortWireOffTitle') })
      }
      const published = effortNames(model.referenceReasoning)
      const sameLevels = (a, b) => a.length === b.length && a.every((level, index) => level === b[index])
      if (referenceLevels.length > 0 && !sameLadder && !sameLevels(referenceLevels, published)) {
        const ladderSource = model.fieldEvidence?.reasoningEfforts?.source || model.sources?.reasoningEfforts || reasoningSource
        tags.push({ key: 'reference-effort', tone: 'muted', inferred: true,
          label: t(model.reasoningCatalog || ladderSource === 'public' ? 'tag.effortPublicReference' : 'tag.effortReference') + ' ' + referenceLevels.join('/'),
          title: t('tag.effortReferenceTitle', { source: model.reasoningCatalog ?? sourceLabel(ladderSource, t) }) })
      }
      // A trusted directory can advertise a different ladder *alongside* the actual adapter ladder.
      if (published.length && !sameLevels(published, requestLevels)) {
        const fact = model.fieldEvidence?.referenceReasoning
        const raw = model.referenceReasoningSource
        const label = fact?.catalog || (raw && !['public', 'snapshot', 'catalog'].includes(raw) ? raw : sourceLabel(fact?.source || raw || 'snapshot', t))
        tags.push({ key: 'published-effort', tone: 'muted', inferred: true,
          label: t(fact?.source === 'public' || (typeof raw === 'string' && !['snapshot', 'manual'].includes(raw)) ? 'tag.effortPublicReference' : 'tag.effortReference') + ' ' + published.join('/'),
          title: t('tag.effortReferenceTitle', { source: label }) })
      }

      const contextSource = sourceOf(model, 'context')
      const context = formatContext(model.contextWindow)
      tags.push({
        key: 'context',
        tone: context === null ? 'muted' : 'neutral',
        label: t('tag.context') + ' ' + (context === null ? t('tag.unknown') : context),
        title:
          context === null
            ? errorTitle
            : t('tag.contextTitle', {
                tokens: Number(model.contextWindow).toLocaleString(),
                source: sourceLabel(contextSource, t),
              }),
        inferred: context !== null && isInferredSource(contextSource),
      })

      const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : null
      const modalitySource = sourceOf(model, 'modalities')
      if (modalities === null || modalities.length === 0) {
        tags.push({ key: 'modality', tone: 'muted', label: t('tag.modalityUnknown'), title: errorTitle })
      } else {
        const vision = modalities.includes('image')
        const textOnly = modalities.every((modality) => modality === 'text')
        tags.push({
          key: 'modality',
          tone: vision ? 'vision' : 'neutral',
          label: vision ? t('tag.multimodal') : textOnly ? t('tag.textOnly') : modalityNames(modalities, t),
          title: t('tag.modalityTitle', {
            modalities: modalityNames(modalities, t),
            source: sourceLabel(modalitySource, t),
          }),
          inferred: isInferredSource(modalitySource),
        })
      }

      // A vendor-documented correction is the one non-dashed value that is not
      // an adapter declaration; keep it visible so "why is this text-only?"
      // has an answer next to the tag.
      const correction = model.correction
      if (correction !== null && typeof correction === 'object' && typeof correction.code === 'string') {
        const noteKey = 'correction.' + correction.code
        const localized = t(noteKey)
        const note = localized === noteKey
          ? typeof correction.note === 'string' && correction.note !== ''
            ? correction.note
            : correction.code
          : localized
        tags.push({
          key: 'correction',
          tone: 'muted',
          label: t('tag.correction'),
          title: t('tag.correctionTitle', {
            note,
            source: typeof correction.source === 'string' && correction.source !== '' ? correction.source : '—',
          }),
        })
      }
      const manual = manualTag(model, t)
      if (manual !== null) tags.push(manual)
      return tags.map((tag) => {
        const field = { context: 'context', modality: 'modalities', 'reference-no-reasoning': 'reasoning',
          'reference-effort': model.fieldEvidence?.reasoningEfforts ? 'reasoningEfforts' : 'reasoning', 'published-effort': 'referenceReasoning' }[tag.key]
          || (tag.key === 'reasoning' && !requestLevels.length ? 'reasoning' : undefined)
        return field ? withEvidence(tag, model, field, t) : tag
      })
    }

    function tagClassOf(tag) {
      const tone =
        tag.tone === 'accent'
          ? ' mvp_tag--accent'
          : tag.tone === 'vision'
            ? ' mvp_tag--vision'
            : tag.tone === 'kind'
              ? ' mvp_tag--kind'
              : typeof tag.tone === 'string' && tag.tone.startsWith('kind-')
                ? ' mvp_tag--kind mvp_tag--' + tag.tone
                : tag.tone === 'muted'
                  ? ' mvp_tag--muted'
                  : ''
      return 'mvp_tag' + tone + (tag.inferred === true ? ' mvp_tag--inferred' : '')
    }

    exports.capabilityTags = capabilityTags
    exports.tagClassOf = tagClassOf

  })

  // -------------------------------------------------------- usage-view
  define("usage-view", function (require, module, exports) {
    /**
     * Token-usage strip with the two CSV exports.
     *
     * One line, four numbers, two icon-sized buttons: the strip is context, not
     * the point of the page, so it must not push the model list down. Exact
     * numbers live in the tooltip; the visible figure is the total.
     */

    const React = require('react')
    const h = React.createElement

    const { API } = require("constants")
    const { bucketTotalOf, formatTokens } = require("pure")
    const { useSource } = require("hooks")

    /** Detail line for one window: input / output / cache split. */
    function detailOf(range, t) {
      if (!Array.isArray(range)) return t('usage.none')
      // Exactly the four non-overlapping buckets exported to CSV, unrounded.
      return t('usage.detail', {
        input: range[0] ?? 0,
        output: range[1] ?? 0,
        cacheRead: range[2] ?? 0,
        cacheWrite: range[3] ?? 0,
      })
    }

    /** Download only a successful CSV response, not a Host JSON error document. */
    async function download(type, signal) {
      const response = await fetch(API + '/export?type=' + type, {
        headers: { accept: 'text/csv' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      })
      signal.throwIfAborted()
      if (!response.ok) {
        let detail = ''
        try { detail = (await response.json())?.error?.message ?? '' } catch (_error) { /* status is enough */ }
        throw new Error('HTTP ' + response.status + (detail ? ': ' + detail : ''))
      }
      if (!/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected a CSV response.')
      const filename = /filename="([A-Za-z0-9_.-]+\.csv)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
      const blob = await response.blob()
      signal.throwIfAborted() // A fetch shim may ignore abort and still resolve its body.
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      try {
        anchor.href = href
        anchor.rel = 'noopener'
        anchor.download = filename ?? 'model-visibility-' + type + '.csv'
        document.body.appendChild(anchor)
        anchor.click()
      } finally {
        anchor.remove()
        // Leave time for the browser to acquire the blob before releasing the URL.
        setTimeout(() => URL.revokeObjectURL(href), 1000)
      }
    }

    // Cover headers, error documents and the final blob. Release the UI even if
    // a nonconforming transport ignores abort; download guards its side effects.
    async function boundedDownload(type, controller) {
      const { signal } = controller
      const timer = setTimeout(() => controller.abort(new Error('CSV download timed out')), 120_000)
      let stop
      const aborted = new Promise((_, reject) => {
        stop = () => reject(signal.reason)
        signal.addEventListener('abort', stop, { once: true })
      })
      try {
        signal.throwIfAborted()
        await Promise.race([download(type, signal), aborted])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
      }
    }

    function UsageToolbar({ usage, t, features }) {
      const state = useSource(usage)
      const supported = features.length === 0 || features.includes('usage')
      const ranges = state.snapshot?.ranges
      const computing = state.snapshot?.computing === true
      const scanError = state.snapshot?.error
      const [exporting, setExporting] = React.useState(null)
      const [exportError, setExportError] = React.useState(null)
      const activeExport = React.useRef(null)
      React.useEffect(() => () => {
        const controller = activeExport.current
        activeExport.current = null
        controller?.abort()
      }, [])

      const startExport = (type) => {
        if (activeExport.current !== null) return
        const controller = new AbortController()
        activeExport.current = controller
        setExporting(type)
        setExportError(null)
        void boundedDownload(type, controller).catch(error => {
          if (activeExport.current === controller) setExportError(String(error?.message ?? error))
        }).finally(() => {
          if (activeExport.current !== controller) return
          activeExport.current = null
          setExporting(null)
        })
      }

      if (!supported) {
        return h('div', { className: 'mvp_usage mvp_usage--off' }, t('usage.hostStale'))
      }

      const windows = [
        ['today', 'usage.today', 'usage.todayTitle'],
        ['week', 'usage.week', 'usage.weekTitle'],
        ['month', 'usage.month', 'usage.monthTitle'],
        ['total', 'usage.total', 'usage.totalTitle'],
      ]

      const notices = [
        computing && t('usage.computing'),
        exporting !== null && t(exporting === 'usage' ? 'usage.exportingUsage' : 'usage.exportingModels'),
        (state.error || scanError) && t('usage.readFailed', { message: state.error || scanError }),
        exportError !== null && t('usage.exportFailed', { message: exportError }),
      ].filter(Boolean)

      return h(
        'div',
        { className: 'mvp_usage' },
        h('span', { className: 'mvp_usageLabel' }, t('usage.title')),
        h(
          'span',
          { className: 'mvp_usageRanges' },
          windows.map(([key, labelKey, titleKey]) => {
            const range = ranges?.[key]
            const total = bucketTotalOf(range)
            // Zero from a cold or failed scan isn't yet a confirmed zero.
            const known = Array.isArray(range) && (total > 0 || (!computing && !scanError && !state.error))
            return h(
              'span',
              {
                key,
                className: 'mvp_stat' + (key === 'total' ? ' mvp_stat--total' : ''),
                title: t(titleKey) + '\n' + (known ? detailOf(range, t) : t('usage.none')),
              },
              h('span', { className: 'mvp_statLabel' }, t(labelKey)),
              h('span', { className: 'mvp_statValue' }, known ? formatTokens(total) : t('usage.none')),
            )
          }),
        ),
        h(
          'span',
          { className: 'mvp_usageActions' },
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button mvp_button--quiet',
              title: t('usage.exportUsageTitle'),
              disabled: exporting !== null,
              onClick: () => startExport('usage'),
            },
            t('usage.exportUsage'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button mvp_button--quiet',
              title: t('usage.exportModelsTitle'),
              disabled: exporting !== null,
              onClick: () => startExport('models'),
            },
            t('usage.exportModels'),
          ),
        ),
        h('span', { className: 'mvp_usageStatus', role: 'status', 'aria-live': 'polite', 'aria-atomic': true,
          title: notices.length ? notices.join('\n') : undefined, tabIndex: exporting || state.error || scanError || exportError ? 0 : undefined },
          notices.map((text, i) => h('span', { key: i, className: 'mvp_usageStatusText' }, text))),
      )
    }


    exports.UsageToolbar = UsageToolbar
  })

  // -------------------------------------------------------- visibility-codec
  define("visibility-codec", function (require, module, exports) {
    /**
     * Stored hidden[] is also read by old composer clients. A legacy `a/b/c`
     * hides EVERY provider/model split. Never infer a split from a (possibly
     * partial) catalog. Keep that conservative baseline and add exact exceptions.
     *
     * For a newly hidden ambiguous route keep the legacy key as an old-reader
     * shadow, plus a `hide` tag. A group with hide tags is an explicit subset;
     * a legacy group without hide tags is still a blanket with optional `show`
     * exceptions. Old readers may hide extra colliding routes, never expose one
     * we hide. Old readers deleting a shadow explicitly show the group. Tags
     * without a shadow are inert. Untouched/unknown preferences pass through.
     *
     * Tags contain no literal slash and cannot be any legacy provider/model key.
     * JSON handles arbitrary IDs (including lone surrogates); escape only the
     * percent sign and slash, in that order, to make the tag's namespace disjoint.
     */
    const PREFIX = 'mv2:'
    const tag = (kind, provider, model) => PREFIX + kind + ':' + JSON.stringify([provider, model]).replaceAll('%', '%25').replaceAll('/', '%2F')
    const legacyKey = (provider, model) => provider + '/' + model
    const ambiguous = (provider, model) => provider.includes('/') || model.includes('/')
    const id = (text) => typeof text === 'string' && text.length > 0

    /** Injective route identity. Preserve every already-unambiguous legacy key. */
    function routeKey(provider, model) {
      return ambiguous(provider, model) ? tag('hide', provider, model) : legacyKey(provider, model)
    }

    function parseTag(text) {
      if (typeof text !== 'string' || !text.startsWith(PREFIX) || text.includes('/')) return null
      const split = text.indexOf(':', PREFIX.length)
      const kind = text.slice(PREFIX.length, split)
      if (kind !== 'hide' && kind !== 'show') return null
      try {
        const pair = JSON.parse(text.slice(split + 1).replaceAll('%2F', '/').replaceAll('%25', '%'))
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(id)) return null
        const [provider, model] = pair
        if (!ambiguous(provider, model) || tag(kind, provider, model) !== text) return null
        return { kind, provider, model, legacy: legacyKey(provider, model) }
      } catch { return null }
    }

    /** Exact route fields for usage exports; old multi-slash totals stay unassigned. */
    function routeFields(key) {
      if (typeof key !== 'string') return null
      const slash = key.indexOf('/')
      if (slash > 0 && slash < key.length - 1 && slash === key.lastIndexOf('/')) return [key.slice(0, slash), key.slice(slash + 1)]
      const parsed = parseTag(key)
      return parsed?.kind === 'hide' ? [parsed.provider, parsed.model] : null
    }

    // Per-legacy-group tag index, updated along with the raw strings. A raw key
    // with no tag always retains the full historical behavior, even if a model
    // disappears from the catalog and comes back under another provider split.
    function preferences(list) {
      const raw = new Set(Array.isArray(list) ? list : [])
      const groups = new Map()
      for (const text of raw) {
        const parsed = parseTag(text)
        if (!parsed) continue
        let metadata = groups.get(parsed.legacy)
        if (!metadata) groups.set(parsed.legacy, metadata = { hide: new Set(), show: new Set() })
        metadata[parsed.kind].add(text)
      }

      const hasRoute = (provider, model) => {
        const legacy = legacyKey(provider, model)
        if (!raw.has(legacy)) return false
        const meta = groups.get(legacy)
        if (!meta) return true
        return meta.hide.size ? meta.hide.has(tag('hide', provider, model)) : !meta.show.has(tag('show', provider, model))
      }

      const setRoute = (provider, model, visible) => {
        if (hasRoute(provider, model) === !visible) return false
        const legacy = legacyKey(provider, model)
        if (!ambiguous(provider, model)) {
          if (visible) raw.delete(legacy)
          else raw.add(legacy)
          return true
        }
        let meta = groups.get(legacy)
        if (!meta) groups.set(legacy, meta = { hide: new Set(), show: new Set() })
        const hidden = tag('hide', provider, model)
        const shown = tag('show', provider, model)
        if (!raw.has(legacy)) {
          // An old reader removed the shadow but retained unknown tags. A later
          // explicit hide must not resurrect other routes from that old edit.
          for (const keys of [meta.hide, meta.show]) { for (const key of keys) raw.delete(key); keys.clear() }
          raw.add(legacy); raw.add(hidden); meta.hide.add(hidden)
        } else if (meta.hide.size) {
          if (!visible) { raw.add(hidden); meta.hide.add(hidden) }
          else {
            raw.delete(hidden); meta.hide.delete(hidden)
            if (!meta.hide.size) {
              raw.delete(legacy)
              for (const key of meta.show) raw.delete(key)
              groups.delete(legacy)
            }
          }
        } else if (visible) {
          // Do not split or replace a blanket based on currently listed models.
          raw.add(shown); meta.show.add(shown)
          // Once *every possible* nonempty split was explicitly shown, the old
          // blanket can be removed too. Counting separators does not guess IDs.
          let splits = 0
          for (let i = 1; i < legacy.length - 1; i++) if (legacy[i] === '/') splits++
          if (meta.show.size === splits) {
            raw.delete(legacy)
            for (const key of meta.show) raw.delete(key)
            groups.delete(legacy)
          }
        } else { raw.delete(shown); meta.show.delete(shown) }
        return true
      }
      return { raw, hasRoute, setRoute }
    }

    /** Read-only facade for filters using canonical keys, plus a direct hot-path check. */
    function hiddenIndex(list) {
      const { raw, hasRoute } = preferences(list)
      return { hasRoute, has(key) {
        if (typeof key !== 'string') return false
        if (key.includes('/')) return raw.has(key)
        const parsed = parseTag(key)
        return parsed?.kind === 'hide' && hasRoute(parsed.provider, parsed.model)
      } }
    }

    /** Pure route-level edit. Keep the input array reference if nothing changed. */
    function editHiddenRoutes(list, routes, visible) {
      const prefs = preferences(list)
      let changed = false
      for (const { provider, model } of routes) if (prefs.setRoute(provider, model, visible)) changed = true
      return changed ? [...prefs.raw] : list
    }


    exports.routeKey = routeKey
    exports.routeFields = routeFields
    exports.hiddenIndex = hiddenIndex
    exports.editHiddenRoutes = editHiddenRoutes
  })

  // -------------------------------------------------------- visibility-identity
  define("visibility-identity", function (require, module, exports) {
    const { FIELD } = require("constants")
    const { editHiddenRoutes } = require("visibility-codec")
    const { clientTrace } = require("diagnostic-events")

    // One FIFO per shared ConfigForm, not per mounted settings component. Queue
    // intents only and compute each replacement against the latest accepted view.
    // The fixed revision fences other browser tabs and other editors of the field.
    const writes = new WeakMap()

    function canWriteHidden(form, snapshot) {
      return typeof form?.mutate === 'function' && snapshot?.status === 'ready' && snapshot.writable === true &&
        Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 && Array.isArray(snapshot.value?.[FIELD])
    }

    async function commit(form, routes, visible) {
      // The official form reloads its mirror on a latest refused write. Retry an
      // unrelated revision change against that accepted value, but don't spin on
      // a read-only/missing/refused document or an endlessly moving revision.
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = form.getSnapshot()
        if (!canWriteHidden(form, snapshot)) return false
        const original = snapshot.value[FIELD]
        const value = editHiddenRoutes(original, routes, visible)
        if (value === original) return true
        const accepted = await form.mutate([{ op: 'set', path: [FIELD], value }], snapshot.revision)
        if (accepted === true) return true
        if (form.getSnapshot().revision === snapshot.revision) return false
      }
      return false
    }

    /** Explicit desired visibility of the specified routes, never a stale whole list. */
    function writeHiddenRoutes(form, routes, visible) {
      if (!Array.isArray(routes) || typeof visible !== 'boolean' || !routes.every(item =>
        typeof item?.provider === 'string' && item.provider !== '' && typeof item.model === 'string' && item.model !== '')) {
        return Promise.reject(new TypeError('Invalid model visibility edit'))
      }
      const owned = routes.map(({ provider, model }) => ({ provider, model }))
      const run = () => commit(form, owned, visible)
      const result = (writes.get(form) ?? Promise.resolve()).then(run)
      const settle = (accepted) => {
        clientTrace('visibility', accepted ? 'accepted' : 'refused', { count: owned.length, enabled: visible })
      }
      // A failed write must not poison the queue or produce an unhandled rejection.
      const tail = result.then(accepted => { settle(accepted); }, () => { settle(false) })
      writes.set(form, tail)
      tail.then(() => { if (writes.get(form) === tail) writes.delete(form) })
      return result
    }


    exports.canWriteHidden = canWriteHidden
    exports.writeHiddenRoutes = writeHiddenRoutes
  })

  // -------------------------------------------------------- entry
  define("entry", function (require, module, exports) {
    /**
     * Plugin entry: store wiring, facts inputs and effect registration.
     *
     * Assembled with the other modules by `scripts/build-client.mjs`; the bundle
     * factory returns `{ inject, apply }` exactly like the original single-file
     * bundle, but every subsystem now lives in its own module.
     */

    const React = require('react')
    const h = React.createElement

    const { NS, ENTRY, SECTION_ID } = require("constants")
    const { DICT } = require("dict")
    const { CHECKER_EN, CHECKER_ZH } = require("checker-dict")
    const { SUPPORT_DICT } = require("support-dict")
    const { CSS } = require("css")
    const { CHECKER_CSS } = require("checker-style")
    const { setClientTraceSession } = require("diagnostic-events")
    const { createCatalog, createOverrides, createUsageApi, createVerifyApi } = require("catalog-store")
    const { makeSection } = require("settings-section")
    const { installComposerFilter } = require("composer-filter")

    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        ...DICT, en: { ...DICT.en, ...CHECKER_EN, ...SUPPORT_DICT.en }, zh: { ...DICT.zh, ...CHECKER_ZH, ...SUPPORT_DICT.zh },
      }), 'model-visibility: dictionaries')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-model-visibility'
        tag.textContent = CSS + CHECKER_CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'model-visibility: styles')

      const form = ctx.configForms.get(ENTRY)
      const catalog = createCatalog(ctx)
      const overrides = createOverrides()
      const usage = createUsageApi()
      const verify = createVerifyApi()

      ctx.effect(() => {
        const disposers = []
        disposers.push(
          ctx.on('connection/reset', () => {
            // Never flush buffered diagnostics into a different Host identity.
            setClientTraceSession(null)
            // A different Host may now own the same URL; discard previous capabilities,
            // receipts and in-flight reads/writes even when no page is observing.
            for (const store of [catalog, overrides, usage, verify, verify.bulk]) void store.invalidate({ reset: true })
          }),
        )
        if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
          for (const event of ['llm/adapters-updated', 'llm/models-updated']) {
            disposers.push(ctx.remote.$on(event, () => { void catalog.invalidate({ fresh: true }); void verify.bulk.invalidate() }))
          }
          for (const event of [
            'settings/document-updated',
            'credentials/record-updated',
            'credentials/reference-updated',
          ]) {
            disposers.push(
              ctx.remote.$on(event, () => {
                // Supersede a stale browser GET, but do not force new relay probes
                // for unrelated settings edits (for example a visibility toggle).
                void catalog.invalidate()
                if (event === 'settings/document-updated') void verify.bulk.invalidate()
              }),
            )
          }
        }
        return () => {
          setClientTraceSession(null)
          for (const store of [catalog, overrides, usage, verify]) store.dispose()
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (_error) {
              // A source may already be gone during teardown.
            }
          }
        }
      }, 'model-visibility: catalog refresh')

      const Section = makeSection(form, catalog, overrides, usage, verify)
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 12,
                locale: NS,
                label: () => ctx.locale.bind(NS)('nav'),
              },
              Section,
            ),
          ),
        'model-visibility: settings section',
      )

      ctx.inject(['modelDirectories'], (scope) => {
        installComposerFilter(scope, form)
      })
    }

    exports.inject = inject
    exports.apply = apply

  })

    const entryModule = moduleRequire("entry")
    return { inject: entryModule.inject, apply: entryModule.apply }
  },
})
