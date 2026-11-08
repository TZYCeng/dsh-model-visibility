const React = require('react')
const h = React.createElement

import { keyOf, kindOf, isGenerationKind, providerLabel, countModels, readCollapsedGroups, persistCollapsedGroups, overrideKeyOf } from './format.mjs'
import { computeFilteredGroups, countKinds, probeOf } from './pure.mjs'
import { capabilityTags, tagClassOf } from './tags.mjs'
import { ModelOverrideEditor, providerWriteNote } from './override-editor.mjs'
import { useHidden, useSource } from './hooks.mjs'
import { UsageToolbar } from './usage-view.mjs'
import { VerifyPanel } from './checker-view.mjs'

function makeSection(form, catalog, overrides, usage, verify) {
  return function ModelVisibilitySection({ t }) {
    const { hidden, snapshot } = useHidden(form)
    const state = useSource(catalog)
    const overrideState = useSource(overrides)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [refreshing, setRefreshing] = React.useState(false)
    const [reloading, setReloading] = React.useState(false)
    const [collapsed, setCollapsed] = React.useState(readCollapsedGroups)
    const [editing, setEditing] = React.useState(null)
    const [providerNote, setProviderNote] = React.useState(null)

    React.useEffect(() => {
      catalog.load()
      overrides.load()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const catalogMeta = state.learned && typeof state.learned === 'object' ? state.learned : null
    const hostFeatures =
      catalogMeta && Array.isArray(catalogMeta.features) ? catalogMeta.features : []
    const canEdit = state.source === 'host' && hostFeatures.includes('overrides')
    const canVerify = state.source === 'host' && hostFeatures.includes('verify')
    const overrideEntries = new Map()
    for (const entry of overrideState.entries) {
      overrideEntries.set(overrideKeyOf(entry), entry)
    }

    const writable = snapshot.writable !== false
    const groups = state.groups
    const total = countModels(groups)
    const hiddenCount = groups.reduce(
      (count, group) =>
        count +
        (group.models || []).filter((model) => hidden.has(keyOf(group.id, model.id))).length,
      0,
    )
    const allKinds = countKinds(groups.flatMap((group) => group.models || []))
    const generationCount = allKinds.image + allKinds.video
    const [filter, setFilter] = React.useState('all')
    const [query, setQuery] = React.useState('')
    const [multimodalOnly, setMultimodalOnly] = React.useState(false)
    const [reasoningOnly, setReasoningOnly] = React.useState(false)
    const [minContext, setMinContext] = React.useState(0)
    const normalizedQuery = query.trim().toLowerCase()
    const filteredGroups = computeFilteredGroups(groups, {
      filter,
      query: normalizedQuery,
      multimodalOnly,
      reasoningOnly,
      minContext,
    })
    const disabled = busy || !writable

    const writeField = (field, value) => {
      if (disabled) return
      setBusy(true)
      setError(null)
      Promise.resolve(form.set(field, value)).then(
        (accepted) => {
          if (accepted === false) setError(t('page.saveFailed'))
        },
        () => {
          setError(t('page.saveFailed'))
        },
      ).finally(() => {
        setBusy(false)
      })
    }

    const commit = (next) => writeField(FIELD, Array.from(next))
    const applyInput = !(snapshot.value && snapshot.value.applyInput === false)
    const commitApply = (next) => writeField('applyInput', next)

    const toggleModel = (group, model) => {
      const next = new Set(hidden)
      const key = keyOf(group.id, model.id)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      commit(next)
    }

    const setGroup = (group, subset, visible) => {
      const next = new Set(hidden)
      for (const model of subset) {
        const key = keyOf(group.id, model.id)
        if (visible) next.delete(key)
        else next.add(key)
      }
      commit(next)
    }

    const runCatalogAction = (action, setActive) => {
      setActive(true)
      Promise.resolve()
        .then(action)
        .catch(() => {})
        .finally(() => setActive(false))
    }

    const refreshCatalog = () => {
      if (refreshing || reloading) return
      runCatalogAction(() => catalog.refresh(), setRefreshing)
    }

    // A hard reload may supersede a soft refresh that is still running;
    // catalog.load() gives it a new run and discards the older result.
    const reloadCatalog = () => {
      if (busy || reloading) return
      runCatalogAction(() => catalog.reload(), setReloading)
    }

    const toggleGroupCollapsed = (id) => {
      setCollapsed((previous) => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        persistCollapsedGroups(next)
        return next
      })
    }

    const toggleAllCollapsed = () => {
      setCollapsed((previous) => {
        const collapsedNow = groups.some((group) => previous.has(group.id))
        const next = collapsedNow ? new Set() : new Set(groups.map((group) => group.id))
        persistCollapsedGroups(next)
        return next
      })
    }

    const rows = []
    for (const group of filteredGroups) {
      const allGroupModels =
        (groups.find((candidate) => candidate.id === group.id) || group).models || []
      const models = group.models || []
      const shown = allGroupModels.filter(
        (model) => !hidden.has(keyOf(group.id, model.id)),
      ).length
      const allShown = models.every((model) => !hidden.has(keyOf(group.id, model.id)))
      const kinds = countKinds(allGroupModels)
      const kindParts = []
      if (kinds.chat > 0) kindParts.push(['chat', t('page.filter.chat') + ' ' + kinds.chat])
      if (kinds.image > 0) kindParts.push(['image', t('page.filter.image') + ' ' + kinds.image])
      if (kinds.video > 0) kindParts.push(['video', t('page.filter.video') + ' ' + kinds.video])
      if (kinds.other > 0) kindParts.push(['other', t('page.filter.other') + ' ' + kinds.other])
      const kindNodes = []
      for (const [index, [kindKey, label]] of kindParts.entries()) {
        if (index > 0) kindNodes.push(' · ')
        kindNodes.push(
          h(
            'span',
            {
              key: kindKey,
              className:
                'mvp_kindCount' +
                (kindKey === 'chat' ? '' : ' mvp_kindCount--' + kindKey),
            },
            label,
          ),
        )
      }
      const groupName = providerLabel(group, t)
      const collapsedNow = collapsed.has(group.id)
      const collapseLabel = t(collapsedNow ? 'group.expandNamed' : 'group.collapseNamed', {
        name: groupName,
      })
      const probe = probeOf(state, group, t)
      rows.push(
        h(
          'div',
          { key: group.id, className: 'mvp_group' },
          h(
            'div',
            { className: 'mvp_groupHead' },
            h(
              'div',
              { className: 'mvp_groupTitle' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_collapse',
                  'aria-expanded': !collapsedNow,
                  'aria-label': collapseLabel,
                  title: collapseLabel,
                  onClick: () => toggleGroupCollapsed(group.id),
                },
                collapsedNow ? '▸' : '▾',
              ),
              h('span', { className: 'mvp_groupName' }, groupName),
              h('span', { className: 'mvp_groupCount' }, shown + '/' + allGroupModels.length),
              kindParts.length > 0
                ? h('span', { className: 'mvp_groupCap' }, kindNodes)
                : null,
              probe !== null
                ? h('span', { className: 'mvp_groupProbe', title: probe.title || undefined }, probe.label)
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mvp_button',
                disabled: disabled,
                onClick: () => setGroup(group, models, !allShown),
              },
              allShown
                ? filter === 'all'
                  ? t('group.hideAll')
                  : t('group.hideFiltered')
                : filter === 'all'
                  ? t('group.showAll')
                  : t('group.showFiltered'),
            ),
          ),
          collapsedNow
            ? null
            : models.map((model) => {
              const rowKey = keyOf(group.id, model.id)
              const shownModel = !hidden.has(rowKey)
              const tags = capabilityTags(model, t)
              const kind = kindOf(model)
              const generation = isGenerationKind(kind)
              const kindTint =
                kind !== 'chat' &&
                ['image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation'].includes(kind)
                  ? ' mvp_row--kind-' + kind
                  : ''
              const row = h(
                'div',
                {
                  className:
                    'mvp_row' +
                    (generation ? ' mvp_row--gen' : '') +
                    kindTint,
                },
                h(
                  'div',
                  { className: 'mvp_rowText' },
                  h('div', { className: 'mvp_rowTitle' }, model.name),
                  model.id === model.name
                    ? null
                    : h('div', { className: 'mvp_rowMeta' }, model.id),
                  h(
                    'div',
                    { className: 'mvp_tags' },
                    tags.map((tag) =>
                      h(
                        'span',
                        {
                          key: tag.key,
                          className: tagClassOf(tag),
                          title: tag.title || undefined,
                        },
                        tag.label,
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'mvp_rowActions' },
                  canEdit
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'mvp_button mvp_editButton',
                          'aria-pressed': editing === rowKey,
                          'aria-label': t('row.edit') + ': ' + model.name,
                          title: t('row.editTitle'),
                          disabled: busy,
                          onClick: () => setEditing(editing === rowKey ? null : rowKey),
                        },
                        t('row.edit'),
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'switch',
                      className: 'mvp_switch',
                      'aria-checked': shownModel,
                      'aria-label': model.name,
                      disabled: disabled,
                      onClick: () => toggleModel(group, model),
                    },
                    h('span', { className: 'mvp_thumb' }),
                  ),
                ),
              )
              const editor =
                canEdit && editing === rowKey
                  ? h(ModelOverrideEditor, {
                      key: 'editor',
                      entry:
                        overrideEntries.get(rowKey) || { provider: group.id, model: model.id },
                      name: model.name,
                      t,
                      overrides,
                      onClose: () => setEditing(null),
                      onSaved: (result) => {
                        setEditing(null)
                        setProviderNote(providerWriteNote(result && result.provider, t))
                        refreshCatalog()
                      },
                    })
                  : null
              return h(React.Fragment, { key: model.id }, row, editor)
            }),
        ),
      )
    }

    const loading = state.status === 'loading' || state.status === 'idle'
    const providerList = Array.isArray(state.providers) ? state.providers : []
    const probeOk = providerList.filter((provider) => provider && provider.status === 'ok').length
    const probeCaps = providerList.reduce(
      (count, provider) => count + (Number(provider && provider.capabilities) || 0),
      0,
    )
    const probeNote =
      state.source === 'host'
        ? providerList.length > 0
          ? t('page.probeSummary', { ok: probeOk, caps: probeCaps })
          : t('page.probeSummaryNone')
        : null
    // A page refresh can deliver this bundle while the Host half is still
    // the previous version; the switch would look live but do nothing.
    const hostStale = state.source === 'host' && !hostFeatures.includes('applyInput')
    // A hard reload is only meaningful when the Host half understands it.
    const canReload = state.source === 'host' && hostFeatures.includes('reload')
    const anyCollapsed = groups.some((group) => collapsed.has(group.id))
    const learnedDate =
      catalogMeta && Number.isFinite(catalogMeta.updatedAt)
        ? catalogMeta.updatedAt > 0
          ? new Date(catalogMeta.updatedAt).toISOString().slice(0, 10)
          : null
        : null
    const catalogNote =
      catalogMeta !== null
        ? t('page.learnedNote', {
            models: catalogMeta.models ?? 0,
            date: learnedDate || '?',
          })
        : null
    const filterOptions = [
      ['all', t('page.filter.all'), total],
      ['chat', t('page.filter.chat'), allKinds.chat],
      ['image', t('page.filter.image'), allKinds.image],
      ['video', t('page.filter.video'), allKinds.video],
      ['other', t('page.filter.other'), allKinds.other],
    ]
    const hasActiveFilters =
      filter !== 'all' || normalizedQuery !== '' || multimodalOnly || reasoningOnly || minContext > 0

    return h(
      'div',
      { className: 'mvp_page' },
      h(UsageToolbar, { usage, t, features: state.source === 'host' ? hostFeatures : [] }),
      h(
        'div',
        { className: 'mvp_head' },
        h('h2', { className: 'mvp_title' }, t('page.title')),
        h('p', { className: 'mvp_desc' }, t('page.description')),
      ),
      h(
        'div',
        { className: 'mvp_toolbar' },
        h(
          'div',
          { className: 'mvp_summary' },
          total === 0
            ? loading
              ? t('page.loading')
              : t('page.empty')
            : t('page.summary', { visible: total - hiddenCount, total }) +
              (hiddenCount > 0 ? ' · ' + t('page.hiddenSummary', { count: hiddenCount }) : '') +
              (generationCount > 0 ? ' · ' + t('page.kindSummary', { count: generationCount }) : ''),
        ),
        h(
          'div',
          { className: 'mvp_actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button',
              disabled: disabled || hiddenCount === 0,
              onClick: () => commit(new Set()),
            },
            t('page.showAll'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button',
              disabled: groups.length === 0,
              title: t(anyCollapsed ? 'page.expandGroupsTitle' : 'page.collapseGroupsTitle'),
              onClick: toggleAllCollapsed,
            },
            t(anyCollapsed ? 'page.expandGroups' : 'page.collapseGroups'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button',
              disabled: busy || refreshing || reloading,
              onClick: refreshCatalog,
            },
            t(refreshing ? 'page.refreshing' : 'page.refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_button mvp_button--accent',
              disabled: !canReload || busy || reloading,
              title: t(canReload ? 'page.reloadTitle' : 'page.reloadUnavailable'),
              onClick: reloadCatalog,
            },
            t(reloading ? 'page.reloading' : 'page.reload'),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mvp_filters' },
        h('label', { className: 'mvp_search' },
          h('span', { className: 'mvp_filterLabel' }, t('page.searchPlaceholder')),
          h('input', {
            className: 'mvp_searchInput',
            type: 'search',
            value: query,
            placeholder: t('page.searchPlaceholder'),
            'aria-label': t('page.searchPlaceholder'),
            onInput: (event) => setQuery(event.target.value),
          }),
        ),
        h('span', { className: 'mvp_filterLabel' }, t('page.filterLabel')),
        filterOptions.map(([value, label, count]) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'mvp_filter',
              'aria-pressed': filter === value,
              onClick: () => setFilter(value),
            },
            label + ' ' + count,
          ),
        ),
        h('span', { className: 'mvp_filterLabel' }, t('page.capabilityLabel')),
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_filter',
            'aria-pressed': multimodalOnly,
            onClick: () => setMultimodalOnly(!multimodalOnly),
          },
          t('page.capability.multimodal'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_filter',
            'aria-pressed': reasoningOnly,
            onClick: () => setReasoningOnly(!reasoningOnly),
          },
          t('page.capability.reasoning'),
        ),
        h('label', { className: 'mvp_context' },
          h('span', { className: 'mvp_filterLabel' }, t('page.contextLabel')),
          h(
            'select',
            {
              className: 'mvp_contextSelect',
              value: String(minContext),
              'aria-label': t('page.contextLabel'),
              onChange: (event) => setMinContext(Number(event.target.value)),
            },
            [
              [0, 'page.context.any'],
              [128000, 'page.context.128k'],
              [256000, 'page.context.256k'],
              [512000, 'page.context.512k'],
              [1000000, 'page.context.1m'],
            ].map(([value, label]) => h('option', { key: value, value: String(value) }, t(label))),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mvp_applyRow' },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'mvp_switch',
            'aria-checked': applyInput,
            'aria-label': t('page.applyInput'),
            disabled: disabled,
            onClick: () => commitApply(!applyInput),
          },
          h('span', { className: 'mvp_thumb' }),
        ),
        h(
          'div',
          { className: 'mvp_applyText' },
          h('div', { className: 'mvp_applyTitle' }, t('page.applyInput')),
          h('div', { className: 'mvp_applyHint' }, t('page.applyInputHint')),
        ),
      ),
      h(
        VerifyPanel,
        { verify, catalog: state, t, canUse: canVerify },
      ),
      h('div', { className: 'mvp_legend' }, t('page.legend')),
      h('div', { className: 'mvp_legend' }, t('page.kindLegend')),
      h('div', { className: 'mvp_legend' }, t('page.manualNote')),
      overrideState.available === false
        ? h('div', { className: 'mvp_fallback' }, t('override.unavailable'))
        : null,
      state.detailsError !== null && state.source === 'catalog'
        ? h('div', { className: 'mvp_fallback' }, t('page.metaFallback'))
        : null,
      hostStale ? h('div', { className: 'mvp_fallback' }, t('page.hostStale')) : null,
      state.failures.length > 0
        ? h(
            'div',
            {
              className: 'mvp_fallback',
              title: state.failures
                .map((failure) => (failure.name || failure.id) + ': ' + failure.message)
                .join('\n'),
            },
            t('page.providerFailures', {
              names: state.failures
                .map((failure) => failure.name || failure.id)
                .join(' · '),
            }),
          )
        : null,
      error !== null ? h('div', { className: 'mvp_error', role: 'alert' }, error) : null,
      state.error !== null
        ? h('div', { className: 'mvp_error', role: 'alert' }, t('page.error', { message: state.error }))
        : null,
      rows.length > 0 ? rows : null,
      total > 0 && hasActiveFilters && rows.length === 0
        ? h('div', { className: 'mvp_note' }, t('page.filterEmpty'))
        : null,
      rows.length === 0 && !loading && state.error === null && total === 0
        ? h('div', { className: 'mvp_error' }, t('page.empty'))
        : null,
      probeNote !== null ? h('div', { className: 'mvp_note' }, probeNote) : null,
      providerNote !== null ? h('div', { className: 'mvp_note' }, providerNote) : null,
      catalogNote !== null ? h('div', { className: 'mvp_note' }, catalogNote) : null,
    )
  }
}

export { makeSection }
