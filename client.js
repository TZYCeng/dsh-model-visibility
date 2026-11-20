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

    /** A separate key space from the composer visibility keys. */
    function overrideIdentity(provider, model) {
      return JSON.stringify([provider, model])
    }

    function createCatalog(ctx) {
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
    function createOverrides() {
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
    function createUsageApi() {
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
    function createVerifyApi() {
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


    exports.overrideIdentity = overrideIdentity
    exports.createCatalog = createCatalog
    exports.createOverrides = createOverrides
    exports.createUsageApi = createUsageApi
    exports.createVerifyApi = createVerifyApi
  })

  // -------------------------------------------------------- checker-view
  define("checker-view", function (require, module, exports) {
    const { formatTokens, checkerRoutesOf } = require("pure")
    const { useSource } = require("hooks")

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

      React.useEffect(() => { verify.load() }, [verify])

      const progress = state.snapshot?.state
      const running = progress?.running === true
      const pending = state.pending === true
      const locked = running || pending
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
      const routeOptions = checkerRoutesOf(catalog?.groups)
      const selectedRoute = running && progress?.checker ? progress.checker : pick
      const route = routeOptions.find((entry) => entry.id === selectedRoute.provider) ?? null
      const models = (catalog?.groups ?? []).find((group) => group.id === selectedRoute.provider)?.models ?? []
      const missingChecker = usesChecker && (route === null || !models.some((model) => model.id === selectedRoute.model))

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
        if (!canUse || locked || missingChecker) return
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
        if (!running || pending || stopping) return
        setMessage(null)
        verify.cancel().catch((error) => {
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
        tokens: formatTokens((progress?.tokenUsage?.[0] ?? 0) + (progress?.tokenUsage?.[1] ?? 0)),
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
      if (progress?.catalogMatches > 0 && progress.catalogMatches !== progress.publicOnly) {
        routing.push(t('checker.catalogMatches', { count: progress.catalogMatches }))
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
          running ? h('button', { type: 'button', className: 'mvp_button', disabled: pending || stopping,
            title: t('checker.cancelTitle'), onClick: cancel }, t(stopping ? 'checker.stopping' : 'checker.cancel')) : null,
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
            usesChecker ? select('checker.provider', selectedRoute.provider,
              routeOptions.map((entry) => [entry.id, entry.name]), (provider) => commit({ ...pick, provider, model: '' }),
              { placeholder: 'checker.chooseProvider' }) : null,
            usesChecker ? select('checker.model', selectedRoute.model,
              models.map((model) => [model.id, model.name ?? model.id]), (model) => commit({ ...pick, model }),
              { placeholder: 'checker.chooseModel', disabled: route === null }) : null,
            !running ? h('button', { type: 'button', className: 'mvp_button mvp_button--accent',
              disabled: !canUse || pending || missingChecker, title: t('checker.startTitle'), onClick: run },
            t(usesChecker ? 'checker.start' : 'checker.startPublic')) : null,
          ),
          !locked && canUse && missingChecker ? h('p', { className: 'mvp_checkerHint mvp_checkerNotice' },
            routeOptions.length === 0 ? t(canSetMode || canSetSourceMode ? 'checker.noRoute' : 'checker.noLegacyRoute') : t('checker.chooseRoute')) : null,
          usesChecker || canSetMode || canSetSourceMode || canFullScan ? h('details', { className: 'mvp_checkerDetails' },
            h('summary', null, t('checker.advanced'), (running ? progress?.writeBack === true : writeBack)
              ? h('span', { className: 'mvp_checkerOptionNote' }, ' · ' + t('checker.writeBackEnabled')) : null),
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
            h('div', { className: 'mvp_usageHint' }, t('checker.targetScope'), usesChecker ? ' ' + t('checker.resultsScope') : null),
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
          (progress?.publicOnly ?? 0) > 0 || (progress?.aliasMatches ?? 0) > 0
            ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' }, [
              progress?.publicOnly > 0 ? t('checker.catalogResults', { count: progress.publicOnly }) : null,
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
        ) : null,
      )
    }


    exports.VerifyPanel = VerifyPanel
  })

  // -------------------------------------------------------- composer-filter
  define("composer-filter", function (require, module, exports) {
    const { keyOf } = require("format")
    const { FIELD } = require("constants")

    function hiddenListOf(snapshot) {
      const value = snapshot && snapshot.value
      return value && Array.isArray(value[FIELD]) ? value[FIELD] : []
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
      let lastSignature

      const build = (baseSnapshot, hiddenList) => {
        const hidden = new Set(hiddenList)
        const selection = baseSnapshot.current
        const groups = []
        let changed = false
        for (const group of baseSnapshot.groups ?? []) {
          const all = group.models ?? []
          const models = all.filter((model) => !hidden.has(keyOf(group.id, model.id)) ||
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
        const hidden = hiddenListOf(form.getSnapshot())
        const signature = JSON.stringify(hidden)
        if (baseSnapshot === lastBase && signature === lastSignature) return snapshot
        const next = build(baseSnapshot, hidden)
        // Keep the external-store snapshot stable when a hidden-list edit didn't
        // affect this particular directory (e.g. its current model is retained).
        const sameGroups = baseSnapshot === lastBase && next !== baseSnapshot && snapshot !== baseSnapshot &&
          next.groups.length === snapshot.groups.length && next.groups.every((group, index) => {
            const prior = snapshot.groups[index]
            return group === prior || (group.id === prior.id && group.models.length === prior.models.length &&
              group.models.every((model, modelIndex) => model === prior.models[modelIndex]))
          })
        lastBase = baseSnapshot
        lastSignature = signature
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
          snapshot = lastBase = lastSignature = null
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
    .mvp_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
    .mvp_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .mvp_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.6}

    /* ---------------------------------------------------------------- usage */
    .mvp_usage{flex:none;color:var(--dsw-alias-label-secondary);align-items:center;gap:14px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:6px 0 10px;font-size:12px;line-height:18px;display:flex;flex-wrap:wrap}
    .mvp_usage--off{color:var(--dsw-alias-label-tertiary)}
    .mvp_usageLabel{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:6px;flex:none;display:inline-flex}
    .mvp_usageComputing{color:var(--dsw-alias-brand-primary);font-size:11px}
    .mvp_usageRanges{flex:1;min-width:0;align-items:baseline;gap:16px;display:flex;flex-wrap:wrap}
    .mvp_stat{align-items:baseline;gap:5px;display:inline-flex;white-space:nowrap}
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
    .mvp_row--off{opacity:.62}
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
    .mvp_thumb{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
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

  // -------------------------------------------------------- dict
  define("dict", function (require, module, exports) {
    const DICT = {
      zh: {
        'nav': '模型显示',
        'page.title': '模型显示',
        'page.description':
          '关闭的模型不会出现在聊天输入框的模型下拉列表中；这里的改动立即生效，之后仍可随时重新打开。每个模型标注真实能力：适配器声明优先，其次读中转站模型列表，最后用校验结果或模型名补全。',
        'page.about': '说明',
        'page.aboutTitle': '展开标签含义、来源与颜色说明',
        'page.summary': '聊天列表已启用 {visible} / {total}',
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
        'page.showAll': '启用所有模型',
        'page.showAllTitle': '启用整个列表中的模型，包括不符合当前筛选的模型',
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
        'usage.detail': '输入 {input} · 输出 {output} · 缓存读 {cacheRead} · 缓存写 {cacheWrite}',
        'usage.today': '今天',
        'usage.todayTitle': '本地自然日（今天 0 点起）',
        'usage.week': '本周',
        'usage.weekTitle': '本周一 0 点起',
        'usage.month': '本月',
        'usage.monthTitle': '本月 1 日 0 点起',
        'usage.total': '总计',
        'usage.totalTitle': '保留期内用量（较早月份按会话创建日估算）',
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
        'override.useReferenceTitle': '预览来源、档位和可用的映射，再确认填入草稿。',
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
        'override.referencePreservation': '填入时保留草稿的已有档位、默认档位和手填值。参考写入不会覆盖提供商的现有映射或默认档位。要替换已有映射，请在模型提供商设置中手动修改。',
        'override.referenceRevert': '如需撤销提供商改动，请在模型提供商设置中修改该模型。「恢复自动」只清除本插件设置。',
        'override.cancelReference': '取消填入',
        'override.confirmReference': '确认填入草稿',
        'override.referenceApplied': '已填入草稿，请核对后保存。',
        'override.referenceWireBlank': '保留已有值，空白可用 {value}',
        'override.referenceDisabled': '已保留提供商明确禁用的推理配置。',
        'override.referenceNonChat': '此路由不是对话模型，未写入参考推理设置。',
        'override.referencePreservedEfforts': '这些档位保留了提供商的已有映射：{levels}',
        'override.saveLocal': '保存到本插件',
        'override.saveProvider': '保存并写入模型提供商',
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
        'tag.aliasReferenceTitle': "此能力由唯一的公开目录别名匹配补全，不是该路由的声明。",
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
        'source.snapshot': '已校验',
        'page.applyInput': '为符合条件的中转站模型补充图像输入',
        'page.applyInputShort': '仅补有可靠图像能力证据、且未明确声明输入模态的中转站对话模型；列表标签不代表请求会放行。',
        'page.applyInputHint':
          '开启后，只为有可靠图像能力证据且未明确声明输入模态的中转站（pi-ai）对话模型补充图像输入。列表标注不保证请求会放行，也不保证上游接受图像。关闭后不补充；不修改提供商配置。',
        'page.kindLegend':
          '类型配色：生图 蓝 · 生视频 绿 · 嵌入 橙 · 音频 紫 · 重排 红 · 审核 玫红 · 翻译 灰。「官方校正」表示目录与厂商文档不一致时以文档为准。',
        'page.searchPlaceholder': '搜索名称或 ID',
        'page.capability.multimodal': '多模态',
        'page.capability.multimodalTitle': '只看能力信息包含图像输入的模型',
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
        'page.visibility.label': '显示状态筛选',
        'page.visibility.all': '所有状态',
        'page.visibility.enabled': '已启用',
        'page.visibility.disabled': '已禁用',
        'group.showAll': '启用全组',
        'group.enabledCount': '全组已启用 / 模型总数',
        'group.hideAll': '禁用全组',
        'group.showFiltered': '启用匹配模型',
        'group.hideFiltered': '禁用匹配模型',
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
        'tag.effort': '可选思考强度',
        'tag.effortReference': '参考档位',
        'tag.effortPublicReference': '目录参考档位',
        'tag.reasoningReference': '推理（参考）',
        'tag.noReasoningReference': '参考：不支持推理',
        'tag.effortReferenceTitle': '仅为能力参考（来源：{source}），不改变对话菜单或实际请求。',
        'tag.effortWireOff': '未启用 reasoning_effort',
        'tag.effortWireOffTitle': '这个 OpenAI Completions 路由明确关闭了 reasoning_effort。若上游确实支持此字段，请在模型提供商的兼容设置中启用；其他协议可能使用不同的参数。',
        'tag.context': '上下文',
        'tag.unknown': '未知',
        'tag.multimodal': '多模态',
        'tag.textOnly': '纯文本',
        'tag.modalityUnknown': '模态未知',
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
        'tag.imageInput': '可改图',
        'tag.imageInputTitle': '支持图像输入（图生图 / 参考图）',
        'tag.reasoningTitle': '支持推理，可用档位：{levels}（来源：{source}）',
        'tag.reasoningCatalogTitle': '支持推理；适配器未公布档位，此结论来自{source}',
        'tag.effortTitle': '可用档位：{levels}；默认：{fallback}（来源：{source}）',
        'tag.effortTitleNoFallback': '可用档位：{levels}（来源：{source}）',
        'tag.contextTitle': '上下文窗口 {tokens} tokens；来源：{source}',
        'tag.modalityTitle': '输入模态：{modalities}；来源：{source}',
        'tag.outputTitle': '输出模态：{modalities}；来源：{source}',
        'tag.unknownTitle': '适配器与中转站都没有公布这项信息',
        'tag.infoErrorTitle': '模型能力读取失败：{message}',
        'source.config': '适配器配置',
        'source.adapter': '适配器',
        'source.provider': '中转站模型列表',
        'source.catalog': '内置模型目录',
        'source.inferred': '模型名推断',
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
        'tag.manualTitle': '这项能力由你手动指定，优先于适配器、中转站与内置目录。',
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
        'override.providerWritten': '已同时写入提供商设置：{fields}',
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
        'override.field.kind': '模型类型',
        'override.field.defaultEffort': '默认档位',
        'override.localOnly': '仅保存在本插件：{fields}',
        'override.unresolvedEfforts': '这些档位没有可用的上游值：{levels}',
        'override.routeDefaultConflict': '推理配置与提供商默认档位冲突，未写入。',
        'override.inheritedLadderConflict': '为保留内置目录映射，未写入推理档位。',
        'override.wireTitle': '上游请求值',
        'override.wireHint': '按当前路由的 API 文档填写，不自动猜测。留空可复用已有显式值；未选的已配置档位保持不变。是否发送取决于协议及兼容设置。',
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
        'page.description':
          'Models turned off here disappear from the chat composer model list. Changes apply immediately and can be turned back on at any time. Every model shows its real capabilities: adapter declarations first, then the relay model list, then verification results or the model name.',
        'page.about': 'About',
        'page.aboutTitle': 'Show what the tags, sources and colours mean',
        'page.summary': 'Enabled in the composer: {visible} of {total}',
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
        'page.showAll': 'Enable all models',
        'page.showAllTitle': 'Enable every model in the catalog, even those outside the current filters',
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
        'usage.detail': 'input {input} · output {output} · cache read {cacheRead} · cache write {cacheWrite}',
        'usage.today': 'Today',
        'usage.week': 'Week',
        'usage.month': 'Month',
        'usage.total': 'Total',
        'usage.todayTitle': 'Local calendar day',
        'usage.weekTitle': 'Since Monday 00:00 local',
        'usage.monthTitle': 'Since the 1st local',
        'usage.totalTitle': 'Usage within the retention window (older months attributed by session start day)',
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
        'override.useReferenceTitle': 'Preview the source, levels and available mappings before filling the draft.',
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
        'override.referencePreservation': 'Filling keeps draft levels, the default and manual values. Reference saves keep existing provider mappings and the default. To replace mappings, edit the model provider settings.',
        'override.referenceRevert': 'To undo a provider change, edit the model in Model providers. “Use automatic” clears this plugin’s settings only.',
        'override.cancelReference': 'Cancel fill',
        'override.confirmReference': 'Fill draft',
        'override.referenceApplied': 'Draft filled. Review it before saving.',
        'override.referenceWireBlank': 'Keep existing value or use {value} if blank',
        'override.referenceDisabled': 'Kept reasoning disabled in the provider settings.',
        'override.referenceNonChat': 'This is not a chat route; reference reasoning was not written.',
        'override.referencePreservedEfforts': 'Kept existing provider mappings for: {levels}',
        'override.saveLocal': 'Save in this plugin',
        'override.saveProvider': 'Save and write to provider',
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
        'tag.aliasReferenceTitle': "A unique public catalog alias supplied advisory metadata; it is not a route declaration.",
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
        'source.snapshot': 'verified',
        'page.applyInput': 'Supplement image input for eligible relay models',
        'page.applyInputShort':
          'Only applies to relay chat models with reliable vision evidence and no explicit input declaration. A label does not guarantee image admission.',
        'page.applyInputHint':
          'When on, the plugin can supply image input for eligible relay (pi-ai) chat models with reliable vision evidence and no explicit input declaration. Display labels do not guarantee request admission or upstream support. Turning this off stops supplementation; no provider settings are changed.',
        'page.kindLegend':
          'Kind colours: image blue · video green · embedding orange · audio purple · rerank red · moderation rose · translation grey. “Official correction” means vendor documentation overrides a wrong catalog row.',
        'page.searchPlaceholder': 'Search name or ID',
        'page.capability.multimodal': 'Multimodal',
        'page.capability.multimodalTitle': 'Only models with evidence of image input in the catalog',
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
        'page.visibility.label': 'Filter by visibility',
        'page.visibility.all': 'Any visibility',
        'page.visibility.enabled': 'Enabled',
        'page.visibility.disabled': 'Disabled',
        'group.showAll': 'Enable group',
        'group.enabledCount': 'Enabled / total in this group',
        'group.hideAll': 'Disable group',
        'group.showFiltered': 'Enable matching models',
        'group.hideFiltered': 'Disable matching models',
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
        'tag.effort': 'Selectable effort',
        'tag.effortReference': 'Reference levels',
        'tag.effortPublicReference': 'Catalog reference levels',
        'tag.reasoningReference': 'Reasoning (reference)',
        'tag.noReasoningReference': 'Reference: no reasoning',
        'tag.effortReferenceTitle': 'Capability reference only (source: {source}); does not change the menu or requests.',
        'tag.effortWireOff': 'reasoning_effort disabled',
        'tag.effortWireOffTitle': 'This OpenAI Completions route explicitly disables reasoning_effort. Enable it in provider compatibility settings only if the upstream accepts this field. Other protocols may use different fields.',
        'tag.context': 'Context',
        'tag.unknown': 'unknown',
        'tag.multimodal': 'Multimodal',
        'tag.textOnly': 'Text only',
        'tag.modalityUnknown': 'Modality unknown',
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
        'tag.imageInput': 'Image edit',
        'tag.imageInputTitle': 'Accepts image input (image-to-image / reference images)',
        'tag.reasoningTitle': 'Reasoning supported; levels: {levels} (source: {source})',
        'tag.reasoningCatalogTitle': 'Reasoning supported; the adapter publishes no levels, so this comes from {source}',
        'tag.effortTitle': 'Available levels: {levels}; default: {fallback} (source: {source})',
        'tag.effortTitleNoFallback': 'Available levels: {levels} (source: {source})',
        'tag.contextTitle': 'Context window {tokens} tokens; source: {source}',
        'tag.modalityTitle': 'Input modalities: {modalities}; source: {source}',
        'tag.outputTitle': 'Output modalities: {modalities}; source: {source}',
        'tag.unknownTitle': 'Neither the adapter nor the relay publishes this fact',
        'tag.infoErrorTitle': 'Could not read model capabilities: {message}',
        'source.config': 'adapter configuration',
        'source.adapter': 'adapter',
        'source.provider': 'relay model list',
        'source.catalog': 'built-in model catalog',
        'source.inferred': 'model name inference',
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
          'You set this capability by hand; it outranks the adapter, the relay and the built-in catalog.',
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
        'override.providerWritten': 'Also written to the provider settings: {fields}',
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
        'override.field.kind': 'model kind',
        'override.field.defaultEffort': 'default level',
        'override.localOnly': 'Kept in this plugin only: {fields}',
        'override.unresolvedEfforts': 'No usable upstream values for: {levels}',
        'override.routeDefaultConflict': 'Reasoning was not written because it conflicts with the provider default level.',
        'override.inheritedLadderConflict': 'Reasoning was not written to protect inherited catalog mappings.',
        'override.wireTitle': 'Upstream request values',
        'override.wireHint': 'Follow the route’s API documentation. Blank keeps existing explicit values, including unselected levels. The protocol and compatibility settings determine what is sent.',
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

  // -------------------------------------------------------- format
  define("format", function (require, module, exports) {
    const { FIELD } = require("constants")

    function keyOf(provider, model) {
      return provider + '/' + model
    }

    function hiddenSetOf(snapshot) {
      const value = snapshot && snapshot.value
      const list = value && Array.isArray(value[FIELD]) ? value[FIELD] : []
      return new Set(list)
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
     * `snapshot` is the learned store: facts a checker model or a public catalog
     * reported. Only the adapter, the settings document, the relay's own listing
     * and a vendor correction count as declarations, so a verified row must stay
     * dashed — otherwise an LLM guess would look as trustworthy as a declaration.
     */
    function isInferredSource(source) {
      return source === 'snapshot' || source === 'inferred'
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

    const isStandardChoice = (id) => id !== 'off' && OVERRIDE_EFFORTS.includes(id)

    function providerWriteNote(result, t) {
      if (result === null || typeof result !== 'object') return null
      const fieldLabels = (fields) => fields.map((field) => {
        const key = 'override.field.' + field
        const label = t(key)
        return label === key ? field : label
      }).join(' / ')
      const messages = []
      if (result.written === true) {
        messages.push(t('override.providerWritten', { fields: fieldLabels(Array.isArray(result.fields) ? result.fields : []) }))
      } else if (result.reason && result.reason !== 'nothing' && result.reason !== 'skipped') {
        const key = 'override.reason.' + result.reason
        const label = t(key)
        messages.push(t('override.providerSkipped', { reason: label === key ? result.reason : label }))
      }
      if (result.localOnly?.length) messages.push(t('override.localOnly', { fields: fieldLabels(result.localOnly) }))
      if (result.unresolvedEfforts?.length) messages.push(t('override.unresolvedEfforts', {
        levels: result.unresolvedEfforts.map((id) => effortLabel(id, t)).join(' / '),
      }))
      if (result.reasoningConflict === 'route-default') messages.push(t('override.routeDefaultConflict'))
      if (result.reasoningConflict === 'inherited-ladder') messages.push(t('override.inheritedLadderConflict'))
      if (result.reasoningConflict === 'standard-format') messages.push(t('override.standardFormatConflict'))
      if (result.reasoningConflict === 'reference-disabled') messages.push(t('override.referenceDisabled'))
      if (result.reasoningConflict === 'reference-nonchat') messages.push(t('override.referenceNonChat'))
      if (Array.isArray(result.protectedEfforts) && result.protectedEfforts.length > 0) {
        messages.push(t('override.referencePreservedEfforts', {
          levels: result.protectedEfforts.map((id) => effortLabel(id, t)).join(' / '),
        }))
      }
      return messages.length > 0 ? messages.join(' · ') : null
    }

    function ModelOverrideEditor({
      entry, revision, hasOverride, blocked, stale, name, t, overrides, onClose, onSaved,
      canMap = false, hasStandard = false, canUseStandard = false, canReferencePrefill = false,
      referenceEfforts = [], referenceSource = '', referenceAlias = false,
    }) {
      const [kind, setKind] = React.useState(entry.kind || '')
      const [context, setContext] = React.useState(
        entry.contextWindow === undefined ? '' : String(entry.contextWindow),
      )
      const [input, setInput] = React.useState(
        () => new Set(Array.isArray(entry.input) ? entry.input : []),
      )
      const [efforts, setEfforts] = React.useState(
        () => new Set((Array.isArray(entry.efforts) ? entry.efforts : []).map((item) => item.id)),
      )
      const [noReasoning, setNoReasoning] = React.useState(entry.reasoningSupported === false)
      const [defaultEffort, setDefaultEffort] = React.useState(
        typeof entry.defaultEffort === 'string' ? entry.defaultEffort : '',
      )
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [applyToProvider, setApplyToProvider] = React.useState(false)
      const [wireValues, setWireValues] = React.useState({})
      const [omitOff, setOmitOff] = React.useState(false)
      const [standardEffort, setStandardEffort] = React.useState(false)
      const [referenceApplied, setReferenceApplied] = React.useState(false)
      const [confirmation, setConfirmation] = React.useState(null)
      const referenceButton = React.useRef(null)
      const saveButton = React.useRef(null)
      const confirmationPreview = React.useRef(null)
      const contextInput = React.useRef(null)
      const returnFocus = React.useRef(null)
      const referencePanel = React.useId()
      const providerPanel = React.useId()

      React.useEffect(() => {
        if (confirmation !== null) confirmationPreview.current?.focus()
        else if (returnFocus.current !== null) {
          returnFocus.current.current?.focus()
          returnFocus.current = null
        }
      }, [confirmation])

      const closeConfirmation = () => {
        returnFocus.current = confirmation === 'reference' ? referenceButton : saveButton
        setConfirmation(null)
      }
      const cancelOnEscape = (event) => {
        if (event.key !== 'Escape' || confirmation === null) return
        event.preventDefault()
        event.stopPropagation()
        closeConfirmation()
      }

      const toggleIn = (setter, id) => {
        setter((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const locked = busy || blocked || stale
      const editingLocked = locked || confirmation !== null
      const fail = (failure) => {
        setBusy(false)
        if (failure?.status === 409) {
          setError(t('override.conflict'))
          void overrides.load()
        } else {
          setError(t('override.failed', { message: String(failure?.message ?? failure) }))
        }
      }

      const availableEfforts = [...new Set([...OVERRIDE_EFFORTS, ...efforts])]
      // Keep the order of a hand-authored ladder. A standalone default must remain selected when filling a ladder.
      const selectedEfforts = [...efforts]
      const suggested = [...new Set((Array.isArray(referenceEfforts) ? referenceEfforts : []).map((item) => item?.id)
        .filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)))]
      const standaloneDefault = selectedEfforts.length === 0 && defaultEffort ? [defaultEffort] : []
      const referenceDraft = [...new Set([...selectedEfforts, ...standaloneDefault, ...suggested])].slice(0, 16)
      const includedReference = suggested.filter((id) => referenceDraft.includes(id))
      const skippedReference = suggested.filter((id) => !referenceDraft.includes(id))
      const levelsOf = (ids) => ids.map((id) => effortLabel(id, t)).join(' / ')
      const providerAllowed = !referenceApplied || canReferencePrefill
      const providerRequested = applyToProvider && providerAllowed
      const canSuggestStandard = canMap && hasStandard && canUseStandard && canReferencePrefill
      const hasStandardChoices = !noReasoning && selectedEfforts.some(isStandardChoice)
      const standardAvailable = hasStandard && canUseStandard && hasStandardChoices
      const fallbackFor = (ids) => ids.filter((id) => isStandardChoice(id) && !wireValues[id]?.trim())
      const mappings = Object.fromEntries(selectedEfforts.filter((id) => OVERRIDE_EFFORTS.includes(id)).flatMap((id) => {
        if (id === 'off' && omitOff) return [[id, null]]
        const value = wireValues[id]?.trim()
        return value ? [[id, value]] : []
      }))

      const applyReference = () => {
        if (locked || noReasoning || confirmation !== 'reference' || includedReference.length === 0) return
        setEfforts(new Set(referenceDraft))
        setReferenceApplied(true)
        if (!canReferencePrefill) setApplyToProvider(false)
        closeConfirmation()
      }

      const save = (confirmed = false) => {
        if (locked || (confirmation !== null && !confirmed)) return
        const contextWindow = context.trim() === '' ? undefined : Number(context)
        if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
          setError(t('override.contextInvalid'))
          contextInput.current?.focus()
          return
        }
        if (referenceApplied && providerRequested && !confirmed) {
          setError(null)
          setConfirmation('provider')
          return
        }
        const payload = { provider: entry.provider, model: entry.model }
        if (kind !== '') payload.kind = kind
        if (contextWindow !== undefined) payload.contextWindow = contextWindow
        if (input.size > 0) {
          payload.input = [...input]
        }
        if (noReasoning) {
          payload.reasoningSupported = false
        } else if (efforts.size > 0) {
          payload.efforts = selectedEfforts.map((id) => ({ id }))
          if (providerRequested && canMap && Object.keys(mappings).length > 0) payload.reasoningEffortMappings = mappings
        }
        if (!noReasoning && defaultEffort !== '' && (efforts.size === 0 || efforts.has(defaultEffort))) {
          payload.defaultEffort = defaultEffort
        }
        payload.applyToProvider = providerRequested
        if (providerRequested && referenceApplied) payload.referencePrefill = true
        if (providerRequested && standardAvailable && standardEffort) payload.standardEffort = true
        setConfirmation(null)
        setBusy(true)
        setError(null)
        overrides.save(payload, revision).then(
          (result) => {
            setBusy(false)
            if (typeof onSaved === 'function') onSaved(result)
          },
          fail,
        )
      }

      const resetToAuto = () => {
        if (locked || !hasOverride) return
        setBusy(true)
        setError(null)
        overrides.remove(entry.provider, entry.model, revision).then(
          (result) => {
            setBusy(false)
            if (typeof onSaved === 'function') onSaved(result)
          },
          fail,
        )
      }

      const kindOptions = [['', t('override.kindAuto')]].concat(
        ['chat', 'image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation'].map(
          (id) => [id, id === 'chat' ? t('page.filter.chat') : t('tag.kind.' + id)],
        ),
      )
      const defaultOptions = [['', t('override.defaultEffortAuto')]].concat(
        (efforts.size === 0 && defaultEffort !== '' ? [defaultEffort] : selectedEfforts).map((id) => [id, effortLabel(id, t)]),
      )
      const selectedDefault = efforts.size === 0 || efforts.has(defaultEffort) ? defaultEffort : ''
      const referenceFallbacks = canSuggestStandard ? fallbackFor(referenceDraft) : []
      const providerFallbacks = standardAvailable && standardEffort ? fallbackFor(selectedEfforts) : []
      const sourceLabel = referenceAlias
        ? t('override.referenceAlias', { source: referenceSource || t('source.unknown') })
        : referenceSource || t('source.unknown')
      const saveLabel = t(providerRequested ? 'override.saveProvider' : 'override.saveLocal')
      const caution = (summary) => h('div', { className: 'mvp_banner mvp_banner--warn' },
        h('div', null, t(summary)),
        h('details', null,
          h('summary', null, t('override.referenceSafeguards')),
          h('div', null, t('override.referencePreservation')),
          h('div', null, t('override.referenceRevert')),
        ),
      )

      return h(
        'div',
        { className: 'mvp_editor', onKeyDown: cancelOnEscape },
        h(
          'div',
          { className: 'mvp_editorHead' },
          h('div', { className: 'mvp_editorTitle' }, t('override.title') + ' · ' + name),
          h('div', { className: 'mvp_editorSub' }, t('override.hint')),
        ),
        h(
          'div',
          { className: 'mvp_editorGrid' },
          h(
            'label',
            { className: 'mvp_field' },
            h('span', { className: 'mvp_fieldLabel' }, t('override.kind')),
            h(
              'select',
              {
                className: 'mvp_select',
                value: kind,
                disabled: editingLocked,
                'aria-label': t('override.kind'),
                onChange: (event) => setKind(event.target.value),
              },
              kindOptions.map(([value, label]) => h('option', { key: value, value }, label)),
            ),
          ),
          h(
            'label',
            { className: 'mvp_field' },
            h('span', { className: 'mvp_fieldLabel' }, t('override.context')),
            h('input', {
              className: 'mvp_number',
              ref: contextInput,
              type: 'number',
              min: '1',
              step: '1',
              value: context,
              disabled: editingLocked,
              placeholder: t('override.contextPlaceholder'),
              'aria-label': t('override.context'),
              onInput: (event) => setContext(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'mvp_field mvp_field--wide' },
            h('span', { className: 'mvp_fieldLabel' }, t('override.input')),
            h(
              'div',
              { className: 'mvp_chips' },
              OVERRIDE_MODALITIES.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'mvp_chip',
                    'aria-pressed': input.has(id),
                    disabled: editingLocked,
                    onClick: () => toggleIn(setInput, id),
                  },
                  modalityLabel(id, t),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'mvp_field mvp_field--wide' },
            h('span', { className: 'mvp_fieldLabel' }, t('override.efforts')),
            suggested.length > 0 ? h('div', null,
              h('button', {
                ref: referenceButton,
                type: 'button', className: 'mvp_button mvp_button--quiet', disabled: editingLocked || noReasoning,
                'aria-expanded': confirmation === 'reference',
                'aria-controls': referencePanel,
                onClick: () => setConfirmation('reference'),
                title: t('override.useReferenceTitle'),
              }, t('override.useReference')),
              h('div', { id: referencePanel, hidden: confirmation !== 'reference' }, confirmation === 'reference' ? h(
                'div', { role: 'group', 'aria-label': t('override.referencePreview') },
                h('div', { ref: confirmationPreview, tabIndex: -1, className: 'mvp_editorTitle' }, t('override.referencePreview')),
                h('div', { className: 'mvp_fieldLabel' }, t('override.referenceSource', { source: sourceLabel })),
                h('div', null, t('override.referenceLevels', { levels: levelsOf(suggested) })),
                h('div', null, t('override.referenceDraft', { levels: levelsOf(referenceDraft) })),
                skippedReference.length > 0 ? h('div', null, t('override.referenceLimit', { levels: levelsOf(skippedReference) })) : null,
                referenceFallbacks.length > 0 ? h('div', null, t('override.referenceFallbacks', { levels: referenceFallbacks.join(' / ') })) : null,
                caution(!canReferencePrefill ? 'override.referenceOldHost' : canSuggestStandard ? 'override.referenceStandardScope' : 'override.referenceManualScope'),
                h('div', { className: 'mvp_editorActions' },
                  h('button', { type: 'button', className: 'mvp_button', onClick: closeConfirmation }, t('override.cancelReference')),
                  h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: locked || noReasoning || includedReference.length === 0, onClick: applyReference }, t('override.confirmReference')),
                ),
              ) : null),
              h('div', { role: 'status', className: 'mvp_editorNote' }, referenceApplied ? t('override.referenceApplied') : ''),
            ) : null,
            h(
              'div',
              { className: 'mvp_chips' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_chip',
                  'aria-pressed': noReasoning,
                  disabled: editingLocked,
                  onClick: () => { setNoReasoning((value) => !value); setStandardEffort(false) },
                },
                t('tag.noReasoning'),
              ),
              availableEfforts.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'mvp_chip',
                    'aria-pressed': !noReasoning && efforts.has(id),
                    disabled: editingLocked || noReasoning,
                    onClick: () => { toggleIn(setEfforts, id); setStandardEffort(false) },
                  },
                  effortLabel(id, t),
                ),
              ),
            ),
          ),
          !noReasoning && (efforts.size > 0 || defaultEffort !== '')
            ? h(
                'label',
                { className: 'mvp_field' },
                h('span', { className: 'mvp_fieldLabel' }, t('override.defaultEffort')),
                h(
                  'select',
                  {
                    className: 'mvp_select',
                    value: selectedDefault,
                    disabled: editingLocked,
                    'aria-label': t('override.defaultEffort'),
                    onChange: (event) => setDefaultEffort(event.target.value),
                  },
                  defaultOptions.map(([value, label]) => h('option', { key: value, value }, label)),
                ),
              )
            : null,
          canMap && (providerRequested || (referenceApplied && canSuggestStandard)) && !noReasoning && selectedEfforts.some((id) => OVERRIDE_EFFORTS.includes(id))
            ? h(
                'div',
                { className: 'mvp_field mvp_field--wide' },
                h('div', { className: 'mvp_fieldLabel' }, t('override.wireTitle')),
                h('div', { className: 'mvp_editorNote' }, t('override.wireHint')),
                h('div', { className: 'mvp_chips' }, selectedEfforts.filter((id) => OVERRIDE_EFFORTS.includes(id)).map((id) => {
                  const label = t('override.wireValue', { level: effortLabel(id, t) })
                  return h('label', { className: 'mvp_field', key: id },
                    h('span', { className: 'mvp_fieldLabel' }, label),
                    h('input', {
                      className: 'mvp_number', type: 'text', 'aria-label': label,
                      value: wireValues[id] ?? '', maxLength: 128,
                      placeholder: referenceApplied && canSuggestStandard && isStandardChoice(id)
                        ? t('override.referenceWireBlank', { value: id }) : t('override.wireKeep'),
                      disabled: editingLocked || !providerRequested || (id === 'off' && omitOff),
                      onChange: (event) => {
                        const value = event.target.value
                        setWireValues((previous) => ({ ...previous, [id]: value }))
                        if (!referenceApplied) setStandardEffort(false)
                      },
                    }),
                  )
                })),
                efforts.has('off') ? h('label', { className: 'mvp_check' },
                  h('input', { type: 'checkbox', checked: omitOff, disabled: editingLocked || !providerRequested, onChange: (event) => { setOmitOff(event.target.checked); if (!referenceApplied) setStandardEffort(false) } }),
                  t('override.wireOff'),
                ) : null,
              )
            : null,
          h(
            'div',
            { className: 'mvp_field mvp_field--wide' },
            h(
              'label',
              { className: 'mvp_check' },
              h('input', {
                type: 'checkbox',
                checked: providerRequested,
                disabled: editingLocked || !providerAllowed,
                onChange: (event) => { setApplyToProvider(event.target.checked); setStandardEffort(false) },
              }),
              h('span', null, t('override.provider')),
            ),
            h('div', { className: 'mvp_editorNote' }, t('override.providerHint')),
            !providerAllowed ? h('div', { className: 'mvp_editorNote' }, t('override.referenceOldHost')) : null,
            standardAvailable && providerRequested ? h('label', { className: 'mvp_check' },
              h('input', { type: 'checkbox', checked: standardEffort, disabled: editingLocked,
                onChange: (event) => setStandardEffort(event.target.checked) }),
              h('span', null, t('override.standardWire')),
            ) : null,
            hasStandard && hasStandardChoices && providerRequested
              ? h('div', { className: 'mvp_editorNote' }, t(standardAvailable ? 'override.standardWireHint' : 'override.standardWireUnavailable')) : null,
          ),
        ),
        stale || error !== null
          ? h('div', { className: 'mvp_editorError', role: 'alert' }, stale ? t('override.conflict') : error) : null,
        h(
          'div',
          { className: 'mvp_editorFooter' },
          h('div', { className: 'mvp_editorNote' }, t('override.effortHint')),
          h('div', { id: providerPanel, className: 'mvp_field--wide', hidden: confirmation !== 'provider' }, confirmation === 'provider' ? h(
            'div', { role: 'group', 'aria-label': t('override.providerConfirmTitle') },
            h('div', { ref: confirmationPreview, tabIndex: -1, className: 'mvp_editorTitle' }, t('override.providerConfirmTitle')),
            h('div', null, t('override.providerTarget', { provider: entry.provider, model: entry.model })),
            context.trim() !== '' ? h('div', null, t('override.providerContext', { value: Number(context) })) : null,
            input.size > 0 ? h('div', null, t('override.providerInput', { value: [...input].map((id) => modalityLabel(id, t)).join(' / ') })) : null,
            !noReasoning && selectedEfforts.length > 0 ? h('div', null, t('override.referenceDraft', { levels: levelsOf(selectedEfforts) })) : null,
            noReasoning ? h('div', null, t('override.providerDisableReasoning')) : null,
            !noReasoning && canMap && Object.keys(mappings).length > 0 ? h('div', null, t('override.providerMappings', {
              values: Object.entries(mappings).map(([id, wire]) => `${effortLabel(id, t)} → ${wire ?? t('override.providerOmit')}`).join(' / '),
            })) : null,
            !noReasoning && selectedDefault !== '' ? h('div', null, t('override.providerLocalDefault', { value: effortLabel(selectedDefault, t) })) : null,
            providerFallbacks.length > 0 ? h('div', null, t('override.referenceFallbacks', { levels: providerFallbacks.join(' / ') })) : null,
            standardAvailable && standardEffort ? h('div', null, t('override.providerStandardEnable')) : null,
            caution('override.referenceProviderScope'),
            h('div', { className: 'mvp_editorActions' },
              h('button', { type: 'button', className: 'mvp_button', onClick: closeConfirmation }, t('override.backToDraft')),
              h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: locked || !providerRequested, onClick: () => save(true) }, t('override.confirmProviderSave')),
            ),
          ) : null),
          h(
            'div',
            { className: 'mvp_editorActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'mvp_button',
                disabled: editingLocked || !hasOverride,
                title: t('override.resetTitle'),
                onClick: resetToAuto,
              },
              t('override.reset'),
            ),
            h(
              'button',
              { type: 'button', className: 'mvp_button', disabled: busy || confirmation !== null, onClick: onClose },
              t('override.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mvp_button mvp_button--accent',
                ref: saveButton,
                disabled: editingLocked,
                'aria-expanded': referenceApplied && providerRequested ? confirmation === 'provider' : undefined,
                'aria-controls': referenceApplied && providerRequested ? providerPanel : undefined,
                onClick: () => save(),
              },
              busy ? t('override.saving') : saveLabel,
            ),
          ),
        ),
      )
        }

    exports.ModelOverrideEditor = ModelOverrideEditor
    exports.providerWriteNote = providerWriteNote


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

    /** Checker-model candidates from a loaded catalog state. */
    function checkerRoutesOf(groups) {
      const routes = []
      for (const group of groups ?? []) {
        if (group === null || typeof group !== 'object') continue
        const models = Array.isArray(group.models) ? group.models : []
        if (models.length > 0) routes.push({ id: group.id, name: group.name ?? group.id })
      }
      return routes
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
    exports.checkerRoutesOf = checkerRoutesOf
    exports.probeOf = probeOf
  })

  // -------------------------------------------------------- settings-section
  define("settings-section", function (require, module, exports) {
    const React = require('react')
    const h = React.createElement

    const { FIELD } = require("constants")
    const { keyOf, kindOf, isGenerationKind, providerLabel, countModels, sourceOf, sourceLabel, readCollapsedGroups, persistCollapsedGroups } = require("format")
    const { overrideIdentity } = require("catalog-store")
    const { computeFilteredGroups, countKinds, probeOf } = require("pure")
    const { capabilityTags, tagClassOf } = require("tags")
    const { ModelOverrideEditor, providerWriteNote } = require("override-editor")
    const { useHidden, useSource } = require("hooks")
    const { UsageToolbar } = require("usage-view")
    const { VerifyPanel } = require("checker-view")

    /** Browser-local key for the "about this page" disclosure. */
    const ABOUT_KEY = 'dsh-model-visibility:about-open:v1'

    function readAboutOpen() {
      try {
        return window.localStorage.getItem(ABOUT_KEY) === '1'
      } catch (_error) {
        return false
      }
    }

    function persistAboutOpen(open) {
      try {
        window.localStorage.setItem(ABOUT_KEY, open ? '1' : '0')
      } catch (_error) {
        // Storage is optional for a preference like this.
      }
    }

    /**
     * The settings page.
     *
     * Layout, in the order a user needs it: a one-line summary with the two
     * primary actions, the token strip, the filter bar, the models, then the
     * diagnostics — and behind a disclosure the long explanation that used to
     * occupy a third of the viewport before the first model row.
     */
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
        const [aboutOpen, setAboutOpen] = React.useState(readAboutOpen)
        const [editing, setEditing] = React.useState(null)
        const [providerNote, setProviderNote] = React.useState(null)
        const editTrigger = React.useRef(null)

        const closeEditor = () => setEditing(null)
        React.useEffect(() => {
          if (editing === null && editTrigger.current !== null) {
            editTrigger.current.focus()
            editTrigger.current = null
          }
        }, [editing])

        React.useEffect(() => {
          catalog.load()
          overrides.load()
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        const catalogMeta = state.learned && typeof state.learned === 'object' ? state.learned : null
        const hostFeatures =
          catalogMeta && Array.isArray(catalogMeta.features) ? catalogMeta.features : []
        const supportsOverrides = state.source === 'host' && hostFeatures.includes('overrides')
        const overridesReady = overrideState.status === 'ready' && overrideState.available === true
        const canOpenEditor = state.status === 'ready' && supportsOverrides && overridesReady && !overrideState.pending && !overrideState.refreshing
        const hostFeaturesKnown = state.source === 'host' && Array.isArray(catalogMeta?.features)
        const canSetSourceMode = hostFeatures.includes('verifySourceModes')
        const supportsVerify = canSetSourceMode || hostFeatures.includes('verifyWeb')
        const canVerify = hostFeaturesKnown && state.status === 'ready' && supportsVerify
        const verifyState = verify.getSnapshot()
        const observeVerify = !hostFeaturesKnown || hostFeatures.includes('verify') || supportsVerify ||
          verifyState.snapshot?.state?.running === true || verifyState.pending
        const overrideEntries = new Map(overrideState.entries.map((entry) => [overrideIdentity(entry.provider, entry.model), entry]))

        const writable = snapshot.writable !== false
        const groups = state.groups
        const total = countModels(groups)
        const hiddenCount = groups.reduce(
          (count, group) =>
            count +
            (group.models || []).filter((model) => hidden.has(keyOf(group.id, model.id))).length,
          0,
        )
        const allKinds = countKinds(groups.flatMap((group) => group.models || []))
        const generationCount = allKinds.image + allKinds.video
        const [filter, setFilter] = React.useState('all')
        const [visibility, setVisibility] = React.useState('all')
        const [query, setQuery] = React.useState('')
        const [multimodalOnly, setMultimodalOnly] = React.useState(false)
        const [reasoningOnly, setReasoningOnly] = React.useState(false)
        const [minContext, setMinContext] = React.useState(0)
        const normalizedQuery = query.trim().toLowerCase()
        const hasActiveFilters =
          filter !== 'all' || visibility !== 'all' || normalizedQuery !== '' || multimodalOnly || reasoningOnly || minContext > 0
        const filteredGroups = computeFilteredGroups(groups, {
          filter,
          visibility,
          hidden,
          query: normalizedQuery,
          multimodalOnly,
          reasoningOnly,
          minContext,
        })
        const disabled = busy || !writable

        const writeField = (field, value) => {
          if (disabled) return
          setBusy(true)
          setError(null)
          Promise.resolve(form.set(field, value))
            .then(
              (accepted) => {
                if (accepted === false) setError(t('page.saveFailed'))
              },
              () => {
                setError(t('page.saveFailed'))
              },
            )
            .finally(() => {
              setBusy(false)
            })
        }

        const commit = (next) => writeField(FIELD, Array.from(next))
        const applyInput = !(snapshot.value && snapshot.value.applyInput === false)
        const commitApply = (next) => writeField('applyInput', next)

        const toggleModel = (group, model) => {
          const next = new Set(hidden)
          const key = keyOf(group.id, model.id)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          commit(next)
        }

        const setGroup = (group, subset, visible) => {
          const next = new Set(hidden)
          for (const model of subset) {
            const key = keyOf(group.id, model.id)
            if (visible) next.delete(key)
            else next.add(key)
          }
          commit(next)
        }

        const runCatalogAction = (action, setActive) => {
          setActive(true)
          Promise.resolve()
            .then(action)
            .catch(() => {})
            .finally(() => setActive(false))
        }

        const refreshCatalog = () => {
          if (refreshing || reloading) return
          runCatalogAction(() => catalog.refresh(), setRefreshing)
        }

        // A hard reload may supersede a soft refresh that is still running;
        // catalog.load() gives it a new run and discards the older result.
        const reloadCatalog = () => {
          if (busy || reloading) return
          setRefreshing(false)
          runCatalogAction(() => { void overrides.load(); return catalog.reload() }, setReloading)
        }

        const toggleGroupCollapsed = (id) => {
          setCollapsed((previous) => {
            const next = new Set(previous)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            persistCollapsedGroups(next)
            return next
          })
        }

        const toggleAllCollapsed = () => {
          setCollapsed((previous) => {
            const collapsedNow = groups.some((group) => previous.has(group.id))
            const next = collapsedNow ? new Set() : new Set(groups.map((group) => group.id))
            persistCollapsedGroups(next)
            return next
          })
        }

        const toggleAbout = () => {
          setAboutOpen((previous) => {
            persistAboutOpen(!previous)
            return !previous
          })
        }

        /* ------------------------------------------------------------- groups */

        const rows = []
        for (const group of filteredGroups) {
          const allGroupModels =
            (groups.find((candidate) => candidate.id === group.id) || group).models || []
          const models = group.models || []
          const shown = allGroupModels.filter((model) => !hidden.has(keyOf(group.id, model.id))).length
          const allShown = models.every((model) => !hidden.has(keyOf(group.id, model.id)))
          const kinds = countKinds(allGroupModels)
          const kindParts = []
          if (kinds.chat > 0) kindParts.push('chat')
          if (kinds.image > 0) kindParts.push('image')
          if (kinds.video > 0) kindParts.push('video')
          if (kinds.other > 0) kindParts.push('other')
          const kindNodes = []
          for (const [index, kindKey] of kindParts.entries()) {
            if (index > 0) kindNodes.push(h('span', { key: 'sep-' + kindKey, className: 'mvp_sep' }, '·'))
            kindNodes.push(
              h(
                'span',
                {
                  key: kindKey,
                  className:
                    'mvp_kindCount' +
                    (kindKey === 'chat' ? '' : ' mvp_kindCount--' + kindKey),
                  title: t('page.filter.' + kindKey) + ' ' + kinds[kindKey],
                },
                kinds[kindKey],
              ),
            )
          }
          const groupName = providerLabel(group, t)
          const collapsedNow = collapsed.has(group.id)
          const collapseLabel = t(collapsedNow ? 'group.expandNamed' : 'group.collapseNamed', {
            name: groupName,
          })
          const probe = probeOf(state, group, t)
          rows.push(
            h(
              'div',
              { key: group.id, className: 'mvp_group' },
              h(
                'div',
                { className: 'mvp_groupHead' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mvp_groupTitle',
                    'aria-expanded': !collapsedNow,
                    'aria-label': collapseLabel,
                    title: collapseLabel,
                    onClick: () => toggleGroupCollapsed(group.id),
                  },
                  h('span', { className: 'mvp_chevron' }, collapsedNow ? '▸' : '▾'),
                  h('span', { className: 'mvp_groupName' }, groupName),
                  h('span', { className: 'mvp_groupCount', title: t('group.enabledCount') }, shown + '/' + allGroupModels.length),
                  kindParts.length > 0
                    ? h('span', { className: 'mvp_groupCap' }, kindNodes)
                    : null,
                  probe !== null
                    ? h(
                        'span',
                        {
                          className: 'mvp_groupProbe' + (probe.failed === true ? ' mvp_groupProbe--warn' : ''),
                          title: probe.title || undefined,
                        },
                        probe.label,
                      )
                    : null,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mvp_button mvp_button--quiet',
                    disabled: disabled,
                    onClick: () => setGroup(group, models, !allShown),
                  },
                  allShown
                    ? t(hasActiveFilters ? 'group.hideFiltered' : 'group.hideAll')
                    : t(hasActiveFilters ? 'group.showFiltered' : 'group.showAll'),
                ),
              ),
              collapsedNow
                ? null
                : models.map((model) => {
                  const rowKey = keyOf(group.id, model.id)
                  const overrideId = overrideIdentity(group.id, model.id)
                  const currentRevision = overrideState.revisions?.get(overrideId) ?? null
                  const isEditing = editing?.id === overrideId
                  const shownModel = !hidden.has(rowKey)
                  const tags = capabilityTags(model, t)
                  const kind = kindOf(model)
                  const generation = isGenerationKind(kind)
                  const kindTint =
                    kind !== 'chat' &&
                    ['image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation'].includes(kind)
                      ? ' mvp_row--kind-' + kind
                      : ''
                  const row = h(
                    'div',
                    {
                      className:
                        'mvp_row' +
                        (generation ? ' mvp_row--gen' : '') +
                        (shownModel ? '' : ' mvp_row--off') +
                        kindTint,
                    },
                    h(
                      'div',
                      { className: 'mvp_rowText' },
                      h(
                        'div',
                        { className: 'mvp_rowHead' },
                        h('span', { className: 'mvp_rowTitle' }, model.name),
                        model.id === model.name
                          ? null
                          : h('span', { className: 'mvp_rowMeta' }, model.id),
                      ),
                      h(
                        'div',
                        { className: 'mvp_tags' },
                        tags.map((tag) =>
                          h(
                            'span',
                            {
                              key: tag.key,
                              className: tagClassOf(tag),
                              title: tag.title || undefined,
                            },
                            tag.label,
                          ),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'mvp_rowActions' },
                      supportsOverrides && overrideState.available !== false
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'mvp_button mvp_button--quiet mvp_editButton',
                              'aria-pressed': isEditing,
                              'aria-label': t('row.edit') + ': ' + model.name,
                              title: t(canOpenEditor || isEditing ? 'row.editTitle' : 'override.listNotReady'),
                              disabled: busy || overrideState.pending || (!canOpenEditor && !isEditing),
                              onClick: (event) => {
                                if (isEditing) closeEditor()
                                else if (canOpenEditor) {
                                  editTrigger.current = event?.currentTarget ?? null
                                  setEditing({ id: overrideId, revision: currentRevision,
                                    entry: overrideEntries.get(overrideId) ?? { provider: group.id, model: model.id } })
                                }
                              },
                            },
                            t('row.edit'),
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'switch',
                          className: 'mvp_switch',
                          'aria-checked': shownModel,
                          'aria-label': model.name,
                          disabled: disabled,
                          onClick: () => toggleModel(group, model),
                        },
                        h('span', { className: 'mvp_thumb' }),
                      ),
                    ),
                  )
                  const editor =
                    supportsOverrides && isEditing
                      ? h(ModelOverrideEditor, {
                          key: 'editor',
                          entry: editing.entry,
                          revision: editing.revision,
                          hasOverride: editing.revision !== null,
                          stale: overridesReady && currentRevision !== editing.revision,
                          blocked: !overridesReady || overrideState.pending || state.status !== 'ready',
                          name: model.name,
                          t,
                          overrides,
                          canMap: hostFeatures.includes('reasoningMappings'),
                          hasStandard: hostFeatures.includes('standardEffort'),
                          canUseStandard: model.standardEffort === true,
                          canReferencePrefill: hostFeatures.includes('referencePrefill'),
                          referenceEfforts: kind === 'chat' ? model.referenceReasoning?.efforts ?? model.reasoning?.efforts : [],
                          referenceSource: model.referenceReasoning
                            ? model.referenceReasoningSource === 'snapshot' || !model.referenceReasoningSource
                              ? sourceLabel('snapshot', t) : model.referenceReasoningSource
                            : model.reasoningCatalog ?? sourceLabel(sourceOf(model, 'reasoning'), t),
                          referenceAlias: Boolean(model.learned?.publicAlias),
                          onClose: closeEditor,
                          onSaved: (result) => {
                            setEditing((active) => active?.id === overrideId ? null : active)
                            const message = providerWriteNote(result?.provider, t)
                            setProviderNote(message === null ? null : { rowKey, message })
                            void catalog.afterChange()
                          },
                        })
                      : null
                  const note = providerNote?.rowKey === rowKey
                    ? h('div', { className: 'mvp_note', role: 'status' }, providerNote.message) : null
                  return h(React.Fragment, { key: model.id }, row, editor, note)
                }),
            ),
          )
        }

        /* ------------------------------------------------------------- status */

        const loading = state.status === 'loading' || state.status === 'idle'
        const providerList = Array.isArray(state.providers) ? state.providers : []
        const probeOk = providerList.filter(
          (provider) => provider && (provider.status === 'ok' || provider.status === 'partial'),
        ).length
        const probeCaps = providerList.reduce(
          (count, provider) => count + (Number(provider && provider.capabilities) || 0),
          0,
        )
        const probeNote =
          state.source === 'host'
            ? providerList.length > 0
              ? t('page.probeSummary', { ok: probeOk, caps: probeCaps })
              : t('page.probeSummaryNone')
            : null
        const hostStale = state.source === 'host' && !hostFeatures.includes('applyInput')
        const canReload = state.source === 'host' && hostFeatures.includes('reload')
        const anyCollapsed = groups.some((group) => collapsed.has(group.id))
        const learnedDate =
          catalogMeta && Number.isFinite(catalogMeta.updatedAt)
            ? catalogMeta.updatedAt > 0
              ? new Date(catalogMeta.updatedAt).toISOString().slice(0, 10)
              : null
            : null
        const catalogNote =
          catalogMeta !== null
            ? t('page.learnedNote', {
                models: catalogMeta.models ?? 0,
                date: learnedDate || '?',
              })
            : null
        const filterOptions = [
          ['all', t('page.filter.all'), total],
          ['chat', t('page.filter.chat'), allKinds.chat],
          ['image', t('page.filter.image'), allKinds.image],
          ['video', t('page.filter.video'), allKinds.video],
          ['other', t('page.filter.other'), allKinds.other],
        ]
        // A relay that answered with a diagnostic is worth surfacing next to the
        // group, but only failed routes belong in the page-level warning list.
        const failedRoutes = providerList.filter(
          (provider) => provider && (provider.status === 'failed' || provider.status === 'unauthorized'),
        )
        const summaryText =
          total === 0
            ? loading
              ? t('page.loading')
              : t('page.empty')
            : t('page.summary', { visible: total - hiddenCount, total })

        /* ------------------------------------------------------------- render */

        return h(
          'div',
          { className: 'mvp_page' },
          // Title + summary + the two actions that are worth a permanent slot.
          h(
            'div',
            { className: 'mvp_head' },
            h(
              'div',
              { className: 'mvp_headMain' },
              h('h2', { className: 'mvp_title' }, t('page.title')),
              h('span', { className: 'mvp_summary' }, summaryText),
              hasActiveFilters && total > 0
                ? h('span', { className: 'mvp_summary mvp_summary--dim' }, t('page.matchCount', { count: countModels(filteredGroups) }))
                : null,
              hiddenCount > 0
                ? h('span', { className: 'mvp_summary mvp_summary--dim' }, t('page.hiddenSummary', { count: hiddenCount }))
                : null,
              generationCount > 0
                ? h('span', { className: 'mvp_summary mvp_summary--dim' }, t('page.kindSummary', { count: generationCount }))
                : null,
            ),
            h(
              'div',
              { className: 'mvp_headActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button mvp_button--quiet',
                  'aria-pressed': aboutOpen,
                  title: t('page.aboutTitle'),
                  onClick: toggleAbout,
                },
                t('page.about') + (aboutOpen ? ' ▴' : ' ▾'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button',
                  disabled: busy || refreshing || reloading,
                  title: t('page.refreshTitle'),
                  onClick: refreshCatalog,
                },
                t(refreshing ? 'page.refreshing' : 'page.refresh'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button mvp_button--accent',
                  disabled: !canReload || busy || reloading,
                  title: t(canReload ? 'page.reloadTitle' : 'page.reloadUnavailable'),
                  onClick: reloadCatalog,
                },
                t(reloading ? 'page.reloading' : 'page.reload'),
              ),
            ),
          ),
          aboutOpen
            ? h(
                'div',
                { className: 'mvp_about' },
                h('p', { className: 'mvp_aboutP' }, t('page.description')),
                h('p', { className: 'mvp_aboutP' }, t('page.legend')),
                h('p', { className: 'mvp_aboutP' }, t('page.kindLegend')),
                h('p', { className: 'mvp_aboutP' }, t('page.manualNote')),
              )
            : null,
          hostFeaturesKnown && !hostFeatures.includes('usage')
            ? h('div', { className: 'mvp_usage mvp_usage--off' }, t('usage.hostStale'))
            : h(UsageToolbar, { usage, t, features: hostFeatures }),
          h(
            'div',
            { className: 'mvp_filters' },
            h('input', {
              className: 'mvp_searchInput',
              type: 'search',
              value: query,
              placeholder: t('page.searchPlaceholder'),
              'aria-label': t('page.searchPlaceholder'),
              onInput: (event) => setQuery(event.target.value),
            }),
            h(
              'div',
              { className: 'mvp_filterGroup' },
              filterOptions.map(([value, label, count]) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: 'mvp_filter',
                    'aria-pressed': filter === value,
                    onClick: () => setFilter(value),
                  },
                  label + ' ' + count,
                ),
              ),
            ),
            h(
              'select',
              {
                className: 'mvp_contextSelect',
                value: visibility,
                'aria-label': t('page.visibility.label'),
                title: t('page.visibility.label'),
                onChange: (event) => setVisibility(event.target.value),
              },
              ['all', 'enabled', 'disabled'].map((value) =>
                h('option', { key: value, value }, t('page.visibility.' + value)),
              ),
            ),
            h(
              'div',
              { className: 'mvp_filterGroup' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_filter',
                  'aria-pressed': multimodalOnly,
                  title: t('page.capability.multimodalTitle'),
                  onClick: () => setMultimodalOnly(!multimodalOnly),
                },
                t('page.capability.multimodal'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_filter',
                  'aria-pressed': reasoningOnly,
                  title: t('page.capability.reasoningTitle'),
                  onClick: () => setReasoningOnly(!reasoningOnly),
                },
                t('page.capability.reasoning'),
              ),
              h(
                'select',
                {
                  className: 'mvp_contextSelect',
                  value: String(minContext),
                  'aria-label': t('page.contextLabel'),
                  title: t('page.contextLabel'),
                  onChange: (event) => setMinContext(Number(event.target.value)),
                },
                [
                  [0, 'page.context.any'],
                  [128000, 'page.context.128k'],
                  [256000, 'page.context.256k'],
                  [512000, 'page.context.512k'],
                  [1000000, 'page.context.1m'],
                ].map(([value, label]) => h('option', { key: value, value: String(value) }, t(label))),
              ),
            ),
            h(
              'div',
              { className: 'mvp_filterGroup mvp_filterGroup--push' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button mvp_button--quiet',
                  disabled: disabled || hiddenCount === 0,
                  title: t('page.showAllTitle'),
                  onClick: () => commit(new Set()),
                },
                t('page.showAll'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button mvp_button--quiet',
                  disabled: groups.length === 0,
                  title: t(anyCollapsed ? 'page.expandGroupsTitle' : 'page.collapseGroupsTitle'),
                  onClick: toggleAllCollapsed,
                },
                t(anyCollapsed ? 'page.expandGroups' : 'page.collapseGroups'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'mvp_applyRow' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'mvp_switch',
                'aria-checked': applyInput,
                'aria-label': t('page.applyInput'),
                'aria-describedby': 'mvp-apply-hint',
                disabled: disabled,
                onClick: () => commitApply(!applyInput),
              },
              h('span', { className: 'mvp_thumb' }),
            ),
            h(
              'div',
              { className: 'mvp_applyText' },
              h('span', { className: 'mvp_applyTitle' }, t('page.applyInput')),
              h('span', { className: 'mvp_applyHint', id: 'mvp-apply-hint' }, t('page.applyInputShort')),
            ),
          ),
          failedRoutes.length > 0
            ? h(
                'div',
                {
                  className: 'mvp_banner mvp_banner--warn',
                  title: failedRoutes
                    .map((route) => (route.name || route.id) + ': ' + (route.message || route.status))
                    .join('\n'),
                },
                t('page.probeFailures', {
                  names: failedRoutes.map((route) => route.name || route.id).join(' · '),
                }),
              )
            : null,
          hostStale ? h('div', { className: 'mvp_banner' }, t('page.hostStale')) : null,
          state.detailsError !== null && state.source === 'catalog'
            ? h('div', { className: 'mvp_banner', title: state.detailsError }, t('page.metaFallback'))
            : null,
          state.failures.length > 0
            ? h(
                'div',
                {
                  className: 'mvp_banner mvp_banner--warn',
                  title: state.failures
                    .map((failure) => (failure.name || failure.id) + ': ' + failure.message)
                    .join('\n'),
                },
                t('page.providerFailures', {
                  names: state.failures
                    .map((failure) => failure.name || failure.id)
                    .join(' · '),
                }),
              )
            : null,
          supportsOverrides && overrideState.available === false
            ? h('div', { className: 'mvp_banner' }, t('override.unavailable'))
            : null,
          supportsOverrides && overrideState.status === 'error'
            ? h('div', { className: 'mvp_banner mvp_banner--warn', role: 'alert' },
                t('override.listFailed', { message: overrideState.error }), ' ',
                h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: () => { void overrides.load() } }, t('override.retryList')))
            : null,
          error !== null ? h('div', { className: 'mvp_banner mvp_banner--error', role: 'alert' }, error) : null,
          state.error !== null
            ? h(
                'div',
                { className: 'mvp_banner mvp_banner--error', role: 'alert' },
                t('page.error', { message: state.error }),
              )
            : null,
          h('div', { className: 'mvp_groups' }, rows),
          total > 0 && hasActiveFilters && rows.length === 0
            ? h('div', { className: 'mvp_note' }, t('page.filterEmpty'))
            : null,
          rows.length === 0 && !loading && state.error === null && total === 0
            ? h('div', { className: 'mvp_note' }, t('page.empty'))
            : null,
          h(
            'div',
            { className: 'mvp_footer' },
            probeNote !== null
              ? h('span', { className: 'mvp_footerItem', title: t('page.probeSummaryTitle') }, probeNote)
              : null,
            catalogNote !== null ? h('span', { className: 'mvp_footerItem' }, catalogNote) : null,
          ),
          observeVerify ? h(VerifyPanel, {
            verify,
            catalog: state,
            t,
            canUse: canVerify,
            onFinished: catalog.afterChange,
            canFullScan: canVerify && hostFeatures.includes('verifyFullScan'),
            canSetMode: hostFeatures.includes('verifyModes'),
            canSetSourceMode,
          }) : h('div', { className: 'mvp_banner' }, t('checker.hostStale')),
        )
      }
    }

    exports.makeSection = makeSection

  })

  // -------------------------------------------------------- tags
  define("tags", function (require, module, exports) {
    const { kindOf, sourceOf, sourceLabel, isInferredSource, formatContext, effortNames, defaultEffortName, modalityNames, modalityLabel, resolutionOf, manualFieldsOf } = require("format")

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
      return tags
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
      if (model.learned?.publicAlias) {
        tags.push({ key: 'public-alias', tone: 'muted', inferred: true,
          label: t('tag.aliasReference'), title: t('tag.aliasReferenceTitle') })
      }
      if (referenceLevels.length > 0 && !sameLadder) {
        tags.push({ key: 'reference-effort', tone: 'muted', inferred: true,
          label: t(model.reasoningCatalog ? 'tag.effortPublicReference' : 'tag.effortReference') + ' ' + referenceLevels.join('/'),
          title: t('tag.effortReferenceTitle', { source: model.reasoningCatalog ?? sourceLabel(reasoningSource, t) }) })
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
      return tags
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
    const { formatTokens } = require("pure")
    const { useSource } = require("hooks")

    /** Total of one bucket tuple (input + output + cache read + cache write). */
    function totalOf(range) {
      if (!Array.isArray(range)) return 0
      return range.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
    }

    /** Detail line for one window: input / output / cache split. */
    function detailOf(range, t) {
      if (!Array.isArray(range) || totalOf(range) === 0) return t('usage.none')
      const input = (range[0] ?? 0) + (range[2] ?? 0) + (range[3] ?? 0)
      const output = range[1] ?? 0
      return t('usage.detail', {
        input: formatTokens(input),
        output: formatTokens(output),
        cacheRead: formatTokens(range[2] ?? 0),
        cacheWrite: formatTokens(range[3] ?? 0),
      })
    }

    /** Download only a successful CSV response, not a Host JSON error document. */
    async function download(type) {
      const response = await fetch(API + '/export?type=' + type, {
        headers: { accept: 'text/csv' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      })
      if (!response.ok) {
        let detail = ''
        try { detail = (await response.json())?.error?.message ?? '' } catch (_error) { /* status is enough */ }
        throw new Error('HTTP ' + response.status + (detail ? ': ' + detail : ''))
      }
      if (!/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected a CSV response.')
      const filename = /filename="([A-Za-z0-9_.-]+\.csv)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
      const href = URL.createObjectURL(await response.blob())
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

    function UsageToolbar({ usage, t, features }) {
      const state = useSource(usage)
      const supported = features.length === 0 || features.includes('usage')
      const ranges = state.snapshot?.ranges
      const computing = state.snapshot?.computing === true
      const scanError = state.snapshot?.error
      const [exporting, setExporting] = React.useState(null)
      const [exportError, setExportError] = React.useState(null)

      const startExport = (type) => {
        if (exporting !== null) return
        setExporting(type)
        setExportError(null)
        void download(type).catch((error) => setExportError(String(error?.message ?? error)))
          .finally(() => setExporting(null))
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

      return h(
        'div',
        { className: 'mvp_usage' },
        h(
          'span',
          { className: 'mvp_usageLabel' },
          t('usage.title'),
          computing ? h('span', { className: 'mvp_usageComputing', role: 'status' }, t('usage.computing')) : null,
        ),
        h(
          'span',
          { className: 'mvp_usageRanges' },
          windows.map(([key, labelKey, titleKey]) => {
            const range = ranges?.[key]
            const total = totalOf(range)
            // Zero from a cold or failed scan isn't yet a confirmed zero.
            const known = Array.isArray(range) && (total > 0 || (!computing && !scanError && !state.error))
            return h(
              'span',
              {
                key,
                className: 'mvp_stat' + (key === 'total' ? ' mvp_stat--total' : ''),
                title: t(titleKey) + '\n' + detailOf(range, t),
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
        exporting !== null ? h('span', { className: 'mvp_usageHint', role: 'status' },
          t(exporting === 'usage' ? 'usage.exportingUsage' : 'usage.exportingModels')) : null,
        (state.error || scanError) ? h('span', { className: 'mvp_usageHint mvp_usageHint--warn', role: 'alert' },
          t('usage.readFailed', { message: state.error || scanError })) : null,
        exportError !== null ? h('span', { className: 'mvp_usageHint mvp_usageHint--warn', role: 'alert' },
          t('usage.exportFailed', { message: exportError })) : null,
      )
    }


    exports.UsageToolbar = UsageToolbar
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
    const { CSS } = require("css")
    const { createCatalog, createOverrides, createUsageApi, createVerifyApi } = require("catalog-store")
    const { makeSection } = require("settings-section")
    const { installComposerFilter } = require("composer-filter")

    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'model-visibility: dictionaries')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-model-visibility'
        tag.textContent = CSS
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
            catalog.afterChange()
            overrides.load()
            usage.refresh()
            verify.load()
          }),
        )
        if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
          for (const event of ['llm/adapters-updated', 'llm/models-updated']) {
            disposers.push(ctx.remote.$on(event, () => { void catalog.afterChange() }))
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
                void catalog.afterChange({ fresh: false })
              }),
            )
          }
        }
        return () => {
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
