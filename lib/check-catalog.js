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
 * 2. **The checker model** — batches of models go through `llm.prepareCall` + a
 *    strict JSON prompt. With web search enabled, the checker can call bounded search/read
 *    tools and must cite retrieved URLs. It answers unknown freely, and an unknown answer
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

import { stripWrittenFields, writeCapabilities } from './provider-write.js'
import { sanitizeLearned } from './learned-catalog.js'
import { modelIdVariants } from './model-id.js'
import { readResponseText } from './http-body.js'
import { boundedOperation } from './async-operation.js'
import { callChecker, CHECKER_MAX_TOKENS, CHECKER_REASONING_EFFORT } from './checker-call.js'
import { checkerSystemPrompt, batchPrompt, validateReplyShape, evidenceBackedRows } from './checker-contract.js'
export { CHECKER_MAX_TOKENS, CHECKER_REASONING_EFFORT } from './checker-call.js'

import {
  PUBLIC_SOURCES,
  HUGGING_FACE_HOSTS,
  PUBLIC_BODY_LIMIT,
  huggingFaceUrl,
  readModelsDev,
  readOpenRouter,
  readHuggingFace,
  mergePublicSources,
  publicOnlyFacts,
} from './public-catalog.js'

// Preserve the existing public parser API for callers of this module.
export {
  PUBLIC_SOURCES,
  HUGGING_FACE_HOSTS,
  PUBLIC_BODY_LIMIT,
  huggingFaceUrl,
  readModelsDevRecord,
  readModelsDev,
  readOpenRouter,
  kindOfPipelineTag,
  readHuggingFace,
  mergePublicSources,
  publicFactToCapability,
  lookupPublicFact,
  publicOnlyFacts,
} from './public-catalog.js'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

import { extractJsonBlock, parseCheckerAnswer } from './checker-answer.js'
export { extractJsonBlock, parseCheckerAnswer } from './checker-answer.js'

/** Renderable progress state between sweeps. */
function idleState() {
  return {
    phase: 'idle',
    running: false,
    total: 0,
    done: 0,
    processed: 0,
    unknown: 0,
    failed: 0,
    searchCalls: 0,
    fetchCalls: 0,
    webSearch: false,
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
  const web = options.web
  const learned = options.learned
  const ledger = options.ledger
  const logger = options.logger ?? console
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 180_000
  const batchSize =
    Number.isFinite(options.batchSize) && options.batchSize > 0
      ? Math.min(32, Math.max(1, Math.trunc(options.batchSize)))
      : DEFAULT_BATCH_SIZE
  const concurrencyLimit = Math.max(
    1,
    Math.min(
      MAX_CONCURRENCY,
      Number.isFinite(options.concurrency) ? Math.trunc(options.concurrency) : DEFAULT_CONCURRENCY,
    ),
  )
  const defaultWriteBack = options.writeBack === true
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
    batches: state.batches.map((batch) => ({ ...batch, ids: [...batch.ids], ...(batch.written ? { written: [...batch.written] } : {}) })),
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
      const response = await boundedOperation(localSignal => fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: localSignal,
        redirect: 'error',
      }), { signal: controller.signal, timeoutMs: 20_000, label: 'public catalog request' })
      if (!response.ok) {
        entry.status = 'http'
        entry.message = `HTTP ${response.status}`
        return new Map()
      }
      // Stream the body with a real byte ceiling; `response.text()` would
      // buffer whatever the CDN decides to send before checking its size.
      const declared = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > PUBLIC_BODY_LIMIT) {
        await response.body?.cancel?.().catch(() => {})
        entry.status = 'too-large'
        entry.message = `${declared} bytes`
        warn(`model-visibility: public catalog ${url} is too large (${declared} bytes)`)
        return new Map()
      }
      let text
      try {
        text = await boundedOperation(bodySignal => readResponseText(response, PUBLIC_BODY_LIMIT, bodySignal), { signal: controller.signal, timeoutMs: 20_000, label: 'public catalog body' })
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
      entry.bytes = Buffer.byteLength(text, 'utf8')
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

  /**
   * Parse one reply, and on failure retry with the batch halved.
   *
   * A truncated or malformed answer used to lose the whole batch. Splitting it
   * costs one extra call but salvages the models the checker can still answer,
   * and eventually isolates the single model it chokes on. When the halves fail
   * too the *original* error is rethrown: a downstream "no JSON" from a retry
   * would otherwise hide the real cause (truncation, auth, upstream error).
   * @param ids - ids of this batch, in prompt order.
   * @returns sanitized entries with partial failure diagnostics; throws if none survive.
   */
  const runBatchResilient = async (ids, publicFacts, checker, signal, activity) => {
    let firstError
    try {
      return await runBatch(ids, ids, publicFacts, checker, signal, activity)
    } catch (error) {
      firstError = error
      if (signal.aborted || ids.length <= 1 || error.code === 'TIMEOUT') throw error
    }
    const half = Math.ceil(ids.length / 2)
    const results = []
    results.failedIds = []
    results.errors = []
    for (const halfIds of [ids.slice(0, half), ids.slice(half)]) {
      try {
        const halfResults = await runBatchResilient(halfIds, publicFacts, checker, signal, activity)
        results.push(...halfResults)
        results.failedIds.push(...(halfResults.failedIds ?? []))
        results.errors.push(...(halfResults.errors ?? []))
      } catch (error) {
        if (signal.aborted) throw error
        results.failedIds.push(...halfIds)
        results.errors.push(`${halfIds.join(', ')}: ${error.message}`)
      }
    }
    if (!results.length) throw firstError
    return results
  }

  /** Execute one batch; returns the sanitized results (or throws). */
  const runBatch = async (batchText, ids, publicFacts, checker, signal, activity) => {
    let formatProblem
    const ask = async () => {
      signal.throwIfAborted()
      activity.attempts = (activity.attempts ?? 0) + 1
      const reply = await callChecker({ llm, web, checker, system: checkerSystemPrompt(state.webSearch), input: batchPrompt(batchText, formatProblem), signal,
        timeoutMs: defaultTimeoutMs, maxTokens: defaultCheckerMaxTokens, effort: defaultCheckerEffort, webSearch: state.webSearch,
        noteUsage, onActivity: stage => { if (!signal.aborted) activity.stage = stage },
        onWebCall: type => { if (!signal.aborted) state[type === 'search' ? 'searchCalls' : 'fetchCalls'] += 1 },
      })
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
      const shape = validateReplyShape(parsed, ids, { strict: state.webSearch })
      return { parsed: state.webSearch ? evidenceBackedRows(parsed, reply.allowedUrls) : parsed, shape, problem: shape.ok ? undefined : shape.reasons.join('; ') }
    }

    let attempt = await ask()
    // One targeted retry, and only when another attempt could plausibly help:
    // unusable text or a broken/missing entry. A legitimate answer — even an
    // empty array — is never retried, because a second call costs tokens and
    // cannot improve "I know none of these".
    const retryable = attempt.problem !== undefined && attempt.shape?.retryable !== false && !signal.aborted
    if (retryable) {
      formatProblem = attempt.problem
      attempt = await ask()
    }
    if (attempt.parsed === undefined) throw new Error(attempt.problem)
    if (state.webSearch && !attempt.shape?.ok) throw new Error(`checker format violation: ${attempt.problem}`)
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
  const writeBackEntry = async (entry, signal) => {
    if (signal?.aborted || disposed) return { fields: [] }
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
    if (result?.written && !signal?.aborted && !disposed) onApplied(provider, entry.model)
    return { written: result?.written === true, fields: result?.fields ?? [], reason: result?.reason }
  }

  /**
   * The sweep itself; run once at a time.
   * @param options.checker - `{ provider, model }` to use as the checker.
   * @param options.writeBack - mirror confirmed facts into provider settings.
   * @param options.concurrency - simultaneous checker calls for THIS run
   *   (clamped to {@link MAX_CONCURRENCY}); omitted keeps the constructor value.
   */
  const startVerification = async ({ checker, writeBack = defaultWriteBack, concurrency, webSearch = options.webSearch ?? Boolean(web) } = {}) => {
    if (disposed) return snapshot()
    // A cancelled sweep keeps its workers alive until their in-flight call
    // settles. Joining that run instead of racing it is what stops two workers
    // from writing the same `state` and reporting done > total.
    if (running !== null) return running
    if (state.running) return snapshot()
    const provider = nonEmpty(checker?.provider)
    const model = nonEmpty(checker?.model)
    if (provider === undefined || model === undefined) {
      state = { ...idleState(), phase: 'error', errors: ['choose the checking provider/model first'] }
      return snapshot()
    }
    const run = runSweep({ provider, model, writeBack, concurrency, webSearch })
    running = run
    try {
      return await run
    } finally {
      if (running === run) running = null
    }
  }

  /** One sweep against the checker route, from catalog read to flush. */
  const runSweep = async ({ provider, model, writeBack, concurrency, webSearch }) => {
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
      webSearch: webSearch === true,
      concurrency: workers,
    }
    abort = new AbortController()
    const signal = abort.signal
    try {
      // Target list: every model the registry offers, grouped per route.
      const targetProviders = []
      const listedProviders = llm.listProviders()
      const providerList = Array.isArray(listedProviders) ? listedProviders : []
      for (const route of providerList) {
        if (route === null || typeof route !== 'object') continue
        const id = nonEmpty(route.id)
        if (id === undefined) continue
        let models = []
        try {
          // One call: the old ternary awaited `listModels` twice (once for the
          // Array check, once for the value), doubling registry work per route.
          const listed = await boundedOperation(() => llm.listModels(id), { signal, timeoutMs: defaultTimeoutMs, label: `list models ${id}` })
          models = Array.isArray(listed) ? listed : []
        } catch (error) {
          state.errors.push(`route ${id}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const ids = models.map((item) => nonEmpty(item?.id)).filter(Boolean)
        if (ids.length > 0) targetProviders.push({ id, ids: [...new Set(ids)] })
      }
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
      if (state.webSearch && typeof web?.search !== 'function') {
        state.errors.push('web search service unavailable; configure a DSH search provider or disable web search')
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
        // The checker never verifies itself and never appears in a batch, so
        // `total` is derived from the batches below rather than from
        // `targets.length - 1` (which undercounted when the checker was not
        // routable and let `done` exceed `total`).
        if (normalizeId(target.id) === normalizeId(model)) continue
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
        if (pending.length === 0 || signal.aborted || disposed) return flushChain
        const batch = pending
        pending = []
        flushChain = flushChain.catch(() => {}).then(() => {
          if (signal.aborted || disposed) return
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
          const activity = state.batches[index]
          activity.status = 'running'
          activity.startedAt = now()
          activity.stage = 'checker'
          let verified = 0
          /** Ids the checker actually returned a verdict for. */
          let answered = []
          let batchFailed = false
          let failedIds = []
          const ingest = async (results) => {
            for (const result of results) {
              if (signal.aborted) break
              // `fact === null` and "an object with no usable field" are the
              // same thing: the checker had no verdict for this model.
              if (result.fact === null) continue
              if (answered.includes(result.id)) continue
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
                  const routeModels = route.ids.filter(id => normalizeId(id) === normalizeId(result.id))
                  for (const routeModel of routeModels) {
                    if (signal.aborted || disposed) break
                    activity.stage = 'writeBack'
                    let applied
                    try {
                      applied = await boundedOperation(writeSignal => writeBackEntry({
                        provider: route.id,
                        model: routeModel,
                        fact: sanitized.entry,
                      }, writeSignal), { signal, timeoutMs: defaultTimeoutMs, label: 'provider write-back' })
                    } catch (error) {
                      if (signal.aborted) break
                      state.errors.push(`write-back ${route.id}/${routeModel}: ${error.message}`)
                      continue
                    }
                    if (applied?.written) {
                      activity.written = [...(activity.written ?? []), `${route.id}/${routeModel}`]
                    }
                  }
                }
              }
            }
          }
          try {
            const results = await boundedOperation(batchSignal =>
              runBatchResilient(ids, publicFacts, state.checker, batchSignal, activity),
              { signal, timeoutMs: defaultTimeoutMs * 2, label: 'checker batch' })
            failedIds = results.failedIds ?? []
            for (const message of results.errors ?? []) state.errors.push(`batch ${index + 1}: ${message}`)
            await ingest(results)
            // Whatever the checker skipped may still be described by a public
            // catalog. Those facts were downloaded already, so recording them
            // costs nothing and is the difference between "0 facts" and a
            // usable table when the checker is weak.
            const filled = publicOnlyFacts(ids, answered, publicFacts)
            if (filled.length > 0) {
              await ingest(filled)
              state.publicOnly += filled.length
            }
            activity.stage = 'flush'
            await flush()
            state.batches[index].status = signal.aborted ? 'cancelled' : failedIds.length ? 'partial' : 'ok'
          } catch (error) {
            batchFailed = !signal.aborted
            if (!signal.aborted && !disposed) {
              const filled = publicOnlyFacts(ids, answered, publicFacts)
              await ingest(filled)
              state.publicOnly += filled.length
              await flush()
            }
            state.batches[index].status = signal.aborted ? 'cancelled' : 'failed'
            state.batches[index].error = error instanceof Error ? error.message : String(error)
            if (!signal.aborted) {
              state.errors.push(`batch ${index + 1}: ${state.batches[index].error}`)
            }
          } finally {
            // Count what was actually verified: the checker legitimately skips
            // models or answers "unknown", so `done` must never assume the whole
            // batch landed (that produced done=36 / total=23).
            activity.finishedAt = now()
            state.done = Math.min(state.total, state.done + verified)
            if (!signal.aborted) {
              state.processed = Math.min(state.total, state.processed + ids.length)
              const unresolved = Math.max(0, ids.length - verified)
              const failures = batchFailed ? unresolved : failedIds.filter(id => !answered.includes(id)).length
              state.failed += failures
              state.unknown += Math.max(0, unresolved - failures)
            }
          }
        }
      }
      // A failing flush must not detach sibling workers and release ownership of
      // the global snapshot while they can still report usage or write facts.
      const outcomes = await Promise.allSettled(Array.from({ length: workers }, () => worker()))
      const rejected = outcomes.find(result => result.status === 'rejected')
      if (rejected) throw rejected.reason
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
