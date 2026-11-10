/**
 * Relay/provider probing for real capability metadata.
 *
 * DSH's LLM registry knows which provider routes exist, but for a custom
 * relay (`llm-pi-ai` with `api: openai-completions` + a `baseURL`) the adapter
 * only forwards the provider's static `defaultInput` — everything else is
 * unknown. The relay itself often publishes more: an OpenAI-compatible
 * `/v1/models` may carry `architecture.input_modalities` (OpenRouter format) or
 * `input_modalities`, and New API style gateways expose `supported_endpoint_types`
 * through `/api/pricing` (kind: chat / image-generation / embeddings / …).
 *
 * This module reads the provider profiles from the settings document, resolves
 * each `apiKeyEnv` reference through the credentials seam *per read* (never
 * cached, never returned), probes the endpoint with a short timeout and keeps
 * only detached capability facts. Nothing here writes settings, stores keys or
 * logs response bodies.
 *
 * Everything is best-effort: a failed probe produces a diagnostic and the page
 * falls back to the adapter declaration + built-in catalog.
 *
 * @module lib/provider-probe
 */

/** Default lifetime of one probe snapshot. */
export const DEFAULT_PROBE_TTL_MS = 10 * 60_000
/** Per-request timeout; providers are probed concurrently. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3500
/** Responses larger than this are refused instead of parsed. */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Capabilities we are willing to forward. */
const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'file'])

/** Read a non-empty string, or undefined. */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Keep positive safe integers only. */
function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Normalize an adapter/endpoint modality list.
 * @param value - unknown list.
 * @returns detached lowercase modalities, or undefined when nothing remains.
 */
export function normalizeModalities(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    let id = item.trim().toLowerCase()
    if (id === 'vision') id = 'image'
    if (id === 'text_only') id = 'text'
    if (!MODALITIES.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out.length > 0 ? out : undefined
}

/** Parse OpenRouter's `"text+image->image"` modality notation. */
function splitArchitectureModality(value) {
  if (typeof value !== 'string' || !value.includes('->')) return {}
  const [left, right] = value.split('->', 2)
  const parse = (part) => normalizeModalities(part.split('+').map((item) => item.trim()))
  return { input: parse(left), output: parse(right) }
}

/** Map an endpoint-type name (New API) to a model kind. */
function kindOfEndpoint(type) {
  if (typeof type !== 'string') return undefined
  const id = type.toLowerCase()
  if (id.includes('image')) return 'image'
  if (id.includes('video')) return 'video'
  if (id.includes('embedding')) return 'embedding'
  if (id.includes('rerank')) return 'rerank'
  if (id.includes('audio') || id.includes('speech') || id.includes('tts')) return 'audio'
  if (id.includes('moderation') || id.includes('classifier') || id.includes('safety')) return 'classifier'
  if (id.includes('translation')) return 'translation'
  if (id.includes('chat') || id.includes('completion')) return 'chat'
  return undefined
}

/** Map an explicit `type`/`model_type` field to a kind. */
function kindOfType(type) {
  if (typeof type !== 'string') return undefined
  const id = type.toLowerCase()
  if (['chat', 'text', 'completion', 'language'].includes(id)) return 'chat'
  if (['image', 'image-generation', 'imagegeneration'].includes(id)) return 'image'
  if (['video', 'video-generation', 'videogeneration'].includes(id)) return 'video'
  if (['embedding', 'embeddings', 'embed'].includes(id)) return 'embedding'
  if (['rerank', 'reranker', 'reranking'].includes(id)) return 'rerank'
  if (['audio', 'speech', 'tts', 'transcription'].includes(id)) return 'audio'
  if (['classifier', 'moderation', 'guard', 'safety'].includes(id)) return 'classifier'
  if (['translation', 'translate'].includes(id)) return 'translation'
  return undefined
}

/** Kind implied by output modalities, when an endpoint publishes them. */
function kindOfOutput(output) {
  if (!Array.isArray(output)) return undefined
  if (output.includes('video')) return 'video'
  if (output.includes('image')) return 'image'
  if (output.includes('audio')) return 'audio'
  if (output.includes('text')) return 'chat'
  return undefined
}

/** Kinds implied by OpenRouter's `supported_parameters`-style capability lists. */
function reasoningOf(entry) {
  const capabilities = entry?.capabilities
  if (capabilities !== null && typeof capabilities === 'object') {
    if (typeof capabilities.reasoning === 'boolean') return capabilities.reasoning
    if (typeof capabilities.reasoning_effort === 'boolean') return capabilities.reasoning_effort
  }
  if (typeof entry?.reasoning === 'boolean') return entry.reasoning
  const params = entry?.supported_parameters
  if (Array.isArray(params)) {
    for (const param of params) {
      if (typeof param !== 'string') continue
      const id = param.toLowerCase()
      if (id === 'reasoning' || id === 'reasoning_effort' || id === 'thinking' || id === 'include_reasoning') return true
    }
  }
  return undefined
}

/** Endpoint-type list from an array or a JSON-encoded string. */
function endpointTypesOf(raw) {
  let value = raw?.supported_endpoint_types
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (_error) {
      return []
    }
  }
  return Array.isArray(value) ? value.map(kindOfEndpoint).filter(Boolean) : []
}

/** Read one advertised model entry from any endpoint dialect. */
export function readModelEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = str(raw.id) ?? str(raw.model) ?? str(raw.model_name) ?? str(raw.name)
  if (id === undefined) return undefined
  const architecture = raw.architecture !== null && typeof raw.architecture === 'object' ? raw.architecture : undefined
  const split = splitArchitectureModality(architecture?.modality)
  const input =
    normalizeModalities(architecture?.input_modalities) ??
    normalizeModalities(raw.input_modalities) ??
    normalizeModalities(raw.inputModalities) ??
    normalizeModalities(raw.input) ??
    (raw.supports_vision === true ||
    raw.vision === true ||
    architecture?.vision === true ||
    raw.capabilities?.vision === true
      ? ['text', 'image']
      : undefined) ??
    split.input
  const output =
    normalizeModalities(architecture?.output_modalities) ??
    normalizeModalities(raw.output_modalities) ??
    normalizeModalities(raw.outputModalities) ??
    normalizeModalities(raw.output) ??
    split.output
  const endpointKinds = endpointTypesOf(raw)
  const kind =
    kindOfType(raw.type) ??
    kindOfType(raw.model_type) ??
    (endpointKinds.includes('image') ? 'image' : undefined) ??
    (endpointKinds.includes('video') ? 'video' : undefined) ??
    kindOfOutput(output) ??
    endpointKinds[0]
  const contextWindow =
    positive(raw.context_length) ??
    positive(raw.context_window) ??
    positive(raw.contextWindow) ??
    positive(raw.max_input_tokens) ??
    positive(raw.limit?.context)
  const maxTokens = entryMaxTokens(raw)
  const reasoning = reasoningOf(raw)
  return {
    id,
    ...(str(raw.name) === undefined ? {} : { name: raw.name.trim() }),
    ...(input === undefined ? {} : { inputModalities: input }),
    ...(output === undefined ? {} : { outputModalities: output }),
    ...(kind === undefined ? {} : { kind }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/** Aggregate the several spellings of an output cap in OpenAI-ish listings. */
function entryMaxTokens(raw) {
  return (
    positive(raw.max_output_tokens) ??
    positive(raw.max_completion_tokens) ??
    positive(raw.max_tokens) ??
    positive(raw.maxTokens) ??
    positive(raw.top_provider?.max_completion_tokens) ??
    positive(raw.limit?.output)
  )
}

/**
 * Parse one `/models` response.
 * @param body - parsed JSON in any dialect the relays use.
 * @returns a Map of exact model id to detached capability facts.
 */
export function parseModelListing(body) {
  const out = new Map()
  let entries = []
  if (Array.isArray(body)) entries = body
  else if (body !== null && typeof body === 'object') {
    if (Array.isArray(body.data)) entries = body.data
    else if (Array.isArray(body.models)) entries = body.models
    else if (body.models !== null && typeof body.models === 'object') {
      entries = Object.entries(body.models).map(([key, value]) => ({
        id: key,
        ...(value !== null && typeof value === 'object' ? value : {}),
      }))
    }
  }
  for (const raw of entries) {
    const record = readModelEntry(raw)
    if (record === undefined) continue
    out.set(record.id, record)
  }
  return out
}

/**
 * Build the model-id set from a New API `/api/pricing` response.
 *
 * A relay that refuses or times out on `/models` usually still answers the
 * public pricing endpoint, and a bare id list is enough for the page to show
 * the right total and to classify every model it serves.
 * @param body - parsed `/api/pricing` payload.
 * @returns a Map of model id to `{ id }` (kind filled in by the caller).
 */
export function parsePricingIds(body) {
  const out = new Map()
  const data = body !== null && typeof body === 'object' && Array.isArray(body.data) ? body.data : []
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue
    const id = str(raw.model_name) ?? str(raw.model) ?? str(raw.modelName) ?? str(raw.id)
    if (id === undefined) continue
    out.set(id, { id })
  }
  return out
}

/**
 * Parse New API's `/api/pricing` response (model kind only).
 * @param body - parsed JSON.
 * @returns a Map of model id to `{ kind }`.
 */
export function parsePricing(body) {
  const out = new Map()
  const data = body !== null && typeof body === 'object' && Array.isArray(body.data) ? body.data : []
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue
    const id = str(raw.model_name) ?? str(raw.model) ?? str(raw.modelName)
    if (id === undefined) continue
    const kinds = endpointTypesOf(raw)
    const kind = kinds.includes('image') ? 'image' : kinds.includes('video') ? 'video' : kinds[0]
    if (kind !== undefined) out.set(id, { kind })
  }
  return out
}

/**
 * Read provider profiles from `settings.describe()` output.
 *
 * A profile is any settings value shaped `{ providers: { <id>: { baseURL,
 * apiKeyEnv, api, models, ... } } }` — that is the `llm-pi-ai` schema, but the
 * reader does not hardcode the namespace so future adapters work too.
 * @param descriptors - the settings descriptors.
 * @returns Map provider id -> profile.
 */
export function readProviderProfiles(descriptors) {
  const profiles = new Map()
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    const value = descriptor?.value
    if (value === null || typeof value !== 'object') continue
    const providers = value.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue
    for (const [id, raw] of Object.entries(providers)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const baseURL = str(raw.baseURL)
      if (baseURL === undefined) continue
      const models = new Map()
      for (const model of Array.isArray(raw.models) ? raw.models : []) {
        if (model === null || typeof model !== 'object') continue
        const modelId = str(model.id)
        if (modelId !== undefined) models.set(modelId, model)
      }
      const headers = {}
      if (raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
        for (const [name, headerValue] of Object.entries(raw.headers)) {
          if (typeof headerValue === 'string') headers[name] = headerValue
        }
      }
      const profile = {
        id,
        namespace: typeof descriptor.ns === 'string' ? descriptor.ns : undefined,
        api: str(raw.api) ?? 'openai-completions',
        baseURL,
        apiKeyEnv: str(raw.apiKeyEnv),
        headers,
        defaultInput: normalizeModalities(raw.defaultInput),
        defaultContextWindow: positive(raw.defaultContextWindow),
        models,
      }
      const previous = profiles.get(id)
      // A namespace that actually carries a model list wins over an empty shell.
      if (previous === undefined || models.size >= previous.models.size) profiles.set(id, profile)
    }
  }
  return profiles
}

/** Stable fingerprint of the routing facts that affect a probe. */
export function profileSignature(profiles) {
  const parts = []
  for (const profile of [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    parts.push([
      profile.id,
      profile.api ?? '',
      profile.baseURL ?? '',
      profile.apiKeyEnv ?? '',
      JSON.stringify(profile.headers ?? {}),
      [...profile.models.keys()].sort().join(','),
    ].join('|'))
  }
  return parts.join('\n')
}

/** Absolute listing URL candidates for one base URL. */
export function listingUrls(baseURL) {
  const base = String(baseURL).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return []
  // A plaintext base URL would put the resolved API key on the wire in clear
  // text. Loopback stays allowed for a local gateway.
  if (!isSecureBase(base) && !isLoopback(base)) return []
  const urls = [`${base}/models`]
  if (!/\/v\d+$/i.test(base)) urls.push(`${base}/v1/models`)
  return urls
}

/** True when the base URL speaks TLS. */
function isSecureBase(value) {
  return /^https:\/\//i.test(String(value))
}

/** True for a loopback host, where plaintext never leaves the machine. */
function isLoopback(value) {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch (_error) {
    return false
  }
}

/** Turn a transport/DNS failure into something the page can show. */
function transportMessage(error) {
  const code = error?.code ?? error?.cause?.code
  if (typeof code === 'string') {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败（DNS 查不到该主机）'
    if (code === 'ECONNREFUSED') return '连接被拒绝'
    if (code === 'ECONNRESET') return '连接被重置'
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
    if (code === 'CERT_HAS_EXPIRED') return 'TLS 证书已过期'
    if (code.startsWith('ERR_TLS') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'TLS 校验失败'
    if (code === 'ENOTFOUND') return '域名解析失败'
  }
  const message = error?.message ?? String(error)
  if (/aborted|timeout/i.test(message)) return '请求超时'
  return message
}

/** One JSON GET with a timeout, redirect refusal and a body cap. */
async function getJson(fetchImpl, url, headers, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('response body is too large')
  let body
  try {
    body = JSON.parse(text)
  } catch (_error) {
    throw new Error(`not JSON (HTTP ${response.status})`)
  }
  return { status: response.status, body }
}

/**
 * A cached, best-effort probe over every configured provider route.
 *
 * @param options.settings - Host settings service (`describe()`).
 * @param options.credentials - optional credentials service (`resolve(ref)`).
 * @param options.logger - optional logger; only warnings, never payloads.
 * @param options.fetch - fetch implementation (injectable for tests).
 * @param options.now - clock (injectable for tests).
 * @param options.ttlMs - probe cache lifetime.
 * @param options.timeoutMs - per-request timeout.
 */
export function createProviderProbe(options = {}) {
  const settings = options.settings
  const credentials = options.credentials
  const logger = options.logger ?? console
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_PROBE_TTL_MS
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS

  let cached = null
  let cachedAt = -Infinity
  let inflight = null
  let generation = 0
  let lastSignature = ''
  let profilesCache = null

  const readProfiles = () => {
    if (typeof settings?.describe !== 'function') return new Map()
    try {
      return readProviderProfiles(settings.describe())
    } catch (error) {
      if (typeof logger.warn === 'function') logger.warn('model-visibility: could not read provider settings', error)
      return new Map()
    }
  }

  /**
   * The last known provider profiles, without probing.
   *
   * The request-side image gate needs a synchronous answer while the adapter
   * resolves a model; re-reading `settings.describe()` for every model would be
   * wasteful, so the map is cached until a settings or route change.
   * @returns Map provider id -> profile.
   */
  const profiles = () => {
    if (profilesCache === null) profilesCache = readProfiles()
    return profilesCache
  }

  /** The last completed probe snapshot, without starting a new sweep. */
  const peek = () => cached

  /** Probe one provider route; never throws. */
  const probeProvider = async (profile) => {
    const diagnostics = {
      id: profile.id,
      status: 'skipped',
      models: 0,
      capabilities: 0,
      pricing: 'skipped',
    }
    try {
      diagnostics.host = new URL(profile.baseURL).host
    } catch (_error) {
      diagnostics.status = 'skipped'
      diagnostics.message = 'invalid base URL'
      return { entries: new Map(), diagnostics }
    }
    if (profile.apiKeyEnv === undefined) {
      diagnostics.message = 'no credential reference'
      return { entries: new Map(), diagnostics }
    }
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      diagnostics.message = 'credential service unavailable'
      return { entries: new Map(), diagnostics }
    }
    let key
    try {
      const resolved = await credentials.resolve(profile.apiKeyEnv)
      key = typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : undefined
    } catch (_error) {
      diagnostics.message = 'credential could not be resolved'
      return { entries: new Map(), diagnostics }
    }
    if (key === undefined) {
      diagnostics.status = 'unauthorized'
      diagnostics.message = 'credential is not configured'
      return { entries: new Map(), diagnostics }
    }

    const headers = {
      accept: 'application/json',
      'user-agent': 'dsh-model-visibility/1.4',
      ...profile.headers,
    }
    if (profile.api === 'anthropic-messages') {
      headers['anthropic-version'] ??= '2023-06-01'
      headers['x-api-key'] ??= key
    } else {
      headers.authorization ??= `Bearer ${key}`
    }

    let body
    let lastError
    let refused = false
    for (const url of listingUrls(profile.baseURL)) {
      try {
        const response = await getJson(fetchImpl, url, headers, timeoutMs)
        if (response.status === 401 || response.status === 403) {
          // Keep going: a relay that rejects the listing still often serves the
          // public pricing endpoint, and its id list is better than nothing.
          diagnostics.status = 'unauthorized'
          diagnostics.message = `HTTP ${response.status}`
          refused = true
          break
        }
        if (response.status < 200 || response.status >= 300) {
          lastError = new Error(`HTTP ${response.status}`)
          continue
        }
        body = response.body
        break
      } catch (error) {
        lastError = error
      }
    }

    // New API exposes model ids and kinds through its public pricing endpoint.
    // When `/models` is unreachable (DNS, timeout, 401, 5xx) that listing is
    // still worth having: it is what lets the page show "served N models"
    // instead of a bare failure. It is also frequently 403/404, which is not an
    // error.
    const pricing = await probePricing(profile, headers)
    if (body === undefined) {
      if (pricing.entries.size > 0) {
        // The listing failed but the pricing endpoint enumerated the route.
        diagnostics.status = 'partial'
        diagnostics.models = pricing.entries.size
        diagnostics.capabilities = 0
        diagnostics.pricing = pricing.state
        const status = refused ? String(diagnostics.message ?? '') : undefined
        diagnostics.message = refused
          ? `${status === '' ? 'HTTP 401/403' : status}（鉴权被拒），已用价格接口列出模型`
          : `模型列表不可用（${
              lastError === undefined ? '未知原因' : transportMessage(lastError)
            }），已用价格接口列出模型`
        return { entries: withKinds(pricing.entries, pricing.kinds), diagnostics }
      }
      diagnostics.status = refused ? 'unauthorized' : 'failed'
      diagnostics.pricing = pricing.state
      if (!refused) {
        diagnostics.message =
          lastError === undefined ? 'no listing endpoint answered' : transportMessage(lastError)
      }
      return { entries: new Map(), diagnostics }
    }

    const entries = parseModelListing(body)
    diagnostics.status = 'ok'
    diagnostics.models = entries.size
    const capabilityKeys = ['inputModalities', 'outputModalities', 'kind', 'reasoning', 'contextWindow']
    diagnostics.capabilities = [...entries.values()].filter((entry) =>
      capabilityKeys.some((field) => entry[field] !== undefined),
    ).length

    diagnostics.pricing = pricing.state
    return { entries: withKinds(entries, pricing.kinds), diagnostics }
  }

  /**
   * Fill in the kind of every entry from the pricing endpoint, keeping the
   * richer `/models` facts when both sources describe the same model.
   */
  /**
   * Return a copy of `entries` with each model's kind filled in from the
   * pricing endpoint, keeping the richer `/models` facts when both sources
   * describe the same model.
   *
   * A copy, not an edit: the partial branch passes the pricing map itself, and
   * mutating it while iterating it would make the result depend on map order.
   */
  const withKinds = (entries, kinds) => {
    const out = new Map()
    for (const [id, entry] of entries) out.set(id, { ...entry })
    for (const [id, info] of kinds) {
      const entry = out.get(id) ?? { id }
      if (entry.kind === undefined) entry.kind = info.kind
      out.set(id, entry)
    }
    return out
  }

  /**
   * Read New API's public pricing endpoint for model ids and kinds.
   * @returns `{ entries, kinds, state }`; `state` is ok / disabled / failed.
   */
  const probePricing = async (profile, headers) => {
    const empty = { entries: new Map(), kinds: new Map(), state: 'failed' }
    let origin
    try {
      origin = new URL(profile.baseURL).origin
    } catch (_error) {
      return { ...empty, state: 'skipped' }
    }
    // The pricing request carries the same Authorization header, so it obeys the
    // same rule as the listing: TLS only, unless the target is loopback.
    if (!isSecureBase(origin) && !isLoopback(origin)) return { ...empty, state: 'skipped' }
    try {
      const response = await getJson(fetchImpl, `${origin}/api/pricing`, headers, timeoutMs)
      if (response.status === 403 || response.status === 404) return { ...empty, state: 'disabled' }
      if (response.status < 200 || response.status >= 300) return empty
      return {
        entries: parsePricingIds(response.body),
        kinds: parsePricing(response.body),
        state: 'ok',
      }
    } catch (_error) {
      return empty
    }
  }

  const sweep = async () => {
    const profiles = readProfiles()
    profilesCache = profiles
    const initialSignature = profileSignature(profiles)
    lastSignature = initialSignature
    const discovered = new Map()
    const diagnostics = []
    const routes = [...profiles.values()]
    await Promise.all(
      routes.map(async (profile) => {
        const result = await probeProvider(profile)
        discovered.set(profile.id, result.entries)
        diagnostics.push(result.diagnostics)
      }),
    )
    diagnostics.sort((left, right) => String(left.id).localeCompare(String(right.id)))
    // Re-read the profiles after the sweep: a settings write during the network
    // calls may have changed model-level declarations, and those must reach the
    // merge without waiting for another TTL.
    const latestProfiles = readProfiles()
    profilesCache = latestProfiles
    const latestSignature = profileSignature(latestProfiles)
    lastSignature = latestSignature
    // A routing change during the sweep invalidates the entries we just
    // collected; return them for this caller but do not cache them.
    if (latestSignature !== initialSignature) generation += 1
    return { profiles: latestProfiles, discovered, diagnostics, probedAt: now() }
  }

  const read = (request = {}) => {
    const fresh = request !== null && typeof request === 'object' && request.fresh === true
    const stamp = now()
    if (!fresh && cached !== null && stamp - cachedAt < ttlMs) return Promise.resolve(cached)
    if (inflight !== null) return inflight
    const startedAt = generation
    const run = sweep()
      .then((value) => {
        if (generation === startedAt) {
          cached = value
          cachedAt = now()
        }
        return value
      })
      .catch((error) => {
        if (typeof logger.warn === 'function') logger.warn('model-visibility: provider probe failed', error)
        return { profiles: readProfiles(), discovered: new Map(), diagnostics: [], probedAt: now() }
      })
      .finally(() => {
        // `invalidate()` may have started a newer sweep while this one ran;
        // only clear the slot this promise owns.
        if (inflight === run) inflight = null
      })
    inflight = run
    return run
  }

  /** A settings write may change routes; only drop the cache when it did. */
  const noteSettingsChanged = () => {
    const profiles = readProfiles()
    profilesCache = profiles
    const signature = profileSignature(profiles)
    if (signature !== lastSignature) {
      lastSignature = signature
      cached = null
      cachedAt = -Infinity
      generation += 1
      return
    }
    // Model-level declarations (input / context / reasoning) feed the merge
    // even when the routing facts did not change. Refresh them without paying
    // for another network sweep: hiding a model must never re-probe 8 relays.
    if (cached !== null) cached = { ...cached, profiles }
  }

  const invalidate = () => {
    generation += 1
    cached = null
    cachedAt = -Infinity
    inflight = null
    profilesCache = null
  }

  return { read, invalidate, noteSettingsChanged, profiles, peek }
}
