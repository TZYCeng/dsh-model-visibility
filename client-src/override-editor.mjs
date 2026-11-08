const React = require('react')
const h = React.createElement

import { modalityLabel, effortLabel, OVERRIDE_MODALITIES, OVERRIDE_EFFORTS } from './format.mjs'
function providerWriteNote(result, t) {
  if (result === null || typeof result !== 'object') return null
  if (result.written === true) {
    const fields = (Array.isArray(result.fields) ? result.fields : [])
      .map((field) => t('override.field.' + field))
      .join('、')
    return t('override.providerWritten', { fields })
  }
  if (result.reason === 'nothing' || result.reason === 'skipped') return null
  const label = t('override.reason.' + String(result.reason))
  return t('override.providerSkipped', {
    reason: label === 'override.reason.' + String(result.reason) ? String(result.reason) : label,
  })
}

function ModelOverrideEditor({ entry, name, t, overrides, onClose, onSaved }) {
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
  const [applyToProvider, setApplyToProvider] = React.useState(true)

  const toggleIn = (setter, id) => {
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const fail = (failure) => {
    setBusy(false)
    setError(
      t('override.failed', {
        message: String(failure && failure.message ? failure.message : failure),
      }),
    )
  }

  const save = () => {
    const payload = { provider: entry.provider, model: entry.model }
    if (kind !== '') payload.kind = kind
    if (context.trim() !== '') {
      const value = Number(context)
      if (!Number.isFinite(value) || value <= 0) {
        setError(t('override.contextInvalid'))
        return
      }
      payload.contextWindow = Math.round(value)
    }
    if (input.size > 0) {
      payload.input = OVERRIDE_MODALITIES.filter((id) => input.has(id))
    }
    if (noReasoning) {
      payload.reasoningSupported = false
    } else if (efforts.size > 0) {
      payload.efforts = OVERRIDE_EFFORTS.filter((id) => efforts.has(id)).map((id) => ({ id }))
      if (defaultEffort !== '' && efforts.has(defaultEffort)) {
        payload.defaultEffort = defaultEffort
      }
    }
    payload.applyToProvider = applyToProvider
    setBusy(true)
    setError(null)
    Promise.resolve(overrides.save(payload)).then(
      (result) => {
        setBusy(false)
        if (typeof onSaved === 'function') onSaved(result)
      },
      fail,
    )
  }

  const resetToAuto = () => {
    setBusy(true)
    setError(null)
    Promise.resolve(overrides.remove(entry.provider, entry.model)).then(
      () => {
        setBusy(false)
        if (typeof onSaved === 'function') onSaved()
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
    OVERRIDE_EFFORTS.filter((id) => efforts.has(id)).map((id) => [id, effortLabel(id, t)]),
  )
  const selectedDefault = efforts.has(defaultEffort) ? defaultEffort : ''

  return h(
    'div',
    { className: 'mvp_editor' },
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
          type: 'number',
          min: '1',
          step: '1',
          value: context,
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
                disabled: busy,
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
        h(
          'div',
          { className: 'mvp_chips' },
          h(
            'button',
            {
              type: 'button',
              className: 'mvp_chip',
              'aria-pressed': noReasoning,
              disabled: busy,
              onClick: () => setNoReasoning((value) => !value),
            },
            t('tag.noReasoning'),
          ),
          OVERRIDE_EFFORTS.map((id) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                className: 'mvp_chip',
                'aria-pressed': !noReasoning && efforts.has(id),
                disabled: busy || noReasoning,
                onClick: () => toggleIn(setEfforts, id),
              },
              effortLabel(id, t),
            ),
          ),
        ),
      ),
      !noReasoning && efforts.size > 0
        ? h(
            'label',
            { className: 'mvp_field' },
            h('span', { className: 'mvp_fieldLabel' }, t('override.defaultEffort')),
            h(
              'select',
              {
                className: 'mvp_select',
                value: selectedDefault,
                'aria-label': t('override.defaultEffort'),
                onChange: (event) => setDefaultEffort(event.target.value),
              },
              defaultOptions.map(([value, label]) => h('option', { key: value, value }, label)),
            ),
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
            checked: applyToProvider,
            disabled: busy,
            onChange: (event) => setApplyToProvider(event.target.checked),
          }),
          h('span', null, t('override.provider')),
        ),
        h('div', { className: 'mvp_editorNote' }, t('override.providerHint')),
      ),
    ),
    error !== null ? h('div', { className: 'mvp_editorError', role: 'alert' }, error) : null,
    h(
      'div',
      { className: 'mvp_editorFooter' },
      h('div', { className: 'mvp_editorNote' }, t('override.effortHint')),
      h(
        'div',
        { className: 'mvp_editorActions' },
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_button',
            disabled: busy,
            title: t('override.resetTitle'),
            onClick: resetToAuto,
          },
          t('override.reset'),
        ),
        h(
          'button',
          { type: 'button', className: 'mvp_button', disabled: busy, onClick: onClose },
          t('override.cancel'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mvp_button mvp_button--accent',
            disabled: busy,
            onClick: save,
          },
          t(busy ? 'override.saving' : 'override.save'),
        ),
      ),
    ),
  )
    }

export { ModelOverrideEditor, providerWriteNote }

