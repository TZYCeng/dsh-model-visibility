/**
 * Revision-checked writes to existing pi-ai model entries. Automatic verification
 * only fills unspecified input and context fields. Explicit manual writes may
 * change reasoning settings, but an effort ID is not its wire value.
 *
 * @module lib/provider-write
 */

import { isDeepStrictEqual } from 'node:util'
import { boundedOperation } from './async-operation.js'
import { inferModelKind } from './capability-catalog.js'

export const PROVIDER_EFFORT_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])
const PROVIDER_INPUT = ['text', 'image']
const IDENTITY_EFFORTS = new Set(PROVIDER_EFFORT_LEVELS.filter(id => id !== 'off'))

/** Decide whether the effective route can safely use the explicit OpenAI wire format. */
export function canWriteStandardEffort(target, entry, model) {
  if (!target || !entry || target.ns !== entry.ns || !isRecord(model) || !Number.isSafeInteger(entry.revision)) return false
  const { profile } = entry
  if (profile?.api !== 'openai-completions' || inferModelKind(model.id, model.name) !== 'chat') return false
  const format = model?.compat?.thinkingFormat ?? profile.compat?.thinkingFormat
  // Never infer a native model's compat or replace its inherited effort map.
  const path = [...target.path, 'models', String(entry.models.indexOf(model))]
  if (writePathRefusal(entry, [...path, 'reasoningEfforts']) !== undefined ||
      writePathRefusal(entry, [...path, 'compat', 'thinkingFormat']) !== undefined ||
      writePathRefusal(entry, [...path, 'compat', 'supportsReasoningEffort']) !== undefined) return false
  if (inheritsCatalogModel(target, entry, model.id)) return format === 'openai' && model.reasoningEfforts !== undefined
  if (typeof profile.baseURL !== 'string' || !/^https?:\/\//i.test(profile.baseURL) || profile.baseURL.trim() !== profile.baseURL) return false
  let url
  try { url = new URL(profile.baseURL) } catch { return false }
  if (url.username || url.password) return false
  if (format != null) return format === 'openai'
  // pi-ai checks the entire raw base URL, including reverse-proxy paths, for
  // vendor-specific thinking formats or suppressed efforts. Refuse ambiguity
  // unless the user already configured OpenAI's format explicitly. Keep this
  // deny list conservative; the successful opt-in also pins the wire format so
  // a future SDK auto-detection change cannot silently switch fields.
  const vendor = /^(?:deepseek|zai|zai-coding-cn|together|ant-ling|openrouter|xai|moonshotai(?:-cn)?|nvidia|cloudflare-ai-gateway)$/i
  const specialHost = /(?:^|\.)(?:deepseek\.com|z\.ai|bigmodel\.cn|together\.(?:ai|xyz)|ant-ling\.com|openrouter\.ai|x\.ai|moonshot\.(?:ai|cn)|nvidia\.com|cloudflare\.com)\.?$/i
  const specialUrl = /(?:deepseek\.com|api\.z\.ai|open\.bigmodel\.cn|api\.together\.(?:ai|xyz)|api\.ant-ling\.com|openrouter\.ai|api\.x\.ai|api\.moonshot\.|integrate\.api\.nvidia\.com|gateway\.ai\.cloudflare\.com)/i
  return !vendor.test(target.provider) && !specialHost.test(url.hostname) && !specialUrl.test(profile.baseURL)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  if (error === null || error === undefined) return undefined
  return typeof error.message === 'string' ? error.message : String(error)
}

function effortIds(override) {
  if (!Array.isArray(override?.efforts)) return []
  return [...new Set(override.efforts.map((effort) => {
    const id = typeof effort === 'string' ? effort : effort?.id
    return typeof id === 'string' ? id.trim().toLowerCase() : ''
  }).filter(Boolean))]
}

/** Only off may omit its wire value; all other levels need an explicit token. */
function usableWire(id, value) {
  return (id === 'off' && value === null) || (typeof value === 'string' && value.trim() !== '')
}

function reasoningPatch(override, configured, mappings, inheritedCatalog = false) {
  if (override?.reasoningSupported === false) return { value: false, unresolved: [] }
  const ids = effortIds(override)
  if (ids.length === 0) return { unresolved: [] }
  const existing = isRecord(configured?.reasoningEfforts) ? configured.reasoningEfforts : {}
  const explicit = isRecord(mappings) ? mappings : {}
  const unresolved = []
  const selected = {}
  const entered = {}
  for (const id of ids) {
    const supplied = Object.hasOwn(explicit, id)
    const wire = supplied ? explicit[id] : Object.hasOwn(existing, id) ? existing[id] : undefined
    if (!PROVIDER_EFFORT_LEVELS.includes(id) || !usableWire(id, wire)) {
      unresolved.push(id)
    } else {
      selected[id] = wire
      if (supplied && wire !== existing[id]) entered[id] = wire
    }
  }
  // A settings editor knowing only the newly selected IDs must never remove
  // unselected Provider levels. Inherited native mappings are not enumerable
  // via settings; refusing to replace them avoids silently narrowing them.
  if (inheritedCatalog && configured?.reasoningEfforts === undefined) {
    return { unresolved, inherited: true }
  }
  const known = Object.fromEntries(PROVIDER_EFFORT_LEVELS
    .filter((id) => Object.hasOwn(existing, id) && usableWire(id, existing[id]))
    .map((id) => [id, existing[id]]))
  const value = unresolved.length > 0
    ? (Object.keys(entered).length > 0 ? { ...known, ...entered } : undefined)
    : { ...known, ...selected }
  if (value === undefined || !Object.keys(value).some((id) => id !== 'off')) {
    return { unresolved: unresolved.length > 0 ? unresolved : ids }
  }
  return { value, unresolved }
}

/** A manual ladder uses only exact values from this model or the supplied map. */
export function effortsForProvider(override, configured, mappings = override?.reasoningEffortMappings) {
  return reasoningPatch(override, configured, mappings).value
}

function hasInput(override) {
  return Array.isArray(override?.input) && override.input.length > 0
}

function validContext(value) {
  return Number.isSafeInteger(value) && value > 0
}

function planProviderPatch(override, {
  configured, automatic = false, reasoningEffortMappings = override?.reasoningEffortMappings,
  inputDefault, contextDefault, defaultReasoning, inheritedCatalog, standardEffort = false, standardEffortAllowed = false,
  referencePrefill = false,
} = {}) {
  const patch = {}
  const localOnly = []
  const protectedFields = []
  if (hasInput(override)) {
    if (automatic && ((configured?.input !== undefined && (!Array.isArray(configured.input) || configured.input.length > 0)) || inputDefault)) {
      protectedFields.push('input')
    } else if (!override.input.every((input) => PROVIDER_INPUT.includes(input))) {
      // A narrower request declaration is not equivalent to the intended list.
      localOnly.push('input')
    } else {
      patch.input = [...override.input]
    }
  }
  if (validContext(override?.contextWindow)) {
    if (automatic && (configured?.contextWindow !== undefined || contextDefault)) protectedFields.push('contextWindow')
    else patch.contextWindow = override.contextWindow
  }
  let unresolvedEfforts = []
  let reasoningConflict
  const protectedEfforts = []
  if (automatic) {
    if (override?.reasoningSupported !== undefined || effortIds(override).length > 0) localOnly.push('reasoningEfforts')
  } else if (referencePrefill && effortIds(override).length > 0 &&
    (inferModelKind(configured?.id ?? override?.model, configured?.name) !== 'chat' || override?.kind && override.kind !== 'chat')) {
    reasoningConflict = 'reference-nonchat'
    localOnly.push('reasoningEfforts')
  } else if (referencePrefill && (override?.reasoningSupported === false || (effortIds(override).length > 0 && configured?.reasoningEfforts === false))) {
    reasoningConflict = 'reference-disabled'
    localOnly.push('reasoningEfforts')
  } else {
    const existing = configured?.reasoningEfforts
    let explicitMappings = reasoningEffortMappings
    if (referencePrefill && isRecord(explicitMappings) && isRecord(existing)) {
      const requested = new Set(effortIds(override))
      explicitMappings = Object.fromEntries(Object.entries(explicitMappings).filter(([id, value]) => {
        if (!requested.has(id) || !usableWire(id, value)) return false
        if (!Object.hasOwn(existing, id) || !usableWire(id, existing[id])) return true
        if (existing[id] !== value) protectedEfforts.push(id)
        return false
      }))
    }
    const requestedIdentity = effortIds(override).filter((id) => IDENTITY_EFFORTS.has(id))
    const useIdentity = standardEffort && standardEffortAllowed && requestedIdentity.length > 0
    const mappings = useIdentity
      ? { ...Object.fromEntries(requestedIdentity.filter((id) => !usableWire(id, existing?.[id])).map((id) => [id, id])),
          ...(isRecord(explicitMappings) ? explicitMappings : {}) }
      : explicitMappings
    const { value, unresolved, inherited } = reasoningPatch(override, configured, mappings, inheritedCatalog)
    if (inherited) reasoningConflict = 'inherited-ladder'
    else if (standardEffort && !standardEffortAllowed && requestedIdentity.length > 0) reasoningConflict = 'standard-format'
    if (value !== undefined && reasoningConflict !== 'standard-format') {
      if (PROVIDER_EFFORT_LEVELS.includes(defaultReasoning) &&
        (value === false ? defaultReasoning !== 'off' : !Object.hasOwn(value, defaultReasoning))) {
        reasoningConflict = 'route-default'
      } else {
        patch.reasoningEfforts = value
        if (useIdentity && value !== false && requestedIdentity.some((id) => usableWire(id, value[id]))) {
          patch.supportsReasoningEffort = true
        }
      }
    }
    unresolvedEfforts = unresolved
    if (unresolved.length > 0 || reasoningConflict !== undefined || protectedEfforts.length) localOnly.push('reasoningEfforts')
  }
  return { patch, localOnly, protectedFields, unresolvedEfforts, reasoningConflict, protectedEfforts }
}

export function providerPatch(override, options) {
  return planProviderPatch(override, options).patch
}

/** Loader interpolation interprets an own string marker even in a map that already has sibling keys. */
export function isConfigExpression(value) {
  return isRecord(value) && Object.hasOwn(value, '__jsExpr') && typeof value.__jsExpr === 'string'
}

export function ownAt(value, path) {
  for (const segment of path) {
    if (!(isRecord(value) || Array.isArray(value)) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

/** Read raw effective/interleaved layers, never interpolated secret values. */
export function rawSettingsEntries(configEditor) {
  const map = new Map()
  if (typeof configEditor?.configuration !== 'function') return map
  for (const row of configEditor.configuration() ?? []) {
    const options = row?.entry?.options
    if (typeof options?.id !== 'string') continue
    // `entry.options.config` is the raw effective composition, which `mutate`
    // actually edits. `override` alone misses inherited or home overlays.
    map.set(options.id, map.has(options.id) ? null : {
      name: options.name,
      current: Object.hasOwn(options, 'config') ? options.config ?? {} : undefined,
      override: row.override,
      inherited: row.inherited,
    })
  }
  return map
}

const piAiNamespace = /(?:^|:)llm-pi-ai$/

export function isPiAiRouteAdapter(adapter) {
  return !!adapter && typeof adapter.modelOf === 'function' && typeof adapter.profileOf === 'function' && typeof adapter.current === 'function'
}
export function isPiAiSettingsOwner(ns, raw) {
  if (typeof ns !== 'string' || !ns) return false
  if (typeof raw?.name === 'string') return raw.name === '@deepseek-ai/dsh-llm-pi-ai'
  return piAiNamespace.test(ns)
}

/** `declared` is catalog PROVIDER identity; it does not describe the models list. */
export function findRegisteredTarget(providers, provider, rawEntries) {
  const matches = Array.isArray(providers) ? providers.filter((entry) => entry?.provider === provider) : []
  const row = matches.length === 1 ? matches[0] : undefined
  if (!row || !isPiAiSettingsOwner(row.settingsNs, rawEntries?.get(row.settingsNs)) || !Array.isArray(row.settingsPath) ||
    row.settingsPath.length !== 2 || row.settingsPath[0] !== 'providers' || row.settingsPath[1] !== provider) return null
  return { provider, ns: row.settingsNs, path: [...row.settingsPath], catalogProvider: row.declared !== true }
}

export function findProviderTarget(llm, provider, rawEntries) {
  if (typeof llm?.listConfigurableProviders !== 'function') return undefined
  return findRegisteredTarget(llm.listConfigurableProviders(), provider, rawEntries)
}

/** The installed implementation handles provider-only discovery locally. An
 * empty/failed catalog is not evidence that a model is hand declared. */
export async function readInstalledModelIds(llm, target) {
  if (!target.catalogProvider || typeof llm?.discoverModels !== 'function') return undefined
  try {
    const models = await boundedOperation(signal => llm.discoverModels(target.ns, { provider: target.provider }, signal), {
      timeoutMs: 1500, label: 'installed provider catalog',
    })
    if (!Array.isArray(models) || models.length === 0 || models.some(row => typeof row?.id !== 'string' || !row.id)) return undefined
    return new Set(models.map(row => row.id))
  } catch (_error) {
    return undefined
  }
}

function inheritsCatalogModel(target, entry, modelId) {
  return target.catalogProvider && (entry.installedModels?.has(modelId) ?? true)
}

/** Read-only convenience for callers already holding the authoritative namespace. */
export function findProviderEntry(settings, providerId, settingsNs) {
  if (typeof settings?.describe !== 'function') return undefined
  return findSettingsEntry(settings.describe({ redactSecrets: true }), providerId, settingsNs)
}

function findSettingsEntry(descriptors, providerId, settingsNs, rawEntries) {
  if (!Array.isArray(descriptors) || typeof providerId !== 'string') return undefined
  const rows = descriptors.filter((descriptor) => settingsNs !== undefined ? descriptor?.ns === settingsNs :
    typeof descriptor?.ns === 'string' && piAiNamespace.test(descriptor.ns))
  if (settingsNs !== undefined && rows.length !== 1) return undefined
  const matches = []
  const path = ['providers', providerId]
  for (const descriptor of rows) {
    const profile = ownAt(descriptor.value, path)
    if (!isRecord(profile)) continue
    const raw = rawEntries?.get(descriptor.ns)
    const rawProfile = ownAt(raw?.current, path)
    const userProfile = ownAt(descriptor.user, path)
    // Real projected `base` includes schema defaults. If raw provenance is
    // available use it instead: an explicit `[text]` differs from its default.
    const fallbackProfile = raw?.current === undefined ? ownAt(descriptor.base, path) : undefined
    const declaresInput = (p) => Array.isArray(p?.defaultInput) && p.defaultInput.length > 0
    matches.push({
      ns: descriptor.ns,
      revision: descriptor.revision,
      models: Array.isArray(profile.models) ? profile.models : undefined,
      inputDefault: declaresInput(rawProfile) || declaresInput(userProfile) || declaresInput(fallbackProfile) ||
        Array.isArray(profile.defaultInput) && profile.defaultInput.some((input) => input !== 'text'),
      contextDefault: validContext(rawProfile?.defaultContextWindow) || validContext(userProfile?.defaultContextWindow) ||
        validContext(fallbackProfile?.defaultContextWindow) || validContext(profile.defaultContextWindow) && profile.defaultContextWindow !== 1_000_000,
      defaultReasoning: profile.reasoning,
      profile,
      descriptor,
      raw,
    })
  }
  return matches.length === 1 ? matches[0] : undefined
}

function hasExpressionAt(layer, path) {
  for (let i = 0; i <= path.length; i++) {
    if (isConfigExpression(ownAt(layer, path.slice(0, i)))) return true
  }
  return false
}

function writePathRefusal(entry, path) {
  if (hasExpressionAt(entry.descriptor.user, path) || hasExpressionAt(entry.raw?.current, path)) return 'expression-backed'
  const current = entry.raw?.current
  // Without the raw effective tree, a resolved inherited value cannot prove
  // that an edit is safe. A materialized user value is not proof against a
  // higher-precedence overlay, either. Do not try a mutation to test this.
  if (!isRecord(current)) return 'config-provenance-unavailable'
  const modelPath = path.slice(0, 4)
  const rawModel = ownAt(current, modelPath)
  const effectiveModel = ownAt(entry.descriptor.value, modelPath)
  if (!isRecord(rawModel) || typeof rawModel.id !== 'string' || rawModel.id !== effectiveModel?.id) {
    return isConfigExpression(rawModel?.id) ? 'expression-backed' : 'config-provenance-unavailable'
  }
  return undefined
}

/** Read ownership and revisioned settings once per catalog, not per model. */
export function createStandardEffortAvailability(settings, llm, configEditor) {
  if (typeof settings?.mutate !== 'function' || typeof settings?.describe !== 'function' ||
    typeof llm?.listConfigurableProviders !== 'function') return () => false
  try {
    const providers = llm.listConfigurableProviders()
    const raw = rawSettingsEntries(configEditor)
    const descriptors = settings.describe({ redactSecrets: true })
    const eligible = new Map()
    return (provider, model, installedModels) => {
      if (!eligible.has(provider)) {
        const models = new Set()
        try {
          const target = findRegisteredTarget(providers, provider, raw)
          if (target !== null && (!(llm.adapters instanceof Map) || isPiAiRouteAdapter(llm.adapters.get(provider)?.adapter))) {
            const entry = findSettingsEntry(descriptors, provider, target.ns, raw)
            if (entry) entry.installedModels = installedModels
            const seen = new Set()
            for (const row of entry?.models ?? []) {
              if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') continue
              if (seen.has(row.id)) models.delete(row.id)
              else if (canWriteStandardEffort(target, entry, row)) models.add(row.id)
              seen.add(row.id)
            }
          }
        } catch (_error) {
          models.clear()
        }
        eligible.set(provider, models)
      }
      return eligible.get(provider).has(model)
    }
  } catch (_error) {
    // An unavailable settings plane must not affect the normal catalog read.
    return () => false
  }
}

/**
 * Set fields on one existing models[] entry through the host revision check.
 * The caller retains all data not exactly represented by a successful write.
 */
export async function writeCapabilities(settings, override, {
  automatic = false, reasoningEffortMappings = override?.reasoningEffortMappings, standardEffort = false, referencePrefill = false, llm, configEditor, onDispatch,
} = {}) {
  const none = { written: false, fields: [] }
  const hasReasoning = effortIds(override).length > 0 || override?.reasoningSupported === false
  if (!hasInput(override) && !validContext(override?.contextWindow) && !hasReasoning) {
    return { ...none, reason: 'nothing' }
  }
  if (typeof settings?.mutate !== 'function' || typeof settings?.describe !== 'function') {
    return { ...none, reason: 'unsupported' }
  }

  let entry
  let target
  let adapter
  try {
    let raw = rawSettingsEntries(configEditor)
    target = findProviderTarget(llm, override.provider, raw)
    adapter = llm?.adapters instanceof Map ? llm.adapters.get(target?.provider)?.adapter : undefined
    if (!target || llm.adapters instanceof Map && !isPiAiRouteAdapter(adapter)) return { ...none, reason: 'provider-unverified' }
    let installedModels
    if (target.catalogProvider && typeof llm?.discoverModels === 'function') {
      installedModels = await readInstalledModelIds(llm, target)
      raw = rawSettingsEntries(configEditor)
      if (!isDeepStrictEqual(findProviderTarget(llm, override.provider, raw), target) ||
          (llm.adapters instanceof Map && llm.adapters.get(target.provider)?.adapter !== adapter)) {
        return { ...none, reason: 'provider-unverified' }
      }
    }
    const descriptors = settings.describe({ redactSecrets: true })
    entry = findSettingsEntry(descriptors, override.provider, target.ns, raw)
    if (entry) entry.installedModels = installedModels
  } catch (error) {
    return { ...none, reason: 'describe-failed', message: messageOf(error) }
  }
  if (entry === undefined) return { ...none, reason: 'provider-missing' }
  if (entry.models === undefined || entry.models.length === 0) {
    return { ...none, reason: target.catalogProvider ? 'native-catalog' : 'models-missing' }
  }
  const inheritedCatalog = inheritsCatalogModel(target, entry, override.model)
  if (automatic && inheritedCatalog) return { ...none, reason: 'native-catalog' }

  const isRequestedModel = (model) => isRecord(model) && model.id === override.model
  const index = entry.models.findIndex(isRequestedModel)
  if (index < 0 || entry.models.findLastIndex(isRequestedModel) !== index) return { ...none, reason: 'model-missing' }

  const { patch, localOnly, protectedFields, unresolvedEfforts, reasoningConflict, protectedEfforts } = planProviderPatch(override, {
    configured: entry.models[index], automatic, reasoningEffortMappings,
    inputDefault: entry.inputDefault, contextDefault: entry.contextDefault,
    defaultReasoning: entry.defaultReasoning, inheritedCatalog,
    standardEffort: !automatic && standardEffort === true,
    referencePrefill: referencePrefill === true,
    standardEffortAllowed: canWriteStandardEffort(target, entry, entry.models[index]),
  })
  const fields = Object.keys(patch)
  const diagnostic = {
    ...(localOnly.length ? { localOnly } : {}),
    ...(protectedFields.length ? { protectedFields } : {}),
    ...(unresolvedEfforts.length ? { unresolvedEfforts } : {}),
    ...(protectedEfforts.length ? { protectedEfforts } : {}),
    ...(reasoningConflict !== undefined ? { reasoningConflict } : {}),
  }
  if (fields.length === 0) {
    return { ...none, reason: localOnly.length ? 'local-only' : protectedFields.length ? 'protected' : 'nothing', ...diagnostic }
  }
  if (!Number.isSafeInteger(entry.revision)) return { ...none, reason: 'revision-unavailable', ...diagnostic }

  const path = [...target.path, 'models', String(index)]
  const ops = fields.flatMap((field) => field === 'supportsReasoningEffort' ? [
    { op: 'set', path: [...path, 'compat', 'thinkingFormat'], value: 'openai' },
    { op: 'set', path: [...path, 'compat', field], value: patch[field] },
  ] : [{ op: 'set', path: [...path, field], value: patch[field] }])
  for (const op of ops) {
    const refusal = writePathRefusal(entry, op.path)
    if (refusal !== undefined) return { ...none, reason: refusal, ...diagnostic }
  }
  try {
    onDispatch?.()
    await settings.mutate(entry.ns, ops, entry.revision)
  } catch (error) {
    return { ...none, reason: 'settings-failed', message: messageOf(error), ...diagnostic }
  }
  try {
    const after = rawSettingsEntries(configEditor)
    const descriptors = settings.describe({ redactSecrets: true })
    const owner = findProviderTarget(llm, override.provider, after)
    const verified = isDeepStrictEqual(owner, target) &&
      (!(llm.adapters instanceof Map) || llm.adapters.get(target.provider)?.adapter === adapter) &&
      findSettingsEntry(descriptors, override.provider, target.ns, after)
    if (verified && verified.models?.[index]?.id === override.model && verified.models.findLastIndex(isRequestedModel) === index &&
      verified.models.findIndex(isRequestedModel) === index && ops.every(({ path, value }) =>
        writePathRefusal(verified, path) === undefined &&
        isDeepStrictEqual(ownAt(verified.descriptor.value, path), value) &&
        isDeepStrictEqual(ownAt(verified.raw.current, path), value) &&
        isDeepStrictEqual(ownAt(verified.raw.override, path), value))) {
      return { written: true, fields, ns: entry.ns, ...diagnostic }
    }
  } catch (_error) {
    // Mutation may have reached storage; do not retry or discard the local copy.
  }
  return { ...none, reason: 'settings-unverified', ...diagnostic }
}

/** Remove only the local fields fully represented in the settings write. */
export function stripWrittenFields(override, fields, localOnly = []) {
  const mirrored = (field) => fields.includes(field) && !localOnly.includes(field)
  const remaining = { provider: override.provider, model: override.model }
  if (!mirrored('input') && override.input !== undefined) remaining.input = override.input
  if (!mirrored('contextWindow') && override.contextWindow !== undefined) remaining.contextWindow = override.contextWindow
  if (!mirrored('reasoningEfforts')) {
    if (override.efforts !== undefined) remaining.efforts = override.efforts
    if (override.reasoningSupported === false) remaining.reasoningSupported = false
  }
  if (override.defaultEffort !== undefined) remaining.defaultEffort = override.defaultEffort
  if (override.kind !== undefined) remaining.kind = override.kind
  return remaining
}
