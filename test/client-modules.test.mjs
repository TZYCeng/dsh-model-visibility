/**
 * Pure client modules: they import with plain ESM and run under `node --test`
 * without React, the DOM, or the bundle step.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  bucketTotalOf,
  checkerRoutesOf,
  computeFilteredGroups,
  countKinds,
  dayKeyOf,
  formatTokens,
  monthPrefixOf,
  weekKeyOf,
} from '../client-src/pure.mjs'
import { DICT } from '../client-src/dict.mjs'
import { CSS } from '../client-src/css.mjs'
import { createCatalog, createOverrides, createUsageApi, createVerifyApi, createBulkEffortsApi } from '../client-src/catalog-store.mjs'
import { CHECKER_EN, CHECKER_ZH } from '../client-src/checker-dict.mjs'
import { patchDirectoryStore } from '../client-src/composer-filter.mjs'

test('formatTokens rounds into K/M readings', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(4096), '4.1K')
  // The same decimal convention the context tag has always used.
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_048_576), '1M')
  assert.equal(formatTokens(33637594), '33.6M')
})

test('bucketTotalOf tolerates partial buckets', () => {
  assert.equal(bucketTotalOf([1, 2]), 3)
  assert.equal(bucketTotalOf(undefined), 0)
  assert.equal(bucketTotalOf([1, null, 2]), 3)
})

test('dayKeyOf, weekKeyOf and monthPrefixOf follow the local calendar', () => {
  const sunday = new Date(2026, 10, 8).getTime()
  assert.equal(dayKeyOf(sunday), '2026-11-08')
  assert.equal(weekKeyOf(sunday), '2026-11-02')
  assert.equal(monthPrefixOf(sunday), '2026-11')
})

/** Minimal model records used by the filter tests below. */
function model(id, kind, extra = {}) {
  return { id, name: id, kind, ...extra }
}

function group(id, models) {
  return { id, name: id, models }
}

test('computeFilteredGroups applies keyword, kind, capability and context filters', () => {
  const groups = [
    group('relay', [
      model('grok-4.7', 'chat', { inputModalities: ['text', 'image'], reasoningSupported: true, contextWindow: 500000 }),
      model('sora-2', 'video'),
      model('deepseek-v3', 'chat', { contextWindow: 64000 }),
    ]),
    group('builtin', [model('claude-5', 'chat', { inputModalities: ['text'] })]),
  ]
  assert.equal(computeFilteredGroups(groups, { filter: 'all' }).length, 2)
  const images = computeFilteredGroups(groups, { filter: 'video' })
  assert.equal(images.length, 1)
  assert.equal(images[0].models.length, 1)
  const multimodal = computeFilteredGroups(groups, { multimodalOnly: true })
  assert.deepEqual(multimodal.map((g) => g.id), ['relay'])
  const reasoning = computeFilteredGroups(groups, { reasoningOnly: true })
  assert.equal(reasoning[0].models.length, 1)
  const context = computeFilteredGroups(groups, { minContext: 100000 })
  assert.equal(context[0].models.length, 1)
  const needle = computeFilteredGroups(groups, { query: 'SORA' })
  assert.equal(needle.length, 1)
  assert.equal(computeFilteredGroups(groups, { query: 'no-such-model' }).length, 0)
})

test('visibility uses provider-scoped hidden keys and combines with all capability filters', () => {
  const capable = { inputModalities: ['text', 'image'], reasoningSupported: true, contextWindow: 200000 }
  const groups = [
    group('relay', [model('foo', 'chat', capable), model('foo-small', 'chat', { ...capable, contextWindow: 1000 }), model('foo-video', 'video', capable)]),
    group('second', [model('foo', 'chat', capable), model('foo-text', 'chat', { ...capable, inputModalities: ['text'] })]),
  ]
  const hidden = new Set(['relay/foo', 'relay/foo-small', 'relay/foo-video', 'second/foo-text'])
  const options = { filter: 'chat', query: ' FOO ', multimodalOnly: true, reasoningOnly: true, minContext: 128000, hidden }
  const selections = (visibility) => computeFilteredGroups(groups, { ...options, visibility })
    .map((entry) => [entry.id, entry.models.map((item) => item.id)])
  assert.deepEqual(selections('all'), [['relay', ['foo']], ['second', ['foo']]])
  assert.deepEqual(selections('enabled'), [['second', ['foo']]])
  assert.deepEqual(selections('disabled'), [['relay', ['foo']]])
  assert.equal(hidden.size, 4)
})

test('countKinds buckets chat / image / video / other', () => {
  assert.deepEqual(
    countKinds([model('a', 'chat'), model('b', 'image'), model('c', 'video'), model('d', 'embedding'), model('e')]),
    { chat: 2, image: 1, video: 1, other: 1 },
  )
})

test('checkerRoutesOf keeps only routes with models', () => {
  const routes = checkerRoutesOf([
    group('relay', [model('a', 'chat')]),
    { id: 'empty', models: [] },
  ])
  assert.deepEqual(routes, [{ id: 'relay', name: 'relay' }])
})

test('DICT keeps zh and en in lock-step and translates the new panels', () => {
  const zh = Object.keys(DICT.zh)
  const en = Object.keys(DICT.en)
  assert.deepEqual(zh.sort(), en.sort())
  assert.ok(zh.includes('usage.title'))
  assert.ok(zh.includes('checker.writeBack'))
  assert.ok(zh.includes('source.snapshot'))
  assert.notEqual(DICT.zh['usage.detail'], DICT.en['usage.detail'])
  assert.ok(CSS.includes('mvp_usage') && CSS.includes('mvp_checker'))
})

test('every dictionary placeholder is spelled the same in zh and en', () => {
  const placeholders = (value) =>
    new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]))
  const drift = []
  for (const key of Object.keys(DICT.zh)) {
    const left = placeholders(DICT.zh[key])
    const right = placeholders(DICT.en[key])
    for (const name of left) if (!right.has(name)) drift.push(`${key}: zh-only {${name}}`)
    for (const name of right) if (!left.has(name)) drift.push(`${key}: en-only {${name}}`)
  }
  assert.deepEqual(drift, [])
})

test('checker progress and token labels interpolate separate values', () => {
  for (const locale of [DICT.zh, DICT.en]) {
    assert.match(locale['checker.progress'], /\{processed\}\/\{total\}/)
    assert.doesNotMatch(locale['checker.progress'], /\{tokens\}/)
    assert.match(locale['checker.tokens'], /\{tokens\}/)
  }
})

test('the verify store starts and cancels through the same-origin route', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (init?.method === undefined) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: { state: { running: false, done: 3, total: 3 }, learned: { models: 3 } },
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        value: { state: { running: true, done: 1, total: 3, phase: 'verifying' } },
      }),
    }
  }
  // `fetch` is a browser global; the store reads it lazily per call. We swap
  // it for the duration of the test the way page code cannot.
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const verify = createVerifyApi()
    await verify.load()
    assert.equal(verify.getSnapshot().snapshot.state.done, 3)
    const started = await verify.start({ provider: 'relay', model: 'checker-x' })
    assert.equal(started.state.running, true)
    assert.equal(calls.every((call) => String(call.url).includes('/api/dsh-model-visibility/verify')), true)
    const startCall = calls.find((call) => call.init?.method === 'POST')
    assert.deepEqual(JSON.parse(startCall.init.body), { provider: 'relay', model: 'checker-x' })

  } finally {
    globalThis.fetch = originalFetch
  }
})

test('verify start supersedes a stale GET and skips polls until the POST settles', async (t) => {
  const response = (value) => ({ ok: true, json: async () => ({ ok: true, value }) })
  const old = Promise.withResolvers()
  const post = Promise.withResolvers()
  const pendingReads = [old.promise, Promise.resolve(response({ state: { running: true, processed: 2 } }))]
  t.mock.method(globalThis, 'fetch', (_url, init) =>
    init.method === 'POST' ? post.promise : pendingReads.shift())
  const verify = createVerifyApi()
  const stale = verify.load()
  await Promise.resolve()
  const start = verify.start({ provider: 'relay', model: 'checker', fullScan: true })
  assert.equal(verify.getSnapshot().pending, true)
  await verify.load()
  assert.equal(pendingReads.length, 1, 'GET is not sent during POST')
  post.resolve(response({ state: { running: true, processed: 0 } }))
  await start
  assert.equal(verify.getSnapshot().pending, false)
  assert.equal(verify.getSnapshot().snapshot.state.running, true)
  old.resolve(response({ state: { running: false } }))
  await stale
  assert.equal(verify.getSnapshot().snapshot.state.running, true)
  await verify.load()
  assert.equal(verify.getSnapshot().snapshot.state.processed, 2)
})

test('verify cancel supersedes stale GET errors without exposing a ghost run', async (t) => {
  const response = (value) => ({ ok: true, json: async () => ({ ok: true, value }) })
  const old = Promise.withResolvers()
  let requests = 0
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { cancel: true })
      return Promise.resolve(response({ state: { running: false, phase: 'cancelled' } }))
    }
    requests += 1
    return requests === 1 ? Promise.resolve(response({ state: { running: true } })) : old.promise
  })
  const verify = createVerifyApi()
  await verify.load()
  const stale = verify.load()
  await Promise.resolve()
  await verify.cancel()
  old.reject(new Error('obsolete poll failed'))
  await stale
  assert.equal(verify.getSnapshot().snapshot.state.phase, 'cancelled')
  assert.equal(verify.getSnapshot().error, null)
})

test('the usage store reads the ledger snapshot', async () => {
  const labels = []
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      value: {
        generatedAt: 1,
        computing: false,
        progress: null,
        ranges: { today: [1, 2, 0, 0], week: [3, 4, 0, 0], month: [5, 6, 0, 0], total: [7, 8, 0, 0] },
        days: {},
        byModel: {},
      },
    }),
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const usage = createUsageApi()
    await usage.load()
    const snapshot = usage.getSnapshot().snapshot
    assert.deepEqual(snapshot.ranges.today, [1, 2, 0, 0])
    labels.push(snapshot.ranges.total[1])
  } finally {
    globalThis.fetch = original
  }
})

const json = value => Response.json({ ok: true, value })
const countsOf = rows => Object.fromEntries(['pending', 'written', 'skipped', 'failed'].map(k => [k, rows.filter(r => r.status === k).length]))
const emptyBulk = () => ({ enabled: false, running: false, scopeCount: 0, rows: [], counts: countsOf([]) })
const tick = () => new Promise(setImmediate)

test('unobserved invalidations stay lazy; the first subscriber loads one current generation, then an obsolete body cannot publish', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => { const d = Promise.withResolvers(); calls.push({ ...d, url, init }); return d.promise })
  const stores = [createCatalog({}), createOverrides(), createUsageApi(), createVerifyApi(), createBulkEffortsApi()]
  t.after(() => stores.forEach(s => s.dispose()))
  const values = [{ groups: [{ id: 'current', models: [] }] }, { overrides: [], revisions: [] }, { generatedAt: 2 }, { state: { runId: 'new' } }, emptyBulk()]
  for (const [i, s] of stores.entries()) {
    const base = calls.length
    await s.invalidate({ fresh: true }); await s.invalidate({ reset: true }); await tick()
    assert.equal(calls.length, base, 'global event does not read an unobserved store')
    const off = s.subscribe(() => {}); const offAgain = s.subscribe(() => {})
    assert.equal(calls.length, base + 1, 'subscribers share the request')
    const stale = s.load(), old = calls.at(-1)
    // Coalesce several notices in one turn; only interested stores are reloaded.
    void s.invalidate({ fresh: true }); const refreshed = s.invalidate({ reset: true }); await tick()
    assert.equal(old.init.signal.aborted, true); assert.equal(calls.length, base + 2)
    calls.at(-1).resolve(json(values[i])); await refreshed
    const accepted = s.getSnapshot(); assert.equal(accepted.epoch, 2); assert.equal(accepted.status, 'ready')
    old.resolve(json({ bad: 'stale payload' })); await stale; await tick(); assert.equal(s.getSnapshot(), accepted)
    off(); offAgain(); await s.invalidate(); assert.equal(calls.length, base + 2)
    const end = s.subscribe(() => {}); assert.equal(calls.length, base + 3, 'a new visit reloads')
    const last = calls.at(-1); end(); assert.ok(last.init.signal.aborted); last.resolve(json(values[i])); await tick()
  }
})

test('a stale run ID is never substituted with a newer one, and cancellation sends the exact known ID only', async t => {
  const posts = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init.method === 'POST') posts.push(JSON.parse(init.body))
    return json({ state: { runId: 'newer', running: !init.method } })
  })
  const v = createVerifyApi(); t.after(() => v.dispose()); await v.load()
  await assert.rejects(v.cancel('older'), { status: 409 }); await assert.rejects(v.cancel(), { status: 409 })
  assert.deepEqual(posts, []); await v.cancel('newer'); assert.deepEqual(posts, [{ cancel: true, runId: 'newer' }])
  await v.invalidate({ reset: true }); await assert.rejects(v.cancel('newer'), { status: 409 })
  assert.equal(posts.length, 1, 'old-Host cancellation cannot hit the new Host before its first read')
})

test('a stalled POST body releases pending and aborts transport even when the underlying promise never rejects', async t => {
  const body = Promise.withResolvers(), calls = []
  t.mock.method(globalThis, 'fetch', (_url, init) => { calls.push(init); return { ok: true, json: () => body.promise } })
  const api = createVerifyApi({ timeoutMs: 15 }); t.after(() => api.dispose())
  const posted = api.start({ mode: 'public' }); assert.ok(api.getSnapshot().pending)
  await assert.rejects(posted, { name: 'TimeoutError' }); assert.equal(api.getSnapshot().pending, false)
  assert.equal(calls.length, 1); assert.ok(calls[0].signal.aborted)
  body.resolve({ ok: true, value: { state: { runId: 'obsolete' } } }); await tick(); assert.equal(api.getSnapshot().snapshot, null)
})

test('bulk requests only hit the same-origin Host, store no ticket, and return a full per-route receipt', async t => {
  const rows = [{ provider: 'a/b', model: 'c', authorized: true, status: 'pending', reason: 'ready' },
    { provider: 'a', model: 'b/c', authorized: true, status: 'skipped', reason: 'awaiting-evidence' }]
  const preview = { ...emptyBulk(), rows, total: 2, eligible: 1, skipped: 1, scopeCount: 2, counts: countsOf(rows), expiresAt: Date.now()+60_000, ticket: 'private-preview-ticket' }
  const written = [{ ...rows[0], status: 'written' }, rows[1]]
  const receipt = { enabled: true, running: false, rows: written, counts: countsOf(written), scopeCount: 2 }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init }); const action = init.body && JSON.parse(init.body).action
    return json(action === 'preview' ? preview : action === 'enable' ? receipt : emptyBulk())
  })
  const s = createBulkEffortsApi(); t.after(() => s.dispose()); await s.load()
  const plan = await s.preview(); assert.equal(s.getSnapshot().snapshot.enabled, false)
  assert.equal(JSON.stringify(s.getSnapshot()).includes(plan.ticket), false)
  await assert.rejects(s.enable(''), /ticket/); await s.enable(plan.ticket); assert.deepEqual(s.getSnapshot().snapshot.rows, written); await s.disable()
  assert.deepEqual(calls.map(c => c.init.body ? JSON.parse(c.init.body) : 'GET'), ['GET', { action: 'preview' }, { action: 'enable', ticket: plan.ticket }, { action: 'disable' }])
  assert.ok(calls.every(c => c.url === '/api/dsh-model-visibility/bulk-efforts' && c.init.credentials === 'same-origin' && c.init.signal instanceof AbortSignal))
  const pristine = [...rows]
  for (const patch of [{ scopeCount: 0 }, { eligible: 2, skipped: 0 }, { rows: [rows[0], rows[0]] }, { rows: [null, rows[1]] },
    { rows: [{ ...rows[0], status: 'new-status' }, rows[1]] }, { rows: [{ ...rows[0], authorized: false }, rows[1]] }, { expiresAt: undefined }]) {
    Object.assign(preview, { scopeCount: 2, eligible: 1, skipped: 1, rows: pristine, expiresAt: Date.now()+60_000 }, patch)
    await assert.rejects(s.preview(), /Incomplete/)
  }
  assert.equal(calls.filter(({ init }) => init.body?.includes('"action":"enable"')).length, 1, 'a corrupt preview never writes')
  receipt.rows = [null]; await assert.rejects(s.enable('reviewed-ticket'), /Incomplete bulk-effort receipt/)
  assert.equal(s.getSnapshot().status, 'error'); assert.equal(s.getSnapshot().pending, false)
})

test('resetting while bulk enable is in flight clears authority, preserves only an uncertainty notice and ignores the delayed Host', async t => {
  const deferred = Promise.withResolvers()
  const posts = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { if (init.method === 'POST') { posts.push(init); return deferred.promise }; return json(emptyBulk()) })
  const s = createBulkEffortsApi(); t.after(() => s.dispose()); const off = s.subscribe(() => {}); await s.load()
  const submitting = assert.rejects(s.enable('ticket'), { name: 'AbortError' })
  await s.invalidate({ reset: true }); await submitting
  assert.equal(s.getSnapshot().lostReply, true); assert.equal(s.getSnapshot().snapshot.enabled, false)
  assert.equal(posts.length, 1); assert.ok(posts[0].signal.aborted)
  deferred.resolve(json({ ...emptyBulk(), enabled: true })); await tick(); assert.equal(s.getSnapshot().snapshot.enabled, false)
  s.clearLostReply(); assert.equal(s.getSnapshot().lostReply, false); off()
})

test('the dedicated checker dictionary covers disclosure, outcome statuses and row-level reasons in both languages', () => {
  assert.deepEqual(Object.keys(CHECKER_ZH).sort(), Object.keys(CHECKER_EN).sort())
  for (const language of [CHECKER_ZH, CHECKER_EN]) {
    for (const section of ['target','evidence','routes','cost','undo','privacy','limit']) {
      assert.ok(language['bulk.terms.' + section + '.title']); assert.ok(language['bulk.terms.' + section + '.body'])
    }
    for (const status of ['pending','written','skipped','failed']) assert.ok(language['bulk.status.' + status])
  }
  assert.match(CHECKER_ZH['bulk.terms.privacy.body'], /不对外联网.*不计费/)
  assert.match(CHECKER_ZH['bulk.terms.limit.title'], /免死金牌/)
  assert.match(CHECKER_EN['bulk.terms.undo.body'], /already written persist/)
})

test('patchDirectoryStore rewrites snapshots in place and restores', () => {
  const groups = [
    { id: 'relay', models: [{ id: 'model-a' }, { id: 'model-b' }] },
    { id: 'gone', models: [{ id: 'model-gone' }] },
  ]
  let base = { groups, current: { provider: 'relay', model: 'model-b' } }
  let listeners = []
  const store = {
    getSnapshot: () => base,
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        listeners = listeners.filter((entry) => entry !== listener)
      }
    },
  }
  const EMPTY_FORM_VALUES = { value: { hidden: ['relay/model-a', 'gone/model-gone'] } }
  const form = {
    getSnapshot: () => EMPTY_FORM_VALUES,
    subscribe() {
      return () => {}
    },
  }
  const record = patchDirectoryStore(store, form)
  const snapshot = store.getSnapshot()
  assert.deepEqual(snapshot.groups.map((group) => group.id), ['relay'])
  assert.deepEqual(snapshot.groups[0].models.map((model) => model.id), ['model-b'])
  record.restore()
  assert.equal(store.getSnapshot(), base)
})

test('the client bundle builds deterministically from the sources', (t) => {
  const root = path.dirname(dirname(fileURLToPath(import.meta.url)))
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-bundle-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  fs.cpSync(path.join(root, 'client-src'), path.join(fixture, 'client-src'), { recursive: true })
  fs.mkdirSync(path.join(fixture, 'scripts'))
  fs.copyFileSync(path.join(root, 'scripts/build-client.mjs'), path.join(fixture, 'scripts/build-client.mjs'))
  const build = () => {
    execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: fixture, stdio: 'ignore' })
    return fs.readFileSync(path.join(fixture, 'client.js'), 'utf8')
  }
  const built = build()
  fs.unlinkSync(path.join(fixture, 'client.js'))
  assert.equal(build(), built)
})


/**
 * The editor renders `t('override.reason.' + result.reason)` and
 * `t('override.field.' + field)` with no fallback, so a reason the Host can
 * return but the dictionary never learned reaches the user as a bare key.
 * `native-catalog` did exactly that. Keep the two lists in lock-step.
 */
test('every provider-write reason and field has a localized label', async () => {
  const source = fs.readFileSync(join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'lib', 'provider-write.js'), 'utf8')
  const reasons = new Set([...source.matchAll(/reason: '([^']+)'/g)].map((match) => match[1]))
  // `stripWrittenFields` and the verifier pass these through as `localOnly`.
  for (const field of ['input', 'contextWindow', 'reasoningEfforts', 'kind', 'defaultEffort', 'supportsReasoningEffort']) {
    reasons.add('field.' + field)
  }
  assert.ok(reasons.size > 5, 'the reason list was parsed')
  const missing = []
  for (const key of reasons) {
    const name = key.startsWith('field.') ? 'override.field.' + key.slice(6) : 'override.reason.' + key
    if (!(name in DICT.en)) missing.push(name + ' (en)')
    if (!(name in DICT.zh)) missing.push(name + ' (zh)')
  }
  // A write result may also be reported before any provider write is attempted.
  for (const name of ['override.reason.skipped', 'override.reason.write-pending', 'override.reason.protected']) {
    if (!(name in DICT.en)) missing.push(name + ' (en)')
    if (!(name in DICT.zh)) missing.push(name + ' (zh)')
  }
  assert.deepEqual(missing, [])
})

test('reasoning filter retains adapter choices despite a negative local reference', () => {
  const models = [
    { id: 'adapter', reasoningSupported: false, requestReasoning: { efforts: [{ id: 'high', name: 'High' }] } },
    { id: 'reference', reasoningSupported: true, requestReasoning: null },
    { id: 'disabled', reasoningSupported: false, requestReasoning: null },
  ]
  const groups = computeFilteredGroups([{ id: 'relay', models }], { reasoningOnly: true })
  assert.deepEqual(groups[0].models.map(model => model.id), ['adapter', 'reference'])
})
