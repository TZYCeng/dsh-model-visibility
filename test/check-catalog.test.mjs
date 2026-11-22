/**
 * The online capability verifier: public catalog parsers, checker-answer
 * validation, and an end-to-end sweep against a scripted llm service.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  extractJsonBlock,
  mergePublicSources,
  parseCheckerAnswer,
  readModelsDev,
  readOpenRouter,
  createCapabilityVerifier,
} from '../lib/check-catalog.js'
import { createLearnedCatalog } from '../lib/learned-catalog.js'
import { createUsageLedger } from '../lib/usage-ledger.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-verify-'))
}

test('readModelsDev maps modalities, limits and reasoning', () => {
  const body = {
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-6-sol': {
          name: 'GPT-6',
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 400000, output: 128000 },
          reasoning: true,
        },
      },
    },
  }
  const facts = readModelsDev(body)
  assert.deepEqual(facts.get('openai/gpt-6-sol').input, ['text', 'image'])
  assert.equal(facts.get('openai/gpt-6-sol').contextWindow, 400000)
  assert.equal(facts.get('openai/gpt-6-sol').reasoning, true)
  assert.equal(facts.get('vendor-prefix/gpt-6-sol')?.contextWindow, undefined)
})

test('readOpenRouter reuses the relay dialect', () => {
  const facts = readOpenRouter({
    data: [
      { id: 'anthropic/claude-5', context_length: 200000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] },
    ],
  })
  const fact = facts.get('anthropic/claude-5')
  assert.deepEqual(fact.inputModalities, ['text', 'image'])
  assert.equal(fact.contextWindow, 200000)
  assert.equal(fact.reasoning, true)
})

test('mergePublicSources fills gaps without overwriting declarations', () => {
  const left = new Map([['model-a', { id: 'model-a', contextWindow: 100 }]])
  const right = new Map([['model-a', { id: 'model-a', contextWindow: 999, reasoning: true }], ['model-b', { id: 'model-b', reasoning: false }]])
  const merged = mergePublicSources(left, right)
  assert.equal(merged.get('model-a').contextWindow, 100)
  assert.equal(merged.get('model-a').reasoning, true)
  assert.equal(merged.get('model-b').reasoning, false)
})

test('extractJsonBlock reads fenced and chatty replies', () => {
  assert.deepEqual(extractJsonBlock('```json\n[{"id":"a"}]\n```').models, undefined)
  assert.equal(extractJsonBlock('Sure! Here you go:\n```\n{"models":[{"id":"a","kind":"chat"}]}\n```\nbye').models[0].id, 'a')
  assert.equal(extractJsonBlock('no json'), undefined)
})

test('parseCheckerAnswer keeps only the ids the batch asked about', () => {
  const answers = parseCheckerAnswer(
    { models: [
      { id: 'm-1', kind: 'chat', input: ['text', 'image'], contextWindow: 200000, reasoning: true },
      { id: 'm-2' },
      { id: 'foreign-model', kind: 'chat', input: ['text'] },
    ] },
    ['m-1', 'm-2'],
  )
  assert.equal(answers.length, 2)
  assert.equal(answers[0].fact.contextWindow, 200000)
  assert.deepEqual(answers[0].fact.input, ['text', 'image'])
  assert.equal(answers[1].fact, null)
  assert.deepEqual(answers[0].origins, ['checker'])
})

/** Scripted llm service: every prepareCall returns one canned completion. */
function fakeLlm(replies) {
  let call = 0
  return {
    calls: [],
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listConfigurableProviders: () => [{ provider: 'relay', declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] }],
    listModels: async () => [{ id: 'model-a' }, { id: 'model-b' }, { id: 'checker-x' }],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
    async prepareCall(config, signal, controls) {
      this.calls.push(config)
      controls(config, undefined)
      const reply = replies[Math.min(call++, replies.length - 1)]
      return {
        config,
        async *stream() {
          yield { type: 'text-delta', text: reply }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

function configEditorFor(settings) {
  return { configuration: () => {
    const value = settings.describe()[0].value
    return [{ entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: value } }, override: value }]
  } }
}

function verifierSetup({ replies, settings = defaultSettings(), learnedFile, ledger }) {
  const llm = fakeLlm(replies)
  const learned = createLearnedCatalog({ file: learnedFile ?? path.join(tempHome(), 'learned.json') })
  const publicFetch = async (url) => ({
    ok: true,
    text: async () => {
      if (String(url).includes('models.dev')) {
        return JSON.stringify({ modelsdev: { models: { 'model-b': { reasoning: true, limit: { context: 8000 } } } } })
      }
      return JSON.stringify({ data: [] })
    },
  })
  const verifier = createCapabilityVerifier({
    llm,
    settings,
    configEditor: configEditorFor(settings),
    learned,
    ledger,
    fetch: publicFetch,
    logger: { warn() {} },
  })
  return { verifier, llm, learned, settings }
}

function defaultSettings() {
  const providers = {
    relay: {
      baseURL: 'https://relay.example/v1',
      apiKeyEnv: 'K',
      models: [{ id: 'model-a', input: [] }, { id: 'model-b', input: [] }, { id: 'checker-x', input: [] }],
    },
  }
  return {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
    calls: [],
    async mutate(ns, ops) {
      this.calls.push({ ns, ops })
      for (const { path: [, provider, , index, field], value } of ops) providers[provider].models[index][field] = value
    },
  }
}

test('a verify sweep fills the learned snapshot and writes back once per route', async () => {
  const { verifier, learned, settings } = verifierSetup({
    replies: [
      '```json\n{"models":[{"id":"model-a","kind":"chat","input":["text","image"],"contextWindow":222000,"reasoning":true,"reasoningEfforts":["low","high"],"defaultEffort":"high"},{"id":"model-b","kind":"chat","input":["text"],"contextWindow":90000}]}\n```',
    ],
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: true })
  assert.equal(snapshot.phase, 'done')
  // `total` and `done` both count factual verifications only. The checker's own
  // model is never verified, so counting it as done made the progress read
  // 3/2 (and 36/23 in the field).
  assert.equal(snapshot.total, 2)
  assert.equal(snapshot.done, 2)
  assert.deepEqual(snapshot.tokenUsage.slice(0, 2), [100, 20])
  const a = learned.get('model-a')
  assert.equal(a.type, 'chat')
  assert.deepEqual(a.input, ['text', 'image'])
  assert.equal(a.verifiedAt > 0, true)
  assert.deepEqual(a.reasoningEfforts, [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ])
  assert.equal(a.defaultEffort, 'high')
  // Both writable models received the same mirrored patch.
  assert.equal(settings.calls.length, 2)
  const first = settings.calls[0]
  assert.equal(first.ns, 'llm-pi-ai')
  assert.ok(first.ops.some((op) => Array.isArray(op.value) && op.value.includes('image')))
  // The checker's own model is never verified.
  assert.equal(learned.get('checker-x'), undefined)
})

test('verification write-back protects existing config, never guesses wire values, and skips aliases', async () => {
  const models = {
    relay: [
      { id: 'model-a', input: ['text'], reasoningEfforts: { high: 'vendor-level' } },
      { id: 'model-b', input: [] },
      { id: 'checker-x' },
    ],
    other: [{ id: 'vendor/model-a', input: [] }],
  }
  const providers = Object.fromEntries(Object.entries(models).map(([key, entries]) => [key, { models: entries }]))
  const settings = {
    calls: [],
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
    async mutate(_ns, ops) {
      this.calls.push(ops)
      for (const op of ops) {
        const [, provider, , index, field] = op.path
        models[provider][index][field] = op.value
      }
    },
  }
  const { verifier, llm, learned } = verifierSetup({ settings, replies: [JSON.stringify([
    { id: 'model-a', input: ['text', 'image'], contextWindow: 400000, reasoningEfforts: ['max'] },
    { id: 'model-b', input: ['text', 'image'], reasoningEfforts: ['high'] },
  ])] })
  llm.listProviders = () => Object.keys(providers).map((id) => ({ id }))
  llm.listConfigurableProviders = () => Object.keys(providers).map((provider) => ({
    provider, declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider],
  }))
  llm.listModels = async (provider) => models[provider]
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: true })
  assert.equal(snapshot.phase, 'done')
  assert.equal(snapshot.done, 2)
  assert.deepEqual(snapshot.batches[0].written, ['relay/model-a', 'relay/model-b'])
  assert.deepEqual(models.relay[0], {
    id: 'model-a', input: ['text'], contextWindow: 400000, reasoningEfforts: { high: 'vendor-level' },
  })
  assert.deepEqual(models.relay[1].input, ['text', 'image'])
  assert.equal(models.relay[1].reasoningEfforts, undefined)
  assert.deepEqual(models.other[0], { id: 'vendor/model-a', input: [] })
  assert.equal(learned.get('model-a').reasoningEfforts[0].id, 'max')
})

test('a sweep with the write-back switch off only fills the snapshot', async () => {
  const { verifier, learned, settings } = verifierSetup({
    replies: ['{"models":[{"id":"model-a","kind":"chat","input":["text","image"],"contextWindow":222000}]}'],
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.phase, 'done')
  assert.equal(settings.calls.length, 0)
  assert.equal(learned.get('model-a').contextWindow, 222000)
})

test('incremental verification skips exact checked snapshot hits and no-op runs never fetch', async () => {
  const learned = createLearnedCatalog({ file: path.join(tempHome(), 'learned.json') })
  learned.upsertEntries([{ id: 'model-a', contextWindow: 4096 }], { origins: ['checker'] })
  let fetches = 0
  const requested = []
  const llm = fakeLlm([])
  llm.listModels = async () => [{ id: 'model-a' }, { id: 'model-b' }, { id: 'checker-x' }]
  llm.prepareCall = async config => ({ config, async *stream({ messages }) {
    const ids = JSON.parse(messages[0].content[0].text.split('\n')[1])
    requested.push(ids)
    yield { type: 'text-delta', text: JSON.stringify(ids.map(id => ({ id, contextWindow: 8192 }))) }
  } })
  const verifier = createCapabilityVerifier({
    llm, learned, huggingFaceHosts: ['https://huggingface.co'],
    fetch: async () => { fetches += 1; return new Response('[]') },
  })
  const checker = { provider: 'relay', model: 'checker-x' }
  const first = await verifier.start({ checker })
  assert.equal(first.skippedKnown, 1)
  assert.equal(first.total, 1)
  assert.equal(first.done, 1)
  assert.deepEqual(requested, [['model-b']])
  assert.equal(learned.getExact('model-a').contextWindow, 4096)
  const afterFirst = fetches
  const noop = await verifier.start({ checker, webSearch: true })
  assert.equal(noop.phase, 'done')
  assert.equal(noop.skippedKnown, 2)
  assert.equal(noop.total, 0)
  assert.equal(fetches, afterFirst)
  assert.equal(requested.length, 1)
  const full = await verifier.start({ checker, fullScan: true })
  assert.equal(full.fullScan, true)
  assert.equal(full.skippedKnown, 0)
  assert.equal(full.done, 2)
  assert.deepEqual(requested[1], ['model-a', 'model-b'])
  assert.equal(learned.getExact('model-a').contextWindow, 8192)
})

test('no checker route, no sweep', async () => {
  const { verifier } = verifierSetup({ replies: [] })
  const snapshot = await verifier.start({})
  assert.equal(snapshot.phase, 'error')
  assert.match(snapshot.errors[0], /choose the checking provider/)
  assert.equal(verifier.isRunning(), false)
})

test('the sweep records its own token spend into the ledger', async () => {
  const home = tempHome()
  const recorded = []
  const ledger = {
    notePluginUsage(entry) {
      recorded.push(entry)
    },
  }
  // The batch asks about every routable model except the checker, so the reply
  // must cover both or the strict format check retries once (which is correct,
  // but would double the spend this test is measuring).
  const { verifier } = verifierSetup({
    replies: [
      '{"models":[{"id":"model-a","kind":"chat","input":["text","image"],"contextWindow":222000},' +
        '{"id":"model-b","kind":"chat","contextWindow":90000}]}',
    ],
    ledger,
    learnedFile: path.join(home, 'learned.json'),
  })
  await verifier.start({ checker: { provider: 'relay', model: 'checker-x' } })
  assert.ok(recorded.length >= 1)
  assert.equal(recorded[0].provider, 'relay')
  assert.equal(recorded[0].model, 'checker-x')
  assert.ok(recorded[0].usage.inputTokens > 0)
  assert.equal(recorded.length, 1, 'one well-formed reply must not be retried')

  // And a real ledger aggregates the same note into the day buckets.
  const realLedger = createUsageLedger({ home, file: path.join(home, 'ledger.json'), sessionsRoot: path.join(home, 'sessions') })
  for (const entry of recorded) realLedger.notePluginUsage(entry)
  assert.deepEqual(realLedger.read().ranges.total.slice(0, 2), [100, 20])
})


test('public-only mode never invokes checker or web and never writes alias-derived fields', async () => {
  const { llm, learned } = verifierSetup({ replies: [] })
  const models = [{ id: 'vendorA/shared', input: [] }, { id: 'vendorB/shared', input: [] }, { id: 'vendorC/only:free', input: [] }]
  const routes = { relay: { models } }
  let writes = 0
  llm.listModels = async () => models
  llm.listConfigurableProviders = () => [{ provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers','relay'], declared: true }]
  llm.prepareCall = () => assert.fail('no paid checker in public-only mode')
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: routes } }],
    async mutate(_ns, ops) { writes++; for (const op of ops) models[Number(op.path[3])][op.path[4]] = op.value },
  }
  const data = {
    vendorA: { models: { shared: { id: 'shared', modalities: { input: ['text','image'] }, limit: { context: 999 } } } },
    vendorB: { models: { shared: { id: 'shared', modalities: { input: ['text'] }, limit: { context: 123 } } } },
    vendorC: { models: { only: { id: 'only', modalities: { input: ['text','image'] } } } },
  }
  const run = createCapabilityVerifier({ llm, settings, learned, web: { search: () => assert.fail('no web search') },
    fetch: async url => Response.json(String(url).endsWith('/api.json') && String(url).includes('models.dev') ? data : {}),
    logger: { warn() {} },
  })
  const strict = await run.start({ useChecker: false, webSearch: true, writeBack: true })
  assert.deepEqual([strict.done, strict.unknown, strict.publicOnly, strict.aliasMatches, strict.searchCalls], [2, 1, 2, 0, 0])
  assert.equal(learned.getExact(models[0].id).contextWindow, 999)
  assert.equal(learned.getExact(models[1].id).contextWindow, 123)
  assert.equal(writes, 0)
  assert.equal(strict.writeBack, false)
  const fuzzy = await run.start({ useChecker: false, fuzzyMatch: true, writeBack: true })
  assert.deepEqual([fuzzy.done, fuzzy.skippedKnown, fuzzy.aliasMatches, writes], [1, 2, 1, 0])
  assert.deepEqual(models[2].input, [])
  assert.equal(learned.getExact(models[2].id).publicAlias, true)
  await run.start({ useChecker: false, fuzzyMatch: false })
  assert.equal(learned.getExact(models[2].id), undefined)
})


test('catalog aliases cannot leak into prompted automatic writeback', async () => {
  const models = [{ id: 'vendor/target:free', input: [] }]
  const model = models[0]
  const settings = { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { relay: { models } } } }],
    mutate: async (_ns, ops) => { for (const op of ops) model[op.path.at(-1)] = op.value },
  }
  const { llm, learned } = verifierSetup({ replies: ['[{"id":"vendor/target:free","contextWindow":10000}]'] })
  llm.listModels = async () => models
  llm.listConfigurableProviders = () => [{ provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers','relay'], declared: true }]
  const data = { vendor: { models: { target: { id: 'target', modalities: { input: ['text','image'] } } } } }
  const run = createCapabilityVerifier({ llm, settings, configEditor: configEditorFor(settings), learned, fetch: async () => Response.json(data) })
  await run.start({ checker: { provider: 'relay', model: 'checker' }, writeBack: true, fuzzyMatch: true })
  assert.equal(model.contextWindow, 10000)
  assert.deepEqual(model.input, [])
})


test('exact qualified public facts write to the corresponding vendor only', async () => {
  const models = [{ id: 'vendorA/shared', input: [] }, { id: 'vendorB/shared', input: [] }, { id: 'shared', input: [] }]
  const settings = { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { relay: { models } } } }],
    mutate: async (_ns, ops) => { for (const op of ops) models[Number(op.path[3])][op.path[4]] = op.value },
  }
  const { llm, learned } = verifierSetup({ replies: ['[]'] })
  llm.listModels = async () => models
  llm.listConfigurableProviders = () => [{ provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers','relay'], declared: true }]
  const data = {
    vendorA: { models: { shared: { id: 'shared', modalities: { input: ['text','image'] }, limit: { context: 999 } } } },
    vendorB: { models: { shared: { id: 'shared', modalities: { input: ['text'] }, limit: { context: 123 } } } },
  }
  const run = createCapabilityVerifier({ llm, settings, configEditor: configEditorFor(settings), learned, fetch: async url => Response.json(String(url).includes('models.dev/api.json') ? data : {}) })
  const result = await run.start({ checker: { provider: 'relay', model: 'checker' }, writeBack: true, fuzzyMatch: true })
  assert.deepEqual(models.map(model => model.contextWindow), [999, 123, undefined])
  assert.deepEqual(models.map(model => model.input), [['text','image'], ['text'], []])
  assert.equal(result.aliasMatches, 0)
})


test('cancelled writeback stays pending until the actual host mutation settles, without rewriting later sweep state', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const applyObserved = Promise.withResolvers()
  const settings = defaultSettings()
  const apply = settings.mutate.bind(settings)
  let dispatches = 0
  settings.mutate = async (ns, ops) => {
    dispatches++
    entered.resolve()
    await release.promise
    await apply(ns, ops)
  }
  const llm = fakeLlm(['[{"id":"model-a","input":["image"]},{"id":"model-b","contextWindow":4096}]'])
  const verifier = createCapabilityVerifier({
    llm, settings, configEditor: configEditorFor(settings),
    learned: { upsertEntries() {}, meta() {} }, fetch: async () => new Response('{}'), logger: { warn() {} },
    onApplied: () => applyObserved.resolve(), timeoutMs: 1000,
  })
  const options = { checker: { provider: 'relay', model: 'checker-x' }, writeBack: true }
  const first = verifier.start(options)
  await entered.promise
  verifier.cancel()
  const stopped = await first
  assert.equal(stopped.phase, 'cancelled')
  assert.equal(stopped.done, 2)
  assert.equal(stopped.processed, 2)
  assert.equal(stopped.pendingWrite.model, 'model-a')
  assert.equal(stopped.pendingWrite.waitEnded, 'CANCELLED')
  const blocked = await verifier.start(options)
  assert.equal(dispatches, 1)
  assert.match(blocked.errors.join(), /previous dispatched settings mutation has not settled/)
  assert.equal(blocked.batches[0].written, undefined)
  release.resolve()
  await applyObserved.promise
  const settled = verifier.snapshot()
  assert.equal(settled.latestWriteSettlement.model, 'model-a')
  assert.equal(settled.latestWriteSettlement.written, true)
  assert.equal(settled.pendingWrite, undefined)
  assert.equal(settled.batches[0].written, undefined)
})

test('incremental writeback asks for a full scan without writing old unverifiable facts', async () => {
  const settings = defaultSettings()
  const { llm, learned } = verifierSetup({ settings, replies: [] })
  for (const id of ['model-a', 'model-b']) learned.upsertEntries({ id, input: ['image'], origins: ['checker'] })
  const verifier = createCapabilityVerifier({ llm, settings, configEditor: configEditorFor(settings), learned, fetch: () => assert.fail('no incremental fetch') })
  const state = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: true })
  assert.equal(state.skippedKnown, 2)
  assert.match(state.errors.join(), /run a full scan with write-back enabled/)
  assert.equal(settings.calls.length, 0)
})
