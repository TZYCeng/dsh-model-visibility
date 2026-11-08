/**
 * Plugin entry: store wiring, facts inputs and effect registration.
 *
 * Assembled with the other modules by `scripts/build-client.mjs`; the bundle
 * factory returns `{ inject, apply }` exactly like the original single-file
 * bundle, but every subsystem now lives in its own module.
 */

const React = require('react')
const h = React.createElement

import { NS, ENTRY, SECTION_ID } from './constants.mjs'
import { DICT } from './dict.mjs'
import { CSS } from './css.mjs'
import { createCatalog, createOverrides, createUsageApi, createVerifyApi } from './catalog-store.mjs'
import { makeSection } from './settings-section.mjs'
import { installComposerFilter } from './composer-filter.mjs'

const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, DICT), 'model-visibility: dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-model-visibility'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'model-visibility: styles')

  const form = ctx.configForms.get(ENTRY)
  const catalog = createCatalog(ctx)
  const overrides = createOverrides()
  const usage = createUsageApi()
  const verify = createVerifyApi()

  ctx.effect(() => {
    const disposers = []
    disposers.push(
      ctx.on('connection/reset', () => {
        catalog.refresh()
        overrides.load()
        usage.refresh()
      }),
    )
    if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
      disposers.push(
        ctx.remote.$on('llm/adapters-updated', () => {
          catalog.refresh()
        }),
      )
      for (const event of [
        'settings/document-updated',
        'credentials/record-updated',
        'credentials/reference-updated',
      ]) {
        disposers.push(
          ctx.remote.$on(event, () => {
            catalog.load()
          }),
        )
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (_error) {
          // A source may already be gone during teardown.
        }
      }
    }
  }, 'model-visibility: catalog refresh')

  const Section = makeSection(form, catalog, overrides, usage, verify)
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 12,
            locale: NS,
            label: () => ctx.locale.bind(NS)('nav'),
          },
          Section,
        ),
      ),
    'model-visibility: settings section',
  )

  ctx.inject(['modelDirectories'], (scope) => {
    installComposerFilter(scope, form)
  })
}

export { inject, apply }
