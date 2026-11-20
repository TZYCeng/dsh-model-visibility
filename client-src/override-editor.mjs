const React = require('react')
const h = React.createElement

import { modalityLabel, effortLabel, OVERRIDE_MODALITIES, OVERRIDE_EFFORTS } from './format.mjs'

const isStandardChoice = (id) => id !== 'off' && OVERRIDE_EFFORTS.includes(id)

function providerWriteNote(result, t) {
  if (result === null || typeof result !== 'object') return null
  const fieldLabels = (fields) => fields.map((field) => {
    const key = 'override.field.' + field
    const label = t(key)
    return label === key ? field : label
  }).join(' / ')
  const messages = []
  if (result.written === true) {
    messages.push(t('override.providerWritten', { fields: fieldLabels(Array.isArray(result.fields) ? result.fields : []) }))
  } else if (result.reason && result.reason !== 'nothing' && result.reason !== 'skipped') {
    const key = 'override.reason.' + result.reason
    const label = t(key)
    messages.push(t('override.providerSkipped', { reason: label === key ? result.reason : label }))
  }
  if (result.localOnly?.length) messages.push(t('override.localOnly', { fields: fieldLabels(result.localOnly) }))
  if (result.unresolvedEfforts?.length) messages.push(t('override.unresolvedEfforts', {
    levels: result.unresolvedEfforts.map((id) => effortLabel(id, t)).join(' / '),
  }))
  if (result.reasoningConflict === 'route-default') messages.push(t('override.routeDefaultConflict'))
  if (result.reasoningConflict === 'inherited-ladder') messages.push(t('override.inheritedLadderConflict'))
  if (result.reasoningConflict === 'standard-format') messages.push(t('override.standardFormatConflict'))
  if (result.reasoningConflict === 'reference-disabled') messages.push(t('override.referenceDisabled'))
  if (result.reasoningConflict === 'reference-nonchat') messages.push(t('override.referenceNonChat'))
  if (Array.isArray(result.protectedEfforts) && result.protectedEfforts.length > 0) {
    messages.push(t('override.referencePreservedEfforts', {
      levels: result.protectedEfforts.map((id) => effortLabel(id, t)).join(' / '),
    }))
  }
  return messages.length > 0 ? messages.join(' · ') : null
}

function ModelOverrideEditor({
  entry, revision, hasOverride, blocked, stale, name, t, overrides, onClose, onSaved,
  canMap = false, hasStandard = false, canUseStandard = false, canReferencePrefill = false,
  referenceEfforts = [], referenceSource = '', referenceAlias = false,
}) {
  const [kind, setKind] = React.useState(entry.kind || '')
  const [context, setContext] = React.useState(
    entry.contextWindow === undefined ? '' : String(entry.contextWindow),
  )
  const [input, setInput] = React.useState(
    () => new Set(Array.isArray(entry.input) ? entry.input : []),
  )
  const [efforts, setEfforts] = React.useState(
    () => new Set((Array.isArray(entry.efforts) ? entry.efforts : []).map((item) => item.id)),
  )
  const [noReasoning, setNoReasoning] = React.useState(entry.reasoningSupported === false)
  const [defaultEffort, setDefaultEffort] = React.useState(
    typeof entry.defaultEffort === 'string' ? entry.defaultEffort : '',
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [applyToProvider, setApplyToProvider] = React.useState(false)
  const [wireValues, setWireValues] = React.useState({})
  const [omitOff, setOmitOff] = React.useState(false)
  const [standardEffort, setStandardEffort] = React.useState(false)
  const [referenceApplied, setReferenceApplied] = React.useState(false)
  const [confirmation, setConfirmation] = React.useState(null)
  const referenceButton = React.useRef(null)
  const saveButton = React.useRef(null)
  const confirmationPreview = React.useRef(null)
  const contextInput = React.useRef(null)
  const returnFocus = React.useRef(null)
  const referencePanel = React.useId()
  const providerPanel = React.useId()

  React.useEffect(() => {
    if (confirmation !== null) confirmationPreview.current?.focus()
    else if (returnFocus.current !== null) {
      returnFocus.current.current?.focus()
      returnFocus.current = null
    }
  }, [confirmation])

  const closeConfirmation = () => {
    returnFocus.current = confirmation === 'reference' ? referenceButton : saveButton
    setConfirmation(null)
  }
  const cancelOnEscape = (event) => {
    if (event.key !== 'Escape' || confirmation === null) return
    event.preventDefault()
    event.stopPropagation()
    closeConfirmation()
  }

  const toggleIn = (setter, id) => {
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const locked = busy || blocked || stale
  const editingLocked = locked || confirmation !== null
  const fail = (failure) => {
    setBusy(false)
    if (failure?.status === 409) {
      setError(t('override.conflict'))
      void overrides.load()
    } else {
      setError(t('override.failed', { message: String(failure?.message ?? failure) }))
    }
  }

  const availableEfforts = [...new Set([...OVERRIDE_EFFORTS, ...efforts])]
  // Keep the order of a hand-authored ladder. A standalone default must remain selected when filling a ladder.
  const selectedEfforts = [...efforts]
  const suggested = [...new Set((Array.isArray(referenceEfforts) ? referenceEfforts : []).map((item) => item?.id)
    .filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)))]
  const standaloneDefault = selectedEfforts.length === 0 && defaultEffort ? [defaultEffort] : []
  const referenceDraft = [...new Set([...selectedEfforts, ...standaloneDefault, ...suggested])].slice(0, 16)
  const includedReference = suggested.filter((id) => referenceDraft.includes(id))
  const skippedReference = suggested.filter((id) => !referenceDraft.includes(id))
  const levelsOf = (ids) => ids.map((id) => effortLabel(id, t)).join(' / ')
  const providerAllowed = !referenceApplied || canReferencePrefill
  const providerRequested = applyToProvider && providerAllowed
  const canSuggestStandard = canMap && hasStandard && canUseStandard && canReferencePrefill
  const hasStandardChoices = !noReasoning && selectedEfforts.some(isStandardChoice)
  const standardAvailable = hasStandard && canUseStandard && hasStandardChoices
  const fallbackFor = (ids) => ids.filter((id) => isStandardChoice(id) && !wireValues[id]?.trim())
  const mappings = Object.fromEntries(selectedEfforts.filter((id) => OVERRIDE_EFFORTS.includes(id)).flatMap((id) => {
    if (id === 'off' && omitOff) return [[id, null]]
    const value = wireValues[id]?.trim()
    return value ? [[id, value]] : []
  }))

  const applyReference = () => {
    if (locked || noReasoning || confirmation !== 'reference' || includedReference.length === 0) return
    setEfforts(new Set(referenceDraft))
    setReferenceApplied(true)
    if (!canReferencePrefill) setApplyToProvider(false)
    closeConfirmation()
  }

  const save = (confirmed = false) => {
    if (locked || (confirmation !== null && !confirmed)) return
    const contextWindow = context.trim() === '' ? undefined : Number(context)
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
      setError(t('override.contextInvalid'))
      contextInput.current?.focus()
      return
    }
    if (referenceApplied && providerRequested && !confirmed) {
      setError(null)
      setConfirmation('provider')
      return
    }
    const payload = { provider: entry.provider, model: entry.model }
    if (kind !== '') payload.kind = kind
    if (contextWindow !== undefined) payload.contextWindow = contextWindow
    if (input.size > 0) {
      payload.input = [...input]
    }
    if (noReasoning) {
      payload.reasoningSupported = false
    } else if (efforts.size > 0) {
      payload.efforts = selectedEfforts.map((id) => ({ id }))
      if (providerRequested && canMap && Object.keys(mappings).length > 0) payload.reasoningEffortMappings = mappings
    }
    if (!noReasoning && defaultEffort !== '' && (efforts.size === 0 || efforts.has(defaultEffort))) {
      payload.defaultEffort = defaultEffort
    }
    payload.applyToProvider = providerRequested
    if (providerRequested && referenceApplied) payload.referencePrefill = true
    if (providerRequested && standardAvailable && standardEffort) payload.standardEffort = true
    setConfirmation(null)
    setBusy(true)
    setError(null)
    overrides.save(payload, revision).then(
      (result) => {
        setBusy(false)
        if (typeof onSaved === 'function') onSaved(result)
      },
      fail,
    )
  }

  const resetToAuto = () => {
    if (locked || !hasOverride) return
    setBusy(true)
    setError(null)
    overrides.remove(entry.provider, entry.model, revision).then(
      (result) => {
        setBusy(false)
        if (typeof onSaved === 'function') onSaved(result)
      },
      fail,
    )
  }

  const kindOptions = [['', t('override.kindAuto')]].concat(
    ['chat', 'image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation'].map(
      (id) => [id, id === 'chat' ? t('page.filter.chat') : t('tag.kind.' + id)],
    ),
  )
  const defaultOptions = [['', t('override.defaultEffortAuto')]].concat(
    (efforts.size === 0 && defaultEffort !== '' ? [defaultEffort] : selectedEfforts).map((id) => [id, effortLabel(id, t)]),
  )
  const selectedDefault = efforts.size === 0 || efforts.has(defaultEffort) ? defaultEffort : ''
  const referenceFallbacks = canSuggestStandard ? fallbackFor(referenceDraft) : []
  const providerFallbacks = standardAvailable && standardEffort ? fallbackFor(selectedEfforts) : []
  const sourceLabel = referenceAlias
    ? t('override.referenceAlias', { source: referenceSource || t('source.unknown') })
    : referenceSource || t('source.unknown')
  const saveLabel = t(providerRequested ? 'override.saveProvider' : 'override.saveLocal')
  const caution = (summary) => h('div', { className: 'mvp_banner mvp_banner--warn' },
    h('div', null, t(summary)),
    h('details', null,
      h('summary', null, t('override.referenceSafeguards')),
      h('div', null, t('override.referencePreservation')),
      h('div', null, t('override.referenceRevert')),
    ),
  )

  return h(
    'div',
    { className: 'mvp_editor', onKeyDown: cancelOnEscape },
    h(
      'div',
      { className: 'mvp_editorHead' },
      h('div', { className: 'mvp_editorTitle' }, t('override.title') + ' · ' + name),
      h('div', { className: 'mvp_editorSub' }, t('override.hint')),
    ),
    h(
      'div',
      { className: 'mvp_editorGrid' },
      h(
        'label',
        { className: 'mvp_field' },
        h('span', { className: 'mvp_fieldLabel' }, t('override.kind')),
        h(
          'select',
          {
            className: 'mvp_select',
            value: kind,
            disabled: editingLocked,
            'aria-label': t('override.kind'),
            onChange: (event) => setKind(event.target.value),
          },
          kindOptions.map(([value, label]) => h('option', { key: value, value }, label)),
        ),
      ),
      h(
        'label',
        { className: 'mvp_field' },
        h('span', { className: 'mvp_fieldLabel' }, t('override.context')),
        h('input', {
          className: 'mvp_number',
          ref: contextInput,
          type: 'number',
          min: '1',
          step: '1',
          value: context,
          disabled: editingLocked,
          placeholder: t('override.contextPlaceholder'),
          'aria-label': t('override.context'),
          onInput: (event) => setContext(event.target.value),
        }),
      ),
      h(
        'div',
        { className: 'mvp_field mvp_field--wide' },
        h('span', { className: 'mvp_fieldLabel' }, t('override.input')),
        h(
          'div',
          { className: 'mvp_chips' },
          OVERRIDE_MODALITIES.map((id) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                className: 'mvp_chip',
                'aria-pressed': input.has(id),
                disabled: editingLocked,
                onClick: () => toggleIn(setInput, id),
              },
              modalityLabel(id, t),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mvp_field mvp_field--wide' },
        h('span', { className: 'mvp_fieldLabel' }, t('override.efforts')),
        suggested.length > 0 ? h('div', null,
          h('button', {
            ref: referenceButton,
            type: 'button', className: 'mvp_button mvp_button--quiet', disabled: editingLocked || noReasoning,
            'aria-expanded': confirmation === 'reference',
            'aria-controls': referencePanel,
            onClick: () => setConfirmation('reference'),
            title: t('override.useReferenceTitle'),
          }, t('override.useReference')),
          h('div', { id: referencePanel, hidden: confirmation !== 'reference' }, confirmation === 'reference' ? h(
            'div', { role: 'group', 'aria-label': t('override.referencePreview') },
            h('div', { ref: confirmationPreview, tabIndex: -1, className: 'mvp_editorTitle' }, t('override.referencePreview')),
            h('div', { className: 'mvp_fieldLabel' }, t('override.referenceSource', { source: sourceLabel })),
            h('div', null, t('override.referenceLevels', { levels: levelsOf(suggested) })),
            h('div', null, t('override.referenceDraft', { levels: levelsOf(referenceDraft) })),
            skippedReference.length > 0 ? h('div', null, t('override.referenceLimit', { levels: levelsOf(skippedReference) })) : null,
            referenceFallbacks.length > 0 ? h('div', null, t('override.referenceFallbacks', { levels: referenceFallbacks.join(' / ') })) : null,
            caution(!canReferencePrefill ? 'override.referenceOldHost' : canSuggestStandard ? 'override.referenceStandardScope' : 'override.referenceManualScope'),
            h('div', { className: 'mvp_editorActions' },
              h('button', { type: 'button', className: 'mvp_button', onClick: closeConfirmation }, t('override.cancelReference')),
              h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: locked || noReasoning || includedReference.length === 0, onClick: applyReference }, t('override.confirmReference')),
            ),
          ) : null),
          h('div', { role: 'status', className: 'mvp_editorNote' }, referenceApplied ? t('override.referenceApplied') : ''),
        ) : null,
        h(
          'div',
          { className: 'mvp_chips' },
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_chip',
              'aria-pressed': noReasoning,
              disabled: editingLocked,
              onClick: () => { setNoReasoning((value) => !value); setStandardEffort(false) },
            },
            t('tag.noReasoning'),
          ),
          availableEfforts.map((id) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                className: 'mvp_chip',
                'aria-pressed': !noReasoning && efforts.has(id),
                disabled: editingLocked || noReasoning,
                onClick: () => { toggleIn(setEfforts, id); setStandardEffort(false) },
              },
              effortLabel(id, t),
            ),
          ),
        ),
      ),
      !noReasoning && (efforts.size > 0 || defaultEffort !== '')
        ? h(
            'label',
            { className: 'mvp_field' },
            h('span', { className: 'mvp_fieldLabel' }, t('override.defaultEffort')),
            h(
              'select',
              {
                className: 'mvp_select',
                value: selectedDefault,
                disabled: editingLocked,
                'aria-label': t('override.defaultEffort'),
                onChange: (event) => setDefaultEffort(event.target.value),
              },
              defaultOptions.map(([value, label]) => h('option', { key: value, value }, label)),
            ),
          )
        : null,
      canMap && (providerRequested || (referenceApplied && canSuggestStandard)) && !noReasoning && selectedEfforts.some((id) => OVERRIDE_EFFORTS.includes(id))
        ? h(
            'div',
            { className: 'mvp_field mvp_field--wide' },
            h('div', { className: 'mvp_fieldLabel' }, t('override.wireTitle')),
            h('div', { className: 'mvp_editorNote' }, t('override.wireHint')),
            h('div', { className: 'mvp_chips' }, selectedEfforts.filter((id) => OVERRIDE_EFFORTS.includes(id)).map((id) => {
              const label = t('override.wireValue', { level: effortLabel(id, t) })
              return h('label', { className: 'mvp_field', key: id },
                h('span', { className: 'mvp_fieldLabel' }, label),
                h('input', {
                  className: 'mvp_number', type: 'text', 'aria-label': label,
                  value: wireValues[id] ?? '', maxLength: 128,
                  placeholder: referenceApplied && canSuggestStandard && isStandardChoice(id)
                    ? t('override.referenceWireBlank', { value: id }) : t('override.wireKeep'),
                  disabled: editingLocked || !providerRequested || (id === 'off' && omitOff),
                  onChange: (event) => {
                    const value = event.target.value
                    setWireValues((previous) => ({ ...previous, [id]: value }))
                    if (!referenceApplied) setStandardEffort(false)
                  },
                }),
              )
            })),
            efforts.has('off') ? h('label', { className: 'mvp_check' },
              h('input', { type: 'checkbox', checked: omitOff, disabled: editingLocked || !providerRequested, onChange: (event) => { setOmitOff(event.target.checked); if (!referenceApplied) setStandardEffort(false) } }),
              t('override.wireOff'),
            ) : null,
          )
        : null,
      h(
        'div',
        { className: 'mvp_field mvp_field--wide' },
        h(
          'label',
          { className: 'mvp_check' },
          h('input', {
            type: 'checkbox',
            checked: providerRequested,
            disabled: editingLocked || !providerAllowed,
            onChange: (event) => { setApplyToProvider(event.target.checked); setStandardEffort(false) },
          }),
          h('span', null, t('override.provider')),
        ),
        h('div', { className: 'mvp_editorNote' }, t('override.providerHint')),
        !providerAllowed ? h('div', { className: 'mvp_editorNote' }, t('override.referenceOldHost')) : null,
        standardAvailable && providerRequested ? h('label', { className: 'mvp_check' },
          h('input', { type: 'checkbox', checked: standardEffort, disabled: editingLocked,
            onChange: (event) => setStandardEffort(event.target.checked) }),
          h('span', null, t('override.standardWire')),
        ) : null,
        hasStandard && hasStandardChoices && providerRequested
          ? h('div', { className: 'mvp_editorNote' }, t(standardAvailable ? 'override.standardWireHint' : 'override.standardWireUnavailable')) : null,
      ),
    ),
    stale || error !== null
      ? h('div', { className: 'mvp_editorError', role: 'alert' }, stale ? t('override.conflict') : error) : null,
    h(
      'div',
      { className: 'mvp_editorFooter' },
      h('div', { className: 'mvp_editorNote' }, t('override.effortHint')),
      h('div', { id: providerPanel, className: 'mvp_field--wide', hidden: confirmation !== 'provider' }, confirmation === 'provider' ? h(
        'div', { role: 'group', 'aria-label': t('override.providerConfirmTitle') },
        h('div', { ref: confirmationPreview, tabIndex: -1, className: 'mvp_editorTitle' }, t('override.providerConfirmTitle')),
        h('div', null, t('override.providerTarget', { provider: entry.provider, model: entry.model })),
        context.trim() !== '' ? h('div', null, t('override.providerContext', { value: Number(context) })) : null,
        input.size > 0 ? h('div', null, t('override.providerInput', { value: [...input].map((id) => modalityLabel(id, t)).join(' / ') })) : null,
        !noReasoning && selectedEfforts.length > 0 ? h('div', null, t('override.referenceDraft', { levels: levelsOf(selectedEfforts) })) : null,
        noReasoning ? h('div', null, t('override.providerDisableReasoning')) : null,
        !noReasoning && canMap && Object.keys(mappings).length > 0 ? h('div', null, t('override.providerMappings', {
          values: Object.entries(mappings).map(([id, wire]) => `${effortLabel(id, t)} → ${wire ?? t('override.providerOmit')}`).join(' / '),
        })) : null,
        !noReasoning && selectedDefault !== '' ? h('div', null, t('override.providerLocalDefault', { value: effortLabel(selectedDefault, t) })) : null,
        providerFallbacks.length > 0 ? h('div', null, t('override.referenceFallbacks', { levels: providerFallbacks.join(' / ') })) : null,
        standardAvailable && standardEffort ? h('div', null, t('override.providerStandardEnable')) : null,
        caution('override.referenceProviderScope'),
        h('div', { className: 'mvp_editorActions' },
          h('button', { type: 'button', className: 'mvp_button', onClick: closeConfirmation }, t('override.backToDraft')),
          h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: locked || !providerRequested, onClick: () => save(true) }, t('override.confirmProviderSave')),
        ),
      ) : null),
      h(
        'div',
        { className: 'mvp_editorActions' },
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_button',
            disabled: editingLocked || !hasOverride,
            title: t('override.resetTitle'),
            onClick: resetToAuto,
          },
          t('override.reset'),
        ),
        h(
          'button',
          { type: 'button', className: 'mvp_button', disabled: busy || confirmation !== null, onClick: onClose },
          t('override.cancel'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_button mvp_button--accent',
            ref: saveButton,
            disabled: editingLocked,
            'aria-expanded': referenceApplied && providerRequested ? confirmation === 'provider' : undefined,
            'aria-controls': referenceApplied && providerRequested ? providerPanel : undefined,
            onClick: () => save(),
          },
          busy ? t('override.saving') : saveLabel,
        ),
      ),
    ),
  )
    }

export { ModelOverrideEditor, providerWriteNote }

