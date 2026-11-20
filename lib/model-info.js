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
  inferIdentifierKind,
  inferInputModalities,
  inferModelKind,
} from './capability-catalog.js'
import { lookupCorrection } from './capability-corrections.js'
import { addModelAlias, exactModelIdentity, modelAliasCandidates } from './model-id.js'
import { createLearnedCatalog } from './learned-catalog.js'
import { boundedOperation } from './async-operation.js'
import { createStandardEffortAvailability, readInstalledModelIds } from './provider-write.js'
import { isDeepStrictEqual } from 'node:util'

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
    exact.set(id, entry)
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
const installedByAdapter = new WeakMap()

function recordInstalledModels(profile, modelIds) {
  if (profile?.adapter === undefined || modelIds === undefined) return
  let records = installedByAdapter.get(profile.adapter)
  if (records === undefined) installedByAdapter.set(profile.adapter, records = new Map())
  records.set(profile.id, modelIds)
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

  const identifierKind = inferIdentifierKind(base.id)
  const providerKind = MODEL_KINDS.includes(discovered?.kind) ? discovered.kind : undefined
  const providerAlias = discovered?.id !== undefined && discovered.id !== base.id
  const weakProviderChat = providerKind === 'chat' && (discovered.weakKind === true || providerAlias)
  const snapshotKind = MODEL_KINDS.includes(learned?.type) ? learned.type : undefined
  const snapshotAlias = learned?.publicAlias || learned?.legacyPublic || (learned?.id !== undefined && learned.id !== base.id)
  const nameKind = identifierKind ?? inferModelKind(base.id, base.name)
  let kind = 'chat'
  sources.kind = 'unknown'

  // Manual and explicit route facts are strongest. A snapshot or advertised
  // alias saying only "chat" must not mask a specialist ID. An alias is not
  // allowed to overrule a different specialist task in the exact ID either.
  const candidates = [
    [override?.kind, 'manual'],
    [!providerAlias && !weakProviderChat ? providerKind : undefined, 'provider'],
    [!snapshotAlias && snapshotKind !== 'chat' ? snapshotKind : undefined, 'snapshot'],
    [identifierKind, 'inferred'],
    [providerKind !== 'chat' ? providerKind : undefined, 'provider'],
    [snapshotKind !== 'chat' ? snapshotKind : undefined, 'snapshot'],
    [snapshotKind, 'snapshot'],
    [providerKind, 'provider'],
    [nameKind, 'inferred'],
  ]
  for (const [value, source] of candidates) {
    if (!MODEL_KINDS.includes(value)) continue
    kind = value
    sources.kind = source
    if (source === 'snapshot') useLearned(learned)
    break
  }

  /* --------------------------------------------------------- modalities */

  let inputModalities
  let modalitySource = 'unknown'
  const configuredInput = modalityList(configured?.input)
  const adapterInput = detachModalities(adapter?.inputModalities)
  const profileExists = profile !== undefined
  const adapterNative = !profileExists || configured === undefined || profile.catalogModels === true ||
    profile.catalogProvider === true && (context.installedModels?.has(base.id) ?? true)

  if (configuredInput !== undefined) {
    inputModalities = configuredInput
    modalitySource = 'config'
  } else if (adapterNative && adapterInput !== undefined) {
    inputModalities = adapterInput
    modalitySource = 'adapter'
  } else if (!adapterNative && (profile?.inputDefault === true || multiModalDefault(profile?.defaultInput))) {
    inputModalities = modalityList(profile.defaultInput)
    if (inputModalities !== undefined) modalitySource = 'config'
  } else if (!adapterNative && adapterInput !== undefined && !isDeepStrictEqual(adapterInput, ['text'])) {
    // In particular ModelInfo can already include the image gate's widening.
    // Do not treat a gated resolver response as independent provider evidence.
    if (adapterInput.includes('image') && profile?.adapter === undefined) {
      inputModalities = adapterInput
      modalitySource = 'adapter'
    }
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
  } else if (adapterNative && adapterContext !== undefined) {
    contextWindow = adapterContext
    contextSource = 'adapter'
  } else if (!adapterNative && profile?.contextDefault === true) {
    contextWindow = positiveInteger(profile.defaultContextWindow)
    if (contextWindow !== undefined) contextSource = 'config'
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
  // A non-default effective adapter value is still a useful fallback when
  // config/probe evidence is missing; the synthetic million-token ceiling is not.
  if (contextWindow === undefined && kind === 'chat' && profile?.adapter !== undefined && adapterContext !== undefined && adapterContext !== 1_000_000) {
    contextWindow = adapterContext
    contextSource = 'adapter'
  }
  const manualContext = positiveInteger(override?.contextWindow)
  if (manualContext !== undefined) {
    contextWindow = manualContext
    contextSource = 'manual'
  }

  /* ----------------------------------------------------------- reasoning */

  // Adapter choices are the only values accepted by the actual request path.
  // Learned/manual declarations are useful for display, never controls.
  const chat = kind === 'chat'
  const requestReasoning = !chat || configured?.reasoningEfforts === false ? null : detachReasoning(adapter?.reasoning) ?? null
  const reasoningWireDisabled = requestReasoning !== null && profile?.api === 'openai-completions'
    && (configured?.compat?.supportsReasoningEffort ?? profile.compat?.supportsReasoningEffort) === false
    && !['openrouter', 'string-thinking', 'ant-ling'].includes(configured?.compat?.thinkingFormat ?? profile.compat?.thinkingFormat)
  const reference = learned?.reasoningEfforts?.length ? learned : learned?.publicReasoning ?? learned
  const learnedLadder = !chat || learned?.reasoning === false ? undefined : detachReasoning({
    efforts: reference?.reasoningEfforts, defaultEffort: reference?.defaultEffort,
  })
  let reasoning = requestReasoning ?? undefined
  let reasoningCatalog
  let reasoningSupported
  let reasoningSource = 'unknown'
  // Some image models reason internally; that is not a chat effort control.
  if (chat && configured?.reasoningEfforts === false) {
    reasoning = undefined
    reasoningSupported = false
    reasoningSource = 'config'
  } else if (reasoning !== undefined) {
    reasoningSupported = true
    reasoningSource = configured?.reasoningEfforts !== undefined ? 'config' : 'adapter'
  } else if (chat && discovered?.reasoning !== undefined) {
    reasoningSupported = discovered.reasoning === true
    reasoningSource = 'provider'
    if (reasoningSupported && learnedLadder) {
      reasoning = learnedLadder
      reasoningCatalog = reference.reasoningCatalog
      useLearned(learned)
    }
  } else if (chat && (learned?.reasoning !== undefined || learnedLadder !== undefined)) {
    reasoningSupported = learned.reasoning === true || learnedLadder !== undefined
    reasoning = learnedLadder
    reasoningCatalog = reference?.reasoningCatalog
    reasoningSource = 'snapshot'
    useLearned(learned)
  }

  // A manual ladder is the requested fix for relays that publish no effort
  // levels at all. An explicit "no reasoning" declaration is the other half of
  // the same switch.
  if (learnedLadder !== undefined) useLearned(learned)
  if (chat && override?.efforts !== undefined) {
    const manualReasoning = detachReasoning({
      efforts: override.efforts,
      defaultEffort: override.defaultEffort,
    })
    if (manualReasoning !== undefined) {
      reasoning = manualReasoning
      reasoningCatalog = undefined
      reasoningSupported = true
      reasoningSource = 'manual'
    }
  } else if (chat && override?.reasoningSupported === false) {
    reasoning = undefined
    reasoningSupported = false
    reasoningSource = 'manual'
  } else if (reasoning?.efforts.some((effort) => effort.id === override?.defaultEffort)) {
    reasoning = { ...reasoning, defaultEffort: override.defaultEffort }
    reasoningSource = 'manual'
  }

  /* ----------------------------------------------------------- max tokens */

  let defaultMaxTokens
  const configuredMaxTokens = positiveInteger(configured?.maxTokens)
  const adapterMaxTokens = positiveInteger(adapter?.defaultMaxTokens)
  // The resolver's value is a request default, not the catalog's capability;
  // pi-ai only supplies it for a cap the deployment actually selected.
  if (configuredMaxTokens !== undefined) defaultMaxTokens = configuredMaxTokens
  else if (adapterMaxTokens !== undefined && (adapterNative || profile?.adapter !== undefined)) defaultMaxTokens = adapterMaxTokens
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
    ...(reasoning && reasoningCatalog ? { reasoningCatalog } : {}),
    requestReasoning,
    ...(reasoningWireDisabled ? { reasoningWireDisabled } : {}),
    ...(chat && context.standardEffort === true ? { standardEffort: true } : {}),
    ...(learnedLadder === undefined ? {} : { referenceReasoning: learnedLadder, referenceReasoningSource: reference?.reasoningCatalog ?? 'snapshot' }),
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
            ...(learnedRecord.publicAlias ? { publicAlias: learnedRecord.publicAlias } : {}),
            ...(learnedRecord.legacyPublic === true ? { legacyPublic: true } : {}),
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
 * Only infer an extra input for explicit-list relay routes. The adapter's
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
  const declared = modalityList(configured?.input)
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
  const learned = context.learned ?? lookupLearned(modelId)
  // An advisory specialist classification can prevent widening, but never
  // use an ambiguous or legacy public fact as evidence for accepting images.
  const advisory = learned?.publicAlias || learned?.legacyPublic
  const safeLearned = advisory
    ? { id: learned.id, type: learned.type, publicAlias: learned.publicAlias, legacyPublic: learned.legacyPublic }
    : learned ?? {}
  const record = mergeCapabilities(
    { id: modelId, name: nonEmptyString(context.modelName) ?? modelId },
    { profile, configured, discovered, installedModels: context.installedModels, override: context.override, learned: safeLearned },
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
    info = await boundedOperation(signal => llm.resolveModelInfo(providerId, model.id, signal), {
      timeoutMs: catalogTimeout(context.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS),
      label: `resolve model ${providerId}/${model.id}`,
    })
  } catch (error) {
    infoError = messageOf(error)
  }
  // Listing metadata is still valid when the richer resolver stalls or fails.
  // Only the fields provided by the list may fall back; no reasoning levels
  // are inferred from the route or model name.
  const adapter = describeResolvedModel({ ...base, inputModalities: model.inputModalities }, info)
  const candidate = context.profile
  const profile = profileMatchesRegistration(llm, candidate) ? candidate : undefined
  const discovered = profile !== candidate ? undefined : findDiscovered(
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
    learned: context.learned ?? lookupLearned(model.id),
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
          timeoutMs: catalogTimeout(options.enrichmentTimeoutMs, DEFAULT_ENRICHMENT_TIMEOUT_MS),
          label: 'provider enrichment',
        })
  } catch (error) {
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
  // Adopting the caller's store here also points the module-level fallback at
  // the Host's single mtime-memoized read; direct consumers without a store
  // keep their lazy default.
  if (options.learned !== undefined) defaultLearned = options.learned
  const learnedStore = options.learned ?? (defaultLearned ?? undefined)
  const enrichmentPromise = resolveEnrichment(options)
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

  const standardEffortAvailable = createStandardEffortAvailability(options.settings, llm, options.configEditor)
  // Providers are probed concurrently but reported in catalog order; a slow
  // adapter must not delay the page behind every other provider.
  const results = await Promise.all(
    (Array.isArray(providers) ? providers : []).map(async (provider) => {
      if (provider === null || typeof provider !== 'object') return null
      const id = nonEmptyString(provider.id)
      if (id === undefined) return null
      const name = nonEmptyString(provider.name) ?? id
      try {
        const [models, enrichment] = await Promise.all([
          boundedOperation(() => llm.listModels(id), {
            timeoutMs: catalogTimeout(options.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS),
            label: `list models ${id}`,
          }),
          enrichmentPromise,
        ])
        const listed = Array.isArray(models) ? models : []
        const candidate = enrichment?.profiles instanceof Map ? enrichment.profiles.get(id) : undefined
        const profile = profileMatchesRegistration(llm, candidate) ? candidate : undefined
        const installedModels = profile?.catalogProvider === true && profile.catalogModels === false
          ? await readInstalledModelIds(llm, { catalogProvider: true, provider: id, ns: profile.namespace }) : undefined
        recordInstalledModels(profile, installedModels)
        const discovered = profile !== candidate ? undefined : enrichment?.discovered?.get?.(id)
        const discoveredIndex = indexDiscovered(discovered)
        const entries = await Promise.all(
          listed
            .filter((model) => model !== null && typeof model === 'object' && nonEmptyString(model.id) !== undefined)
            .map((model) =>
              describeModel(llm, id, model, {
                timeoutMs: options.timeoutMs,
                profile,
                installedModels,
                standardEffort: standardEffortAvailable(id, model.id, installedModels),
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

  const enrichment = await enrichmentPromise
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
    features: ['applyInput', 'reload', 'overrides', 'verify', 'usage', 'checkerBudget', 'verifyWeb', 'verifyFullScan', 'reasoningMappings', 'standardEffort', 'referencePrefill', 'verifyModes', 'verifySourceModes'],
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
    if (!fresh && cached !== null && stamp - cachedAt < ttlMs) {
      return Promise.resolve(cached)
    }
    if (inflight !== null) return inflight
    const startedAt = generation
    const run = describeCatalog(llm, {
      settings: options.settings,
      configEditor: options.configEditor,
      enrichment: options.enrichment,
      fallbackEnrichment: options.fallbackEnrichment,
      timeoutMs: options.timeoutMs,
      enrichmentTimeoutMs: options.enrichmentTimeoutMs,
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
          clearImageCache()
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
   * Use the page's evidence and display name for inference, but never widen an
   * explicit Provider input declaration or the adapter's installed catalog.
   * @param providerId - provider route id.
   * @param modelId - exact model id.
   * @param modelName - adapter display name, when available.
   * @returns whether this exact relay model may be widened by the plugin.
   */
  const imageInputAllowed = (providerId, modelId, modelName, snapshotRoute) => {
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
            adapterProfile?.provider !== providerId || resolved?.id !== modelId) return false
      }
      const key = JSON.stringify([providerId, modelId, modelName])
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
      allowed = imageInputDecision(providerId, modelId, {
        modelName,
        profile,
        installedModels: profile?.adapter && installedByAdapter.get(profile.adapter)?.get(providerId),
        discovered: discovery,
        discoveredIndex,
        override: typeof overrides?.get === 'function' ? overrides.get(providerId, modelId) : undefined,
        learned:
          typeof source.learned === 'function'
            ? source.learned(modelId)
            : typeof source.learned?.get === 'function'
              ? source.learned.get(modelId)
              : source.learned,
      }).allowed
      if (snapshotRoute === undefined) imageCache.set(key, allowed)
    } catch (_error) {
      // A capability read must never break the request path.
      allowed = false
    }
    return allowed
  }

  const invalidate = () => {
    generation += 1
    cached = null
    cachedAt = -Infinity
    inflight = null
    clearImageCache()
  }

  return { read, invalidate, imageInputAllowed }
}
