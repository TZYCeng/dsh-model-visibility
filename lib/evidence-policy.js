/** Evidence is field-local. A union of record origins is never proof that a
 * particular fact (or effort ladder) came from an exact public document. */
import { MODEL_KINDS, inferIdentifierKind, inferInputModalities, inferModelKind } from './capability-catalog.js'
import { lookupCorrection } from './capability-corrections.js'

const text = value => typeof value === 'string' && value.length ? value : undefined
const kindOf = value => MODEL_KINDS.includes(value) ? value : undefined
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined
const bool = value => typeof value === 'boolean' ? value : undefined
const modalities = value => {
  const unique = Array.isArray(value) ? [...new Set(value.filter(text))] : []
  return unique.length ? unique : undefined
}
const catalogUrls = new Map([
  ['models.dev/models.json', 'https://models.dev/models.json'],
  ['models.dev/api.json', 'https://models.dev/api.json'],
  ['models.dev', 'https://models.dev/'],
  ['OpenRouter', 'https://openrouter.ai/api/v1/models?output_modalities=all'],
  ['Hugging Face', 'https://huggingface.co/models'],
])

/** Keep actual adapter choices detached, including their original IDs/order. */
export function detachReasoning(reasoning) {
  if (!Array.isArray(reasoning?.efforts)) return undefined
  const efforts = []
  const seen = new Set()
  for (const effort of reasoning.efforts) {
    const id = text(effort?.id), name = text(effort?.name)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    const description = text(effort.description)
    efforts.push({ id, name, ...(description ? { description } : {}) })
  }
  if (!efforts.length) return undefined
  return { efforts, ...(seen.has(reasoning.defaultEffort) ? { defaultEffort: reasoning.defaultEffort } : {}) }
}

const fact = (value, source, detail) => value === undefined || value === null
  ? undefined : { value, evidence: { source, ...detail } }
const firstFact = (...facts) => facts.find(Boolean)

const listOf = (value) => Array.isArray(value) ? value : []
const ladderOf = row => row?.reasoning === false ? undefined : detachReasoning({ efforts: row?.reasoningEfforts, defaultEffort: row?.defaultEffort })

function citations(row, field) {
  const urls = new Set()
  const key = field === 'type' ? 'kind' : field
  for (const item of listOf(row?.evidence).slice(0, 64)) {
    if (urls.size >= 8) break
    if (!listOf(item?.fields).includes(key) || typeof item.url !== 'string' || item.url.length > 2048) continue
    try {
      const url = new URL(item.url)
      if (url.protocol === 'https:' && !url.username && !url.password && !/[?&](?:[^=&#]*(?:key|secret|token|signature|credential|password)[^=&#]*)=/i.test(url.search)) urls.add(url.href)
    } catch { /* Do not expose malformed references. */ }
  }
  return [...urls]
}

function recordFact(row, field, value, source, lookupId, alias) {
  if (value === undefined || value === null) return undefined
  const declaredCatalog = row.fieldSources?.[field] ?? (field === 'reasoningEfforts' ? row.reasoningCatalog : undefined)
  const catalog = source === 'public' && catalogUrls.has(declaredCatalog) ? declaredCatalog : undefined
  const urls = source === 'public' ? (catalog ? [catalogUrls.get(catalog)] : []) : citations(row, field)
  const verifiedAt = positive(row.fieldVerifiedAt?.[field]) ?? positive(row.verifiedAt)
  return fact(value, source, {
    ...(text(lookupId) ? { lookupId } : {}), ...(alias ? { alias: true } : {}),
    ...(catalog ? { catalog } : {}), ...(urls.length ? { urls } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
  })
}

/** Distinguish exact independent public fields, ordinary snapshots and advisory
 * aliases; never upgrade a flattened mixed-origin row based on its origins. */
export function learnedLayers(row, id) {
  const exact = !!row && row.id === id && !row.publicAlias && !row.legacyPublic
  const origins = listOf(row?.origins)
  const publicOnly = origins.length === 1 && origins[0] === 'public'
  const publicLooking = publicOnly || row?.publicAlias === true || row?.legacyPublic === true
  const independent = row?.publicFacts
  const docs = exact && independent?.publicLookupId === id && !independent.publicAlias && !independent.legacyPublic ? independent
    : !independent && exact && publicOnly && row.publicLookupId === id ? row : undefined
  const manualField = field => exact && (listOf(row.manualFields).includes(field) || origins.length === 1 && origins[0] === 'manual')
  const topId = publicLooking ? row.publicLookupId ?? row.id : row?.id
  function field(key, read = (record => record?.[key])) {
    const pub = docs && recordFact(docs, key, read(docs), 'public', id, false)
    const value = row && read(row)
    if (value === undefined || value === null) return { public: pub }
    if (manualField(key)) return { manual: recordFact(row, key, value, 'manual', id, false), public: pub }
    if (publicLooking && pub) return { public: pub }
    const alias = !exact || publicLooking
    const fromRow = recordFact(row, key, value, publicLooking ? 'public' : 'snapshot', topId, alias)
    return { public: pub, ...(alias ? { alias: fromRow } : { snapshot: fromRow }) }
  }
  return { field, docs }
}

/** Authoritative public levels are *reference* metadata; never a request
 * control. A fuzzy publicReasoning sidecar on an otherwise exact row stays fuzzy. */
export function referenceLadder(row, id, layers = learnedLayers(row, id)) {
  if (layers.docs?.reasoning === false) return undefined
  const levels = layers.field('reasoningEfforts', ladderOf)
  const advisory = row?.publicReasoning
  return firstFact(levels.public, levels.manual, levels.snapshot, levels.alias,
    advisory && recordFact(advisory, 'reasoningEfforts', ladderOf(advisory), 'public', advisory.publicLookupId, true))
}

/** One merger for display, request admission and checking a proposed write. */
export function projectCapabilities(base, context) {
  const { adapter, profile, configured, discovered, override, learned } = context
  const layers = learnedLayers(learned, base.id)
  const correction = lookupCorrection(base.id)
  const sources = {}, fieldEvidence = {}
  const display = (key, selected) => {
    sources[key] = selected?.evidence.source ?? 'unknown'
    if (selected) fieldEvidence[key] = selected.evidence
    return selected?.value
  }
  const official = (key, normalize) => correction && fact(normalize(correction[key]), 'official', { lookupId: base.id, urls: [correction.source] })
  const discoveredId = discovered?.id ?? base.id
  const providerAlias = discoveredId !== base.id || discovered?.nameOnly === true
  const relay = value => fact(value, 'provider', { lookupId: discoveredId, ...(providerAlias ? { alias: true } : {}) })
  const adapterNative = !profile || profile.catalogModels === true ||
    (profile.catalogProvider === true && (context.installedModels?.has(base.id) ?? true))
  const kindLayers = layers.field('type', row => kindOf(row.type))
  const providerKind = kindOf(discovered?.kind)
  const weakChat = providerKind === 'chat' && discovered?.weakKind === true
  // A generic completion endpoint/legacy checker chat guess is not an explicit
  // task declaration. Keep e.g. embedding/image IDs out of the chat controls.
  const kind = display('kind', firstFact(fact(kindOf(override?.kind), 'manual'), kindLayers.manual,
    official('type', kindOf), kindLayers.public, !providerAlias && !weakChat && relay(providerKind),
    kindLayers.snapshot?.value !== 'chat' && kindLayers.snapshot, fact(inferIdentifierKind(base.id), 'inferred'),
    kindLayers.snapshot, providerKind !== 'chat' && relay(providerKind), kindLayers.alias?.value !== 'chat' && kindLayers.alias,
    relay(providerKind), kindLayers.alias, fact(inferModelKind(base.id, base.name), 'inferred'))) ?? 'chat'

  // Never turn gate-widened resolver input on an explicit-list relay into
  // independent adapter evidence. Exact route metadata always beats an alias.
  function choose(key, field, normalize, explicit, native, probed, fallback, inferred) {
    const learnedField = layers.field(field, row => normalize(row[field]))
    return display(key, firstFact(fact(normalize(override?.[field]), 'manual'), learnedField.manual,
      fact(explicit, 'config'), fact(native, 'adapter'), official(field, normalize), learnedField.public,
      !providerAlias && relay(normalize(probed)), learnedField.snapshot, fallback,
      providerAlias && relay(normalize(probed)), learnedField.alias, fact(inferred, 'inferred')))
  }
  const chat = kind === 'chat'
  const adapterInput = modalities(adapter?.inputModalities)
  const defaultInput = modalities(profile?.defaultInput)
  const configuredInput = modalities(configured?.input) ?? (!adapterNative && (profile?.inputDefault || defaultInput?.some(i => i !== 'text')) ? defaultInput : undefined)
  const inputModalities = choose('modalities', 'input', modalities, configuredInput,
    adapterNative ? adapterInput : undefined, discovered?.inputModalities, undefined,
    chat ? inferInputModalities(base.id, base.name) : undefined)
  const adapterContext = positive(adapter?.contextWindow)
  const configuredContext = positive(configured?.contextWindow) ?? (!adapterNative && profile?.contextDefault ? positive(profile.defaultContextWindow) : undefined)
  const contextWindow = choose('context', 'contextWindow', positive, configuredContext,
    adapterNative ? adapterContext : undefined, discovered?.contextWindow,
    chat && profile?.adapter && adapterContext !== 1_000_000 ? fact(adapterContext, 'adapter') : undefined)
  const defaultMaxTokens = choose('maxTokens', 'maxTokens', positive,
    positive(configured?.maxTokens) ?? (!adapterNative && profile?.maxTokensDefault ? positive(profile.defaultMaxTokens) : undefined),
    adapterNative || profile?.adapter ? positive(adapter?.defaultMaxTokens) : undefined, discovered?.maxTokens)
  const inferredOutput = ['image', 'video', 'audio'].includes(kind) ? [kind] : undefined
  const outputModalities = choose('output', 'output', modalities, undefined, undefined, discovered?.outputModalities, undefined, inferredOutput)

  const disabled = configured?.reasoningEfforts === false
  const requestReasoning = chat && !disabled ? detachReasoning(adapter?.reasoning) ?? null : null
  const requestSource = configured?.reasoningEfforts !== undefined ? 'config' : 'adapter'
  const reasoningWireDisabled = requestReasoning !== null && profile?.api === 'openai-completions'
    && (configured?.compat?.supportsReasoningEffort ?? profile.compat?.supportsReasoningEffort) === false
    && !['openrouter', 'string-thinking', 'ant-ling'].includes(configured?.compat?.thinkingFormat ?? profile.compat?.thinkingFormat)
  const reference = chat ? referenceLadder(learned, base.id, layers) : undefined
  const referenceReasoning = display('referenceReasoning', reference)
  const manualLadder = chat ? fact(detachReasoning({ efforts: override?.efforts, defaultEffort: override?.defaultEffort }), 'manual')
    ?? (override?.reasoningSupported !== false ? layers.field('reasoningEfforts', ladderOf).manual : undefined) : undefined
  const supported = layers.field('reasoning', row => bool(row.reasoning) ?? (row.reasoningEfforts?.length ? true : undefined))
  let support = !chat ? undefined : firstFact(
    manualLadder && { value: true, evidence: manualLadder.evidence }, fact(override?.reasoningSupported === false ? false : undefined, 'manual'), supported.manual,
    disabled && fact(false, 'config'), requestReasoning && fact(true, requestSource), official('reasoning', bool),
    supported.public, !providerAlias && relay(bool(discovered?.reasoning)), supported.snapshot,
    providerAlias && relay(bool(discovered?.reasoning)), supported.alias, reference && { value: true, evidence: reference.evidence })
  let ladder = support?.value ? firstFact(manualLadder, requestReasoning && fact(requestReasoning, requestSource), reference) : undefined
  let defaultFact = ladder?.value.defaultEffort ? { value: ladder.value.defaultEffort, evidence: ladder.evidence } : undefined
  if (!manualLadder && ladder?.value.efforts.some(effort => effort.id === override?.defaultEffort)) {
    defaultFact = fact(override.defaultEffort, 'manual')
    // The annotation chose a default, not the IDs in this ladder.
    ladder = { value: { ...ladder.value, defaultEffort: override.defaultEffort }, evidence: ladder.evidence }
    support = fact(true, 'manual') // compatibility with older manual-edit indicators
  }
  display('defaultEffort', defaultFact)
  const reasoningSupported = display('reasoning', support)
  const reasoning = display('reasoningEfforts', ladder)
  const reasoningCatalog = ladder?.evidence.catalog
  const usesLearned = Object.values(fieldEvidence).some(e => ['snapshot', 'public'].includes(e.source) || e.source === 'manual' && e.lookupId)
  return {
    ...base, kind,
    ...(inputModalities ? { inputModalities } : {}), ...(outputModalities ? { outputModalities } : {}),
    ...(contextWindow ? { contextWindow } : {}), ...(defaultMaxTokens ? { defaultMaxTokens } : {}),
    ...(reasoning ? { reasoning } : {}), ...(reasoning && reasoningCatalog ? { reasoningCatalog } : {}),
    requestReasoning, ...(reasoningWireDisabled ? { reasoningWireDisabled } : {}),
    ...(chat && context.standardEffort === true ? { standardEffort: true } : {}),
    ...(referenceReasoning ? { referenceReasoning, referenceReasoningSource: reference.evidence.catalog?.startsWith('models.dev/') ? 'models.dev' : reference.evidence.catalog ?? reference.evidence.source,
      ...(reference.evidence.alias ? { referenceReasoningAlias: true } : {}) } : {}),
    ...(reasoningSupported === undefined ? {} : { reasoningSupported }), sources, fieldEvidence,
    ...(correction && Object.values(sources).includes('official') ? {
      correction: { id: correction.id, code: correction.code, note: correction.note, source: correction.source },
    } : {}),
    ...(usesLearned && learned ? { learned: {
      id: learned.id ?? base.id, ...(learned.publicAlias ? { publicAlias: true } : {}), ...(learned.legacyPublic ? { legacyPublic: true } : {}),
      ...(Number.isSafeInteger(learned.verifiedAt) ? { verifiedAt: learned.verifiedAt } : {}),
      ...(learned.origins?.length ? { origins: [...learned.origins] } : {}), ...(learned.checker ? { checker: learned.checker } : {}),
    } } : {}),
    ...(context.infoError === undefined ? {} : { infoError: context.infoError }),
  }
}

/** An automatic operation may materialize only this run's independently
 * proposed fields that actually won in the same final projection. Do not turn
 * a local manual decision, a heuristic, an alias, or a conflicting document
 * into a Provider setting. Even equal settings/native values need no write. */
export function selectAutomaticWriteFact(row, proposed) {
  if (!row || !proposed || row.infoError || (proposed.id !== undefined && proposed.id !== row.id)) return null
  const eligible = key => {
    const evidence = row.fieldEvidence?.[key]
    return evidence?.lookupId === row.id && !evidence.alias &&
      (evidence.source === 'public' || evidence.source === 'snapshot') && row.sources?.[key] === evidence.source
  }
  const result = {}
  const input = proposed.input, effective = row.inputModalities
  if (eligible('modalities') && Array.isArray(input) && input.length && Array.isArray(effective) && input.length === effective.length &&
      new Set(input).size === input.length && input.every(item => (item === 'text' || item === 'image') && effective.includes(item))) result.input = [...effective]
  if (eligible('context') && Number.isSafeInteger(proposed.contextWindow) && proposed.contextWindow > 0 && proposed.contextWindow === row.contextWindow) result.contextWindow = row.contextWindow
  return Object.keys(result).length ? result : null
}
