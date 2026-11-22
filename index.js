/**
 * Host half of the model-visibility plugin.
 *
 * Wires the directory, verifier, guarded reasoning operations, diagnostics and
 * usage ledger. Visibility preferences have two additional lifecycle rules:
 *
 * 1. Own the `model-visibility` settings namespace: `hidden` is a volatile
 *    Config field, so the Host settings document persists the browser's choices
 *    and `settings.describe` projects them back to the Client. The generated
 *    configuration page is disabled because the plugin's own settings section
 *    is the editing surface.
 * 2. Keep a shadow copy of that list outside the profile patch layer
 *    (profile-scoped `hidden.json` from profile-store.js), because the patch layer is
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
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import { createModelInfoService } from './lib/model-info.js'
import { createLearnedCatalog } from './lib/learned-catalog.js'
import { createOverrideStore } from './lib/model-overrides.js'
import { createCapabilityVerifier } from './lib/check-catalog.js'
import { createCheckerSearchBridge } from './lib/checker-search-bridge.js'
import { createUsageLedger } from './lib/usage-ledger.js'
import { createProviderProbe, readProviderProfiles } from './lib/provider-probe.js'
import { registerCoreRoutes } from './lib/host-routes.js'
import { API, registerSupportRoutes, wrapConnection } from './lib/host-http.js'
import { createDebugTrace } from './lib/debug-trace.js'
import { createVersionInfo } from './lib/version-info.js'
import { createBulkEffortService } from './lib/bulk-efforts.js'
import { profileDataFile, storageRoot } from './lib/profile-store.js'
import { withStoreLock } from './lib/store-lock.js'
import { installImageInputGate } from './lib/image-input-gate.js'

/** Settings namespace this entry owns; also the loader row id. */
const ENTRY = 'model-visibility'
/** Config field carrying the hidden model keys. */
const FIELD = 'hidden'
/** Shadow store location below `$DSH_HOME`. */
const STORE_FILE = 'hidden.json'

/** Absolute path of the shadow copy. */
function storeFile() {
  return profileDataFile(STORE_FILE)
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
  withStoreLock(file, () => {
    // An incomplete external edit is not an empty list. Leave its contents intact.
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.[FIELD])) throw new Error('Unreadable visibility backup')
    }
    const temp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ [FIELD]: list }, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temp, file)
    } finally { try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  })
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
  const diagnostics = createDebugTrace()
  const { trace } = diagnostics
  ctx.effect(() => () => diagnostics.dispose(), 'model-visibility: debug journal')
  const overrides = createOverrideStore({ file: profileDataFile('overrides.json'), logger, trace })

  // The learned capability snapshot replaces the abandoned static catalog:
  // the online verification run seeds it, and every same-named model served
  // later resolves against the cached rows. See `lib/learned-catalog.js`.
  // Tests may inject a store through the inject scope (`scope.get('learned')`).
  let learned = null
  const learnedFor = () => {
    if (learned !== null) return learned
    learned = createLearnedCatalog({ file: profileDataFile('learned.json'), logger, trace })
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
    const signature = JSON.stringify(list)
    if (signature === written) return
    try {
      writeStored(list)
      trace('visibility', 'shadow.saved', { count: list.length })
      written = signature
    } catch (error) {
      if (typeof logger.warn === 'function') {
        trace('visibility', 'shadow.failed', { ok: false })
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
        ? createProviderProbe({ settings, llm: scope.llm, configEditor, credentials, logger, trace })
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
      configEditor, trace,
      enrichment: probe === null ? localEnrichment : request => probe.read(request),
      fallbackEnrichment: localEnrichment,
      overrides,
      learned: learnedService,
      context: () => ({ ...localEnrichment(), overrides, learned: learnedService }),
    })

    // Make the relay adapter admit images for models the page displays as
    // multimodal. The patch is read-only: an explicit provider declaration
    // still wins, and the settings switch can turn the behaviour off.
    const imageInput = installImageInputGate(scope.llm, {
      trace,
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
    const usageLedger = createUsageLedger({ logger, trace, sessionPersistence: scope.get?.('sessionPersistence'),
      file: profileDataFile('usage-ledger.json', { importLegacy: false }), legacyFile: path.join(storageRoot().legacy, 'usage-ledger.json') })
    let lastRescanAt = -Infinity
    const nowMs = () => Date.now()
    const maybeRescan = () => {
      if (usageLedger.isScanning()) return
      if (nowMs() - lastRescanAt < 60_000) return
      lastRescanAt = nowMs()
      usageLedger.rescan().catch(() => {})
    }

    const refreshAfterWrite = () => {
      clearFallbackProfiles()
      probe?.noteSettingsChanged()
      service.invalidate()
      imageInput.refresh()
    }
    const versions = createVersionInfo({ trace })
    const bulk = createBulkEffortService({ settings, llm: scope.llm, configEditor, learned: learnedService,
      overrides, readCatalog: service.peek, onApplied: refreshAfterWrite, trace })
    const traced = wrapConnection(connection, trace)
    registerSupportRoutes(scope, { connection: traced, diagnostics, versions, bulk })
    // The online capability verifier: the user's chosen checker model plus
    // two public catalogs fill the learned snapshot and (optionally) write
    // back into the provider settings documents.
    const verifier = createCapabilityVerifier({
      llm: scope.llm,
      settings,
      configEditor, trace,
      automaticWriteFact: service.automaticWriteFact,
      onLearned: ({ effortIds, startedAt }) => {
        if (effortIds?.length && bulk.inspect().enabled) void Promise.resolve().then(() => bulk.reconcile({ modelIds: effortIds, startedAt })).catch(() => trace('bulk', 'reconcile.failed', { ok: false }))
      },
      onSettled: () => service.invalidate(),
      web: typeof scope.get === 'function' ? scope.get('web') : undefined,
      searchBridge: createCheckerSearchBridge({
        trace, getTools: () => scope.get?.('tools'),
        getSettings: () => scope.get?.('settings'),
      }),
      learned: learnedService,
      ledger: usageLedger,
      logger,
      onApplied: refreshAfterWrite,
    })
    scope.effect(
      () => async () => {
        // Stop authorization and prevent new work before waiting on workers.
        bulk.dispose()
        versions.dispose()
        const stopping = [probe?.dispose?.(), service.dispose?.(), verifier.dispose()]
        try { await Promise.allSettled(stopping) } finally { await usageLedger.dispose() }
      },
      'model-visibility: verifier and usage ledger',
    )
    registerCoreRoutes(scope, { connection: traced, service, probe, clearFallbackProfiles, overrides, learnedService,
      imageInput, usageLedger, maybeRescan, resetRescan: () => { lastRescanAt = -Infinity }, verifier,
      settings, configEditor, logger, liveList, trace })

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
