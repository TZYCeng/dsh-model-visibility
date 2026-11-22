/** Authenticated same-origin model-management routes. UI, verifier and request gate
 * use the same services; route handlers never own long-running tasks. */
import { stripWrittenFields, writeCapabilities } from './provider-write.js'
import { inferModelKind } from './capability-catalog.js'
import { VERIFY_SOURCE_MODES } from './check-catalog.js'
import { toModelListCsv, toUsageCsv } from './export-csv.js'
import { API, json, readControl } from './host-http.js'

export function registerCoreRoutes(scope, deps) {
  const { connection, service, probe, clearFallbackProfiles, overrides, learnedService, imageInput,
    usageLedger, maybeRescan, resetRescan, verifier, settings, configEditor, logger, liveList, trace } = deps
  scope.effect(
    () =>
      connection.fetch.register({
        path: `${API}/models`,
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          let fresh = false
          let reload = false
          try {
            const params = new URL(request.url).searchParams
            fresh = params.get('fresh') !== null
            reload = params.get('reload') !== null
          } catch (_error) {
            // A malformed URL simply means "use the cached read".
          }
          // A hard reload is the page's "re-fetch capabilities" action: drop
          // every cache and any sweep already in flight, then read again. A
          // plain `fresh` read bypasses TTLs but still joins an in-flight
          // sweep, which can be exactly the stale read the user is trying to
          // escape.
          if (reload) {
            service.invalidate()
            probe?.invalidate()
            clearFallbackProfiles()
            overrides.invalidate()
            learnedService.invalidate()
            imageInput.refresh()
          }
          try {
            return json({ ok: true, value: await service.read({ fresh: fresh || reload }) })
          } catch (error) {
            if (typeof logger.warn === 'function') {
              logger.warn('model-visibility: capability probe failed')
              logger.warn(error)
            }
            return json(
              {
                ok: false,
                error: {
                  code: 'model-info/failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              500,
            )
          }
        },
      }),
    'model-visibility: capability route',
  )

  scope.effect(
    () =>
      connection.fetch.register({
        path: `${API}/overrides`,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const method = String(request.method || 'GET').toUpperCase()
          if (method === 'GET') {
            try {
              return json({ ok: true, value: overrides.read() })
            } catch (error) {
              if (typeof logger.warn === 'function') {
                logger.warn('model-visibility: could not read model overrides')
                logger.warn(error)
              }
              return json(
                {
                  ok: false,
                  error: {
                    code: 'overrides/failed',
                    message: error instanceof Error ? error.message : String(error),
                  },
                },
                500,
              )
            }
          }
          if (method !== 'POST') {
            return json(
              { ok: false, error: { code: 'overrides/method', message: 'GET or POST' } },
              405,
            )
          }
          let body
          try {
            body = await readControl(request)
          } catch (_error) {
            return json(
              {
                ok: false,
                error: { code: 'overrides/body', message: 'expected a JSON override entry' },
              },
              400,
            )
          }
          // What the provider schema can express is mirrored into the
          // provider's own settings, so the composer and the adapter see the
          // same facts as this page. A refusal is not an error: the local
          // override still applies, and the response explains the reason.
          let provider = { written: false, fields: [], reason: 'skipped' }
          const providerId = typeof body?.provider === 'string' ? body.provider.trim() : ''
          const modelId = typeof body?.model === 'string' ? body.model.trim() : ''
          if (!providerId || !modelId || providerId.length > 512 || modelId.length > 1024 || (Object.hasOwn(body, 'expectedRevision')
            && body.expectedRevision !== null && typeof body.expectedRevision !== 'string')) {
            return json({ ok: false, error: { code: 'overrides/params', message: 'a provider, model and valid revision are required' } }, 400)
          }
          try {
            // Old clients did not send a revision; acquire the current one
            // for this request. Current clients submit the editor's revision,
            // including null for a previously absent override.
            const expected = Object.hasOwn(body, 'expectedRevision') ? body.expectedRevision : overrides.snapshot(providerId, modelId).revision
            const local = overrides.compareAndCommit(body.remove === true ? { provider: providerId, model: modelId } : body, expected)
            trace('overrides', 'local.commit', { provider: providerId, model: modelId, accepted: local.ok,
              fields: local.entry && Object.keys(local.entry).filter(k => !['provider','model','updatedAt','revision'].includes(k)) })
            if (!local.ok) {
              return json({ ok: false, error: { code: 'overrides/conflict', message: 'this model override changed; reopen the editor and review the current values' } }, 409)
            }
            service.invalidate()
            if (local.entry && body.applyToProvider === true) {
              provider = await writeCapabilities(settings, local.entry, {
                llm: scope.llm,
                configEditor,
                reasoningEffortMappings: body.reasoningEffortMappings,
                directEffort: body.directEffort === true, standardEffort: body.standardEffort === true,
                beforeDispatch: () => overrides.snapshot(providerId, modelId).revision === local.revision,
                referencePrefill: local.entry.referencePrefill === true || body.referencePrefill === true, trace,
              })
              trace('overrides', 'provider.receipt', { provider: providerId, model: modelId, accepted: provider.written === true, fields: provider.fields, reason: provider.reason })
              if (provider.written) {
                const remaining = stripWrittenFields(local.entry, provider.fields, provider.localOnly)
                // Do not prune an independently edited file after an async
                // settings write; the same CAS protects concurrent POSTs.
                const clean = overrides.compareAndCommit(remaining, local.revision)
                if (!clean.ok) trace('overrides', 'prune.conflict', { provider: providerId, model: modelId })
              }
            }
          } catch (error) {
            if (typeof logger.warn === 'function') {
              logger.warn('model-visibility: could not save a model override')
              logger.warn(error)
            }
            return json(
              {
                ok: false,
                error: {
                  code: 'overrides/failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              500,
            )
          }
          // The new entry outranks every cached capability fact. A provider
          // write also changed the settings document: refresh the profile
          // cache so the page immediately shows the declared values instead
          // of the stale ones (no network sweep is needed for that).
          service.invalidate()
          imageInput.refresh()
          if (provider.written) {
            clearFallbackProfiles()
            probe?.noteSettingsChanged()
          }
          try {
            return json({ ok: true, value: { ...overrides.read(), provider } })
          } catch (error) {
            return json({ ok: false, error: { code: 'overrides/read-after-save', message: String(error?.message ?? error) } }, 500)
          }
        },
      }),
    'model-visibility: override route',
  )

  // Token-usage read for the page's stats strip; the background scan runs
  // whenever the ledger could have grown and the page asks for a read.
  scope.effect(
    () =>
      connection.fetch.register({
        path: `${API}/usage`,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          if (String(request.method || 'GET').toUpperCase() === 'POST') {
            resetRescan()
          }
          maybeRescan()
          try {
            return json({ ok: true, value: usageLedger.read() })
          } catch (error) {
            return json(
              {
                ok: false,
                error: {
                  code: 'usage/failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              500,
            )
          }
        },
      }),
    'model-visibility: usage route',
  )

  // One-click exports: the token ledger and the visible-model capability
  // list, both as CSV downloads through the same-origin route.
  scope.effect(
    () =>
      connection.fetch.register({
        path: `${API}/export`,
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          const params = new URL(request.url).searchParams
          const which = params.get('type') === 'models' ? 'models' : 'usage'
          let body
          let name
          try {
            if (which === 'usage') {
              // Join an active scan or finish the first scan before creating
              // a CSV. Do not silently download a cold, all-zero snapshot.
              await usageLedger.ensureScanned()
              const usage = usageLedger.read()
              body = toUsageCsv(usage)
              name = `model-visibility-usage-${new Date().toISOString().slice(0, 10)}.csv`
            } else {
              const catalog = await service.read()
              body = toModelListCsv(catalog, { hidden: liveList() })
              name = `model-visibility-models-${new Date().toISOString().slice(0, 10)}.csv`
            }
          } catch (error) {
            return json(
              {
                ok: false,
                error: {
                  code: 'export/failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              500,
            )
          }
          trace('export', 'csv.ready', { mode: which, bytes: Buffer.byteLength(body) })
          return new Response(body, {
            status: 200,
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': `attachment; filename="${name}"`,
              'Cache-Control': 'no-store',
            },
          })
        },
      }),
    'model-visibility: export route',
  )

  // The verify sweep: state reads are instant, a start posts and the Host
  // runs batches in the background without holding the HTTP call open.
  scope.effect(
    () =>
      connection.fetch.register({
        path: `${API}/verify`,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const method = String(request.method || 'GET').toUpperCase()
          if (method === 'GET') {
            return json({ ok: true, value: { state: verifier.snapshot(), learned: learnedService.meta() } })
          }
          let body
          try {
            body = await readControl(request)
          } catch (_error) {
            return json({ ok: false, error: { code: 'verify/body', message: 'Expected a JSON object' } }, 400)
          }
          if (body !== null && typeof body === 'object' && body.cancel === true) {
            if (typeof body.runId !== 'string' || !body.runId || body.runId.length > 80) {
              return json({ ok: false, error: { code: 'verify/run-id', message: 'Refresh the verification panel before cancelling a run.' } }, 409)
            }
            const result = verifier.cancel(body.runId)
            if (!result?.cancelled) return json({ ok: false, error: { code: 'verify/stale-run', message: 'This run is no longer active.' } }, 409)
            return json({ ok: true, value: { state: verifier.snapshot() } })
          }
          const provider = typeof body?.provider === 'string' ? body.provider : undefined
          const model = typeof body?.model === 'string' ? body.model : undefined
          const mode = body?.mode
          if (mode !== undefined && !VERIFY_SOURCE_MODES.includes(mode)) {
            return json({ ok: false, error: { code: 'verify/params', message: 'invalid verification mode' } }, 400)
          }
          const useChecker = mode === undefined ? body?.useChecker !== false : mode !== 'public'
          if (useChecker && (!provider?.trim() || !model?.trim())) {
            return json(
              { ok: false, error: { code: 'verify/params', message: 'provider and model are required' } },
              400,
            )
          }
          if (useChecker) {
            // Check local evidence only. Never contact a suspect model just to see if it is a chatbot.
            const record = learnedService.getExact?.(model.trim())
            const cached = service.peek?.()?.groups?.find(group => group.id === provider.trim())?.models?.find(row => row.id === model.trim())
            const kind = overrides.get(provider.trim(), model.trim())?.kind ?? cached?.kind ?? record?.publicFacts?.type ?? record?.type ?? inferModelKind(model)
            if (kind !== 'chat') return json({ ok: false, error: { code: 'verify/checker-kind', message: 'Choose a conversation model as the checker.' } }, 400)
          }
          // The sweep runs in the background: the response only reports that
          // it was accepted, and polling GET observes the progress state.
          // `concurrency` is a per-run choice (how many checker calls may be
          // in flight), so a fast relay can use more threads than the default.
          const concurrency = Number.isFinite(body?.concurrency) ? body.concurrency : undefined
          if (verifier.isRunning()) {
            return json({ ok: false, error: { code: 'verify/running', message: 'a verification run is already active' } }, 409)
          }
          void verifier.start({
            mode, checker: useChecker ? { provider, model } : undefined, useChecker,
            fuzzyMatch: typeof body?.fuzzyMatch === 'boolean' ? body.fuzzyMatch : undefined, writeBack: body?.writeBack === true,
            webSearch: useChecker && body?.webSearch !== false, fullScan: body?.fullScan === true, concurrency,
          }).catch(error => logger.warn?.('model-visibility: could not start verification', error))
          return json({ ok: true, value: { state: verifier.snapshot(), accepted: true } })
        },
      }),
    'model-visibility: verify route',
  )

}
