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
  assert.deepEqual(facts.get('gpt-6-sol').input, ['text', 'image'])
  assert.equal(facts.get('gpt-6-sol').contextWindow, 400000)
  assert.equal(facts.get('gpt-6-sol').reasoning, true)
  assert.equal(facts.get('vendor-prefix/gpt-6-sol')?.contextWindow, undefined)
})

test('readOpenRouter reuses the relay dialect', () => {
  const facts = readOpenRouter({
    data: [
      { id: 'anthropic/claude-5', context_length: 200000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] },
    ],
  })
  const fact = facts.get('claude-5')
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
    listModels: async () => [{ id: 'model-a' }, { id: 'model-b' }, { id: 'checker-x' }],
    resolveModelInfo: async () => undefined,
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
    describe: () => [{ ns: 'llm-pi-ai', value: { providers } }],
    calls: [],
    async mutate(ns, ops) {
      this.calls.push({ ns, ops })
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

test('a sweep with the write-back switch off only fills the snapshot', async () => {
  const { verifier, learned, settings } = verifierSetup({
    replies: ['{"models":[{"id":"model-a","kind":"chat","input":["text","image"],"contextWindow":222000}]}'],
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.phase, 'done')
  assert.equal(settings.calls.length, 0)
  assert.equal(learned.get('model-a').contextWindow, 222000)
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
