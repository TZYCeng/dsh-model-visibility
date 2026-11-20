/** Pure parsers and matching helpers for public model catalogs.
 * @module lib/public-catalog
 */

import { normalizeModalities, readModelEntry } from './provider-probe.js'
import { kindOfType } from './capability-catalog.js'
import { exactModelIdentity, modelIdParts, publicModelSearchKeyTiers, publicModelSearchVendor } from './model-id.js'
import { sanitizeEfforts } from './model-overrides.js'

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
  openRouter: 'https://openrouter.ai/api/v1/models?output_modalities=all',
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

const validFact = (fact) => fact !== null && typeof fact === 'object' && !Array.isArray(fact)
const validIndexedFact = (id, fact) => validFact(fact) && (fact.id === undefined || exactModelIdentity(fact.id) === id)

const indexes = new WeakMap()
const factlessIds = new WeakMap()

/** Index parser output once per generation, without caching arbitrary caller maps. */
class PublicRows extends Map {
  set(key, value) {
    indexes.delete(this)
    factlessIds.get(this)?.delete(key)
    return super.set(key, value)
  }

  delete(key) {
    indexes.delete(this)
    factlessIds.get(this)?.delete(key)
    return super.delete(key)
  }

  clear() {
    indexes.delete(this)
    factlessIds.delete(this)
    super.clear()
  }
}

function firstFact(out, id, fact, name) {
  if (id === undefined || out.has(id)) return
  if (fact !== undefined) {
    out.set(id, fact)
    return
  }
  // An advertised identity can veto a seemingly unique alias even when it
  // declares no capabilities. Don't count it as an ingested fact.
  let ids = factlessIds.get(out)
  if (ids === undefined) factlessIds.set(out, ids = new Map())
  ids.set(id, name ?? ids.get(id))
  indexes.delete(out)
}

/** Parse declared levels only, not generic support flags or parameter names. */
function explicitLadder(raw) {
  const result = {}
  if (raw.reasoning === false) return result
  const options = Array.isArray(raw.reasoning_options) ? raw.reasoning_options : []
  const optionGroups = options.filter(option => option?.type === 'effort' && Array.isArray(option.values))
  // Don't mix toggle/budget declarations into a discrete effort ladder or
  // combine distinct ladders from alternative request modes.
  const modelDev = optionGroups.length === 1 ? optionGroups[0].values : undefined
  const openRouter = validFact(raw.reasoning) ? raw.reasoning : undefined
  const levels = sanitizeEfforts(raw.reasoningEfforts ?? raw.reasoning_efforts ?? modelDev ?? openRouter?.supported_efforts)
  if (levels === undefined) return result
  const order = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const rank = id => order.includes(id) ? order.indexOf(id) : order.length
  result.reasoningEfforts = (modelDev || openRouter?.supported_efforts)
    ? levels.sort((a, b) => rank(a.id) - rank(b.id)) : levels
  const defaultEffort = nonEmpty(raw.defaultEffort ?? raw.default_effort ?? openRouter?.default_effort)?.toLowerCase()
  if (levels.some((item) => item.id === defaultEffort)) result.defaultEffort = defaultEffort
  return result
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
  // An absent type is normal for models.dev chat rows. Do not invent a type
  // from text output (the same output is also used on embedding models).
  const type = kindOfType(raw.type)
  const ladder = explicitLadder(raw)
  const fact = {
    id: recordId,
    ...(type === undefined ? {} : { type }),
    ...(exactModelIdentity(raw.canonical_model_id) !== undefined ? { canonicalModelId: exactModelIdentity(raw.canonical_model_id) } : {}),
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
    ...ladder,
    ...(ladder.reasoningEfforts ? { reasoningCatalog: 'models.dev' } : {}),
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
 * @returns Map of exact (possibly provider-qualified) id → capability fact.
 */
function addCanonicalReferences(rows) {
  const groups = new Map()
  for (const row of rows.values()) {
    const id = row.canonicalModelId
    if (!id?.includes('/') || rows.has(id)) continue
    let group = groups.get(id)
    if (!group) groups.set(id, group = [])
    group.push(publicFactToCapability(row))
  }
  for (const [id, group] of groups) {
    const consensus = {}
    for (const key of ['type', 'input', 'output', 'contextWindow', 'maxTokens', 'reasoning', 'reasoningEfforts']) {
      const values = group.map(row => row[key]).filter(value => value !== undefined)
      if (values.length && values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))) consensus[key] = values[0]
    }
    // Collapsing declared aliases must not union distinct route ladders or
    // invent a default. A real native record always beats this projection.
    if (Object.keys(consensus).length) rows.set(id, { id, ...consensus, canonicalReference: true })
  }
}

export function readModelsDev(body) {
  const out = new PublicRows()
  if (!validFact(body)) return out

  /** Preserve the catalog's API ID. Provider-relative IDs are not bare facts. */
  const collectRecord = (key, raw, providerId) => {
    const id = exactModelIdentity(key)
    if (id === undefined) return
    const qualified = providerId === undefined || id.startsWith(`${providerId}/`) ? id : `${providerId}/${id}`
    const relative = providerId !== undefined ? qualified.slice(providerId.length + 1) : leafOf(id)
    const recordId = exactModelIdentity(raw?.id)
    // The map key and row may use full or provider-relative spelling, but do not
    // treat a conflicting explicit ID as a fact for the map key's model.
    if (!validFact(raw) || (recordId !== undefined && recordId !== id && recordId !== qualified && recordId !== relative)) return
    const fact = readModelsDevRecord(id, raw)
    const useful = fact !== undefined && Object.keys(publicFactToCapability(fact)).length > 0
    firstFact(out, qualified, useful ? { ...fact, id: qualified,
      ...(providerId === undefined && id.includes('/') ? { canonicalListing: true } : {}),
    } : undefined, nonEmpty(raw.name))
  }
  const collectRecords = (models, providerId) => {
    if (!validFact(models)) return
    for (const [key, raw] of Object.entries(models)) collectRecord(key, raw, providerId)
  }

  // catalog.json: { providers, models }
  collectRecords(body.models)
  if (validFact(body.providers)) {
    for (const [key, provider] of Object.entries(body.providers)) {
      if (!validFact(provider)) continue
      const providerId = exactModelIdentity(key)
      if (providerId !== undefined) collectRecords(provider.models, providerId)
    }
  }

  // api.json: { <providerId>: { models } }; models.json: { <id>: record }.
  for (const [key, value] of Object.entries(body)) {
    if (key === 'providers' || key === 'models' || !validFact(value)) continue
    if (validFact(value.models)) {
      const providerId = exactModelIdentity(key)
      if (providerId !== undefined) collectRecords(value.models, providerId)
    } else if (exactModelIdentity(value.id) !== undefined || nonEmpty(value.name) !== undefined || value.limit !== undefined
        || value.type !== undefined || value.modalities !== undefined || value.attachment !== undefined || value.reasoning !== undefined
        || value.reasoningEfforts !== undefined || value.reasoning_efforts !== undefined || value.reasoning_options !== undefined) {
      collectRecord(key, value)
    }
  }
  addCanonicalReferences(out)
  return out
}

/**
 * Parse OpenRouter's public listing using the relay dialect reader.
 * @param body - parsed JSON.
 * @returns Map of exact advertised id → relay fact entry.
 */
export function readOpenRouter(body) {
  const out = new PublicRows()
  const listed = validFact(body) && Array.isArray(body.data) ? body.data : []
  for (const raw of listed) {
    // The general relay parser accepts display names as a last resort; an
    // exact public match must use only the catalog's actual advertised ID.
    const id = exactModelIdentity(raw?.id)
    if (id === undefined) continue
    const entry = readModelEntry(raw)
    if (entry === undefined) continue
    const canonical = exactModelIdentity(raw.canonical_slug)
    const ladder = explicitLadder(raw)
    const fact = { ...entry, ...ladder, ...(ladder.reasoningEfforts ? { reasoningCatalog: 'OpenRouter' } : {}), ...(canonical ? { canonicalSlug: canonical } : {}) }
    if (validFact(raw.reasoning) && (raw.reasoning.mandatory === true || raw.reasoning.default_enabled === true)) fact.reasoning = true
    const useful = Object.keys(publicFactToCapability(fact)).length > 0
    firstFact(out, id, useful ? fact : undefined, fact.name)
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
  const id = tag.trim().toLowerCase()
  if (['text-generation', 'text2text-generation', 'conversational', 'image-text-to-text'].includes(id)) return 'chat'
  if (['text-to-image', 'unconditional-image-generation', 'image-to-image'].includes(id)) return 'image'
  if (['text-to-video', 'image-to-video', 'video-to-video'].includes(id)) return 'video'
  if (id === 'feature-extraction' || id === 'sentence-similarity') return 'embedding'
  if (['text-classification', 'zero-shot-classification', 'image-classification', 'zero-shot-image-classification', 'video-classification', 'audio-classification'].includes(id)) return 'classifier'
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
 * @returns Map of exact repository id → fact `{ id, name?, kind?, reasoning?, toolCall? }`.
 */
export function readHuggingFace(body) {
  const out = new PublicRows()
  const listed = Array.isArray(body) ? body : Array.isArray(body?.models) ? body.models : []
  for (const raw of listed) {
    if (!validFact(raw)) continue
    const id = exactModelIdentity(raw.id) ?? exactModelIdentity(raw.modelId)
    // The Hub's identity is owner/repository; never synthesize a bare checkpoint
    // name (or drop branch/version spelling) into an exact API identity.
    if (id === undefined || !/^[^/]+\/[^/]+$/.test(id)) continue
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
    // Names, libraries and tool tags alone cannot populate a learned capability.
    firstFact(out, id, kind !== undefined || fact.reasoning === true ? fact : undefined, fact.name)
  }
  return out
}

/** Merge exact identities only; earlier sources win, later ones fill only gaps. */
export function mergePublicSources(...maps) {
  const merged = new PublicRows()
  const synonymous = {
    input: 'inputModalities', inputModalities: 'input', output: 'outputModalities', outputModalities: 'output',
    kind: 'type', type: 'kind',
  }
  for (const map of maps) {
    for (const [id, name] of factlessIds.get(map) ?? []) firstFact(merged, id, undefined, name)
    for (const [rawId, fact] of map) {
      const id = exactModelIdentity(rawId)
      if (id === undefined || !validIndexedFact(id, fact)) continue
      const current = merged.get(id)
      if (current === undefined || (current.canonicalReference === true && fact.canonicalReference !== true)) merged.set(id, fact)
      else if (fact.canonicalReference !== true || current.canonicalReference === true) {
        const next = { ...current }
        for (const [key, value] of Object.entries(fact)) {
          if (key === 'weakKind' || value === undefined || value === null) continue
          if ((key === 'kind' || key === 'type') && next.weakKind === true && fact.weakKind !== true) {
            delete next[synonymous[key]]
            delete next.weakKind
          } else if (next[key] != null || next[synonymous[key]] != null) continue
          if ((key === 'kind' || key === 'type') && fact.weakKind === true) next.weakKind = true
          // A default belongs to the ladder from the same source. The next
          // parser normalizes its membership after selecting that source.
          if ((key === 'defaultEffort' || key === 'reasoningCatalog') && current.reasoningEfforts !== undefined) continue
          if (key === 'reasoning' && value === false && current.reasoningEfforts?.length > 0) continue
          next[key] = value
        }
        merged.set(id, next)
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
  const type = kindOfType(publicFact.kind) ?? kindOfType(publicFact.type)
  // Do not persist text-only output or a generic chat endpoint as an explicit
  // task declaration. A usable modality/context fact can still be learned.
  if (type !== undefined && !(type === 'chat' && publicFact.weakKind === true)) fact.type = type
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
  Object.assign(fact, explicitLadder(publicFact))
  if (fact.reasoningEfforts !== undefined) {
    fact.reasoning = true
    if (['models.dev', 'OpenRouter'].includes(publicFact.reasoningCatalog)) fact.reasoningCatalog = publicFact.reasoningCatalog
  }
  return fact
}

const leafOf = (id) => id.slice(id.lastIndexOf('/') + 1)

// Catalog route IDs remain distinct for exact matches. A models.dev gateway
// may advertise a canonical upstream ID; use that link for search only when
// its own canonical/native row is present. Never merge the gateway's settings
// into that row. Arbitrary Hub owner names are not rebranded by display text.
function publicIndex(rows) {
  const existing = indexes.get(rows)
  if (existing !== undefined) return existing
  const folded = new Map()
  const lookups = new Map()
  const qualifiedLeaves = new Map()
  const add = (index, key, id) => {
    if (!key) return
    let ids = index.get(key)
    if (ids === undefined) index.set(key, ids = new Set())
    ids.add(id)
  }
  function indexSpelling(id, spelling, weight) {
    if (!nonEmpty(spelling)) return
    const { strict, spelling: normalized, stripped } = publicModelSearchKeyTiers(spelling)
    const addKey = (key, rank) => {
      if (!key) return
      let candidates = lookups.get(key)
      if (!candidates) lookups.set(key, candidates = new Map())
      candidates.set(id, Math.min(candidates.get(id) ?? Infinity, rank + weight))
    }
    addKey(strict, 0)
    addKey(normalized, 1)
    stripped.forEach((key, index) => addKey(key, 4 + index))
  }
  function addIdentity(id, displayName, fact) {
    if (typeof id !== 'string' || exactModelIdentity(id) !== id) return
    const { namespace, name } = modelIdParts(id)
    add(folded, id.toLowerCase(), id)
    const canonical = fact?.canonicalModelId
    if (canonical && canonical !== id && validIndexedFact(canonical, rows.get(canonical))) return
    // When a rolling OpenRouter slug has an exact live sibling, the batch or
    // free variant is still exact-addressable but is not a second dated alias.
    const slug = fact?.canonicalSlug
    const base = id.replace(/:(?:batch|free|fast)$/i, '')
    const baseFact = rows.get(base)
    if (namespace) add(qualifiedLeaves, name, id)
    indexSpelling(id, id, 0)
    const display = nonEmpty(displayName)?.replace(/^[a-z][a-z0-9 .-]{0,28}:\s+/i, '')
    const displayScope = display && modelIdParts(display).namespace
    if (!displayScope || publicModelSearchVendor(display) === publicModelSearchVendor(id)) indexSpelling(id, display, 2)
    if (slug && publicModelSearchVendor(slug) === publicModelSearchVendor(id) && (base === id || baseFact?.canonicalSlug !== slug)) {
      indexSpelling(id, slug, 0)
    }
  }
  for (const [id, fact] of rows) if (validIndexedFact(id, fact)) addIdentity(id, fact.name, fact)
  for (const [id, name] of factlessIds.get(rows) ?? []) addIdentity(id, name)
  const result = { folded, lookups, qualifiedLeaves }
  if (rows instanceof PublicRows) indexes.set(rows, result)
  return result
}

function conflicts(left, right) {
  const a = publicFactToCapability(left)
  const b = publicFactToCapability(right)
  const comparable = (v) => Array.isArray(v) ? JSON.stringify(v.map(item => item?.id ?? item).sort()) : v
  return Object.keys(a).some((key) => Object.hasOwn(b, key) && comparable(a[key]) !== comparable(b[key]))
}

/**
 * Prefer the exact advertised ID, then a case-insensitive full ID, then a
 * unique scoped alias of the ID or optional route display name. Only exact
 * IDs can support an automatic write. A namesake in another vendor's scope
 * cannot supply facts for a qualified model.
 * @returns {{fact: object, exact: boolean} | undefined}
 */
export function lookupPublicMatch(publicFacts, value, { fuzzy = false, name } = {}) {
  const id = exactModelIdentity(value)
  if (id === undefined) return undefined
  if (!(publicFacts instanceof Map)) {
    if (!validFact(publicFacts)) return undefined
    const factId = exactModelIdentity(publicFacts.id)
    if (factId === undefined) return undefined
    return lookupPublicMatch(new Map([[factId, publicFacts]]), id, { fuzzy, name })
  }
  const scope = modelIdParts(id)
  const exact = publicFacts.get(id)
  if (publicFacts.has(id) && !validIndexedFact(id, exact)) return undefined
  if (scope.namespace && validIndexedFact(id, exact)) {
    if (exact.canonicalReference) return fuzzy ? { fact: exact, exact: false } : undefined
    return { fact: exact, exact: true }
  }
  if (factlessIds.get(publicFacts)?.has(id)) return undefined
  if (!fuzzy && exact === undefined) return undefined

  const { folded, lookups, qualifiedLeaves } = publicIndex(publicFacts)
  const bareConflicts = (name, fact) => {
    const siblings = qualifiedLeaves.get(name)
    if (siblings === undefined) return false
    return siblings.size > 1 || conflicts(fact, publicFacts.get(siblings.values().next().value))
  }
  if (validIndexedFact(id, exact)) {
    return bareConflicts(scope.name, exact) || (exact.canonicalReference && !fuzzy) ? undefined : { fact: exact, exact: !exact.canonicalReference }
  }

  const full = folded.get(id.toLowerCase())
  if (full !== undefined) {
    if (full.size !== 1) return undefined
    const fact = publicFacts.get(full.values().next().value)
    if (!validFact(fact) || (!scope.namespace && bareConflicts(scope.name, fact))) return undefined
    return { fact, exact: false }
  }

  const vendor = publicModelSearchVendor(id)
  const displayVendor = publicModelSearchVendor(name)
  const candidates = new Map()
  function query(spelling, weight) {
    if (!nonEmpty(spelling)) return
    const tiers = publicModelSearchKeyTiers(spelling)
    for (const [key, queryRank] of [[tiers.strict, 0], [tiers.spelling, 1], ...tiers.stripped.map((key, index) => [key, 4 + index])]) {
      for (const [candidate, rowRank] of lookups.get(key) ?? []) {
        const candidateVendor = publicModelSearchVendor(candidate)
        if (vendor && vendor !== candidateVendor) continue
        if (!vendor && displayVendor && displayVendor !== candidateVendor && weight > 0) continue
        const rank = Math.max(queryRank, rowRank) * 32 + queryRank + rowRank + weight
        candidates.set(candidate, Math.min(candidates.get(candidate) ?? Infinity, rank))
      }
    }
  }
  query(id, 0)
  if (!vendor || !displayVendor || vendor === displayVendor) query(name, 2)
  if (candidates.size === 0) return undefined
  const bestRank = Math.min(...candidates.values())
  const best = [...candidates].filter(([, rank]) => rank === bestRank).map(([id]) => id)
  if (best.length === 1) {
    const fact = publicFacts.get(best[0])
    return validFact(fact) ? { fact, exact: false } : undefined
  }
  // A canonical models.dev spelling and another catalog's known vendor
  // spelling of the same leaf (alibaba/qwen4-max vs qwen/qwen4-max) are not
  // unrelated variants. Actual variant/vendor conflicts remain unresolved.
  const canonical = best.filter(id => publicFacts.get(id)?.canonicalListing || publicFacts.get(id)?.canonicalReference)
  if (canonical.length !== 1 || !publicModelSearchVendor(canonical[0])) return undefined
  const original = canonical[0]
  if (!best.every(other => publicModelSearchVendor(other) === publicModelSearchVendor(original) &&
    publicModelSearchKeyTiers(other).strict === publicModelSearchKeyTiers(original).strict && validIndexedFact(other, publicFacts.get(other)))) return undefined
  const fact = publicFacts.get(original)
  if (fact.reasoningEfforts?.length || fact.reasoning === false) return { fact, exact: false }
  const ladders = best.map(other => publicFacts.get(other)).filter(row => row?.reasoningEfforts?.length)
  if (ladders.length !== 1) return { fact, exact: false }
  const { reasoningEfforts, reasoningCatalog, defaultEffort } = ladders[0]
  return { fact: { ...fact, reasoning: true, reasoningEfforts, reasoningCatalog, defaultEffort }, exact: false }
}

/** Compatibility wrapper with safe exact matching unless explicitly opted in. */
export function lookupPublicFact(publicFacts, id, options) {
  return lookupPublicMatch(publicFacts, id, options)?.fact
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
 * @param options - `{fuzzy, names}` enables reference-only aliases, optionally
 *   using a Map of exact route IDs to unambiguous display names.
 * @returns unmatched rows as `{ id, fact, origins, writeFact, publicAlias? }`.
 */
export function publicOnlyFacts(ids, answered, publicFacts, options) {
  if (publicFacts === undefined || publicFacts === null) return []
  const done = new Set((answered ?? []).map(exactModelIdentity))
  const out = []
  for (const id of ids) {
    const identity = exactModelIdentity(id)
    if (identity === undefined || done.has(identity)) continue
    const match = lookupPublicMatch(publicFacts, identity, { fuzzy: options?.fuzzy, name: options?.names?.get(identity) })
    if (match === undefined) continue
    const fields = publicFactToCapability(match.fact)
    if (Object.keys(fields).length === 0) continue
    out.push({ id, fact: { id, ...fields, publicLookupId: match.fact.id }, origins: ['public'], writeFact: match.exact ? fields : null,
      ...(match.exact ? {} : { publicAlias: true }) })
  }
  return out
}
