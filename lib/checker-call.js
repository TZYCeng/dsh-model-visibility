import { randomUUID } from 'node:crypto'
import { boundedOperation } from './async-operation.js'

export const CHECKER_MAX_TOKENS = 8192
export const CHECKER_REASONING_EFFORT = 'low'
const MAX_ROUNDS = 5
const MAX_TOOL_CALLS = 12
const MAX_REPLY_CHARS = 128_000

export const CHECKER_WEB_TOOLS = [
  {
    name: 'search_model_docs',
    description: 'Search current model specifications. Returns source URLs and excerpts; may consume web service quota.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Exact model name and desired specifications; at most 500 characters.' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'read_model_doc',
    description: 'Read a documentation URL returned by search_model_docs. Returns bounded page text; may consume web service quota.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'An HTTPS URL returned by search_model_docs in this batch.' } }, required: ['url'], additionalProperties: false },
  },
]

function publicUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    return host.includes('.') && !/^[\d.]+$/.test(host) && !host.includes(':') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  } catch { return false }
}

/** Streaming collection is bounded in memory and abortable even for a stalled iterator. */
async function completion(llm, checker, messages, system, options, signal) {
  return boundedOperation(async localSignal => {
    const config = { ...checker, maxTokens: options.maxTokens }
    const call = await llm.prepareCall(config, localSignal, (controls, model) => {
      // Only pin an effort actually offered by this route. Some checkers have no low level.
      const efforts = model?.reasoning?.efforts
      if (options.effort == null) return controls
      if (Array.isArray(efforts) && efforts.some(entry => entry.id === options.effort)) return { ...controls, reasoningEffort: options.effort }
      const { reasoningEffort, ...rest } = controls
      return rest
    })
    localSignal.throwIfAborted()
    const iterator = call.stream({ ...call.config, system, messages, tools: options.webSearch ? CHECKER_WEB_TOOLS : [], signal: localSignal })[Symbol.asyncIterator]()
    let text = ''
    let finish
    let usage
    let sawReasoning = false
    let ended = false
    const toolCalls = new Map()
    try {
      for (;;) {
        const next = await iterator.next()
        localSignal.throwIfAborted()
        if (next.done) { ended = true; break }
        const chunk = next.value
        if (chunk?.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk?.type === 'reasoning-delta') sawReasoning = true
        else if (chunk?.type === 'usage') usage = chunk.usage
        else if (chunk?.type === 'finish') finish = chunk.reason
        else if (chunk?.type === 'tool-call-delta') {
          const current = toolCalls.get(chunk.index) ?? { type: 'tool-call', id: chunk.id, name: '', arguments: '' }
          if (chunk.name) current.name = chunk.name
          current.arguments += chunk.argumentsDelta ?? ''
          toolCalls.set(chunk.index, current)
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') toolCalls.set(chunk.index, { ...chunk.block })
        if (text.length + [...toolCalls.values()].reduce((sum, item) => sum + item.arguments.length, 0) > MAX_REPLY_CHARS || toolCalls.size > MAX_TOOL_CALLS) throw new Error('checker response exceeded size or tool-call limit')
      }
    } finally {
      // Never wait forever for return() on a provider that ignores cancellation.
      if (!ended) Promise.resolve().then(() => iterator.return?.()).catch(() => {})
      if (usage && !localSignal.aborted) options.noteUsage?.({ usage })
    }
    if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message ?? 'verify request failed')
    if (finish?.kind === 'max-tokens') throw new Error(`the checker reply was truncated at ${options.maxTokens} output tokens${sawReasoning ? ' (the model spent them on reasoning)' : ''}`)
    return { text, toolCalls: [...toolCalls.values()] }
  }, { signal, timeoutMs: options.timeoutMs, label: 'checker request' })
}

/** Small private tool loop: only search and reads of search-returned URLs can execute. */
export async function callChecker({ llm, web, checker, system, input, signal, timeoutMs = 180_000, maxTokens = CHECKER_MAX_TOKENS, effort = null, webSearch = false, noteUsage, onActivity = () => {}, onWebCall = () => {} }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: input }] }]
  const allowedUrls = new Set()
  const readUrls = new Set()
  let toolCount = 0
  let searched = false
  const toolErrors = []
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    signal?.throwIfAborted()
    onActivity('checker')
    const reply = await completion(llm, checker, messages, system, { timeoutMs, maxTokens, effort, webSearch, noteUsage }, signal)
    if (!reply.toolCalls.length) {
      // One reminder ensures that an ordinary completion cannot impersonate a web check.
      if (webSearch && !searched && round === 0) {
        messages.push({ role: 'assistant', id: randomUUID(), source: { kind: 'model', ...checker }, content: [{ type: 'text', text: reply.text }] })
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Call search_model_docs before answering. No web search has been executed yet; unsupported claims must be null.' }] })
        continue
      }
      if (webSearch && !searched) throw new Error('checker did not call a successful web search; no online verification performed' + (toolErrors.length ? ` (${toolErrors.join('; ')})` : ''))
      return { text: reply.text, allowedUrls, readUrls }
    }
    if (!webSearch) throw new Error('checker requested tools while web search is disabled')
    messages.push({ role: 'assistant', id: randomUUID(), source: { kind: 'model', ...checker }, content: [...(reply.text ? [{ type: 'text', text: reply.text }] : []), ...reply.toolCalls] })
    for (const call of reply.toolCalls) {
      signal?.throwIfAborted()
      if (++toolCount > MAX_TOOL_CALLS) throw new Error('checker web tool budget exhausted')
      let result
      let isError = false
      try {
        const args = JSON.parse(call.arguments)
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('expected an object')
        if (call.name === 'search_model_docs') {
          if (typeof web?.search !== 'function') throw new Error('web search service unavailable; configure a DSH search provider or disable web search')
          if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500 || Object.keys(args).some(key => key !== 'query')) throw new Error('expected query (1–500 characters)')
          onActivity('search'); onWebCall('search')
          const found = await boundedOperation(s => web.search({ query: args.query, maxResults: 5 }, s), { signal, timeoutMs: Math.min(timeoutMs, 30_000), label: 'web search' })
          searched = true
          const sources = (found.sources ?? []).filter(source => publicUrl(source.url)).slice(0, 5).map(source => ({ url: source.url, title: String(source.title ?? '').slice(0, 300), snippet: String(source.snippet ?? source.summary ?? '').slice(0, 2500) }))
          for (const source of sources) allowedUrls.add(source.url)
          result = { sources, content: String(found.content ?? '').slice(0, 4000), untrusted: true }
        } else if (call.name === 'read_model_doc') {
          if (typeof args.url !== 'string' || !allowedUrls.has(args.url) || !publicUrl(args.url) || Object.keys(args).some(key => key !== 'url')) throw new Error('URL must be a public HTTPS source returned by this batch search')
          if (typeof web?.fetch !== 'function') throw new Error('web page read service unavailable')
          onActivity('fetch'); onWebCall('fetch')
          const page = await boundedOperation(s => web.fetch({ url: args.url }, s), { signal, timeoutMs: Math.min(timeoutMs, 30_000), label: 'web page read' })
          if (page.statusCode < 200 || page.statusCode >= 300) throw new Error(`page returned HTTP ${page.statusCode}`)
          readUrls.add(args.url)
          result = { url: args.url, text: String(page.body?.content ?? '').slice(0, 16_000), truncated: page.truncated, untrusted: true }
        } else throw new Error(`unsupported checker tool: ${call.name}`)
      } catch (error) {
        if (signal?.aborted) throw error
        result = { error: String(error?.message ?? error).slice(0, 1000) }
        toolErrors.push(result.error)
        isError = true
      }
      messages.push({ role: 'tool', id: randomUUID(), source: { kind: 'tool', callId: call.id }, toolCallId: call.id, isError, content: [{ type: 'text', text: JSON.stringify(result) }] })
    }
  }
  throw new Error('checker exceeded the 5-round web lookup limit')
}
