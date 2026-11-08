/**
 * Pure helpers that never touch React or the DOM, so `node --test` can call
 * them directly.
 *
 * @module client-src/pure
 */

/** Number of one bucket's token sum, guarding partial buckets. */
export function bucketTotalOf(buckets) {
  if (!Array.isArray(buckets)) return 0
  return buckets.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
}

/** 1234567 → "1.2M"; 4096 → "4.1K"; 0/undefined → "0". */
export function formatTokens(value) {
  const tokens = Number.isFinite(value) ? value : 0
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 100_000)) / 10
    return Number.isInteger(millions) ? `${millions}M` : millions.toFixed(1) + 'M'
  }
  if (tokens >= 1_000) {
    const thousands = Math.round(tokens / 100) / 10
    return Number.isInteger(thousands) ? `${thousands}K` : thousands.toFixed(1) + 'K'
  }
  return String(tokens)
}

/** Local-calendar `YYYY-MM-DD` stamp used by the ledger's day buckets. */
export function dayKeyOf(time) {
  const date = new Date(Number.isFinite(time) ? time : Date.now())
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** First day (Monday) of the local ISO week of `time`. */
export function weekKeyOf(time) {
  const date = new Date(Number.isFinite(time) ? time : Date.now())
  const weekday = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - weekday)
  return dayKeyOf(date.getTime())
}

/** Local calendar month prefix of `time`. */
export function monthPrefixOf(time) {
  return dayKeyOf(time).slice(0, 7)
}

/**
 * Apply the section's filters to one catalog.
 *
 * Mirrors the settings page exactly; the composer filter is a separate,
 * simpler pass (visibility only). Inputs are the loaded groups plus the five
 * filter axes; output keeps the group objects in order with only kept models.
 */
export function computeFilteredGroups(groups, { filter = 'all', query = '', multimodalOnly = false, reasoningOnly = false, minContext = 0 } = {}) {
  const normalized = String(query ?? '').trim().toLowerCase()
  const filtered = []
  for (const group of groups ?? []) {
    const models = []
    for (const model of group.models ?? []) {
      if (filter !== 'all' && bucket(model) !== filter) continue
      if (normalized !== '') {
        const name = String(model.name ?? '').toLowerCase()
        const id = String(model.id ?? '').toLowerCase()
        if (!name.includes(normalized) && !id.includes(normalized)) continue
      }
      if (multimodalOnly && !(Array.isArray(model.inputModalities) && model.inputModalities.includes('image'))) {
        continue
      }
      if (reasoningOnly && model.reasoningSupported !== true) continue
      if (minContext > 0 && !(Number.isFinite(model.contextWindow) && model.contextWindow >= minContext)) {
        continue
      }
      models.push(model)
    }
    if (models.length > 0) filtered.push({ ...group, models })
  }
  return filtered
}

function bucket(model) {
  const kind = model && typeof model.kind === 'string' && model.kind !== '' ? model.kind : 'chat'
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'chat') return 'chat'
  return 'other'
}

/** Counts per kind bucket for the whole list. */
export function countKinds(models) {
  const counts = { chat: 0, image: 0, video: 0, other: 0 }
  for (const model of models ?? []) counts[bucket(model)] += 1
  return counts
}

/** Checker-model candidates from a loaded catalog state. */
export function checkerRoutesOf(groups) {
  const routes = []
  for (const group of groups ?? []) {
    if (group === null || typeof group !== 'object') continue
    const models = Array.isArray(group.models) ? group.models : []
    if (models.length > 0) routes.push({ id: group.id, name: group.name ?? group.id })
  }
  return routes
}

/** Compact label + tooltip for one provider probe diagnostic. */
export function probeOf(state, group, t) {
  const list = Array.isArray(state.providers) ? state.providers : []
  const diagnostic = list.find((item) => item && item.id === group.id)
  if (diagnostic === undefined) return null
  const details = [
    diagnostic.host ? 'host: ' + diagnostic.host : null,
    diagnostic.status ? 'status: ' + diagnostic.status : null,
    diagnostic.message ? 'message: ' + diagnostic.message : null,
    diagnostic.pricing && diagnostic.pricing !== 'skipped' ? 'pricing: ' + diagnostic.pricing : null,
  ]
    .filter(Boolean)
    .join('\n')
  if (diagnostic.status === 'ok') {
    return {
      label:
        Number(diagnostic.capabilities) > 0
          ? t('group.probeOk', {
              models: diagnostic.models ?? 0,
              caps: diagnostic.capabilities,
            })
          : t('group.probeNoCaps', { models: diagnostic.models ?? 0 }),
      title: details,
    }
  }
  if (diagnostic.status === 'failed' || diagnostic.status === 'unauthorized') {
    return { label: t('group.probeFailed'), title: details }
  }
  return { label: t('group.probeSkipped'), title: details }
}
