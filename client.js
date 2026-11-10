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

    function createCatalog(ctx) {
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
    function createOverrides() {
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
      let state = { status: 'idle', snapshot: null, error: null }
      let inflight = null
      let timer = null
      /** Cadence the armed timer currently runs at, so rearm can compare. */
      let timerMs = null

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
      /** Re-arm the timer at the cadence the *current* snapshot needs. */
      const rearm = () => {
        // Never arm a timer nobody will observe: a bare `load()` (a test, an
        // explicit refresh) must not leave an interval holding the page alive.
        if (listeners.size === 0) {
          stopTimer()
          return
        }
        const wantFast = state.snapshot?.state?.running === true
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
        start(payload) {
          return post(payload).then(
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
        cancel() {
          return post({ cancel: true }).then(
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
      }
    }


    exports.createCatalog = createCatalog
    exports.createOverrides = createOverrides
    exports.createUsageApi = createUsageApi
    exports.createVerifyApi = createVerifyApi
  })

  // -------------------------------------------------------- checker-view
  define("checker-view", function (require, module, exports) {
    /**
     * The online capability verification panel.
     *
     * Collapsed to a single summary line: this is a maintenance action, not the
     * point of the page. Expanding it reveals the checker picker, the write-back
     * switch and — the part that matters when a sweep fails — the per-batch errors
     * with their real messages instead of a bare count.
     *
     * The last route choice is kept in browser storage only: the Host persists run
     * facts, not UI selections.
     */

    const React = require('react')
    const h = React.createElement

    const { formatTokens, checkerRoutesOf } = require("pure")
    const { useSource } = require("hooks")

    const PICK_KEY = 'dsh-model-visibility:checker-pick:v1'
    /** How many failure lines to show before summarising the rest. */
    const MAX_ERROR_LINES = 6
    /** Concurrency choices offered in the panel; mirrors lib/check-catalog MAX_CONCURRENCY. */
    const CONCURRENCY_CHOICES = [1, 2, 3, 4, 6, 8]

    function readPick() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(PICK_KEY))
        return parsed !== null && typeof parsed === 'object'
          ? {
              provider: typeof parsed.provider === 'string' ? parsed.provider : '',
              model: typeof parsed.model === 'string' ? parsed.model : '',
              writeBack: parsed.writeBack !== false,
              concurrency:
                Number.isFinite(parsed.concurrency) && parsed.concurrency > 0
                  ? Math.min(8, Math.max(1, Math.trunc(parsed.concurrency)))
                  : 2,
            }
          : { provider: '', model: '', writeBack: true, concurrency: 2 }
      } catch (_error) {
        return { provider: '', model: '', writeBack: true, concurrency: 2 }
      }
    }

    function persistPick(pick) {
      try {
        window.localStorage.setItem(PICK_KEY, JSON.stringify(pick))
      } catch (_error) {
        // Storage availability is optional for this preference.
      }
    }

    function VerifyPanel({ verify, catalog, t, canUse }) {
      const state = useSource(verify)
      const [pick, setPick] = React.useState(readPick)
      const [message, setMessage] = React.useState(null)
      const [open, setOpen] = React.useState(false)

      React.useEffect(() => {
        verify.load()
      }, [verify])

      const routeOptions = checkerRoutesOf(catalog?.groups)
      const route = routeOptions.find((entry) => entry.id === pick.provider) ?? null
      const progress = state.snapshot?.state
      const running = progress?.running === true
      const finished = progress?.phase === 'done' || progress?.phase === 'cancelled'
      const models = (catalog?.groups ?? [])
        .find((group) => group.id === pick.provider)?.models ?? []

      if (!canUse) {
        return h('div', { className: 'mvp_banner' }, t('checker.hostStale'))
      }

      const tokensSpent = progress
        ? formatTokens((progress.tokenUsage?.[0] ?? 0) + (progress.tokenUsage?.[1] ?? 0))
        : null

      const commit = (next) => {
        setPick(next)
        persistPick(next)
      }

      const run = () => {
        setMessage(null)
        verify
          .start({
            provider: pick.provider,
            model: pick.model,
            writeBack: pick.writeBack,
            concurrency: pick.concurrency,
          })
          .catch((error) => setMessage(String(error?.message ?? error)))
      }

      const cancel = () => {
        verify.cancel().catch((error) => setMessage(String(error?.message ?? error)))
      }

      const summary = running
        ? t('checker.running', {
            phase: t('checker.phase.' + (progress?.phase ?? 'verifying')),
            done: progress?.done ?? 0,
            total: progress?.total ?? 0,
            tokens: tokensSpent,
          })
        : finished
          ? t('checker.finished', {
              done: progress?.done ?? 0,
              total: progress?.total ?? 0,
              tokens: tokensSpent,
            })
          : t('checker.idle')

      const errors = Array.isArray(progress?.errors) ? progress.errors : []
      const visibleErrors = errors.slice(0, MAX_ERROR_LINES)

      return h(
        'div',
        { className: 'mvp_checker' + (open ? '' : ' mvp_checker--closed') },
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_checkerHead',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
          h('span', { className: 'mvp_chevron' }, open ? '▾' : '▸'),
          h('span', { className: 'mvp_checkerTitle' }, t('checker.title')),
          h('span', { className: 'mvp_checkerSummary' }, summary),
          errors.length > 0 ? h('span', { className: 'mvp_badge' }, t('checker.errorBadge', { count: errors.length })) : null,
        ),
        open
          ? h(
              'div',
              { className: 'mvp_checkerBody' },
              h('p', { className: 'mvp_checkerHint' }, t('checker.description')),
              h(
                'div',
                { className: 'mvp_checkerForm' },
                h(
                  'label',
                  { className: 'mvp_field' },
                  h('span', { className: 'mvp_fieldLabel' }, t('checker.provider')),
                  h(
                    'select',
                    {
                      className: 'mvp_select',
                      value: pick.provider,
                      'aria-label': t('checker.provider'),
                      onChange: (event) => commit({ ...pick, provider: event.target.value, model: '' }),
                    },
                    h('option', { key: '', value: '' }, t('override.kindAuto')),
                    routeOptions.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
                  ),
                ),
                h(
                  'label',
                  { className: 'mvp_field' },
                  h('span', { className: 'mvp_fieldLabel' }, t('checker.model')),
                  h(
                    'select',
                    {
                      className: 'mvp_select',
                      value: pick.model,
                      'aria-label': t('checker.model'),
                      disabled: route === null,
                      onChange: (event) => commit({ ...pick, model: event.target.value }),
                    },
                    h('option', { key: '', value: '' }, t('override.kindAuto')),
                    models.map((model) =>
                      h('option', { key: model.id, value: model.id }, model.name ?? model.id),
                    ),
                  ),
                ),
                h(
                  'label',
                  { className: 'mvp_field', title: t('checker.concurrencyTitle') },
                  h('span', { className: 'mvp_fieldLabel' }, t('checker.concurrency')),
                  h(
                    'select',
                    {
                      className: 'mvp_select',
                      value: String(pick.concurrency),
                      'aria-label': t('checker.concurrency'),
                      disabled: running,
                      onChange: (event) =>
                        commit({ ...pick, concurrency: Number(event.target.value) }),
                    },
                    CONCURRENCY_CHOICES.map((value) =>
                      h('option', { key: value, value: String(value) }, t('checker.concurrencyValue', { count: value })),
                    ),
                  ),
                ),
                h(
                  'label',
                  { className: 'mvp_check', title: t('checker.writeBackTitle') },
                  h('input', {
                    type: 'checkbox',
                    checked: pick.writeBack,
                    disabled: running,
                    onChange: (event) => commit({ ...pick, writeBack: event.target.checked }),
                  }),
                  h('span', null, t('checker.writeBack')),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: running ? 'mvp_button' : 'mvp_button mvp_button--accent',
                    disabled: !running && (pick.provider === '' || pick.model === ''),
                    title: running ? t('checker.cancelTitle') : t('checker.startTitle'),
                    onClick: running ? cancel : run,
                  },
                  running ? t('checker.cancel') : t('checker.start'),
                ),
              ),
              running || finished
                ? h(
                    'div',
                    { className: 'mvp_checkerProgress' },
                    h('div', {
                      className: 'mvp_progressBar',
                      role: 'progressbar',
                      'aria-valuemin': 0,
                      'aria-valuemax': progress?.total ?? 0,
                      'aria-valuenow': progress?.done ?? 0,
                    }, h('span', {
                      className: 'mvp_progressFill',
                      style: {
                        width:
                          (progress?.total ?? 0) > 0
                            ? Math.min(100, Math.round(((progress?.done ?? 0) / progress.total) * 100)) + '%'
                            : '0%',
                      },
                    })),
                    h(
                      'span',
                      { className: 'mvp_checkerProgressText' },
                      t('checker.progress', {
                        done: progress?.done ?? 0,
                        total: progress?.total ?? 0,
                        tokens: tokensSpent,
                      }),
                    ),
                    h(
                      'span',
                      { className: 'mvp_checkerProgressText' },
                      t('checker.threads', { count: progress?.concurrency ?? pick.concurrency }),
                    ),
                  )
                : null,
              // Which public catalogs were read, and which were not. Without this
              // "the catalogs returned nothing" and "the catalogs errored" look
              // identical, which is exactly how a broken fetch stayed invisible.
              (progress?.sources?.length ?? 0) > 0
                ? h(
                    'div',
                    { className: 'mvp_sources' },
                    h('div', { className: 'mvp_sourcesTitle' }, t('checker.sourcesTitle')),
                    h(
                      'ul',
                      { className: 'mvp_sourceList' },
                      progress.sources.map((source, index) =>
                        h(
                          'li',
                          { key: index, className: source.status === 'ok' ? 'mvp_source--ok' : 'mvp_source--bad' },
                          h('span', { className: 'mvp_sourceName' }, String(source.name)),
                          h('span', { className: 'mvp_sourceState' }, t('checker.source.' + String(source.status))),
                          source.models > 0
                            ? h('span', { className: 'mvp_sourceCount' }, t('checker.sourceModels', { count: source.models }))
                            : null,
                          source.message
                            ? h('span', { className: 'mvp_sourceMsg' }, String(source.message))
                            : null,
                        ),
                      ),
                    ),
                  )
                : null,
              (progress?.publicOnly ?? 0) > 0
                ? h(
                    'div',
                    { className: 'mvp_usageHint' },
                    t('checker.publicOnly', { count: progress.publicOnly }),
                  )
                : null,
              errors.length > 0
                ? h(
                    'div',
                    { className: 'mvp_checkerErrors' },
                    h('div', { className: 'mvp_checkerErrorsTitle' }, t('checker.errorTitle')),
                    h(
                      'ul',
                      { className: 'mvp_errorList' },
                      visibleErrors.map((entry, index) =>
                        h('li', { key: index }, typeof entry === 'string' ? entry : String(entry)),
                      ),
                    ),
                    errors.length > visibleErrors.length
                      ? h(
                          'div',
                          { className: 'mvp_usageHint' },
                          t('checker.errorMore', { count: errors.length - visibleErrors.length }),
                        )
                      : null,
                  )
                : null,
              message !== null ? h('div', { className: 'mvp_banner mvp_banner--error' }, message) : null,
              state.error !== null ? h('div', { className: 'mvp_banner mvp_banner--error' }, state.error) : null,
            )
          : null,
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

    /**
     * Rewrite one directory store in place so its snapshots omit hidden models.
     *
     * The shipped composer seat may capture the directory store before this plugin
     * applies, so replacing the store object would never reach it; rewriting
     * getSnapshot/subscribe on the captured object does. The session's active
     * model stays listed even while hidden, because the shipped trigger
     * resolves its label from this same catalog.
     */
    function patchDirectoryStore(store, form) {
      const readBase = store.getSnapshot.bind(store)
      const subscribeBase = store.subscribe.bind(store)
      const originalGet = store.getSnapshot
      const originalSubscribe = store.subscribe
      const listeners = new Set()
      let snapshot = null
      let lastBase
      let lastSignature

      const build = (baseSnapshot) => {
        const hidden = new Set(hiddenListOf(form.getSnapshot()))
        const activeSelection = baseSnapshot.current
        const groups = []
        for (const group of baseSnapshot.groups || []) {
          const all = group.models || []
          const models = []
          for (const model of all) {
            const key = keyOf(group.id, model.id)
            const active =
              activeSelection !== null &&
              activeSelection !== undefined &&
              activeSelection.provider === group.id &&
              activeSelection.model === model.id
            if (!hidden.has(key) || active) models.push(model)
          }
          if (models.length === 0) continue
          groups.push(models.length === all.length ? group : { ...group, models })
        }
        return { ...baseSnapshot, groups }
      }

      const current = () => {
        const baseSnapshot = readBase()
        const signature = hiddenListOf(form.getSnapshot()).join('\u0000')
        if (snapshot !== null && baseSnapshot === lastBase && signature === lastSignature) {
          return snapshot
        }
        lastBase = baseSnapshot
        lastSignature = signature
        snapshot = build(baseSnapshot)
        return snapshot
      }

      const emit = () => {
        const previous = snapshot
        const next = current()
        if (previous === next) return
        for (const listener of Array.from(listeners)) listener()
      }

      Object.defineProperties(store, {
        __modelVisibilityPatched: { value: true, configurable: true },
        getSnapshot: { value: current, configurable: true, writable: true },
        subscribe: {
          value(listener) {
            listeners.add(listener)
            const stop = subscribeBase(listener)
            return () => {
              listeners.delete(listener)
              stop()
            }
          },
          configurable: true,
          writable: true,
        },
      })

      return {
        emit,
        restore() {
          Object.defineProperties(store, {
            getSnapshot: { value: originalGet, configurable: true, writable: true },
            subscribe: { value: originalSubscribe, configurable: true, writable: true },
          })
          delete store.__modelVisibilityPatched
          listeners.clear()
        },
      }
    }

    /**
     * Patch every model directory — the ones already live when the plugin
     * applies and every directory resolved later — so the shipped seat keeps
     * owning the trigger, the Model / Effort rows, and third-party menu
     * enhancements such as the reasoning-effort slider.
     */
    function installComposerFilter(scope, form) {
      const models = scope.modelDirectories
      const original = models.directoryFor
      if (typeof original !== 'function') return
      const records = new Set()

      const ensure = (directory) => {
        if (directory === undefined || directory === null) return directory
        const store = directory.store
        if (store === undefined || store === null || store.__modelVisibilityPatched === true) {
          return directory
        }
        try {
          records.add(patchDirectoryStore(store, form))
        } catch (_error) {
          // Fail open: an unwritable store simply keeps showing every model.
        }
        return directory
      }

      scope.effect(() => {
        const live = models.live && models.live.directories ? models.live.directories.values : null
        if (live instanceof Set) for (const directory of live) ensure(directory)

        const stopForm = form.subscribe(() => {
          for (const record of records) record.emit()
        })

        const wrapper = function directoryFor(sessionId) {
          return ensure(original.call(this, sessionId))
        }
        Object.defineProperty(models, 'directoryFor', {
          value: wrapper,
          configurable: true,
          writable: true,
        })

        return () => {
          stopForm()
          for (const record of records) record.restore()
          records.clear()
          if (Object.getOwnPropertyDescriptor(models, 'directoryFor')?.value === wrapper) {
            delete models.directoryFor
          }
        }
      }, 'model-visibility: filtered model directory')
    }

    /* ----------------------------------------------------- settings page */


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
    .mvp_checker--closed{background:transparent}
    .mvp_checkerHead{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:0;align-items:baseline;gap:8px;padding:7px 10px;font-family:inherit;font-size:12px;line-height:18px;display:flex;flex-wrap:wrap}
    .mvp_checkerHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
    .mvp_checkerHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
    .mvp_checkerTitle{font-weight:500;flex:none}
    .mvp_checkerSummary{color:var(--dsw-alias-label-tertiary);flex:1;min-width:0;font-size:11px}
    .mvp_badge{flex:none;color:var(--dsw-alias-state-warn-primary);border:.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);border-radius:999px;padding:0 6px;font-size:10px;line-height:15px}
    .mvp_checkerBody{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px}
    .mvp_checkerHint{color:var(--dsw-alias-label-tertiary);margin:0 0 8px;font-size:11px;line-height:16px}
    .mvp_checkerForm{align-items:flex-end;gap:10px;display:flex;flex-wrap:wrap}
    .mvp_checkerProgress{align-items:center;gap:10px;margin-top:10px;display:flex;flex-wrap:wrap}
    .mvp_progressBar{flex:1 1 160px;min-width:120px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
    .mvp_progressFill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease;display:block}
    .mvp_checkerProgressText{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
    .mvp_checkerErrors{margin-top:10px}
    .mvp_checkerErrorsTitle{color:var(--dsw-alias-state-warn-primary);margin-bottom:4px;font-size:11px;line-height:16px}
    .mvp_errorList{max-height:150px;color:var(--dsw-alias-label-secondary);margin:0;padding-left:18px;font-size:11px;line-height:16px;overflow-y:auto}
    .mvp_errorList li{margin-bottom:3px;word-break:break-word}
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
        'page.summary': '已显示 {visible} / {total}',
        'page.hiddenSummary': '已关闭 {count}',
        'page.kindSummary': '生图/生视频 {count}',
        'page.loading': '正在加载模型列表…',
        'page.empty': '暂无可用模型。',
        'page.filterEmpty': '当前筛选下没有模型。',
        'page.error': '模型列表加载失败：{message}',
        'page.saveFailed': '保存失败，请重试。',
        'page.refresh': '刷新',
        'page.refreshing': '刷新中…',
        'page.refreshTitle': '重新读取适配器与中转站的能力信息（沿用缓存，10 分钟内的探测不会重发请求）',
        'page.reload': '重新获取能力',
        'page.reloading': '正在获取…',
        'page.reloadTitle':
          '清空本插件的能力缓存和正在进行的读取，重新询问适配器与所有中转站；不会改动任何模型开关。适配器没有公布的思考强度仍不会凭空出现。',
        'page.reloadUnavailable': 'Host 半不支持强制重新获取；重启 DSH 后可用。',
        'page.collapseGroups': '折叠全部',
        'page.expandGroups': '展开全部',
        'page.collapseGroupsTitle': '只保留分组标题，方便跳到其他分组',
        'page.expandGroupsTitle': '展开所有被折叠的分组',
        'page.showAll': '全部显示',
        'page.legend':
          '标签：推理 = 可调推理等级；上下文 = 输入窗口；多模态 = 可输入图像。实线来自适配器、中转站或厂商文档，虚线来自联网校验或模型名推断。生图 / 生视频 / 嵌入等只标类型，不显示思考强度与文本标签。',
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
        'usage.detail': '输入 {input} · 输出 {output} · 缓存读 {cacheRead} · 缓存写 {cacheWrite}',
        'usage.today': '今天',
        'usage.todayTitle': '本地自然日（今天 0 点起）',
        'usage.week': '本周',
        'usage.weekTitle': '本周一 0 点起',
        'usage.month': '本月',
        'usage.monthTitle': '本月 1 日 0 点起',
        'usage.total': '总计',
        'usage.totalTitle': '全部历史（更早的按会话创建日粗算）',
        'usage.exportUsage': '用量 CSV',
        'usage.exportUsageTitle': '下载按天分桶、含每模型 token 分解的 CSV',
        'usage.exportModels': '模型 CSV',
        'usage.exportModelsTitle': '下载全部提供商模型的可见性与能力表',
        'usage.hostStale': '宿主半尚未提供用量统计，重启 DSH 即可启用。',
        'checker.title': '联网校验',
        'checker.description':
          '选定一个校验员模型：先拉 models.dev / OpenRouter / Hugging Face 三个公开目录做基准，再把其余模型分批交给它核对。公开目录已经知道的能力会直接采用，校验员答不上时也不例外。校验请求会消耗所选模型的额度，其 token 计入上方统计。提示：思考型模型会先花掉输出预算，若批次普遍失败，换一个非思考模型或降低其思考档位。',
        'checker.provider': '校验员提供商',
        'checker.model': '校验员模型',
        'checker.start': '开始校验',
        'checker.startTitle': '在宿主侧后台跑一轮全模型校验',
        'checker.cancel': '取消',
        'checker.cancelTitle': '中止正在进行的校验',
        'checker.writeBack': '同时写入提供商配置',
        'checker.writeBackTitle':
          '开启：判定到的 input / contextWindow / 推理档位直接写进各提供商该模型条目（learned.json 只留写不进去的字段）；关闭：只更新本页与快照。',
        'checker.idle': '未运行',
        'checker.running': '进行中{phase} · {done}/{total} · 已耗 {tokens}',
        'checker.finished': '已完成 {done}/{total} · 耗 {tokens}',
        'checker.progress': '{done}/{total} 已核对 · 校验本身消耗 {tokens} token',
        'checker.errorBadge': '{count} 个批次失败',
        'checker.errorTitle': '失败批次',
        'checker.errorMore': '另有 {count} 条未显示',
        'checker.concurrency': '并发线程',
        'checker.concurrencyTitle': '同时发出的校验请求数。中转站限流时调低，网络快时调高（上限 8）。',
        'checker.concurrencyValue': '{count} 路',
        'checker.threads': '并发 {count} 路',
        'checker.sourcesTitle': '公开目录',
        'checker.source.ok': '已读取',
        'checker.source.empty': '无匹配',
        'checker.source.http': 'HTTP 错误',
        'checker.source.failed': '请求失败',
        'checker.source.bad-json': '非 JSON',
        'checker.source.too-large': '响应过大',
        'checker.source.pending': '等待中',
        'checker.sourceModels': '{count} 条',
        'checker.publicOnly': '其中 {count} 个模型的能力来自公开目录（校验员未作答）。',
        'checker.hostStale': '宿主半不支持联网校验，请重启 DSH 后使用。',
        'checker.phase.public': '（读取公开目录）',
        'checker.phase.checker': '（读取公开目录）',
        'checker.phase.verifying': '（分批校验）',
        'source.snapshot': '已校验',
        'page.applyInput': '让输入框按能力标注放行图像',
        'page.applyInputShort': '多模态中转站模型自动补 image；关闭则只按 Provider 的 input 声明',
        'page.applyInputHint':
          '开启后，被标注为「多模态」的中转站对话模型会在发送请求时自动补上图像输入能力；关闭则完全按 Provider 配置里的 input 声明。只影响中转站（pi-ai）路由，不改任何配置文件；若某个上游实际拒绝图像，关闭此开关即可。',
        'page.kindLegend':
          '类型配色：生图 蓝 · 生视频 绿 · 嵌入 橙 · 音频 紫 · 重排 红 · 审核 玫红 · 翻译 灰。「官方校正」表示目录与厂商文档不一致时以文档为准。',
        'page.searchPlaceholder': '搜索名称或 ID',
        'page.capability.multimodal': '多模态',
        'page.capability.multimodalTitle': '只看可输入图像的模型',
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
        'group.showAll': '全组显示',
        'group.hideAll': '全组隐藏',
        'group.showFiltered': '显示结果',
        'group.hideFiltered': '隐藏结果',
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
        'tag.effort': '思考强度',
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
        'effort.off': '关闭',
        'effort.minimal': '极低',
        'effort.low': '低',
        'effort.medium': '中',
        'effort.high': '高',
        'effort.max': '最高',
        'effort.xhigh': '极高',
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
          '勾选「不支持推理」会隐藏思考强度；勾选档位后，这些档位会直接显示为该模型的可用强度。',
        'override.save': '保存',
        'override.saving': '保存中…',
        'override.reset': '恢复自动',
        'override.cancel': '取消',
        'override.failed': '保存失败：{message}',
        'override.unavailable': 'Host 半仍不支持手动能力设置；重启 DSH 后可用。',
        'override.provider': '同时写入模型提供商设置',
        'override.providerHint':
          '勾选后，输入模态、上下文窗口与思考强度会写进「设置 → 模型提供商」里这个模型的配置，其他界面也能看到；只在本页可表达的项（模型类型、默认档位、仅 off 的档位）仍留在本插件。',
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
        'page.summary': 'Showing {visible} of {total}',
        'page.hiddenSummary': '{count} hidden',
        'page.kindSummary': '{count} image/video',
        'page.loading': 'Loading model list…',
        'page.empty': 'No models available.',
        'page.filterEmpty': 'No models match this filter.',
        'page.error': 'Could not load the model list: {message}',
        'page.saveFailed': 'Could not save this change. Try again.',
        'page.refresh': 'Refresh',
        'page.refreshing': 'Refreshing…',
        'page.refreshTitle': 'Read adapter and relay capabilities again (honours caches; a probe younger than 10 minutes is not repeated)',
        'page.reload': 'Re-fetch capabilities',
        'page.reloading': 'Re-fetching…',
        'page.reloadTitle':
          'Drops this plugin’s capability caches and any in-flight read, then asks the adapter and every relay again. Model switches are untouched; effort levels the adapter does not publish still cannot appear.',
        'page.reloadUnavailable': 'The Host half does not support a hard re-fetch; restart DSH to enable it.',
        'page.collapseGroups': 'Collapse all',
        'page.expandGroups': 'Expand all',
        'page.collapseGroupsTitle': 'Keep only group headers so other groups are easy to reach',
        'page.expandGroupsTitle': 'Expand every collapsed group',
        'page.showAll': 'Show all',
        'page.legend':
          'Tags: Reasoning = adjustable levels; Context = input window; Multimodal = accepts images. Solid tags come from the adapter, the relay or vendor documentation; dashed tags come from online verification or the model name. Image, video, embedding and other models show only their kind.',
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
        'usage.detail': 'input {input} · output {output} · cache read {cacheRead} · cache write {cacheWrite}',
        'usage.today': 'Today',
        'usage.week': 'Week',
        'usage.month': 'Month',
        'usage.total': 'Total',
        'usage.todayTitle': 'Local calendar day',
        'usage.weekTitle': 'Since Monday 00:00 local',
        'usage.monthTitle': 'Since the 1st local',
        'usage.totalTitle': 'All history (older months attributed by session start day)',
        'usage.exportUsage': 'Usage CSV',
        'usage.exportUsageTitle': 'Download a day-bucketed CSV with per-model breakdown',
        'usage.exportModels': 'Models CSV',
        'usage.exportModelsTitle': 'Download visibility and capability table of every provider model',
        'usage.hostStale': 'The Host half does not provide usage stats yet; restart DSH to enable it.',
        'checker.title': 'Online verification',
        'checker.description':
          'Pick one model as the checker: three public catalogs (models.dev / OpenRouter / Hugging Face) are fetched first, then the remaining models are verified in batches. Whatever the catalogs already know is applied directly, even when the checker has no answer. A sweep spends the checker route quota and its tokens count in the strip above. Note: a thinking model spends the output budget before it answers, so if batches keep failing pick a non-thinking checker or lower its effort.',
        'checker.provider': 'Checker provider',
        'checker.model': 'Checker model',
        'checker.start': 'Start',
        'checker.startTitle': 'Run a background verification sweep in the Host',
        'checker.cancel': 'Cancel',
        'checker.cancelTitle': 'Abort the running sweep',
        'checker.writeBack': 'Also write into provider settings',
        'checker.writeBackTitle':
          'On: the judged input / contextWindow / efforts are written into each provider entry (learned.json keeps only what cannot be mapped). Off: only this page and the snapshot update.',
        'checker.idle': 'not run yet',
        'checker.running': 'running{phase} · {done}/{total} · {tokens} spent',
        'checker.finished': 'finished {done}/{total} · {tokens} spent',
        'checker.progress': '{done}/{total} verified · checker spent {tokens} tokens',
        'checker.errorBadge': '{count} failed batches',
        'checker.errorTitle': 'Failed batches',
        'checker.errorMore': '{count} more not shown',
        'checker.concurrency': 'Threads',
        'checker.concurrencyTitle':
          'How many checker requests may be in flight at once. Lower it if the relay rate-limits you, raise it on a fast link (max 8).',
        'checker.concurrencyValue': '{count}',
        'checker.threads': '{count} in parallel',
        'checker.sourcesTitle': 'Public catalogs',
        'checker.source.ok': 'read',
        'checker.source.empty': 'no match',
        'checker.source.http': 'HTTP error',
        'checker.source.failed': 'request failed',
        'checker.source.bad-json': 'not JSON',
        'checker.source.too-large': 'response too large',
        'checker.source.pending': 'pending',
        'checker.sourceModels': '{count}',
        'checker.publicOnly': '{count} models were resolved from a public catalog alone (the checker had no answer).',
        'checker.hostStale': 'The Host half does not support online verification yet; restart DSH.',
        'checker.phase.public': ' (fetching public catalogs)',
        'checker.phase.checker': ' (fetching public catalogs)',
        'checker.phase.verifying': ' (verifying in batches)',
        'source.snapshot': 'verified',
        'page.applyInput': 'Let the composer admit images shown as supported',
        'page.applyInputShort':
          'Adds image input to multimodal relay models; off means the Provider input declaration only',
        'page.applyInputHint':
          'When on, relay chat models labelled Multimodal advertise image input to the request path; when off, only the Provider input declaration counts. Relay (pi-ai) routes only — no configuration file is modified. Turn it off if a particular upstream still rejects images.',
        'page.kindLegend':
          'Kind colours: image blue · video green · embedding orange · audio purple · rerank red · moderation rose · translation grey. “Official correction” means vendor documentation overrides a wrong catalog row.',
        'page.searchPlaceholder': 'Search name or ID',
        'page.capability.multimodal': 'Multimodal',
        'page.capability.multimodalTitle': 'Only models that accept image input',
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
        'group.showAll': 'Show all',
        'group.hideAll': 'Hide all',
        'group.showFiltered': 'Show results',
        'group.hideFiltered': 'Hide results',
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
        'tag.effort': 'Effort',
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
        'effort.off': 'Off',
        'effort.minimal': 'Minimal',
        'effort.low': 'Low',
        'effort.medium': 'Medium',
        'effort.high': 'High',
        'effort.max': 'Max',
        'effort.xhigh': 'XHigh',
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
        'override.effortHint':
          '“No reasoning” hides effort levels; checked levels are shown as this model’s available effort levels.',
        'override.save': 'Save',
        'override.saving': 'Saving…',
        'override.reset': 'Use automatic',
        'override.cancel': 'Cancel',
        'override.failed': 'Could not save: {message}',
        'override.unavailable':
          'The Host half does not support manual capabilities yet; restart DSH to enable it.',
        'override.provider': 'Also write to the model provider settings',
        'override.providerHint':
          'When checked, input modalities, context window and effort levels are written into this model’s entry under Settings → Model providers, so other views see them too. Fields that only exist here (kind, default level, an off-only ladder) stay in this plugin.',
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

    /** Identity of a manual override entry; same shape as the row key. */
    function overrideKeyOf(entry) {
      return entry ? keyOf(entry.provider, entry.model) : null
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
    exports.overrideKeyOf = overrideKeyOf
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
    function providerWriteNote(result, t) {
      if (result === null || typeof result !== 'object') return null
      if (result.written === true) {
        const fields = (Array.isArray(result.fields) ? result.fields : [])
          .map((field) => t('override.field.' + field))
          .join('、')
        return t('override.providerWritten', { fields })
      }
      if (result.reason === 'nothing' || result.reason === 'skipped') return null
      const label = t('override.reason.' + String(result.reason))
      return t('override.providerSkipped', {
        reason: label === 'override.reason.' + String(result.reason) ? String(result.reason) : label,
      })
    }

    function ModelOverrideEditor({ entry, name, t, overrides, onClose, onSaved }) {
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
      const [applyToProvider, setApplyToProvider] = React.useState(true)

      const toggleIn = (setter, id) => {
        setter((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const fail = (failure) => {
        setBusy(false)
        setError(
          t('override.failed', {
            message: String(failure && failure.message ? failure.message : failure),
          }),
        )
      }

      const save = () => {
        const payload = { provider: entry.provider, model: entry.model }
        if (kind !== '') payload.kind = kind
        if (context.trim() !== '') {
          const value = Number(context)
          if (!Number.isFinite(value) || value <= 0) {
            setError(t('override.contextInvalid'))
            return
          }
          payload.contextWindow = Math.round(value)
        }
        if (input.size > 0) {
          payload.input = OVERRIDE_MODALITIES.filter((id) => input.has(id))
        }
        if (noReasoning) {
          payload.reasoningSupported = false
        } else if (efforts.size > 0) {
          payload.efforts = OVERRIDE_EFFORTS.filter((id) => efforts.has(id)).map((id) => ({ id }))
          if (defaultEffort !== '' && efforts.has(defaultEffort)) {
            payload.defaultEffort = defaultEffort
          }
        }
        payload.applyToProvider = applyToProvider
        setBusy(true)
        setError(null)
        Promise.resolve(overrides.save(payload)).then(
          (result) => {
            setBusy(false)
            if (typeof onSaved === 'function') onSaved(result)
          },
          fail,
        )
      }

      const resetToAuto = () => {
        setBusy(true)
        setError(null)
        Promise.resolve(overrides.remove(entry.provider, entry.model)).then(
          () => {
            setBusy(false)
            if (typeof onSaved === 'function') onSaved()
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
        OVERRIDE_EFFORTS.filter((id) => efforts.has(id)).map((id) => [id, effortLabel(id, t)]),
      )
      const selectedDefault = efforts.has(defaultEffort) ? defaultEffort : ''

      return h(
        'div',
        { className: 'mvp_editor' },
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
              type: 'number',
              min: '1',
              step: '1',
              value: context,
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
                    disabled: busy,
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
            h(
              'div',
              { className: 'mvp_chips' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_chip',
                  'aria-pressed': noReasoning,
                  disabled: busy,
                  onClick: () => setNoReasoning((value) => !value),
                },
                t('tag.noReasoning'),
              ),
              OVERRIDE_EFFORTS.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'mvp_chip',
                    'aria-pressed': !noReasoning && efforts.has(id),
                    disabled: busy || noReasoning,
                    onClick: () => toggleIn(setEfforts, id),
                  },
                  effortLabel(id, t),
                ),
              ),
            ),
          ),
          !noReasoning && efforts.size > 0
            ? h(
                'label',
                { className: 'mvp_field' },
                h('span', { className: 'mvp_fieldLabel' }, t('override.defaultEffort')),
                h(
                  'select',
                  {
                    className: 'mvp_select',
                    value: selectedDefault,
                    'aria-label': t('override.defaultEffort'),
                    onChange: (event) => setDefaultEffort(event.target.value),
                  },
                  defaultOptions.map(([value, label]) => h('option', { key: value, value }, label)),
                ),
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
                checked: applyToProvider,
                disabled: busy,
                onChange: (event) => setApplyToProvider(event.target.checked),
              }),
              h('span', null, t('override.provider')),
            ),
            h('div', { className: 'mvp_editorNote' }, t('override.providerHint')),
          ),
        ),
        error !== null ? h('div', { className: 'mvp_editorError', role: 'alert' }, error) : null,
        h(
          'div',
          { className: 'mvp_editorFooter' },
          h('div', { className: 'mvp_editorNote' }, t('override.effortHint')),
          h(
            'div',
            { className: 'mvp_editorActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'mvp_button',
                disabled: busy,
                title: t('override.resetTitle'),
                onClick: resetToAuto,
              },
              t('override.reset'),
            ),
            h(
              'button',
              { type: 'button', className: 'mvp_button', disabled: busy, onClick: onClose },
              t('override.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mvp_button mvp_button--accent',
                disabled: busy,
                onClick: save,
              },
              t(busy ? 'override.saving' : 'override.save'),
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

    const { bucketOf, kindOf } = require("format")

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
     * simpler pass (visibility only). Inputs are the loaded groups plus the five
     * filter axes; output keeps the group objects in order with only kept models.
     */
    function computeFilteredGroups(groups, { filter = 'all', query = '', multimodalOnly = false, reasoningOnly = false, minContext = 0 } = {}) {
      const normalized = String(query ?? '').trim().toLowerCase()
      const filtered = []
      for (const group of groups ?? []) {
        const models = []
        for (const model of group.models ?? []) {
          if (filter !== 'all' && bucket(model) !== filter) continue
          if (normalized !== '') {
            const name = String(model.name ?? '').toLowerCase()
            const id = String(model.id ?? '').toLowerCase()
            if (!name.includes(normalized) && !id.includes(normalized)) continue
          }
          if (multimodalOnly && !(Array.isArray(model.inputModalities) && model.inputModalities.includes('image'))) {
            continue
          }
          if (reasoningOnly && model.reasoningSupported !== true) continue
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
    const { keyOf, kindOf, isGenerationKind, providerLabel, countModels, readCollapsedGroups, persistCollapsedGroups, overrideKeyOf } = require("format")
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

        React.useEffect(() => {
          catalog.load()
          overrides.load()
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        const catalogMeta = state.learned && typeof state.learned === 'object' ? state.learned : null
        const hostFeatures =
          catalogMeta && Array.isArray(catalogMeta.features) ? catalogMeta.features : []
        const canEdit = state.source === 'host' && hostFeatures.includes('overrides')
        const canVerify = state.source === 'host' && hostFeatures.includes('verify')
        const overrideEntries = new Map()
        for (const entry of overrideState.entries) {
          overrideEntries.set(overrideKeyOf(entry), entry)
        }

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
        const [query, setQuery] = React.useState('')
        const [multimodalOnly, setMultimodalOnly] = React.useState(false)
        const [reasoningOnly, setReasoningOnly] = React.useState(false)
        const [minContext, setMinContext] = React.useState(0)
        const normalizedQuery = query.trim().toLowerCase()
        const filteredGroups = computeFilteredGroups(groups, {
          filter,
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
          if (busy || reloading || refreshing) return
          runCatalogAction(() => catalog.reload(), setReloading)
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
                  h('span', { className: 'mvp_groupCount' }, shown + '/' + allGroupModels.length),
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
                    ? filter === 'all'
                      ? t('group.hideAll')
                      : t('group.hideFiltered')
                    : filter === 'all'
                      ? t('group.showAll')
                      : t('group.showFiltered'),
                ),
              ),
              collapsedNow
                ? null
                : models.map((model) => {
                  const rowKey = keyOf(group.id, model.id)
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
                      canEdit
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'mvp_button mvp_button--quiet mvp_editButton',
                              'aria-pressed': editing === rowKey,
                              'aria-label': t('row.edit') + ': ' + model.name,
                              title: t('row.editTitle'),
                              disabled: busy,
                              onClick: () => setEditing(editing === rowKey ? null : rowKey),
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
                    canEdit && editing === rowKey
                      ? h(ModelOverrideEditor, {
                          key: 'editor',
                          entry:
                            overrideEntries.get(rowKey) || { provider: group.id, model: model.id },
                          name: model.name,
                          t,
                          overrides,
                          onClose: () => setEditing(null),
                          onSaved: (result) => {
                            setEditing(null)
                            setProviderNote(providerWriteNote(result && result.provider, t))
                            refreshCatalog()
                          },
                        })
                      : null
                  return h(React.Fragment, { key: model.id }, row, editor)
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
        const hasActiveFilters =
          filter !== 'all' || normalizedQuery !== '' || multimodalOnly || reasoningOnly || minContext > 0
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
          h(UsageToolbar, { usage, t, features: state.source === 'host' ? hostFeatures : [] }),
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
            ? h('div', { className: 'mvp_banner' }, t('page.metaFallback'))
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
          overrideState.available === false
            ? h('div', { className: 'mvp_banner' }, t('override.unavailable'))
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
          providerNote !== null ? h('div', { className: 'mvp_note' }, providerNote) : null,
          h(VerifyPanel, { verify, catalog: state, t, canUse: canVerify }),
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
      const levels = effortNames(reasoning)
      const reasoningSource = sourceOf(model, 'reasoning')
      const errorTitle =
        typeof model.infoError === 'string' && model.infoError !== ''
          ? t('tag.infoErrorTitle', { message: model.infoError })
          : t('tag.unknownTitle')

      if (levels.length > 0) {
        tags.push({
          key: 'reasoning',
          tone: 'accent',
          label: t('tag.reasoning'),
          title: t('tag.reasoningTitle', {
            levels: levels.join(' / '),
            source: sourceLabel(reasoningSource, t),
          }),
        })
        const fallback = defaultEffortName(reasoning)
        tags.push({
          key: 'effort',
          tone: 'neutral',
          label: t('tag.effort') + ' ' + levels.join('/'),
          title:
            fallback === null
              ? t('tag.effortTitleNoFallback', {
                  levels: levels.join(' / '),
                  source: sourceLabel(reasoningSource, t),
                })
              : t('tag.effortTitle', {
                  levels: levels.join(' / '),
                  fallback,
                  source: sourceLabel(reasoningSource, t),
                }),
        })
      } else if (model.reasoningSupported === true) {
        tags.push({
          key: 'reasoning',
          tone: 'accent',
          label: t('tag.reasoning'),
          title: t('tag.reasoningCatalogTitle', { source: sourceLabel(reasoningSource, t) }),
          inferred: isInferredSource(reasoningSource),
        })
      } else if (model.reasoningSupported === false) {
        tags.push({
          key: 'reasoning',
          tone: 'muted',
          label: t('tag.noReasoning'),
          title: sourceLabel(reasoningSource, t),
          inferred: isInferredSource(reasoningSource),
        })
      } else {
        tags.push({ key: 'reasoning', tone: 'muted', label: t('tag.reasoningUnknown'), title: errorTitle })
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
        tags.push({
          key: 'modality',
          tone: vision ? 'vision' : 'neutral',
          label: vision ? t('tag.multimodal') : t('tag.textOnly'),
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

    /** Trigger a same-origin download without leaving the page. */
    function download(href) {
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.rel = 'noopener'
      anchor.download = ''
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    function UsageToolbar({ usage, t, features }) {
      const state = useSource(usage)
      const supported = features.length === 0 || features.includes('usage')
      const ranges = state.snapshot?.ranges
      const computing = state.snapshot?.computing === true

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
          computing ? h('span', { className: 'mvp_usageComputing' }, t('usage.computing')) : null,
        ),
        h(
          'span',
          { className: 'mvp_usageRanges' },
          windows.map(([key, labelKey, titleKey]) =>
            h(
              'span',
              {
                key,
                className: 'mvp_stat' + (key === 'total' ? ' mvp_stat--total' : ''),
                title: t(titleKey) + '\n' + detailOf(ranges?.[key], t),
              },
              h('span', { className: 'mvp_statLabel' }, t(labelKey)),
              h('span', { className: 'mvp_statValue' }, formatTokens(totalOf(ranges?.[key]))),
            ),
          ),
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
              onClick: () => download(`${API}/export?type=usage`),
            },
            t('usage.exportUsage'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button mvp_button--quiet',
              title: t('usage.exportModelsTitle'),
              onClick: () => download(`${API}/export?type=models`),
            },
            t('usage.exportModels'),
          ),
        ),
        state.error !== null
          ? h('span', { className: 'mvp_usageHint mvp_usageHint--warn' }, state.error)
          : null,
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
            catalog.refresh()
            overrides.load()
            usage.refresh()
          }),
        )
        if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
          disposers.push(
            ctx.remote.$on('llm/adapters-updated', () => {
              catalog.refresh()
            }),
          )
          for (const event of [
            'settings/document-updated',
            'credentials/record-updated',
            'credentials/reference-updated',
          ]) {
            disposers.push(
              ctx.remote.$on(event, () => {
                catalog.load()
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
