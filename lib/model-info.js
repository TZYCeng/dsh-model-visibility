/**
 * Host-side model capability probe.
 *
 * The shipped browser catalog (`session.modelCatalog`) deliberately carries only
 * the identity and the reasoning ladder of every routable model. The model
 * visibility page wants three more facts that the LLM registry already knows but
 * the catalog projection drops:
 *
 * - the context window (`LlmResolvedModelInfo.context.contextWindow`),
 * - the accepted input modalities (`inputModalities`, e.g. text + image),
 * - the output-token default (`defaultMaxTokens`), used as a tooltip only.
 *
 * Everything here resolves through `ctx.llm` — the same registry the official
 * model menu uses — so the page can never disagree with the composer about
 * whether a model supports reasoning or which efforts it publishes.
 *
 * The registry is interrogated per model and some adapters answer from the
 * network, so a short-lived cache fronts `describeCatalog`. The cache is
 * invalidated by the plugin on `llm/adapters-updated` and
 * `settings/document-updated`; the browser may also ask for a fresh read with
 * `?fresh=1`.
 *
 * Nothing in this module imports DSH internals: the only contract is the small
 * slice of `ctx.llm` used by {@link describeCatalog}, which keeps the probe
 * unit-testable with a plain object.
 *
 * @module lib/model-info
 */

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
 * Project one resolved model into the wire shape the settings page consumes.
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
 * Describe one catalog model through the registry.
 *
 * A resolver failure is reported as `infoError` on the model instead of
 * removing it: the visibility switch must stay usable even when an adapter
 * cannot answer, and the page renders the unknown facts as such.
 * @param llm - the Host `ctx.llm` registry (or a test double).
 * @param providerId - provider route the model belongs to.
 * @param model - catalog entry `{ id, name?, description?, inputModalities? }`.
 * @returns a detached model record.
 */
export async function describeModel(llm, providerId, model) {
  const base = {
    id: model.id,
    name: nonEmptyString(model.name) ?? model.id,
    ...(nonEmptyString(model.description) === undefined
      ? {}
      : { description: model.description }),
  }
  try {
    const info = await llm.resolveModelInfo(providerId, model.id)
    return { ...base, ...describeResolvedModel(base, info) }
  } catch (error) {
    return { ...base, infoError: messageOf(error) }
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
 *     "contextWindow", "inputModalities", "reasoning": { "efforts", "defaultEffort" } }] }],
 *   "failures": [{ "id", "name", "message" }],
 *   "generatedAt": 1700000000000
 * }
 * ```
 *
 * Provider failures are isolated exactly like the shipped catalog. Empty
 * provider groups are dropped so the page never shows a header with no rows.
 * @param llm - the Host `ctx.llm` registry (or a test double).
 * @returns the catalog value.
 */
export async function describeCatalog(llm) {
  const generatedAt = Date.now()
  const groups = []
  const failures = []

  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return {
      groups,
      failures: [{ id: '*', name: 'providers', message: messageOf(error) }],
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
        const entries = await Promise.all(
          listed
            .filter((model) => model !== null && typeof model === 'object' && nonEmptyString(model.id) !== undefined)
            .map((model) => describeModel(llm, id, model)),
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

  return { groups, failures, generatedAt }
}

/**
 * A cached reader around {@link describeCatalog}.
 *
 * One shared promise backs concurrent reads, so a page open cannot fan out into
 * one registry sweep per widget. `read({ fresh: true })` bypasses the TTL but
 * still joins an in-flight sweep.
 * @param llm - the Host `ctx.llm` registry.
 * @param options - `{ ttlMs?, now? }`; `now` is injectable for tests.
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
    inflight = describeCatalog(llm)
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
