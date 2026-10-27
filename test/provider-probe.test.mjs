/**
 * Relay probe tests: profile reading, listing parsing, credentials, caching.
 *
 * Everything is driven with fake services and a fake fetch, so the suite never
 * touches the network, a real settings document or the credential store.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProviderProbe,
  listingUrls,
  normalizeModalities,
  parseModelListing,
  parsePricing,
  profileSignature,
  readProviderProfiles,
} from '../lib/provider-probe.js'
import { createModelInfoService, describeCatalog } from '../lib/model-info.js'

/** A settings.describe() stand-in with one relay profile. */
function descriptors(overrides = {}) {
  return [
    {
      ns: 'llm-pi-ai',
      value: {
        providers: {
          relay: {
            api: 'openai-completions',
            baseURL: 'https://relay.example/v1',
            apiKeyEnv: 'RELAY_API_KEY',
            headers: { 'x-relay-tenant': 'tenant-1' },
            defaultInput: ['text'],
            models: [
              { id: 'grok-4.7', input: [] },
              { id: 'gpt-image-2', input: [] },
            ],
            ...overrides,
          },
        },
      },
      revision: 1,
    },
  ]
}

/** A fetch stub that answers from a URL registry. */
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: { ...(options.headers ?? {}) } })
    const handler = routes[String(url)]
    if (handler === undefined) throw new Error('unexpected url ' + url)
    const result = typeof handler === 'function' ? handler(options) : handler
    return {
      status: result.status ?? 200,
      async text() {
        return typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
      },
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

test('normalizeModalities maps vision and drops unknown values', () => {
  assert.deepEqual(normalizeModalities(['text', 'vision', 'image', 'audio', 'bogus', 'text']), [
    'text',
    'image',
    'audio',
  ])
  assert.equal(normalizeModalities([]), undefined)
  assert.equal(normalizeModalities('text'), undefined)
})

test('readProviderProfiles extracts routing facts and ignores incomplete entries', () => {
  const profiles = readProviderProfiles([
    ...descriptors().map((descriptor) => ({
      ...descriptor,
      value: {
        providers: {
          ...descriptor.value.providers,
          broken: { apiKeyEnv: 'NO_URL' },
          emptyModels: { baseURL: 'https://empty.example/v1', models: 'nope' },
        },
      },
    })),
    { ns: 'not-a-provider', value: { providers: 'nope' } },
    { ns: 'list', value: { providers: [] } },
    null,
  ])
  assert.equal(profiles.size, 2)
  const relay = profiles.get('relay')
  assert.equal(relay.api, 'openai-completions')
  assert.equal(relay.baseURL, 'https://relay.example/v1')
  assert.equal(relay.apiKeyEnv, 'RELAY_API_KEY')
  assert.equal(relay.headers['x-relay-tenant'], 'tenant-1')
  assert.deepEqual([...relay.models.keys()], ['grok-4.7', 'gpt-image-2'])
  assert.equal(profiles.get('emptyModels').models.size, 0)
})

test('profileSignature tracks routing changes only', () => {
  const first = readProviderProfiles(descriptors())
  const same = readProviderProfiles(descriptors())
  assert.equal(profileSignature(first), profileSignature(same))
  const moved = readProviderProfiles(descriptors({ baseURL: 'https://other.example/v1' }))
  assert.notEqual(profileSignature(first), profileSignature(moved))
})

test('listingUrls keeps the configured base and adds /v1 when missing', () => {
  assert.deepEqual(listingUrls('https://relay.example/v1'), ['https://relay.example/v1/models'])
  assert.deepEqual(listingUrls('https://relay.example/v1/'), ['https://relay.example/v1/models'])
  assert.deepEqual(listingUrls('https://relay.example'), [
    'https://relay.example/models',
    'https://relay.example/v1/models',
  ])
  assert.deepEqual(listingUrls('file:///nope'), [])
})

test('parseModelListing understands OpenRouter-style metadata', () => {
  const entries = parseModelListing({
    data: [
      {
        id: 'x-ai/grok-4.7',
        name: 'Grok 4.7',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        context_length: 500000,
        top_provider: { max_completion_tokens: 128000 },
        supported_parameters: ['tools', 'reasoning_effort'],
      },
      {
        id: 'openai/gpt-image-2',
        architecture: { modality: 'text+image->image' },
        supported_endpoint_types: ['image-generation'],
      },
      {
        id: 'no-facts',
      },
      { id: 42 },
      null,
    ],
  })
  assert.equal(entries.size, 3)
  const grok = entries.get('x-ai/grok-4.7')
  assert.deepEqual(grok.inputModalities, ['text', 'image'])
  assert.deepEqual(grok.outputModalities, ['text'])
  assert.equal(grok.contextWindow, 500000)
  assert.equal(grok.maxTokens, 128000)
  assert.equal(grok.reasoning, true)
  assert.equal(grok.kind, 'chat')

  const image = entries.get('openai/gpt-image-2')
  assert.deepEqual(image.inputModalities, ['text', 'image'])
  assert.deepEqual(image.outputModalities, ['image'])
  assert.equal(image.kind, 'image')

  assert.equal(entries.get('no-facts').kind, undefined)
})

test('parseModelListing understands pi-ai object listings and capability flags', () => {
  const entries = parseModelListing({
    models: {
      'grok-imagine-video': { name: 'Grok Imagine Video', type: 'video' },
      'vision-model': { capabilities: { vision: true, reasoning: true }, context_window: 131072 },
    },
  })
  assert.equal(entries.get('grok-imagine-video').kind, 'video')
  assert.deepEqual(entries.get('vision-model').inputModalities, ['text', 'image'])
  assert.equal(entries.get('vision-model').reasoning, true)
  assert.equal(entries.get('vision-model').contextWindow, 131072)
})

test('parsePricing maps New API endpoint types to kinds', () => {
  const pricing = parsePricing({
    success: true,
    data: [
      { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
      { model_name: 'grok-imagine-video', supported_endpoint_types: ['video-generation'] },
      { model_name: 'text-embedding-3', supported_endpoint_types: ['embeddings'] },
      { model_name: 'grok-4.7', supported_endpoint_types: ['chat'] },
      { model_name: 'unknown', supported_endpoint_types: [] },
      { model_name: 'json-string', supported_endpoint_types: '["image-generation"]' },
    ],
  })
  assert.equal(pricing.get('gpt-image-2').kind, 'image')
  assert.equal(pricing.get('grok-imagine-video').kind, 'video')
  assert.equal(pricing.get('text-embedding-3').kind, 'embedding')
  assert.equal(pricing.get('grok-4.7').kind, 'chat')
  assert.equal(pricing.has('unknown'), false)
  assert.equal(pricing.get('json-string').kind, 'image')
})

test('createProviderProbe reads models with the resolved credential and caches', async () => {
  let clock = 1000
  const fetchImpl = fakeFetch({
    'https://relay.example/v1/models': {
      body: {
        data: [
          {
            id: 'grok-4.7',
            architecture: { input_modalities: ['text', 'image'] },
            context_length: 500000,
          },
        ],
      },
    },
    'https://relay.example/api/pricing': { status: 403, body: { message: 'pricing is disabled' } },
  })
  const probe = createProviderProbe({
    settings: { describe: () => descriptors() },
    credentials: { resolve: async (ref) => (ref === 'RELAY_API_KEY' ? { value: 'sk-test', source: 'test' } : undefined) },
    fetch: fetchImpl,
    now: () => clock,
    ttlMs: 1000,
  })

  const first = await probe.read()
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer sk-test')
  assert.equal(fetchImpl.calls[0].headers['x-relay-tenant'], 'tenant-1')
  assert.equal(first.discovered.get('relay').get('grok-4.7').contextWindow, 500000)
  assert.equal(first.diagnostics[0].status, 'ok')
  assert.equal(first.diagnostics[0].models, 1)
  assert.equal(first.diagnostics[0].capabilities, 1)
  assert.equal(first.diagnostics[0].pricing, 'disabled')
  assert.equal(JSON.stringify(first.diagnostics).includes('sk-test'), false)

  clock += 500
  await probe.read()
  assert.equal(fetchImpl.calls.length, 2, 'inside the TTL the probe is cached')

  await probe.read({ fresh: true })
  assert.equal(fetchImpl.calls.length, 4, 'fresh bypasses the TTL')
})

test('createProviderProbe reports an unauthorized relay without throwing', async () => {
  const fetchImpl = fakeFetch({
    'https://relay.example/v1/models': { status: 401, body: { error: 'invalid token' } },
  })
  const probe = createProviderProbe({
    settings: { describe: () => descriptors() },
    credentials: { resolve: async () => ({ value: 'sk-bad', source: 'test' }) },
    fetch: fetchImpl,
  })
  const snapshot = await probe.read()
  assert.equal(snapshot.diagnostics[0].status, 'unauthorized')
  assert.equal(snapshot.diagnostics[0].message, 'HTTP 401')
  assert.equal(snapshot.discovered.get('relay').size, 0)
})

test('createProviderProbe skips a route without a configured credential', async () => {
  const fetchImpl = fakeFetch({})
  const probe = createProviderProbe({
    settings: { describe: () => descriptors() },
    credentials: { resolve: async () => undefined },
    fetch: fetchImpl,
  })
  const snapshot = await probe.read()
  assert.equal(snapshot.diagnostics[0].status, 'unauthorized')
  assert.equal(snapshot.diagnostics[0].message, 'credential is not configured')
  assert.equal(fetchImpl.calls.length, 0)
})

test('createProviderProbe falls back to /v1/models when the bare base 404s', async () => {
  const fetchImpl = fakeFetch({
    'https://relay.example/models': { status: 404, body: {} },
    'https://relay.example/v1/models': { body: { data: [{ id: 'grok-4.7' }] } },
    'https://relay.example/api/pricing': { status: 404, body: {} },
  })
  const probe = createProviderProbe({
    settings: {
      describe: () => descriptors({ baseURL: 'https://relay.example' }),
    },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'test' }) },
    fetch: fetchImpl,
  })
  const snapshot = await probe.read()
  assert.equal(snapshot.diagnostics[0].status, 'ok')
  assert.equal(snapshot.discovered.get('relay').get('grok-4.7').id, 'grok-4.7')
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.url),
    [
      'https://relay.example/models',
      'https://relay.example/v1/models',
      'https://relay.example/api/pricing',
    ],
  )
})

test('noteSettingsChanged drops the cache only when routing facts changed', async () => {
  let clock = 1000
  let current = descriptors()
  const fetchImpl = fakeFetch({
    'https://relay.example/v1/models': { body: { data: [{ id: 'grok-4.7' }] } },
    'https://relay.example/v2/models': { body: { data: [{ id: 'grok-4.7' }] } },
    'https://relay.example/api/pricing': { status: 403, body: {} },
  })
  const probe = createProviderProbe({
    settings: { describe: () => current },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'test' }) },
    fetch: fetchImpl,
    now: () => clock,
    ttlMs: 60_000,
  })

  await probe.read()
  assert.equal(fetchImpl.calls.length, 2)

  current = descriptors()
  probe.noteSettingsChanged()
  await probe.read()
  assert.equal(fetchImpl.calls.length, 2, 'an unchanged profile keeps the cache')

  current = descriptors({ baseURL: 'https://relay.example/v2' })
  probe.noteSettingsChanged()
  await probe.read()
  assert.equal(fetchImpl.calls.length, 4, 'a changed base URL invalidates the cache')
})

test('the capability catalog carries probe diagnostics and relay kinds', async () => {
  const fetchImpl = fakeFetch({
    'https://relay.example/v1/models': {
      body: {
        data: [
          { id: 'grok-4.7', architecture: { input_modalities: ['text', 'image'] } },
          { id: 'gpt-image-2.5-flare', supported_endpoint_types: ['image-generation'] },
        ],
      },
    },
    'https://relay.example/api/pricing': { status: 403, body: {} },
  })
  const probe = createProviderProbe({
    settings: {
      describe: () =>
        descriptors({
          models: [
            { id: 'grok-4.7', input: [] },
            { id: 'gpt-image-2.5-flare', input: [] },
            { id: 'gpt-image-2.5-sunburst-4k', input: [] },
          ],
        }),
    },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'test' }) },
    fetch: fetchImpl,
  })
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => [
      { id: 'grok-4.7', name: 'grok-4.7' },
      { id: 'gpt-image-2.5-flare', name: 'gpt-image-2.5-flare' },
      { id: 'gpt-image-2.5-sunburst-4k', name: 'gpt-image-2.5-sunburst-4k' },
    ],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 262144 },
      defaultMaxTokens: 32768,
    }),
  }
  const service = createModelInfoService(llm, {
    enrichment: ({ fresh }) => probe.read({ fresh }),
  })
  const catalog = await service.read()
  assert.equal(catalog.groups.length, 1)
  const models = catalog.groups[0].models
  assert.equal(models.length, 3)

  const grok = models.find((model) => model.id === 'grok-4.7')
  assert.deepEqual(grok.inputModalities, ['text', 'image'])
  assert.equal(grok.sources.modalities, 'provider')
  assert.equal(grok.contextWindow, 500000)
  assert.equal(grok.sources.context, 'catalog')

  const image = models.find((model) => model.id === 'gpt-image-2.5-flare')
  assert.equal(image.kind, 'image')
  assert.equal(image.sources.kind, 'provider')
  assert.deepEqual(image.outputModalities, ['image'])
  assert.equal(image.contextWindow, undefined)

  const sunburst = models.find((model) => model.id === 'gpt-image-2.5-sunburst-4k')
  assert.equal(sunburst.kind, 'image')
  assert.equal(sunburst.sources.kind, 'catalog')

  assert.equal(catalog.providers.length, 1)
  assert.equal(catalog.providers[0].status, 'ok')
  assert.equal(catalog.providers[0].models, 2)
  assert.equal(catalog.providers[0].capabilities, 2)
  assert.ok(catalog.catalog.models > 500)
  assert.equal(typeof catalog.catalog.generatedAt, 'string')
})

test('describeCatalog survives a probe that cannot read settings', async () => {
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => [{ id: 'grok-4.7', name: 'grok-4.7' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
  }
  const catalog = await describeCatalog(llm, {
    enrichment: async () => {
      throw new Error('settings exploded')
    },
  })
  assert.equal(catalog.groups.length, 1)
  assert.equal(catalog.groups[0].models[0].inputModalities.includes('image'), true)
  assert.deepEqual(catalog.providers, [])
})
