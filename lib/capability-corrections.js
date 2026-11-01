/**
 * Curated corrections for facts the bundled catalog gets wrong.
 *
 * The pi-ai / models.dev snapshot is a snapshot: vendor model names collide
 * (`glm-5.3` is a text-only flagship while `glm-5.3-flash` is the multimodal
 * one), and an entry can be attributed to the wrong provider family.  A wrong
 * row that says "multimodal" is worse than an unknown one: the composer would
 * offer image input for a model that rejects it, and the request would fail
 * upstream.
 *
 * Corrections are deliberately tiny, keyed by normalized model id and labelled
 * `official` in the UI, with the documentation URL kept for the tooltip. They
 * only replace `catalog` / `inferred` / `unknown` evidence — an explicit
 * provider declaration or a relay listing still wins, because that is the
 * user's own routing configuration.
 *
 * Add an entry only when a primary source (the vendor's model documentation)
 * contradicts the snapshot. Never guess from a model name here.
 *
 * @module lib/capability-corrections
 */

import { modelIdVariants } from './capability-catalog.js'

/**
 * Corrected facts keyed by the normalized catalog id.
 *
 * Shape:
 *   `input`   — exact input modalities the vendor documents.
 *   `code`    — dictionary key under `correction.*` for the localized note.
 *   `note`    — English fallback when the dictionary has no key (diagnostics).
 *   `source`  — canonical documentation URL, shown in the tooltip.
 */
export const CORRECTIONS = Object.freeze({
  'glm-5.3': Object.freeze({
    input: Object.freeze(['text']),
    code: 'glm-5.3-text-only',
    note: 'GLM-5.3 accepts text only; the multimodal variant is GLM-5.3-Flash / FlashX.',
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
  }),
})

/** Normalized-id index over {@link CORRECTIONS}. */
const INDEX = (() => {
  const index = new Map()
  for (const [id, correction] of Object.entries(CORRECTIONS)) {
    for (const variant of modelIdVariants(id)) {
      if (!index.has(variant)) index.set(variant, { id, ...correction })
    }
  }
  return index
})()

/**
 * Find the curated correction for one model id.
 * @param value - model id as any provider spells it.
 * @returns `{ id, input, code, note, source }` or undefined.
 */
export function lookupCorrection(value) {
  for (const variant of modelIdVariants(value)) {
    const found = INDEX.get(variant)
    if (found !== undefined) return found
  }
  return undefined
}
