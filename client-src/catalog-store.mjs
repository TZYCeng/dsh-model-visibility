import { API } from './constants.mjs'
import { clientTrace, tracedFetch } from './diagnostic-events.mjs'

/** A separate key space from the composer visibility keys. */
export function overrideIdentity(provider, model) {
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

export function createCatalog(ctx, options) {
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

export function createOverrides(options) {
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
    return store.mutate(payload.remove ? 'remove' : 'save', (signal) => request('/overrides', signal, { ...payload, expectedRevision }),
      (value) => value.localReadUnavailable === true && typeof value.provider?.written === 'boolean'
        ? { ...state, status: 'error', error: 'overrides/read-after-save' } : readyState(value),
      (error) => error.status === 404 ? unavailable : { ...state, status: 'error', error: failureText(error) })
  }
  return { ...store, save: write, remove: (provider, model, revision) => write({ remove: true, provider, model }, revision) }
}

const emptySnapshot = () => ({ status: 'idle', snapshot: null, error: null, pending: false })
const snapshotOf = (value) => ({ status: 'ready', snapshot: value })

export function createUsageApi(options) {
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

export function createVerifyApi(options) {
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

export function catalogAdvertisesBulk(state) {
  return state?.status === 'ready' && state.source === 'host' &&
    Array.isArray(state.learned?.features) && state.learned.features.includes('bulkEfforts')
}

/** The preview ticket lives only in the open confirmation, never in preferences, traces, or a cached GET. */
export function createBulkEffortsApi(options) {
  const outcomes = ['pending', 'written', 'skipped', 'failed']
  const count = (n) => Number.isSafeInteger(n) && n >= 0
  const scanRows = (rows) => {
    if (!Array.isArray(rows)) return null
    const keys = new Set(), counts = { pending: 0, written: 0, skipped: 0, failed: 0 }
    for (const row of rows) {
      if (!record(row) || !outcomes.includes(row.status) || typeof row.provider !== 'string' || !row.provider ||
          typeof row.model !== 'string' || !row.model) return null
      const key = overrideIdentity(row.provider, row.model)
      if (keys.has(key)) return null
      keys.add(key); counts[row.status]++
    }
    return counts
  }
  const valueOf = (value) => {
    if (typeof value?.enabled !== 'boolean' || typeof value.running !== 'boolean') throw new Error('Malformed bulk-effort status.')
    const counts = scanRows(value.rows)
    if (!counts || !record(value.counts) || !outcomes.every(k => value.counts[k] === counts[k]) ||
        (value.enabled && !count(value.scopeCount))) throw Object.assign(new Error('Incomplete bulk-effort receipt.'), { code: 'bulk/receipt' })
    return { ...snapshotOf(value), available: true, mayBeEnabled: false }
  }
  const store = mirror({ name: 'bulk-efforts', initial: { ...emptySnapshot(), available: null, mayBeEnabled: false },
    timeoutMs: options?.timeoutMs, warnOnLost: (action) => action !== 'preview',
    read: async (signal) => {
      try { return valueOf(await request('/bulk-efforts', signal)) } catch (error) {
        // Older Hosts lack this endpoint. A lost endpoint after a good read is
        // not proof that this Host's authorization was revoked.
        if (error.status === 404 && store.getSnapshot().available !== true) return { available: false }
        throw error
      }
    },
    cadence: (state) => state.available === false ? 0 : state.snapshot?.running ? 2_000 : state.snapshot?.enabled || state.mayBeEnabled ? 10_000 : 60_000,
  })
  const requireEnable = () => {
    const { status, snapshot, mayBeEnabled } = store.getSnapshot()
    if (!options?.canEnableBulk?.() || status !== 'ready' || snapshot?.enabled !== false || snapshot.running || mayBeEnabled) {
      throw new Error('Bulk-effort authorization is not available.')
    }
  }
  const change = (action, ticket) => store.mutate(action, (signal) => request('/bulk-efforts', signal, ticket ? { action, ticket } : { action }),
    valueOf, (error) => {
      const state = store.getSnapshot()
      // A refused ticket does not grant anything. Timeout, transport, or a
      // damaged receipt cannot prove the enable never took effect.
      const mayBeEnabled = state.mayBeEnabled || (action === 'enable' && ![400, 404, 409].includes(error.status))
      return { ...state, status: 'error', error: failureText(error), mayBeEnabled }
    })
  return { ...store,
    async preview(signal) {
      requireEnable()
      const value = await store.mutate('preview', (requestSignal) => request('/bulk-efforts', requestSignal, { action: 'preview' }), null, null, signal)
      const { rows, scopeCount, total, eligible, skipped, expiresAt } = value
      const counts = scanRows(rows)
      if (typeof value.ticket !== 'string' || !value.ticket || !Number.isFinite(expiresAt) ||
          ![total, eligible, skipped, scopeCount].every(count) || eligible + skipped !== total || !counts || rows.length !== total ||
          rows.some(row => typeof row.authorized !== 'boolean' || row.status === 'written' || (row.status === 'pending' && !row.authorized)) ||
          counts.pending !== eligible || rows.filter(row => row.authorized).length !== scopeCount) {
        throw new Error('Incomplete bulk-effort preview; nothing was authorized.')
      }
      return value
    },
    async enable(ticket) {
      if (typeof ticket !== 'string' || !ticket) throw new Error('A confirmed preview ticket is required.')
      requireEnable()
      return change('enable', ticket)
    },
    async disable() {
      const state = store.getSnapshot()
      if (state.snapshot?.enabled !== true && !state.mayBeEnabled) throw new Error('No known bulk-effort authorization to turn off.')
      return change('disable')
    },
  }
}
