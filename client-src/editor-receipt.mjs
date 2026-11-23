import { effortLabel } from './format.mjs'

/** A 200 response to the local save is not evidence of a provider write. */
function providerWriteNote(result, t, action = {}, receipt = {}) {
  const localWarning = receipt.localReadUnavailable === true ? t('override.localReadUnavailable')
    : receipt.localCleanup === 'changed' ? t('override.localCleanupChanged')
    : receipt.localCleanup === 'unavailable' ? t('override.localCleanupUnavailable') : ''
  const join = (...messages) => [...messages, localWarning].filter(Boolean).join(' · ')
  if (action.mode === 'reset') return join(t('override.resetDone'))
  if (action.mode === 'local') return join(t('override.localDone'))
  const strings = (value) => Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && v !== ''))] : []
  const labels = (fields) => fields.map((field) => {
    const key = 'override.field.' + field
    const label = t(key)
    return label === key ? field : label
  }).join(' / ')
  const writtenFields = result?.written === true ? strings(result.fields) : []
  const localFields = new Set(strings(result?.localOnly))
  for (const field of strings(action.fields)) if (!writtenFields.includes(field)) localFields.add(field)
  const messages = []
  const reason = typeof result?.reason === 'string' ? result.reason : ''
  const reused = strings(result?.reusedEfforts)
  const alreadyMapped = result?.written === false && reason === 'already-mapped'
  const someExisting = !writtenFields.includes('reasoningEfforts') && (alreadyMapped || reused.length > 0)
  if (someExisting) localFields.delete('reasoningEfforts')
  // This draft's local commit once succeeded, but another edit or an unreadable file prevented
  // dispatch. The currently stored values are not necessarily this draft's values.
  if (!writtenFields.length && ['override-changed', 'overrides-unavailable'].includes(reason)) return t('override.recheckLocal', { reason: t('override.reason.' + reason) })
  if (writtenFields.length) {
    // A verified map write may have represented *some*, not all, requested levels. An overlapping
    // field must never appear under either a blanket success or an "only local" heading.
    const partial = writtenFields.filter((field) => localFields.has(field))
    const fullyWritten = writtenFields.filter((field) => !localFields.has(field))
    if (fullyWritten.length) messages.push(t('override.providerWritten', { fields: labels(fullyWritten) }))
    if (partial.includes('reasoningEfforts')) messages.push(t('override.partialEfforts'))
    const others = partial.filter((field) => field !== 'reasoningEfforts')
    if (others.length) messages.push(t('override.partialFields', { fields: labels(others) }))
    for (const field of partial) localFields.delete(field)
  } else if (alreadyMapped) {
    messages.push(t('override.reason.already-mapped'))
  } else if (!result || result.written !== false || !reason || ['settings-unverified', 'settings-failed', 'write-pending'].includes(reason)) {
    // The server may have accepted the mutation: do not tell the user to retry it.
    messages.push(t('override.providerUnconfirmed'))
    if (reason === 'write-pending') messages.push(t('override.reason.write-pending'))
  } else {
    const key = 'override.reason.' + reason
    const label = t(key)
    messages.push(t('override.providerSkipped', { reason: label === key ? reason : label }))
  }
  if (localFields.size > 0 && !localWarning) {
    // With an unverified write the local copy is retained, but we cannot claim the fields exist *only* locally.
    messages.push(t(!writtenFields.length && (!reason || ['settings-unverified', 'settings-failed', 'write-pending'].includes(reason) || result?.written !== false)
      ? 'override.localRetained' : 'override.localOnly', { fields: labels([...localFields]) }))
  }
  if (reused.length) messages.push(t('override.reusedEfforts', { levels: reused.map((id) => effortLabel(id, t)).join(' / ') }))
  if (someExisting && !alreadyMapped && strings(result?.localOnly).includes('reasoningEfforts')) messages.push(t('override.ladderRetained'))
  const protectedFields = strings(result?.protectedFields)
  if (protectedFields.length) messages.push(t('override.protectedFields', { fields: labels(protectedFields) }))
  const unresolved = strings(result?.unresolvedEfforts)
  if (unresolved.length) messages.push(t('override.unresolvedEfforts', { levels: unresolved.map((id) => effortLabel(id, t)).join(' / ') }))
  const conflict = {
    'route-default': 'override.routeDefaultConflict', 'inherited-ladder': 'override.inheritedLadderConflict',
    'standard-format': 'override.standardFormatConflict', 'reference-disabled': 'override.referenceDisabled',
    'reference-nonchat': 'override.referenceNonChat', 'expression-backed': 'override.reason.expression-backed',
    'config-provenance-unavailable': 'override.reason.config-provenance-unavailable',
  }[result?.reasoningConflict]
  if (typeof conflict === 'string' && (writtenFields.length || reason !== result.reasoningConflict)) messages.push(t(conflict))
  const kept = strings(result?.protectedEfforts)
  if (kept.length) messages.push(t('override.referencePreservedEfforts', { levels: kept.map((id) => effortLabel(id, t)).join(' / ') }))
  return join(...messages)
}

export { providerWriteNote }
