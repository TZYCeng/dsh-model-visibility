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
 *   4. `catalog`  — the pi-ai / models.dev snapshot (see `capability-catalog.js`).
 *   5. `inferred` — conservative name rules for well-known model families.
 *
 * The browser renders `catalog`/`inferred` facts with a dashed tag and explains
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
  CATALOG_GENERATED_AT,
  CATALOG_PI_AI_VERSION,
  MODEL_CATALOG,
  inferInputModalities,
  inferModelKind,
  lookupCatalogModel,
  modelIdVariants,
} from './capability-catalog.js'

export { CATALOG_GENERATED_AT, CATALOG_PI_AI_VERSION }

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
 * @param context - `{ adapter?, infoError?, profile?, configured?, discovered?, catalogEntry? }`.
 * @returns a detached model record with per-field sources.
 */
export function mergeCapabilities(base, context = {}) {
  const adapter = context.adapter
  const profile = context.profile
  const configured = context.configured ?? mapGet(profile?.models, base.id)
  const discovered = context.discovered
  const catalogEntry = context.catalogEntry ?? lookupCatalogModel(base.id)
  const sources = {}
  let catalogUsed = false

  const useCatalog = () => {
    catalogUsed = true
  }

  /* ---------------------------------------------------------------- kind */

  const inferredKind = inferModelKind(base.id, base.name)
  let kind
  if (discovered?.kind !== undefined) {
    kind = discovered.kind
    sources.kind = 'provider'
  } else if (catalogEntry?.type !== undefined) {
    kind = catalogEntry.type
    sources.kind = 'catalog'
    useCatalog()
  } else if (inferredKind !== undefined) {
    kind = inferredKind
    sources.kind = 'inferred'
  } else {
    kind = 'chat'
    sources.kind = 'unknown'
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
  if (inputModalities === undefined && catalogEntry?.input !== undefined) {
    inputModalities = modalityList(catalogEntry.input)
    if (inputModalities !== undefined) {
      modalitySource = 'catalog'
      useCatalog()
    }
  }
  if (inputModalities === undefined && kind === 'chat') {
    const inferred = inferInputModalities(base.id, base.name)
    if (inferred !== undefined) {
      inputModalities = inferred
      modalitySource = 'inferred'
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
  if (contextWindow === undefined && catalogEntry?.contextWindow !== undefined) {
    contextWindow = positiveInteger(catalogEntry.contextWindow)
    if (contextWindow !== undefined) {
      contextSource = 'catalog'
      useCatalog()
    }
  }

  /* ----------------------------------------------------------- reasoning */

  const reasoning = detachReasoning(adapter?.reasoning)
  let reasoningSupported
  let reasoningSource = 'unknown'
  if (reasoning !== undefined) {
    reasoningSupported = true
    reasoningSource = configured?.reasoningEfforts !== undefined ? 'config' : 'adapter'
  } else if (discovered?.reasoning !== undefined) {
    reasoningSupported = discovered.reasoning === true
    reasoningSource = 'provider'
  } else if (catalogEntry?.reasoning !== undefined) {
    reasoningSupported = catalogEntry.reasoning === true
    reasoningSource = 'catalog'
    useCatalog()
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
  if (defaultMaxTokens === undefined && catalogEntry?.maxTokens !== undefined) {
    defaultMaxTokens = positiveInteger(catalogEntry.maxTokens)
  }

  /* --------------------------------------------------------- output side */

  const outputModalities =
    modalityList(discovered?.outputModalities) ??
    modalityList(catalogEntry?.output) ??
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
    ...(catalogUsed
      ? {
          catalog: {
            id: catalogEntry.id,
            ...(nonEmptyString(catalogEntry.provider) === undefined
              ? {}
              : { provider: catalogEntry.provider }),
            ...(CATALOG_GENERATED_AT === null ? {} : { generatedAt: CATALOG_GENERATED_AT }),
          },
        }
      : {}),
    ...(context.infoError === undefined ? {} : { infoError: context.infoError }),
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
 * @param context - `{ profile?, discovered? }` enrichment for this provider.
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
 *   "catalog": { "generatedAt", "piAiVersion", "models" },
 *   "generatedAt": 1700000000000
 * }
 * ```
 *
 * Provider failures are isolated exactly like the shipped catalog. Empty
 * provider groups are dropped so the page never shows a header with no rows.
 * @param llm - the Host `ctx.llm` registry (or a test double).
 * @param options - `{ enrichment?, fresh? }`.
 * @returns the catalog value.
 */
export async function describeCatalog(llm, options = {}) {
  const generatedAt = Date.now()
  const groups = []
  const failures = []
  const enrichment = await resolveEnrichment(options, options.fresh === true)
  const profiles = enrichment?.profiles instanceof Map ? enrichment.profiles : new Map()
  const discovered = enrichment?.discovered instanceof Map ? enrichment.discovered : new Map()

  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return {
      groups,
      failures: [{ id: '*', name: 'providers', message: messageOf(error) }],
      providers: [],
      catalog: catalogMeta(),
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
            .map((model) => describeModel(llm, id, model, { profile, discoveredIndex })),
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
    catalog: catalogMeta(),
    generatedAt,
  }
}

/** Non-secret provenance of the bundled snapshot, for the page footer. */
function catalogMeta() {
  return {
    generatedAt: CATALOG_GENERATED_AT ?? null,
    piAiVersion: CATALOG_PI_AI_VERSION ?? null,
    models: Object.keys(MODEL_CATALOG).length,
  }
}

/**
 * A cached reader around {@link describeCatalog}.
 *
 * One shared promise backs concurrent reads, so a page open cannot fan out into
 * one registry sweep per widget. `read({ fresh: true })` bypasses the TTL but
 * still joins an in-flight sweep.
 * @param llm - the Host `ctx.llm` registry.
 * @param options - `{ ttlMs?, now?, enrichment? }`; `now` is injectable for tests.
 * @returns `{ read, invalidate }`.
 */
export function createModelInfoService(llm, options = {}) {
  const ttlMs =
    Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now

  let cached = null
  let cachedAt = -Infinity
  let inflight = null
  let generation = 0

  const read = (request = {}) => {
    const fresh = request !== null && typeof request === 'object' && request.fresh === true
    const stamp = now()
    if (!fresh && cached !== null && stamp - cachedAt < ttlMs) {
      return Promise.resolve(cached)
    }
    if (inflight !== null) return inflight
    const startedAt = generation
    inflight = describeCatalog(llm, { enrichment: options.enrichment, fresh })
      .then((value) => {
        // A sweep that was invalidated while running must not repopulate the
        // cache with facts the invalidation was meant to discard.
        if (generation === startedAt) {
          cached = value
          cachedAt = now()
        }
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  const invalidate = () => {
    generation += 1
    cached = null
    cachedAt = -Infinity
    inflight = null
  }

  return { read, invalidate }
}
