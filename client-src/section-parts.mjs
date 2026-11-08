import { bucketOf, kindOf } from './format.mjs'

function countKinds(models) {
  const counts = { chat: 0, image: 0, video: 0, other: 0 }
  for (const model of models || []) counts[bucketOf(kindOf(model))] += 1
  return counts
}

/** Compact label + tooltip for one provider probe diagnostic. */
function probeOf(state, group, t) {
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
