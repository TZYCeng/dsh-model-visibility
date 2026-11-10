/**
 * CSV builders behind the one-click exports.
 *
 * Both functions are pure string builders so the route layer only wires
 * response headers, and the unit suite pins the dialect (RFC 4180 quoting,
 * CRLF rows) independent of the Host.
 *
 * @module lib/export-csv
 */

/** Quote one CSV field, RFC 4180 style, and defuse spreadsheet formulas. */
function csvField(value) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  // A leading =, +, -, @ or tab makes Excel/Sheets evaluate the cell. Model
  // ids come from a third-party relay, so they are not trusted input.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

/** Render one bucket tuple as four CSV columns. */
function bucketFields(buckets) {
  return [0, 1, 2, 3].map((index) => csvField(buckets?.[index] ?? 0))
}

/**
 * Prefix the sheet with the window totals, then one (day, route) row each.
 *
 * `summary.days` is `{ dayKey: [in, out, cacheRead, cacheWrite] }` — the ledger
 * folds to a single tuple per day. Per-route detail lives in `summary.byModel`
 * (`{ "provider/model": tuple }`) and has no day dimension, so it is exported
 * as its own section rather than being mistaken for a day/route map.
 */
export function toUsageCsv(summary) {
  const rows = []
  rows.push('section,range,input,output,cacheRead,cacheWrite')
  const ranges = summary?.ranges ?? {}
  for (const name of ['today', 'week', 'month', 'total']) {
    // `range` is a single bucket tuple, so it expands to the four numeric
    // columns rather than being joined as if it were a string.
    rows.push(['sum', name, ...bucketFields(ranges[name])].join(','))
  }

  rows.push('')
  rows.push('day,input,output,cacheRead,cacheWrite')
  const days = summary?.days ?? {}
  for (const dayKey of Object.keys(days).sort()) {
    const values = days[dayKey]
    if (!Array.isArray(values)) continue
    if (values.every((n) => n === 0)) continue
    rows.push([csvField(dayKey), ...bucketFields(values)].join(','))
  }

  const byModel = summary?.byModel ?? {}
  const modelKeys = Object.keys(byModel).sort()
  if (modelKeys.length > 0) {
    rows.push('')
    rows.push('provider/model,input,output,cacheRead,cacheWrite')
    for (const route of modelKeys) {
      if (route === '*') continue
      const values = byModel[route]
      if (!Array.isArray(values)) continue
      if (values.every((n) => n === 0)) continue
      rows.push([csvField(route), ...bucketFields(values)].join(','))
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
      // `efforts` is an array of `{ id, name }`; joining it needs the ids, not
      // the array itself (the old code called `.join` on the array and threw).
      const efforts = Array.isArray(model.reasoning?.efforts)
        ? model.reasoning.efforts
            .map((effort) => (typeof effort === 'string' ? effort : effort?.id))
            .filter((id) => typeof id === 'string' && id !== '')
        : []
      rows.push(
        [
          group.id,
          model.id,
          hiddenKeys.has(`${group.id}/${model.id}`) ? 1 : 0,
          model.kind ?? '',
          (model.inputModalities ?? []).join('|'),
          model.contextWindow ?? '',
          efforts.join('|'),
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
