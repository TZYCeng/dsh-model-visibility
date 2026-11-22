import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderProbe } from '../lib/provider-probe.js'

// No actual endpoint, configuration or credential store is used.
const directory = names => ({ listConfigurableProviders: () => names.map(provider => ({ provider, declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })) })
const route = (host, key = 'credential-fixture') => ({ api: 'openai-completions', baseURL: `https://${host}.invalid`, apiKeyEnv: key,
  headers: { 'x-private-test': 'SECRET_HEADER' }, models: [{ id: 'SECRET_ID' }] })
const description = providers => [{ ns: 'llm-pi-ai', value: { providers } }]

for (const change of ['notified', 'unannounced', 'dispose', 'parent-timeout']) {
  test(`retire while waiting on credentials: ${change} never dispatches the old request`, { timeout: 1500 }, async () => {
    let profile = route('retired')
    const key = Promise.withResolvers(), resolving = Promise.withResolvers(), parent = new AbortController()
    const calls = [], trace = []
    const probe = createProviderProbe({ llm: directory(['relay']), settings: { describe: () => description({ relay: profile }) },
      credentials: { resolve: () => { resolving.resolve(); return key.promise } }, timeoutMs: 5000,
      trace: (m, s, d) => trace.push([m, s, d]), fetch: async url => { calls.push(url); return Response.json({ data: [] }) } })
    const waiting = probe.read({ signal: parent.signal })
    await resolving.promise
    if (change === 'notified' || change === 'unannounced') profile = route('replacement', 'different-key')
    if (change === 'notified') probe.noteSettingsChanged()
    if (change === 'parent-timeout') parent.abort()
    if (change === 'dispose') await probe.dispose() // must not wait for the uncooperative resolver
    if (change !== 'unannounced') assert.equal((await waiting).discovered.size, 0)
    key.resolve({ value: 'SECRET_CREDENTIAL' })
    const result = await waiting
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(result.discovered.size, 0)
    assert.deepEqual(calls, [], 'neither an authenticated listing nor public pricing may start')
    if (change === 'dispose') assert.equal((await probe.read({ fresh: true })).profiles.size, 0)
    assert.doesNotMatch(JSON.stringify(trace), /SECRET|invalid|different-key/)
    await probe.dispose()
  })
}

test('disposing an active response actually aborts its body and prevents the /v1 retry and pricing fallback', { timeout: 1500 }, async () => {
  let cancelled = 0
  const entered = Promise.withResolvers(), calls = []
  const probe = createProviderProbe({ llm: directory(['relay']), settings: { describe: () => description({ relay: route('fixture') }) },
    credentials: { resolve: () => ({ value: 'fixture' }) },
    fetch: (url, { signal }) => { calls.push(url); return new Response(new ReadableStream({ pull() { entered.resolve(signal) }, cancel() { cancelled++ } })) } })
  const waiting = probe.read()
  const signal = await entered.promise
  await probe.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, 1)
  assert.deepEqual(calls, ['https://fixture.invalid/models'])
  assert.equal((await waiting).discovered.size, 0)
})

test('probe workers are bounded and trace stages stay constant across 120 routes', async () => {
  const count = 120, names = Array.from({ length: count }, (_, i) => `SECRET_ROUTE_${i}`)
  const all = Object.fromEntries(names.map(name => [name, route(name)]))
  let active = 0, peak = 0
  const trace = []
  const probe = createProviderProbe({ llm: directory(names), settings: { describe: () => description(all) }, providerConcurrency: 3,
    trace: (m, s, d) => trace.push([m, s, d]), credentials: { resolve: async () => {
      peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return { value: 'SECRET_CREDENTIAL' }
    } }, fetch: async url => url.endsWith('/api/pricing') ? new Response(null, { status: 404 }) : Response.json({ data: [{ id: 'model' }] }) })
  const snapshot = await probe.read()
  assert.equal(peak, 3)
  assert.equal(snapshot.diagnostics.length, count)
  assert.ok(snapshot.diagnostics.every(d => d.status === 'ok'))
  assert.deepEqual(trace.map(([, step]) => step), ['start', 'credential', 'listing', 'pricing', 'complete'])
  assert.doesNotMatch(JSON.stringify(trace), /secret|\.invalid|authorization/i)
  await probe.dispose()
})
