/**
 * Host half of the model-visibility plugin.
 *
 * Two jobs:
 *
 * 1. Own the `model-visibility` settings namespace: `hidden` is a volatile
 *    Config field, so the Host settings document persists the browser's choices
 *    and `settings.describe` projects them back to the Client. The generated
 *    configuration page is disabled because the plugin's own settings section
 *    is the editing surface.
 * 2. Keep a shadow copy of that list outside the profile patch layer
 *    (`$DSH_HOME/dsh-model-visibility/hidden.json`), because the patch layer is
 *    rebuilt from scratch in several ordinary situations — a profile repair,
 *    a plugin reinstall, or any write whose value equals the inherited default
 *    (the settings writer then deletes the row). Without a shadow copy the row
 *    silently disappears and every model becomes visible again after the next
 *    reload. The schema default is seeded from that file, so a rebuilt patch
 *    layer restores the last known list instead of an empty one.
 *
 * Each entry is an opaque `provider/model` key; the Client never parses it.
 *
 * @module index.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import { createModelInfoService } from './lib/model-info.js'
import { createLearnedCatalog } from './lib/learned-catalog.js'
import { createOverrideStore } from './lib/model-overrides.js'
import { createCapabilityVerifier, VERIFY_SOURCE_MODES } from './lib/check-catalog.js'
import { createCheckerSearchBridge } from './lib/checker-search-bridge.js'
import { toModelListCsv, toUsageCsv } from './lib/export-csv.js'
import { createUsageLedger } from './lib/usage-ledger.js'
import { createProviderProbe, readProviderProfiles } from './lib/provider-probe.js'
import { stripWrittenFields, writeCapabilities } from './lib/provider-write.js'
import { installImageInputGate } from './lib/image-input-gate.js'

/** Settings namespace this entry owns; also the loader row id. */
const ENTRY = 'model-visibility'
/** Config field carrying the hidden model keys. */
const FIELD = 'hidden'
/** Shadow store location below `$DSH_HOME`. */
const STORE_DIR = 'dsh-model-visibility'
const STORE_FILE = 'hidden.json'
/** Authenticated same-origin route prefix used by the settings page. */
const API = '/api/dsh-model-visibility'

/** Absolute path of the shadow copy. */
function storeFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, STORE_DIR, STORE_FILE)
}

/** Keep only string entries, so a hand-edited file can never break the schema. */
function asKeyList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((key) => typeof key === 'string')
}

/** Read the shadow copy; a missing or unreadable file simply yields an empty list. */
function readStored() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    return asKeyList(Array.isArray(parsed) ? parsed : parsed?.[FIELD])
  } catch (_error) {
    return []
  }
}

/** Replace the shadow copy atomically; a failure must never break the plugin. */
function writeStored(list) {
  const file = storeFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ [FIELD]: list }, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/**
 * Restored default: a rebuilt settings document keeps the last hidden list
 * instead of falling back to "everything visible".
 */
const RESTORED = readStored()

/** Model keys the composer must stop offering, in the order they were hidden. */
export const Config = z.object({
  hidden: z.array(z.string()).default(RESTORED).volatile(),
  /** Probe relay endpoints for capability metadata (set MODEL_VISIBILITY_PROBE=0 to disable). */
  probe: z.boolean().default(true),
  /**
   * Admit image input on relay models the page displays as multimodal. DSH
   * builds the adapter model from the provider's `defaultInput` (usually
   * text) when the route leaves `input` empty, so a relay model that really
   * accepts images is rejected by both the session check and the serializer.
   * Volatile so flipping the switch reaches the running Host without a reload.
   */
  applyInput: z.boolean().default(true).volatile(),
})

/**
 * Disable the generated configuration page and keep the shadow copy current.
 * @param ctx - plugin context.
 * @param config - resolved plugin config; `hidden` is a stable volatile reference.
 */
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const logger = ctx.logger ?? console

  // Manual capability overrides live in their own file: they are structured,
  // change independently of the hidden list, and the request-side image gate
  // needs a synchronous read. See `lib/model-overrides.js`.
  const overrides = createOverrideStore({ logger })

  // The learned capability snapshot replaces the abandoned static catalog:
  // the online verification run seeds it, and every same-named model served
  // later resolves against the cached rows. See `lib/learned-catalog.js`.
  // Tests may inject a store through the inject scope (`scope.get('learned')`).
  let learned = null
  const learnedFor = () => {
    if (learned !== null) return learned
    learned = createLearnedCatalog({ logger })
    return learned
  }
  /** Current hidden keys, read through the stable volatile reference. */
  const liveList = () => {
    const value = config?.[FIELD]
    const current = value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value
    return asKeyList(current)
  }

  /** Read one config field, tolerating both a volatile reference and a value. */
  const liveConfig = (field, fallback) => {
    const value = config?.[field]
    const current = value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value
    return current === undefined ? fallback : current
  }

  let written
  const persist = () => {
    const list = liveList()
    const signature = list.join('\u0000')
    if (signature === written) return
    try {
      writeStored(list)
      written = signature
    } catch (error) {
      if (typeof logger.warn === 'function') {
        logger.warn('model-visibility: could not write the shadow copy')
        logger.warn(error)
      }
    }
  }

  ctx.effect(() => {
    const disposers = []
    /**
     * A volatile-only settings write updates the reference in place and emits
     * `loader/volatile-update`; the settings document event covers the same
     * change when the loader reports it differently.
     */
    const onConfigChanged = (paths) => {
      if (
        Array.isArray(paths) &&
        !paths.some((item) => Array.isArray(item) && (item[0] === FIELD || item[0] === 'applyInput'))
      ) {
        return
      }
      persist()
    }
    if (typeof ctx.on === 'function') {
      disposers.push(
        ctx.on('loader/volatile-update', (paths) => {
          onConfigChanged(paths)
        }),
      )
      disposers.push(
        ctx.on('settings/document-updated', (ns) => {
          if (ns === ENTRY) onConfigChanged()
        }),
      )
    }
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (_error) {
          // A listener may already be gone during teardown.
        }
      }
    }
  }, 'model-visibility: shadow copy')

  ctx.effect(() => {
    persist()
    return () => persist()
  }, 'model-visibility: shadow baseline')

  // The capability catalog is a read-only projection of the live LLM registry,
  // enriched with the provider profile (settings) and the relay's own model
  // listing. It is served over an authenticated same-origin route because the
  // shipped `session.modelCatalog` projection drops context windows and
  // modalities, and a custom relay reports `input: []` for almost everything.
  ctx.inject(['llm', 'connection'], (scope) => {
    const connection = scope.connection
    if (scope.llm === undefined) {
      if (typeof logger.warn === 'function') {
        logger.warn('model-visibility: llm service unavailable; capability route not registered')
      }
      return
    }
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      if (typeof logger.warn === 'function') {
        logger.warn('model-visibility: connection.fetch unavailable; capability route not registered')
      }
      return
    }

    // Optional services: without them the page still renders adapter + catalog
    // facts, it just cannot probe relay endpoints.
    const settings = scope.get?.('settings')
    const credentials = scope.get?.('credentials')
    const configEditor = scope.get?.('configEditor')
    const probeEnabled = config?.probe !== false && process.env.MODEL_VISIBILITY_PROBE !== '0'
    const probe =
      probeEnabled && settings !== undefined
        ? createProviderProbe({ settings, llm: scope.llm, configEditor, credentials, logger })
        : null

    // Even with the relay probe disabled, the request-side gate still needs the
    // provider declarations. Reading them is local and synchronous; cache the
    // map per settings generation because the gate asks once per model.
    let fallbackProfiles = null
    const profilesForGate = () => {
      if (fallbackProfiles !== null) return fallbackProfiles
      if (typeof settings?.describe !== 'function') return new Map()
      try {
        fallbackProfiles = readProviderProfiles(settings.describe(), { llm: scope.llm, configEditor })
      } catch (_error) {
        fallbackProfiles = new Map()
      }
      return fallbackProfiles
    }
    const clearFallbackProfiles = () => {
      fallbackProfiles = null
    }

    const learnedService =
      (typeof scope.get === 'function' ? scope.get('learned') : undefined) ?? learnedFor()

    // Use the same exact declarations for the catalog's degradation path and
    // the synchronous request-side gate. Do not wait for network enrichment to
    // see a Provider's explicit configuration.
    const localEnrichment = () => ({
      ...probe?.peek(),
      profiles: probe === null ? profilesForGate() : probe.profiles(),
    })
    const service = createModelInfoService(scope.llm, {
      settings,
      configEditor,
      enrichment: probe === null ? localEnrichment : ({ fresh }) => probe.read({ fresh }),
      fallbackEnrichment: localEnrichment,
      overrides,
      learned: learnedService,
      context: () => ({ ...localEnrichment(), overrides, learned: learnedService }),
    })

    // Make the relay adapter admit images for models the page displays as
    // multimodal. The patch is read-only: an explicit provider declaration
    // still wins, and the settings switch can turn the behaviour off.
    const imageInput = installImageInputGate(scope.llm, {
      allow: (provider, model, name, snapshotRoute) =>
        liveConfig('applyInput', true) !== false && service.imageInputAllowed(provider, model, name, snapshotRoute),
      warn: (error) => {
        if (typeof logger.warn === 'function') {
          logger.warn('model-visibility: image input gate failed')
          logger.warn(error)
        }
      },
    })
    scope.effect(() => () => imageInput.dispose(), 'model-visibility: image input gate')

    // Token-usage ledger behind the page's stats strip: session logs are read
    // incrementally in a background pass, the check sweep records its own
    // spend into the same buckets.
    const usageLedger = createUsageLedger({ logger, sessionPersistence: scope.get?.('sessionPersistence') })
    let lastRescanAt = -Infinity
    const nowMs = () => Date.now()
    const maybeRescan = () => {
      if (usageLedger.isScanning()) return
      if (nowMs() - lastRescanAt < 60_000) return
      lastRescanAt = nowMs()
      usageLedger.rescan().catch(() => {})
    }

    // The online capability verifier: the user's chosen checker model plus
    // two public catalogs fill the learned snapshot and (optionally) write
    // back into the provider settings documents.
    const verifier = createCapabilityVerifier({
      llm: scope.llm,
      settings,
      configEditor,
      onSettled: () => service.invalidate(),
      web: typeof scope.get === 'function' ? scope.get('web') : undefined,
      searchBridge: createCheckerSearchBridge({
        getTools: () => scope.get?.('tools'),
        getSettings: () => scope.get?.('settings'),
      }),
      learned: learnedService,
      ledger: usageLedger,
      logger,
      onApplied: () => {
        clearFallbackProfiles()
        probe?.noteSettingsChanged()
        service.invalidate()
        imageInput.refresh()
      },
    })
    scope.effect(
      () => async () => {
        try {
          await verifier.dispose()
        } finally {
          await usageLedger.dispose()
        }
      },
      'model-visibility: verifier and usage ledger',
    )
    /** Answer with JSON; the route is diagnostics-friendly on purpose. */
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })

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
              body = await request.json()
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
            if (!providerId || !modelId || (Object.hasOwn(body, 'expectedRevision')
              && body.expectedRevision !== null && typeof body.expectedRevision !== 'string')) {
              return json({ ok: false, error: { code: 'overrides/params', message: 'a provider, model and valid revision are required' } }, 400)
            }
            try {
              // Old clients did not send a revision; acquire the current one
              // for this request. Current clients submit the editor's revision,
              // including null for a previously absent override.
              const expected = Object.hasOwn(body, 'expectedRevision') ? body.expectedRevision : overrides.snapshot(providerId, modelId).revision
              const local = overrides.compareAndCommit(body.remove === true ? { provider: providerId, model: modelId } : body, expected)
              if (!local.ok) {
                return json({ ok: false, error: { code: 'overrides/conflict', message: 'this model override changed; reopen the editor and review the current values' } }, 409)
              }
              service.invalidate()
              if (local.entry && body.applyToProvider === true) {
                provider = await writeCapabilities(settings, local.entry, {
                  llm: scope.llm,
                  configEditor,
                  reasoningEffortMappings: body.reasoningEffortMappings,
                  standardEffort: body.standardEffort === true,
                  referencePrefill: body.referencePrefill === true,
                })
                if (provider.written) {
                  const remaining = stripWrittenFields(local.entry, provider.fields, provider.localOnly)
                  // Do not prune an independently edited file after an async
                  // settings write; the same CAS protects concurrent POSTs.
                  overrides.compareAndCommit(remaining, local.revision)
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
              lastRescanAt = -Infinity
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
              body = await request.json()
            } catch (_error) {
              body = {}
            }
            if (body !== null && typeof body === 'object' && body.cancel === true) {
              verifier.cancel()
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

    // A route/credential change invalidates both the capability cache and (when
    // it actually changed routing facts) the relay-probe cache. Ordinary
    // settings writes — hiding one model — only invalidate the capability
    // snapshot, so a toggle never fans out into a network sweep.
    scope.effect(() => {
      const offs = []
      const invalidateAll = () => {
        service.invalidate()
        probe?.invalidate()
        clearFallbackProfiles()
        imageInput.refresh()
      }
      const noteSettings = () => {
        service.invalidate()
        probe?.noteSettingsChanged()
        clearFallbackProfiles()
      }
      if (typeof scope.on === 'function') {
        offs.push(scope.on('llm/adapters-updated', invalidateAll))
        offs.push(scope.on('llm/models-updated', invalidateAll))
        offs.push(scope.on('settings/document-updated', noteSettings))
        for (const event of ['credentials/record-updated', 'credentials/reference-updated']) {
          try {
            offs.push(scope.on(event, invalidateAll))
          } catch (_error) {
            // Older hosts do not emit every credential event.
          }
        }
      }
      return () => {
        for (const off of offs) {
          try {
            if (typeof off === 'function') off()
          } catch (_error) {
            // The service may already be gone during teardown.
          }
        }
      }
    }, 'model-visibility: capability cache')
  })
}
