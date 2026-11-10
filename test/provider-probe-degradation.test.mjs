/**
 * Relay probe degradation and transport-safety contract.
 *
 * The settings page showed "中转站读取失败" with no reason for a relay whose DNS
 * entry had gone away, and lost the whole model list for a relay that answers
 * 401 on `/models` but serves its catalog through `/api/pricing`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProviderProbe,
  listingUrls,
  parsePricingIds,
  readProviderProfiles,
} from '../lib/provider-probe.js'

const PROVIDERS = {
  relay: {
    api: 'openai-completions',
    baseURL: 'https://relay.example',
    apiKeyEnv: 'K',
    api: 'openai-completions',
    models: [{ id: 'model-a' }, { id: 'model-b' }],
  },
}

function settingsFor(providers = PROVIDERS) {
  return { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] }
}

/** A fetch stub keyed by URL; a thrown entry simulates a transport failure. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    const handler = routes[String(url)]
    if (handler === undefined) {
      const error = new Error('not found')
      error.code = 'ENOTFOUND'
      throw error
    }
    if (handler instanceof Error) throw handler
    return {
      status: handler.status ?? 200,
      async text() {
        return typeof handler.body === 'string' ? handler.body : JSON.stringify(handler.body)
      },
    }
  }
  impl.calls = calls
  return impl
}

const credentials = { resolve: async () => ({ value: 'secret' }) }

function probeWith(fetchImpl) {
  return createProviderProbe({
    settings: settingsFor(),
    credentials,
    fetch: fetchImpl,
    logger: { warn() {} },
    timeoutMs: 50,
  })
}

test('a DNS failure is reported in words the page can show', async () => {
  const error = new Error('getaddrinfo ENOTFOUND relay.example')
  error.code = 'ENOTFOUND'
  const probe = probeWith(fakeFetch({}))
  const snapshot = await probe.read({ fresh: true })
  void error
  const [diagnostic] = snapshot.diagnostics
  assert.equal(diagnostic.status, 'failed')
  assert.match(diagnostic.message, /域名解析失败/)
  assert.doesNotMatch(diagnostic.message, /ENOTFOUND/)
})

test('a timeout is reported as a timeout, not a raw abort', async () => {
  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  const probe = probeWith(fakeFetch({}))
  const snapshot = await probe.read({ fresh: true })
  const [diagnostic] = snapshot.diagnostics
  // No route answered at all → still a failure, but the message is readable.
  assert.equal(diagnostic.status, 'failed')
  assert.ok(typeof diagnostic.message === 'string' && diagnostic.message.length > 0)
})

test('401 on /models falls back to /api/pricing for the model list', async () => {
  const fetchImpl = fakeFetch({
    'https://relay.example/models': { status: 401, body: {} },
    'https://relay.example/v1/models': { status: 401, body: {} },
    'https://relay.example/api/pricing': {
      status: 200,
      body: {
        data: [
          { model_name: 'model-a', supported_endpoint_types: ['openai'] },
          { model_name: 'model-b', supported_endpoint_types: ['image-generation'] },
        ],
      },
    },
  })
  const probe = probeWith(fetchImpl)
  const snapshot = await probe.read({ fresh: true })
  const [diagnostic] = snapshot.diagnostics
  assert.equal(diagnostic.status, 'partial')
  assert.equal(diagnostic.pricing, 'ok')
  assert.equal(diagnostic.models, 2)
  assert.match(diagnostic.message, /鉴权被拒/)
  const entries = snapshot.discovered.get('relay')
  assert.equal(entries.size, 2)
  assert.equal(entries.get('model-b').kind, 'image')
})

test('a dead host with no pricing endpoint stays failed with the DNS reason', async () => {
  const dns = new Error('getaddrinfo ENOTFOUND yujianwudi.net')
  dns.code = 'ENOTFOUND'
  const fetchImpl = fakeFetch({
    'https://relay.example/models': dns,
    'https://relay.example/v1/models': dns,
    'https://relay.example/api/pricing': dns,
  })
  const probe = probeWith(fetchImpl)
  const snapshot = await probe.read({ fresh: true })
  const [diagnostic] = snapshot.diagnostics
  assert.equal(diagnostic.status, 'failed')
  assert.match(diagnostic.message, /域名解析失败/)
})

test('parsePricingIds reads the id list even when kinds are absent', () => {
  const ids = parsePricingIds({ data: [{ model_name: 'a' }, { model_name: 'b' }, {}] })
  assert.deepEqual([...ids.keys()], ['a', 'b'])
  assert.deepEqual(parsePricingIds(undefined).size, 0)
  assert.deepEqual(parsePricingIds({ data: 'nope' }).size, 0)
})

test('a plaintext base URL never receives the API key', () => {
  // Credentials must not travel over http:// to a remote host.
  assert.deepEqual(listingUrls('http://relay.example/v1'), [])
  assert.deepEqual(listingUrls('https://relay.example/v1'), ['https://relay.example/v1/models'])
  // Loopback is the documented exception (a local gateway).
  assert.deepEqual(listingUrls('http://127.0.0.1:8080/v1'), ['http://127.0.0.1:8080/v1/models'])
  assert.deepEqual(listingUrls('http://localhost:8080'), ['http://localhost:8080/models', 'http://localhost:8080/v1/models'])
})

test('an http relay is reported as skipped instead of sending the key', async () => {
  const providers = {
    plain: { baseURL: 'http://relay.example/v1', apiKeyEnv: 'K', models: [{ id: 'a' }] },
  }
  let touched = 0
  const fetchImpl = async () => {
    touched += 1
    return { status: 200, async text() { return '{}' } }
  }
  const probe = createProviderProbe({
    settings: settingsFor(providers),
    credentials,
    fetch: fetchImpl,
    logger: { warn() {} },
  })
  const snapshot = await probe.read({ fresh: true })
  assert.equal(touched, 0, 'no request may leave for a plaintext base URL')
  const [diagnostic] = snapshot.diagnostics
  assert.equal(diagnostic.status, 'failed')
})

test('readProviderProfiles keeps auth headers for the probe', () => {
  const profiles = readProviderProfiles([
    {
      ns: 'llm-pi-ai',
      value: {
        providers: {
          relay: {
            baseURL: 'https://relay.example/v1',
            apiKeyEnv: 'K',
            headers: { 'x-tenant': 't1', 'bad': 7 },
            models: [{ id: 'a' }],
          },
        },
      },
    },
  ])
  assert.deepEqual(profiles.get('relay').headers, { 'x-tenant': 't1' })
})
