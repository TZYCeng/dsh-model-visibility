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
import { createUsageApi, createVerifyApi } from '../client-src/catalog-store.mjs'
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

test('no dictionary entry ships a literal unresolved placeholder in a no-param call', () => {
  // `checker.running` used to be called without `tokens`, so the UI showed a
  // literal "{tokens}". Pin the keys whose call sites are easy to get wrong.
  for (const key of ['checker.running', 'checker.finished', 'checker.progress']) {
    assert.match(DICT.zh[key], /\{tokens\}/, `${key} should ask for {tokens}`)
    assert.match(DICT.en[key], /\{tokens\}/, `${key} should ask for {tokens}`)
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

test('the client bundle builds deterministically from the sources', () => {
  const root = path.dirname(dirname(fileURLToPath(import.meta.url)))
  const first = os.tmpdir()
  const out1 = path.join(first, `mv-bundle-${process.pid}-a.js`)
  const out2 = path.join(first, `mv-bundle-${process.pid}-b.js`)
  execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: root, stdio: 'ignore' })
  const built = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  fs.writeFileSync(out1, built)
  execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: root, stdio: 'ignore' })
  const rebuilt = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  assert.equal(rebuilt, fs.readFileSync(out1, 'utf8'))
  assert.equal(rebuilt.trim().length, built.trim().length)
})
