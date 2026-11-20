import { API } from './constants.mjs'

/** A separate key space from the composer visibility keys. */
export function overrideIdentity(provider, model) {
  return JSON.stringify([provider, model])
}

export function createCatalog(ctx) {
  const listeners = new Set()
  let state = {
    status: 'idle',
    groups: [],
    failures: [],
    providers: [],
    learned: null,
    error: null,
    detailsError: null,
    source: null,
    generatedAt: 0,
  }
  let inflight = null
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
    if (!response.ok) throw await httpFailure(response)
    const body = await response.json()
    const value = body && body.ok === true ? body.value : null
    if (!Array.isArray(value?.groups)) {
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
      // Only the official Session catalog's reasoning ladder comes from the
      // adapter. Do not infer request settings from enriched reference data.
      groups: Array.isArray(value.groups) ? value.groups.map((group) => ({
        ...group,
        models: Array.isArray(group.models) ? group.models.map((model) =>
          Array.isArray(model.reasoning?.efforts) && model.reasoning.efforts.length > 0
            ? { ...model, requestReasoning: model.reasoning }
            : model) : [],
      })) : [],
      failures: Array.isArray(value.failures) ? value.failures : [],
      generatedAt: 0,
    }
  }

  const load = (options) => {
    const fresh = options?.fresh === true
    const reload = options?.reload === true
    const priority = reload ? 2 : fresh ? 1 : 0
    // A fresh read must not join an older browser GET. A known Host change
    // can also supersede a read of equal priority, without another hard purge.
    if (inflight !== null && !reload && !options?.supersede && priority <= inflight.priority) return inflight.run
    const token = ++generation
    const run = Promise.resolve().then(async () => {
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
        if (token !== generation) return
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
        if (inflight?.run === run) inflight = null
      }
    })
    inflight = { priority, run }
    if (state.status !== 'ready') publish({ ...state, status: 'loading', error: null })
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
      return load({ reload: true })
    },
    afterChange({ fresh = true } = {}) {
      return load({ supersede: true, fresh })
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
  const unavailable = { status: 'ready', entries: [], revisions: null, available: false, error: null, pending: false, refreshing: false }
  let state = { ...unavailable, status: 'idle', available: null }
  let inflight = null
  let generation = 0

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  const readValue = async (response) => {
    if (!response.ok) throw await httpFailure(response)
    const body = await response.json()
    const value = body?.ok === true ? body.value : null
    if (!Array.isArray(value?.overrides)) throw new Error('malformed override list')
    return value
  }

  const readyState = (value) => {
    // A legacy Host cannot guard a full-entry replacement against lost edits.
    if (!Array.isArray(value.revisions)) return unavailable
    const revisions = new Map()
    for (const item of value.revisions) {
      if (typeof item?.provider !== 'string' || typeof item.model !== 'string' ||
          typeof item.revision !== 'string' || item.revision === '') throw new Error('malformed override revisions')
      const key = overrideIdentity(item.provider, item.model)
      if (revisions.has(key)) throw new Error('duplicate override revision')
      revisions.set(key, item.revision)
    }
    if (value.overrides.length !== revisions.size || value.overrides.some((entry) =>
      !revisions.has(overrideIdentity(entry?.provider, entry?.model)))) {
      throw new Error('missing override revision')
    }
    return { ...unavailable, available: true, entries: value.overrides, revisions }
  }

  const load = () => {
    if (state.pending) return Promise.resolve()
    if (inflight !== null) return inflight
    const token = ++generation
    const run = Promise.resolve().then(async () => {
      try {
        const response = await fetch(API + '/overrides', {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        })
        const next = response.status === 404 ? unavailable : readyState(await readValue(response))
        if (token === generation) publish(next)
      } catch (error) {
        if (token === generation) publish({ ...state, status: 'error', error: failureText(error), refreshing: false })
      } finally {
        if (inflight === run) inflight = null
      }
    })
    inflight = run
    publish({ ...state, status: state.status === 'ready' ? 'ready' : 'loading', error: null, refreshing: true })
    return run
  }

  /** Send the revision captured when the draft opened, not the latest one. */
  const write = async (payload, expectedRevision) => {
    if (state.status !== 'ready' || state.available !== true || state.pending) {
      throw new Error('Override list is not ready.')
    }
    const key = overrideIdentity(payload.provider, payload.model)
    if ((state.revisions.get(key) ?? null) !== expectedRevision) {
      throw Object.assign(new Error('Override changed.'), { status: 409 })
    }
    generation += 1
    inflight = null
    publish({ ...state, pending: true, refreshing: false })
    try {
      const response = await fetch(API + '/overrides', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        body: JSON.stringify({ ...payload, expectedRevision }),
      })
      const value = await readValue(response)
      publish(readyState(value))
      return value
    } catch (error) {
      if (error.status === 404) publish(unavailable)
      else publish({ ...state, status: 'error', error: failureText(error), pending: false })
      throw error
    }
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
    save(entry, expectedRevision) {
      return write(entry, expectedRevision)
    },
    remove(provider, model, expectedRevision) {
      return write({ remove: true, provider, model }, expectedRevision)
    },
  }
}

/* ------------------------------------------------------ composer filter */

/** Common failure text for envelopes and HTTP errors. */
function failureText(error) {
  return String(error && error.message ? error.message : error)
}

async function httpFailure(response) {
  let detail = ''
  try {
    const { error } = await response.json()
    if (error) detail = ' (' + String(error.code) + ': ' + String(error.message) + ')'
  } catch (_error) {
    // The status is still useful when a proxy returns a non-JSON body.
  }
  return Object.assign(new Error('HTTP ' + response.status + detail), { status: response.status })
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
  let timerMs = null

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  const read = async () => {
    if (inflight !== null) return inflight
    const run = Promise.resolve().then(async () => {
      try {
        const response = await fetch(API + '/usage', {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        })
        if (!response.ok) throw await httpFailure(response)
        const body = await response.json()
        const value = body && body.ok === true ? body.value : null
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed usage snapshot')
        publish({ status: 'ready', snapshot: value, error: null })
      } catch (error) {
        publish({ ...state, status: 'error', error: failureText(error) })
      } finally {
        if (inflight === run) inflight = null
      }
    })
    inflight = run
    return run
  }

  /**
   * Poll cadence follows the ledger's own progress: a cold scan of the session
   * tree takes seconds, so the strip asks again quickly until it settles
   * instead of showing em dashes for half a minute.
   */
  const LIVE_POLL_MS = 3_000
  const POLL_MS = 30_000
  const rearm = () => {
    // Same rule as the verify store: no observer, no armed timer.
    if (listeners.size === 0) {
      stopTimer()
      return
    }
    const wantMs = state.snapshot?.computing === true ? LIVE_POLL_MS : POLL_MS
    if (timer !== null && timerMs === wantMs) return
    if (timer !== null) clearInterval(timer)
    timerMs = wantMs
    timer = setInterval(() => {
      void read().then(rearm, rearm)
    }, wantMs)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
      timerMs = null
    }
  }

  return {
    subscribe(fn) {
      const first = listeners.size === 0
      listeners.add(fn)
      // Read once immediately: waiting a full poll interval is why the strip
      // looked empty on every first visit.
      if (first) {
        void read().then(rearm, rearm)
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
      return read().then(
        (value) => {
          rearm()
          return value
        },
        (error) => {
          rearm()
          throw error
        },
      )
    },
    refresh() {
      // A POST rescan is never needed: the Host rescan throttle refreshes on
      // reads anyway. A plain read is enough here.
      return this.load()
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
  let state = { status: 'idle', snapshot: null, error: null, pending: false }
  let inflight = null
  let generation = 0
  let timer = null
  /** Cadence the armed timer currently runs at, so rearm can compare. */
  let timerMs = null

  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  const read = async () => {
    // A GET sent while a POST is pending can still capture pre-POST state.
    if (state.pending) return
    if (inflight !== null) return inflight
    const token = generation
    const run = Promise.resolve().then(async () => {
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
        if (token === generation) publish({ status: 'ready', snapshot: value, error: null, pending: false })
      } catch (error) {
        if (token === generation) publish({ ...state, status: 'error', error: failureText(error) })
      } finally {
        if (token === generation) inflight = null
      }
    })
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
    if (body?.ok === true && body.value !== null && typeof body.value === 'object') return body.value
    if (body?.ok === true) throw new Error('malformed verify snapshot')
    throw new Error(failureText(body?.error))
  }

  const mutate = async (payload) => {
    if (state.pending) throw new Error('A verification request is already pending.')
    // Drop the old GET without waiting for it. Its result (or error) no longer
    // describes the state this POST is changing.
    generation += 1
    inflight = null
    publish({ ...state, error: null, pending: true })
    try {
      const value = await post(payload)
      publish({ status: 'ready', snapshot: value, error: null, pending: false })
      return value
    } catch (error) {
      publish({ ...state, pending: false })
      throw error
    } finally {
      rearm()
    }
  }

  const SWEEP_POLL_MS = 2_000
  const IDLE_POLL_MS = 60_000
  /** Re-arm the timer at the cadence the *current* snapshot needs. */
  const rearm = () => {
    // Never arm a timer nobody will observe: a bare `load()` (a test, an
    // explicit refresh) must not leave an interval holding the page alive.
    if (listeners.size === 0) {
      stopTimer()
      return
    }
    const wantFast = state.snapshot?.state?.running === true || state.snapshot?.state?.pendingWrite != null
    const wantMs = wantFast ? SWEEP_POLL_MS : IDLE_POLL_MS
    if (timer !== null && timerMs === wantMs) return
    if (timer !== null) clearInterval(timer)
    timerMs = wantMs
    timer = setInterval(() => {
      void read().then(rearm, rearm)
    }, wantMs)
    // A polling strip must not keep a non-browser process alive.
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
      timerMs = null
    }
  }

  return {
    subscribe(fn) {
      const first = listeners.size === 0
      listeners.add(fn)
      if (first) {
        void read().then(rearm, rearm)
        rearm()
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
      return read().then(
        (value) => {
          rearm()
          return value
        },
        (error) => {
          rearm()
          throw error
        },
      )
    },
    start: mutate,
    cancel() {
      return mutate({ cancel: true })
    },
  }
}
