const React = require('react')
const h = React.createElement

/** Native modal: focus is confined by the browser; Escape cancels without issuing a mutation. */
function SettingsConfirm({ title, description, changed, confirmLabel, cancelLabel, onCancel, onConfirm, targets, targetLabel, disabled }) {
  const dialog = React.useRef(null)
  const cancel = React.useRef(null)
  const headingId = React.useId()
  const descId = React.useId()
  React.useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (!node.open) node.showModal()
    cancel.current?.focus()
    return () => { if (node.open) node.close() }
  }, [])
  return h('dialog', { className: 'mvp_dialog', ref: dialog, 'aria-labelledby': headingId, 'aria-describedby': descId,
    onCancel: (event) => { event.preventDefault(); onCancel() },
  }, h('h3', { className: 'mvp_dialogTitle', id: headingId }, title),
  h('p', { id: descId }, description),
  targets?.length > 0 ? h('details', { className: 'mvp_details' }, h('summary', null, targetLabel),
    h('ul', { className: 'mvp_targetList' }, targets.map(({ provider, model }) => h('li', { key: JSON.stringify([provider, model]) }, provider + ' / ' + model))),
  ) : null,
  changed ? h('p', { className: 'mvp_editorError', role: 'alert' }, changed) : null,
  h('div', { className: 'mvp_editorActions' },
    h('button', { type: 'button', className: 'mvp_button', ref: cancel, onClick: onCancel }, cancelLabel),
    h('button', { type: 'button', className: 'mvp_button mvp_button--accent', disabled: disabled || Boolean(changed), onClick: onConfirm }, confirmLabel),
  ))
}

export { SettingsConfirm }
