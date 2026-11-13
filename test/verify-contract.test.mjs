/**
 * Verify-sweep contract against the real `llm.prepareCall` shape.
 *
 * The original double faked `prepareCall(config, signal, controls)` and
 * returned a generator, so it never exercised the two things that actually
 * broke in the field:
 *
 *  - `finish.reason.kind === 'max-tokens'` was ignored, so a truncated reply
 *    surfaced as "the checker reply contained no JSON object";
 *  - the output budget was hardcoded at 2048 and no reasoning effort was
 *    pinned, so a thinking checker spent the whole budget on reasoning and
 *    every batch failed (0/191 verified, 32 failed batches, ~63K tokens).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCapabilityVerifier, CHECKER_MAX_TOKENS, CHECKER_REASONING_EFFORT } from '../lib/check-catalog.js'
import { createLearnedCatalog } from '../lib/learned-catalog.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-contract-'))
}

const PUBLIC_EMPTY = {
  ok: true,
  text: async () => '{}',
}

const MODELS = [{ id: 'model-a' }, { id: 'model-b' }, { id: 'checker-x' }]

/**
 * A scripted llm that records every prepareCall option and streams exactly
 * what a real adapter streams.
 * @param options.reply - the text the model emits (may be empty).
 * @param options.reasoning - reasoning-delta chunks to emit before the text.
 * @param options.finishKind - the terminal reason kind.
 */
function scriptedLlm({ reply = '', reasoning = 0, finishKind = 'stop', failOnce = false } = {}) {
  const calls = []
  let attempt = 0
  return {
    calls,
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => MODELS,
    resolveModelInfo: async () => ({ inputModalities: ['text'], contextWindow: 1000 }),
    async prepareCall(config, signal, configure) {
      const recorded = { config: { ...config } }
      calls.push(recorded)
      signal?.throwIfAborted()
      // dsh-llm calls configure before resolving the final config.
      const controls = configure === undefined ? { ...config } : { ...configure({ ...config }, { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }) }
      const resolvedConfig = { ...config, ...controls }
      recorded.config = resolvedConfig
      return {
        config: resolvedConfig,
        stream: async function* () {
          attempt += 1
          if (failOnce && attempt === 1) {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded' } } }
            return
          }
          for (let sent = 0; sent < reasoning; sent += 256) {
            yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(Math.min(256, reasoning - sent)) }
          }
          if (reply !== '') yield { type: 'text-delta', index: 1, text: reply }
          yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } }
          yield { type: 'finish', reason: { kind: finishKind } }
        },
      }
    },
  }
}

function run(verifierOptions, startOptions = {}) {
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  const verifier = createCapabilityVerifier({
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    fetch: async () => PUBLIC_EMPTY,
    logger: { warn() {} },
    ...verifierOptions.extra,
    llm: verifierOptions.llm,
  })
  return verifier
    .start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false, ...startOptions })
    .then((snapshot) => ({ snapshot, learned, llm: verifierOptions.llm }))
}

test('the checker budget is generous enough for a batch of JSON objects', () => {
  // A batch asks for six short objects; 2 048 was not enough once a thinking
  // model spent the allowance before answering.
  assert.ok(CHECKER_MAX_TOKENS >= 4096, 'the checker output budget must leave room for reasoning')
  assert.equal(CHECKER_REASONING_EFFORT, 'low')
})

test('a thinking checker that eats the budget reports truncation, not "no JSON"', async () => {
  const llm = scriptedLlm({ reasoning: CHECKER_MAX_TOKENS, reply: '', finishKind: 'max-tokens' })
  const { snapshot } = await run({ llm })
  assert.equal(snapshot.phase, 'done')
  assert.equal(snapshot.done, 0, 'nothing was verified')
  assert.equal(snapshot.batches.every((batch) => batch.status === 'failed'), true)
  const joined = snapshot.errors.join('\n')
  assert.match(joined, /truncated at \d+ output tokens/)
  assert.match(joined, /spent them on reasoning/)
  assert.doesNotMatch(joined, /contained no JSON object/)
})

test('the sweep pins a low reasoning effort so a thinking checker can answer', async () => {
  const llm = scriptedLlm({ reply: '{"models":[{"id":"model-a","kind":"chat","contextWindow":1000}]}' })
  await run({ llm })
  assert.ok(llm.calls.length >= 1)
  assert.equal(llm.calls[0].config.reasoningEffort, CHECKER_REASONING_EFFORT)
  assert.equal(llm.calls[0].config.maxTokens, CHECKER_MAX_TOKENS)
})

test('the caller can override the budget and disable effort pinning', async () => {
  const llm = scriptedLlm({ reply: '{"models":[{"id":"model-a","kind":"chat"}]}' })
  const home = tempHome()
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned: createLearnedCatalog({ file: path.join(home, 'learned.json') }),
    fetch: async () => PUBLIC_EMPTY,
    logger: { warn() {} },
    checkerMaxTokens: 1234,
    checkerReasoningEffort: null,
  })
  await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(llm.calls[0].config.maxTokens, 1234)
  assert.equal(llm.calls[0].config.reasoningEffort, undefined)
})

test('an empty reply names the real problem', async () => {
  const llm = scriptedLlm({ reply: '', reasoning: 100, finishKind: 'stop' })
  const { snapshot } = await run({ llm })
  assert.match(snapshot.errors.join('\n'), /empty reply/)
})

test('a failing batch is split so the healthy models still land', async () => {
  // One id makes the checker emit junk; the split isolates it and the rest verify.
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  let call = 0
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => [{ id: 'good-1' }, { id: 'poison' }, { id: 'good-2' }],
    resolveModelInfo: async () => ({}),
    async prepareCall(config) {
      call += 1
      return {
        config,
        stream: async function* () {
          const asked = String(config.model)
          void asked
          yield { type: 'text-delta', index: 0, text: 'not json at all' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    fetch: async () => PUBLIC_EMPTY,
    logger: { warn() {} },
    batchSize: 3,
    concurrency: 1,
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' } })
  assert.equal(snapshot.phase, 'done')
  // The split walked down to single-model batches, so the batch count grew.
  assert.ok(call > 1, 'the failing batch must be retried in halves')
  assert.equal(snapshot.done, 0, 'junk replies verify nothing')
})

test('done never exceeds total, even when the checker answers unknown', async () => {
  const llm = scriptedLlm({ reply: '{"models":[{"id":"model-a"},{"id":"model-b"}]}' })
  const { snapshot } = await run({ llm })
  assert.equal(snapshot.phase, 'done')
  assert.ok(snapshot.done <= snapshot.total, `done=${snapshot.done} total=${snapshot.total}`)
})

test('cancel then start joins the old sweep instead of racing it', async () => {
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  let inFlight = 0
  let peak = 0
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => Array.from({ length: 12 }, (_, index) => ({ id: `m-${index}` })),
    resolveModelInfo: async () => ({}),
    async prepareCall(config) {
      return {
        config,
        stream: async function* () {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 40))
          inFlight -= 1
          yield { type: 'text-delta', index: 0, text: '{"models":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    fetch: async () => PUBLIC_EMPTY,
    logger: { warn() {} },
    batchSize: 4,
    concurrency: 2,
  })
  const first = verifier.start({ checker: { provider: 'relay', model: 'm-0' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  verifier.cancel()
  // The old workers are still unwinding; a second start must wait for them.
  const second = verifier.start({ checker: { provider: 'relay', model: 'm-0' } })
  await Promise.all([first, second])
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(peak <= 2, `two sweeps ran at once (peak ${peak} concurrent calls, limit 2)`)
  const snapshot = verifier.snapshot()
  assert.ok(snapshot.done <= snapshot.total, `done=${snapshot.done} total=${snapshot.total}`)
})

test('a batch failure is recorded once with the real message', async () => {
  // Every attempt fails, so the split cannot salvage the batch; the recorded
  // error must be the adapter's own message, not a downstream parse complaint.
  const llm = (() => {
    const base = scriptedLlm({ reply: '' })
    return {
      ...base,
      async prepareCall(config) {
        return {
          config,
          stream: async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded' } } }
          },
        }
      },
    }
  })()
  const { snapshot } = await run({ llm })
  const joined = snapshot.errors.join('\n')
  assert.ok(snapshot.errors.length >= 1)
  assert.match(joined, /upstream exploded/)
})
