import { randomUUID } from 'node:crypto'

const TOOL = 'advanced_search'
const NAMESPACE = 'web-search-free'

function matchesFreeSearchTool(definition) {
  // The global registry rejects duplicate names; it doesn't expose registrant metadata.
  // Require the active Free Search settings entry AND its observed structured schema.
  const params = definition?.parameters?.properties
  const result = definition?.output?.schema?.properties
  return definition?.name === TOOL && params?.query?.type === 'string'
    && params.maxResults?.type === 'number' && params.timeRange?.type === 'string' && params.engine?.type === 'string'
    && result?.provider?.type === 'string' && result.content?.type === 'string'
    && result.sources?.type === 'array' && result.sources.items?.properties?.url?.type === 'string'
}

/** A narrow adapter for the documented standalone Host tool executor, never an agent. */
export function createCheckerSearchBridge({ getTools, getSettings }) {
  const inFlight = new Set()

  return {
    /** Resolve optional services and the live plugin config again for each call. */
    resolve() {
      const tools = getTools?.()
      const settings = getSettings?.()
      if (typeof tools?.execute !== 'function' || typeof tools.executable !== 'function' || typeof settings?.describe !== 'function') return undefined
      const config = settings.describe({ redactSecrets: true }).find(entry => entry.ns === NAMESPACE)?.value
      if (!config || typeof config !== 'object' || config.disabledTools?.includes?.(TOOL)) return undefined
      if (!matchesFreeSearchTool(tools.executable(TOOL))) return undefined

      return async ({ query, maxResults }, signal) => {
        signal.throwIfAborted()
        // No engine or timeRange override: Free Search owns routing and the user's configured preferences.
        // The installed tool does not forward AbortSignal upstream. Don't start new work
        // while an already cancelled/timed-out dispatch is still settling.
        if ([...inFlight].some(pending => pending.aborted)) throw new Error('a cancelled Free Search request is still settling')
        const id = randomUUID()
        inFlight.add(signal)
        try {
          const batch = await tools.execute({
            calls: [{ type: 'tool-call', id, name: TOOL, arguments: JSON.stringify({ query, maxResults }) }],
            signal,
          })
          signal.throwIfAborted()
          const result = batch?.results?.find(entry => entry.callId === id)?.result
          if (result?.isError === true) throw new Error(`Free Search: ${String(result.error?.message ?? 'tool failed').slice(0, 800)}`)
          // Never infer URLs from human-rendered content or diagnostics.
          if (result?.isError !== false || !Array.isArray(result.value?.sources)) throw new Error('Free Search returned no structured search result')
          return result.value
        } finally {
          inFlight.delete(signal)
        }
      }
    },
  }
}
