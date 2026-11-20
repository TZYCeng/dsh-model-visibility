/**
 * Token-usage strip with the two CSV exports.
 *
 * One line, four numbers, two icon-sized buttons: the strip is context, not
 * the point of the page, so it must not push the model list down. Exact
 * numbers live in the tooltip; the visible figure is the total.
 */

const React = require('react')
const h = React.createElement

import { API } from './constants.mjs'
import { formatTokens } from './pure.mjs'
import { useSource } from './hooks.mjs'

/** Total of one bucket tuple (input + output + cache read + cache write). */
function totalOf(range) {
  if (!Array.isArray(range)) return 0
  return range.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
}

/** Detail line for one window: input / output / cache split. */
function detailOf(range, t) {
  if (!Array.isArray(range) || totalOf(range) === 0) return t('usage.none')
  const input = (range[0] ?? 0) + (range[2] ?? 0) + (range[3] ?? 0)
  const output = range[1] ?? 0
  return t('usage.detail', {
    input: formatTokens(input),
    output: formatTokens(output),
    cacheRead: formatTokens(range[2] ?? 0),
    cacheWrite: formatTokens(range[3] ?? 0),
  })
}

/** Download only a successful CSV response, not a Host JSON error document. */
async function download(type) {
  const response = await fetch(API + '/export?type=' + type, {
    headers: { accept: 'text/csv' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  })
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json())?.error?.message ?? '' } catch (_error) { /* status is enough */ }
    throw new Error('HTTP ' + response.status + (detail ? ': ' + detail : ''))
  }
  if (!/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected a CSV response.')
  const filename = /filename="([A-Za-z0-9_.-]+\.csv)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
  const href = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  try {
    anchor.href = href
    anchor.rel = 'noopener'
    anchor.download = filename ?? 'model-visibility-' + type + '.csv'
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    // Leave time for the browser to acquire the blob before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
}

export function UsageToolbar({ usage, t, features }) {
  const state = useSource(usage)
  const supported = features.length === 0 || features.includes('usage')
  const ranges = state.snapshot?.ranges
  const computing = state.snapshot?.computing === true
  const scanError = state.snapshot?.error
  const [exporting, setExporting] = React.useState(null)
  const [exportError, setExportError] = React.useState(null)

  const startExport = (type) => {
    if (exporting !== null) return
    setExporting(type)
    setExportError(null)
    void download(type).catch((error) => setExportError(String(error?.message ?? error)))
      .finally(() => setExporting(null))
  }

  if (!supported) {
    return h('div', { className: 'mvp_usage mvp_usage--off' }, t('usage.hostStale'))
  }

  const windows = [
    ['today', 'usage.today', 'usage.todayTitle'],
    ['week', 'usage.week', 'usage.weekTitle'],
    ['month', 'usage.month', 'usage.monthTitle'],
    ['total', 'usage.total', 'usage.totalTitle'],
  ]

  return h(
    'div',
    { className: 'mvp_usage' },
    h(
      'span',
      { className: 'mvp_usageLabel' },
      t('usage.title'),
      computing ? h('span', { className: 'mvp_usageComputing', role: 'status' }, t('usage.computing')) : null,
    ),
    h(
      'span',
      { className: 'mvp_usageRanges' },
      windows.map(([key, labelKey, titleKey]) => {
        const range = ranges?.[key]
        const total = totalOf(range)
        // Zero from a cold or failed scan isn't yet a confirmed zero.
        const known = Array.isArray(range) && (total > 0 || (!computing && !scanError && !state.error))
        return h(
          'span',
          {
            key,
            className: 'mvp_stat' + (key === 'total' ? ' mvp_stat--total' : ''),
            title: t(titleKey) + '\n' + detailOf(range, t),
          },
          h('span', { className: 'mvp_statLabel' }, t(labelKey)),
          h('span', { className: 'mvp_statValue' }, known ? formatTokens(total) : t('usage.none')),
        )
      }),
    ),
    h(
      'span',
      { className: 'mvp_usageActions' },
      h(
        'button',
        {
          type: 'button',
          className: 'mvp_button mvp_button--quiet',
          title: t('usage.exportUsageTitle'),
          disabled: exporting !== null,
          onClick: () => startExport('usage'),
        },
        t('usage.exportUsage'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mvp_button mvp_button--quiet',
          title: t('usage.exportModelsTitle'),
          disabled: exporting !== null,
          onClick: () => startExport('models'),
        },
        t('usage.exportModels'),
      ),
    ),
    exporting !== null ? h('span', { className: 'mvp_usageHint', role: 'status' },
      t(exporting === 'usage' ? 'usage.exportingUsage' : 'usage.exportingModels')) : null,
    (state.error || scanError) ? h('span', { className: 'mvp_usageHint mvp_usageHint--warn', role: 'alert' },
      t('usage.readFailed', { message: state.error || scanError })) : null,
    exportError !== null ? h('span', { className: 'mvp_usageHint mvp_usageHint--warn', role: 'alert' },
      t('usage.exportFailed', { message: exportError })) : null,
  )
}
