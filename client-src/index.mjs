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
import { CHECKER_EN, CHECKER_ZH } from './checker-dict.mjs'
import { SUPPORT_DICT } from './support-dict.mjs'
import { CSS } from './css.mjs'
import { CHECKER_CSS } from './checker-style.mjs'
import { setClientTraceSession } from './diagnostic-events.mjs'
import { createCatalog, createOverrides, createUsageApi, createVerifyApi } from './catalog-store.mjs'
import { makeSection } from './settings-section.mjs'
import { installComposerFilter } from './composer-filter.mjs'

const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, {
    ...DICT, en: { ...DICT.en, ...CHECKER_EN, ...SUPPORT_DICT.en }, zh: { ...DICT.zh, ...CHECKER_ZH, ...SUPPORT_DICT.zh },
  }), 'model-visibility: dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-model-visibility'
    tag.textContent = CSS + CHECKER_CSS
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
        // Never flush buffered diagnostics into a different Host identity.
        setClientTraceSession(null)
        // A different Host may now own the same URL; discard previous capabilities,
        // receipts and in-flight reads/writes even when no page is observing.
        for (const store of [catalog, overrides, usage, verify, verify.bulk]) void store.invalidate({ reset: true })
      }),
    )
    if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
      for (const event of ['llm/adapters-updated', 'llm/models-updated']) {
        disposers.push(ctx.remote.$on(event, () => { void catalog.invalidate({ fresh: true }); void verify.bulk.invalidate() }))
      }
      for (const event of [
        'settings/document-updated',
        'credentials/record-updated',
        'credentials/reference-updated',
      ]) {
        disposers.push(
          ctx.remote.$on(event, () => {
            // Supersede a stale browser GET, but do not force new relay probes
            // for unrelated settings edits (for example a visibility toggle).
            void catalog.invalidate()
            if (event === 'settings/document-updated') void verify.bulk.invalidate()
          }),
        )
      }
    }
    return () => {
      setClientTraceSession(null)
      for (const store of [catalog, overrides, usage, verify]) store.dispose()
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
