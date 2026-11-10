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

/** Trigger a same-origin download without leaving the page. */
function download(href) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.rel = 'noopener'
  anchor.download = ''
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function UsageToolbar({ usage, t, features }) {
  const state = useSource(usage)
  const supported = features.length === 0 || features.includes('usage')
  const ranges = state.snapshot?.ranges
  const computing = state.snapshot?.computing === true

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
      computing ? h('span', { className: 'mvp_usageComputing' }, t('usage.computing')) : null,
    ),
    h(
      'span',
      { className: 'mvp_usageRanges' },
      windows.map(([key, labelKey, titleKey]) =>
        h(
          'span',
          {
            key,
            className: 'mvp_stat' + (key === 'total' ? ' mvp_stat--total' : ''),
            title: t(titleKey) + '\n' + detailOf(ranges?.[key], t),
          },
          h('span', { className: 'mvp_statLabel' }, t(labelKey)),
          h('span', { className: 'mvp_statValue' }, formatTokens(totalOf(ranges?.[key]))),
        ),
      ),
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
          onClick: () => download(`${API}/export?type=usage`),
        },
        t('usage.exportUsage'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mvp_button mvp_button--quiet',
          title: t('usage.exportModelsTitle'),
          onClick: () => download(`${API}/export?type=models`),
        },
        t('usage.exportModels'),
      ),
    ),
    state.error !== null
      ? h('span', { className: 'mvp_usageHint mvp_usageHint--warn' }, state.error)
      : null,
  )
}
