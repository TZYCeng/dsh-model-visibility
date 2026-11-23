import { formatTokens, bucketTotalOf, checkerRoutesOf, checkerModelsOf, checkerScopeOf } from './pure.mjs'
import { catalogAdvertisesBulk } from './catalog-store.mjs'
import { BulkEffortsControl } from './checker-bulk.mjs'

const React = require('react')
const h = React.createElement

const PICK_KEY = 'dsh-model-visibility:checker-pick:v1'
const SOURCE_MODES = ['public', 'supplement', 'checker']
const MAX_ACTIVE_BATCH_LINES = 3
const MAX_ERROR_LINES = 3
const MAX_ERROR_LENGTH = 140
/** Mirrors lib/check-catalog MAX_CONCURRENCY. */
const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8]
const RUN_PHASES = ['listing', 'public', 'checker', 'verifying', 'cancelled']
const BATCH_STAGES = ['checker', 'search', 'fetch', 'writeBack', 'flush']

function readPick() {
  let parsed
  try {
    parsed = JSON.parse(window.localStorage.getItem(PICK_KEY))
  } catch (_error) {
    // Storage availability is optional for this preference.
  }
  const concurrency = parsed?.concurrency
  return {
    provider: typeof parsed?.provider === 'string' ? parsed.provider : '',
    model: typeof parsed?.model === 'string' ? parsed.model : '',
    // The legacy choices are also kept for older Hosts that still control web access separately.
    mode: SOURCE_MODES.includes(parsed?.mode) ? parsed.mode : undefined,
    webSearch: parsed?.webSearch !== false,
    useChecker: parsed?.useChecker !== false,
    writeBack: parsed?.writeBack === true,
    fuzzyMatch: typeof parsed?.fuzzyMatch === 'boolean' ? parsed.fuzzyMatch : undefined,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(8, Math.trunc(concurrency) || 1) : 2,
  }
}

function persistPick(pick) {
  try {
    window.localStorage.setItem(PICK_KEY, JSON.stringify(pick))
  } catch (_error) {
    // Storage availability is optional for this preference.
  }
}

function shortError(message) {
  const line = String(message).replace(/\s+/g, ' ').trim()
  return line.length > MAX_ERROR_LENGTH ? line.slice(0, MAX_ERROR_LENGTH - 1) + '…' : line
}

function errorsView(errors, t, alert) {
  function errorList(entries, shorten) {
    return h('ul', { className: 'mvp_errorList' }, entries.map((entry, index) =>
      h('li', { key: index }, shorten ? shortError(entry) : String(entry))))
  }
  const visible = errors.slice(0, MAX_ERROR_LINES)
  const hasDetails = errors.length > visible.length || visible.some((entry) => shortError(entry) !== String(entry))
  return h('div', { className: 'mvp_checkerErrors' },
    h('div', { role: alert ? 'alert' : undefined },
      h('div', { className: 'mvp_checkerErrorsTitle' }, t('checker.errorTitle')),
      errorList(visible, true),
    ),
    hasDetails ? h('details', { className: 'mvp_checkerDetails' },
      h('summary', null, t('checker.errorDetails', { count: errors.length })),
      errorList(errors, false),
    ) : null,
  )
}

function routeLabel(checker) {
  return checker?.provider && checker?.model ? `${checker.provider}/${checker.model}` : null
}

const noSubscription = () => () => {}
const noBulk = () => null

export function VerifyPanel({ verify, catalog, t, canUse, observeVerify = true, canFullScan = false, canSetMode = false, canSetSourceMode = false, onFinished }) {
  const cachedVerify = verify.getSnapshot()
  const keepVerify = cachedVerify.pending || cachedVerify.snapshot?.state?.running || cachedVerify.snapshot?.state?.pendingWrite
  const state = React.useSyncExternalStore(observeVerify || keepVerify ? verify.subscribe : noSubscription, verify.getSnapshot)
  const [pick, setPick] = React.useState(readPick)
  const [open, setOpen] = React.useState(false)
  const [message, setMessage] = React.useState(null)
  // A full scan is an opt-in for one start, not a saved preference.
  const [fullScan, setFullScan] = React.useState(false)
  const modeGroup = React.useId()
  const modeHint = React.useId()

  const features = Array.isArray(catalog?.learned?.features) ? catalog.learned.features : []
  const hasFeatureList = catalog?.source === 'host' && Array.isArray(catalog.learned?.features)
  const canEnableBulk = catalogAdvertisesBulk(catalog)
  const readBulk = open && (canEnableBulk || catalog?.status === 'error' || (!hasFeatureList && catalog?.status === 'ready'))
  const bulk = verify.bulk
  // Observe an already-known operation even when catalog/verification is no
  // longer usable, but don't probe unsupported Hosts or an unopened checker.
  const cachedBulk = bulk?.getSnapshot()
  const keepBulk = (next) => Boolean(next?.snapshot?.enabled || next?.snapshot?.running || next?.mayBeEnabled || next?.pending || next?.lostReply || next?.snapshot?.rows?.length)
  const bulkState = React.useSyncExternalStore(bulk && (readBulk || keepBulk(cachedBulk)) ? bulk.subscribe : noSubscription, bulk?.getSnapshot ?? noBulk)
  const showBulk = bulk && (keepBulk(bulkState) || (readBulk && (canEnableBulk || bulkState?.available !== false)))
  const scopeHint = React.useId()
  const requiresRunId = features.includes('runId')

  const progress = state.snapshot?.state
  const running = progress?.running === true
  const pending = state.pending === true
  const stateUnknown = ['idle', 'loading', 'error'].includes(state.status)
  const locked = running || pending || stateUnknown
  const stopping = running && progress.phase === 'cancelled'
  const pendingWrite = progress?.pendingWrite
  const latestWrite = progress?.latestWriteSettlement
  // Respect a previous opt-out: switching an offline legacy run to the new online default would change its cost.
  const storedMode = pick.mode ?? (pick.useChecker && pick.webSearch ? 'supplement' : 'public')
  const runMode = SOURCE_MODES.includes(progress?.mode) ? progress.mode : null
  const shownMode = running && runMode !== null ? runMode : storedMode
  const usesChecker = canSetSourceMode ? shownMode !== 'public' : !canSetMode || pick.useChecker
  const usesCatalog = !canSetSourceMode || shownMode !== 'checker'
  const autoFullScan = canSetSourceMode && shownMode === 'checker'
  const fuzzyMatch = pick.fuzzyMatch ?? canSetSourceMode
  const writeBack = usesChecker && pick.writeBack
  const groups = catalog?.groups
  const routeOptions = React.useMemo(() => checkerRoutesOf(groups), [groups])
  const selectedRoute = running && progress?.checker ? progress.checker : pick
  const route = routeOptions.find((entry) => entry.id === selectedRoute.provider) ?? null
  const models = React.useMemo(() => checkerModelsOf((groups ?? []).find((group) => group.id === selectedRoute.provider)),
    [groups, selectedRoute.provider])
  const validModel = models.some((model) => model.id === selectedRoute.model)
  const missingChecker = usesChecker && (route === null || !validModel)
  const excludedId = usesChecker && validModel ? selectedRoute.model : undefined
  const scope = React.useMemo(() => checkerScopeOf(groups, excludedId), [groups, excludedId])
  const runId = typeof progress?.runId === 'string' && progress.runId !== '' ? progress.runId : undefined
  const cancelLocked = pending || stopping || (requiresRunId && runId === undefined)
  const showWriteWarning = running ? progress?.writeBack === true : writeBack
  const showFullWarning = running ? progress?.fullScan === true : autoFullScan || (canFullScan && fullScan)

  React.useEffect(() => {
    if (running || !canFullScan || autoFullScan) setFullScan(false)
  }, [running, canFullScan, autoFullScan])

  const lastFinished = React.useRef(progress?.finishedAt)
  React.useEffect(() => {
    if (running || progress?.finishedAt === undefined || lastFinished.current === progress.finishedAt) return
    lastFinished.current = progress.finishedAt
    onFinished?.()
  }, [running, progress?.finishedAt, onFinished])

  const lastWrite = React.useRef(latestWrite?.finishedAt)
  React.useEffect(() => {
    if (latestWrite?.finishedAt === undefined || lastWrite.current === latestWrite.finishedAt) return
    lastWrite.current = latestWrite.finishedAt
    if (latestWrite.written === true && !running) onFinished?.()
  }, [latestWrite?.finishedAt, running, onFinished])

  if (!observeVerify && !running && !pending && !pendingWrite && !canEnableBulk && !showBulk) {
    return h('div', { className: 'mvp_banner' }, t('checker.hostStale'))
  }

  const commit = (next) => {
    setPick(next)
    persistPick(next)
  }

  const run = () => {
    if (!canUse || locked || missingChecker || verify.getSnapshot().epoch !== state.epoch) return
    setMessage(null)
    setFullScan(false)
    verify.start({
      ...(usesChecker ? { provider: pick.provider, model: pick.model } : {}),
      writeBack,
      ...(canSetSourceMode
        ? { mode: shownMode, fuzzyMatch: usesCatalog && fuzzyMatch }
        : {
            webSearch: usesChecker && pick.webSearch,
            ...(canSetMode ? { useChecker: usesChecker, fuzzyMatch } : {}),
          }),
      concurrency: pick.concurrency,
      fullScan: autoFullScan || (canFullScan && fullScan),
    }).catch((error) => setMessage(String(error?.message ?? error)))
  }

  const cancel = () => {
    if (!running || cancelLocked || verify.getSnapshot().epoch !== state.epoch) return
    setMessage(null)
    verify.cancel(runId).catch((error) => {
      setOpen(true)
      setMessage(String(error?.message ?? error))
    })
  }

  const counts = {
    processed: progress?.processed ?? progress?.done ?? 0,
    total: progress?.total ?? 0,
    valid: progress?.done ?? 0,
    unknown: progress?.unknown ?? 0,
    failed: progress?.failed ?? 0,
    skippedKnown: progress?.skippedKnown ?? 0,
    searchCalls: progress?.searchCalls ?? 0,
    fetchCalls: progress?.fetchCalls ?? 0,
    tokens: formatTokens(bucketTotalOf(progress?.tokenUsage)),
  }
  const finished = ['done', 'cancelled', 'error'].includes(progress?.phase)
  const allSkipped = progress?.phase === 'done' && counts.total === 0 && counts.skippedKnown > 0
  const writeBackSkipped = progress?.writeBack === true && progress?.fullScan !== true && counts.skippedKnown > 0
  const runningPhase = RUN_PHASES.includes(progress?.phase) ? progress.phase : 'verifying'
  let summary = t('checker.idle')
  if (running) summary = t('checker.running', { phase: t('checker.phase.' + runningPhase) })
  else if (pending) summary = t('checker.starting')
  else if (progress?.phase === 'error') summary = t('checker.runFailed')
  else if (progress?.phase === 'cancelled') summary = t('checker.cancelled')
  else if (allSkipped) summary = t('checker.allSkipped', counts)
  else if (finished) summary = t('checker.finished')
  if (runMode !== null && progress?.phase !== 'idle' && !pending) summary += ' · ' + t('checker.mode.' + runMode)
  if ((running || finished) && !allSkipped && counts.total > 0) {
    summary += ' · ' + t('checker.progress', counts)
  }

  const routing = []
  if (Number.isFinite(progress?.catalogTargets)) routing.push(t('checker.catalogTargets', { count: progress.catalogTargets }))
  if (runMode !== 'checker' && Number.isFinite(progress?.catalogMatches)) {
    routing.push(t('checker.catalogMatches', { count: progress.catalogMatches }))
  }
  if (runMode !== 'checker' && Number.isFinite(progress?.publicReliable) && progress?.phase !== 'idle') {
    routing.push(t('checker.reliable', { count: progress.publicReliable }))
  }
  if (Number.isFinite(progress?.checkerTargets)) routing.push(t('checker.checkerTargets', { count: progress.checkerTargets }))
  if (routeLabel(progress?.checker) !== null && runMode !== 'public') {
    routing.push(t('checker.usedRoute', { target: routeLabel(progress.checker) }))
  }
  const searchBackends = ['dsh-free-search', 'host-web'].flatMap((backend) => {
    const count = progress?.searchBackends?.[backend]
    return Number.isFinite(count) && count > 0 ? [t('checker.searchBackend.' + backend, { count })] : []
  })
  const activeBatches = running && Array.isArray(progress?.batches)
    ? progress.batches.filter((batch) => batch.status === 'running') : []
  const notices = [...new Set([message, state.error].filter((error) => error != null))]
  const errors = [...new Set([...notices, ...(Array.isArray(progress?.errors) ? progress.errors : [])])]
  const sources = Array.isArray(progress?.sources) ? progress.sources : []
  const sourceFailures = progress?.sourceFailures ?? sources.filter((s) => ['http', 'failed', 'too-large', 'bad-json'].includes(s.status)).length
  const showWebUsage = runMode !== 'public' && progress?.useChecker !== false && (counts.searchCalls > 0 || counts.fetchCalls > 0 || counts.tokens !== '0' || (counts.total > 0 && progress?.checkerTargets !== 0))

  const checkbox = (key, checked, change) => h('label', { className: 'mvp_check', title: t(key + 'Title') },
    h('input', { type: 'checkbox', checked, disabled: locked, 'aria-label': t(key),
      onChange: (event) => change(event.target.checked) }),
    h('span', null, t(key)),
  )
  const select = (key, value, options, change, { placeholder, disabled, title } = {}) => h('label', { className: 'mvp_field', title },
    h('span', { className: 'mvp_fieldLabel' }, t(key)),
    h('select', { className: 'mvp_select', value, disabled: locked || disabled, 'aria-label': t(key),
      onChange: (event) => change(event.target.value) },
    placeholder ? h('option', { value: '' }, t(placeholder)) : null,
    options.map(([id, name]) => h('option', { key: id, value: id }, name)),
    ),
  )

  return h('div', { className: 'mvp_checker' },
    h('div', { className: 'mvp_checkerBar' },
      h('button', { type: 'button', className: 'mvp_checkerHead', 'aria-expanded': open, onClick: () => setOpen(!open) },
        h('span', { className: 'mvp_chevron', 'aria-hidden': true }, open ? '▾' : '▸'),
        h('span', { className: 'mvp_checkerTitle' }, t('checker.title')),
        h('span', { className: 'mvp_checkerSummary', 'aria-live': 'polite', 'aria-atomic': true }, summary),
        errors.length > 0 ? h('span', { className: 'mvp_badge' }, t('checker.errorBadge', { count: errors.length })) : null,
      ),
      running ? h('button', { type: 'button', className: 'mvp_button', disabled: cancelLocked,
        title: t(requiresRunId && !runId ? 'checker.stopNoId' : 'checker.cancelTitle'), onClick: cancel }, t(stopping ? 'checker.stopping' : 'checker.cancel')) : null,
    ),
    pendingWrite?.waitEnded != null ? h('div', { className: 'mvp_usageHint mvp_usageHint--warn mvp_checkerNotice', role: 'status' },
      t('checker.pendingWrite', { target: routeLabel(pendingWrite) })) : null,
    open ? h('div', { className: 'mvp_checkerBody' },
      !canUse ? h('p', { className: 'mvp_checkerHint' }, t('checker.catalogNeeded')) : null,
      canSetSourceMode ? h('fieldset', { className: 'mvp_checkerModes', disabled: locked, 'aria-describedby': modeHint },
        h('legend', { className: 'mvp_fieldLabel' }, t('checker.sourceMode')),
        SOURCE_MODES.map((mode) => h('label', { key: mode, className: 'mvp_checkerMode' },
          h('input', { type: 'radio', name: modeGroup, value: mode, checked: shownMode === mode, disabled: locked,
            onChange: () => { setFullScan(false); commit({ ...pick, mode }) } }),
          h('span', null, t('checker.mode.' + mode)),
        )),
      ) : null,
      h('p', { id: modeHint, className: 'mvp_checkerHint' }, t(canSetSourceMode
        ? 'checker.hint.' + shownMode : usesChecker ? 'checker.description' : 'checker.publicDescription')),
      h('div', { className: 'mvp_checkerForm' },
        !canSetSourceMode && canSetMode ? checkbox('checker.useChecker', usesChecker, (useChecker) => commit({ ...pick, useChecker })) : null,
        usesChecker ? select('checker.provider', route?.id ?? '',
          routeOptions.map((entry) => [entry.id, entry.name]), (provider) => commit({ ...pick, provider, model: '' }),
          { placeholder: 'checker.chooseProvider' }) : null,
        usesChecker ? select('checker.model', validModel ? selectedRoute.model : '',
          models.map((model) => [model.id, model.name ?? model.id]), (model) => commit({ ...pick, model }),
          { placeholder: 'checker.chooseModel', disabled: route === null }) : null,
      ),
      !locked && canUse && missingChecker ? h('p', { className: 'mvp_checkerHint mvp_checkerNotice' },
        routeOptions.length === 0 ? t(canSetMode || canSetSourceMode ? 'checker.noRoute' : 'checker.noLegacyRoute') : t('checker.chooseRoute')) : null,
      h('div', { className: 'mvp_checkerNotice', id: scopeHint },
        h('div', { className: 'mvp_checkerProgressText' }, t('checker.scopeNow', scope)),
        showWriteWarning ? h('div', { className: 'mvp_checkerOptionNote' }, t('checker.writeWarning')) : null,
        showFullWarning ? h('div', { className: 'mvp_checkerOptionNote' }, t('checker.fullWarning')) : null),
      !running ? h('button', { type: 'button', className: 'mvp_button mvp_button--accent', 'aria-describedby': scopeHint,
        disabled: !canUse || locked || missingChecker, title: t('checker.startTitle'), onClick: run },
        t(usesChecker ? 'checker.start' : 'checker.startPublic')) : null,
      usesChecker || canSetMode || canSetSourceMode || canFullScan ? h('details', { className: 'mvp_checkerDetails' },
        h('summary', null, t('checker.advanced')),
        h('div', { className: 'mvp_checkerAdvanced' },
          usesCatalog && (canSetSourceMode || canSetMode)
            ? checkbox('checker.fuzzyMatch', running ? progress?.fuzzyMatch ?? fuzzyMatch : fuzzyMatch,
                (fuzzyMatch) => commit({ ...pick, fuzzyMatch })) : null,
          canFullScan && !autoFullScan
            ? checkbox('checker.fullScan', running ? progress?.fullScan === true : fullScan, setFullScan) : null,
          usesChecker ? checkbox('checker.writeBack', running ? progress?.writeBack === true : writeBack,
            (writeBack) => commit({ ...pick, writeBack })) : null,
          usesChecker && !canSetSourceMode ? checkbox('checker.webSearch', running ? progress?.webSearch ?? pick.webSearch : pick.webSearch,
            (webSearch) => commit({ ...pick, webSearch })) : null,
          usesChecker ? select('checker.concurrency', String(running ? progress?.concurrency ?? pick.concurrency : pick.concurrency),
            CONCURRENCY_CHOICES.map((count) => [String(count), t('checker.concurrencyValue', { count })]),
            (concurrency) => commit({ ...pick, concurrency: Number(concurrency) }), { title: t('checker.concurrencyTitle') }) : null,
        ),
        usesChecker ? h('div', { className: 'mvp_usageHint' }, t('checker.resultsScope')) : null,
        usesChecker && (running ? progress?.writeBack === true : writeBack) && !autoFullScan && !(running ? progress?.fullScan : fullScan)
          ? h('div', { className: 'mvp_usageHint' }, t('checker.writeBackScope')) : null,
      ) : null,
      (running || finished) && counts.total > 0 ? h('div', { className: 'mvp_checkerProgress' },
        running ? h('div', { className: 'mvp_progressBar', role: 'progressbar', 'aria-label': t('checker.progressLabel'),
          'aria-valuemin': 0, 'aria-valuemax': counts.total, 'aria-valuenow': counts.processed }, h('span', {
          className: 'mvp_progressFill', style: { width: Math.min(100, Math.round((counts.processed / counts.total) * 100)) + '%' },
        })) : null,
        h('span', { className: 'mvp_checkerProgressText' }, t('checker.outcomes', counts)),
      ) : null,
      routing.length > 0 ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' }, routing.join(' · ')) : null,
      (running || finished) && showWebUsage
        ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' },
          t('checker.webCalls', counts), ' · ', t('checker.tokens', counts),
          searchBackends.length > 0 ? ' · ' + t('checker.searchBreakdown', { breakdown: searchBackends.join(' · ') }) : null,
        ) : null,
      sourceFailures > 0 ? h('div', { className: 'mvp_usageHint mvp_checkerNotice mvp_checkerOptionNote' },
        t('checker.sourceFailures', { count: sourceFailures })) : null,
      (!Number.isFinite(progress?.publicReliable) && progress?.publicOnly > 0) || (progress?.aliasMatches ?? 0) > 0
        ? h('div', { className: 'mvp_checkerProgressText mvp_checkerNotice' }, [
          !Number.isFinite(progress?.publicReliable) && progress?.publicOnly > 0 ? t('checker.catalogResults', { count: progress.publicOnly }) : null,
          progress?.aliasMatches > 0 ? t('checker.aliasMatches', { count: progress.aliasMatches }) : null,
        ].filter(Boolean).join(' · ')) : null,
      latestWrite?.finishedAt != null ? h('div', { className: 'mvp_usageHint mvp_checkerNotice',
        title: latestWrite.message || latestWrite.reason }, t(latestWrite.written === true
        ? 'checker.lateWriteApplied' : 'checker.lateWriteNotApplied', { target: routeLabel(latestWrite) })) : null,
      writeBackSkipped ? h('div', { className: 'mvp_usageHint mvp_checkerNotice' },
        t('checker.writeBackSkipped', { count: counts.skippedKnown })) : null,
      errors.length > 0 ? errorsView(errors, t, notices.length > 0) : null,
      activeBatches.length > 0 ? h('div', { className: 'mvp_sources', 'aria-label': t('checker.activeBatches') },
        h('div', { className: 'mvp_sourcesTitle' }, t('checker.activeBatches')),
        h('ul', { className: 'mvp_sourceList' }, activeBatches.slice(0, MAX_ACTIVE_BATCH_LINES).map((batch, index) =>
          h('li', { key: index },
            h('span', { className: 'mvp_sourceState' }, BATCH_STAGES.includes(batch.stage)
              ? t('checker.stage.' + batch.stage) : String(batch.stage ?? t('checker.stage.checker'))),
            h('span', { className: 'mvp_sourceName' }, Array.isArray(batch.ids) ? batch.ids.map(String).join(', ') : ''),
          ))),
        activeBatches.length > MAX_ACTIVE_BATCH_LINES ? h('div', { className: 'mvp_usageHint' },
          t('checker.activeMore', { count: activeBatches.length - MAX_ACTIVE_BATCH_LINES })) : null,
      ) : null,
      sources.length > 0 ? h('details', { className: 'mvp_checkerDetails' },
        h('summary', null, t('checker.sourcesTitle'), ' · ', t('checker.sourceSummary', {
          complete: sources.filter((source) => ['ok', 'empty'].includes(source.status)).length, total: sources.length,
        })),
        h('ul', { className: 'mvp_sourceList' }, sources.map((source, index) =>
          h('li', { key: index, className: ['ok', 'empty'].includes(source.status) ? 'mvp_source--ok' : 'mvp_source--bad' },
            h('span', { className: 'mvp_sourceName' }, String(source.name)),
            h('span', { className: 'mvp_sourceState' }, t('checker.source.' + String(source.status))),
            source.attempts > 1 ? h('span', { className: 'mvp_sourceCount' }, t('checker.sourceAttempts', { count: source.attempts })) : null,
            source.models > 0 ? h('span', { className: 'mvp_sourceCount' }, t('checker.sourceModels', { count: source.models })) : null,
            source.message ? h('span', { className: 'mvp_sourceMsg', title: String(source.message) }, shortError(source.message)) : null,
          ))),
      ) : null,
    ) : null,
    // Its own shallow child position survives collapsing verification and catalog fallback.
    showBulk ? h(BulkEffortsControl, { api: bulk, t, canUse: open && canEnableBulk }) : null,
  )
}
