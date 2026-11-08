/**
 * CSV builders behind the one-click exports.
 *
 * Both functions are pure string builders so the route layer only wires
 * response headers, and the unit suite pins the dialect (RFC 4180 quoting,
 * CRLF rows) independent of the Host.
 *
 * @module lib/export-csv
 */

/** Quote one CSV field, RFC 4180 style. */
function csvField(value) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

/** Prefix the sheet with the window totals, then one (day, route) row each. */
export function toUsageCsv(summary) {
  const fmt = (buckets) => `${buckets?.[0] ?? 0},${buckets?.[1] ?? 0},${buckets?.[2] ?? 0},${buckets?.[3] ?? 0}`
  const rows = []
  rows.push('section,range,input,output,cacheRead,cacheWrite')
  const ranges = summary?.ranges ?? {}
  for (const name of ['today', 'week', 'month', 'total']) {
    rows.push(`sum,${name},${fmt(ranges[name])}`)
  }
  rows.push('')
  rows.push('day,provider/model,input,output,cacheRead,cacheWrite')
  const days = summary?.days ?? {}
  const dayKeys = Object.keys(days).sort()
  for (const dayKey of dayKeys) {
    const byRoute = days[dayKey] ?? {}
    for (const [route, values] of Object.entries(byRoute)) {
      // `*` is the day's own total; the per-route rows already carry it.
      if (route === '*' || values.every((n) => n === 0)) continue
      rows.push(`${dayKey},${route},${fmt(values)}`)
    }
  }
  return `${rows.join('\r\n')}\r\n`
}

/** One row per model: visibility, kind, context window, modalities, sources. */
export function toModelListCsv(catalog, { hidden = [] } = {}) {
  const hiddenKeys = new Set(hidden)
  const rows = ['provider,model,hidden,kind,inputModalities,contextWindow,reasoning,reasoningSupported,sources']
  for (const group of catalog?.groups ?? []) {
    for (const model of group?.models ?? []) {
      const sources = model.sources ?? {}
      const reasoning = model.reasoning?.efforts?.map((effort) => effort.id).join('|') ?? []
      rows.push(
        [
          group.id,
          model.id,
          hiddenKeys.has(`${group.id}/${model.id}`) ? 1 : 0,
          model.kind ?? '',
          (model.inputModalities ?? []).join('|'),
          model.contextWindow ?? '',
          reasoning.length > 0 ? reasoning.join('|') : '',
          model.reasoningSupported === true ? 'yes' : model.reasoningSupported === false ? 'no' : '',
          `${sources.modalities ?? 'unknown'};${sources.context ?? 'unknown'};${sources.reasoning ?? 'unknown'}`,
        ]
          .map(csvField)
          .join(','),
      )
    }
  }
  return `${rows.join('\r\n')}\r\n`
}
