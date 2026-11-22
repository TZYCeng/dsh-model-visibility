/** Read-only bulk planning. No adapter discovery, fetch, credentials or write APIs. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { inferModelKind } from './capability-catalog.js'
import { directEffortPolicy, findRegisteredTarget, findSettingsEntry, isPiAiRouteAdapter, isPiAiSettingsOwner,
  ownAt, PROVIDER_EFFORT_LEVELS, providerPatch, rawSettingsEntries } from './provider-write.js'

export const routeKey = (provider, model) => JSON.stringify([provider, model])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const idString = value => typeof value === 'string' && value.length > 0 && value.trim() === value
const idsOf = levels => Array.isArray(levels) ? [...new Set(levels.map(level => typeof level === 'string' ? level : level?.id).filter(idString))] : []
const catalogNames = new Set(['models.dev', 'models.dev/models.json', 'models.dev/api.json', 'OpenRouter'])
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, v) => record(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v)).digest('hex')

function citedEfforts(fact) {
  return fact.evidence?.some(item => {
    if (!item?.fields?.includes('reasoningEfforts') || typeof item.url !== 'string') return false
    try { const url = new URL(item.url); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
  })
}

/** Exact facts only. An alias nested in publicReasoning is never a write source.
 * origins is record-wide; it cannot identify who supplied a particular field. */
function reference(fact, provider, model, deployments) {
  if (!fact) return { reason: 'awaiting-evidence' }
  if (fact.id !== model || fact.provider !== undefined && fact.provider !== provider) return { reason: 'reference-mismatch' }
  if (fact.publicAlias || fact.legacyPublic) return { reason: 'reference-alias' }
  if (fact.origins?.includes('manual') && (!Array.isArray(fact.manualFields) ||
    fact.manualFields.some(key => ['reasoning', 'reasoningEfforts', 'defaultEffort'].includes(key)))) return { reason: 'manual-protected' }
  const purePublic = fact.origins?.length === 1 && fact.origins[0] === 'public'
  const doc = fact.publicFacts ?? (purePublic ? fact : null)
  const exactPublic = doc?.publicLookupId === model && !doc.publicAlias && !doc.legacyPublic
  const kind = (exactPublic && doc.type) || fact.type
  if (kind && kind !== 'chat') return { reason: 'non-chat' }
  if (exactPublic && doc.reasoning === false) return { reason: 'reasoning-disabled' }
  if (exactPublic && idsOf(doc.reasoningEfforts).length) {
    const name = doc.fieldSources?.reasoningEfforts ?? doc.reasoningCatalog
    if (catalogNames.has(name)) return { ids: idsOf(doc.reasoningEfforts), source: name, verifiedAt: doc.fieldVerifiedAt?.reasoningEfforts ?? doc.verifiedAt }
  }
  if (fact.reasoning === false) return { reason: 'reasoning-disabled' }
  if (fact.origins?.includes('checker') && !fact.reasoningCatalog && citedEfforts(fact) && idsOf(fact.reasoningEfforts).length) {
    // A checker record is keyed by API ID. Without route attribution a fact
    // for one of several identically named deployments cannot pick a target.
    if (fact.provider === undefined && deployments?.size > 1) return { reason: 'reference-mismatch' }
    return { ids: idsOf(fact.reasoningEfforts), source: 'checker', verifiedAt: fact.verifiedAt }
  }
  if (fact.publicReasoning || doc?.publicLookupId && !exactPublic) return { reason: 'reference-alias' }
  return { reason: 'awaiting-evidence' }
}

// HMAC is not needed: the guard never leaves the Host. Store only hashes of
// configuration/provenance, not headers, URLs or expressions in a ticket.
function fingerprint(target, entry, index, patch) {
  const route = layer => {
    const profile = ownAt(layer, target.path)
    if (!record(profile)) return null
    const { models, ...rest } = profile
    const model = models?.[index]
    if (!patch || !model) return [rest, model]
    return [rest, { ...model, reasoningEfforts: patch.reasoningEfforts,
      ...(patch.supportsReasoningEffort === true ? { compat: { ...model.compat, thinkingFormat: 'openai', supportsReasoningEffort: true } } : {}) }]
  }
  return hash([target.provider, target.ns, index, route(entry.raw.current), route(entry.descriptor.value)])
}

export function readBulkWorld({ settings, llm, configEditor, overrides, learned, readCatalog }, strict = false) {
  if (typeof settings?.mutate !== 'function' || typeof settings?.describe !== 'function' || typeof configEditor?.configuration !== 'function' ||
    typeof llm?.listConfigurableProviders !== 'function' || typeof learned?.getExact !== 'function' || typeof overrides?.read !== 'function') throw Error('unavailable')
  if (strict) learned.assertReadable?.()
  if (learned.meta?.().readError) throw Error('evidence-unavailable')
  const raw = rawSettingsEntries(configEditor)
  const descriptors = settings.describe({ redactSecrets: true })
  const directory = llm.listConfigurableProviders()
  if (!Array.isArray(directory) || !Array.isArray(descriptors)) throw Error('unavailable')
  const local = overrides.read()
  if (!Array.isArray(local?.overrides)) throw Error('overrides-unavailable')
  const manual = new Map(local.overrides.map(row => [routeKey(row.provider, row.model), row]))
  const seen = new Map()
  // Optional *synchronous local/cache* veto. Do not inject service.read() here:
  // unlike a cache peek it may initiate a paid/network model discovery sweep.
  const catalog = readCatalog?.()
  if (catalog?.then) throw Error('local-catalog-required')
  for (const group of catalog?.groups ?? []) for (const row of group.models ?? []) {
    const key = routeKey(group.id, row.id)
    seen.set(key, seen.has(key) ? null : row)
  }
  const deployments = new Map()
  for (const descriptor of descriptors) for (const [provider, profile] of Object.entries(descriptor.value?.providers ?? {})) {
    for (const model of Array.isArray(profile?.models) ? profile.models : []) {
      if (!idString(model?.id)) continue
      if (!deployments.has(model.id)) deployments.set(model.id, new Set())
      deployments.get(model.id).add(provider)
    }
  }
  return { raw, descriptors, directory, manual, seen, learned, llm, deployments }
}

/** Keep skeletons for refused models too; the confirmation UI can audit every
 * row. Only configured models[] are enumerable. Never invent a settings row. */
export function enumerateBulk(world) {
  const ids = new Map()
  for (const row of world.descriptors) {
    if (!isPiAiSettingsOwner(row.ns, world.raw.get(row.ns))) continue
    for (const [provider, profile] of Object.entries(row.value?.providers ?? {})) {
      if (!idString(provider)) continue
      for (const model of Array.isArray(profile?.models) ? profile.models : []) {
        if (idString(model?.id)) ids.set(routeKey(provider, model.id), { provider, model: model.id })
      }
    }
  }
  return [...ids.values()]
}

const refused = reason => ({ authorized: false, status: 'skipped', reason })
export function planBulkRow(world, { provider, model }) {
  const { directory, raw, descriptors, llm } = world
  const key = routeKey(provider, model)
  const target = findRegisteredTarget(directory, provider, raw)
  if (!target || directory.some(row => row.provider === provider && row.error)) return refused('provider-unverified')
  // The installed catalog is not the configuration or a source of wire values.
  // This offline path intentionally does not discover native-provider models.
  if (target.catalogProvider) return refused('native-catalog')
  const adapter = llm.adapters instanceof Map ? llm.adapters.get(provider)?.adapter : undefined
  if (!isPiAiRouteAdapter(adapter)) return refused('provider-unverified')
  const entry = findSettingsEntry(descriptors, provider, target.ns, raw)
  if (!entry?.models?.length || entry.raw?.name !== '@deepseek-ai/dsh-llm-pi-ai') return refused('provider-unverified')
  if (!Number.isSafeInteger(entry.revision)) return refused('revision-unavailable')
  const index = entry.models.findIndex(row => row?.id === model)
  if (index < 0 || entry.models.findLastIndex(row => row?.id === model) !== index) return refused('model-ambiguous')
  const configured = entry.models[index]
  const local = world.manual.get(key)
  const cached = world.seen.get(key)
  if (cached === null || cached?.id !== undefined && cached.id !== model || cached?.provider !== undefined && cached.provider !== provider) return refused('model-ambiguous')
  if (inferModelKind(model, configured.name) !== 'chat' || (cached?.kind && cached.kind !== 'chat') || (local?.kind && local.kind !== 'chat')) return refused('non-chat')
  if (local?.reasoningSupported === false || local?.efforts || local?.defaultEffort) return refused('manual-protected')
  if (cached?.reasoningWireDisabled || cached?.reasoningSupported === false) return refused('reasoning-disabled')
  let active, resolved
  try {
    const snapshot = adapter.current()
    active = adapter.profileOf(snapshot, provider); resolved = adapter.modelOf(snapshot, provider, model)
  } catch { return refused('provider-unverified') }
  if (active?.provider !== provider || resolved?.provider !== provider || resolved?.id !== model || !['api', 'baseURL'].every(field => active[field] === entry.profile[field]) ||
    resolved.api !== entry.profile.api || resolved.baseUrl !== entry.profile.baseURL) return refused('provider-unverified')
  if (inferModelKind(model, resolved.name) !== 'chat') return refused('non-chat')
  const { refusal, protocol } = directEffortPolicy(target, entry, index)
  if (refusal) return refused(refusal === 'reference-disabled' ? 'reasoning-disabled' : refusal)
  const ref = reference(world.learned.getExact(model), provider, model, world.deployments.get(model))
  if (ref.reason && ref.reason !== 'awaiting-evidence') return refused(ref.reason)
  const existing = configured.reasoningEfforts
  const desired = ref.ids ?? []
  const known = desired.filter(id => PROVIDER_EFFORT_LEVELS.includes(id) && Object.hasOwn(existing ?? {}, id) &&
    (id === 'off' && existing[id] === null || typeof existing[id] === 'string' && existing[id].trim()))
  const missing = desired.filter(id => !known.includes(id))
  const additions = protocol ? missing.filter(id => id !== 'off' && PROVIDER_EFFORT_LEVELS.includes(id) && !Object.hasOwn(existing ?? {}, id)) : []
  const unmet = missing.filter(id => !additions.includes(id))
  const info = { ...(desired.length ? { efforts: desired } : {}), ...(ref.source ? { source: ref.source } : {}),
    ...(Number.isSafeInteger(ref.verifiedAt) && ref.verifiedAt > 0 ? { verifiedAt: ref.verifiedAt } : {}),
    ...(additions.length ? { additions } : {}), ...(unmet.length ? { unresolvedEfforts: unmet } : {}) }
  if (!protocol) return { ...refused(!missing.length && known.length ? 'already-mapped' : 'protocol-unmapped'), ...info }
  const guard = { adapter, registration: llm.adapters.get(provider), ns: target.ns, index, revision: entry.revision, before: fingerprint(target, entry, index),
    // Comparing a full hash avoids handing config or raw secret fields to callers.
    localRevision: hash(local ?? null) }
  if (!additions.length) {
    if (unmet.length && !known.length) return { ...refused('unmapped-efforts'), ...info }
    return { ...info, authorized: true, status: 'skipped', reason: unmet.length ? 'unmapped-efforts' : known.length ? 'already-mapped' : 'awaiting-evidence', guard }
  }
  const override = { provider, model, efforts: additions }
  const patch = providerPatch(override, { configured, directEffort: true, directProtocol: protocol,
    referencePrefill: true, defaultReasoning: entry.defaultReasoning })
  if (!record(patch.reasoningEfforts) || !additions.every(id => patch.reasoningEfforts[id] === id) ||
    !Object.keys(existing ?? {}).every(id => isDeepStrictEqual(existing[id], patch.reasoningEfforts[id]))) return { ...refused('route-default'), ...info }
  return { ...info, authorized: true, status: 'pending', reason: 'ready', guard: { ...guard, patch, after: fingerprint(target, entry, index, patch) } }
}
