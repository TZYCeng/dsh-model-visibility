/**
 * The online capability verification panel.
 *
 * The user picks a checker route (provider + model) and a write-back switch,
 * runs the sweep, and the panel polls the Host for progress and the checker's
 * token spend. The last route choice is kept in browser storage only: the
 * Host persists run facts, not UI selections.
 *
 * @module client-src/checker-view
 */

const React = require('react')
const h = React.createElement

import { API } from './constants.mjs'
import { formatTokens } from './pure.mjs'
import { useSource } from './hooks.mjs'

const PICK_KEY = 'dsh-model-visibility:checker-pick:v1'

function readPick() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PICK_KEY))
    return parsed !== null && typeof parsed === 'object'
      ? {
          provider: typeof parsed.provider === 'string' ? parsed.provider : '',
          model: typeof parsed.model === 'string' ? parsed.model : '',
          writeBack: parsed.writeBack !== false,
        }
      : { provider: '', model: '', writeBack: true }
  } catch (_error) {
    return { provider: '', model: '', writeBack: true }
  }
}

function persistPick(pick) {
  try {
    window.localStorage.setItem(PICK_KEY, JSON.stringify(pick))
  } catch (_error) {
    // Storage availability is optional for this preference.
  }
}

/** Routes with at least one model, from a loaded catalog — checker choices. */
export function checkerRoutesOf(groups) {
  const routes = []
  for (const group of groups ?? []) {
    if (group === null || typeof group !== 'object') continue
    const models = Array.isArray(group.models) ? group.models : []
    if (models.length > 0) routes.push({ id: group.id, name: group.name ?? group.id })
  }
  return routes
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
    return h('div', { className: 'mvp_fallback' }, t('checker.hostStale'))
  }

  const tokensSpent = progress ? formatTokens((progress.tokenUsage?.[0] ?? 0) + (progress.tokenUsage?.[1] ?? 0)) : null

  const commit = (next) => {
    setPick(next)
    persistPick(next)
  }

  const run = () => {
    setMessage(null)
    verify
      .start({ provider: pick.provider, model: pick.model, writeBack: pick.writeBack })
      .then((result) => {
        if (result !== undefined && result.ok === false) {
          setMessage(result.message ?? t('checker.failed'))
        }
      })
      .catch((error) => setMessage(String(error?.message ?? error)))
  }

  const cancel = () => {
    verify.cancel().catch((error) => setMessage(String(error?.message ?? error)))
  }

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
      h('span', { className: 'mvp_checkerTitle' }, t('checker.title')),
      h(
        'span',
        { className: 'mvp_checkerSummary' },
        running
          ? t('checker.running', {
              done: progress?.done ?? 0,
              total: progress?.total ?? 0,
              phase: t(`checker.phase.${progress?.phase ?? 'checker'}`),
            })
          : finished
            ? t('checker.finished', { done: progress?.done ?? 0, total: progress?.total ?? 0, tokens: tokensSpent })
            : t('checker.idle'),
      ),
    ),
    open
      ? h(
          'div',
          { className: 'mvp_checkerBody' },
          h('div', { className: 'mvp_checkerHint' }, t('checker.description')),
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
          ),
          h(
            'div',
            { className: 'mvp_checkerActions' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'mvp_switch',
                'aria-checked': pick.writeBack,
                title: t('checker.writeBackTitle'),
                disabled: running,
                onClick: () => commit({ ...pick, writeBack: !pick.writeBack }),
              },
              h('span', { className: 'mvp_thumb' }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mvp_button',
                title: t('checker.writeBackTitle'),
                onClick: () => commit({ ...pick, writeBack: !pick.writeBack }),
              },
              t('checker.writeBack'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: running ? 'mvp_button' : 'mvp_button mvp_button--accent',
                disabled: running ? false : pick.provider === '' || pick.model === '',
                title: running ? t('checker.cancelTitle') : t('checker.startTitle'),
                onClick: running ? cancel : run,
              },
              running ? t('checker.cancel') : t('checker.start'),
            ),
          ),
          progress !== null && (running || finished)
            ? h(
                'div',
                { className: 'mvp_checkerProgress' },
                t('checker.progress', {
                  done: progress?.done ?? 0,
                  total: progress?.total ?? 0,
                  tokens: tokensSpent,
                }),
              )
            : null,
          (progress?.errors?.length ?? 0) > 0
            ? h(
                'div',
                {
                  className: 'mvp_usageHint mvp_usageHint--warn',
                  title: progress.errors.join('\n'),
                },
                t('checker.errors', { count: progress.errors.length }),
              )
            : null,
          message !== null ? h('div', { className: 'mvp_usageHint mvp_usageHint--warn' }, message) : null,
        )
      : null,
  )
}

void API
