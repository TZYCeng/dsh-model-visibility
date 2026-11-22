/**
 * Host-side model capability probe.
 *
 * The shipped browser catalog (`session.modelCatalog`) deliberately carries only
 * the identity and the reasoning ladder of every routable model. The model
 * visibility page wants the rest of the story:
 *
 * - the context window (`LlmResolvedModelInfo.context.contextWindow`),
 * - the accepted input modalities (`inputModalities`, e.g. text + image),
 * - the output-token default (`defaultMaxTokens`), used as a tooltip only,
 * - the model kind (chat / image / video / embedding / …), which the adapter
 *   contract does not carry at all.
 *
 * Everything resolves through `ctx.llm` — the same registry the official model
 * menu uses — but an adapter declaration is not always trustworthy. A custom
 * relay configured with `input: []` falls back to the provider's `defaultInput`
 * (usually `["text"]`), so the registry reports "text only" for a model that is
 * plainly multimodal. Field priority: manual, explicit configuration / trusted
 * native adapter, exact vendor correction, exact public catalog, route listing
 * / ordinary learned snapshot, inference. Aliases are display-only; published
 * effort levels are not request controls. See `evidence-policy.js`.
 *
 * Nothing in this module imports DSH internals: the only contract is the small
 * slice of `ctx.llm` used by {@link describeCatalog}, which keeps the probe
 * unit-testable with a plain object.
 *
 * @module lib/model-info
 */

import { detachReasoning, projectCapabilities, selectAutomaticWriteFact } from './evidence-policy.js'
import { concurrency, mapWorkers, operationSlots, traceEvent, traceRoute } from './catalog-work.js'
import { isDeepStrictEqual } from 'node:util'
export { detachReasoning, selectAutomaticWriteFact }

import { addModelAlias, exactModelIdentity, modelAliasCandidates } from './model-id.js'
import { createLearnedCatalog } from './learned-catalog.js'
import { boundedOperation } from './async-operation.js'
import { createStandardEffortAvailability, readInstalledModelIds } from './provider-write.js'

const TRACE_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'file'])
const TRACE_EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const TRACE_FIELDS = ['kind', 'modalities', 'context', 'maxTokens', 'reasoning', 'reasoningEfforts', 'defaultEffort', 'referenceReasoning', 'output']
const TRACE_KINDS = ['chat', 'image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation']

// Only enabled diagnostics use this projection. The mandatory identifiers
// and closed lists go through a stricter filter than the model display wire.
function traceModel(trace, provider, row, status) {
  const issue = row.infoError
  const reason = status !== 'failed' ? status : /timed out/.test(issue) ? 'timeout' : /capacity unavailable/.test(issue) ? 'capacity' : /route changed/.test(issue) ? 'route-changed' : 'adapter-failed'
  traceEvent(trace, 'catalog', 'model', {
    ...traceRoute(provider, row.id), status, reason, accepted: status !== 'failed',
    source: row.sources.modalities, fields: TRACE_FIELDS.filter(f => row.sources[f] !== 'unknown'),
    sources: TRACE_FIELDS.filter(f => row.sources[f] !== 'unknown').map(f => `${f}:${row.sources[f]}`),
    ...(TRACE_KINDS.includes(row.kind) ? { format: row.kind } : {}),
    ...(row.inputModalities ? { input: row.inputModalities.filter(m => TRACE_MODALITIES.has(m)).slice(0, 5) } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}), ...(row.defaultMaxTokens ? { maxTokens: row.defaultMaxTokens } : {}),
    ...(row.requestReasoning ? { efforts: row.requestReasoning.efforts.map(e => e.id).filter(id => TRACE_EFFORTS.has(id)).slice(0, 8) } : {}),
    alias: Object.values(row.fieldEvidence).some(e => e.alias),
  })
}

const DEFAULT_CATALOG_TIMEOUT_MS = 12_000
const DEFAULT_ENRICHMENT_TIMEOUT_MS = 16_000

function catalogTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Fallback learned snapshot used when the caller does not inject one. The
 * Host constructs its own store so the settings page and the request-side
 * image gate share one mtime-memoized read; a plain consumer of this module
 * (a test double, another tool) still gets learned facts without wiring.
 */
let defaultLearned = null
function lookupLearned(value) {
  try {
    if (defaultLearned === null) defaultLearned = createLearnedCatalog({})
    return defaultLearned.get(value)
  } catch (_error) {
    return undefined
  }
}

/** Default lifetime of one catalog snapshot, in milliseconds. */
export const DEFAULT_TTL_MS = 15_000

/** Render an unknown thrown value without losing its message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Keep only positive safe integers; the adapter contract allows nothing else. */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Read a non-empty string, or `undefined`. */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a Map entry by key, tolerating a plain object in tests. */
function mapGet(map, key) {
  if (map === null || map === undefined) return undefined
  if (typeof map.get === 'function') return map.get(key)
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/**
 * Detach a modality list: strings only, first occurrence wins.
 * @param value - adapter-owned modality array, possibly malformed.
 * @returns a fresh array, or undefined when nothing valid is left.
 */
export function detachModalities(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || out.includes(item)) continue
    out.push(item)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Project one resolved model into the adapter-only wire shape.
 *
 * `info` is whatever `llm.resolveModelInfo` returned; every field is optional
 * because adapters may know only part of a model's capabilities.
 * @param model - the catalog entry the resolver was called for.
 * @param info - `LlmResolvedModelInfo`, or undefined.
 * @returns a detached model record.
 */
export function describeResolvedModel(model, info) {
  const description =
    nonEmptyString(info?.description) ?? nonEmptyString(model?.description)
  const contextWindow = positiveInteger(info?.context?.contextWindow)
  const defaultMaxTokens = positiveInteger(info?.defaultMaxTokens)
  const inputModalities =
    detachModalities(info?.inputModalities) ?? detachModalities(model?.inputModalities)
  const reasoning = detachReasoning(info?.reasoning)
  return {
    id: model.id,
    name: model.name,
    ...(description === undefined ? {} : { description }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

/**
 * Build a lookup over one provider's discovered models.
 *
 * Relays may spell IDs differently (case, fast/free or a vendor prefix).
 * Retain exact IDs and index the conservative aliases separately.
 * @param entries - Map of advertised id -> discovered facts.
 * @returns a Map of lookup key -> discovered facts.
 */
export function indexDiscovered(entries) {
  const index = new Map()
  if (entries === null || entries === undefined) return index
  const source = entries instanceof Map ? entries : new Map(Object.entries(entries))
  const exact = new Map()
  const folded = new Map()
  const aliases = new Map()
  for (const [id, entry] of source) {
    if (typeof id !== 'string' || exactModelIdentity(id) !== id) continue
    if (!entry || typeof entry !== 'object' || entry.id !== undefined && entry.id !== id) continue
    exact.set(id, entry.id === id ? entry : { ...entry, id })
    const key = id.toLowerCase()
    folded.set(key, folded.has(key) ? null : id)
    addModelAlias(aliases, id)
  }
  for (const [id, entry] of exact) index.set(id, entry)
  for (const [key, id] of folded) {
    if (!index.has(key)) index.set(key, exact.get(id))
  }
  for (const [key, rows] of aliases) {
    if (index.has(key)) continue
    index.set(key, rows.size === 1 ? exact.get(rows.keys().next().value) : undefined)
  }
  discoveryLookups.set(index, { exact, folded, aliases })
  return index
}

const discoveryLookups = new WeakMap()

function recordInstalledModels(cache, profile, modelIds) {
  if (!cache || profile?.adapter === undefined) return
  let records = cache.get(profile.adapter)
  if (records === undefined) cache.set(profile.adapter, records = new Map())
  records.set(profile.id, { snapshot: profile.adapterSnapshot, modelIds })
}

function installedFor(cache, profile) {
  const record = profile?.adapter && cache.get(profile.adapter)?.get(profile.id)
  return record?.snapshot === profile?.adapterSnapshot ? record?.modelIds : undefined
}

/** A qualified query may use same-namespace facts but never another namespace's. */
function findDiscovered(index, value) {
  const id = exactModelIdentity(value)
  if (index == null || id === undefined) return undefined
  const data = discoveryLookups.get(index)
  if (data === undefined) return index.get(id)
  if (data.exact.has(id)) return data.exact.get(id)
  const foldedId = data.folded.get(id.toLowerCase())
  if (foldedId !== undefined) return data.exact.get(foldedId)
  const candidates = modelAliasCandidates(data.aliases, id)
  return candidates.length === 1 ? data.exact.get(candidates[0]) : undefined
}

/** Merge independently ranked fields. The fallback lookup is for legacy direct
 * consumers only: an injected empty store must not read unrelated disk state. */
export function mergeCapabilities(base, context = {}) {
  return projectCapabilities(base, {
    ...context,
    configured: context.configured ?? mapGet(context.profile?.models, base.id),
    learned: Object.hasOwn(context, 'learned') ? context.learned : lookupLearned(base.id),
  })
}

/**
 * Decide whether the composer may attach images to one relay model.
 *
 * Only widen an input for explicit-list relay routes with exact evidence. The adapter's
 * installed catalog is authoritative on the request path; the plugin's own
 * annotations (including local manual facts) cannot override a Provider's
 * explicit text-only declaration here.
 *
 * @param providerId - provider route the model belongs to.
 * @param modelId - exact model id.
 * @param context - `{ profile?, configured?, modelName?, discovered?, discoveredIndex? }`;
 *   `discovered` is either one provider's raw id->entry Map or one entry.
 * @returns `{ allowed, record?, reason }`; pure and synchronous.
 */
export function imageInputDecision(providerId, modelId, context = {}) {
  const profile = context.profile
  if (profile === undefined) return { allowed: false, reason: 'no-profile' }
  const configured = context.configured ?? mapGet(profile.models, modelId)
  const declared = detachModalities(configured?.input)
  if ((configured?.input !== undefined && !Array.isArray(configured.input)) ||
      (declared && !declared.includes('image')) ||
      (declared === undefined && profile.inputDefault === true && !profile.defaultInput?.includes('image'))) {
    return { allowed: false, reason: 'configured-text-only' }
  }
  if (profile.catalogModels === true || profile.catalogProvider === true && (context.installedModels?.has(modelId) ?? true)) {
    return { allowed: false, reason: 'installed-catalog' }
  }
  if (profile.catalogModels === false && (profile.baseURL === undefined || configured === undefined)) {
    return { allowed: false, reason: 'no-exact-relay-model' }
  }
  const discovery = context.discovered
  const discoveredIndex = context.discoveredIndex ?? indexDiscovered(
    discovery instanceof Map || discovery === undefined
      ? discovery
      : new Map([[discovery?.id, discovery]]),
  )
  const discovered = findDiscovered(discoveredIndex, modelId)
  const record = mergeCapabilities(
    { id: modelId, name: nonEmptyString(context.modelName) ?? modelId },
    { ...context, configured, discovered },
  )
  const modalities = record.inputModalities ?? []
  if (record.kind !== 'chat') return { allowed: false, record, reason: 'non-chat' }
  if (modalities.includes('image')) {
    const evidence = record.fieldEvidence.modalities
    // Exact evidence for an input, not a familiar-looking route/display name,
    // is required to change what a real conversation will admit and serialize.
    const allowed = !evidence.alias && evidence.source !== 'inferred'
    return { allowed, record, reason: allowed ? 'image' : 'reference-only' }
  }

  return {
    allowed: false,
    record,
    reason: modalities.length === 0 ? 'unknown' : 'text-only',
  }
}

/**
 * Describe one catalog model through the registry plus every evidence layer.
 *
 * A resolver failure is reported as `infoError` on the model instead of
 * removing it: the visibility switch must stay usable even when an adapter
 * cannot answer, and the catalog layers can still fill the capability fields.
 * @param llm - the Host `ctx.llm` registry (or a test double).
 * @param providerId - provider route the model belongs to.
 * @param model - catalog entry `{ id, name?, description?, inputModalities? }`.
 * @param context - `{ profile?, discovered?, override?, learned? }` enrichment for this provider.
 * @returns a detached model record.
 */
export async function describeModel(llm, providerId, model, context = {}) {
  const base = {
    id: model.id,
    name: nonEmptyString(model.name) ?? model.id,
    ...(nonEmptyString(model.description) === undefined ? {} : { description: model.description }),
  }
  let info
  let infoError
  const candidate = context.profile
  const registered = llm.adapters?.get?.(providerId)?.adapter
  const current = () => !context.stale && registered === llm.adapters?.get?.(providerId)?.adapter && profileMatchesRegistration(llm, candidate)
  try {
    info = await boundedOperation(signal => {
      const resolve = () => {
        if (!current()) throw new Error('provider route changed')
        return llm.resolveModelInfo(providerId, model.id, signal)
      }
      return context.resolveSlot ? context.resolveSlot(signal, resolve, current) : resolve()
    }, {
      signal: context.signal,
      timeoutMs: catalogTimeout(context.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS),
      label: `resolve model ${providerId}/${model.id}`,
    })
  } catch (error) {
    context.signal?.throwIfAborted()
    infoError = messageOf(error)
  }
  context.signal?.throwIfAborted()
  // Retain listing data after a timeout, but never reuse *either* adapter's
  // metadata after an ownership change during lookup.
  const valid = current()
  if (!valid) infoError = 'provider route changed'
  const adapter = valid ? describeResolvedModel({ ...base, inputModalities: model.inputModalities }, info) : undefined
  const profile = valid ? candidate : undefined
  const discovered = !valid ? undefined : findDiscovered(
    context.discoveredIndex ?? indexDiscovered(context.discovered),
    model.id,
  )
  return mergeCapabilities(base, {
    adapter,
    infoError,
    profile,
    installedModels: context.installedModels,
    standardEffort: profile === candidate && context.standardEffort,
    configured: mapGet(profile?.models, model.id),
    discovered,
    override: context.override,
    learned: Object.hasOwn(context, 'learned') ? context.learned : lookupLearned(model.id),
  })
}

/** Adapter resolutions are asynchronous and can finish after an HMR swap. */
function profileMatchesRegistration(llm, profile) {
  if (profile?.adapter === undefined) return true
  try {
    return llm.adapters.get(profile.id)?.adapter === profile.adapter && profile.adapter.current() === profile.adapterSnapshot
  } catch (_error) {
    return false
  }
}

/** Resolve relay metadata, keeping local settings even if enrichment stalls. */
async function resolveEnrichment(options) {
  let enrichment
  let failure
  try {
    enrichment = typeof options.enrichment !== 'function'
      ? options.enrichment
      : await boundedOperation(signal => options.enrichment({ fresh: options.fresh === true, signal }), {
          signal: options.signal,
          timeoutMs: catalogTimeout(options.enrichmentTimeoutMs, DEFAULT_ENRICHMENT_TIMEOUT_MS),
          label: 'provider enrichment',
        })
  } catch (error) {
    options.signal?.throwIfAborted()
    failure = messageOf(error)
  }
  if (enrichment !== null && typeof enrichment === 'object') return enrichment
  try {
    // This is a synchronous snapshot of already available Host state; never
    // wait for another probe when the first one was unreliable.
    const fallback = options.fallbackEnrichment?.()
    if (fallback !== null && typeof fallback === 'object') {
      if (failure === undefined) return fallback
      const diagnostics = Array.isArray(fallback.diagnostics) ? fallback.diagnostics : []
      return { ...fallback, diagnostics: [...diagnostics, { id: '*', status: 'failed', message: failure }] }
    }
  } catch (_error) {
    // Best-effort only. The adapter catalog is independent of enrichment.
  }
  return undefined
}

/**
 * Build the whole capability catalog.
 *
 * Shape (wire-compatible with `session.modelCatalog` plus the extra fields):
 *
 * ```json
 * {
 *   "groups": [{ "id": "route", "name": "Route", "models": [{ "id", "name",
 *     "kind", "contextWindow", "inputModalities", "reasoning", "sources" }] }],
 *   "failures": [{ "id", "name", "message" }],
 *   "providers": [{ "id", "status", "models", "capabilities" }],
 *   "learned": { "models", "updatedAt?", "checker?" },
 *   "generatedAt": 1700000000000
 * }
 * ```
 *
 * Provider failures are isolated exactly like the shipped catalog. Empty
 * provider groups are dropped so the page never shows a header with no rows.
 * @param llm - the Host `ctx.llm` registry (or a test double).
 * @param options - `{ enrichment?, fallbackEnrichment?, fresh?, learned?,
 *   timeoutMs?, enrichmentTimeoutMs? }`. The local fallback is synchronous;
 *   `timeoutMs` bounds each adapter listing or model resolution.
 * @returns the catalog value.
 */
export async function describeCatalog(llm, options = {}) {
  const generatedAt = Date.now()
  const groups = []
  const failures = []
  const { signal, trace } = options
  signal?.throwIfAborted()
  const learnedStore = options.learned ?? defaultLearned
  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    traceEvent(trace, 'catalog', 'list-failed', { failed: 1 })
    return { groups, failures: [{ id: '*', name: 'providers', message: messageOf(error) }], providers: [], learned: catalogMeta(learnedStore), generatedAt }
  }
  const routes = (Array.isArray(providers) ? providers : []).filter(row => nonEmptyString(row?.id))
  const providerLimit = concurrency(options.providerConcurrency, 4, 8)
  const modelLimit = concurrency(options.modelConcurrency, 8, 16)
  const listSlot = options.listSlot ?? operationSlots(providerLimit)
  const resolveSlot = options.resolveSlot ?? operationSlots(modelLimit)
  traceEvent(trace, 'catalog', 'list', { providers: routes.length, concurrency: providerLimit })
  const standardEffortAvailable = createStandardEffortAvailability(options.settings, llm, options.configEditor)
  // Listing starts alongside enrichment, not after a possibly slow relay.
  const [enrichment, listings] = await Promise.all([
    resolveEnrichment(options),
    mapWorkers(routes, providerLimit, signal, async ({ id, name }) => {
      try {
        // The installed registry has no listModels signal parameter. Bound the
        // wait and check the parent generation before dispatching its successor.
        const registered = llm.adapters?.get?.(id)?.adapter
        const sameOwner = () => registered === llm.adapters?.get?.(id)?.adapter
        const value = await boundedOperation(local => listSlot(local, () => {
          if (!sameOwner()) throw new Error('provider route changed')
          return llm.listModels(id)
        }, sameOwner), {
          signal, timeoutMs: catalogTimeout(options.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS), label: `list models ${id}`,
        })
        const models = Array.isArray(value) ? value.filter(row => nonEmptyString(row?.id)) : []
        return { id, name: nonEmptyString(name) ?? id, models, registered }
      } catch (error) {
        signal?.throwIfAborted()
        return { id, name: nonEmptyString(name) ?? id, message: messageOf(error) }
      }
    }),
  ])
  const ready = []
  for (const route of listings) {
    if (route.message !== undefined) failures.push(route)
    else if (route.models.length) ready.push(route)
  }
  await mapWorkers(ready, providerLimit, signal, async route => {
    const candidate = enrichment?.profiles?.get?.(route.id)
    route.stale = !profileMatchesRegistration(llm, candidate)
    route.profile = route.stale ? undefined : candidate
    if (route.profile?.catalogProvider && !route.profile.catalogModels) {
      route.installedModels = await readInstalledModelIds(llm, { catalogProvider: true, provider: route.id, ns: route.profile.namespace }, signal)
      signal?.throwIfAborted()
      if (profileMatchesRegistration(llm, route.profile)) recordInstalledModels(options.installedCache, route.profile, route.installedModels)
    }
    route.discoveredIndex = indexDiscovered(route.profile === candidate ? enrichment?.discovered?.get?.(route.id) : undefined)
  })
  // One GLOBAL pool, not a pool per provider and not one Promise per model.
  // Assign each result to its catalog position, independent of completion order.
  function* jobs() {
    for (const route of ready) for (let i = 0; i < route.models.length; i++) yield [route, i]
  }
  const work = jobs()
  const total = ready.reduce((sum, route) => sum + route.models.length, 0)
  traceEvent(trace, 'catalog', 'resolve', { models: total, concurrency: modelLimit })
  let infoErrors = 0
  const samples = { failed: 6, advisory: 10, resolved: 8 }
  async function worker() {
    for (const [route, i] of work) {
      signal?.throwIfAborted()
      const model = route.models[i]
      const result = await describeModel(llm, route.id, model, {
        timeoutMs: options.timeoutMs, signal, profile: route.profile, installedModels: route.installedModels,
        resolveSlot, stale: route.stale || route.registered !== llm.adapters?.get?.(route.id)?.adapter,
        standardEffort: standardEffortAvailable(route.id, model.id, route.installedModels),
        discoveredIndex: route.discoveredIndex, override: options.overrides?.get?.(route.id, model.id),
        ...(learnedStore ? { learned: learnedStore.get?.(model.id) } : {}),
      })
      if (result.infoError !== undefined) infoErrors++
      if (trace?.enabled === true) {
        const status = result.infoError !== undefined ? 'failed' : Object.values(result.fieldEvidence).some(e => e.alias) ||
          ['unknown', 'inferred'].includes(result.sources.modalities) ? 'advisory' : 'resolved'
        if (samples[status] > 0) { samples[status]--; traceModel(trace, route.id, result, status) }
      }
      route.models[i] = result
    }
  }
  await Promise.all(Array.from({ length: Math.min(total, modelLimit) }, worker))
  signal?.throwIfAborted()
  for (const { id, name, models } of ready) groups.push({ id, name, models })
  traceEvent(trace, 'catalog', 'complete', { providers: groups.length, models: total, failures: failures.length, infoErrors })
  return {
    groups, failures, providers: Array.isArray(enrichment?.diagnostics) ? enrichment.diagnostics : [],
    learned: catalogMeta(learnedStore ?? defaultLearned), generatedAt,
  }
}

/** Non-secret provenance of the learned snapshot, for the page footer. */
function catalogMeta(store) {
  const meta = store?.meta?.()
  return {
    models: meta?.models ?? 0,
    ...(meta?.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
    ...(meta?.checker !== undefined ? { checker: meta.checker } : {}),
    // Lets a newer browser half detect an older Host half after an upgrade.
    // `reload` means the route understands `?reload=1` and drops every cache;
    // `overrides` means the Host persists and serves manual capability edits;
    // `verify` means the Host can sweep every model online; `usage` means the
    // Host serves the token-usage ledger; `checkerBudget` means the verify
    // sweep sizes its output budget and pins a reasoning effort (a Host
    // without it truncates every batch on a thinking checker).
    features: ['applyInput', 'reload', 'overrides', 'verify', 'usage', 'checkerBudget', 'verifyWeb', 'verifyFullScan', 'reasoningMappings', 'standardEffort', 'referencePrefill', 'verifyModes', 'verifySourceModes',
      'effortDirect', 'bulkEfforts', 'runId', 'diagnostics', 'versionInfo', 'visibilityIdentity'],
  }
}

/**
 * A cached reader around {@link describeCatalog}.
 *
 * One shared promise backs concurrent reads, so a page open cannot fan out into
 * one registry sweep per widget. `read({ fresh: true })` bypasses the TTL but
 * still joins an in-flight sweep.
 * @param llm - the Host `ctx.llm` registry.
 * @param options - `{ ttlMs?, now?, enrichment?, context? }`; `now` is
 *   injectable for tests and `context()` supplies `{ profiles, discovered }`
 *   synchronously for the request-side image decision.
 * @returns `{ read, peek, invalidate, imageInputAllowed, automaticWriteFact, dispose }`.
 */
export function createModelInfoService(llm, options = {}) {
  const ttlMs =
    Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const contextSource =
    typeof options.context === 'function' ? options.context : () => options.context

  let cached = null
  let cachedAt = -Infinity
  let inflight = null
  let disposed = false
  let lifetime = new AbortController()
  let installedCache = new WeakMap()
  // Keep underlying uncooperative calls bounded across invalidations and fresh reads.
  const listSlot = operationSlots(concurrency(options.providerConcurrency, 4, 8))
  const resolveSlot = operationSlots(concurrency(options.modelConcurrency, 8, 16))
  // Request-side image decisions share the same evidence merge as the page.
  // They are cached briefly because `read()` resolves every model once and each
  // resolution must not re-read the settings document.
  const imageCache = new Map()
  let gateWindow = -Infinity
  const gateSamples = new Set()
  const traceGate = (provider, model, reason, allowed, row) => {
    if (options.trace?.enabled !== true) return
    const stamp = now()
    if (stamp - gateWindow >= 10_000) { gateWindow = stamp; gateSamples.clear() }
    if (gateSamples.size >= 16) return
    const identity = traceRoute(provider, model)
    const key = JSON.stringify([identity.provider, identity.model, reason])
    if (gateSamples.has(key)) return
    gateSamples.add(key)
    traceEvent(options.trace, 'gate', 'decision', { ...identity, allowed, accepted: allowed, reason,
      ...(row ? { source: row.sources.modalities, alias: row.fieldEvidence.modalities?.alias === true,
        fields: ['kind', 'modalities'], input: (row.inputModalities ?? []).filter(m => TRACE_MODALITIES.has(m)).slice(0, 5) } : {}),
    })
  }
  let discoveryIndexes = new WeakMap()
  let imageCacheAt = 0
  const IMAGE_CACHE_MS = 30_000
  const clearImageCache = () => {
    imageCache.clear()
    discoveryIndexes = new WeakMap()
    imageCacheAt = now()
  }

  const read = (request = {}) => {
    const fresh = request !== null && typeof request === 'object' && request.fresh === true
    const stamp = now()
    if (disposed) return Promise.reject(new Error('catalog disposed'))
    if (!fresh && cached !== null && stamp - cachedAt < ttlMs) return Promise.resolve(cached)
    if (inflight !== null) return inflight
    const signal = request?.signal ? AbortSignal.any([lifetime.signal, request.signal]) : lifetime.signal
    const run = describeCatalog(llm, { ...options, listSlot, resolveSlot, installedCache, signal, fresh }).then(value => {
      signal.throwIfAborted()
      cached = value
      cachedAt = now()
      clearImageCache()
      return value
    }).finally(() => { if (inflight === run) inflight = null })
    inflight = run
    return run
  }

  /**
   * Whether image input should be admitted for one relay model.
   *
   * Use the page's field provenance; never admit based on a display name or widen an
   * explicit Provider input declaration or the adapter's installed catalog.
   * @param providerId - provider route id.
   * @param modelId - exact model id.
   * @param modelName - adapter display name, when available.
   * @returns whether this exact relay model may be widened by the plugin.
   */
  const imageInputAllowed = (providerId, modelId, modelName, snapshotRoute) => {
    if (disposed) return false
    const stamp = now()
    if (stamp - imageCacheAt > IMAGE_CACHE_MS) clearImageCache()
    let allowed = false
    try {
      const source = contextSource() ?? {}
      const profile = source.profiles?.get?.(providerId)
      if (snapshotRoute !== undefined) {
        const { adapter, snapshot, profile: adapterProfile, resolved } = snapshotRoute
        if (profile?.adapter !== adapter || profile?.adapterSnapshot !== snapshot || profile?.inputProvenance !== true ||
            profile?.baseURL !== resolved?.baseUrl || profile?.api !== resolved?.api ||
            adapterProfile?.provider !== providerId || resolved?.id !== modelId) {
          traceGate(providerId, modelId, 'route-mismatch', false)
          return false
        }
      }
      const key = snapshotRoute === undefined ? JSON.stringify([providerId, modelId, modelName]) : undefined
      // Request-side reads consult the override file's current last-good copy
      // instead of reusing an image answer from a previous route or edit.
      const known = snapshotRoute === undefined ? imageCache.get(key) : undefined
      if (known !== undefined) return known
      const discovery = source.discovered instanceof Map ? source.discovered.get(providerId) : undefined
      let discoveredIndex
      if (discovery instanceof Map) {
        discoveredIndex = discoveryIndexes.get(discovery)
        if (discoveredIndex === undefined) {
          discoveredIndex = indexDiscovered(discovery)
          discoveryIndexes.set(discovery, discoveredIndex)
        }
      }
      const overrides = source.overrides
      const decision = imageInputDecision(providerId, modelId, {
        modelName,
        profile,
        installedModels: installedFor(installedCache, profile),
        discovered: discovery,
        discoveredIndex,
        override: typeof overrides?.get === 'function' ? overrides.get(providerId, modelId) : undefined,
        learned:
          typeof source.learned === 'function'
            ? source.learned(modelId)
            : typeof source.learned?.get === 'function'
              ? source.learned.get(modelId)
              : source.learned,
      })
      allowed = decision.allowed
      traceGate(providerId, modelId, decision.reason, allowed, decision.record)
      if (snapshotRoute === undefined) {
        if (imageCache.size >= 512) imageCache.clear()
        imageCache.set(key, allowed)
      }
    } catch (_error) {
      // A capability read must never break the request path.
      allowed = false
    }
    return allowed
  }

  /** Verify only this exact route against its current configuration, adapter
   * and committed local facts. Never trigger a network enrichment for a write.
   * Any settings/adapter change during resolution, or missing authority, vetoes
   * the write. The caller applies its normal revision/ownership guard as well. */
  const automaticWriteFact = async (provider, model, proposed, request = {}) => {
    if (disposed || !proposed) return null
    const signal = request.signal ? AbortSignal.any([lifetime.signal, request.signal]) : lifetime.signal
    try {
      signal.throwIfAborted()
      const source = contextSource() ?? options.fallbackEnrichment?.()
      const profile = source?.profiles?.get?.(provider)
      if (!profile || !profileMatchesRegistration(llm, profile) || profile.catalogModels || !profile.models?.has(model)) return null
      const installedModels = installedFor(installedCache, profile)
      if (profile.catalogProvider && (installedModels?.has(model) ?? true)) return null
      const listed = request.listed?.id === model ? request.listed : { id: model }
      const ownerCurrent = () => profileMatchesRegistration(llm, profile)
      const info = await boundedOperation(local => resolveSlot(local, () => {
        if (!ownerCurrent()) throw new Error('provider route changed')
        return llm.resolveModelInfo(provider, model, local)
      }, ownerCurrent), {
        signal, timeoutMs: catalogTimeout(options.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS), label: 'resolve capability for write',
      })
      signal.throwIfAborted()
      const current = contextSource() ?? options.fallbackEnrichment?.()
      const currentProfile = current?.profiles?.get?.(provider)
      if (!info || (info.id !== undefined && info.id !== model) || (info.provider !== undefined && info.provider !== provider) ||
          !profileMatchesRegistration(llm, profile) || (!currentProfile || currentProfile.adapter !== profile.adapter ||
          currentProfile.adapterSnapshot !== profile.adapterSnapshot || !isDeepStrictEqual(currentProfile, profile))) return null
      const store = current.learned ?? options.learned
      store?.assertReadable?.()
      const learned = typeof store?.getExact === 'function' ? store.getExact(model) : request.learned
      if (learned?.id !== model) return null
      const overrides = current.overrides ?? options.overrides
      const override = typeof overrides?.snapshot === 'function' ? overrides.snapshot(provider, model).entry : overrides?.get?.(provider, model)
      const row = mergeCapabilities({ id: model, name: listed.name ?? model }, {
        profile, installedModels, adapter: describeResolvedModel(listed, info),
        // A fuzzy listing cannot veto stronger exact evidence or authorize writes.
        discovered: current.discovered?.get?.(provider)?.get?.(model),
        override, learned,
      })
      return selectAutomaticWriteFact(row, proposed)
    } catch { return null }
  }

  const invalidate = () => {
    lifetime.abort()
    installedCache = new WeakMap()
    if (!disposed) lifetime = new AbortController()
    traceEvent(options.trace, 'catalog', disposed ? 'dispose' : 'invalidate', { cancelled: inflight !== null })
    cached = null
    cachedAt = -Infinity
    inflight = null
    clearImageCache()
  }

  return { read, peek: () => cached, invalidate, imageInputAllowed, automaticWriteFact,
    dispose() {
      const pending = inflight
      disposed = true
      invalidate()
      return pending?.catch(() => {})
    },
  }
}
