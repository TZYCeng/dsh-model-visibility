/** Pure parsers and matching helpers for public model catalogs.
 * @module lib/public-catalog
 */

import { normalizeModalities, readModelEntry } from './provider-probe.js'
import { MODEL_KINDS } from './capability-catalog.js'
import { modelIdVariants } from './model-id.js'

/**
 * Public catalog endpoints, fetched without credentials.
 *
 * models.dev publishes three shapes and the plugin used to read only the first
 * one through a parser that also silently ignored the other two:
 *
 *   api.json      `{ <provider>: { models: { <id>: … } } }`   (provider-qualified)
 *   models.json   `{ <id>: { modalities, limit, … } }`        (provider-free)
 *   catalog.json  `{ providers: {…}, models: {…} }`           (both, merged)
 *
 * `api.json` is ~6 MB and only lists models a *specific provider* serves, so a
 * relay model such as `glm-5.3` may be absent from it while being present in
 * `models.json`. Reading the provider-free endpoint first is both cheaper and
 * a better match for what a relay actually serves.
 *
 * Hugging Face publishes the open-weight side of the same story: something
 * self-hosted through vLLM / LM Studio / Ollama is usually NOT in models.dev
 * at all, but it always has a Hub card that names its pipeline and library.
 */
export const PUBLIC_SOURCES = {
  /** Provider-free model metadata; the best match for a relay's model ids. */
  modelsDevModels: 'https://models.dev/models.json',
  /** Provider-qualified catalog; used as a second pass for anything missing. */
  modelsDevApi: 'https://models.dev/api.json',
  openRouter: 'https://openrouter.ai/api/v1/models',
}

/**
 * Hugging Face Hub model listing, tried in order until one answers.
 *
 * `huggingface.co` is frequently unreachable from mainland China, so the two
 * well-known read-only mirrors come next. All three serve the same
 * `/api/models` contract; only the host differs. The list is ordered by
 * reliability for this audience, not by preference for the canonical host.
 */
export const HUGGING_FACE_HOSTS = [
  'https://huggingface.co',
  'https://hf-mirror.com',
  'https://hugging-face.cn',
]

/** Build one Hub listing URL for a host. */
export function huggingFaceUrl(host) {
  return (
    `${String(host).replace(/\/+$/, '')}/api/models?filter=text-generation&limit=1000` +
    '&expand[]=pipeline_tag&expand[]=library_name&expand[]=tags'
  )
}

/**
 * Refuse a public catalog larger than this.
 *
 * The models.dev payload is ~6 MB today and the relay probe already caps its
 * own responses at 4 MB; buffering an unbounded body here would let a redirect
 * target or a bad day on the CDN exhaust the Host heap.
 */
export const PUBLIC_BODY_LIMIT = 16 * 1024 * 1024

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read one string list, keeping only strings (duplicates preserved by caller). */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : undefined
}

/**
 * Convert one models.dev model record into a fact entry.
 *
 * Shared by every models.dev shape: the per-model record is identical whether
 * it arrived through `api.json`, `models.json` or `catalog.json`.
 * @param id - the key the record was stored under.
 * @param raw - the record.
 * @returns a detached fact, or undefined when nothing useful is present.
 */
export function readModelsDevRecord(id, raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const recordId = nonEmpty(raw.id) ?? id
  if (recordId === undefined) return undefined
  const modalities = raw.modalities !== null && typeof raw.modalities === 'object' ? raw.modalities : undefined
  const limit = raw.limit !== null && typeof raw.limit === 'object' ? raw.limit : undefined
  const fact = {
    id: recordId,
    ...(nonEmpty(raw.name) !== undefined ? { name: raw.name.trim() } : {}),
    ...(stringList(modalities?.input) !== undefined ? { input: stringList(modalities.input) } : {}),
    ...(stringList(modalities?.output) !== undefined ? { output: stringList(modalities.output) } : {}),
    // `attachment` is models.dev's "accepts file/image attachments" flag; it is
    // the closest analogue to an input modality list when modalities are absent.
    ...(typeof raw.attachment === 'boolean' && stringList(modalities?.input) === undefined
      ? { attachment: raw.attachment }
      : {}),
    ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    ...(Number.isSafeInteger(limit?.context) && limit.context > 0 ? { contextWindow: limit.context } : {}),
    ...(Number.isSafeInteger(limit?.output) && limit.output > 0 ? { maxTokens: limit.output } : {}),
  }
  // `id` alone is not a fact: require at least one capability field.
  return Object.keys(fact).length > 1 ? fact : undefined
}

/**
 * Parse any models.dev endpoint into a fact map.
 *
 * Accepts all three published shapes, plus a bare `{ <id>: record }` map. The
 * old parser only understood `api.json`, so pointing it at `models.json` or
 * `catalog.json` silently produced zero facts — which is what made the verify
 * sweep look like "the public catalogs returned no model data".
 * @param body - parsed JSON of the endpoint.
 * @returns Map of variant id → fact `{ id, name?, input?, output?, reasoning?,
 *   attachment?, contextWindow?, maxTokens? }`.
 */
export function readModelsDev(body) {
  const out = new Map()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return out
  const push = (id, fact) => {
    if (fact === undefined) return
    for (const variant of modelIdVariants(id)) {
      if (!out.has(variant)) out.set(variant, fact)
    }
  }
  /** Collect a `{ <id>: record }` dict. */
  const collectRecords = (models) => {
    if (models === null || typeof models !== 'object' || Array.isArray(models)) return
    for (const [key, raw] of Object.entries(models)) {
      push(key, readModelsDevRecord(key, raw))
    }
  }

  // catalog.json: { providers, models }
  if (body.models !== null && typeof body.models === 'object' && !Array.isArray(body.models)) {
    collectRecords(body.models)
  }
  if (body.providers !== null && typeof body.providers === 'object' && !Array.isArray(body.providers)) {
    for (const provider of Object.values(body.providers)) {
      if (provider === null || typeof provider !== 'object') continue
      collectRecords(provider.models)
    }
  }

  // api.json: { <providerId>: { models } }  — and it also carries `models` at the
  // top level for some deployments, which the branch above already consumed.
  for (const [key, value] of Object.entries(body)) {
    if (key === 'providers' || key === 'models') continue
    if (value === null || typeof value !== 'object') continue
    const models = value.models
    if (models === null || typeof models !== 'object') continue
    collectRecords(models)
  }

  // models.json: { <id>: record }  — a bare record map with no wrapper.
  for (const [key, value] of Object.entries(body)) {
    if (key === 'providers' || key === 'models') continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (value.models !== undefined) continue
    // Only treat it as a record when it looks like one.
    if (value.limit === undefined && value.modalities === undefined && value.reasoning === undefined) continue
    push(key, readModelsDevRecord(key, value))
  }
  return out
}

/**
 * Parse OpenRouter's public listing using the relay dialect reader.
 * @param body - parsed JSON.
 * @returns Map of variant id → relay fact entry.
 */
export function readOpenRouter(body) {
  const out = new Map()
  const listed = body !== null && typeof body === 'object' && Array.isArray(body.data) ? body.data : []
  for (const raw of listed) {
    const entry = readModelEntry(raw)
    if (entry === undefined) continue
    for (const variant of modelIdVariants(entry.id)) {
      if (!out.has(variant)) out.set(variant, entry)
    }
  }
  return out
}

/**
 * Map a Hugging Face `pipeline_tag` to a model kind.
 * @param tag - the Hub pipeline tag, e.g. `text-generation`.
 * @returns a MODEL_KINDS value, or undefined when the task is unknown.
 */
export function kindOfPipelineTag(tag) {
  if (typeof tag !== 'string' || tag === '') return undefined
  const id = tag.toLowerCase()
  if (id === 'text-generation' || id === 'text2text-generation' || id === 'conversational') return 'chat'
  if (id.startsWith('image-') || id === 'text-to-image' || id === 'unconditional-image-generation') return 'image'
  if (id.startsWith('video-') || id === 'text-to-video') return 'video'
  if (id === 'feature-extraction' || id === 'sentence-similarity') return 'embedding'
  if (id === 'text-classification' || id === 'zero-shot-classification') return 'classifier'
  if (id.startsWith('audio') || id === 'text-to-speech' || id === 'automatic-speech-recognition') return 'audio'
  if (id === 'translation') return 'translation'
  if (id === 'reranking' || id === 'text-ranking') return 'rerank'
  return undefined
}

/**
 * Read Hugging Face's model list into a fact map.
 *
 * The Hub tells us a model's task and library, not its context window or
 * reasoning ladder. It is still the only source for weights that a relay
 * serves under the checkpoint's own name (`Qwen/Qwen3.5-9B`, `unsloth/…`),
 * which no hosted catalog lists.
 *
 * Only a small, high-signal tag set is translated: Hub tags are free-form and
 * an unknown tag must not turn into a capability claim.
 * @param body - parsed JSON array of Hub model entries.
 * @returns Map of variant id → fact `{ id, name?, kind?, reasoning?, toolCall? }`.
 */
export function readHuggingFace(body) {
  const out = new Map()
  const listed = Array.isArray(body) ? body : Array.isArray(body?.models) ? body.models : []
  for (const raw of listed) {
    if (raw === null || typeof raw !== 'object') continue
    const id = nonEmpty(raw.id) ?? nonEmpty(raw.modelId)
    if (id === undefined) continue
    const tags = stringList(raw.tags) ?? []
    const lowerTags = tags.map((tag) => tag.toLowerCase())
    const kind = kindOfPipelineTag(raw.pipeline_tag)
    const fact = {
      id,
      ...(nonEmpty(raw.name) !== undefined ? { name: raw.name.trim() } : {}),
      ...(kind === undefined ? {} : { kind }),
      // A Hub tag is a declaration by the model publisher, so it counts.
      ...(lowerTags.includes('reasoning') ? { reasoning: true } : {}),
      ...(lowerTags.includes('tool-use') || lowerTags.includes('function-calling')
        ? { toolCall: true }
        : {}),
      ...(nonEmpty(raw.library_name) !== undefined ? { library: raw.library_name.trim() } : {}),
    }
    if (Object.keys(fact).length <= 1) continue
    for (const variant of modelIdVariants(id)) {
      if (!out.has(variant)) out.set(variant, fact)
    }
    // A checkpoint is often served under its bare name: `Qwen/Qwen3.5-9B`
    // is reached as `Qwen3.5-9B`, which `modelIdVariants` already covers.
  }
  return out
}

/** Merge public sources; earlier sources win, later ones fill only gaps. */
export function mergePublicSources(...maps) {
  const merged = new Map()
  for (const map of maps) {
    for (const [variant, fact] of map) {
      const current = merged.get(variant)
      if (current === undefined) merged.set(variant, fact)
      else {
        const next = { ...current }
        for (const [key, value] of Object.entries(fact)) {
          if (value === undefined || value === null) continue
          if (next[key] === undefined || next[key] === null) next[key] = value
        }
        merged.set(variant, next)
      }
    }
  }
  return merged
}

/**
 * Translate one public catalog row into the fact vocabulary the store uses.
 *
 * Shared by {@link parseCheckerAnswer} and {@link publicOnlyFacts} so a fact
 * means the same thing whichever path produced it.
 * @param publicFact - one merged public catalog entry.
 * @returns a partial fact; empty when the row declared nothing usable.
 */
export function publicFactToCapability(publicFact) {
  if (publicFact === null || publicFact === undefined || typeof publicFact !== 'object') return {}
  const fact = {}
  const type = nonEmpty(publicFact.kind) ?? nonEmpty(publicFact.type)
  if (type !== undefined && MODEL_KINDS.includes(type)) fact.type = type
  // `input` is the models.dev / OpenRouter spelling; `inputModalities` is the
  // relay dialect spelling.
  const input = normalizeModalities(publicFact.input ?? publicFact.inputModalities)
  if (input !== undefined) fact.input = input
  const output = normalizeModalities(publicFact.output ?? publicFact.outputModalities)
  if (output !== undefined) fact.output = output
  if (Number.isSafeInteger(publicFact.contextWindow) && publicFact.contextWindow > 0) {
    fact.contextWindow = publicFact.contextWindow
  }
  if (Number.isSafeInteger(publicFact.maxTokens) && publicFact.maxTokens > 0) {
    fact.maxTokens = publicFact.maxTokens
  }
  if (typeof publicFact.reasoning === 'boolean') fact.reasoning = publicFact.reasoning
  return fact
}

/** Look one model up in the merged public catalog by every id variant. */
export function lookupPublicFact(publicFacts, id) {
  if (publicFacts === undefined || publicFacts === null) return undefined
  if (!(publicFacts instanceof Map)) return publicFacts
  for (const variant of modelIdVariants(id)) {
    const found = publicFacts.get(variant)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Build facts for models the checker never answered.
 *
 * A public catalog hit is a real fact even when the checker skipped the model
 * (it said "unknown", or the batch failed). Emitting these separately keeps
 * `origins` honest: they are `['public']`, not `['public','checker']`.
 * @param ids - batch ids.
 * @param answered - ids the checker actually produced a verdict for.
 * @param publicFacts - the merged public catalog.
 * @returns array of `{ id, fact, origins }` for the un-answered ones.
 */
export function publicOnlyFacts(ids, answered, publicFacts) {
  if (publicFacts === undefined || publicFacts === null) return []
  const done = new Set((answered ?? []).map((id) => String(id).toLowerCase()))
  const out = []
  for (const id of ids) {
    if (done.has(String(id).toLowerCase())) continue
    const fields = publicFactToCapability(lookupPublicFact(publicFacts, id))
    if (Object.keys(fields).length === 0) continue
    out.push({ id, fact: { id, ...fields }, origins: ['public'] })
  }
  return out
}
