import { FIELD } from './constants.mjs'

export function keyOf(provider, model) {
  return provider + '/' + model
}

export function hiddenSetOf(snapshot) {
  const value = snapshot && snapshot.value
  const list = value && Array.isArray(value[FIELD]) ? value[FIELD] : []
  return new Set(list)
}

export function providerLabel(group, t) {
  return group.id === 'deepseek-account' ? t('provider.account') : group.name
}

export const COLLAPSE_KEY = 'dsh-model-visibility:collapsed-groups:v1'

/** Group ids whose model lists the page keeps collapsed. */
export function readCollapsedGroups() {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch (_error) {
    return new Set()
  }
}

export function persistCollapsedGroups(collapsed) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch (_error) {
    // Storage can be unavailable (private mode, quota); collapsing still
    // works for this page session.
  }
}

export function countModels(groups) {
  let total = 0
  for (const group of groups || []) total += (group.models || []).length
  return total
}

/** Human context size: 1048576 → "1M", 128000 → "128K". */
export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens >= 1_000_000) return Math.round(tokens / 100_000) / 10 + 'M'
  if (tokens >= 1_000) return Math.round(tokens / 100) / 10 + 'K'
  return String(tokens)
}

/** Effort display names in catalog order. */
export function effortNames(reasoning) {
  const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  const names = []
  for (const effort of efforts) {
    if (effort === null || typeof effort !== 'object') continue
    const label = effort.name || effort.id
    if (typeof label === 'string' && label !== '') names.push(label)
  }
  return names
}

/** Display name of the default effort, or null when none is published. */
export function defaultEffortName(reasoning) {
  if (!reasoning || typeof reasoning.defaultEffort !== 'string') return null
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  const found = efforts.find((effort) => effort !== null && effort.id === reasoning.defaultEffort)
  return found && typeof found.name === 'string' && found.name !== ''
    ? found.name
    : reasoning.defaultEffort
}

/** Localized name of one input modality. */
export function modalityLabel(id, t) {
  const key = 'modality.' + id
  const label = t(key)
  return label === key ? id : label
}

/** Localized provenance label ("adapter", "relay model list", …). */
export function sourceLabel(source, t) {
  const key = 'source.' + (source || 'unknown')
  const label = t(key)
  return label === key ? t('source.unknown') : label
}

/** Per-field provenance recorded by the Host. */
export function sourceOf(model, field) {
  const sources = model && model.sources
  return sources && typeof sources[field] === 'string' ? sources[field] : 'unknown'
}

/** Catalog and name heuristics are completed values, not declarations. */
export function isInferredSource(source) {
  return source === 'catalog' || source === 'inferred'
}

/** Kind with a safe fallback for records from an older Host. */
export function kindOf(model) {
  return model && typeof model.kind === 'string' && model.kind !== '' ? model.kind : 'chat'
}

/** Filter bucket: chat / image / video / other. */
export function bucketOf(kind) {
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'chat') return 'chat'
  return 'other'
}

export function isGenerationKind(kind) {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

/** Resolution tier advertised in the model id ("-4k", "2K"). */
export function resolutionOf(model) {
  const text = String((model && model.id) || '')
  const match = /(?:^|[-_/])(4k|2k|8k|uhd|hd)(?:$|[-_/])/i.exec(text)
  return match === null ? null : match[1].toUpperCase()
}

/** "文本 / 图像" for one modality array. */
export function modalityNames(modalities, t) {
  return (Array.isArray(modalities) ? modalities : []).map((id) => modalityLabel(id, t)).join(' / ')
}

/** Input modalities the manual editor can declare, in display order. */
export const OVERRIDE_MODALITIES = ['text', 'image', 'audio', 'video', 'file']

/** Effort levels the manual editor can declare, in display order. */
export const OVERRIDE_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Localized name of one effort id. */
export function effortLabel(id, t) {
  const key = 'effort.' + id
  const label = t(key)
  return label === key ? id : label
}

/** Identity of a manual override entry; same shape as the row key. */
export function overrideKeyOf(entry) {
  return entry ? keyOf(entry.provider, entry.model) : null
}

/** Model fields whose provenance can be manual. */
export function manualFieldsOf(model) {
  const sources = model && model.sources ? model.sources : {}
  return ['kind', 'reasoning', 'context', 'modalities'].filter(
    (field) => sources[field] === 'manual',
  )
}
