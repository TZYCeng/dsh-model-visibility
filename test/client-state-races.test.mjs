import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalog, createOverrides, overrideIdentity } from '../client-src/catalog-store.mjs'
import { installComposerFilter } from '../client-src/composer-filter.mjs'
import { computeFilteredGroups } from '../client-src/pure.mjs'

const envelope = (value) => Response.json({ ok: true, value })
const catalogResponse = (id) => envelope({ groups: [{ id, models: [] }] })

function mockedFetch(t) {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const deferred = Promise.withResolvers()
    calls.push({ url, init, ...deferred })
    return deferred.promise
  })
  return calls
}

test('fresh supersedes plain catalog reads and reload supersedes fresh', async (t) => {
  const calls = mockedFetch(t)
  const store = createCatalog({})
  const normal = store.load()
  const fresh = store.refresh()
  assert.notEqual(fresh, normal)
  assert.equal(store.refresh(), fresh)
  assert.equal(store.load(), fresh)
  const reload = store.reload()
  assert.notEqual(reload, fresh)
  await Promise.resolve()
  assert.deepEqual(calls.map(({ url }) => url.split('/models')[1]), ['', '?fresh=1', '?fresh=1&reload=1'])
  calls[2].resolve(catalogResponse('current'))
  await reload
  calls[1].resolve(catalogResponse('fresh-but-old'))
  calls[0].reject(new Error('stale failure must not call the fallback'))
  await Promise.all([fresh, normal])
  assert.equal(store.getSnapshot().groups[0].id, 'current')
  assert.equal(store.getSnapshot().detailsError, null)
})

test('known settings, override or verify changes start a fresh generation', async (t) => {
  const calls = mockedFetch(t)
  const store = createCatalog({})
  const stale = store.refresh()
  const afterChange = store.afterChange()
  await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, calls[1].url)
  calls[1].resolve(catalogResponse('after change'))
  await afterChange
  calls[0].resolve(catalogResponse('before change'))
  await stale
  assert.equal(store.getSnapshot().groups[0].id, 'after change')
})

test('the official catalog fallback uses only the official adapter effort declarations', async (t) => {
  const reasoning = { efforts: [{ id: 'high', name: 'Adapter high' }], defaultEffort: 'high' }
  const groups = [{ id: 'relay', models: [{ id: 'thinking', reasoning }, { id: 'unknown' }] }]
  const catalog = createCatalog({ remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups } }) } } })
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 502 }))
  await catalog.load()
  assert.equal(catalog.getSnapshot().source, 'catalog')
  const normalized = catalog.getSnapshot().groups
  assert.equal(normalized[0].models[0].requestReasoning, reasoning)
  assert.equal(Object.hasOwn(groups[0].models[0], 'requestReasoning'), false)
  assert.deepEqual(computeFilteredGroups(normalized, { reasoningOnly: true })[0].models.map((item) => item.id), ['thinking'])
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => envelope({ groups }))
  await catalog.load()
  assert.equal(catalog.getSnapshot().source, 'host')
  assert.equal(Object.hasOwn(catalog.getSnapshot().groups[0].models[0], 'requestReasoning'), false)
})

const row = { provider: 'relay', model: 'namespace/model', contextWindow: 12_000, input: ['text', 'image'] }
const revision = (token, entry = row) => ({ provider: entry.provider, model: entry.model, revision: token })
const overrideResponse = (entry, token) => envelope({ overrides: entry ? [entry] : [], revisions: entry ? [revision(token, entry)] : [] })

test('override writes require a complete revisioned list; a valid empty list uses a null revision', async (t) => {
  const calls = mockedFetch(t)
  const store = createOverrides()
  const first = store.load()
  assert.equal(store.getSnapshot().status, 'loading')
  await assert.rejects(store.save(row, null), /not ready/)
  await Promise.resolve()
  calls[0].resolve(envelope({ overrides: [] }))
  await first
  assert.equal(store.getSnapshot().available, false)
  await assert.rejects(store.save(row, null), /not ready/)
  const ready = store.load()
  await Promise.resolve()
  calls[1].resolve(overrideResponse(null))
  await ready
  const saved = store.save(row, null)
  assert.deepEqual(JSON.parse(calls[2].init.body), { ...row, expectedRevision: null })
  calls[2].resolve(overrideResponse(row, 'r1'))
  await saved
  assert.equal(store.getSnapshot().revisions.get(overrideIdentity(row.provider, row.model)), 'r1')
})

test('successful override POST supersedes stale GET result and stale 404', async (t) => {
  for (const staleResponse of [() => overrideResponse(row, 'r1'), () => new Response(null, { status: 404 })]) {
    const calls = mockedFetch(t)
    const store = createOverrides()
    const initial = store.load()
    await Promise.resolve()
    calls[0].resolve(overrideResponse(row, 'r1'))
    await initial
    const stale = store.load()
    await Promise.resolve()
    const edited = { ...row, contextWindow: 15_000 }
    const saved = store.save(edited, 'r1')
    await store.load()
    assert.equal(calls.length, 3, 'do not GET during POST')
    calls[2].resolve(overrideResponse(edited, 'r2'))
    await saved
    calls[1].resolve(staleResponse())
    await stale
    assert.equal(store.getSnapshot().available, true)
    assert.deepEqual(store.getSnapshot().entries, [edited])
    await assert.rejects(store.save(row, 'r1'), { status: 409 })
    assert.equal(calls.length, 3, 'stale revisions observed locally are never posted')
    t.mock.restoreAll()
  }
})

test('a server-side conflict blocks the stale draft until the list is explicitly re-read', async (t) => {
  const calls = mockedFetch(t)
  const store = createOverrides()
  const initial = store.load()
  await Promise.resolve()
  calls[0].resolve(overrideResponse(row, 'r1'))
  await initial
  const remove = store.remove(row.provider, row.model, 'r1')
  assert.deepEqual(JSON.parse(calls[1].init.body), { remove: true, provider: row.provider, model: row.model, expectedRevision: 'r1' })
  calls[1].resolve(Response.json({ ok: false, error: { code: 'overrides/conflict', message: 'changed' } }, { status: 409 }))
  await assert.rejects(remove, { status: 409 })
  assert.equal(store.getSnapshot().status, 'error')
  await assert.rejects(store.save(row, 'r1'), /not ready/)
  const current = store.load()
  await Promise.resolve()
  calls[2].resolve(overrideResponse({ ...row, kind: 'chat' }, 'r2'))
  await current
  assert.equal(store.getSnapshot().entries[0].kind, 'chat')
  await assert.rejects(store.save(row, 'r1'), { status: 409 })
})

function source(initial) {
  let state = initial
  const listeners = new Set()
  return {
    listeners,
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { state = next; for (const fn of listeners) fn() },
  }
}

test('composer hot attach and removal notify existing subscribers; session dispose removes its patch', () => {
  const groups = [{ id: 'relay', models: [{ id: 'hidden' }, { id: 'active' }] }]
  const selection = { provider: 'relay', model: 'active' }
  const originalDispose = function () { this.disposed = true }
  const directory = () => Object.assign(Object.create({ dispose: originalDispose }), {
    store: source({ groups, current: selection }),
  })
  const existing = directory()
  const future = directory()
  const baseGet = existing.store.getSnapshot
  const baseSubscribe = existing.store.subscribe
  const seen = []
  const record = () => seen.push(existing.store.getSnapshot().groups[0].models.map((model) => model.id))
  const unsubscribe = existing.store.subscribe(record)
  const originalResolver = (id) => id === 'future' ? future : existing
  const models = { directoryFor: originalResolver, live: { directories: { values: new Set([existing]) } } }
  const form = source({ value: { hidden: ['relay/hidden', 'relay/active'] } })
  let teardown
  installComposerFilter({ modelDirectories: models, effect: (run) => { teardown = run() } }, form)
  assert.deepEqual(seen, [['active']], 'even an already mounted subscriber sees hot attach')
  assert.equal(existing.store.subscribe, baseSubscribe)
  assert.equal(models.directoryFor('future'), future)
  assert.equal(future.store.getSnapshot().groups[0].models.length, 1)
  const rawFuture = future.store.getSnapshot
  future.dispose()
  assert.equal(future.disposed, true)
  assert.notEqual(future.store.getSnapshot, rawFuture)
  assert.equal(Object.hasOwn(future, 'dispose'), false)
  assert.equal(future.store.getSnapshot().groups[0].models.length, 2)
  form.set({ value: { hidden: [] } })
  form.set({ value: { hidden: ['relay/hidden'] } })
  assert.deepEqual(seen, [['active'], ['hidden', 'active'], ['active']])
  teardown()
  assert.deepEqual(seen.at(-1), ['hidden', 'active'])
  assert.equal(existing.store.getSnapshot, baseGet)
  assert.equal(existing.store.subscribe, baseSubscribe)
  assert.equal(existing.store.listeners.size, 1, 'only the caller owns its own unsubscribe')
  assert.equal(form.listeners.size, 0)
  assert.equal(models.directoryFor, originalResolver)
  unsubscribe()
  assert.equal(existing.store.listeners.size, 0)
})
