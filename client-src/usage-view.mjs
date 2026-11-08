/**
 * Token-usage strip with the one-click exports.
 *
 * The strip renders the ledger's today/week/month/total buckets and links the
 * two CSV endpoints. It is an inner piece of the settings section: the section
 * supplies the translator and the usage store instance.
 *
 * @module client-src/usage-view
 */

const React = require('react')
const h = React.createElement

import { API } from './constants.mjs'
import { formatTokens } from './pure.mjs'
import { useSource } from './hooks.mjs'

/** Render one [in, out] window as "输入 x · 输出 y". */
function rangeText(range, t) {
  if (!Array.isArray(range) || range.every((value) => value === 0)) return t('usage.none')
  const input = (range[0] ?? 0) + (range[2] ?? 0) + (range[3] ?? 0)
  const output = range[1] ?? 0
  return t('usage.range', {
    input: formatTokens(input),
    output: formatTokens(output),
    total: formatTokens(input + output),
  })
}

/** Trigger a same-origin download without leaving the page. */
function download(href) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function UsageToolbar({ usage, t, features }) {
  const state = useSource(usage)
  const supported = features.length === 0 || features.includes('usage')
  const ranges = state.snapshot?.ranges
  const computing = state.snapshot?.computing === true
  return h(
    'div',
    { className: 'mvp_usage' + (supported ? '' : ' mvp_usage--off') },
    h(
      'div',
      { className: 'mvp_usageHead' },
      h('span', { className: 'mvp_usageTitle' }, t('usage.title')),
      computing ? h('span', { className: 'mvp_usageComputing' }, t('usage.computing')) : null,
      h(
        'span',
        { className: 'mvp_usageActions' },
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_button',
            title: t('usage.exportUsageTitle'),
            onClick: () => download(`${API}/export?type=usage`),
          },
          t('usage.exportUsage'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_button',
            title: t('usage.exportModelsTitle'),
            onClick: () => download(`${API}/export?type=models`),
          },
          t('usage.exportModels'),
        ),
      ),
    ),
    supported
      ? h(
          'div',
          { className: 'mvp_usageRanges' },
          h(
            'span',
            { className: 'mvp_stat', title: t('usage.todayTitle') },
            h('span', { className: 'mvp_statLabel' }, t('usage.today')),
            h('span', { className: 'mvp_statValue' }, rangeText(ranges?.today, t)),
          ),
          h(
            'span',
            { className: 'mvp_stat', title: t('usage.weekTitle') },
            h('span', { className: 'mvp_statLabel' }, t('usage.week')),
            h('span', { className: 'mvp_statValue' }, rangeText(ranges?.week, t)),
          ),
          h(
            'span',
            { className: 'mvp_stat', title: t('usage.monthTitle') },
            h('span', { className: 'mvp_statLabel' }, t('usage.month')),
            h('span', { className: 'mvp_statValue' }, rangeText(ranges?.month, t)),
          ),
          h(
            'span',
            { className: 'mvp_stat mvp_stat--total', title: t('usage.totalTitle') },
            h('span', { className: 'mvp_statLabel' }, t('usage.total')),
            h('span', { className: 'mvp_statValue' }, rangeText(ranges?.total, t)),
          ),
        )
      : h('div', { className: 'mvp_usageHint' }, t('usage.hostStale')),
    state.error !== null
      ? h('div', { className: 'mvp_usageHint mvp_usageHint--warn' }, state.error)
      : null,
  )
}
