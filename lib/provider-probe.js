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

import { concurrency, mapWorkers, operationSlots, traceEvent, traceRoute } from './catalog-work.js'
import { kindOfType } from './capability-catalog.js'
import { readResponseText } from './http-body.js'
import { boundedOperation } from './async-operation.js'
import { isDeepStrictEqual } from 'node:util'
import { findRegisteredTarget, isConfigExpression, isPiAiRouteAdapter, isPiAiSettingsOwner, ownAt, rawSettingsEntries } from './provider-write.js'

/** Default lifetime of one probe snapshot. */
export const DEFAULT_PROBE_TTL_MS = 10 * 60_000
/** Per-request timeout; providers are probed concurrently. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3500
/** Responses larger than this are refused instead of parsed. */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Capabilities we are willing to forward. */
const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'file'])
/**
 * Relay-visible identity of this plugin's probe.
 *
 * Keep it in one place and free of the package version: the header was frozen
 * at `1.4` for ten releases because it was a literal inside the header builder.
 * A probe request is not an API version negotiation, so a stable product token
 * is more honest than a version that silently goes stale.
 */
export const USER_AGENT = 'dsh-model-visibility'

/** Read a non-empty string, or undefined. */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  const id = type.trim().toLowerCase()
  // A request supporting images/video as INPUT is not an image/video generator.
  if (id.includes('chat') || id.includes('completion') || id === 'openai' || id === 'anthropic') return 'chat'
  if (/(?:^|[-_/])images?(?:$|[-_/])/.test(id) && !/(?:vision|caption|classif|embed)/.test(id)) return 'image'
  if (/(?:^|[-_/])videos?(?:$|[-_/])/.test(id) && !/(?:vision|caption|classif|embed)/.test(id)) return 'video'
  if (id.includes('embedding')) return 'embedding'
  if (id.includes('rerank')) return 'rerank'
  if (id.includes('audio') || id.includes('speech') || id.includes('tts')) return 'audio'
  if (id.includes('moderation') || id.includes('classif') || id.includes('safety')) return 'classifier'
  if (id.includes('translation')) return 'translation'
  return undefined
}

/** Prefer specific endpoint tasks over a gateway's generic chat endpoint. */
function endpointKind(kinds) {
  if (kinds.includes('image')) return 'image'
  if (kinds.includes('video')) return 'video'
  return kinds.find(kind => kind !== 'chat') ?? kinds[0]
}

/** Generation output is useful evidence; ordinary text output is only a chat fallback. */
function kindOfOutput(output) {
  if (output?.includes('video')) return 'video'
  if (output?.includes('image')) return 'image'
  if (output?.includes('audio')) return 'audio'
  if (output?.includes('text')) return 'chat'
  return undefined
}

/** OpenRouter lists embedding vectors separately from ordinary text output. */
function embeddingOutput(raw, architecture) {
  const output = [architecture?.output_modalities, raw.output_modalities, raw.outputModalities, raw.output]
    .find(value => Array.isArray(value) && value.some(item => str(item) !== undefined))
    ?? (typeof architecture?.modality === 'string' ? architecture.modality.split('->')[1]?.split('+') : undefined)
  return output?.some(item => kindOfType(item) === 'embedding') === true
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
export function readModelEntry(raw, { key, api } = {}) {
  if (!isRecord(raw)) return undefined
  const google = api === 'google-generative-ai' && str(raw.name)?.startsWith('models/')
  const advertised = str(key) ?? (google ? str(str(raw.name).slice('models/'.length)) :
    str(raw.id) ?? str(raw.model) ?? str(raw.model_name))
  const id = advertised ?? str(raw.name)
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
  const methods = google && Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : []
  // Gemini's generateContent method can return images as well as text.
  const nativeKind = !methods.includes('generateContent') &&
    (methods.includes('embedContent') || methods.includes('batchEmbedContents')) ? 'embedding' : undefined
  const types = [str(raw.type)?.toLowerCase(), str(raw.model_type)?.toLowerCase()]
  const typeKinds = types.map(kindOfType)
  const declaredKind = typeKinds.find(kind => kind !== undefined && kind !== 'chat')
  const explicitChat = types.includes('chat')
  const endpoint = endpointKind(endpointKinds)
  const outputKind = embeddingOutput(raw, architecture) ? 'embedding' : kindOfOutput(output)
  // Generic chat endpoints and text output are fallbacks, not task declarations.
  // Defer identifier inference to the final merge so its provenance stays clear.
  const kind = declaredKind ?? nativeKind ?? (endpoint !== 'chat' ? endpoint : undefined) ??
    (explicitChat ? 'chat' : undefined) ?? outputKind ?? endpoint ?? typeKinds.find(Boolean)
  const weakKind = kind === 'chat' && !explicitChat
  const contextWindow =
    (google ? positive(raw.inputTokenLimit) : undefined) ??
    positive(raw.context_length) ??
    positive(raw.context_window) ??
    positive(raw.contextWindow) ??
    positive(raw.max_input_tokens) ??
    positive(raw.limit?.context)
  const maxTokens = (google ? positive(raw.outputTokenLimit) : undefined) ?? entryMaxTokens(raw)
  const reasoning = reasoningOf(raw) ?? (google && typeof raw.thinking === 'boolean' ? raw.thinking : undefined)
  const name = str(raw.displayName) ?? str(raw.display_name) ?? (!google ? str(raw.name) : undefined)
  return {
    id,
    // A display name masquerading as a model ID is useful only for display.
    ...(advertised === undefined ? { nameOnly: true } : {}),
    ...(name === undefined ? {} : { name }),
    ...(input === undefined ? {} : { inputModalities: input }),
    ...(output === undefined ? {} : { outputModalities: output }),
    ...(kind === undefined ? {} : { kind }),
    ...(weakKind ? { weakKind: true } : {}),
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
export function parseModelListing(body, { api } = {}) {
  const out = new Map()
  const duplicates = new Set()
  const add = (raw, key) => {
    const record = readModelEntry(raw, { key, api })
    if (record === undefined || duplicates.has(record.id)) return
    if (out.has(record.id)) {
      // A duplicate row has no unambiguous capability declaration.
      duplicates.add(record.id)
      out.set(record.id, { id: record.id })
    } else out.set(record.id, record)
  }
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : body?.models
  if (Array.isArray(rows)) for (const row of rows) add(row)
  else if (isRecord(rows)) for (const [key, raw] of Object.entries(rows)) add(raw, key)
  return out
}

function validListing(body) {
  return Array.isArray(body) || Array.isArray(body?.data) || Array.isArray(body?.models) || isRecord(body?.models)
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
    const id = str(raw.model_name) ?? str(raw.model) ?? str(raw.modelName) ?? str(raw.id)
    if (id === undefined) continue
    const kind = endpointKind(endpointTypesOf(raw))
    if (kind !== undefined) out.set(id, { kind })
  }
  return out
}

/**
 * Read provider profiles from `settings.describe()` output.
 *
 * Accept explicit relay URLs and pi-ai-style model declarations. An installed
 * catalog can use modelOverrides without supplying its own baseURL.
 * @param descriptors - the settings descriptors.
 * @returns Map provider id -> profile.
 */
export function readProviderProfiles(descriptors, options) {
  const profiles = new Map()
  const { llm, configEditor } = options ?? {}
  const rows = Array.isArray(descriptors) ? descriptors : []
  const owners = new Map()
  for (const descriptor of rows) owners.set(descriptor?.ns, (owners.get(descriptor?.ns) ?? 0) + 1)
  const rawEntries = rawSettingsEntries(configEditor)
  const directory = typeof llm?.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : undefined
  if (options !== undefined && !Array.isArray(directory)) return profiles
  for (const descriptor of rows) {
    const ns = descriptor?.ns
    const rawEntry = rawEntries.get(ns)
    if (!isPiAiSettingsOwner(ns, rawEntry) || owners.get(ns) !== 1) continue
    const providers = descriptor?.value?.providers
    if (!isRecord(providers)) continue
    const candidates = options?.onlyProvider === undefined ? Object.entries(providers) :
      Object.hasOwn(providers, options.onlyProvider) ? [[options.onlyProvider, providers[options.onlyProvider]]] : []
    for (const [id, raw] of candidates) {
      if (!isRecord(raw)) continue
      const target = options === undefined ? null : findRegisteredTarget(directory, id, rawEntries)
      if (options !== undefined && target?.ns !== ns) continue
      const adapter = llm?.adapters instanceof Map ? llm.adapters.get(id)?.adapter : undefined
      if (llm?.adapters instanceof Map && !isPiAiRouteAdapter(adapter)) continue
      let adapterSnapshot
      let adapterProfile
      if (adapter !== undefined) {
        try {
          adapterSnapshot = adapter.current()
          adapterProfile = adapter.profileOf(adapterSnapshot, id)
        } catch (_error) {
          continue
        }
        if (!adapterProfile || !['api', 'baseURL', 'apiKeyEnv', 'defaultInput', 'headers'].every(field =>
          isDeepStrictEqual(adapterProfile[field], raw[field]))) continue
      }
      const baseURL = str(raw.baseURL)
      const models = new Map()
      const seenModels = new Set()
      const configuredModels = Array.isArray(raw.models) ? raw.models : []
      const catalogModels = configuredModels.length === 0
      for (const model of configuredModels) {
        if (!isRecord(model) || str(model.id) === undefined) continue
        if (seenModels.has(model.id)) models.delete(model.id)
        else models.set(model.id, structuredClone(model))
        seenModels.add(model.id)
      }
      // An omitted or empty `models` array uses the installed catalog. Its
      // sparse overrides are keyed by the original case-sensitive model ID.
      const modelOverrides = raw.modelOverrides
      if (catalogModels && modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
        for (const [modelId, model] of Object.entries(modelOverrides)) {
          if (str(modelId) !== undefined && model && typeof model === 'object' && !Array.isArray(model)) {
            models.set(modelId, { ...structuredClone(model), id: modelId })
          }
        }
      }
      if (baseURL === undefined && models.size === 0) continue
      const headers = {}
      if (raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
        for (const [name, headerValue] of Object.entries(raw.headers)) {
          if (typeof headerValue === 'string') headers[name] = headerValue
        }
      }
      const rawProfile = ownAt(rawEntry?.current, ['providers', id])
      const userProfile = ownAt(descriptor.user, ['providers', id])
      const defaultInput = normalizeModalities(raw.defaultInput)
      const defaultContextWindow = positive(raw.defaultContextWindow)
      const defaultMaxTokens = positive(raw.defaultMaxTokens)
      const explicit = (key, isDefault) => Object.hasOwn(rawProfile ?? {}, key) ||
        Object.hasOwn(userProfile ?? {}, key) || !isDefault
      const profile = {
        id,
        namespace: ns,
        settingsPath: target?.path,
        catalogProvider: target?.catalogProvider,
        // A catalog route with no explicit protocol may serve more than one
        // dialect. Do not guess that its configured baseURL speaks OpenAI.
        api: str(raw.api) ?? (target?.catalogProvider ? undefined : 'openai-completions'),
        declaredApi: str(raw.api),
        baseURL,
        catalogModels,
        apiKeyEnv: str(raw.apiKeyEnv),
        headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
        compat: raw.compat === undefined ? undefined : structuredClone(raw.compat),
        defaultInput,
        inputDefault: defaultInput !== undefined && explicit('defaultInput', isDeepStrictEqual(defaultInput, ['text'])),
        // Unknown provenance must not widen a possibly explicit text default.
        inputProvenance: options === undefined || (isRecord(rawProfile) && !isConfigExpression(rawProfile) &&
          (rawProfile.defaultInput === undefined || Array.isArray(rawProfile.defaultInput))),
        defaultContextWindow,
        contextDefault: defaultContextWindow !== undefined && explicit('defaultContextWindow', defaultContextWindow === 1_000_000),
        defaultMaxTokens,
        maxTokensDefault: defaultMaxTokens !== undefined && explicit('defaultMaxTokens', defaultMaxTokens === 128_000),
        models,
        ...(adapter === undefined ? {} : { adapter, adapterSnapshot }),
      }
      if (profiles.has(id)) profiles.set(id, undefined)
      else profiles.set(id, profile)
    }
  }
  return new Map([...profiles].filter(([, profile]) => profile !== undefined))
}

/** Stable fingerprint of the routing facts that affect a probe. */
export function profileSignature(profiles) {
  const routes = [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify(routes.map((profile) => [
    profile.id,
    profile.namespace,
    profile.settingsPath,
    profile.catalogProvider,
    profile.api,
    profile.baseURL,
    profile.catalogModels,
    profile.apiKeyEnv,
    Object.entries(profile.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    [...profile.models.keys()].sort(),
  ]))
}

/** Absolute listing URL candidates for one base URL. */
const OPENAI_APIS = new Set(['openai-completions', 'openai-responses'])
const LISTABLE_APIS = new Set([...OPENAI_APIS, 'anthropic-messages', 'google-generative-ai'])

export function listingUrls(baseURL, api = 'openai-completions') {
  const parsed = metadataBase(baseURL)
  if (!parsed || !LISTABLE_APIS.has(api)) return []
  const base = parsed.href.replace(/\/+$/, '')
  if (api === 'google-generative-ai') return [`${base}/models?pageSize=1000`]
  if (api === 'anthropic-messages') return [`${base.replace(/\/v1$/, '')}/v1/models?limit=1000`]
  const urls = [`${base}/models`]
  if (!/\/v\d+$/i.test(base)) urls.push(`${base}/v1/models`)
  return urls
}

function metadataBase(baseURL) {
  if (typeof baseURL !== 'string' || !/^https?:\/\//i.test(baseURL)) return undefined
  try {
    const url = new URL(baseURL)
    // Resolve no credential and issue no request for malformed endpoint input.
    if (url.username || url.password || url.search || url.hash ||
      url.protocol !== 'https:' && (url.protocol !== 'http:' || !isLoopback(url.href))) return undefined
    return url
  } catch (_error) {
    return undefined
  }
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
  }
  const message = error?.message ?? String(error)
  if (code === 'TIMEOUT' || /aborted|timed out|timeout/i.test(message)) return '请求超时'
  // A transport implementation may put a full URL, headers or body in its
  // exception text. Only messages we generate ourselves may cross to the UI.
  if (/^(?:HTTP [1-5]\d\d|not JSON \(HTTP [1-5]\d\d\)|response body is too large|endpoint did not return a model listing)$/.test(message)) return message
  return '元数据请求失败（网络或响应格式异常）'
}

/** One JSON GET with a timeout, redirect refusal and a body cap. */
function getJson(fetchImpl, url, headers, timeoutMs, parent, guard, slot) {
  return boundedOperation(signal => slot(signal, async () => {
    // Check inside the operation microtask, immediately before the actual I/O.
    guard()
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal })
    const { status } = response
    // An HTTP failure is already enough information to choose a fallback. Do
    // not wait for (or try to parse) an HTML/streaming error page.
    if (status < 200 || status >= 300 || signal.aborted) {
      void response.body?.cancel?.().catch(() => {})
      signal.throwIfAborted()
      return { status }
    }
    const text = await readResponseText(response, MAX_BODY_BYTES, signal)
    try {
      return { status, body: JSON.parse(text) }
    } catch (_error) {
      throw new Error(`not JSON (HTTP ${status})`)
    }
  }), { signal: parent, timeoutMs, label: 'provider metadata request' })
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
  const { llm, configEditor } = options
  const credentials = options.credentials
  const logger = options.logger ?? console
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_PROBE_TTL_MS
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS

  const limit = concurrency(options.providerConcurrency, 4, 8)
  let credentialSlot = operationSlots(limit), requestSlot = operationSlots(limit)
  let cached = null
  let cachedAt = -Infinity
  let inflight = null
  let generation = 0
  let active = null
  let disposed = false
  let lastSignature = ''
  let lastOwners = new Map()
  let profilesCache = null

  const readProfiles = (onlyProvider) => {
    if (disposed) return new Map()
    if (typeof settings?.describe !== 'function') return new Map()
    try {
      return readProviderProfiles(settings.describe(), { llm, configEditor, onlyProvider })
    } catch (error) {
      if (typeof logger.warn === 'function') logger.warn('model-visibility: could not read provider settings')
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
  const probeProvider = async (profile, signal, mark) => {
    const diagnostics = {
      id: profile.id,
      status: 'skipped',
      models: 0,
      capabilities: 0,
      pricing: 'skipped',
    }
    if (profile.baseURL === undefined) {
      diagnostics.message = 'no explicit metadata endpoint'
      return { entries: new Map(), diagnostics }
    }
    const base = metadataBase(profile.baseURL)
    if (!base) {
      diagnostics.message = 'invalid or insecure metadata base URL'
      return { entries: new Map(), diagnostics }
    }
    diagnostics.host = base.host
    if (!LISTABLE_APIS.has(profile.api)) {
      diagnostics.message = 'no supported metadata protocol explicitly configured'
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
    const routeSignature = profileSignature(new Map([[profile.id, profile]]))
    // Settings notifications are not a synchronization primitive. Re-check
    // the exact endpoint/owner captured before credentials or fallback I/O;
    // don't enumerate/clone every other route's models for each request.
    const guard = () => {
      signal.throwIfAborted()
      const current = readProfiles(profile.id)
      const row = current.get(profile.id)
      if (!row || row.adapter !== profile.adapter || row.adapterSnapshot !== profile.adapterSnapshot || profileSignature(current) !== routeSignature) {
        updateProfiles(readProfiles())
        throw new Error('provider route changed')
      }
    }
    let key
    try {
      signal.throwIfAborted()
      mark('credential')
      const resolved = await boundedOperation(local => credentialSlot(local, () => credentials.resolve(profile.apiKeyEnv)), {
        signal, timeoutMs, label: 'provider credential resolution',
      })
      signal.throwIfAborted()
      key = typeof resolved?.value === 'string' ? resolved.value.trim() : undefined
    } catch (error) {
      signal.throwIfAborted()
      if (error?.code === 'TIMEOUT') {
        diagnostics.status = 'failed'
        diagnostics.message = 'credential resolution timed out'
      } else {
        diagnostics.message = 'credential could not be resolved'
      }
      return { entries: new Map(), diagnostics }
    }
    if (!key) {
      diagnostics.status = 'unauthorized'
      diagnostics.message = 'credential is not configured'
      return { entries: new Map(), diagnostics }
    }

    if (!/^[\x21-\x7e]+$/.test(key)) {
      diagnostics.message = 'configured credential is not a valid API key'
      return { entries: new Map(), diagnostics }
    }
    let headers
    try {
      const headerBag = new Headers({ accept: 'application/json', 'user-agent': USER_AGENT })
      for (const [name, value] of Object.entries(profile.headers)) headerBag.set(name, value)
      const authHeader = profile.api === 'anthropic-messages' ? 'x-api-key' :
        profile.api === 'google-generative-ai' ? 'x-goog-api-key' : 'authorization'
      if (profile.api === 'anthropic-messages' && !headerBag.has('anthropic-version')) headerBag.set('anthropic-version', '2023-06-01')
      if (!headerBag.has(authHeader)) headerBag.set(authHeader, authHeader === 'authorization' ? `Bearer ${key}` : key)
      headers = Object.fromEntries(headerBag)
    } catch (_error) {
      diagnostics.message = 'invalid provider request headers'
      return { entries: new Map(), diagnostics }
    }

    let body
    let lastError
    let refused = false
    for (const url of listingUrls(profile.baseURL, profile.api)) {
      try {
        signal.throwIfAborted()
        mark('listing')
        const response = await getJson(fetchImpl, url, headers, timeoutMs, signal, guard, requestSlot)
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
        if (!validListing(response.body)) {
          lastError = new Error('endpoint did not return a model listing')
          continue
        }
        body = response.body
        break
      } catch (error) {
        signal.throwIfAborted()
        lastError = error
      }
    }

    // New API exposes model ids and kinds through its public pricing endpoint.
    // When `/models` is unreachable (DNS, timeout, 401, 5xx) that listing is
    // still worth having: it is what lets the page show "served N models"
    // instead of a bare failure. It is also frequently 403/404, which is not an
    // error.
    signal.throwIfAborted()
    const pricing = OPENAI_APIS.has(profile.api) ? await probePricing(profile, signal, guard, mark) : { entries: new Map(), kinds: new Map(), state: 'skipped' }
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

    const entries = withKinds(parseModelListing(body, { api: profile.api }), pricing.kinds)
    diagnostics.status = 'ok'
    diagnostics.models = entries.size
    const capabilityKeys = ['inputModalities', 'outputModalities', 'kind', 'reasoning', 'contextWindow', 'maxTokens']
    diagnostics.capabilities = [...entries.values()].filter((entry) =>
      capabilityKeys.some((field) => entry[field] !== undefined),
    ).length

    diagnostics.pricing = pricing.state
    return { entries, diagnostics }
  }

  /**
   * Fill in kind from pricing, which is stronger than a generic text/chat
   * hint from `/models` but not a specific task declaration.
   *
   * A copy, not an edit: the partial branch passes the pricing map itself, and
   * mutating it while iterating it would make the result depend on map order.
   */
  const withKinds = (entries, kinds) => {
    const out = new Map()
    for (const [id, entry] of entries) out.set(id, { ...entry })
    for (const [id, info] of kinds) {
      const entry = out.get(id) ?? { id }
      if (entry.kind === undefined || (entry.weakKind === true && info.kind !== 'chat')) {
        entry.kind = info.kind
        if (info.kind === 'chat') entry.weakKind = true
        else delete entry.weakKind
      }
      out.set(id, entry)
    }
    return out
  }

  /**
   * Read New API's public pricing endpoint for model ids and kinds.
   * @returns `{ entries, kinds, state }`; `state` is ok / disabled / failed.
   */
  const probePricing = async (profile, signal, guard, mark) => {
    const empty = { entries: new Map(), kinds: new Map(), state: 'failed' }
    let origin
    try {
      origin = new URL(profile.baseURL).origin
    } catch (_error) {
      return { ...empty, state: 'skipped' }
    }
    // New API's pricing listing is public and is not scoped to the configured
    // base path. Never forward a route's credential or private headers there.
    if (!isSecureBase(origin) && !isLoopback(origin)) return { ...empty, state: 'skipped' }
    try {
      signal.throwIfAborted()
      mark('pricing')
      const response = await getJson(fetchImpl, `${origin}/api/pricing`, { accept: 'application/json' }, timeoutMs, signal, guard, requestSlot)
      if (response.status === 403 || response.status === 404) return { ...empty, state: 'disabled' }
      if (response.status < 200 || response.status >= 300) return empty
      return {
        entries: parsePricingIds(response.body),
        kinds: parsePricing(response.body),
        state: 'ok',
      }
    } catch (_error) {
      signal.throwIfAborted()
      return empty
    }
  }

  const dropProbeState = () => {
    generation += 1
    active?.abort()
    active = null
    cached = null
    cachedAt = -Infinity
    inflight = null
  }

  const updateProfiles = (nextProfiles) => {
    const replaced = [...nextProfiles].some(([id, p]) => {
      const old = lastOwners.get(id)
      return old && (old.adapter !== p.adapter || old.snapshot !== p.adapterSnapshot)
    })
    lastOwners = new Map([...nextProfiles].map(([id, p]) => [id, { adapter: p.adapter, snapshot: p.adapterSnapshot }]))
    profilesCache = nextProfiles
    const signature = profileSignature(nextProfiles)
    if (replaced || signature !== lastSignature) {
      // A different registered owner/endpoint does not inherit a permanently
      // hung transport's budget. A plain cache invalidation does not reset it.
      lastSignature = signature
      dropProbeState()
      credentialSlot = operationSlots(limit)
      requestSlot = operationSlots(limit)
    } else if (cached !== null) {
      // Model-level declarations feed the merge without another network sweep.
      cached = { ...cached, profiles: nextProfiles }
    }
  }

  const sweep = async (currentProfiles, signal) => {
    const profiles = [...currentProfiles.values()]
    const trace = options.trace
    const stages = new Set()
    // At most one event per stage per sweep, even for thousands of routes.
    const mark = step => { if (trace && !stages.has(step)) { stages.add(step); traceEvent(trace, 'probe', step, {}) } }
    traceEvent(trace, 'probe', 'start', { providers: profiles.length, concurrency: limit })
    let successes = 0, degraded = 0
    const results = await mapWorkers(profiles, limit, signal, async profile => {
      const result = await probeProvider(profile, signal, mark)
      if (trace?.enabled === true) {
        const { status, models, capabilities, pricing } = result.diagnostics
        if (status === 'ok' ? successes++ < 6 : degraded++ < 10) {
          traceEvent(trace, 'probe', 'route', { ...traceRoute(profile.id), status, accepted: status === 'ok' || status === 'partial',
            models, collected: capabilities, outcome: pricing })
        }
      }
      return result
    })
    const discovered = new Map(results.map(({ entries, diagnostics }) => [diagnostics.id, entries]))
    const diagnostics = results.map(r => r.diagnostics).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    traceEvent(trace, 'probe', 'complete', { providers: results.length, failures: diagnostics.filter(d => d.status === 'failed' || d.status === 'unauthorized').length })
    return { discovered, diagnostics }
  }

  // A caller waiting on a superseded sweep must not see its facts combined
  // with today's provider profiles, even if the provider id is unchanged.
  const currentSnapshot = () => cached ?? {
    profiles: profiles(), discovered: new Map(), diagnostics: [], probedAt: now(),
  }

  const read = (request = {}) => {
    if (disposed || request?.signal?.aborted) return Promise.resolve(currentSnapshot())
    const fresh = request !== null && typeof request === 'object' && request.fresh === true
    const stamp = now()
    if (!fresh && cached !== null && stamp - cachedAt < ttlMs) return Promise.resolve(cached)
    const currentProfiles = readProfiles()
    updateProfiles(currentProfiles)
    if (inflight !== null) return inflight
    const startedAt = generation
    const controller = new AbortController()
    active = controller
    const cancel = () => { if (active === controller) dropProbeState() }
    request?.signal?.addEventListener('abort', cancel, { once: true })
    const run = sweep(currentProfiles, controller.signal)
      .then((value) => {
        if (generation !== startedAt) return currentSnapshot()
        // Re-read after I/O to pick up declarations and detect routing changes
        // even when the caller did not deliver a settings notification.
        updateProfiles(readProfiles())
        if (generation !== startedAt) return currentSnapshot()
        cachedAt = now()
        cached = { profiles: profilesCache, ...value, probedAt: cachedAt }
        return cached
      })
      .catch((error) => {
        if (!controller.signal.aborted && typeof logger.warn === 'function') logger.warn('model-visibility: provider probe failed')
        return currentSnapshot()
      })
      .finally(() => {
        // A route change or invalidate() may have started a newer sweep.
        request?.signal?.removeEventListener('abort', cancel)
        if (active === controller) active = null
        if (inflight === run) inflight = null
      })
    inflight = run
    return run
  }

  const noteSettingsChanged = () => { if (!disposed) updateProfiles(readProfiles()) }

  const invalidate = () => {
    dropProbeState()
    profilesCache = null
  }

  return { read, invalidate, noteSettingsChanged, profiles, peek,
    dispose() {
      const pending = inflight
      disposed = true
      lastOwners.clear()
      lastSignature = ''
      invalidate()
      return pending?.catch(() => {})
    },
  }
}
