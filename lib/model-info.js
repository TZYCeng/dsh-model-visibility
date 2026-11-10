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
 * plainly multimodal. This module therefore merges four evidence layers and
 * records which one supplied each fact:
 *
 *   1. `config`   — the model entry in the settings document (explicit input,
 *                   context window, or a provider default that names a
 *                   non-text modality). This is the strongest evidence.
 *   2. `adapter`  — `resolveModelInfo`. Trusted when the provider is not
 *                   configured through settings (built-in adapters) or when the
 *                   configured model declares the field.
 *   3. `provider` — capability fields found by probing the relay's own
 *                   `/v1/models` (see `provider-probe.js`).
 *   4. `snapshot` — a verified fact from the learned local snapshot
 *                   (`lib/learned-catalog.js`), seeded by the settings page's
 *                   online verification run.
 *   5. `inferred` — conservative name rules for well-known model families.
 *
 * The browser renders `snapshot`/`inferred` facts with a dashed tag and explains
 * the source in the tooltip; a missing fact stays "unknown" instead of becoming
 * a false "text only".
 *
 * Nothing in this module imports DSH internals: the only contract is the small
 * slice of `ctx.llm` used by {@link describeCatalog}, which keeps the probe
 * unit-testable with a plain object.
 *
 * @module lib/model-info
 */

import {
  MODEL_KINDS,
  inferInputModalities,
  inferModelKind,
} from './capability-catalog.js'
import { lookupCorrection } from './capability-corrections.js'
import { modelIdVariants } from './model-id.js'
import { createLearnedCatalog } from './learned-catalog.js'

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

/** Detach one modality list (first occurrence wins), or undefined. */
function modalityList(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || out.includes(item)) continue
    out.push(item)
  }
  return out.length > 0 ? out : undefined
}

/** Read a Map entry by key, tolerating a plain object in tests. */
function mapGet(map, key) {
  if (map === null || map === undefined) return undefined
  if (typeof map.get === 'function') return map.get(key)
  return map[key]
}

/**
 * Detach a reasoning ladder into JSON-safe plain objects.
 *
 * Invalid efforts are dropped rather than rejecting the whole model: a single
 * malformed catalog row must not blank the settings page. An empty ladder is
 * treated as "no reasoning metadata", because the composer hides the effort row
 * in that case too.
 * @param reasoning - adapter-owned reasoning metadata, possibly malformed.
 * @returns `{ efforts, defaultEffort? }`, or undefined.
 */
export function detachReasoning(reasoning) {
  if (reasoning === null || typeof reasoning !== 'object') return undefined
  const source = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  const efforts = []
  const seen = new Set()
  for (const effort of source) {
    if (effort === null || typeof effort !== 'object') continue
    const id = nonEmptyString(effort.id)
    const name = nonEmptyString(effort.name)
    if (id === undefined || name === undefined || seen.has(id)) continue
    seen.add(id)
    const description = nonEmptyString(effort.description)
    efforts.push({
      id,
      name,
      ...(description === undefined ? {} : { description }),
    })
  }
  if (efforts.length === 0) return undefined
  const fallback = nonEmptyString(reasoning.defaultEffort)
  return {
    efforts,
    ...(fallback === undefined || !seen.has(fallback) ? {} : { defaultEffort: fallback }),
  }
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
 * Relays spell ids slightly differently from the configured model id
 * (case, `:free` suffix, vendor prefix), so both the exact id and every
 * normalized variant resolve to the same entry.
 * @param entries - Map of advertised id -> discovered facts.
 * @returns a Map of lookup key -> discovered facts.
 */
export function indexDiscovered(entries) {
  const index = new Map()
  if (entries === null || entries === undefined) return index
  const source = entries instanceof Map ? entries : new Map(Object.entries(entries))
  for (const [id, entry] of source) {
    if (!index.has(id)) index.set(id, entry)
    const lower = id.toLowerCase()
    if (!index.has(lower)) index.set(lower, entry)
    for (const variant of modelIdVariants(id)) {
      if (!index.has(variant)) index.set(variant, entry)
    }
  }
  return index
}

/** Find one discovered entry by exact id, lowercase, then normalized variants. */
function findDiscovered(index, id) {
  if (index === null || index === undefined) return undefined
  const exact = index.get(id)
  if (exact !== undefined) return exact
  const lower = index.get(id.toLowerCase())
  if (lower !== undefined) return lower
  for (const variant of modelIdVariants(id)) {
    const found = index.get(variant)
    if (found !== undefined) return found
  }
  return undefined
}

/** Does a provider default declare a non-text input modality? */
function multiModalDefault(input) {
  return Array.isArray(input) && input.some((item) => item !== 'text')
}

/**
 * Merge every evidence layer into the record the settings page consumes.
 *
 * Exported for unit tests: it is pure and takes plain values.
 * @param base - `{ id, name, description? }`.
 * @param context - `{ adapter?, infoError?, profile?, configured?, discovered?, learned?, override? }`
 * @returns a detached model record with per-field sources.
 */
export function mergeCapabilities(base, context = {}) {
  const adapter = context.adapter
  const profile = context.profile
  const configured = context.configured ?? mapGet(profile?.models, base.id)
  const discovered = context.discovered
  const override = context.override
  const learned = context.learned ?? lookupLearned(base.id)
  const sources = {}
  let learnedUsed = false
  let learnedRecord = null

  const useLearned = (record) => {
    learnedUsed = true
    if (record !== null && typeof record === 'object') learnedRecord = record
  }

  /* ---------------------------------------------------------------- kind */

  const inferredKind = inferModelKind(base.id, base.name)
  let kind
  if (discovered?.kind !== undefined) {
    kind = discovered.kind
    sources.kind = 'provider'
  } else if (learned?.type !== undefined) {
    kind = learned.type
    sources.kind = 'snapshot'
    useLearned(learned)
  } else if (inferredKind !== undefined) {
    kind = inferredKind
    sources.kind = 'inferred'
  } else {
    kind = 'chat'
    sources.kind = 'unknown'
  }

  // A manual kind is the user's own statement about the route, so it outranks
  // every automatic layer. It is applied before the modality step because the
  // name heuristic only runs for chat models.
  if (typeof override?.kind === 'string' && MODEL_KINDS.includes(override.kind)) {
    kind = override.kind
    sources.kind = 'manual'
  }

  /* --------------------------------------------------------- modalities */

  let inputModalities
  let modalitySource = 'unknown'
  const configuredInput = modalityList(configured?.input)
  const adapterInput = detachModalities(adapter?.inputModalities)
  const profileExists = profile !== undefined

  if (configuredInput !== undefined) {
    inputModalities = configuredInput
    modalitySource = 'config'
  } else if (!profileExists && adapterInput !== undefined) {
    // Built-in adapter: `inputModalities` is the adapter's own declaration.
    inputModalities = adapterInput
    modalitySource = 'adapter'
  } else if (profileExists && configured === undefined && adapterInput !== undefined) {
    // The route serves a model outside its configured list, so the adapter
    // resolved it from its installed catalog rather than a `defaultInput`.
    inputModalities = adapterInput
    modalitySource = 'adapter'
  } else if (profileExists && configuredInput === undefined && multiModalDefault(profile?.defaultInput)) {
    // An explicit multi-modal provider default is a declaration, unlike the
    // implicit text-only fallback that causes the "everything is text" bug.
    inputModalities = profile.defaultInput
    modalitySource = 'config'
  }

  if (inputModalities === undefined && discovered?.inputModalities !== undefined) {
    inputModalities = modalityList(discovered.inputModalities)
    if (inputModalities !== undefined) modalitySource = 'provider'
  }
  if (inputModalities === undefined && learned?.input !== undefined) {
    inputModalities = modalityList(learned.input)
    if (inputModalities !== undefined) {
      modalitySource = 'snapshot'
      useLearned(learned)
    }
  }
  if (inputModalities === undefined && kind === 'chat') {
    const inferred = inferInputModalities(base.id, base.name)
    if (inferred !== undefined) {
      inputModalities = inferred
      modalitySource = 'inferred'
    }
  }

  // A vendor-documented correction outranks a wrong snapshot row and a relay
  // listing (relays commonly mirror the snapshot), but never an explicit
  // provider declaration or a built-in adapter: those describe the route the
  // user actually configured.
  const correction = lookupCorrection(base.id)
  let correctionApplied = false
  if (
    correction?.input !== undefined &&
    (modalitySource === 'snapshot' ||
      modalitySource === 'inferred' ||
      modalitySource === 'unknown' ||
      modalitySource === 'provider')
  ) {
    const corrected = modalityList(correction.input)
    if (corrected !== undefined) {
      inputModalities = corrected
      modalitySource = 'official'
      correctionApplied = true
    }
  }

  if (override?.input !== undefined) {
    const manualInput = modalityList(override.input)
    if (manualInput !== undefined) {
      inputModalities = manualInput
      modalitySource = 'manual'
    }
  }

  /* ------------------------------------------------------------- context */

  let contextWindow
  let contextSource = 'unknown'
  const configuredContext = positiveInteger(configured?.contextWindow)
  const adapterContext = positiveInteger(adapter?.contextWindow)
  if (configuredContext !== undefined) {
    contextWindow = configuredContext
    contextSource = 'config'
  } else if (!profileExists && adapterContext !== undefined) {
    contextWindow = adapterContext
    contextSource = 'adapter'
  } else if (profileExists && configured === undefined && adapterContext !== undefined) {
    contextWindow = adapterContext
    contextSource = 'adapter'
  }
  if (contextWindow === undefined && discovered?.contextWindow !== undefined) {
    contextWindow = positiveInteger(discovered.contextWindow)
    if (contextWindow !== undefined) contextSource = 'provider'
  }
  if (contextWindow === undefined && learned?.contextWindow !== undefined) {
    contextWindow = positiveInteger(learned.contextWindow)
    if (contextWindow !== undefined) {
      contextSource = 'snapshot'
      useLearned(learned)
    }
  }
  const manualContext = positiveInteger(override?.contextWindow)
  if (manualContext !== undefined) {
    contextWindow = manualContext
    contextSource = 'manual'
  }

  /* ----------------------------------------------------------- reasoning */

  let reasoning = detachReasoning(adapter?.reasoning)
  let reasoningSupported
  let reasoningSource = 'unknown'
  if (reasoning !== undefined) {
    reasoningSupported = true
    reasoningSource = configured?.reasoningEfforts !== undefined ? 'config' : 'adapter'
  } else if (discovered?.reasoning !== undefined) {
    reasoningSupported = discovered.reasoning === true
    reasoningSource = 'provider'
  } else if (learned?.reasoning !== undefined) {
    reasoningSupported = learned.reasoning === true
    // A learned fact that carries a verified ladder also supplies the ladder.
    const ladder = detachReasoning({
      efforts: learned.reasoningEfforts,
      defaultEffort: learned.defaultEffort,
    })
    if (ladder !== undefined) reasoning = ladder
    reasoningSource = 'snapshot'
    useLearned(learned)
  }

  // A manual ladder is the requested fix for relays that publish no effort
  // levels at all. An explicit "no reasoning" declaration is the other half of
  // the same switch.
  if (override?.efforts !== undefined) {
    const manualReasoning = detachReasoning({
      efforts: override.efforts,
      defaultEffort: override.defaultEffort,
    })
    if (manualReasoning !== undefined) {
      reasoning = manualReasoning
      reasoningSupported = true
      reasoningSource = 'manual'
    }
  } else if (override?.reasoningSupported === false) {
    reasoning = undefined
    reasoningSupported = false
    reasoningSource = 'manual'
  }

  /* ----------------------------------------------------------- max tokens */

  let defaultMaxTokens
  const configuredMaxTokens = positiveInteger(configured?.maxTokens)
  const adapterMaxTokens = positiveInteger(adapter?.defaultMaxTokens)
  if (configuredMaxTokens !== undefined) defaultMaxTokens = configuredMaxTokens
  else if (!profileExists && adapterMaxTokens !== undefined) defaultMaxTokens = adapterMaxTokens
  else if (profileExists && configured === undefined && adapterMaxTokens !== undefined) {
    defaultMaxTokens = adapterMaxTokens
  }
  if (defaultMaxTokens === undefined && discovered?.maxTokens !== undefined) {
    defaultMaxTokens = positiveInteger(discovered.maxTokens)
  }
  if (defaultMaxTokens === undefined && learned?.maxTokens !== undefined) {
    defaultMaxTokens = positiveInteger(learned.maxTokens)
  }

  /* --------------------------------------------------------- output side */

  const outputModalities =
    modalityList(discovered?.outputModalities) ??
    modalityList(learned?.output) ??
    (kind === 'image'
      ? ['image']
      : kind === 'video'
        ? ['video']
        : kind === 'audio'
          ? ['audio']
          : undefined)

  return {
    ...base,
    kind,
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reasoningSupported === undefined ? {} : { reasoningSupported }),
    sources: {
      kind: sources.kind,
      modalities: modalitySource,
      context: contextSource,
      reasoning: reasoningSource,
    },
    ...(correctionApplied
      ? {
          correction: {
            id: correction.id,
            code: correction.code,
            note: correction.note,
            ...(correction.source === undefined ? {} : { source: correction.source }),
          },
        }
      : {}),
    ...(learnedUsed && learnedRecord !== null
      ? {
          learned: {
            id: learnedRecord.id ?? base.id,
            ...(Number.isSafeInteger(learnedRecord.verifiedAt)
              ? { verifiedAt: learnedRecord.verifiedAt }
              : {}),
            ...(Array.isArray(learnedRecord.origins) && learnedRecord.origins.length > 0
              ? { origins: [...learnedRecord.origins] }
              : {}),
            ...(learnedRecord.checker !== undefined ? { checker: learnedRecord.checker } : {}),
          },
        }
      : {}),
    ...(context.infoError === undefined ? {} : { infoError: context.infoError }),
  }
}

/**
 * Decide whether the composer may attach images to one relay model.
 *
 * This is the request-side counterpart of the modality tag: it runs the same
 * evidence merge (without the adapter info, which is what the caller is about
 * to override) and reports whether the displayed capability says "image
 * input". Only relay profiles are eligible: a built-in adapter already
 * declares its own modalities and must not be overridden from a catalog row.
 *
 * @param providerId - provider route the model belongs to.
 * @param modelId - exact model id.
 * @param context - `{ profile?, configured?, discovered? }`; `discovered` is
 *   either one provider's id->entry Map or one entry.
 * @returns `{ allowed, record?, reason }`; pure and synchronous.
 */
export function imageInputDecision(providerId, modelId, context = {}) {
  const profile = context.profile
  if (profile === undefined) return { allowed: false, reason: 'no-profile' }
  const configured = context.configured ?? mapGet(profile.models, modelId)
  const discoveredIndex =
    context.discovered instanceof Map
      ? context.discovered
      : context.discovered === undefined
        ? new Map()
        : indexDiscovered(new Map([[context.discovered.id, context.discovered]]))
  const discovered = findDiscovered(discoveredIndex, modelId)
  const record = mergeCapabilities(
    { id: modelId, name: modelId },
    { profile, configured, discovered, override: context.override, learned: context.learned },
  )
  const modalities = Array.isArray(record.inputModalities) ? record.inputModalities : []
  if (record.kind !== 'chat') return { allowed: false, record, reason: 'non-chat' }
  if (modalities.includes('image')) return { allowed: true, record, reason: 'image' }
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
  try {
    info = await llm.resolveModelInfo(providerId, model.id)
  } catch (error) {
    infoError = messageOf(error)
  }
  const adapter = info === undefined ? undefined : describeResolvedModel(base, info)
  const profile = context.profile
  const discovered = findDiscovered(
    context.discoveredIndex ?? indexDiscovered(context.discovered),
    model.id,
  )
  return mergeCapabilities(base, {
    adapter,
    infoError,
    profile,
    configured: mapGet(profile?.models, model.id),
    discovered,
    override: context.override,
    learned: context.learned ?? lookupLearned(model.id),
  })
}

/** Resolve the enrichment snapshot for one sweep. */
async function resolveEnrichment(options, fresh) {
  if (typeof options.enrichment !== 'function') return options.enrichment
  try {
    return await options.enrichment({ fresh })
  } catch (_error) {
    // Capability enrichment is best-effort; the adapter registry still works.
    return undefined
  }
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
 * @param options - `{ enrichment?, fresh?, learned? }`; `learned` is the
 *   Host-owned learned-catalog store backing the `snapshot` evidence layer.
 * @returns the catalog value.
 */
export async function describeCatalog(llm, options = {}) {
  const generatedAt = Date.now()
  const groups = []
  const failures = []
  // Adopting the caller's store here also points the module-level fallback at
  // the Host's single mtime-memoized read; direct consumers without a store
  // keep their lazy default.
  if (options.learned !== undefined) defaultLearned = options.learned
  const learnedStore = options.learned ?? (defaultLearned ?? undefined)
  const enrichment = await resolveEnrichment(options, options.fresh === true)
  const profiles = enrichment?.profiles instanceof Map ? enrichment.profiles : new Map()
  const discovered = enrichment?.discovered instanceof Map ? enrichment.discovered : new Map()
  const overrides = options.overrides

  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return {
      groups,
      failures: [{ id: '*', name: 'providers', message: messageOf(error) }],
      providers: [],
      learned: catalogMeta(),
      generatedAt,
    }
  }

  // Providers are probed concurrently but reported in catalog order; a slow
  // adapter must not delay the page behind every other provider.
  const results = await Promise.all(
    (Array.isArray(providers) ? providers : []).map(async (provider) => {
      if (provider === null || typeof provider !== 'object') return null
      const id = nonEmptyString(provider.id)
      if (id === undefined) return null
      const name = nonEmptyString(provider.name) ?? id
      try {
        const models = await llm.listModels(id)
        const listed = Array.isArray(models) ? models : []
        const profile = profiles.get(id)
        const discoveredIndex = indexDiscovered(discovered.get(id))
        const entries = await Promise.all(
          listed
            .filter((model) => model !== null && typeof model === 'object' && nonEmptyString(model.id) !== undefined)
            .map((model) =>
              describeModel(llm, id, model, {
                profile,
                discoveredIndex,
                override: typeof overrides?.get === 'function' ? overrides.get(id, model.id) : undefined,
                learned: learnedStore?.get?.(model.id),
              }),
            ),
        )
        return entries.length === 0 ? null : { kind: 'group', group: { id, name, models: entries } }
      } catch (error) {
        return { kind: 'failure', failure: { id, name, message: messageOf(error) } }
      }
    }),
  )

  for (const result of results) {
    if (result === null) continue
    if (result.kind === 'group') groups.push(result.group)
    else failures.push(result.failure)
  }

  return {
    groups,
    failures,
    providers: Array.isArray(enrichment?.diagnostics) ? enrichment.diagnostics : [],
    learned: catalogMeta(),
    generatedAt,
  }
}

/** Non-secret provenance of the learned snapshot, for the page footer. */
function catalogMeta() {
  const meta = defaultLearned?.meta?.()
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
    features: ['applyInput', 'reload', 'overrides', 'verify', 'usage', 'checkerBudget'],
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
 * @returns `{ read, invalidate, imageInputAllowed }`.
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
  let generation = 0
  // Request-side image decisions share the same evidence merge as the page.
  // They are cached briefly because `read()` resolves every model once and each
  // resolution must not re-read the settings document.
  const imageCache = new Map()
  let imageCacheAt = 0
  const IMAGE_CACHE_MS = 30_000

  const read = (request = {}) => {
    const fresh = request !== null && typeof request === 'object' && request.fresh === true
    const stamp = now()
    if (!fresh && cached !== null && stamp - cachedAt < ttlMs) {
      return Promise.resolve(cached)
    }
    if (inflight !== null) return inflight
    const startedAt = generation
    const run = describeCatalog(llm, {
      enrichment: options.enrichment,
      overrides: options.overrides,
      learned: options.learned,
      fresh,
    })
      .then((value) => {
        // A sweep that was invalidated while running must not repopulate the
        // cache with facts the invalidation was meant to discard.
        if (generation === startedAt) {
          cached = value
          cachedAt = now()
          // The sweep resolved every model; decisions taken before the probe
          // finished may have missed relay-advertised capabilities.
          imageCache.clear()
          imageCacheAt = now()
        }
        return value
      })
      .finally(() => {
        // `invalidate()` may have started a newer sweep while this one ran;
        // only clear the slot this promise owns.
        if (inflight === run) inflight = null
      })
    inflight = run
    return run
  }

  /**
   * Whether image input should be admitted for one relay model.
   *
   * The answer comes from the same evidence the page renders, so the composer
   * and the tag cannot disagree. Only configured relays are eligible; built-in
   * adapters already declare their own modalities.
   * @param providerId - provider route id.
   * @param modelId - exact model id.
   * @returns true when the model is displayed as accepting images.
   */
  const imageInputAllowed = (providerId, modelId) => {
    const stamp = now()
    if (stamp - imageCacheAt > IMAGE_CACHE_MS) {
      imageCache.clear()
      imageCacheAt = stamp
    }
    const key = String(providerId) + '\u0000' + String(modelId)
    const known = imageCache.get(key)
    if (known !== undefined) return known
    let allowed = false
    try {
      const source = contextSource() ?? {}
      const profiles = source.profiles instanceof Map ? source.profiles : undefined
      const discovered = source.discovered instanceof Map ? source.discovered : undefined
      const overrides = source.overrides
      allowed = imageInputDecision(providerId, modelId, {
        profile: profiles?.get(providerId),
        discovered: discovered?.get(providerId),
        override: typeof overrides?.get === 'function' ? overrides.get(providerId, modelId) : undefined,
        learned:
          typeof source.learned === 'function'
            ? source.learned(modelId)
            : typeof source.learned?.get === 'function'
              ? source.learned.get(modelId)
              : source.learned,
      }).allowed
    } catch (_error) {
      // A capability read must never break the request path.
      allowed = false
    }
    imageCache.set(key, allowed)
    return allowed
  }

  const invalidate = () => {
    generation += 1
    cached = null
    cachedAt = -Infinity
    inflight = null
    imageCache.clear()
    imageCacheAt = now()
  }

  return { read, invalidate, imageInputAllowed }
}
