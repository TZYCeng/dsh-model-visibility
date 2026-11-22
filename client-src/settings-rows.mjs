const React = require('react')
const h = React.createElement

import { kindOf, isGenerationKind } from './format.mjs'
import { capabilityTags, tagClassOf } from './tags.mjs'

// URLs are links only when the user opens evidence and follows them. Never render remote media or follow list values automatically.
function evidenceUrls(fact) {
  const urls = new Set()
  for (const text of Array.isArray(fact?.urls) ? fact.urls.slice(0, 4) : []) {
    if (typeof text !== 'string' || text.length > 2048) continue
    try {
      const url = new URL(text)
      if (url.protocol === 'https:' && !url.username && !url.password) urls.add(url.href)
    } catch { /* a malformed citation remains unlinked */ }
  }
  return [...urls]
}

/** Keep field provenance keyboard/touch accessible without making every tag a tab stop. */
function ModelRowsFacts({ model, t, onClose }) {
  const tags = capabilityTags(model, t)
  return h('div', { className: 'mvp_facts' },
    h('ul', null, tags.map((tag) => {
      const urls = evidenceUrls(model.fieldEvidence?.[tag.evidenceField])
      return h('li', { key: tag.key }, h('strong', null, tag.label), tag.title ? ' — ' + tag.title : '',
        urls.length ? h('div', { className: 'mvp_sourcesLinks' }, urls.map((url) => h('a', { key: url, href: url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, url))) : null)
    })),
    h('button', { type: 'button', className: 'mvp_button mvp_button--quiet', onClick: onClose }, t('row.closeFacts')),
  )
}

/** Return host elements (not an intermediate component) so the page can interleave its single keyed editor with these rows. */
function modelRow({ model, group, rowId, shown, isEditing, canOpenEditor, exposeEditor, disabled, editDisabled, edit, toggle, facts, showFacts, editorId, t }) {
  const tags = capabilityTags(model, t)
  const kind = kindOf(model)
  const tinted = ['image', 'video', 'embedding', 'rerank', 'audio', 'classifier', 'translation'].includes(kind)
  return h('div', { key: 'row:' + rowId, className: 'mvp_modelBlock' },
    h('div', { className: 'mvp_row' + (isGenerationKind(kind) ? ' mvp_row--gen' : '') + (shown ? '' : ' mvp_row--off') + (tinted ? ' mvp_row--kind-' + kind : '') },
      h('div', { className: 'mvp_rowText' },
        h('div', { className: 'mvp_rowHead' },
          h('span', { className: 'mvp_rowTitle' }, model.name || model.id), model.id !== model.name && model.name ? h('span', { className: 'mvp_rowMeta' }, model.id) : null,
          !shown ? h('span', { className: 'mvp_visibilityLabel' }, t('page.visibility.disabled')) : null,
        ),
        h('div', { className: 'mvp_tags' }, tags.map((tag) => h('span', { key: tag.key, className: tagClassOf(tag), title: tag.title || undefined }, tag.label)),
          h('button', { type: 'button', className: 'mvp_factsButton', 'aria-label': t('row.factsNamed', { name: model.name || model.id }), 'aria-expanded': facts,
            onClick: () => showFacts(!facts) }, t('row.facts')),
        ),
      ),
      h('div', { className: 'mvp_rowActions' },
        exposeEditor ? h('button', { type: 'button', className: 'mvp_button mvp_editButton', 'aria-expanded': isEditing,
          'aria-controls': isEditing ? editorId : undefined, 'aria-label': t('row.edit') + ': ' + (model.name || model.id),
          title: t(canOpenEditor || isEditing ? 'row.editTitle' : 'override.listNotReady'), disabled: editDisabled || (!canOpenEditor && !isEditing), onClick: edit,
        }, t('row.edit')) : null,
        h('button', { type: 'button', role: 'switch', className: 'mvp_switch', 'aria-checked': shown, disabled,
          'aria-label': t('row.visibilityNamed', { provider: group.name || group.id, name: model.name || model.id }), onClick: toggle }, h('span', { className: 'mvp_thumb' })),
      ),
    ),
    facts ? h(ModelRowsFacts, { model, t, onClose: () => showFacts(false) }) : null,
  )
}

export { modelRow }
