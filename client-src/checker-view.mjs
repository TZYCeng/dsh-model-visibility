/**
 * The online capability verification panel.
 *
 * Collapsed to a single summary line: this is a maintenance action, not the
 * point of the page. Expanding it reveals the checker picker, the write-back
 * switch and — the part that matters when a sweep fails — the per-batch errors
 * with their real messages instead of a bare count.
 *
 * The last route choice is kept in browser storage only: the Host persists run
 * facts, not UI selections.
 */

const React = require('react')
const h = React.createElement

import { formatTokens, checkerRoutesOf } from './pure.mjs'
import { useSource } from './hooks.mjs'

const PICK_KEY = 'dsh-model-visibility:checker-pick:v1'
/** Bound live batch details so progress cannot overwhelm the panel. */
const MAX_ACTIVE_BATCH_LINES = 3
/** How many failure lines to show before summarising the rest. */
const MAX_ERROR_LINES = 6
/** Concurrency choices offered in the panel; mirrors lib/check-catalog MAX_CONCURRENCY. */
const CONCURRENCY_CHOICES = [1, 2, 3, 4, 6, 8]

function readPick() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PICK_KEY))
    return parsed !== null && typeof parsed === 'object'
      ? {
          provider: typeof parsed.provider === 'string' ? parsed.provider : '',
          model: typeof parsed.model === 'string' ? parsed.model : '',
          writeBack: parsed.writeBack === true,
          webSearch: parsed.webSearch !== false,
          concurrency:
            Number.isFinite(parsed.concurrency) && parsed.concurrency > 0
              ? Math.min(8, Math.max(1, Math.trunc(parsed.concurrency)))
              : 2,
        }
      : { provider: '', model: '', writeBack: false, webSearch: true, concurrency: 2 }
  } catch (_error) {
    return { provider: '', model: '', writeBack: false, webSearch: true, concurrency: 2 }
  }
}

function persistPick(pick) {
  try {
    window.localStorage.setItem(PICK_KEY, JSON.stringify(pick))
  } catch (_error) {
    // Storage availability is optional for this preference.
  }
}

export function VerifyPanel({ verify, catalog, t, canUse }) {
  const state = useSource(verify)
  const [pick, setPick] = React.useState(readPick)
  const [message, setMessage] = React.useState(null)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    verify.load()
  }, [verify])

  const routeOptions = checkerRoutesOf(catalog?.groups)
  const route = routeOptions.find((entry) => entry.id === pick.provider) ?? null
  const progress = state.snapshot?.state
  const running = progress?.running === true
  const finished = progress?.phase === 'done' || progress?.phase === 'cancelled'
  const models = (catalog?.groups ?? [])
    .find((group) => group.id === pick.provider)?.models ?? []

  if (!canUse) {
    return h('div', { className: 'mvp_banner' }, t('checker.hostStale'))
  }

  const tokensSpent = progress
    ? formatTokens((progress.tokenUsage?.[0] ?? 0) + (progress.tokenUsage?.[1] ?? 0))
    : null

  const commit = (next) => {
    setPick(next)
    persistPick(next)
  }

  const run = () => {
    setMessage(null)
    verify
      .start({
        provider: pick.provider,
        model: pick.model,
        writeBack: pick.writeBack,
        webSearch: pick.webSearch,
        concurrency: pick.concurrency,
      })
      .catch((error) => setMessage(String(error?.message ?? error)))
  }

  const cancel = () => {
    verify.cancel().catch((error) => setMessage(String(error?.message ?? error)))
  }

  const counts = {
    processed: progress?.processed ?? progress?.done ?? 0,
    total: progress?.total ?? 0,
    valid: progress?.done ?? 0,
    unknown: progress?.unknown ?? 0,
    failed: progress?.failed ?? 0,
    searchCalls: progress?.searchCalls ?? 0,
    fetchCalls: progress?.fetchCalls ?? 0,
    tokens: tokensSpent,
  }
  const summary = running
    ? t('checker.running', {
        phase: t('checker.phase.' + (progress?.phase ?? 'verifying')),
        ...counts,
      })
    : finished
      ? t('checker.finished', counts)
      : t('checker.idle')

  const activeBatches = running && Array.isArray(progress?.batches)
    ? progress.batches.filter((batch) => batch.status === 'running')
    : []
  const visibleBatches = activeBatches.slice(0, MAX_ACTIVE_BATCH_LINES)
  const errors = Array.isArray(progress?.errors) ? progress.errors : []
  const visibleErrors = errors.slice(0, MAX_ERROR_LINES)

  return h(
    'div',
    { className: 'mvp_checker' + (open ? '' : ' mvp_checker--closed') },
    h(
      'button',
      {
        type: 'button',
        className: 'mvp_checkerHead',
        'aria-expanded': open,
        onClick: () => setOpen(!open),
      },
      h('span', { className: 'mvp_chevron' }, open ? '▾' : '▸'),
      h('span', { className: 'mvp_checkerTitle' }, t('checker.title')),
      h('span', { className: 'mvp_checkerSummary' }, summary),
      errors.length > 0 ? h('span', { className: 'mvp_badge' }, t('checker.errorBadge', { count: errors.length })) : null,
    ),
    open
      ? h(
          'div',
          { className: 'mvp_checkerBody' },
          h('p', { className: 'mvp_checkerHint' }, t('checker.description')),
          h(
            'div',
            { className: 'mvp_checkerForm' },
            h(
              'label',
              { className: 'mvp_field' },
              h('span', { className: 'mvp_fieldLabel' }, t('checker.provider')),
              h(
                'select',
                {
                  className: 'mvp_select',
                  value: pick.provider,
                  'aria-label': t('checker.provider'),
                  onChange: (event) => commit({ ...pick, provider: event.target.value, model: '' }),
                },
                h('option', { key: '', value: '' }, t('override.kindAuto')),
                routeOptions.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
              ),
            ),
            h(
              'label',
              { className: 'mvp_field' },
              h('span', { className: 'mvp_fieldLabel' }, t('checker.model')),
              h(
                'select',
                {
                  className: 'mvp_select',
                  value: pick.model,
                  'aria-label': t('checker.model'),
                  disabled: route === null,
                  onChange: (event) => commit({ ...pick, model: event.target.value }),
                },
                h('option', { key: '', value: '' }, t('override.kindAuto')),
                models.map((model) =>
                  h('option', { key: model.id, value: model.id }, model.name ?? model.id),
                ),
              ),
            ),
            h(
              'label',
              { className: 'mvp_field', title: t('checker.concurrencyTitle') },
              h('span', { className: 'mvp_fieldLabel' }, t('checker.concurrency')),
              h(
                'select',
                {
                  className: 'mvp_select',
                  value: String(pick.concurrency),
                  'aria-label': t('checker.concurrency'),
                  disabled: running,
                  onChange: (event) =>
                    commit({ ...pick, concurrency: Number(event.target.value) }),
                },
                CONCURRENCY_CHOICES.map((value) =>
                  h('option', { key: value, value: String(value) }, t('checker.concurrencyValue', { count: value })),
                ),
              ),
            ),
            h(
              'label',
              { className: 'mvp_check', title: t('checker.webSearchTitle') },
              h('input', {
                type: 'checkbox',
                checked: pick.webSearch,
                disabled: running,
                'aria-label': t('checker.webSearch'),
                onChange: (event) => commit({ ...pick, webSearch: event.target.checked }),
              }),
              h('span', null, t('checker.webSearch')),
            ),
            h(
              'label',
              { className: 'mvp_check', title: t('checker.writeBackTitle') },
              h('input', {
                type: 'checkbox',
                checked: pick.writeBack,
                disabled: running,
                'aria-label': t('checker.writeBack'),
                onChange: (event) => commit({ ...pick, writeBack: event.target.checked }),
              }),
              h('span', null, t('checker.writeBack')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: running ? 'mvp_button' : 'mvp_button mvp_button--accent',
                disabled: !running && (pick.provider === '' || pick.model === ''),
                title: running ? t('checker.cancelTitle') : t('checker.startTitle'),
                onClick: running ? cancel : run,
              },
              running ? t('checker.cancel') : t('checker.start'),
            ),
          ),
          running || finished
            ? h(
                'div',
                { className: 'mvp_checkerProgress' },
                h('div', {
                  className: 'mvp_progressBar',
                  role: 'progressbar',
                  'aria-valuemin': 0,
                  'aria-valuemax': progress?.total ?? 0,
                  'aria-valuenow': counts.processed,
                }, h('span', {
                  className: 'mvp_progressFill',
                  style: {
                    width:
                      (progress?.total ?? 0) > 0
                        ? Math.min(100, Math.round((counts.processed / progress.total) * 100)) + '%'
                        : '0%',
                  },
                })),
                h(
                  'span',
                  { className: 'mvp_checkerProgressText' },
                  t('checker.progress', counts),
                ),
                h(
                  'span',
                  { className: 'mvp_checkerProgressText' },
                  t('checker.outcomes', counts),
                ),
                h(
                  'span',
                  { className: 'mvp_checkerProgressText' },
                  t('checker.webCalls', counts),
                ),
                h(
                  'span',
                  { className: 'mvp_checkerProgressText' },
                  t('checker.threads', { count: progress?.concurrency ?? pick.concurrency }),
                ),
              )
            : null,
          visibleBatches.length > 0
            ? h(
                'div',
                { className: 'mvp_sources', 'aria-label': t('checker.activeBatches') },
                h('div', { className: 'mvp_sourcesTitle' }, t('checker.activeBatches')),
                h(
                  'ul',
                  { className: 'mvp_sourceList' },
                  visibleBatches.map((batch, index) =>
                    h(
                      'li',
                      { key: index },
                      h('span', { className: 'mvp_sourceState' },
                        ['checker', 'search', 'fetch', 'writeBack', 'flush'].includes(batch.stage)
                          ? t('checker.stage.' + batch.stage)
                          : String(batch.stage ?? t('checker.stage.checker')),
                      ),
                      h('span', { className: 'mvp_sourceName' },
                        Array.isArray(batch.ids) ? batch.ids.map(String).join(', ') : '',
                      ),
                    ),
                  ),
                ),
                activeBatches.length > visibleBatches.length
                  ? h('div', { className: 'mvp_usageHint' },
                      t('checker.activeMore', { count: activeBatches.length - visibleBatches.length }),
                    )
                  : null,
              )
            : null,
          // Which public catalogs were read, and which were not. Without this
          // "the catalogs returned nothing" and "the catalogs errored" look
          // identical, which is exactly how a broken fetch stayed invisible.
          (progress?.sources?.length ?? 0) > 0
            ? h(
                'div',
                { className: 'mvp_sources' },
                h('div', { className: 'mvp_sourcesTitle' }, t('checker.sourcesTitle')),
                h(
                  'ul',
                  { className: 'mvp_sourceList' },
                  progress.sources.map((source, index) =>
                    h(
                      'li',
                      { key: index, className: source.status === 'ok' ? 'mvp_source--ok' : 'mvp_source--bad' },
                      h('span', { className: 'mvp_sourceName' }, String(source.name)),
                      h('span', { className: 'mvp_sourceState' }, t('checker.source.' + String(source.status))),
                      source.models > 0
                        ? h('span', { className: 'mvp_sourceCount' }, t('checker.sourceModels', { count: source.models }))
                        : null,
                      source.message
                        ? h('span', { className: 'mvp_sourceMsg' }, String(source.message))
                        : null,
                    ),
                  ),
                ),
              )
            : null,
          (progress?.publicOnly ?? 0) > 0
            ? h(
                'div',
                { className: 'mvp_usageHint' },
                t('checker.publicOnly', { count: progress.publicOnly }),
              )
            : null,
          errors.length > 0
            ? h(
                'div',
                { className: 'mvp_checkerErrors' },
                h('div', { className: 'mvp_checkerErrorsTitle' }, t('checker.errorTitle')),
                h(
                  'ul',
                  { className: 'mvp_errorList' },
                  visibleErrors.map((entry, index) =>
                    h('li', { key: index }, typeof entry === 'string' ? entry : String(entry)),
                  ),
                ),
                errors.length > visibleErrors.length
                  ? h(
                      'div',
                      { className: 'mvp_usageHint' },
                      t('checker.errorMore', { count: errors.length - visibleErrors.length }),
                    )
                  : null,
              )
            : null,
          message !== null ? h('div', { className: 'mvp_banner mvp_banner--error' }, message) : null,
          state.error !== null ? h('div', { className: 'mvp_banner mvp_banner--error' }, state.error) : null,
        )
      : null,
  )
}
