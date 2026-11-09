import { API } from './constants.mjs'

export function createCatalog(ctx) {
  const listeners = new Set()
  let state = {
    status: 'idle',
    groups: [],
    failures: [],
    providers: [],
    catalog: null,
    error: null,
    detailsError: null,
    source: null,
    generatedAt: 0,
  }
  let inflight = null
  // A hard reload starts a new run even while `inflight` is set; the token
  // keeps the older run from publishing its now-stale result afterwards.
  let generation = 0

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  /** Message of a failed Remote envelope. */
  const failureMessage = (response) => {
    const failure = response && response.error
    return failure
      ? String(failure.code) + ': ' + String(failure.message)
      : 'unknown error'
  }

  /**
   * Read the enriched catalog from the Host half. It carries the same
   * groups as `session.modelCatalog` plus context windows and modalities.
   */
  const fetchHostCatalog = async (fresh, reload) => {
    const query = reload ? '?fresh=1&reload=1' : fresh ? '?fresh=1' : ''
    const response = await fetch(API + '/models' + query, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const body = await response.json()
    const value = body && body.ok === true ? body.value : null
    if (value === null || !Array.isArray(value.groups)) {
      throw new Error('malformed capability catalog')
    }
    return value
  }

  /** Read the shipped catalog; the fallback when the route is unavailable. */
  const fetchOfficialCatalog = async () => {
    const response = await ctx.remote.session.modelCatalog()
    if (!response || response.ok !== true) throw new Error(failureMessage(response))
    const value = response.value || {}
    return {
      groups: Array.isArray(value.groups) ? value.groups : [],
      failures: Array.isArray(value.failures) ? value.failures : [],
      generatedAt: 0,
    }
  }

  const load = (options) => {
    const fresh = options !== null && typeof options === 'object' && options.fresh === true
    const reload = options !== null && typeof options === 'object' && options.reload === true
    // A soft load joins whatever is already running. A hard reload has to
    // start its own run, otherwise it would receive the very stale result
    // it is meant to replace.
    if (inflight !== null && !reload) return inflight
    if (state.status !== 'ready') {
      publish({ ...state, status: 'loading', error: null })
    }
    const token = ++generation
    const run = (async () => {
      try {
        const value = await fetchHostCatalog(fresh, reload)
        if (token !== generation) return
        publish({
          status: 'ready',
          groups: Array.isArray(value.groups) ? value.groups : [],
          failures: Array.isArray(value.failures) ? value.failures : [],
          providers: Array.isArray(value.providers) ? value.providers : [],
          // The section reads `state.learned` (the learned-snapshot meta with
          // its feature flags); this store is its only source, so the field
          // name must stay in lock-step with lib/model-info.js's response.
          learned: value.learned && typeof value.learned === 'object' ? value.learned : null,
          error: null,
          detailsError: null,
          source: 'host',
          generatedAt: Number.isFinite(value.generatedAt) ? value.generatedAt : 0,
        })
        return
      } catch (detailError) {
        const detail = String(detailError && detailError.message ? detailError.message : detailError)
        try {
          const value = await fetchOfficialCatalog()
          if (token !== generation) return
          publish({
            status: 'ready',
            groups: value.groups,
            failures: value.failures,
            providers: [],
            learned: null,
            error: null,
            detailsError: detail,
            source: 'catalog',
            generatedAt: value.generatedAt,
          })
        } catch (error) {
          if (token !== generation) return
          publish({
            ...state,
            status: 'error',
            error: String(error && error.message ? error.message : error),
          })
        }
      } finally {
        if (inflight === run) inflight = null
      }
    })()
    inflight = run
    return run
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getSnapshot() {
      return state
    },
    load,
    refresh() {
      return load({ fresh: true })
    },
    reload() {
      return load({ fresh: true, reload: true })
    },
  }
}

/**
 * Manual capability overrides, persisted by the Host half.
 *
 * The page only edits one model at a time; the store keeps the whole list so
 * every row knows whether it already has an override. An older Host half
 * answers 404 and the editor stays hidden behind the `overrides` feature
 * flag.
 */
export function createOverrides() {
  const listeners = new Set()
  let state = { status: 'idle', entries: [], available: null, error: null }
  let inflight = null

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  /** Error text for a failed envelope or HTTP response. */
  const failureOf = async (response) => {
    let detail = ''
    try {
      const body = await response.json()
      if (body && body.error) {
        detail = ' (' + String(body.error.code) + ': ' + String(body.error.message) + ')'
      }
    } catch (_error) {
      // A proxy error page is not JSON; the status code is still useful.
    }
    return new Error('HTTP ' + response.status + detail)
  }

  const readEntries = async (response) => {
    if (response.status === 404) {
      publish({ status: 'ready', entries: [], available: false, error: null })
      return null
    }
    if (!response.ok) throw await failureOf(response)
    const body = await response.json()
    const value = body && body.ok === true ? body.value : null
    if (value === null || !Array.isArray(value.overrides)) {
      throw new Error('malformed override list')
    }
    return value.overrides
  }

  const load = () => {
    if (inflight !== null) return inflight
    if (state.status !== 'ready') publish({ ...state, status: 'loading', error: null })
    const run = (async () => {
      try {
        const response = await fetch(API + '/overrides', {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        })
        const entries = await readEntries(response)
        if (entries !== null) {
          publish({ status: 'ready', entries, available: true, error: null })
        }
      } catch (error) {
        publish({
          ...state,
          status: 'error',
          error: String(error && error.message ? error.message : error),
        })
      } finally {
        if (inflight === run) inflight = null
      }
    })()
    inflight = run
    return run
  }

  /** POST one entry (or `{remove:true}`) and adopt the returned list. */
  const write = async (payload) => {
    const response = await fetch(API + '/overrides', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify(payload),
    })
    if (response.status === 404) {
      publish({ status: 'ready', entries: [], available: false, error: null })
      throw new Error('HTTP 404')
    }
    if (!response.ok) throw await failureOf(response)
    const body = await response.json()
    const value = body && body.ok === true ? body.value : null
    if (value === null || !Array.isArray(value.overrides)) {
      throw new Error('malformed override list')
    }
    publish({ status: 'ready', entries: value.overrides, available: true, error: null })
    return value
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getSnapshot() {
      return state
    },
    load,
    save(entry) {
      return write(entry)
    },
    remove(provider, model) {
      return write({ remove: true, provider, model })
    },
  }
}

/* ------------------------------------------------------ composer filter */

/** Common failure text for envelopes and HTTP errors. */
function failureText(error) {
  return String(error && error.message ? error.message : error)
}

/**
 * Token-usage store behind the page's stats strip.
 *
 * Reads are cheap; the Host keeps a ledger and rescans on its own schedule,
 * so the client only polls and prints. An older Host answers 404 and the
 * strip renders its "host is stale" hint.
 */
export function createUsageApi() {
  const listeners = new Set()
  let state = { status: 'idle', snapshot: null, error: null }
  let inflight = null
  let timer = null

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  const read = async () => {
    if (inflight !== null) return inflight
    const run = (async () => {
      try {
        const response = await fetch(API + '/usage', {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.json()
        const value = body && body.ok === true ? body.value : null
        if (value === null || typeof value !== 'object') throw new Error('malformed usage snapshot')
        publish({ status: 'ready', snapshot: value, error: null })
      } catch (error) {
        publish({ ...state, status: 'error', error: failureText(error) })
      } finally {
        if (inflight === run) inflight = null
      }
    })()
    inflight = run
    return run
  }

  /** One poll now and another every POLL_MS while someone subscribes. */
  const POLL_MS = 30_000
  const startTimer = () => {
    if (timer !== null) return
    timer = setInterval(() => read(), POLL_MS)
  }
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    subscribe(fn) {
      const first = listeners.size === 0
      listeners.add(fn)
      if (first) startTimer()
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0) stopTimer()
      }
    },
    getSnapshot() {
      return state
    },
    load() {
      return read()
    },
    refresh() {
      // A POST rescan is never needed: the Host rescan throttle refreshes on
      // reads anyway. A plain read is enough here.
      return read()
    },
  }
}

/**
 * The verify sweep's client store: read progress, start, cancel. The Host
 * keeps the run in memory, so the store just mirrors its snapshots and keeps
 * one 2 s poll alive while a sweep is running (or being observed).
 */
export function createVerifyApi() {
  const listeners = new Set()
  let state = { status: 'idle', snapshot: null, error: null }
  let inflight = null
  let timer = null

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  const read = async () => {
    if (inflight !== null) return inflight
    const run = (async () => {
      try {
        const response = await fetch(API + '/verify', {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.json()
        const value = body && body.ok === true ? body.value : null
        if (value === null || typeof value !== 'object') throw new Error('malformed verify snapshot')
        publish({ status: 'ready', snapshot: value, error: null })
      } catch (error) {
        publish({ ...state, status: 'error', error: failureText(error) })
      } finally {
        if (inflight === run) inflight = null
      }
    })()
    inflight = run
    return run
  }

  const post = async (payload) => {
    const response = await fetch(API + '/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify(payload ?? {}),
    })
    if (response.status === 404) throw new Error('HTTP 404')
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.json()
        if (body?.error) detail = String(body.error.code) + ': ' + String(body.error.message)
      } catch (_error) {
        // Non-JSON error body: the status code is enough.
      }
      throw new Error('HTTP ' + response.status + detail)
    }
    const body = await response.json()
    if (body?.ok === true) {
      publish({ status: 'ready', snapshot: body.value, error: null })
      return body.value
    }
    throw new Error(failureText(body?.error))
  }

  const SWEEP_POLL_MS = 2_000
  const IDLE_POLL_MS = 60_000
  const startTimer = () => {
    if (timer !== null) return
    timer = setInterval(() => {
      void read()
    }, state.snapshot?.state?.running === true ? SWEEP_POLL_MS : IDLE_POLL_MS)
  }
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    subscribe(fn) {
      const first = listeners.size === 0
      listeners.add(fn)
      if (first) {
        void read()
        startTimer()
      }
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0) stopTimer()
      }
    },
    getSnapshot() {
      return state
    },
    load() {
      return read()
    },
    start(payload) {
      return post(payload)
    },
    cancel() {
      return post({ cancel: true })
    },
  }
}
