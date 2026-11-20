import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelInfoService } from '../lib/model-info.js'
import { createProviderProbe, readProviderProfiles } from '../lib/provider-probe.js'

const pending = () => new Promise(() => {})
const settingsFor = (providers) => ({ describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] })

// These use explicit per-operation and test watchdogs. No live provider,
// mounted plugin configuration, or credentials are touched.
test('a hung listing or resolver does not remove the rest of the model catalog', { timeout: 1500 }, async () => {
  let resolverSignal
  const llm = {
    listProviders: () => [{ id: 'stalled' }, { id: 'healthy' }],
    listModels: (provider) => provider === 'stalled'
      ? pending()
      : [{ id: 'slow', inputModalities: ['text', 'image'] }, { id: 'fast' }],
    resolveModelInfo: (_provider, model, signal) => {
      if (model === 'slow') {
        resolverSignal = signal
        return pending()
      }
      return { inputModalities: ['text'], context: { contextWindow: 32000 } }
    },
  }
  const service = createModelInfoService(llm, { timeoutMs: 20 })
  const result = await service.read()
  assert.deepEqual(result.groups.map(group => group.id), ['healthy'])
  assert.deepEqual(result.failures.map(failure => failure.id), ['stalled'])
  assert.match(result.failures[0].message, /list models stalled timed out/)
  const [slow, fast] = result.groups[0].models
  assert.match(slow.infoError, /resolve model healthy\/slow timed out/)
  assert.deepEqual(slow.inputModalities, ['text', 'image'])
  assert.equal(resolverSignal.aborted, true)
  assert.equal(fast.contextWindow, 32000)
  assert.equal(fast.infoError, undefined)
})

test('stalled enrichment does not block registry I/O or discard local Provider declarations', { timeout: 1500 }, async () => {
  const listed = Promise.withResolvers()
  let enrichmentSignal
  const profiles = readProviderProfiles(settingsFor({
    healthy: { modelOverrides: { model: { input: ['text'], contextWindow: 32768 } } },
  }).describe())
  const service = createModelInfoService({
    listProviders: () => [{ id: 'healthy' }],
    listModels: () => {
      listed.resolve(enrichmentSignal.aborted)
      return [{ id: 'model', name: 'Gemini' }]
    },
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  }, {
    enrichment: ({ signal }) => {
      enrichmentSignal = signal
      return pending()
    },
    fallbackEnrichment: () => ({ profiles }),
    enrichmentTimeoutMs: 25,
  })
  const catalog = service.read()
  assert.equal(await listed.promise, false)
  const result = await catalog
  assert.equal(enrichmentSignal.aborted, true)
  const [model] = result.groups[0].models
  assert.deepEqual(model.inputModalities, ['text'])
  assert.equal(model.sources.modalities, 'config')
  assert.equal(model.contextWindow, 32768)
  assert.match(result.providers[0].message, /provider enrichment timed out/)
})

test('relay probe publishes healthy route facts despite stalled credentials and streaming bodies', { timeout: 1500 }, async () => {
  const hosts = ['credential', 'slow', 'healthy']
  const providers = Object.fromEntries(hosts.map(host => [host, {
    apiKeyEnv: host,
    baseURL: `https://${host}.example/v1`,
    models: [{ id: 'model' }],
  }]))
  let cancelled = 0
  const probe = createProviderProbe({
    settings: settingsFor(providers),
    llm: { listConfigurableProviders: () => hosts.map(provider => ({ provider, declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })) },
    credentials: { resolve: (ref) => ref === 'credential' ? pending() : { value: 'fixture' } },
    timeoutMs: 20,
    fetch: async (url) => {
      if (url.endsWith('/api/pricing')) return new Response('<html>not JSON</html>', { status: 404 })
      if (url.startsWith('https://slow.example/')) {
        return new Response(new ReadableStream({ cancel() { cancelled += 1 } }))
      }
      if (url.startsWith('https://healthy.example/')) {
        return Response.json({ data: [{ id: 'model', context_length: 64000 }] })
      }
      assert.fail(`unexpected fetch: ${url}`)
    },
  })
  const result = await probe.read()
  assert.equal(cancelled, 1)
  assert.equal(result.discovered.get('healthy').get('model').contextWindow, 64000)
  const diagnostics = new Map(result.diagnostics.map(entry => [entry.id, entry]))
  assert.equal(diagnostics.get('healthy').status, 'ok')
  assert.equal(diagnostics.get('healthy').pricing, 'disabled')
  assert.match(diagnostics.get('credential').message, /credential resolution timed out/)
  assert.equal(diagnostics.get('slow').status, 'failed')
  assert.match(diagnostics.get('slow').message, /请求超时/)
})
