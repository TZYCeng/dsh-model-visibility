/**
 * Model-id normalization shared by every matching layer.
 *
 * Split out of `capability-catalog.js` so the relay aggregator rules stay in
 * one place after the bundled static catalog was replaced by the learned
 * local snapshot (`lib/learned-catalog.js`).
 *
 * Relays spell ids slightly differently than the canonical model name: an
 * aggregator namespaces them (`openai/gpt-4o`), request suffixes are stacked
 * (`glm-5.3:free:batch`), a leading `~` marks a route prefix, and resolution
 * twins exist (`gpt-5.1` vs `gpt-5-1`). `modelIdVariants` deliberately stays
 * conservative — over-folding would merge two real models — but the first
 * variant always matches the canonical catalog row.
 *
 * @module lib/model-id
 */

/** Strip aggregator namespaces, request suffixes and resolution variants. */
export function normalizeModelId(value) {
  let id = String(value ?? '').trim().toLowerCase()
  if (id === '') return ''
  id = id.replace(/^~/, '')
  // Providers may stack request variants (for example `:free:thinking`).
  // Strip them one at a time so aliases remain stable without broad folding.
  let previous
  do {
    previous = id
    id = id.replace(/:(batch|free|extended|thinking|online|nitro)$/, '')
    id = id.replace(/-(free|batch)$/, '')
  } while (id !== previous)
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  id = id.replace(/^(global|us|eu|apac|jp|au|ca)\./, '')
  id = id.replace(/^(anthropic|openai|google|xai|x-ai|meta|mistralai|moonshotai|minimax|nvidia|qwen|z-ai|zai|deepseek|bytedance-seed)\./, '')
  return id
}

/** Lookup keys for one model id, most specific first. */
export function modelIdVariants(value) {
  const base = normalizeModelId(value)
  if (base === '') return []
  const variants = [base]
  const withoutResolution = base.replace(/-(4k|2k|8k|hd|uhd)$/, '')
  if (withoutResolution !== base) variants.push(withoutResolution)
  const withoutSuffix = withoutResolution.replace(/-(latest|preview|new)$/, '')
  if (!variants.includes(withoutSuffix)) variants.push(withoutSuffix)
  const compact = base.replace(/[^a-z0-9]+/g, '')
  if (compact !== '' && !variants.includes(compact)) variants.push(compact)
  return variants
}
