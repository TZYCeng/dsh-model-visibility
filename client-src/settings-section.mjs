const React = require('react')
const h = React.createElement

import { keyOf, kindOf, providerLabel, countModels, sourceOf, sourceLabel, readCollapsedGroups, persistCollapsedGroups } from './format.mjs'
import { canWriteHidden, queueVisibilityWrite, visibilityEpoch, writeHiddenRoutes } from './visibility-identity.mjs'
import { overrideIdentity } from './catalog-store.mjs'
import { computeFilteredGroups, countKinds } from './pure.mjs'
import { ModelOverrideEditor } from './override-editor.mjs'
import { providerWriteNote } from './editor-receipt.mjs'
import { modelRow } from './settings-rows.mjs'
import { SettingsConfirm } from './settings-confirm.mjs'
import { useHidden, useSource } from './hooks.mjs'
import { UsageToolbar } from './usage-view.mjs'
import { VerifyPanel } from './checker-view.mjs'
import { DebugPanel, AboutPanel } from './support-panels.mjs'
import { clientTrace } from './diagnostic-events.mjs'

function affectedRoutes(groups, hidden, visible) {
  return groups.flatMap((group) => (group.models ?? []).filter((model) => hidden.has(keyOf(group.id, model.id)) === visible)
    .map((model) => ({ provider: group.id, model: model.id })))
}

function focusOrFallback(target, fallback) {
  if (target && target.isConnected !== false && !target.disabled) target.focus?.()
  else fallback?.focus?.()
}

function makeSection(form, catalog, overrides, usage, verify) {
  return function ModelVisibilitySection({ t }) {
    const { hidden, snapshot } = useHidden(form)
    const state = useSource(catalog)
    const overrideState = useSource(overrides)
    const [operation, setOperation] = React.useState(null)
    const [writeError, setError] = React.useState(null)
    const writeEpoch = visibilityEpoch(form)
    const busy = operation?.epoch === writeEpoch
    const error = writeError?.epoch === writeEpoch ? writeError.message : null
    const [refreshing, setRefreshing] = React.useState(false)
    const [reloading, setReloading] = React.useState(false)
    const [collapsed, setCollapsed] = React.useState(readCollapsedGroups)
    const [matchFold, setMatchFold] = React.useState(null)
    const [editing, setEditing] = React.useState(null)
    const [receipt, setReceipt] = React.useState(null)
    const [confirm, setConfirm] = React.useState(null)
    const [facts, setFacts] = React.useState(null)
    const [filter, setFilter] = React.useState('all')
    const [visibility, setVisibility] = React.useState('all')
    const [query, setQuery] = React.useState('')
    const [multimodalOnly, setMultimodalOnly] = React.useState(false)
    const [reasoningOnly, setReasoningOnly] = React.useState(false)
    const [minContext, setMinContext] = React.useState(0)
    const editTrigger = React.useRef(null)
    const pendingFocus = React.useRef(null)
    const searchInput = React.useRef(null)
    const writeLock = React.useRef(false)
    const editorId = React.useId()
    const applyHintId = React.useId()
    const groupId = React.useId()

    React.useEffect(() => {
      if (!confirm && pendingFocus.current) {
        const target = pendingFocus.current; pendingFocus.current = null
        focusOrFallback(target, searchInput.current)
      }
    }, [confirm, editing?.id])

    const groups = state.groups
    const meta = state.learned
    const featuresKnown = state.source === 'host' && Array.isArray(meta?.features)
    const features = featuresKnown ? meta.features : []
    const supportsOverrides = features.includes('overrides')
    const overridesReady = overrideState.status === 'ready' && overrideState.available === true
    const canOpenEditor = state.status === 'ready' && supportsOverrides && overridesReady && !overrideState.pending && !overrideState.refreshing
    const canSetSourceMode = features.includes('verifySourceModes')
    const supportsVerify = canSetSourceMode || features.includes('verifyWeb')
    const observeVerify = !featuresKnown || features.includes('verify') || supportsVerify
    const entryById = React.useMemo(() => new Map(overrideState.entries.map((entry) => [overrideIdentity(entry.provider, entry.model), entry])), [overrideState.entries])
    const catalogById = React.useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
    const total = countModels(groups)
    const allKinds = React.useMemo(() => countKinds(groups.flatMap((group) => group.models ?? [])), [groups])
    const hiddenCount = React.useMemo(() => affectedRoutes(groups, hidden, true).length, [groups, hidden])
    const normalized = query.trim().toLowerCase()
    const activeFilters = Boolean(filter !== 'all' || visibility !== 'all' || normalized || multimodalOnly || reasoningOnly || minContext)
    const filterKey = JSON.stringify([filter, visibility, normalized, multimodalOnly, reasoningOnly, minContext])
    const filtered = React.useMemo(() => computeFilteredGroups(groups, { filter, visibility, query: normalized, multimodalOnly, reasoningOnly, minContext, hidden }),
      [groups, filter, visibility, normalized, multimodalOnly, reasoningOnly, minContext, hidden])
    const matchCount = countModels(filtered)
    const hiddenMatches = React.useMemo(() => affectedRoutes(filtered, hidden, true), [filtered, hidden])
    // Search results start expanded independently of the user's persisted group layout. Manual folding
    // inside this one filter still works; clearing/changing it never rewrites unfiltered preferences.
    const effectiveFold = activeFilters ? matchFold?.key === filterKey ? matchFold.groups : new Set() : collapsed
    const anyCollapsed = filtered.some((group) => effectiveFold.has(group.id))
    const setFolds = (next) => {
      if (activeFilters) setMatchFold({ key: filterKey, groups: next })
      else { setCollapsed(next); persistCollapsedGroups(next) }
    }
    const resetFilters = () => { setQuery(''); setFilter('all'); setVisibility('all'); setMultimodalOnly(false); setReasoningOnly(false); setMinContext(0); setMatchFold(null) }
    const foldOne = (id) => {
      const next = new Set(effectiveFold)
      if (next.has(id)) next.delete(id); else next.add(id)
      setFolds(next)
    }
    const foldAll = () => {
      const next = new Set(effectiveFold)
      for (const group of filtered) { if (anyCollapsed) next.delete(group.id); else next.add(group.id) }
      setFolds(next)
    }
    const hiddenWritable = canWriteHidden(form, snapshot)
    const disabled = busy || !hiddenWritable || state.status !== 'ready'
    const applyInput = snapshot.value?.applyInput !== false
    const applyDisabled = busy || snapshot.writable !== true || !features.includes('applyInput') || snapshot.status !== 'ready'
    const runWrite = (work, failText) => {
      if (writeEpoch !== visibilityEpoch(form) || writeLock.current?.epoch === writeEpoch) return
      const job = { epoch: writeEpoch }
      writeLock.current = job; setOperation(job); setError(null)
      const report = () => { if (writeEpoch === visibilityEpoch(form)) setError({ epoch: writeEpoch, message: t(failText) }) }
      const send = async () => {
        try { if (await work() !== true) report() }
        catch { report() }
        finally { if (writeLock.current === job) { writeLock.current = null; setOperation(null) } }
      }
      void send()
    }
    const changeVisibility = (routes, visible) => {
      if (disabled || !routes.length) return
      runWrite(() => writeHiddenRoutes(form, routes, visible, writeEpoch), 'page.visibilityFailed')
    }
    const startConfirm = (spec, event) => { setConfirm({ ...spec, epoch: state.epoch, trigger: event?.currentTarget ?? null }) }
    const cancelConfirm = () => { pendingFocus.current = confirm?.trigger || searchInput.current; setConfirm(null) }
    const openEditor = (group, model, trigger) => {
      if (!canOpenEditor) return
      const id = overrideIdentity(group.id, model.id)
      editTrigger.current = trigger; pendingFocus.current = null
      setEditing({ id, epoch: overrideState.epoch, revision: overrideState.revisions.get(id) ?? null, entry: entryById.get(id) ?? { provider: group.id, model: model.id }, model, dirty: false })
      clientTrace('editor', 'open', { provider: group.id, model: model.id })
    }
    const closeEditor = () => { pendingFocus.current = editTrigger.current || searchInput.current; setEditing(null); editTrigger.current = null }
    const askEditor = (group, model, event) => {
      if (!canOpenEditor || overrideState.pending) return
      const id = overrideIdentity(group.id, model.id)
      const target = event?.currentTarget ?? null
      if (editing?.dirty) { startConfirm({ kind: 'discard', next: editing.id === id ? null : { group, model } }, event); return }
      if (editing?.id === id) closeEditor(); else openEditor(group, model, target)
    }
    const runCatalogAction = (hard) => {
      if (busy || reloading || (!hard && refreshing)) return
      const set = hard ? setReloading : setRefreshing
      if (hard) setRefreshing(false)
      set(true)
      Promise.resolve().then(() => { if (hard) { void overrides.load(); return catalog.reload() }; return catalog.refresh() })
        .catch(() => {}).finally(() => set(false))
    }
    const activeGroup = editing ? catalogById.get(editing.entry.provider) : null
    const currentModel = activeGroup?.models?.find((model) => model.id === editing.entry.model)
    const editorModel = currentModel || editing?.model
    const editedShown = Boolean(editing && !effectiveFold.has(editing.entry.provider) && filtered.some((group) => group.id === editing.entry.provider && group.models.some((model) => model.id === editing.entry.model)))
    const currentRevision = editing ? overrideState.revisions?.get(editing.id) ?? null : null
    const reference = editorModel?.referenceReasoning
    const evidence = editorModel?.fieldEvidence
    const proof = reference ? evidence?.referenceReasoning : evidence?.reasoningEfforts ?? evidence?.reasoning
    const referenceSource = proof?.catalog || (reference ? editorModel.referenceReasoningSource : editorModel?.reasoningCatalog) || proof?.source || sourceOf(editorModel, 'reasoning')
    const referenceLabel = ['unknown', 'config', 'provider', 'adapter', 'manual', 'inferred', 'official', 'public', 'snapshot', 'catalog'].includes(referenceSource)
      ? sourceLabel(referenceSource, t) : referenceSource
    const editor = editing ? h(ModelOverrideEditor, {
      // Never nest this element inside a group or a row: React tracks this key among the SAME siblings,
      // even when the row is filtered out, folded, removed or re-ordered by a background catalog read.
      key: 'draft:' + editing.id, id: editorId, entry: editing.entry, revision: editing.revision, hasOverride: editing.revision !== null,
      stale: editing.epoch !== overrideState.epoch || (overridesReady && currentRevision !== editing.revision), blocked: !canOpenEditor,
      detached: !editedShown, missing: state.status === 'ready' && !currentModel, name: editorModel.name || editorModel.id,
      routeKind: kindOf(editorModel), t, overrides, canMap: features.includes('reasoningMappings'),
      canDirect: features.includes('effortDirect'), canReferencePrefill: features.includes('referencePrefill'),
      referenceEfforts: kindOf(editorModel) === 'chat' ? (reference || editorModel.reasoning)?.efforts : [],
      referenceSource: referenceLabel, referenceAlias: proof?.alias === true || (Boolean(reference) && editorModel.referenceReasoningAlias === true),
      onDirty: () => setEditing((previous) => previous?.id === editing.id && !previous.dirty ? { ...previous, dirty: true } : previous),
      onClose: closeEditor,
      onSaved: (result, action) => {
        closeEditor()
        setReceipt({ route: editing.id, epoch: state.epoch, name: editing.entry.provider + ' / ' + editing.entry.model, message: providerWriteNote(result?.provider, t, action, result) })
        void catalog.afterChange({ fresh: false })
      },
    }) : null
    const note = receipt && receipt.epoch === state.epoch ? h('div', { key: 'write-receipt', className: 'mvp_receipt', role: 'status' }, h('strong', null, receipt.name), ' · ', receipt.message,
      h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: () => setReceipt(null) }, t('page.dismissReceipt'))) : null
    let placedReceipt = false
    const rows = []
    if (editor && !editedShown) rows.push(editor)
    for (const [index, group] of filtered.entries()) {
      const models = group.models
      const allCount = catalogById.get(group.id)?.models?.length ?? models.length
      const name = providerLabel(group, t) || group.id
      const folded = effectiveFold.has(group.id)
      const countId = groupId + '-' + index
      const off = affectedRoutes([group], hidden, true)
      const visible = off.length > 0
      const routes = visible ? off : affectedRoutes([group], hidden, false)
      const actionKey = visible ? activeFilters ? 'group.showFiltered' : 'group.showAll' : activeFilters ? 'group.hideFiltered' : 'group.hideAll'
      rows.push(h('div', { key: 'head:' + group.id, className: 'mvp_groupHead' },
        h('button', { type: 'button', className: 'mvp_groupTitle', 'aria-expanded': !folded, 'aria-describedby': countId,
          'aria-label': t(folded ? 'group.expandNamed' : 'group.collapseNamed', { name }), onClick: () => foldOne(group.id) },
          h('span', { className: 'mvp_chevron', 'aria-hidden': true }, folded ? '▸' : '▾'),
          h('span', { className: 'mvp_groupName' }, name),
          h('span', { className: 'mvp_groupCount', id: countId }, activeFilters
            ? t('group.matchCount', { matches: models.length, total: allCount, enabled: models.length - off.length })
            : t('group.count', { enabled: allCount - off.length, total: allCount })),
        ),
        h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: disabled || !routes.length,
          onClick: (event) => startConfirm({ kind: 'visibility', routes, visible, group: group.id, scope: name }, event) }, t(actionKey, { count: routes.length })),
      ))
      if (!folded) for (const model of models) {
        const id = overrideIdentity(group.id, model.id)
        const shown = !hidden.has(keyOf(group.id, model.id))
        rows.push(modelRow({ group, model, rowId: id, editorId, t, shown, disabled,
          exposeEditor: supportsOverrides && overrideState.available !== false, canOpenEditor, editDisabled: busy || overrideState.pending,
          isEditing: editing?.id === id, edit: (event) => askEditor(group, model, event),
          toggle: () => changeVisibility([{ provider: group.id, model: model.id }], !shown), facts: facts === id, showFacts: (open) => setFacts(open ? id : null),
        }))
        if (editor && editing.id === id) rows.push(editor)
        if (note && receipt.route === id) { rows.push(note); placedReceipt = true }
      }
    }
    if (note && !placedReceipt) rows.unshift(note)
    const loading = state.status === 'loading' || state.status === 'idle'
    const options = [['all', total], ['chat', allKinds.chat], ['image', allKinds.image], ['video', allKinds.video], ['other', allKinds.other]]
    const failed = (state.providers ?? []).filter((provider) => provider && (provider.status === 'failed' || provider.status === 'unauthorized'))
    const applyCap = featuresKnown && features.includes('applyInput')
    const filterButton = (key, label, pressed, action, tooltip) => h('button', { key, type: 'button', className: 'mvp_filter', 'aria-pressed': pressed, title: tooltip,
      onClick: () => { action(); clientTrace('filters', 'change', { status: key }) } }, label)
    const actionButton = (label, title, action, off, accent = false) => h('button', { type: 'button', className: 'mvp_button' + (accent ? ' mvp_button--accent' : ''),
      disabled: off, title: t(title), onClick: action }, t(label))
    const banner = (text, warn = false) => h('div', { className: 'mvp_banner' + (warn ? ' mvp_banner--warn' : ''), role: warn ? 'alert' : 'status' }, text)
    let confirmation = null
    if (confirm?.kind === 'visibility') {
      const current = affectedRoutes(confirm.group === undefined ? filtered : filtered.filter((group) => group.id === confirm.group), hidden, confirm.visible)
      const currentIds = new Set(current.map((r) => overrideIdentity(r.provider, r.model)))
      const changed = confirm.epoch !== state.epoch || currentIds.size !== confirm.routes.length || confirm.routes.some((r) => !currentIds.has(overrideIdentity(r.provider, r.model)))
      const count = confirm.routes.length
      confirmation = h(SettingsConfirm, { title: t(confirm.visible ? 'page.confirmEnable' : 'page.confirmDisable', { count }),
        description: t('page.confirmScope', { scope: confirm.scope, count }), targets: confirm.routes, targetLabel: t('page.confirmTargets', { count }),
        confirmLabel: t(confirm.visible ? 'page.doEnable' : 'page.doDisable', { count }), cancelLabel: t('page.cancel'),
        disabled, changed: changed ? t('page.confirmChanged') : null,
        onCancel: cancelConfirm, onConfirm: () => { if (disabled || changed) return; changeVisibility(confirm.routes, confirm.visible); cancelConfirm() },
      })
    } else if (confirm?.kind === 'discard') {
      confirmation = h(SettingsConfirm, { title: t('override.discardTitle'), description: t('override.discardDescription', { name: editing?.entry.model ?? '' }),
        confirmLabel: t('override.discard'), cancelLabel: t('override.keepEditing'), disabled: overrideState.pending,
        onCancel: cancelConfirm, onConfirm: () => { if (overrideState.pending) return; setConfirm(null); if (confirm.next) openEditor(confirm.next.group, confirm.next.model, confirm.trigger); else closeEditor() },
      })
    }
    return h('div', { className: 'mvp_page' },
      h('div', { className: 'mvp_head' }, h('div', { className: 'mvp_headMain' }, h('h2', { className: 'mvp_title' }, t('page.title')),
        h('span', { className: 'mvp_summary' }, total ? t('page.summary', { visible: total - hiddenCount, total }) : t(loading ? 'page.loading' : 'page.empty'))),
        h('div', { className: 'mvp_headActions' },
          actionButton(refreshing ? 'page.refreshing' : 'page.refresh', 'page.refreshTitle', () => runCatalogAction(false), busy || refreshing || reloading),
          actionButton(reloading ? 'page.reloading' : 'page.reload', features.includes('reload') ? 'page.reloadTitle' : 'page.reloadUnavailable', () => runCatalogAction(true), busy || reloading || !features.includes('reload')),
        ),
      ),
      h(DebugPanel, { key: 'debug:' + state.epoch, t, features }),
      featuresKnown && !features.includes('usage') ? h('div', { className: 'mvp_usage mvp_usage--off' }, t('usage.hostStale'), h('div', { className: 'mvp_usageStatus' })) : h(UsageToolbar, { usage, t, features }),
      h('div', { className: 'mvp_filters' },
        h('input', { className: 'mvp_searchInput', type: 'search', value: query, ref: searchInput, placeholder: t('page.searchPlaceholder'), 'aria-label': t('page.searchPlaceholder'),
          onInput: (event) => setQuery(event.target.value) }),
        h('div', { className: 'mvp_filterGroup', role: 'group', 'aria-label': t('override.kind') }, options.map(([key, count]) => filterButton(key, t('page.filter.' + key) + ' ' + count, filter === key, () => setFilter(key)))),
        h('select', { className: 'mvp_contextSelect', value: visibility, 'aria-label': t('page.visibility.label'), onChange: (event) => setVisibility(event.target.value) },
          ['all', 'enabled', 'disabled'].map((key) => h('option', { key, value: key }, t('page.visibility.' + key)))),
        h('div', { className: 'mvp_filterGroup' },
          filterButton('multimodal', t('page.capability.multimodal'), multimodalOnly, () => setMultimodalOnly(!multimodalOnly), t('page.capability.multimodalTitle')),
          filterButton('reasoning', t('page.capability.reasoning'), reasoningOnly, () => setReasoningOnly(!reasoningOnly), t('page.capability.reasoningTitle')),
          h('select', { className: 'mvp_contextSelect', value: String(minContext), 'aria-label': t('page.contextLabel'), onChange: (event) => setMinContext(Number(event.target.value)) },
            [[0, 'any'], [128000, '128k'], [256000, '256k'], [512000, '512k'], [1000000, '1m']].map(([value, key]) => h('option', { key, value: String(value) }, t('page.context.' + key)))),
        ),
      ),
      h('div', { className: 'mvp_listTools' },
        activeFilters ? h('span', { className: 'mvp_summary', role: 'status' }, t('page.matchCount', { count: matchCount })) : null,
        activeFilters ? h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: resetFilters }, t('page.clearFilters')) : null,
        h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: disabled || !hiddenMatches.length,
          onClick: (event) => startConfirm({ kind: 'visibility', visible: true, routes: hiddenMatches, scope: t(activeFilters ? 'page.scopeFiltered' : 'page.scopeCatalog') }, event) },
          t(activeFilters ? 'page.showMatches' : 'page.showAll', { count: hiddenMatches.length })),
        h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: !filtered.length, onClick: foldAll },
          t(activeFilters ? anyCollapsed ? 'page.expandMatches' : 'page.collapseMatches' : anyCollapsed ? 'page.expandGroups' : 'page.collapseGroups')),
        h('details', { className: 'mvp_details' }, h('summary', null, t('page.listHelp')), h('p', null, t('page.listHint')), h('p', null, t('page.filterHint'))),
      ),
      applyCap ? h('div', { className: 'mvp_applyRow' },
        h('button', { type: 'button', role: 'switch', className: 'mvp_switch', 'aria-checked': applyInput, 'aria-label': t('page.applyInput'), 'aria-describedby': applyHintId,
          disabled: applyDisabled, onClick: () => { if (!applyDisabled) runWrite(() => queueVisibilityWrite(form, writeEpoch, () => form.set('applyInput', !applyInput)), 'page.saveFailed') } }, h('span', { className: 'mvp_thumb' })),
        h('span', { className: 'mvp_applyTitle' }, t('page.applyInput')),
        h('details', { className: 'mvp_details' }, h('summary', null, t('page.applyHelp')), h('p', { id: applyHintId }, t('page.applyInputHint'))),
      ) : null,
      !hiddenWritable && snapshot.status !== 'loading' && snapshot.status !== 'idle' ? banner(t('page.visibilityReadOnly')) : null,
      failed.length ? banner(t('page.probeFailures', { names: failed.map((entry) => entry.name || entry.id).join(' · ') }), true) : null,
      featuresKnown && !applyCap ? banner(t('page.hostStale')) : null,
      state.source === 'catalog' && state.detailsError ? banner(t('page.metaFallback')) : null,
      state.failures.length ? banner(t('page.providerFailures', { names: state.failures.map((entry) => entry.name || entry.id).join(' · ') }), true) : null,
      supportsOverrides && overrideState.available === false ? banner(t('override.unavailable')) : null,
      supportsOverrides && overrideState.status === 'error' ? banner(h(React.Fragment, null, t('override.listFailed', { message: overrideState.error }), ' ',
        h('button', { type: 'button', className: 'mvp_button', onClick: () => { void overrides.load() } }, t('override.retryList'))), true) : null,
      error ? banner(error, true) : null,
      state.error ? banner(t('page.error', { message: state.error }), true) : null,
      h('div', { className: 'mvp_groups' }, rows),
      !matchCount && !loading && !state.error ? h('p', { className: 'mvp_note' }, t(total && activeFilters ? 'page.filterEmpty' : 'page.empty')) : null,
      confirmation,
      h(VerifyPanel, { verify, catalog: state, t, observeVerify, canUse: featuresKnown && state.status === 'ready' && supportsVerify, onFinished: catalog.afterChange,
        canFullScan: supportsVerify && features.includes('verifyFullScan'), canSetMode: features.includes('verifyModes'), canSetSourceMode }),
      h(AboutPanel, { key: 'about:' + state.epoch, t, features }),
    )
  }
}

export { makeSection }
