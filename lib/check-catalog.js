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

/** Public catalog endpoints, fetched without credentials. */
export const PUBLIC_SOURCES = {
  modelsDev: 'https://models.dev/api.json',
  openRouter: 'https://openrouter.ai/api/v1/models',
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse models.dev's `api.json` into a fact map.
 *
 * The shape is `{ <provider>: { models: { <id>: { modalities, limit, reasoning … } } } }`;
 * every field is optional because the site evolves.
 * @param body - parsed JSON of the endpoint.
 * @returns Map of normalized id → fact entry `{ id, input, output, reasoning, contextWindow, maxTokens, name }`.
 */
export function readModelsDev(body) {
  const out = new Map()
  if (body === null || typeof body !== 'object') return out
  const push = (id, fact) => {
    if (typeof id !== 'string' || id === '' || fact === undefined) return
    for (const variant of modelIdVariants(id)) {
      if (!out.has(variant)) out.set(variant, fact)
    }
  }
  for (const entry of Object.values(body)) {
    const models = entry !== null && typeof entry === 'object' ? entry.models : undefined
    if (models === null || typeof models !== 'object') continue
    for (const [id, raw] of Object.entries(models)) {
      if (raw === null || typeof raw !== 'object') continue
      const modalities = raw.modalities !== null && typeof raw.modalities === 'object' ? raw.modalities : undefined
      const limit = raw.limit !== null && typeof raw.limit === 'object' ? raw.limit : undefined
      const fact = {
        id,
        ...(nonEmpty(raw.name) !== undefined ? { name: raw.name.trim() } : {}),
        ...(Array.isArray(modalities?.input) ? { input: modalities.input.filter((item) => typeof item === 'string') } : {}),
        ...(Array.isArray(modalities?.output) ? { output: modalities.output.filter((item) => typeof item === 'string') } : {}),
        ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
        ...(Number.isSafeInteger(limit?.context) && limit.context > 0 ? { contextWindow: limit.context } : {}),
        ...(Number.isSafeInteger(limit?.output) && limit.output > 0 ? { maxTokens: limit.output } : {}),
      }
      if (Object.keys(fact).length > 1) push(id, fact)
    }
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

/** Merge the two public sources; a second source fills what the first missed. */
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
 * Extract a JSON object from a possibly fenced or chatty checker reply.
 * @param text - raw assistant text.
 * @returns the parsed object, or undefined when nothing parseable remains.
 */
export function extractJsonBlock(text) {
  if (typeof text !== 'string') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = []
  if (fenced !== null) candidates.push(fenced[1])
  candidates.push(text)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch (_error) {
      // Fall through to the next candidate.
    }
  }
  return undefined
}

/**
 * Validate one checker answer against the identifiers of its batch.
 *
 * Only plain facts survive: modalities are filtered through the host's
 * modality list, kinds through `MODEL_KINDS`, numbers guarded, and every
 * entry stays attached to an id the batch actually asked about.
 * @param parsed - the checker's parsed JSON (object or `{models:[...]}`).
 * @param ids - the batch ids verbatim.
 * @param publicFact - resolved public facts for the batch, keyed by variant.
 * @returns array of `{ id, fact, origins }`; `fact` is null when the checker
 *   said `unknown` for that model in a usable way.
 */
export function parseCheckerAnswer(parsed, ids, publicFact) {
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Object.values(parsed ?? {})
  const wanted = new Set(ids.map((id) => id.toLowerCase()))
  const out = []
  for (const raw of source) {
    if (raw === null || typeof raw !== 'object') continue
    const id = nonEmpty(raw.id)
    if (id === undefined || !wanted.has(id.toLowerCase())) continue
    const fact = {
      id,
      ...(MODEL_KINDS.includes(raw.kind) ? { type: raw.kind } : {}),
      ...(typeof raw.type === 'string' && MODEL_KINDS.includes(raw.type) ? { type: raw.type } : {}),
    }
    const input = normalizeModalities(raw.input ?? raw.inputModalities)
    if (input !== undefined) fact.input = input
    const output = normalizeModalities(raw.output ?? raw.outputModalities)
    if (output !== undefined) fact.output = output
    if (Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0) {
      fact.contextWindow = raw.contextWindow
    }
    if (Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0) fact.maxTokens = raw.maxTokens
    if (typeof raw.reasoning === 'boolean') fact.reasoning = raw.reasoning
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
    }
    const origins = []
    if (publicFact !== undefined) origins.push('public')
    origins.push('checker')
    const declared =
      fact.type !== undefined || fact.input !== undefined || fact.output !== undefined ||
      fact.contextWindow !== undefined || fact.maxTokens !== undefined ||
      fact.reasoning !== undefined || fact.reasoningEfforts !== undefined
    if (declared) out.push({ id, fact, origins })
    else out.push({ id, fact: null, origins })
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
  }
}

/** Chunk-type consumer over one auxiliary completion, minimal and text-only. */
class TextAssembler {
  constructor() {
    this.parts = []
    this.usage = undefined
    this.finish = undefined
  }

  push(chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.parts.push(chunk.text)
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
  const batchSize = Number.isFinite(options.batchSize) && options.batchSize > 0 ? options.batchSize : 6
  const concurrencyLimit = Math.max(1, Math.min(3, Number.isFinite(options.concurrency) ? options.concurrency : 2))
  const defaultWriteBack = options.writeBack !== false
  const onApplied = typeof options.onApplied === 'function' ? options.onApplied : () => {}

  let state = idleState()
  let abort = null

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

  /** Fetch one public source; a failure is an empty map, never a throw. */
  const readPublicSource = async (url, parser, headers) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', ...(headers ?? {}) },
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) return new Map()
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch (_error) {
        return new Map()
      }
      return parser(body)
    } catch (error) {
      warn(`model-visibility: public catalog ${url} unavailable`, error)
      return new Map()
    } finally {
      clearTimeout(timer)
    }
  }

  const publicIndex = async () => {
    const sources = await Promise.all([
      readPublicSource(PUBLIC_SOURCES.modelsDev, readModelsDev),
      readPublicSource(PUBLIC_SOURCES.openRouter, readOpenRouter),
    ])
    return mergePublicSources(...sources)
  }

  /** One auxiliary completion for a batch; answers text or fails loudly. */
  const askChecker = async (checker, system, input, signal) => {
    if (typeof llm?.prepareCall !== 'function') {
      throw new Error('llm service unavailable for the verify sweep')
    }
    const maxTokens = 2048
    const call = await llm.prepareCall(
      { provider: checker.provider, model: checker.model, maxTokens },
      signal,
      (controls, modelInfo) => controls,
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
    return { text: assembler.text, usage: assembler.usage }
  }

  const checkerSystemPrompt =
    'You catalog LLM API capabilities. For each model you answer only JSON. ' +
    'If you have web search, verify against vendor docs; otherwise answer from knowledge. ' +
    'Never invent a number: use null for anything unknown, and only report what the vendor actually documents.'

  const batchPrompt = (batch) =>
    'Report the facts for each model below as a JSON array of objects with keys ' +
    '"id", "kind" ("chat" | "image" | "video" | "embedding" | "rerank" | "audio" | "classifier" | "translation"), ' +
    '"input" (array from "text"/"image"/"audio"/"video"/"file"), "output", "contextWindow" (input tokens), ' +
    '"maxTokens" (max output tokens), "reasoning" (boolean), "reasoningEfforts" (array of level ids such as ' +
    '"minimal"/"low"/"medium"/"high" or vendor ids) and "defaultEffort". Use null for anything unknown. Models:\n' +
    batch.map((item) => `- ${item}${item === null ? '' : ''}`).join('\n')

  /** Execute one batch; returns the sanitized results (or throws). */
  const runBatch = async (batchText, ids, publicFacts, checker, signal) => {
    const reply = await askChecker(
      checker,
      checkerSystemPrompt,
      batchPrompt(batchText),
      signal,
    )
    const parsed = extractJsonBlock(reply.text)
    if (parsed === undefined) throw new Error('the checker reply contained no JSON object')
    return parseCheckerAnswer(parsed, ids, publicFacts)
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

  /** The sweep itself; run once at a time. */
  const startVerification = async ({ checker, writeBack = defaultWriteBack } = {}) => {
    if (state.running) return snapshot()
    const provider = nonEmpty(checker?.provider)
    const model = nonEmpty(checker?.model)
    if (provider === undefined || model === undefined) {
      state = { ...idleState(), phase: 'error', errors: ['choose the checking provider/model first'] }
      return snapshot()
    }
    state = {
      ...idleState(),
      running: true,
      phase: 'public',
      startedAt: now(),
      checker: { provider, model },
      writeBack,
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
          models = Array.isArray(await llm.listModels(id)) ? await llm.listModels(id) : []
        } catch (error) {
          state.errors.push(`route ${id}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const ids = models.map((item) => nonEmpty(item?.id)).filter(Boolean)
        if (ids.length > 0) targetProviders.push({ id, ids: [...new Set(ids)] })
      }
      state.phase = 'checker'
      const publicFacts = await publicIndex()
      state.phase = 'verifying'
      const targets = []
      for (const route of targetProviders) {
        for (const id of route.ids) {
          const key = String(modelIdVariants(id)[0] ?? id)
          // De-duplicate across routes by canonical id: one sweep per model.
          if (!targets.some((target) => target.key === key)) targets.push({ key, id, provider: route.id })
        }
      }
      state.total = Math.max(0, targets.length - 1) // minus the checker itself
      // Batches of batchSize distinct ids, checker's own models excluded.
      const batches = []
      let current = []
      for (const target of targets) {
        const isChecker = target.provider === provider && normalizeId(target.id) === normalizeId(model)
        if (isChecker) {
          state.done += 1
          continue
        }
        current.push(target.id)
        if (current.length >= batchSize) {
          batches.push([...current])
          current = []
        }
      }
      if (current.length > 0) batches.push(current)
      state.batches = batches.map((ids) => ({ ids, status: 'pending' }))
      // Concurrent batches, results merged into the learned store.
      let next = 0
      const worker = async () => {
        for (;;) {
          const index = next
          if (index >= batches.length || signal.aborted) return
          next += 1
          const ids = batches[index]
          state.batches[index].status = 'running'
          try {
            if (signal.aborted) throw new Error('cancelled')
            const results = await runBatch(ids, ids, publicFacts, state.checker, signal)
            for (const result of results) {
              if (result.fact === null) continue
              const sanitized = sanitizeLearned({
                ...result.fact,
                origins: result.origins,
                provider: undefined,
              })
              if (sanitized === undefined) continue
              learned.upsertEntries(
                [{ ...sanitized.entry, id: sanitized.id }],
                { origins: sanitized.entry.origins, verifiedAt: now(), checker: { provider, model } },
              )
              if (writeBack) {
                // Mirror the writable subset into every route serving the id.
                for (const route of targetProviders) {
                  if (!route.ids.includes(result.id)) continue
                  const applied = await writeBackEntry({ provider: route.id, model: result.id, fact: sanitized.entry })
                  if (applied?.written) {
                    state.batches[index].written = [...(state.batches[index].written ?? []), `${route.id}/${result.id}`]
                  }
                }
              }
            }
            state.done += ids.length
            state.batches[index].status = 'ok'
          } catch (error) {
            state.batches[index].status = signal.aborted ? 'cancelled' : 'failed'
            state.batches[index].error = error instanceof Error ? error.message : String(error)
            if (!signal.aborted) state.errors.push(`batch ${index + 1}: ${state.batches[index].error}`)
          }
        }
      }
      await Promise.all(Array.from({ length: concurrencyLimit }, () => worker()))
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
      state.running = false
      state.phase = 'cancelled'
    },
    isRunning: () => state.running,
  }
}
