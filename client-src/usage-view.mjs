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
import { bucketTotalOf, formatTokens } from './pure.mjs'
import { useSource } from './hooks.mjs'

/** Detail line for one window: input / output / cache split. */
function detailOf(range, t) {
  if (!Array.isArray(range)) return t('usage.none')
  // Exactly the four non-overlapping buckets exported to CSV, unrounded.
  return t('usage.detail', {
    input: range[0] ?? 0,
    output: range[1] ?? 0,
    cacheRead: range[2] ?? 0,
    cacheWrite: range[3] ?? 0,
  })
}

/** Download only a successful CSV response, not a Host JSON error document. */
async function download(type, signal) {
  const response = await fetch(API + '/export?type=' + type, {
    headers: { accept: 'text/csv' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
  })
  signal.throwIfAborted()
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json())?.error?.message ?? '' } catch (_error) { /* status is enough */ }
    throw new Error('HTTP ' + response.status + (detail ? ': ' + detail : ''))
  }
  if (!/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected a CSV response.')
  const filename = /filename="([A-Za-z0-9_.-]+\.csv)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
  const blob = await response.blob()
  signal.throwIfAborted() // A fetch shim may ignore abort and still resolve its body.
  const href = URL.createObjectURL(blob)
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

// Cover headers, error documents and the final blob. Release the UI even if
// a nonconforming transport ignores abort; download guards its side effects.
async function boundedDownload(type, controller) {
  const { signal } = controller
  const timer = setTimeout(() => controller.abort(new Error('CSV download timed out')), 120_000)
  let stop
  const aborted = new Promise((_, reject) => {
    stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    signal.throwIfAborted()
    await Promise.race([download(type, signal), aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
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
  const activeExport = React.useRef(null)
  React.useEffect(() => () => {
    const controller = activeExport.current
    activeExport.current = null
    controller?.abort()
  }, [])

  const startExport = (type) => {
    if (activeExport.current !== null) return
    const controller = new AbortController()
    activeExport.current = controller
    setExporting(type)
    setExportError(null)
    void boundedDownload(type, controller).catch(error => {
      if (activeExport.current === controller) setExportError(String(error?.message ?? error))
    }).finally(() => {
      if (activeExport.current !== controller) return
      activeExport.current = null
      setExporting(null)
    })
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

  const notices = [
    computing && t('usage.computing'),
    exporting !== null && t(exporting === 'usage' ? 'usage.exportingUsage' : 'usage.exportingModels'),
    (state.error || scanError) && t('usage.readFailed', { message: state.error || scanError }),
    exportError !== null && t('usage.exportFailed', { message: exportError }),
  ].filter(Boolean)

  return h(
    'div',
    { className: 'mvp_usage' },
    h('span', { className: 'mvp_usageLabel' }, t('usage.title')),
    h(
      'span',
      { className: 'mvp_usageRanges' },
      windows.map(([key, labelKey, titleKey]) => {
        const range = ranges?.[key]
        const total = bucketTotalOf(range)
        // Zero from a cold or failed scan isn't yet a confirmed zero.
        const known = Array.isArray(range) && (total > 0 || (!computing && !scanError && !state.error))
        return h(
          'span',
          {
            key,
            className: 'mvp_stat' + (key === 'total' ? ' mvp_stat--total' : ''),
            title: t(titleKey) + '\n' + (known ? detailOf(range, t) : t('usage.none')),
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
    h('span', { className: 'mvp_usageStatus', role: 'status', 'aria-live': 'polite', 'aria-atomic': true,
      title: notices.length ? notices.join('\n') : undefined, tabIndex: exporting || state.error || scanError || exportError ? 0 : undefined },
      notices.map((text, i) => h('span', { key: i, className: 'mvp_usageStatusText' }, text))),
  )
}
