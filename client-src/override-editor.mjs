const React = require('react')
const h = React.createElement

import { modalityLabel, effortLabel, OVERRIDE_MODALITIES, OVERRIDE_EFFORTS } from './format.mjs'
import { clientTrace } from './diagnostic-events.mjs'

function toggleItem(set, item) {
  const next = new Set(set)
  if (next.has(item)) next.delete(item)
  else next.add(item)
  return next
}

function ModelOverrideEditor({
  id, entry, revision, hasOverride, blocked, stale, detached, missing, name, t, overrides, onClose, onSaved, onDirty,
  canDirect = false, canMap = false, canReferencePrefill = false, routeKind, referenceEfforts = [], referenceSource = '', referenceAlias = false,
}) {
  const [kind, setKind] = React.useState(entry.kind ?? '')
  const [context, setContext] = React.useState(entry.contextWindow === undefined ? '' : String(entry.contextWindow))
  const [input, setInput] = React.useState(() => new Set(entry.input ?? []))
  const [efforts, setEfforts] = React.useState(() => new Set((entry.efforts ?? []).map((effort) => effort.id)))
  const [noReasoning, setNoReasoning] = React.useState(entry.reasoningSupported === false)
  const [defaultEffort, setDefaultEffort] = React.useState(entry.defaultEffort ?? '')
  const [wireValues, setWireValues] = React.useState({})
  const [omitOff, setOmitOff] = React.useState(false)
  const [referenceApplied, setReferenceApplied] = React.useState(entry.referencePrefill === true)
  const [touched, setTouched] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [advanced, setAdvanced] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const saving = React.useRef(false)
  const title = React.useRef(null)
  const contextInput = React.useRef(null)
  const referenceButton = React.useRef(null)
  const previewHeading = React.useRef(null)
  const restoreReference = React.useRef(false)
  const titleId = React.useId()
  const previewId = React.useId()
  const advancedId = React.useId()
  const hintId = React.useId()

  // Focus only when opening the draft, never when a filter/collapse moves its row.
  React.useEffect(() => { title.current?.focus() }, [])
  React.useEffect(() => {
    if (preview) previewHeading.current?.focus()
    else if (restoreReference.current) {
      restoreReference.current = false
      referenceButton.current?.focus()
    }
  }, [preview])

  const dirty = () => {
    if (!touched) { setTouched(true); onDirty?.() }
    setError(null)
  }
  const selected = [...efforts]
  const provided = Array.isArray(referenceEfforts) ? referenceEfforts : []
  const suggested = (kind || routeKind) === 'chat' && routeKind === 'chat' && !noReasoning
    ? [...new Set(provided.map((item) => item?.id).filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)))] : []
  const standalone = !selected.length && defaultEffort ? [defaultEffort] : []
  const merged = [...new Set([...selected, ...standalone, ...suggested])].slice(0, 16)
  const skipped = suggested.filter((id) => !merged.includes(id))
  const levels = (ids) => ids.map((id) => effortLabel(id, t)).join(' / ')
  const selectedDefault = !efforts.size || efforts.has(defaultEffort) ? defaultEffort : ''
  const hasFields = Boolean(kind || context.trim() || input.size || noReasoning || selected.length || selectedDefault)
  // With an entirely blank *untouched* draft, the adjacent, visible levels are the explicit
  // one-click reference action. Never refill a ladder the user removed, or add it to an unrelated edit.
  const directReference = !hasOverride && !touched && !hasFields && suggested.length > 0 && canReferencePrefill
  const directAllowed = canDirect && (!referenceApplied || canReferencePrefill)
  const locked = busy || blocked || stale || missing
  const editingLocked = locked || preview
  const target = { provider: entry.provider, model: entry.model }
  const source = referenceSource || t('source.unknown')
  const sourceText = referenceAlias ? t('override.referenceAlias', { source }) : source
  const directLevels = directReference ? merged : selected
  const togglePreview = (open) => {
    if (!open) restoreReference.current = true
    setPreview(open)
  }
  const fillReference = () => {
    if (locked || !preview || !suggested.some((id) => merged.includes(id))) return
    dirty()
    setEfforts(new Set(merged)); setReferenceApplied(true); togglePreview(false)
    clientTrace('editor', 'reference', { status: 'draft', count: merged.length })
  }
  const fail = (failure, mode) => {
    if (failure?.status === 409) {
      setError(t('override.conflict'))
      void overrides.load()
    } else {
      setError(t(mode === 'provider' ? 'override.writeFailed' : 'override.failed', { message: String(failure?.message ?? failure) }))
    }
    clientTrace('editor', 'save', { status: failure?.status === 409 ? 'conflict' : 'failed' })
  }
  const submit = (mode) => {
    if (editingLocked || saving.current || (mode === 'reset' && !hasOverride)) return
    const direct = mode === 'provider'
    if (direct && (!directAllowed || (!hasFields && !directReference))) return
    const value = context.trim() ? Number(context) : undefined
    if (mode !== 'reset' && value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      setError(t('override.contextInvalid')); contextInput.current?.focus(); return
    }
    const payload = { ...target, applyToProvider: direct }
    const fields = []
    if (kind) { payload.kind = kind; fields.push('kind') }
    if (value !== undefined) { payload.contextWindow = value; fields.push('contextWindow') }
    if (input.size) { payload.input = [...input]; fields.push('input') }
    const ladder = direct ? directLevels : selected
    if (noReasoning) { payload.reasoningSupported = false; fields.push('reasoningEfforts') }
    else if (ladder.length) {
      payload.efforts = ladder.map((id) => ({ id })); fields.push('reasoningEfforts')
      if (direct && canMap) {
        const mappings = Object.fromEntries(ladder.filter((id) => OVERRIDE_EFFORTS.includes(id)).flatMap((id) => {
          if (id === 'off' && omitOff) return [[id, null]]
          const wire = wireValues[id]?.trim()
          return wire ? [[id, wire]] : []
        }))
        if (Object.keys(mappings).length) payload.reasoningEffortMappings = mappings
      }
    }
    if (!noReasoning && selectedDefault) { payload.defaultEffort = selectedDefault; fields.push('defaultEffort') }
    if (referenceApplied || (direct && directReference)) payload.referencePrefill = true
    if (direct) payload.directEffort = true
    saving.current = true; setBusy(true); setError(null)
    clientTrace('editor', 'submit', { status: mode, fields, count: ladder.length })
    const send = async () => {
      try {
        const result = mode === 'reset' ? await overrides.remove(entry.provider, entry.model, revision) : await overrides.save(payload, revision)
        clientTrace('editor', 'receipt', { status: !direct ? mode : result?.provider?.written === true ? 'written' : 'not-confirmed' })
        onSaved?.(result, { mode, fields })
      } catch (failure) { fail(failure, mode) }
      finally { saving.current = false; setBusy(false) }
    }
    void send()
  }

  const chip = (id, label, pressed, disabled, action) => h('button', {
    key: id, type: 'button', className: 'mvp_chip', 'aria-pressed': pressed, disabled, onClick: () => { dirty(); action() },
  }, label)
  const labelField = (label, control) => h('label', { className: 'mvp_field' }, h('span', { className: 'mvp_fieldLabel' }, label), control)
  const select = (label, value, options, setter) => h('select', {
    className: 'mvp_select', 'aria-label': t(label), value, disabled: editingLocked,
    onChange: (event) => { dirty(); setter(event.target.value) },
  }, options.map(([id, name]) => h('option', { key: id, value: id }, name)))
  const kinds = [['', t('override.kindAuto')], ...['chat', 'image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation']
    .map((id) => [id, id === 'chat' ? t('page.filter.chat') : t('tag.kind.' + id)])]
  const defaults = [['', t('override.defaultEffortAuto')], ...[...standalone, ...selected].map((id) => [id, effortLabel(id, t)])]
  const mappable = !noReasoning && directAllowed && canMap ? selected.filter((id) => OVERRIDE_EFFORTS.includes(id)) : []
  const hasMappings = mappable.some((id) => wireValues[id]?.trim() || (id === 'off' && omitOff))
  return h('section', { id, className: 'mvp_editor', 'aria-labelledby': titleId,
    onKeyDown: (event) => {
      if (event.key === 'Escape' && preview) { event.preventDefault(); event.stopPropagation(); togglePreview(false) }
    } },
    h('div', { className: 'mvp_editorHead' },
      h('h3', { className: 'mvp_editorTitle', id: titleId, ref: title, tabIndex: -1 }, t('override.title') + ' · ' + name),
      h('span', { className: 'mvp_rowMeta', title: entry.provider + ' / ' + entry.model }, entry.provider + ' / ' + entry.model),
    ),
    detached ? h('p', { className: 'mvp_editorNote' }, t('override.detached')) : null,
    missing ? h('p', { className: 'mvp_editorError', role: 'alert' }, t('override.missingRoute')) : null,
    h('div', { className: 'mvp_editorGrid' },
      h('fieldset', { className: 'mvp_field mvp_field--wide' },
        h('legend', { className: 'mvp_fieldLabel' }, t('override.efforts')),
        h('div', { className: 'mvp_chips' },
          [...new Set([...OVERRIDE_EFFORTS, ...selected])].map((id) => chip(id, effortLabel(id, t), !noReasoning && efforts.has(id),
            editingLocked || noReasoning || (!efforts.has(id) && efforts.size >= 16), () => setEfforts(toggleItem(efforts, id)))),
          chip('no-reasoning', t('tag.noReasoning'), noReasoning, editingLocked, () => setNoReasoning(!noReasoning)),
          suggested.length ? h('button', { ref: referenceButton, type: 'button', className: 'mvp_button mvp_button--quiet',
            disabled: editingLocked, 'aria-expanded': preview, 'aria-controls': previewId, title: t('override.useReferenceTitle'),
            onClick: () => togglePreview(true),
          }, t('override.useReference')) : null,
        ),
        h('div', { id: previewId, hidden: !preview }, preview ? h('div', { className: 'mvp_preview', role: 'group', 'aria-label': t('override.referencePreview') },
          h('div', { className: 'mvp_editorTitle', tabIndex: -1, ref: previewHeading }, t('override.referencePreview')),
          h('div', null, t('override.referenceSource', { source: sourceText })),
          h('div', null, t('override.referenceLevels', { levels: levels(suggested) })),
          h('div', null, t('override.referenceDraft', { levels: levels(merged) })),
          skipped.length ? h('div', null, t('override.referenceLimit', { levels: levels(skipped) })) : null,
          h('div', { className: 'mvp_editorActions' },
            h('button', { type: 'button', className: 'mvp_button', onClick: () => togglePreview(false) }, t('override.cancelReference')),
            h('button', { type: 'button', className: 'mvp_button mvp_button--accent',
              disabled: locked || !suggested.some((id) => merged.includes(id)), onClick: fillReference }, t('override.confirmReference')),
          ),
        ) : null),
        referenceApplied && !preview ? h('span', { className: 'mvp_editorNote', role: 'status' }, t('override.referenceApplied')) : null,
      ),
      !noReasoning && (selected.length || defaultEffort) ? labelField(t('override.defaultEffort'), select('override.defaultEffort', selectedDefault, defaults, setDefaultEffort)) : null,
      labelField(t('override.kind'), select('override.kind', kind, kinds, setKind)),
      labelField(t('override.context'), h('input', { className: 'mvp_number', type: 'number', min: '1', step: '1', ref: contextInput,
        'aria-label': t('override.context'), value: context, disabled: editingLocked, placeholder: t('override.contextPlaceholder'),
        onInput: (event) => { dirty(); setContext(event.target.value) },
      })),
      h('fieldset', { className: 'mvp_field mvp_field--wide' }, h('legend', { className: 'mvp_fieldLabel' }, t('override.input')),
        h('div', { className: 'mvp_chips' }, OVERRIDE_MODALITIES.map((id) => chip(id, modalityLabel(id, t), input.has(id), editingLocked, () => setInput(toggleItem(input, id))))),
      ),
    ),
    h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', 'aria-expanded': advanced, 'aria-controls': advancedId,
      onClick: () => setAdvanced(!advanced),
    }, t('override.writeDetails') + (hasMappings ? ' · ' + t('override.hasMapping') : '')),
    h('div', { id: advancedId, hidden: !advanced }, advanced ? h('div', { className: 'mvp_editorNote mvp_preview' },
      h('p', null, t('override.hint')), h('p', null, t('override.effortHint')),
      h('p', null, t('override.referencePreservation')), h('p', null, t('override.referenceRevert')),
      mappable.length ? h('fieldset', { className: 'mvp_field' }, h('legend', { className: 'mvp_fieldLabel' }, t('override.wireTitle')),
        h('p', null, t('override.wireHint')), h('div', { className: 'mvp_chips' }, mappable.map((id) => {
          const label = t('override.wireValue', { level: effortLabel(id, t) })
          return h('label', { className: 'mvp_field', key: id }, label,
            h('input', { type: 'text', className: 'mvp_number', 'aria-label': label, value: wireValues[id] ?? '', maxLength: 128,
              placeholder: t('override.wireKeep'), disabled: editingLocked || (id === 'off' && omitOff),
              onChange: (event) => { const value = event.target.value; dirty(); setWireValues((previous) => ({ ...previous, [id]: value })) },
            }),
          )
        })),
        efforts.has('off') ? h('label', { className: 'mvp_check' },
          h('input', { type: 'checkbox', checked: omitOff, disabled: editingLocked,
            onChange: (event) => { dirty(); setOmitOff(event.target.checked) } }), t('override.wireOff'),
        ) : null,
      ) : null,
    ) : null),
    stale || error ? h('div', { className: 'mvp_editorError', role: 'alert' }, stale ? t('override.conflict') : error) : null,
    h('div', { className: 'mvp_editorFooter' },
      h('div', { id: hintId, className: 'mvp_editorNote' },
        !directAllowed ? t('override.directOldHost') : directReference
          ? t('override.directReference', { levels: levels(merged) }) : t('override.directScope'),
        hasMappings ? h('div', null, t('override.mappingScope')) : null,
      ),
      h('div', { className: 'mvp_editorActions' },
        hasOverride ? h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', title: t('override.resetTitle'),
          disabled: editingLocked, onClick: () => submit('reset') }, t('override.reset')) : null,
        h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', disabled: busy || preview, onClick: onClose }, t('override.cancel')),
        h('button', { type: 'button', className: 'mvp_button', disabled: editingLocked || (!hasFields && !hasOverride),
          onClick: () => submit('local') }, t('override.saveLocal')),
        h('button', { type: 'button', className: 'mvp_button mvp_button--accent', 'aria-describedby': hintId,
          disabled: editingLocked || !directAllowed || (!hasFields && !directReference), onClick: () => submit('provider') }, t('override.saveProvider')),
        busy ? h('span', { className: 'mvp_editorNote', role: 'status' }, t('override.saving')) : null,
      ),
    ),
  )
}

export { ModelOverrideEditor }
