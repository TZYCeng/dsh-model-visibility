/**
 * The online capability verifier behind the settings page's "verify all
 * models" run.
 *
 * The user picks one route as the *checker model*; the Host then sweeps every
 * other routable model in two evidence passes:
 *
 * 1. **Public catalogs** — models.dev's `api.json` and OpenRouter's public
 *    `/api/v1/models` are fetched without credentials and matched by
 *    normalized id. They give declared-labeled facts for well-known models.
 * 2. **The checker model** — batches of models whose facts are still missing
 *    (or that a public row contradicts) go through `llm.prepareCall` + a
 *    strict JSON prompt. The checker is expected to know vendor specs (or to
 *    be able to search); it answers `unknown` freely, and an unknown answer
 *    never becomes a fact.
 *
 * Merged results land in the learned snapshot (`lib/learned-catalog.js`), and
 * — when the write-back switch is on — the fields the provider schema can
 * express are mirrored into the route's own settings through
 * `lib/provider-write.js`, exactly like a manual override with
 * "write into provider settings" checked. The checker's own spend is recorded
 * into the token ledger so the page's usage numbers include it.
 *
 * @module lib/check-catalog
 */

import { normalizeModalities, readModelEntry } from './provider-probe.js'
import { stripWrittenFields, writeCapabilities } from './provider-write.js'
import { sanitizeLearned } from './learned-catalog.js'
import { MODEL_KINDS } from './capability-catalog.js'
import { modelIdVariants } from './model-id.js'
import { readResponseText } from './http-body.js'

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
 * Extract a JSON value from a possibly fenced or chatty checker reply.
 *
 * Both `{…}` and `[…]` are accepted: the contract asks for an array, and a
 * model that answers `[]` ("I know none of these") used to fall through to
 * "contained no JSON" because only braces were searched.
 * @param text - raw assistant text.
 * @returns the parsed object/array, or undefined when nothing parseable remains.
 */
export function extractJsonBlock(text) {
  if (typeof text !== 'string') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = []
  if (fenced !== null) candidates.push(fenced[1])
  candidates.push(text)
  for (const candidate of candidates) {
    // Prefer the outermost balanced span of whichever bracket opens first.
    const spans = [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
    ]
      .map(({ open, close }) => {
        const start = candidate.indexOf(open)
        const end = candidate.lastIndexOf(close)
        return start === -1 || end <= start ? undefined : { start, end }
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start)
    for (const span of spans) {
      try {
        const parsed = JSON.parse(candidate.slice(span.start, span.end + 1))
        if (parsed !== null && typeof parsed === 'object') return parsed
      } catch (_error) {
        // Try the next span, then the next candidate.
      }
    }
  }
  return undefined
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
 * Validate one checker answer against the identifiers of its batch.
 *
 * Only plain facts survive: modalities are filtered through the host's
 * modality list, kinds through `MODEL_KINDS`, numbers guarded, and every
 * entry stays attached to an id the batch actually asked about.
 *
 * Public catalog facts are *merged in*, not just named: the discovered public
 * row provides a base and the checker overrides it field by field. Before this
 * the catalogs were downloaded, parsed and then thrown away except for an
 * `origins` label — which is why the sweep looked like "the public catalogs
 * returned no model data" even though the endpoints answered fine.
 * @param parsed - the checker's parsed JSON (object or `{models:[...]}`).
 * @param ids - the batch ids verbatim.
 * @param publicFacts - the merged public catalog (variant id -> fact).
 * @returns array of `{ id, fact, origins }`; `fact` is null when neither the
 *   public catalogs nor the checker declared anything for that model.
 */
export function parseCheckerAnswer(parsed, ids, publicFacts) {
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Object.values(parsed ?? {})
  const wanted = new Set(ids.map((id) => id.toLowerCase()))
  const out = []
  for (const raw of source) {
    if (raw === null || typeof raw !== 'object') continue
    const id = nonEmpty(raw.id)
    if (id === undefined || !wanted.has(id.toLowerCase())) continue
    const publicFact = lookupPublicFact(publicFacts, id)
    // Public row first, checker answers on top: the checker saw this specific
    // route, the catalog only knows the model family.
    const fromPublic = publicFactToCapability(publicFact)
    const fact = { id, ...fromPublic }
    /** Fields the checker itself supplied (as opposed to the catalog). */
    let checkerContributed = false
    if (MODEL_KINDS.includes(raw.kind)) {
      fact.type = raw.kind
      checkerContributed = true
    }
    if (typeof raw.type === 'string' && MODEL_KINDS.includes(raw.type)) {
      fact.type = raw.type
      checkerContributed = true
    }
    const input = normalizeModalities(raw.input ?? raw.inputModalities)
    if (input !== undefined) {
      fact.input = input
      checkerContributed = true
    }
    const output = normalizeModalities(raw.output ?? raw.outputModalities)
    if (output !== undefined) {
      fact.output = output
      checkerContributed = true
    }
    if (Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0) {
      fact.contextWindow = raw.contextWindow
      checkerContributed = true
    }
    if (Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0) {
      fact.maxTokens = raw.maxTokens
      checkerContributed = true
    }
    if (typeof raw.reasoning === 'boolean') {
      fact.reasoning = raw.reasoning
      checkerContributed = true
    }
    if (Array.isArray(raw.reasoningEfforts)) {
      const efforts = raw.reasoningEfforts
        .map((effort) => (typeof effort === 'string' ? effort : effort?.id))
        .filter((effort) => typeof effort === 'string' && effort.trim() !== '')
        .map((effort) => ({ id: effort.trim() }))
      if (efforts.length > 0) fact.reasoningEfforts = efforts
      const defaultEffort = nonEmpty(raw.defaultEffort)
      if (defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort)) {
        fact.defaultEffort = defaultEffort
      }
      if (efforts.length > 0) checkerContributed = true
    }
    // `origins` names the layers that actually contributed a field. Before this
    // "checker" was pushed unconditionally, so a model the checker skipped but a
    // catalog knew looked like a checker answer.
    const origins = []
    if (Object.keys(fromPublic).length > 0) origins.push('public')
    if (checkerContributed) origins.push('checker')
    const declared =
      fact.type !== undefined || fact.input !== undefined || fact.output !== undefined ||
      fact.contextWindow !== undefined || fact.maxTokens !== undefined ||
      fact.reasoning !== undefined || fact.reasoningEfforts !== undefined
    if (declared) out.push({ id, fact, origins })
    else out.push({ id, fact: null, origins })
  }
  return out
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

/** Renderable progress state between sweeps. */
function idleState() {
  return {
    phase: 'idle',
    running: false,
    total: 0,
    done: 0,
    checker: undefined,
    writeBack: undefined,
    tokenUsage: [0, 0, 0, 0],
    batches: [],
    errors: [],
    /** Per-source outcome of the public catalog pass. */
    sources: [],
    /** How many models were resolved from a public catalog alone. */
    publicOnly: 0,
    concurrency: undefined,
  }
}

/**
 * Turn a transport failure into something a user can act on.
 *
 * The common real-world causes here are a dead host, a captive portal, and a
 * TLS-intercepting proxy whose root CA is not trusted — the last one shows up
 * as `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and reads like a plugin bug unless it
 * is named.
 * @param error - whatever the fetch rejected with.
 * @returns one human sentence.
 */
export function transportMessageOf(error) {
  const code = error?.cause?.code ?? error?.code
  if (typeof code === 'string') {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS 解析失败（域名不存在或无法解析）'
    if (code === 'ECONNREFUSED') return '连接被拒绝'
    if (code === 'ECONNRESET') return '连接被重置'
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
    if (code === 'CERT_HAS_EXPIRED') return 'TLS 证书已过期'
    if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      return 'TLS 证书链不受信任（可能被本地代理拦截；把该代理的根证书装进系统信任库）'
    }
    if (code.startsWith('ERR_TLS') || code.startsWith('CERT_')) return `TLS 校验失败（${code}）`
  }
  const message = error?.message ?? String(error)
  if (/abort|timeout/i.test(message)) return '请求超时'
  return message
}

/** Module-level alias so the fetch wrapper can use it before its own scope. */
function transportMessageOfShim(error) {
  return transportMessageOf(error)
}

/**
 * Output-token budget for one checker completion.
 *
 * A batch asks for six short JSON objects, which needs well under 1 000 output
 * tokens. The budget is deliberately generous because *reasoning models spend
 * output tokens before they emit a single text delta*: with a tight cap the
 * whole allowance went to the thinking channel, the reply was empty or cut
 * mid-object, and every batch failed with "the reply contained no JSON".
 */
export const CHECKER_MAX_TOKENS = 8192

/**
 * Pinned reasoning effort on the checker call when the caller does not choose
 * one. Verification is a lookup, not a reasoning task; the lowest level keeps
 * the thinking channel from crowding out the JSON answer on models that
 * otherwise think for thousands of tokens.
 */
export const CHECKER_REASONING_EFFORT = 'low'

/**
 * Upper bound on simultaneous checker calls.
 *
 * Each worker holds one HTTP request and one batch of ids. Beyond this a relay
 * starts answering with rate limits, which the sweep reports as batch failures
 * and which costs more than the extra parallelism saves. The user picks the
 * actual number per run from the panel.
 */
export const MAX_CONCURRENCY = 8

/** Default batch size and concurrency when the caller says nothing. */
export const DEFAULT_BATCH_SIZE = 6
export const DEFAULT_CONCURRENCY = 2

/** Chunk-type consumer over one auxiliary completion, minimal and text-only. */
class TextAssembler {
  constructor() {
    this.parts = []
    this.usage = undefined
    this.finish = undefined
    /** True when the model produced reasoning text (a thinking checker). */
    this.sawReasoning = false
  }

  push(chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.parts.push(chunk.text)
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') this.sawReasoning = true
    else if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') this.usage = chunk.usage
    else if (chunk.type === 'finish') this.finish = chunk.reason
  }

  get text() {
    return this.parts.join('')
  }
}

/**
 * Build the sweep.
 *
 * @param options - `{ llm, settings, learned, ledger?, logger?, onApplied?,
 *   fetch?, now?, timeoutMs?, batchSize?, concurrency?, writeBack? }`.
 *   `onApplied(providerId, modelId)` lets the Host clear its caches whenever a
 *   write-back touched the settings document.
 */
export function createCapabilityVerifier(options = {}) {
  const llm = options.llm
  const settings = options.settings
  const learned = options.learned
  const ledger = options.ledger
  const logger = options.logger ?? console
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 180_000
  const batchSize =
    Number.isFinite(options.batchSize) && options.batchSize > 0
      ? options.batchSize
      : DEFAULT_BATCH_SIZE
  const concurrencyLimit = Math.max(
    1,
    Math.min(
      MAX_CONCURRENCY,
      Number.isFinite(options.concurrency) ? Math.trunc(options.concurrency) : DEFAULT_CONCURRENCY,
    ),
  )
  const defaultWriteBack = options.writeBack !== false
  const onApplied = typeof options.onApplied === 'function' ? options.onApplied : () => {}
  /** Output budget per checker call; 0/undefined keeps the default. */
  const defaultCheckerMaxTokens =
    Number.isFinite(options.checkerMaxTokens) && options.checkerMaxTokens > 0
      ? options.checkerMaxTokens
      : CHECKER_MAX_TOKENS
  /** Pinned reasoning effort; `null` disables pinning, `undefined` keeps the default. */
  const defaultCheckerEffort =
    options.checkerReasoningEffort === null
      ? undefined
      : options.checkerReasoningEffort === undefined
        ? CHECKER_REASONING_EFFORT
        : options.checkerReasoningEffort
  /** Hugging Face hosts tried in order; overridable for a private mirror. */
  const huggingFaceHosts =
    Array.isArray(options.huggingFaceHosts) && options.huggingFaceHosts.length > 0
      ? options.huggingFaceHosts.filter((host) => typeof host === 'string' && host !== '')
      : HUGGING_FACE_HOSTS

  let state = idleState()
  let abort = null
  /** The in-flight sweep promise, so a restart can join it instead of racing. */
  let running = null
  /** Per-source outcome of the current/last public catalog pass. */
  let publicReport = []
  let disposed = false
  const publicControllers = new Set()

  const warn = (message, error) => {
    if (typeof logger.warn === 'function') {
      logger.warn(message)
      if (error !== undefined) logger.warn(error)
    }
  }

  const snapshot = () => ({
    ...state,
    tokenizer: undefined,
    tokenUsage: [...state.tokenUsage],
    batches: state.batches.map((batch) => ({ ...batch })),
    errors: [...state.errors],
    sources: state.sources.map((entry) => ({ ...entry })),
  })

  const noteUsage = (entry) => {
    const usage = entry.usage
    if (usage === undefined) return
    const values = [
      Math.max(0, Math.trunc(usage.inputTokens ?? 0)),
      Math.max(0, Math.trunc(usage.outputTokens ?? 0)),
      Math.max(0, Math.trunc(usage.cacheReadTokens ?? 0)),
      Math.max(0, Math.trunc(usage.cacheWriteTokens ?? 0)),
    ]
    for (let index = 0; index < 4; index += 1) state.tokenUsage[index] += values[index]
    ledger?.notePluginUsage({
      time: now(),
      provider: state.checker?.provider,
      model: state.checker?.model,
      usage: {
        inputTokens: values[0],
        outputTokens: values[1],
        cacheReadTokens: values[2],
        cacheWriteTokens: values[3],
      },
    })
  }

  /**
   * Fetch one public source; a failure is an empty map, never a throw.
   *
   * Every outcome is recorded in `publicReport` so the panel can say *which*
   * source failed and why. Silence here was the reason "the catalogs return no
   * model data" was indistinguishable from "the catalogs were never read".
   */
  const readPublicSource = async (name, url, parser, signal) => {
    const entry = { name, url, status: 'pending', models: 0 }
    publicReport.push(entry)
    if (signal?.aborted || disposed) {
      entry.status = 'cancelled'
      return new Map()
    }
    const controller = new AbortController()
    const abortFetch = () => controller.abort()
    signal?.addEventListener('abort', abortFetch, { once: true })
    publicControllers.add(controller)
    const timer = setTimeout(abortFetch, 20_000)
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) {
        entry.status = 'http'
        entry.message = `HTTP ${response.status}`
        return new Map()
      }
      // Stream the body with a real byte ceiling; `response.text()` would
      // buffer whatever the CDN decides to send before checking its size.
      const declared = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > PUBLIC_BODY_LIMIT) {
        entry.status = 'too-large'
        entry.message = `${declared} bytes`
        warn(`model-visibility: public catalog ${url} is too large (${declared} bytes)`)
        return new Map()
      }
      let text
      try {
        text = await readResponseText(response, PUBLIC_BODY_LIMIT)
      } catch (error) {
        if (error instanceof Error && error.message === 'response body is too large') {
          entry.status = 'too-large'
          entry.message = `over ${PUBLIC_BODY_LIMIT} bytes`
          warn(`model-visibility: public catalog ${url} is too large`, error)
          return new Map()
        }
        throw error
      }
      let body
      try {
        body = JSON.parse(text)
      } catch (_error) {
        entry.status = 'bad-json'
        return new Map()
      }
      const facts = parser(body)
      entry.models = facts.size
      entry.bytes = text.length
      entry.status = facts.size > 0 ? 'ok' : 'empty'
      return facts
    } catch (error) {
      entry.status = 'failed'
      entry.message = transportMessageOfShim(error)
      warn(`model-visibility: public catalog ${url} unavailable`, error)
      return new Map()
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFetch)
      publicControllers.delete(controller)
    }
  }

  /**
   * Read every public catalog.
   *
   * Order matters: the provider-free models.dev list and OpenRouter are the
   * cheapest good matches for a relay's ids, so they are merged first and the
   * provider-qualified `api.json` only fills gaps. A failure in one source
   * never removes the others. Hugging Face is tried across its mirrors, so a
   * blocked canonical host does not remove open-weight coverage.
   */
  const publicIndex = async (signal) => {
    const [modelsDevFree, openRouter, huggingFace, modelsDevAll] = await Promise.all([
      readPublicSource('models.dev/models.json', PUBLIC_SOURCES.modelsDevModels, readModelsDev, signal),
      readPublicSource('openrouter', PUBLIC_SOURCES.openRouter, readOpenRouter, signal),
      readHuggingFaceAcrossMirrors(signal),
      readPublicSource('models.dev/api.json', PUBLIC_SOURCES.modelsDevApi, readModelsDev, signal),
    ])
    return mergePublicSources(modelsDevFree, openRouter, huggingFace, modelsDevAll)
  }

  /**
   * Try each Hugging Face host until one returns a usable listing.
   *
   * Only the successful host is reported; the others are recorded as skipped
   * so the panel can show "canonical host blocked, mirror used" instead of a
   * mute failure.
   */
  const readHuggingFaceAcrossMirrors = async (signal) => {
    const tried = []
    for (const host of huggingFaceHosts) {
      if (signal?.aborted || disposed) break
      const before = publicReport.length
      const facts = await readPublicSource(`huggingface ${host.replace(/^https?:\/\//, '')}`, huggingFaceUrl(host), readHuggingFace, signal)
      const entry = publicReport[before]
      tried.push({ host, status: entry?.status ?? 'unknown' })
      if (facts.size > 0) {
        // Collapse the failed attempts into the one that worked, so the source
        // list stays short and the reason the canonical host was skipped is
        // still visible in `message`.
        if (tried.length > 1) {
          const skipped = tried.slice(0, -1).map((item) => item.host.replace(/^https?:\/\//, ''))
          if (entry !== undefined) {
            entry.message = [entry.message, `已回退（${skipped.join(' / ')} 不可用）`]
              .filter(Boolean)
              .join('；')
          }
        }
        return facts
      }
    }
    return new Map()
  }

  /** One auxiliary completion for a batch; answers text or fails loudly. */
  const askChecker = async (checker, system, input, signal) => {
    if (typeof llm?.prepareCall !== 'function') {
      throw new Error('llm service unavailable for the verify sweep')
    }
    const maxTokens = defaultCheckerMaxTokens
    const effort = defaultCheckerEffort
    const call = await llm.prepareCall(
      {
        provider: checker.provider,
        model: checker.model,
        maxTokens,
        ...(effort === undefined || effort === null ? {} : { reasoningEffort: effort }),
      },
      signal,
      // Pin the chosen effort over whatever the adapter would default to; a
      // thinking checker that spends its whole budget thinking never answers.
      (controls) =>
        effort === undefined || effort === null ? controls : { ...controls, reasoningEffort: effort },
    )
    const options2 = {
      ...call.config,
      system,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: input }],
          source: { kind: 'dsh-model-visibility' },
        },
      ],
      signal,
    }
    const assembler = new TextAssembler()
    for await (const chunk of call.stream(options2)) {
      assembler.push(chunk)
    }
    noteUsage({ usage: assembler.usage })
    const finish = assembler.finish
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new Error(finish?.failure?.message ?? 'verify request failed')
    }
    // A truncated completion is a failed completion. Without this check the
    // JSON parse simply reports "no JSON object", which hides the real cause
    // (a too-small output budget) from the user.
    if (finish?.kind === 'max-tokens') {
      throw new Error(
        `the checker reply was truncated at ${maxTokens} output tokens` +
          (assembler.sawReasoning ? ' (the model spent them on reasoning)' : ''),
      )
    }
    return { text: assembler.text, usage: assembler.usage }
  }

  /**
   * The checker contract, stated as a schema rather than as prose.
   *
   * The previous prompt described the keys in a sentence and then hoped for
   * JSON. Models that like to chat, fence their answers, or narrate their
   * lookup would produce something unparseable, and the batch died. Stating
   * one exact output shape — and naming the forbidden forms — is what makes a
   * strict validator possible at all.
   */
  const checkerSystemPrompt = [
    'You are a capability database for LLM API models. You answer with JSON only.',
    '',
    'OUTPUT CONTRACT (violating any rule fails the whole answer):',
    '- Return exactly one JSON array. No prose, no markdown fence, no comments.',
    '- Emit one object per requested model, in the same order.',
    '- Every object has exactly the keys listed below. Use null when unknown.',
    '- Never invent a number. Unknown is null, never a guess.',
    '',
    'OBJECT SCHEMA',
    '{',
    '  "id": string,                       // the id exactly as given to you',
    '  "kind": "chat" | "image" | "video" | "embedding" | "rerank" | "audio" | "classifier" | "translation" | null,',
    '  "input": array of "text" | "image" | "audio" | "video" | "file" | null,',
    '  "output": array of "text" | "image" | "audio" | "video" | null,',
    '  "contextWindow": integer or null,   // input context window in tokens',
    '  "maxTokens": integer or null,       // max output tokens',
    '  "reasoning": boolean or null,       // does it expose reasoning effort?',
    '  "reasoningEfforts": array of "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null,',
    '  "defaultEffort": one of those levels or null',
    '}',
    '',
    'Do not add fields. Do not drop the array wrapper. Do not explain your reasoning.',
  ].join('\n')

  /**
   * The user turn: the ids to describe, one per line, with the same rules
   * restated compactly (long system prompts get ignored more often than a
   * short reminder next to the data).
   */
  const batchPrompt = (batch) =>
    [
      'Return {"...":null} equivalents for each of these model ids.',
      'Reply with only the JSON array described in the system prompt.',
      '',
      batch.map((item) => `- ${item}`).join('\n'),
    ].join('\n')

  /**
   * Strict format validation of one checker reply.
   *
   * Distinct from {@link parseCheckerAnswer}, which *sanitizes*: this gate
   * decides whether the reply honoured the contract at all, so a mangled
   * answer gets one targeted retry instead of silently becoming a batch of
   * "unknown" facts (the old behaviour, which is why a broken checker looked
   * like "the models have no capabilities").
   * @param parsed - the JSON extracted from the reply.
   * @param ids - the ids that were asked for.
   * @returns `{ ok, retryable, missing, extra, reasons, empty }`. `ok` means the
   *   reply honours the contract; `retryable` says whether another attempt could
   *   plausibly fix it (an unknown id in the reply is harmless and must not be
   *   retried, a missing one may be).
   */
  const validateReplyShape = (parsed, ids) => {
    const reasons = []
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.models)
        ? parsed.models
        : Array.isArray(parsed?.results)
          ? parsed.results
          : undefined
    if (list === undefined) {
      return { ok: false, retryable: true, missing: ids, extra: [], reasons: ['expected a JSON array at the top level'] }
    }
    // `{models:[…]}` and `{results:[…]}` are accepted wrappers: models add them
    // unprompted often enough that rejecting them would waste a retry on a
    // reply that is otherwise perfectly usable.
    const seen = new Set()
    const extra = []
    const wanted = new Set(ids.map((id) => id.toLowerCase()))
    let malformed = false
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        reasons.push('an array element is not an object')
        malformed = true
        continue
      }
      const id = nonEmpty(entry.id ?? entry.model)
      if (id === undefined) {
        reasons.push('an object has no "id"')
        malformed = true
        continue
      }
      const key = id.toLowerCase()
      if (!wanted.has(key)) {
        // Harmless: filter it out, do not spend a second call on it.
        extra.push(id)
        continue
      }
      seen.add(key)
    }
    const missing = ids.filter((id) => !seen.has(id.toLowerCase()))
    if (extra.length > 0) reasons.push(`${extra.length} id(s) were not requested (ignored)`)
    // An EMPTY array is not a violation: it is a model saying "I know none of
    // these". Treating it as a format error meant the batch died before the
    // public catalogs could fill in, which is the opposite of the intent.
    const empty = list.length === 0
    if (missing.length > 0 && !empty) reasons.push(`${missing.length} requested id(s) are missing`)
    // Only a structurally broken element or a missing id is worth retrying;
    // extra ids and an empty array are legitimate answers.
    const retryable = malformed || (missing.length > 0 && !empty)
    return { ok: reasons.length === 0, retryable, missing, extra, reasons, empty }
  }

  /**
   * Parse one reply, and on failure retry with the batch halved.
   *
   * A truncated or malformed answer used to lose the whole batch. Splitting it
   * costs one extra call but salvages the models the checker can still answer,
   * and eventually isolates the single model it chokes on. When the halves fail
   * too the *original* error is rethrown: a downstream "no JSON" from a retry
   * would otherwise hide the real cause (truncation, auth, upstream error).
   * @param ids - ids of this batch, in prompt order.
   * @returns parsed entries; never throws for a per-batch failure.
   */
  const runBatchResilient = async (ids, publicFacts, checker, signal) => {
    let firstError
    try {
      return await runBatch(ids, ids, publicFacts, checker, signal)
    } catch (error) {
      firstError = error
      if (signal.aborted || ids.length <= 1) throw error
    }
    const half = Math.ceil(ids.length / 2)
    try {
      const left = await runBatchResilient(ids.slice(0, half), publicFacts, checker, signal)
      const right = await runBatchResilient(ids.slice(half), publicFacts, checker, signal)
      return [...left, ...right]
    } catch (error) {
      // Report the clearest cause: the original failure, unless a half failed
      // for a different and more specific reason.
      throw firstError ?? error
    }
  }

  /** Execute one batch; returns the sanitized results (or throws). */
  const runBatch = async (batchText, ids, publicFacts, checker, signal) => {
    const ask = async () => {
      const reply = await askChecker(checker, checkerSystemPrompt, batchPrompt(batchText), signal)
      const parsed = extractJsonBlock(reply.text)
      if (parsed === undefined) {
        const seen = reply.text.trim()
        return {
          parsed: undefined,
          problem:
            seen === ''
              ? 'the checker returned an empty reply'
              : `the checker reply contained no JSON (${seen.slice(0, 80)}…)`,
        }
      }
      const shape = validateReplyShape(parsed, ids)
      return { parsed, shape, problem: shape.ok ? undefined : shape.reasons.join('; ') }
    }

    let attempt = await ask()
    // One targeted retry, and only when another attempt could plausibly help:
    // unusable text or a broken/missing entry. A legitimate answer — even an
    // empty array — is never retried, because a second call costs tokens and
    // cannot improve "I know none of these".
    const retryable = attempt.problem !== undefined && attempt.shape?.retryable !== false && !signal.aborted
    if (retryable) {
      attempt = await ask()
    }
    if (attempt.parsed === undefined) throw new Error(attempt.problem)
    if (attempt.shape !== undefined && !attempt.shape.ok) {
      // A reply that parses but omits ids is not a hard failure: the public
      // catalogs may still describe those models. Return what was answered and
      // let `publicOnlyFacts` fill the rest; only a reply with no usable entry
      // AND no public coverage should surface as a batch error.
      const usable = parseCheckerAnswer(attempt.parsed, ids, publicFacts)
      const answered = usable.filter((entry) => entry.fact !== null).length
      const fillable = publicOnlyFacts(ids, [], publicFacts).length
      if (answered === 0 && fillable === 0) {
        throw new Error(`checker format violation: ${attempt.problem}`)
      }
      return usable
    }
    return parseCheckerAnswer(attempt.parsed, ids, publicFacts)
  }

  /** Write the writable subset into the provider settings document. */
  const writeBackEntry = async (entry) => {
    if (typeof settings?.mutate !== 'function' || typeof settings?.describe !== 'function') {
      return { fields: [] }
    }
    const provider = nonEmpty(entry.provider)
    if (provider === undefined) return { fields: [] }
    const override = stripWrittenFields(
      {
        provider,
        model: entry.model,
        ...(entry.fact.type !== undefined ? { kind: entry.fact.type } : {}),
        ...(entry.fact.input !== undefined ? { input: entry.fact.input } : {}),
        ...(entry.fact.contextWindow !== undefined ? { contextWindow: entry.fact.contextWindow } : {}),
        ...(entry.fact.reasoningEfforts !== undefined ? { efforts: entry.fact.reasoningEfforts } : {}),
        ...(entry.fact.defaultEffort !== undefined ? { defaultEffort: entry.fact.defaultEffort } : {}),
        ...(entry.fact.reasoning === false ? { reasoningSupported: false } : {}),
      },
      [],
    )
    // A false "no reasoning" plus nothing else has no provider shape: skip.
    if (
      override?.input === undefined &&
      override?.contextWindow === undefined &&
      override?.efforts === undefined &&
      override?.reasoningSupported !== false
    ) {
      return { fields: [] }
    }
    const result = await writeCapabilities(settings, override)
    if (result?.written) onApplied(provider, entry.model)
    return { written: result?.written === true, fields: result?.fields ?? [], reason: result?.reason }
  }

  /**
   * The sweep itself; run once at a time.
   * @param options.checker - `{ provider, model }` to use as the checker.
   * @param options.writeBack - mirror confirmed facts into provider settings.
   * @param options.concurrency - simultaneous checker calls for THIS run
   *   (clamped to {@link MAX_CONCURRENCY}); omitted keeps the constructor value.
   */
  const startVerification = async ({ checker, writeBack = defaultWriteBack, concurrency } = {}) => {
    if (disposed) return snapshot()
    // A cancelled sweep keeps its workers alive until their in-flight call
    // settles. Joining that run instead of racing it is what stops two workers
    // from writing the same `state` and reporting done > total.
    if (running !== null) await running.catch(() => {})
    if (state.running) return snapshot()
    const provider = nonEmpty(checker?.provider)
    const model = nonEmpty(checker?.model)
    if (provider === undefined || model === undefined) {
      state = { ...idleState(), phase: 'error', errors: ['choose the checking provider/model first'] }
      return snapshot()
    }
    const run = runSweep({ provider, model, writeBack, concurrency })
    running = run
    try {
      return await run
    } finally {
      if (running === run) running = null
    }
  }

  /** One sweep against the checker route, from catalog read to flush. */
  const runSweep = async ({ provider, model, writeBack, concurrency }) => {
    if (disposed) return snapshot()
    const workers = Number.isFinite(concurrency)
      ? Math.max(1, Math.min(MAX_CONCURRENCY, Math.trunc(concurrency)))
      : concurrencyLimit
    publicReport = []
    state = {
      ...idleState(),
      running: true,
      phase: 'public',
      startedAt: now(),
      checker: { provider, model },
      writeBack,
      concurrency: workers,
    }
    abort = new AbortController()
    const signal = abort.signal
    try {
      // Target list: every model the registry offers, grouped per route.
      const targetProviders = []
      const providerList = Array.isArray(llm.listProviders()) ? llm.listProviders() : []
      for (const route of providerList) {
        if (route === null || typeof route !== 'object') continue
        const id = nonEmpty(route.id)
        if (id === undefined) continue
        let models = []
        try {
          // One call: the old ternary awaited `listModels` twice (once for the
          // Array check, once for the value), doubling registry work per route.
          const listed = await llm.listModels(id)
          models = Array.isArray(listed) ? listed : []
        } catch (error) {
          state.errors.push(`route ${id}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const ids = models.map((item) => nonEmpty(item?.id)).filter(Boolean)
        if (ids.length > 0) targetProviders.push({ id, ids: [...new Set(ids)] })
      }
      state.phase = 'checker'
      const publicFacts = await publicIndex(signal)
      // Publish the per-source outcome: "the catalogs returned nothing" needs
      // to be distinguishable from "a catalog errored".
      state.sources = publicReport.map((entry) => ({ ...entry }))
      if (signal.aborted) throw new Error('verification cancelled')
      if (publicFacts.size === 0 && state.sources.every((entry) => entry.status !== 'ok')) {
        state.errors.push(
          'no public catalog could be read (' +
            state.sources.map((entry) => `${entry.name}: ${entry.status}${entry.message ? ' ' + entry.message : ''}`).join(', ') +
            ')',
        )
      }
      state.phase = 'verifying'
      // De-duplicate across routes by canonical id: one sweep per model. A Set
      // keeps this linear; the old `targets.some(…)` scan was O(n²) in 400+
      // models and ran before every network call.
      const seenTargets = new Set()
      const targets = []
      for (const route of targetProviders) {
        for (const id of route.ids) {
          const key = String(modelIdVariants(id)[0] ?? id)
          if (seenTargets.has(key)) continue
          seenTargets.add(key)
          targets.push({ key, id, provider: route.id })
        }
      }
      // Batches of batchSize distinct ids, checker's own models excluded.
      const batches = []
      let current = []
      for (const target of targets) {
        const isChecker = target.provider === provider && normalizeId(target.id) === normalizeId(model)
        // The checker never verifies itself and never appears in a batch, so
        // `total` is derived from the batches below rather than from
        // `targets.length - 1` (which undercounted when the checker was not
        // routable and let `done` exceed `total`).
        if (isChecker) continue
        current.push(target.id)
        if (current.length >= batchSize) {
          batches.push([...current])
          current = []
        }
      }
      if (current.length > 0) batches.push(current)
      state.total = batches.reduce((sum, ids) => sum + ids.length, 0)
      state.batches = batches.map((ids) => ({ ids, status: 'pending' }))
      // Concurrent batches, results merged into the learned store.
      let next = 0
      /**
       * Verified facts are buffered and flushed once per worker step: writing
       * the learned snapshot per model rewrote the whole file N times, which is
       * both slow and leaves a half-written store if the sweep dies.
       */
      let pending = []
      let flushChain = Promise.resolve()
      const flush = () => {
        if (pending.length === 0) return flushChain
        const batch = pending
        pending = []
        flushChain = flushChain.then(() => {
          learned.upsertEntries(
            // Each entry keeps its own provenance (`public`, `checker`, or both).
            // Stamping one blanket origin here used to overwrite the per-model
            // one, so a public-only fact was recorded as if the checker said it.
            batch.map((entry) => ({ ...entry.fact, id: entry.id, origins: entry.origins })),
            { verifiedAt: now(), checker: { provider, model } },
          )
        })
        return flushChain
      }

      const worker = async () => {
        for (;;) {
          if (signal.aborted) return
          const index = next
          if (index >= batches.length) return
          next += 1
          const ids = batches[index]
          state.batches[index].status = 'running'
          let verified = 0
          /** Ids the checker actually returned a verdict for. */
          let answered = []
          const ingest = async (results) => {
            for (const result of results) {
              if (signal.aborted) break
              // `fact === null` and "an object with no usable field" are the
              // same thing: the checker had no verdict for this model.
              if (result.fact === null) continue
              answered.push(result.id)
              const sanitized = sanitizeLearned({
                ...result.fact,
                origins: result.origins,
                provider: undefined,
              })
              if (sanitized === undefined) continue
              verified += 1
              pending.push({
                id: sanitized.id,
                fact: { ...sanitized.entry, id: sanitized.id },
                origins: Array.isArray(result.origins) && result.origins.length > 0
                  ? result.origins
                  : ['checker'],
              })
              state.batches[index].verified = verified
              if (writeBack) {
                // Mirror the writable subset into every route serving the id.
                for (const route of targetProviders) {
                  if (!route.ids.includes(result.id)) continue
                  const applied = await writeBackEntry({
                    provider: route.id,
                    model: result.id,
                    fact: sanitized.entry,
                  })
                  if (applied?.written) {
                    state.batches[index].written = [
                      ...(state.batches[index].written ?? []),
                      `${route.id}/${result.id}`,
                    ]
                  }
                }
              }
            }
          }
          try {
            await ingest(await runBatchResilient(ids, publicFacts, state.checker, signal))
            // Whatever the checker skipped may still be described by a public
            // catalog. Those facts were downloaded already, so recording them
            // costs nothing and is the difference between "0 facts" and a
            // usable table when the checker is weak.
            const filled = publicOnlyFacts(ids, answered, publicFacts)
            if (filled.length > 0) {
              await ingest(filled)
              state.publicOnly += filled.length
            }
            await flush()
            state.batches[index].status = signal.aborted ? 'cancelled' : 'ok'
          } catch (error) {
            await flush()
            state.batches[index].status = signal.aborted ? 'cancelled' : 'failed'
            state.batches[index].error = error instanceof Error ? error.message : String(error)
            if (!signal.aborted) {
              state.errors.push(`batch ${index + 1}: ${state.batches[index].error}`)
            }
          } finally {
            // Count what was actually verified: the checker legitimately skips
            // models or answers "unknown", so `done` must never assume the whole
            // batch landed (that produced done=36 / total=23).
            state.done = Math.min(state.total, state.done + verified)
          }
        }
      }
      await Promise.all(Array.from({ length: workers }, () => worker()))
      // An aborted/disposed sweep persists only the batches flushed before the
      // stop request; no new write may begin while the Host is unloading.
      if (!signal.aborted && !disposed) await flush()
      state.phase = signal.aborted ? 'cancelled' : 'done'
      state.running = false
      state.finishedAt = now()
      if (!signal.aborted) {
        learned.meta()
      }
    } catch (error) {
      state.running = false
      state.phase = signal?.aborted ? 'cancelled' : 'error'
      state.finishedAt = now()
      state.errors.push(error instanceof Error ? error.message : String(error))
      warn('model-visibility: verify sweep failed', error)
    } finally {
      abort = null
    }
    return snapshot()
  }

  /** Normalized spelling used to skip the checker's own models. */
  function normalizeId(value) {
    return String(modelIdVariants(value)[0] ?? value)
  }

  return {
    snapshot,
    start: startVerification,
    cancel() {
      if (abort !== null) abort.abort()
      // Do NOT flip `running` here: the workers are still unwinding, and a
      // false `running` let a second sweep start on top of them. The sweep
      // itself publishes the cancelled state when it finishes unwinding.
      state.phase = 'cancelled'
    },
    isRunning: () => state.running,
    /** Stop network work and wait for every worker before the Host unloads. */
    async dispose() {
      disposed = true
      for (const controller of publicControllers) controller.abort()
      if (abort !== null) abort.abort()
      if (running !== null) await running.catch(() => {})
    },
  }
}
