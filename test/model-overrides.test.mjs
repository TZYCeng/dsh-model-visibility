import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createOverrideStore,
  overrideFile,
  sanitizeEfforts,
  sanitizeModalities,
  sanitizeOverride,
} from '../lib/model-overrides.js'

const silent = { warn() {} }

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-visibility-'))
  return home
}

test('sanitizeModalities keeps the known modalities in order and drops noise', () => {
  assert.deepEqual(sanitizeModalities(['image', 'text', 'image', 'hologram', 3]), ['image', 'text'])
  assert.equal(sanitizeModalities([]), undefined)
  assert.equal(sanitizeModalities('text'), undefined)
})

test('sanitizeEfforts normalises ids, fills names and caps the ladder', () => {
  const efforts = sanitizeEfforts([
    { id: ' HIGH ', name: 'ignored' },
    { id: 'xhigh' },
    { id: 'not a valid id!' },
    null,
  ])
  assert.deepEqual(
    efforts.map((effort) => effort.id),
    ['high', 'xhigh'],
  )
  assert.equal(efforts[0].name, 'High')
  assert.equal(efforts[1].name, 'XHigh')

  const capped = sanitizeEfforts(
    Array.from({ length: 40 }, (_, index) => ({ id: `level${index}` })),
  )
  assert.equal(capped.length, 16)
  assert.equal(sanitizeEfforts([]), undefined)
})

test('sanitizeOverride requires an identity and at least one declared field', () => {
  assert.equal(sanitizeOverride({ model: 'm' }), undefined)
  assert.equal(sanitizeOverride({ provider: 'p' }), undefined)
  assert.equal(sanitizeOverride({ provider: 'p', model: 'm' }), undefined)
  assert.equal(
    sanitizeOverride({ provider: 'p', model: 'm', kind: 'not-a-kind' }),
    undefined,
  )

  const override = sanitizeOverride({
    provider: 'relay',
    model: 'gpt-6.1-terra',
    kind: 'chat',
    input: ['text', 'image'],
    contextWindow: 400000,
    efforts: [{ id: 'low' }, { id: 'high' }],
    defaultEffort: 'high',
  })
  assert.equal(override.provider, 'relay')
  assert.equal(override.model, 'gpt-6.1-terra')
  assert.equal(override.kind, 'chat')
  assert.deepEqual(override.input, ['text', 'image'])
  assert.equal(override.contextWindow, 400000)
  assert.deepEqual(
    override.efforts.map((effort) => effort.id),
    ['low', 'high'],
  )
  assert.equal(override.defaultEffort, 'high')
})

test('a default-only residual override survives store reload after writeback', () => {
  const home = tempHome()
  try {
    const store = createOverrideStore({ home, logger: silent })
    assert.equal(store.upsert({ provider: 'relay', model: 'm', defaultEffort: ' HIGH ' }).defaultEffort, 'high')
    const reopened = createOverrideStore({ home, logger: silent })
    assert.equal(reopened.get('relay', 'm').defaultEffort, 'high')
    assert.equal(reopened.get('relay', 'm').efforts, undefined)
    assert.equal(sanitizeOverride({ provider: 'relay', model: 'm', defaultEffort: 'invalid id!' }), undefined)
    assert.deepEqual(sanitizeEfforts(['constructor']), [{ id: 'constructor', name: 'constructor' }])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a manual "no reasoning" only needs the identity', () => {
  const override = sanitizeOverride({
    provider: 'relay',
    model: 'gpt-6.1-terra',
    reasoningSupported: false,
  })
  assert.equal(override.reasoningSupported, false)
  assert.equal(override.efforts, undefined)
})

test('the override store round-trips through the shadow file', () => {
  const home = tempHome()
  try {
    const store = createOverrideStore({ home, logger: silent })
    assert.deepEqual(store.list(), [])

    store.upsert({
      provider: 'relay',
      model: 'gpt-6.1-terra',
      kind: 'chat',
      input: ['text', 'image'],
      contextWindow: 400000,
      efforts: [{ id: 'low' }, { id: 'high' }],
    })

    const [entry] = store.list()
    assert.equal(entry.provider, 'relay')
    assert.equal(entry.model, 'gpt-6.1-terra')
    assert.equal(entry.contextWindow, 400000)
    assert.deepEqual(entry.input, ['text', 'image'])
    assert.equal(entry.efforts.length, 2)

    const raw = JSON.parse(fs.readFileSync(overrideFile(home), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.overrides.length, 1)

    const second = createOverrideStore({ home, logger: silent })
    assert.equal(second.get('relay', 'gpt-6.1-terra').kind, 'chat')
    assert.equal(second.remove('relay', 'gpt-6.1-terra'), true)
    assert.equal(second.remove('relay', 'gpt-6.1-terra'), false)
    assert.deepEqual(second.list(), [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('an upsert with no declared field removes the entry', () => {
  const home = tempHome()
  try {
    const store = createOverrideStore({ home, logger: silent })
    store.upsert({ provider: 'relay', model: 'm', contextWindow: 1000 })
    assert.equal(store.get('relay', 'm').contextWindow, 1000)
    store.upsert({ provider: 'relay', model: 'm' })
    assert.equal(store.get('relay', 'm'), undefined)
    assert.deepEqual(store.list(), [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a corrupt override file is not writable or reported as empty by strict reads', () => {
  const home = tempHome()
  try {
    fs.mkdirSync(path.dirname(overrideFile(home)), { recursive: true })
    fs.writeFileSync(overrideFile(home), '{not json')
    const store = createOverrideStore({ home, logger: silent })
    assert.deepEqual(store.list(), [])
    assert.throws(() => store.read(), { code: 'OVERRIDES_UNREADABLE' })
    assert.throws(() => store.upsert({ provider: 'relay', model: 'm', kind: 'audio' }), { code: 'OVERRIDES_UNREADABLE' })
    assert.equal(fs.readFileSync(overrideFile(home), 'utf8'), '{not json')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('invalidate re-reads a file changed outside the store', () => {
  const home = tempHome()
  try {
    const store = createOverrideStore({ home, logger: silent })
    store.upsert({ provider: 'relay', model: 'a', kind: 'chat' })
    assert.equal(store.list().length, 1)
    fs.writeFileSync(
      overrideFile(home),
      JSON.stringify({ version: 1, overrides: [{ provider: 'relay', model: 'b', kind: 'image' }] }),
    )
    store.invalidate()
    assert.deepEqual(
      store.list().map((entry) => entry.model),
      ['b'],
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('strict snapshots and compare-and-commit preserve newer edits and unrelated rows', () => {
  const home = tempHome()
  try {
    const store = createOverrideStore({ home, logger: silent })
    const twin = createOverrideStore({ home, logger: silent })
    const a = { provider: 'a/b', model: 'c' }
    const b = { provider: 'a', model: 'b/c' }
    assert.equal(store.snapshot(a.provider, a.model).revision, null)
    const saved = store.compareAndCommit({ ...a, input: ['text'] }, null)
    assert.equal(saved.ok, true)
    assert.deepEqual(store.read().revisions, [{ ...a, revision: saved.revision }])
    twin.upsert({ ...b, kind: 'image' })
    assert.equal(store.compareAndCommit({ ...a, input: ['image'] }, saved.revision).ok, true)
    const previous = store.snapshot(a.provider, a.model)
    twin.upsert({ ...a, input: ['text', 'image'] })
    assert.equal(store.compareAndCommit(a, previous.revision).ok, false)
    assert.equal(store.get(b.provider, b.model).kind, 'image')
    assert.deepEqual(store.get(a.provider, a.model).input, ['text', 'image'])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('read and rename failures preserve the last good override and the full file', (t) => {
  const home = tempHome()
  try {
    const store = createOverrideStore({ home, logger: silent })
    const identity = { provider: 'relay', model: 'm' }
    const file = overrideFile(home)
    store.upsert({ ...identity, kind: 'audio', input: ['text'] })
    store.upsert({ provider: 'relay', model: 'sibling', kind: 'chat' })
    const before = fs.readFileSync(file, 'utf8')
    const snapshot = store.snapshot(identity.provider, identity.model)
    const failRename = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated rename failure') })
    assert.throws(() => store.compareAndCommit({ ...identity, kind: 'image' }, snapshot.revision), /rename failure/)
    assert.equal(store.get(identity.provider, identity.model).kind, 'audio')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['overrides.json'])
    failRename.mock.restore()
    fs.writeFileSync(file, '{bad JSON')
    assert.equal(store.get(identity.provider, identity.model).kind, 'audio')
    const detached = store.get(identity.provider, identity.model)
    detached.input.push('image')
    assert.deepEqual(store.get(identity.provider, identity.model).input, ['text'])
    assert.throws(() => store.compareAndCommit(identity, snapshot.revision), { code: 'OVERRIDES_UNREADABLE' })
    assert.equal(fs.readFileSync(file, 'utf8'), '{bad JSON')
    fs.writeFileSync(file, before)
    assert.equal(store.compareAndCommit(identity, snapshot.revision).ok, true)
    assert.equal(store.get('relay', 'sibling').kind, 'chat')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
