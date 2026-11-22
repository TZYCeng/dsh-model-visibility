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
 * Corrections are deliberately tiny, keyed by exact model identity and labelled
 * `official` with the primary documentation URL. They outrank generic relay
 * listings and public/checker snapshots, but never an explicit route setting,
 * a trusted native adapter declaration, or the user's own annotation.
 *
 * Add an entry only when a primary source (the vendor's model documentation)
 * contradicts the snapshot. Never guess from a model name here.
 *
 * @module lib/capability-corrections
 */

import { exactModelIdentity } from './model-id.js'

/**
 * Corrected facts keyed by the vendor's exact, case-sensitive model leaf.
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

/** Recognized namespaces in which the vendor's correction applies. */
const VENDORS = { 'glm-5.3': ['z-ai', 'zai', 'zhipu', 'zhipuai'] }

/**
 * Find the curated correction for one model id.
 * @param value - model id as any provider spells it.
 * @returns `{ id, input, code, note, source }` or undefined.
 */
export function lookupCorrection(value) {
  const full = exactModelIdentity(value)
  if (!full || full !== value) return undefined
  const slash = full.lastIndexOf('/')
  const id = full.slice(slash + 1)
  if (!Object.hasOwn(CORRECTIONS, id) || (slash !== -1 && !VENDORS[id]?.includes(full.slice(0, slash)))) return undefined
  return { id, ...CORRECTIONS[id] }
}
