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
 * when write-back is enabled, only safe additions to the route's input and
 * context settings are attempted; learned reasoning remains advisory.
 * The checker's own spend is recorded
 * into the token ledger so the page's usage numbers include it.
 *
 * @module lib/check-catalog
 */

import { writeCapabilities } from './provider-write.js'
import { PUBLIC_CATALOG_REVISION, sanitizeLearned } from './learned-catalog.js'
import { readResponseText } from './http-body.js'
import { boundedOperation } from './async-operation.js'
import { callChecker, CHECKER_MAX_TOKENS, CHECKER_REASONING_EFFORT } from './checker-call.js'
import { checkerSystemPrompt, checkerLookupPrompt, batchPrompt, validateReplyShape, recoverCompleteCheckerRows } from './checker-contract.js'
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
  lookupPublicMatch,
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

import { exactCheckerJson, parseCheckerAnswer } from './checker-answer.js'
export { extractJsonBlock, parseCheckerAnswer } from './checker-answer.js'

export const VERIFY_SOURCE_MODES = Object.freeze(['public', 'supplement', 'checker'])

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
    searchBackends: {},
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
    skippedKnown: 0,
    fullScan: false,
    useChecker: true,
    fuzzyMatch: false,
    aliasMatches: 0,
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

const PUBLIC_TIMEOUT_MS = 20_000
const MODELS_DEV_API_TIMEOUT_MS = 30_000
const RETRYABLE_CATALOG_STATUS = new Set([408, 500, 502, 503, 504])
const RETRYABLE_CATALOG_ERRORS = new Set([
  'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

function transientCatalogFailure(error, phase) {
  const code = error?.cause?.code ?? error?.code
  if (RETRYABLE_CATALOG_ERRORS.has(code)) return true
  // The underlying fetch can abort independently after headers (e.g. a
  // disconnected proxy). The caller's own abort is checked before retrying.
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true
  return phase === 'body' && /\b(?:terminated|aborted|cancel(?:l)?ed|socket hang up|premature close)\b/i.test(error?.message ?? '')
}

function cancelCatalogBody(response) {
  // A broken stream's cancel hook need not finish before we can report failure.
  void response.body?.cancel?.().catch(() => {})
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
 *   fetch?, now?, timeoutMs?, publicTimeoutMs?, batchSize?, concurrency?, writeBack? }`.
 *   `onApplied(providerId, modelId)` lets the Host clear its caches whenever a
 *   write-back touched the settings document.
 */
export function createCapabilityVerifier(options = {}) {
  const llm = options.llm
  const settings = options.settings
  const configEditor = options.configEditor
  const web = options.web
  const searchBridge = options.searchBridge
  const learned = options.learned
  const ledger = options.ledger
  const logger = options.logger ?? console
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 180_000
  const publicTimeoutMs = Number.isFinite(options.publicTimeoutMs) && options.publicTimeoutMs > 0 ? options.publicTimeoutMs : undefined
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
  const onSettled = typeof options.onSettled === 'function' ? options.onSettled : () => {}
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
  // Across workers and runs: an already-dispatched mutation cannot be cancelled.
  let writeChain = Promise.resolve()
  let activeWrite
  let latestWriteSettlement

  const warn = (message, error) => {
    if (typeof logger.warn === 'function') {
      logger.warn(message)
      if (error !== undefined) logger.warn(error)
    }
  }

  const snapshot = () => ({
    ...state,
    tokenizer: undefined,
    pendingWrite: activeWrite?.dispatched ? { provider: activeWrite.provider, model: activeWrite.model, startedAt: activeWrite.startedAt, waitEnded: activeWrite.waitEnded } : undefined,
    latestWriteSettlement: latestWriteSettlement && { ...latestWriteSettlement },
    tokenUsage: [...state.tokenUsage],
    searchBackends: { ...state.searchBackends },
    batches: state.batches.map((batch) => ({ ...batch, ids: [...batch.ids], ...(batch.written ? { written: [...batch.written] } : {}) })),
    errors: [...state.errors],
    sources: state.sources.map((entry) => ({ ...entry })),
  })

  const noteUsage = (entry, checker, owner) => {
    const usage = entry.usage
    if (usage === undefined) return
    const values = [
      Math.max(0, Math.trunc(usage.inputTokens ?? 0)),
      Math.max(0, Math.trunc(usage.outputTokens ?? 0)),
      Math.max(0, Math.trunc(usage.cacheReadTokens ?? 0)),
      Math.max(0, Math.trunc(usage.cacheWriteTokens ?? 0)),
    ]
    for (let index = 0; index < 4; index += 1) owner.tokenUsage[index] += values[index]
    ledger?.notePluginUsage({
      time: now(),
      provider: checker?.provider,
      model: checker?.model,
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
    state.sources = publicReport
    if (signal?.aborted || disposed) {
      entry.status = 'cancelled'
      return new Map()
    }
    const controller = new AbortController()
    const abortFetch = () => controller.abort()
    signal?.addEventListener('abort', abortFetch, { once: true })
    publicControllers.add(controller)
    const modelsDevApi = url === PUBLIC_SOURCES.modelsDevApi
    const timeoutMs = publicTimeoutMs ?? (modelsDevApi ? MODELS_DEV_API_TIMEOUT_MS : PUBLIC_TIMEOUT_MS)
    const maxAttempts = modelsDevApi ? 2 : 1
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        entry.attempts = attempt
        let phase = 'request'
        let result
        try {
          // Fetch and drain under one deadline and one signal. A deadline is a
          // timeout; only aborting the parent is a user cancellation.
          result = await boundedOperation(async localSignal => {
            const response = await fetchImpl(url, {
              headers: { accept: 'application/json' },
              signal: localSignal,
              redirect: 'error',
            })
            if (localSignal.aborted || !response.ok) {
              cancelCatalogBody(response)
              localSignal.throwIfAborted()
              return { status: response.status }
            }
            phase = 'body'
            const declared = Number(response.headers?.get?.('content-length'))
            if (Number.isFinite(declared) && declared > PUBLIC_BODY_LIMIT) {
              cancelCatalogBody(response)
              throw new Error('response body is too large')
            }
            return { text: await readResponseText(response, PUBLIC_BODY_LIMIT, localSignal) }
          }, { signal: controller.signal, timeoutMs, label: 'public catalog download' })
        } catch (error) {
          controller.signal.throwIfAborted()
          if (error?.message === 'response body is too large') {
            entry.status = 'too-large'
            entry.message = `over ${PUBLIC_BODY_LIMIT} bytes`
            warn(`model-visibility: public catalog ${url} is too large`, error)
            return new Map()
          }
          if (attempt < maxAttempts && transientCatalogFailure(error, phase)) continue
          entry.status = 'failed'
          entry.message = error?.code === 'TIMEOUT'
            ? `${phase}: 请求超时（${timeoutMs} ms）`
            : `${phase}: ${transportMessageOf(error)}`
          warn(`model-visibility: public catalog ${url} unavailable`, error)
          return new Map()
        }
        if (result.text === undefined) {
          if (attempt < maxAttempts && RETRYABLE_CATALOG_STATUS.has(result.status)) continue
          entry.status = 'http'
          entry.message = `HTTP ${result.status}`
          return new Map()
        }
        let body
        try {
          body = JSON.parse(result.text)
        } catch (_error) {
          entry.status = 'bad-json'
          return new Map()
        }
        const facts = parser(body)
        entry.models = facts.size
        entry.bytes = Buffer.byteLength(result.text, 'utf8')
        entry.status = facts.size > 0 ? 'ok' : 'empty'
        return facts
      }
    } catch (error) {
      if (controller.signal.aborted) entry.status = 'cancelled'
      else {
        entry.status = 'failed'
        entry.message = transportMessageOf(error)
        warn(`model-visibility: public catalog ${url} unavailable`, error)
      }
      return new Map()
    } finally {
      signal?.removeEventListener('abort', abortFetch)
      publicControllers.delete(controller)
    }
  }

  /**
   * Read every public catalog.
   *
   * The provider-free models.dev list supplies canonical metadata; its
   * provider-qualified `api.json` fills native efforts before other catalogs
   * can supply their route-specific options. A failure in one source
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
    return mergePublicSources(modelsDevFree, modelsDevAll, openRouter, huggingFace)
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

  const formatError = message => Object.assign(new Error(message), { code: 'CHECKER_FORMAT' })
  const recoverableShape = code => ['CHECKER_FORMAT', 'CHECKER_TRUNCATED'].includes(code)

  /** One bounded split of still-unresolved offline IDs; never replay paid searches. */
  const runBatchResilient = async (ids, publicFacts, checker, signal, activity) => {
    const initial = await runBatch(ids, publicFacts, checker, signal, activity)
      .catch(error => {
        if (signal.aborted || state.webSearch || ids.length <= 1 || !recoverableShape(error?.code)) throw error
        return Object.assign([], { failedIds: ids, errors: [error.message], errorCode: error.code })
      })
    const unresolved = initial.failedIds ?? []
    if (state.webSearch || unresolved.length <= 1 || !recoverableShape(initial.errorCode)) return initial

    const results = [...initial]
    const failedIds = []
    const errors = []
    let errorCode
    const half = Math.ceil(unresolved.length / 2)
    const groups = [unresolved.slice(0, half), unresolved.slice(half)]
    for (const [i, group] of groups.entries()) {
      try {
        const part = await runBatch(group, publicFacts, checker, signal, activity, { recovery: true, repair: false })
        results.push(...part)
        failedIds.push(...(part.failedIds ?? []))
        errors.push(...(part.errors ?? []))
        errorCode ??= part.errorCode
      } catch (error) {
        if (signal.aborted) throw error
        failedIds.push(...group)
        errors.push(`${group.join(', ')}: ${error?.message ?? String(error)}`)
        errorCode = error?.code ?? errorCode
        if (!recoverableShape(error?.code)) {
          // Transport/auth will not improve by spending again on the other half.
          failedIds.push(...groups.slice(i + 1).flat())
          break
        }
      }
    }
    if (results.length === 0) throw Object.assign(new Error(initial.errors?.join('; ') || errors.join('; ')), { code: errorCode ?? initial.errorCode })
    return Object.assign(results, { failedIds, errors, errorCode })
  }

  /** Parse and retain usable rows from each paid answer, retrying only missing IDs. */
  const runBatch = async (ids, publicFacts, checker, signal, activity, { recovery = false, repair = true } = {}) => {
    signal.throwIfAborted()
    activity.attempts = (activity.attempts ?? 0) + 1
    const owner = state
    const online = owner.webSearch
    const finalSystem = checkerSystemPrompt(online)
    const reply = await callChecker({ llm, web, searchBridge, checker,
      system: online ? checkerLookupPrompt() : finalSystem,
      synthesisSystem: finalSystem,
      publicSearchIds: online ? ids.filter(id => lookupPublicMatch(publicFacts, id)?.exact) : undefined,
      input: batchPrompt(ids, { lookup: online }), finalInput: batchPrompt(ids), signal,
      timeoutMs: defaultTimeoutMs,
      maxTokens: defaultCheckerMaxTokens,
      effort: defaultCheckerEffort, webSearch: online, recovery,
      noteUsage: entry => noteUsage(entry, checker, owner), onActivity: stage => { if (!signal.aborted) activity.stage = stage },
      onWebCall: (type, backend) => {
        if (signal.aborted) return
        state[type === 'search' ? 'searchCalls' : 'fetchCalls'] += 1
        if (type === 'search' && (backend === 'dsh-free-search' || backend === 'host-web')) {
          state.searchBackends[backend] = (state.searchBackends[backend] ?? 0) + 1
        }
      },
    })
    const accepted = new Map()
    const remaining = () => ids.filter(id => !accepted.has(id))
    const inspect = (text, asked, interrupted = false) => {
      const parsed = exactCheckerJson(text)
      const recovered = parsed === undefined && interrupted ? recoverCompleteCheckerRows(text) : parsed
      const shape = validateReplyShape(recovered, asked, { allowedUrls: online ? reply.allowedUrls : undefined })
      for (const row of shape.validRows) if (!accepted.has(row.id)) accepted.set(row.id, row)
      if (parsed === undefined && !shape.validRows.length) return text?.trim() ? 'the checker reply contained no JSON' : 'the checker returned an empty reply'
      return shape.ok && parsed !== undefined ? undefined : shape.reasons.join('; ').slice(0, 360) || 'the checker did not complete JSON'
    }
    let terminalError = reply.error
    let problem = inspect(reply.text, ids, Boolean(terminalError))
    problem = terminalError?.message ?? problem
    const pendingIds = remaining()
    if (repair && problem !== undefined && pendingIds.length && reply.canRepair) {
      const truncated = terminalError?.code === 'CHECKER_TRUNCATED'
      const split = truncated && pendingIds.length > 1
      const middle = Math.ceil(pendingIds.length / 2)
      const chunks = split ? [pendingIds.slice(0, middle), pendingIds.slice(middle)] : [pendingIds]
      const failures = []
      for (const chunk of chunks) {
        signal.throwIfAborted()
        activity.attempts += 1
        try {
          const fixed = await reply.retryFormat(problem, { ids: chunk, compact: truncated, split })
          const issue = inspect(fixed, chunk)
          if (issue !== undefined) failures.push(issue)
          else if (!failures.length) terminalError = undefined
        } catch (error) {
          signal.throwIfAborted()
          inspect(error?.partialText, chunk, true)
          terminalError = error
          failures.push(error?.message ?? String(error))
          // No further dispatch after a transport/auth failure. Truncation is
          // row-local; the other half can still fit and recover its own facts.
          if (error?.code !== 'CHECKER_TRUNCATED') break
        }
      }
      problem = failures.length ? `${problem}; repair: ${failures.join('; ')}` : undefined
    }
    const unresolved = remaining()
    if (!accepted.size && unresolved.length) throw terminalError ?? formatError(`checker format violation: ${(problem ?? 'missing model IDs').slice(0, 420)}`)
    const results = parseCheckerAnswer(ids.map(id => accepted.get(id)).filter(Boolean), ids, publicFacts, { fuzzy: state.fuzzyMatch, validated: true })
    if (unresolved.length) {
      results.failedIds = unresolved
      results.errors = [`${unresolved.length}/${ids.length} unresolved: ${(problem ?? 'no valid checker row').slice(0, 420)}`]
      results.errorCode = terminalError?.code ?? 'CHECKER_FORMAT'
    }
    return results
  }

  /** Queue ordinary writes serially; a dispatched operation that outlives its wait owns the slot. */
  const queueWrite = (entry, signal) => {
    const pendingResult = () => ({ written: false, reason: 'write-pending' })
    if (activeWrite?.waitEnded) return Promise.resolve(pendingResult())
    const job = { provider: entry.provider, model: entry.model, startedAt: undefined, waitEnded: undefined, dispatched: false }
    // Wake queued callers when the active operation outlives its deadline or sweep.
    let release
    const ready = new Promise(resolve => { release = resolve })
    const task = writeChain.then(async () => {
      if (signal.aborted || disposed || activeWrite?.waitEnded) return pendingResult()
      activeWrite = job
      try {
        const result = await writeCapabilities(settings, {
          provider: entry.provider, model: entry.model, input: entry.fact.input,
          contextWindow: entry.fact.contextWindow, efforts: entry.fact.reasoningEfforts,
          reasoningSupported: entry.fact.reasoning,
        }, { automatic: true, llm, configEditor, onDispatch: () => {
          signal.throwIfAborted()
          job.dispatched = true
          job.startedAt = now()
        } })
        if (job.waitEnded && job.dispatched) {
          latestWriteSettlement = { provider: job.provider, model: job.model, written: result.written === true,
            reason: result.reason, message: result.message, finishedAt: now() }
        }
        if (job.dispatched && !disposed) {
          try { onApplied(entry.provider, entry.model) } catch (error) { warn('model-visibility: settings settlement callback failed', error) }
        }
        return result
      } catch (error) {
        if (job.waitEnded && job.dispatched) latestWriteSettlement = { provider: job.provider, model: job.model, written: false, message: error?.message ?? String(error), finishedAt: now() }
        throw error
      } finally {
        if (activeWrite === job) activeWrite = undefined
      }
    })
    // Tail waiters can stop waiting after an in-flight timeout, but no new mutation may pass this tail.
    const previous = activeWrite
    const wait = previous ? Promise.race([task, previous.release]) : task
    job.release = ready
    writeChain = task.catch(() => {})
    const markAbandoned = () => {
      if (activeWrite !== job) return
      job.waitEnded = signal.reason?.code ?? 'CANCELLED'
      release(pendingResult())
    }
    signal.addEventListener('abort', markAbandoned, { once: true })
    return wait.finally(() => signal.removeEventListener('abort', markAbandoned))
  }

  /**
   * The sweep itself; run once at a time.
   * @param options.checker - `{ provider, model }` to use as the checker.
   * @param options.writeBack - mirror confirmed facts into provider settings.
   * @param options.fullScan - re-check known models instead of skipping them.
   * @param options.concurrency - simultaneous checker calls for THIS run
   *   (clamped to {@link MAX_CONCURRENCY}); omitted keeps the constructor value.
   */
  const startVerification = async ({ mode, checker, writeBack = defaultWriteBack, concurrency, fullScan = false, useChecker = true, fuzzyMatch, webSearch = options.webSearch ?? Boolean(web) } = {}) => {
    if (disposed) return snapshot()
    // A cancelled sweep keeps its workers alive until their in-flight call
    // settles. Joining that run instead of racing it is what stops two workers
    // from writing the same `state` and reporting done > total.
    if (running !== null) return running
    if (state.running) return snapshot()
    const provider = nonEmpty(checker?.provider)
    const model = nonEmpty(checker?.model)
    if (mode !== undefined && !VERIFY_SOURCE_MODES.includes(mode)) {
      throw new TypeError('invalid verification mode')
    }
    const runChecker = mode === undefined ? useChecker !== false : mode !== 'public'
    if (runChecker && (provider === undefined || model === undefined)) {
      state = { ...idleState(), phase: 'error', errors: ['choose the checking provider/model first'] }
      return snapshot()
    }
    const run = runSweep({ provider, model, mode, writeBack, concurrency,
      webSearch: mode === undefined ? webSearch : mode !== 'public',
      fullScan: mode === 'checker' || fullScan,
      useChecker: runChecker,
      fuzzyMatch: fuzzyMatch === undefined ? mode !== undefined : fuzzyMatch === true,
    })
    running = run
    try {
      return await run
    } finally {
      if (running === run) running = null
    }
  }

  /** One sweep against the checker route, from catalog read to flush. */
  const runSweep = async ({ provider, model, mode, writeBack, concurrency, webSearch, fullScan, useChecker, fuzzyMatch }) => {
    if (disposed) return snapshot()
    const workers = Number.isFinite(concurrency)
      ? Math.max(1, Math.min(MAX_CONCURRENCY, Math.trunc(concurrency)))
      : concurrencyLimit
    publicReport = []
    state = {
      ...idleState(),
      running: true,
      phase: mode === undefined ? 'public' : 'listing',
      mode,
      fullScan: fullScan === true,
      startedAt: now(),
      checker: useChecker ? { provider, model } : undefined,
      writeBack: useChecker && writeBack,
      useChecker,
      fuzzyMatch,
      webSearch: useChecker && webSearch === true,
      concurrency: workers,
    }
    abort = new AbortController()
    const signal = abort.signal
    const settle = phase => {
      if (!disposed) {
        try { onSettled() } catch (error) { warn('model-visibility: sweep settlement callback failed', error) }
      }
      state.phase = phase
      state.running = false
      state.finishedAt = now()
    }
    try {
      // Target list: every model the registry offers, grouped per route.
      const targetProviders = []
      const catalogNames = new Map()
      const listedProviders = llm.listProviders()
      const providerList = Array.isArray(listedProviders) ? listedProviders : []
      for (const route of providerList) {
        signal.throwIfAborted()
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
          signal.throwIfAborted()
          state.errors.push(`route ${id}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const ids = new Set()
        for (const item of models) {
          const modelId = nonEmpty(item?.id)
          if (!modelId) continue
          ids.add(modelId)
          const name = nonEmpty(item?.name) ?? modelId
          catalogNames.set(modelId, !catalogNames.has(modelId) || catalogNames.get(modelId) === name ? name : null)
        }
        if (ids.size > 0) targetProviders.push({ id, ids: [...ids] })
      }
      // Only identical IDs collapse across routes; retain vendor and suffix.
      const targets = new Set(targetProviders.flatMap(route => route.ids))
      const eligible = []
      for (const id of targets) {
        if (useChecker && id === model) continue
        const known = !state.fullScan && learned?.getExact?.(id)
        const stalePublic = (mode === 'public' || mode === 'supplement') && known?.publicCatalogRevision !== PUBLIC_CATALOG_REVISION &&
          (known?.origins?.includes('public') || known?.reasoning === undefined || known?.reasoning === true && !known?.reasoningEfforts?.length)
        if (known && !stalePublic && !known.legacyPublic && (!known.publicAlias || ((mode === 'supplement' || !useChecker) && fuzzyMatch))
          && (!useChecker || mode === 'supplement' || known.origins?.includes('checker'))) {
          state.skippedKnown += 1
          continue
        }
        eligible.push(id)
      }
      state.total = eligible.length
      signal.throwIfAborted()
      if (state.writeBack && !state.fullScan && state.skippedKnown > 0) {
        state.errors.push('Write-back skipped existing learned entries; run a full scan with write-back enabled to re-verify them before writing settings.')
      }
      if (state.total === 0) {
        state.catalogTargets = 0
        state.checkerTargets = 0
        if (!state.fuzzyMatch && mode !== 'checker') learned.dropPublicAliases?.()
        settle('done')
        return snapshot()
      }
      state.catalogTargets = mode === 'checker' ? 0 : eligible.length
      state.phase = mode === 'checker' ? 'verifying' : 'public'
      const publicFacts = mode === 'checker' ? new Map() : await publicIndex(signal)
      // Publish the per-source outcome: "the catalogs returned nothing" needs
      // to be distinguishable from "a catalog errored".
      state.sources = publicReport.map((entry) => ({ ...entry }))
      if (signal.aborted) throw new Error('verification cancelled')
      if (mode !== 'checker' && publicFacts.size === 0 && state.sources.every((entry) => entry.status !== 'ok')) {
        state.errors.push(
          'no public catalog could be read (' +
            state.sources.map((entry) => `${entry.name}: ${entry.status}${entry.message ? ' ' + entry.message : ''}`).join(', ') +
            ')',
        )
      }
      const catalogOptions = { fuzzy: state.fuzzyMatch, names: catalogNames }
      const fromCatalog = mode === 'supplement' || mode === 'public'
        ? new Map(publicOnlyFacts(eligible, [], publicFacts, catalogOptions).map(result => [result.id, result]))
        : new Map()
      if (mode !== undefined) state.catalogMatches = fromCatalog.size
      const checkerIds = useChecker ? eligible.filter(id => !fromCatalog.has(id)) : []
      state.checkerTargets = checkerIds.length
      const batches = []
      const group = (ids, source) => {
        for (let offset = 0; offset < ids.length; offset += batchSize) {
          batches.push({ ids: ids.slice(offset, offset + batchSize), source })
        }
      }
      group(useChecker ? eligible.filter(id => fromCatalog.has(id)) : eligible, 'catalog')
      group(checkerIds, 'checker')
      state.batches = batches.map(batch => ({ ...batch, status: 'pending' }))
      if (checkerIds.length && state.webSearch && !searchBridge && typeof web?.search !== 'function') {
        state.errors.push(mode === undefined
          ? 'web search service unavailable; configure a DSH search provider or disable web search'
          : 'web search service unavailable; configure a DSH search provider or switch to public catalog mode')
      }
      state.phase = 'verifying'
      // Concurrent batches, results merged into the learned store.
      let next = 0
      // Each worker persists its batch once, and publishes facts/counts only on commit.
      let flushChain = Promise.resolve()
      let persistenceFailure
      let blockedWriteReported = false
      const flush = batch => {
        if (batch.length === 0 || signal.aborted || disposed) return Promise.resolve(false)
        flushChain = flushChain.then(async () => {
          if (signal.aborted || disposed) return false
          await learned.upsertEntries(
            batch.map((entry) => ({ ...entry.fact, id: entry.id, origins: entry.origins })),
            { verifiedAt: now(), checker: batch.some(entry => entry.origins.includes('checker')) ? state.checker : undefined },
          )
          return true
        }).catch(error => {
          persistenceFailure ??= Object.assign(new Error(`could not save the learned snapshot: ${error?.message ?? String(error)}`), { code: 'LEARNED_PERSISTENCE', cause: error })
          throw persistenceFailure
        })
        return flushChain
      }

      const worker = async () => {
        for (;;) {
          if (signal.aborted || persistenceFailure) return
          const index = next
          if (index >= batches.length) return
          next += 1
          const { ids, source } = batches[index]
          const activity = state.batches[index]
          activity.status = 'running'
          activity.startedAt = now()
          activity.stage = source === 'checker' ? 'checker' : 'flush'
          let verified = 0
          /** Ids the checker actually returned a verdict for. */
          let answered = []
          let batchFailed = false
          let failedIds = []
          const pending = []
          const ingest = (results) => {
            for (const result of results) {
              if (signal.aborted || persistenceFailure) break
              if (result.fact === null || answered.includes(result.id)) continue
              const sanitized = sanitizeLearned({
                ...result.fact,
                publicAlias: result.publicAlias === true,
                origins: result.origins,
                publicCatalogRevision: mode !== 'checker' && result.origins?.length === 1 && result.origins[0] === 'public'
                  ? PUBLIC_CATALOG_REVISION : undefined,
                provider: undefined,
              })
              if (sanitized === undefined) continue
              answered.push(result.id)
              pending.push({
                id: sanitized.id,
                fact: sanitized.entry,
                origins: result.origins?.length ? result.origins : ['checker'],
                writeFact: result.writeFact && sanitizeLearned({ id: result.id, ...result.writeFact })?.entry,
              })
            }
          }
          const apply = async () => {
            activity.stage = 'flush'
            if (!await flush(pending)) return
            verified = pending.length
            for (const result of pending) {
              if (result.origins.length === 1 && result.origins[0] === 'public') state.publicOnly += 1
              if (result.fact.publicAlias) state.aliasMatches += 1
            }
            activity.verified = verified
            if (!state.writeBack) return
            for (const result of pending) {
              if (!result.writeFact || signal.aborted || disposed) continue
              // Exact destination and independently matched source fields.
              for (const route of targetProviders) {
                if (signal.aborted || disposed) return
                if (!route.ids.includes(result.id)) continue
                const routeModel = result.id
                activity.stage = 'writeBack'
                let applied
                try {
                  applied = await boundedOperation(writeSignal => queueWrite({
                    provider: route.id, model: routeModel, fact: result.writeFact,
                  }, writeSignal), { signal, timeoutMs: defaultTimeoutMs, label: 'provider write-back' })
                } catch (error) {
                  if (signal.aborted) return
                  const dispatched = activeWrite?.provider === route.id && activeWrite.model === routeModel && activeWrite.dispatched
                  state.errors.push(`write-back ${route.id}/${routeModel}: ${error?.message ?? String(error)}${dispatched ? '; dispatched settings mutation still pending' : ''}`)
                  continue
                }
                if (signal.aborted || disposed) return
                if (applied?.written) {
                  activity.written = [...(activity.written ?? []), `${route.id}/${routeModel}`]
                } else if (applied?.reason === 'write-pending') {
                  if (!blockedWriteReported) state.errors.push('Provider write-back paused: a previous dispatched settings mutation has not settled; skipped writes require a new full scan.')
                  blockedWriteReported = true
                } else if (['settings-failed', 'settings-unverified', 'describe-failed', 'revision-unavailable', 'config-provenance-unavailable', 'expression-backed'].includes(applied?.reason)) {
                  state.errors.push(`write-back ${route.id}/${routeModel}: ${applied.message ?? applied.reason}`)
                }
              }
            }
          }
          try {
            const results = source === 'checker' ? await boundedOperation(batchSignal =>
              runBatchResilient(ids, publicFacts, state.checker, batchSignal, activity),
              { signal, timeoutMs: defaultTimeoutMs * 2, label: 'checker batch' }) : ids.map(id => fromCatalog.get(id)).filter(Boolean)
            failedIds = results.failedIds ?? []
            if (results.errorCode) activity.errorCode = results.errorCode
            for (const message of results.errors ?? []) state.errors.push(`batch ${index + 1}: ${message}`)
            ingest(results)
            // Whatever the checker skipped may still be described by a public
            // catalog. Those facts were downloaded already, so recording them
            // costs nothing and is the difference between "0 facts" and a
            // usable table when the checker is weak.
            const filled = mode === undefined ? publicOnlyFacts(ids, answered, publicFacts, catalogOptions) : []
            ingest(filled)
            await apply()
            state.batches[index].status = signal.aborted ? 'cancelled' : failedIds.length ? 'partial' : 'ok'
          } catch (error) {
            batchFailed = !signal.aborted
            if (!signal.aborted && !disposed && !persistenceFailure) {
              const filled = mode === undefined ? publicOnlyFacts(ids, answered, publicFacts, catalogOptions) : []
              ingest(filled)
              try { await apply() } catch (saveError) {
                // A failed public fallback flush is still a persistence error, not checker transport.
                error = saveError
              }
            }
            state.batches[index].status = signal.aborted ? 'cancelled' : 'failed'
            state.batches[index].error = error instanceof Error ? error.message : String(error)
            if (typeof error?.code === 'string') activity.errorCode = error.code
            if (!signal.aborted && !persistenceFailure) {
              state.errors.push(`batch ${index + 1}: ${state.batches[index].error}`)
            }
          } finally {
            // Count what was actually verified: the checker legitimately skips
            // models or answers "unknown", so `done` must never assume the whole
            // batch landed (that produced done=36 / total=23).
            activity.finishedAt = now()
            state.done = Math.min(state.total, state.done + verified)
            if (signal.aborted) {
              state.processed = Math.min(state.total, state.processed + verified)
            } else {
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
      if (persistenceFailure) throw persistenceFailure
      if (rejected) throw rejected.reason
      // An aborted/disposed sweep persists only the batches flushed before the
      // stop request; no new write may begin while the Host is unloading.
      if (!signal.aborted && !disposed) {
        if (!state.fuzzyMatch && mode !== 'checker') learned.dropPublicAliases?.()
      }
      if (!signal.aborted) learned.meta()
      settle(signal.aborted ? 'cancelled' : 'done')
    } catch (error) {
      settle(signal?.aborted ? 'cancelled' : 'error')
      state.errors.push(error instanceof Error ? error.message : String(error))
      warn('model-visibility: verify sweep failed', error)
    } finally {
      abort = null
    }
    return snapshot()
  }

  return {
    snapshot,
    start: startVerification,
    cancel() {
      if (abort !== null) abort.abort()
      // Do NOT flip `running` here: the workers are still unwinding, and a
      // false `running` let a second sweep start on top of them. The sweep
      // itself publishes the cancelled state when it finishes unwinding.
      if (state.running) state.phase = 'cancelled'
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
