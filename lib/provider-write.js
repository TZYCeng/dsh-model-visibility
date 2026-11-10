/**
 * Write manual capabilities into the model provider's own settings.
 *
 * A manual override fixes what the page shows, but the composer, the adapter
 * and every other reader still see the provider config. When the user edits a
 * model here they usually mean "this is what the model really is", so this
 * module mirrors the writable fields into the `llm-pi-ai` provider profile:
 * `input`, `contextWindow` and `reasoningEfforts`.
 *
 * Only provider fields with an exact equivalent are written:
 * - `kind` has no provider field (it is a display grouping);
 * - `defaultEffort` is not per model in the provider schema (the route-level
 *   `reasoning` default applies to a whole provider), so it stays local;
 * - an off-only ladder is rejected by the provider schema ("offers no level
 *   beyond off"), so it also stays local.
 *
 * The settings service exposes live, volatile provider configs; writing goes
 * through `settings.mutate(ns, ops)` with explicit path ops so the existing
 * `models` array entry is edited by index instead of being replaced wholesale
 * (`modelOverrides` is illegal once a `models` list exists, so appending is not
 * an option either).
 *
 * @module lib/provider-write
 */

/**
 * Effort keys the provider schema accepts.
 *
 * Must stay in lock-step with `llm-pi-ai`'s `reasoningEfforts` dict key schema.
 * A single unknown key rejects the entire `settings.mutate` op list, which also
 * silently discards the modalities and context window saved alongside it.
 */
export const PROVIDER_EFFORT_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/** Plain-object guard. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Best-effort message from an unknown thrown value. */
function messageOf(error) {
  if (error === null || error === undefined) return undefined
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Convert a manual ladder into the provider `reasoningEfforts` shape.
 *
 * `off` maps to `null` ("supported, send nothing"), every other level maps to
 * its own id as the wire value. Levels the provider schema cannot key are
 * dropped here rather than sent: one unknown key rejects the whole write, and
 * the user would lose the modalities and context window saved with it.
 *
 * Returns undefined when there is nothing worth writing: an unset ladder, a
 * ladder that only offers `off` (the schema rejects that as "offers no level
 * beyond off"), or one whose every level is unusable.
 * @param override - sanitized override entry.
 * @returns a provider ladder, `false` for "no reasoning", or undefined.
 */
export function effortsForProvider(override) {
  if (override?.reasoningSupported === false) return false
  if (!Array.isArray(override?.efforts) || override.efforts.length === 0) return undefined
  const ladder = {}
  let beyondOff = false
  for (const effort of override.efforts) {
    const raw = typeof effort === 'string' ? effort : effort?.id
    if (typeof raw !== 'string' || raw === '') continue
    const id = raw.toLowerCase()
    if (!PROVIDER_EFFORT_LEVELS.includes(id)) continue
    if (id === 'off') ladder.off = null
    else {
      ladder[id] = id
      beyondOff = true
    }
  }
  return beyondOff ? ladder : undefined
}

/**
 * The provider fields an override implies.
 *
 * These are the only fields this module mirrors; anything else an override
 * carries (`kind`, `defaultEffort`, an off-only ladder) has no provider
 * equivalent and stays in the local override file.
 * @param override - sanitized override entry.
 * @returns `{input?, contextWindow?, reasoningEfforts?}`; empty when nothing is writable.
 */
export function providerPatch(override) {
  const patch = {}
  if (Array.isArray(override?.input) && override.input.length > 0) patch.input = [...override.input]
  if (Number.isSafeInteger(override?.contextWindow) && override.contextWindow > 0) {
    patch.contextWindow = override.contextWindow
  }
  const efforts = effortsForProvider(override)
  if (efforts !== undefined) patch.reasoningEfforts = efforts
  return patch
}

/**
 * Find the settings entry that owns one provider.
 *
 * Several settings namespaces can carry a `providers` dict (for example a test
 * double or a future second adapter), so prefer the `llm-pi-ai` namespace and
 * otherwise fall back to the first namespace that declares the provider.
 * @param settings - the `settings` service.
 * @param providerId - provider id from the override.
 * @returns `{ns, models}` or undefined.
 */
export function findProviderEntry(settings, providerId) {
  if (typeof settings?.describe !== 'function' || typeof providerId !== 'string') return undefined
  const descriptors = settings.describe()
  if (!Array.isArray(descriptors)) return undefined
  const matches = []
  for (const descriptor of descriptors) {
    const providers = descriptor?.value?.providers
    if (!isRecord(providers)) continue
    const profile = providers[providerId]
    if (!isRecord(profile)) continue
    matches.push({
      ns: descriptor.ns,
      models: Array.isArray(profile.models) ? profile.models : undefined,
      preferred: String(descriptor.ns ?? '').includes('pi-ai') ? 1 : 0,
    })
  }
  if (matches.length === 0) return undefined
  matches.sort((left, right) => right.preferred - left.preferred)
  const best = matches[0]
  return { ns: best.ns, models: best.models }
}

/**
 * Mirror the writable parts of one override into the provider settings.
 *
 * Never throws: the caller keeps the local override when a write cannot happen,
 * so a read-only profile or a probe-only install still behaves like before.
 * @param settings - the `settings` service (needs `describe` and `mutate`).
 * @param override - sanitized override entry.
 * @returns `{written, fields, ns?, reason?, message?}`.
 */
export async function writeCapabilities(settings, override) {
  const fields = Object.keys(providerPatch(override))
  if (fields.length === 0) return { written: false, fields, reason: 'nothing' }
  if (typeof settings?.mutate !== 'function' || typeof settings?.describe !== 'function') {
    return { written: false, fields, reason: 'unsupported' }
  }

  let entry
  try {
    entry = findProviderEntry(settings, override.provider)
  } catch (error) {
    return { written: false, fields, reason: 'describe-failed', message: messageOf(error) }
  }
  if (entry === undefined) return { written: false, fields, reason: 'provider-missing' }
  if (entry.models === undefined) return { written: false, fields, reason: 'models-missing' }

  const index = entry.models.findIndex((model) => isRecord(model) && model.id === override.model)
  if (index < 0) return { written: false, fields, reason: 'model-missing' }

  const patch = providerPatch(override)
  const path = ['providers', override.provider, 'models', String(index)]
  const ops = fields.map((field) => ({ op: 'set', path: [...path, field], value: patch[field] }))
  try {
    await settings.mutate(entry.ns, ops)
  } catch (error) {
    return { written: false, fields, reason: 'settings-failed', message: messageOf(error) }
  }
  return { written: true, fields, ns: entry.ns }
}

/**
 * Remove the fields that have just been mirrored into the provider config.
 * @param override - sanitized override entry that was written.
 * @param fields - fields reported as written.
 * @returns the remaining local override (may contain only provider/model).
 */
export function stripWrittenFields(override, fields) {
  const remaining = { provider: override.provider, model: override.model }
  if (!fields.includes('input') && override.input !== undefined) remaining.input = override.input
  if (!fields.includes('contextWindow') && override.contextWindow !== undefined) {
    remaining.contextWindow = override.contextWindow
  }
  if (!fields.includes('reasoningEfforts')) {
    if (override.efforts !== undefined) remaining.efforts = override.efforts
    if (override.defaultEffort !== undefined) remaining.defaultEffort = override.defaultEffort
    if (override.reasoningSupported === false) remaining.reasoningSupported = false
  }
  if (override.kind !== undefined) remaining.kind = override.kind
  return remaining
}
