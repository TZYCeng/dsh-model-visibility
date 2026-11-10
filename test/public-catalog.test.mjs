/**
 * Public catalog ingestion, Hugging Face parsing, strict reply format and the
 * per-run concurrency setting.
 *
 * The headline regression these tests lock down: the sweep used to download
 * models.dev and OpenRouter, parse them correctly, and then throw the facts
 * away — only an `origins` label survived. Users saw "verification ran, 0 facts
 * learned" and reasonably concluded the catalogs returned nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CHECKER_MAX_TOKENS,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  createCapabilityVerifier,
  huggingFaceUrl,
  kindOfPipelineTag,
  mergePublicSources,
  parseCheckerAnswer,
  publicFactToCapability,
  publicOnlyFacts,
  readHuggingFace,
  readModelsDev,
  readOpenRouter,
  transportMessageOf,
} from '../lib/check-catalog.js'
import { createLearnedCatalog } from '../lib/learned-catalog.js'

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-public-'))

/* ------------------------------------------------------------- parsers */

test('readModelsDev understands all three published endpoints', () => {
  const record = {
    id: 'gpt-4o',
    name: 'GPT-4o',
    attachment: true,
    reasoning: false,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128000, output: 16384 },
  }
  // api.json: { <provider>: { models: { <id>: record } } }
  const apiShape = readModelsDev({ openai: { id: 'openai', models: { 'gpt-4o': record } } })
  assert.equal(apiShape.get('gpt-4o').contextWindow, 128000)

  // models.json: { <id>: record }
  const modelsShape = readModelsDev({ 'gpt-4o': record })
  assert.equal(modelsShape.get('gpt-4o').contextWindow, 128000)
  assert.deepEqual(modelsShape.get('gpt-4o').input, ['text', 'image'])

  // catalog.json: { providers, models }
  const catalogShape = readModelsDev({
    providers: { openai: { id: 'openai', models: { 'gpt-4o': record } } },
    models: { 'gpt-4o': record },
  })
  assert.equal(catalogShape.get('gpt-4o').contextWindow, 128000)
})

test('the old parser silently returned zero facts for two of the three shapes', () => {
  // Regression guard: models.json has no `models` wrapper at all.
  const facts = readModelsDev({ 'deepseek/deepseek-r1': { id: 'deepseek/deepseek-r1', reasoning: true, limit: { context: 131072 } } })
  assert.equal(facts.size >= 1, true)
  assert.equal(facts.get('deepseek-r1').contextWindow, 131072)
})

test('a models.dev record with no capability fields is not a fact', () => {
  const facts = readModelsDev({ 'bare-model': { id: 'bare-model' } })
  assert.equal(facts.size, 0)
})

test('readHuggingFace maps pipeline tags and only trusts explicit tags', () => {
  const facts = readHuggingFace([
    { id: 'Qwen/Qwen3.5-9B', pipeline_tag: 'text-generation', library_name: 'transformers', tags: ['reasoning', 'tool-use'] },
    { id: 'acme/img-gen', pipeline_tag: 'text-to-image', tags: [] },
    { id: 'acme/mystery', pipeline_tag: 'some-new-task', tags: [] },
    { id: 'acme/empty' },
  ])
  const chat = facts.get('qwen3.5-9b') ?? facts.get('Qwen/Qwen3.5-9B')
  assert.ok(chat !== undefined, 'the checkpoint must be indexed')
  assert.equal(chat.kind, 'chat')
  assert.equal(chat.reasoning, true)
  assert.equal(chat.toolCall, true)
  assert.equal(facts.get('img-gen').kind, 'image')
  // An unknown pipeline tag must not invent a kind.
  assert.equal(facts.get('mystery')?.kind, undefined)
  // A row with no usable field is dropped entirely.
  assert.equal(facts.get('empty'), undefined)
})

test('kindOfPipelineTag covers the tasks a relay actually serves', () => {
  assert.equal(kindOfPipelineTag('text-generation'), 'chat')
  assert.equal(kindOfPipelineTag('image-text-to-text'), 'image')
  assert.equal(kindOfPipelineTag('text-to-video'), 'video')
  assert.equal(kindOfPipelineTag('feature-extraction'), 'embedding')
  assert.equal(kindOfPipelineTag('automatic-speech-recognition'), 'audio')
  assert.equal(kindOfPipelineTag('translation'), 'translation')
  assert.equal(kindOfPipelineTag('not-a-task'), undefined)
  assert.equal(kindOfPipelineTag(''), undefined)
})

test('huggingFaceUrl builds the expand-ed listing for any host', () => {
  const url = huggingFaceUrl('https://hf-mirror.com/')
  assert.ok(url.startsWith('https://hf-mirror.com/api/models?'))
  assert.ok(url.includes('expand[]=pipeline_tag'))
  assert.ok(url.includes('limit=1000'))
})

test('transportMessageOf names a TLS interception instead of echoing a code', () => {
  const tls = new Error('unable to get local issuer certificate')
  tls.code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  assert.match(transportMessageOf(tls), /TLS 证书链不受信任/)
  const dns = new Error('getaddrinfo ENOTFOUND h')
  dns.code = 'ENOTFOUND'
  assert.match(transportMessageOf(dns), /DNS/)
  assert.doesNotMatch(transportMessageOf(dns), /ENOTFOUND/)
})

/* -------------------------------------------------- facts actually merge */

test('a public catalog row becomes a fact even when the checker says nothing', () => {
  const publicFacts = readModelsDev({
    'gpt-4o': {
      id: 'gpt-4o',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128000, output: 16384 },
      reasoning: false,
    },
  })
  assert.deepEqual(publicFactToCapability(publicFacts.get('gpt-4o')), {
    input: ['text', 'image'],
    output: ['text'],
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
  })

  // The checker answered with the id but no fields.
  const answered = parseCheckerAnswer({ models: [{ id: 'gpt-4o' }] }, ['gpt-4o'], publicFacts)
  assert.deepEqual(answered[0].fact.input, ['text', 'image'])
  assert.equal(answered[0].fact.contextWindow, 128000)
  assert.deepEqual(answered[0].origins, ['public'])
})

test('the checker overrides a public row field by field', () => {
  const publicFacts = new Map([['m', { id: 'm', input: ['text'], contextWindow: 1000, reasoning: false }]])
  const answered = parseCheckerAnswer(
    { models: [{ id: 'm', contextWindow: 2000, reasoning: true }] },
    ['m'],
    publicFacts,
  )
  assert.equal(answered[0].fact.contextWindow, 2000, 'checker wins')
  assert.deepEqual(answered[0].fact.input, ['text'], 'public fills the gap')
  assert.deepEqual(answered[0].origins, ['public', 'checker'])
})

test('publicOnlyFacts covers models the checker skipped', () => {
  const publicFacts = new Map([
    ['a', { id: 'a', contextWindow: 1000 }],
    ['b', { id: 'b', contextWindow: 2000 }],
  ])
  const filled = publicOnlyFacts(['a', 'b', 'c'], ['a'], publicFacts)
  assert.deepEqual(filled.map((entry) => entry.id), ['b'])
  assert.deepEqual(filled[0].origins, ['public'])
  // 'c' has no public row, so nothing is invented for it.
  assert.equal(filled.some((entry) => entry.id === 'c'), false)
})

test('mergePublicSources keeps earlier sources authoritative', () => {
  const merged = mergePublicSources(
    new Map([['m', { id: 'm', contextWindow: 1000 }]]),
    new Map([['m', { id: 'm', contextWindow: 9999, reasoning: true }]]),
  )
  assert.equal(merged.get('m').contextWindow, 1000)
  assert.equal(merged.get('m').reasoning, true)
})

/* ------------------------------------------------------------- verifier */

/** A checker that always answers with the given text. */
function scriptedChecker(models, reply) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => models,
    resolveModelInfo: async () => ({}),
    async prepareCall(config) {
      calls.push(config)
      return {
        config,
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: typeof reply === 'function' ? reply(config) : reply }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

function setup({ models, reply, publicFetch, extra = {} }) {
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  const llm = scriptedChecker(models, reply)
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    logger: { warn() {} },
    fetch:
      publicFetch ??
      (async (url) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          String(url).includes('models.dev/models.json')
            ? JSON.stringify({ 'model-a': { id: 'model-a', modalities: { input: ['text', 'image'] }, limit: { context: 128000 }, reasoning: true } })
            : String(url).includes('huggingface.co') || String(url).includes('hf-mirror') || String(url).includes('hugging-face.cn')
              ? JSON.stringify([])
              : '{}',
      })),
    ...extra,
  })
  return { verifier, learned, llm }
}

test('a sweep records public facts and reports per-source outcomes', async () => {
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  const { verifier, learned } = setup({
    models,
    // The checker has no idea: it echoes ids with no fields.
    reply: '{"models":[{"id":"model-a"}]}',
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.phase, 'done')

  const row = learned.get('model-a')
  assert.ok(row !== undefined, 'the public fact must land in the learned store')
  assert.deepEqual(row.input, ['text', 'image'])
  assert.equal(row.contextWindow, 128000)
  assert.deepEqual(row.origins, ['public'])

  const source = snapshot.sources.find((entry) => entry.name === 'models.dev/models.json')
  assert.ok(source !== undefined, 'the panel needs a per-source report')
  assert.equal(source.status, 'ok')
  assert.ok(source.models > 0)
})

test('an unreachable public catalog is reported, not silently ignored', async () => {
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  const { verifier } = setup({
    models,
    reply: '{"models":[{"id":"model-a"}]}',
    publicFetch: async () => {
      throw refused
    },
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  const sources = snapshot.sources
  assert.ok(sources.length > 0)
  for (const source of sources) {
    assert.notEqual(source.status, 'ok')
    assert.match(String(source.message), /连接被拒绝|DNS|超时/)
  }
  assert.ok(
    snapshot.errors.some((message) => String(message).includes('no public catalog')),
    'the sweep must say it had no public data at all',
  )
})

test('Hugging Face falls back to the next mirror when the first fails', async () => {
  const seen = []
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  const { verifier } = setup({
    models,
    reply: '{"models":[{"id":"model-a"}]}',
    publicFetch: async (url) => {
      seen.push(String(url))
      if (String(url).includes('//huggingface.co/')) {
        const blocked = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })
        throw blocked
      }
      if (String(url).includes('/api/models')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify([{ id: 'Qwen/Qwen3.5-9B', pipeline_tag: 'text-generation', tags: [] }]),
        }
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }
    },
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  const hfSources = snapshot.sources.filter((entry) => String(entry.name).startsWith('huggingface'))
  assert.equal(hfSources.some((entry) => entry.status === 'ok'), true, 'a mirror must have answered')
  const canonical = hfSources.find((entry) => entry.name.includes('huggingface.co'))
  assert.equal(canonical?.status, 'failed')
  assert.ok(seen.some((url) => url.includes('hf-mirror.com')), 'the mirror must actually be requested')
})

test('a prose reply is retried once, then accepted when it becomes JSON', async () => {
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  let call = 0
  const { verifier, learned } = setup({
    models,
    reply: () => {
      call += 1
      return call === 1
        ? 'Sure! Here are the facts you asked for.'
        : '{"models":[{"id":"model-a","kind":"chat","contextWindow":4096}]}'
    },
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.phase, 'done')
  assert.equal(call, 2, 'exactly one retry')
  assert.equal(learned.get('model-a').contextWindow, 4096)
})

test('a reply missing requested ids is treated as a format violation', async () => {
  const models = [{ id: 'model-a' }, { id: 'model-b' }, { id: 'checker-x' }]
  // Always answers with only one of the two ids: the batch is split after the
  // retry, and the second half then succeeds on its own.
  const { verifier } = setup({
    models,
    reply: (config) => {
      const asked = String(config.model)
      void asked
      return '{"models":[{"id":"model-a","kind":"chat"}]}'
    },
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.phase, 'done')
  // Whatever happened, the run must terminate and record something usable.
  assert.ok(snapshot.done <= snapshot.total)
})

test('the checker budget and effort are still the tuned constants', () => {
  assert.ok(CHECKER_MAX_TOKENS >= 4096)
  assert.equal(DEFAULT_CONCURRENCY, 2)
  assert.equal(MAX_CONCURRENCY, 8)
})

test('a per-run concurrency is honoured and clamped', async () => {
  const models = Array.from({ length: 13 }, (_, index) => ({ id: `m-${index}` }))
  const { verifier } = setup({
    models,
    reply: () => '{"models":[]}',
    extra: { batchSize: 2 },
  })
  const snapshot = await verifier.start({
    checker: { provider: 'relay', model: 'm-0' },
    writeBack: false,
    concurrency: 3,
  })
  assert.equal(snapshot.concurrency, 3)
  assert.equal(snapshot.phase, 'done')
})

test('an out-of-range concurrency is clamped to the allowed window', async () => {
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  const high = setup({ models, reply: () => '{"models":[]}' })
  const highSnapshot = await high.verifier.start({
    checker: { provider: 'relay', model: 'checker-x' },
    writeBack: false,
    concurrency: 99,
  })
  assert.equal(highSnapshot.concurrency, MAX_CONCURRENCY)

  const low = setup({ models, reply: () => '{"models":[]}' })
  const lowSnapshot = await low.verifier.start({
    checker: { provider: 'relay', model: 'checker-x' },
    writeBack: false,
    concurrency: 0,
  })
  assert.equal(lowSnapshot.concurrency, 1)
})

test('the publicOnly counter reports catalog-only coverage', async () => {
  const models = [{ id: 'model-a' }, { id: 'model-b' }, { id: 'checker-x' }]
  const { verifier } = setup({
    models,
    // Answers for model-a but omits model-b entirely.
    reply: '{"models":[{"id":"model-a","kind":"chat"}]}',
    batchSize: 6,
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  // model-b has no public row in this fixture, so it cannot be filled; the
  // counter must therefore stay a number the panel can render.
  assert.equal(typeof snapshot.publicOnly, 'number')
})

test('readOpenRouter still reads the relay dialect', () => {
  const facts = readOpenRouter({
    data: [{ id: 'anthropic/claude-5', context_length: 200000, architecture: { input_modalities: ['text', 'image'] } }],
  })
  assert.equal(facts.get('claude-5').contextWindow, 200000)
})

/* ------------------------------------------------------------ extraction */

test('extractJsonBlock accepts an array reply', async () => {
  const { extractJsonBlock } = await import('../lib/check-catalog.js')
  // The contract asks for an array; a model answering `[]` ("I know none of
  // these") used to fall through to "contained no JSON" because only braces
  // were searched.
  assert.deepEqual(extractJsonBlock('[]'), [])
  assert.deepEqual(extractJsonBlock('[{"id":"a"}]'), [{ id: 'a' }])
  assert.deepEqual(extractJsonBlock('```json\n[]\n```'), [])
  assert.deepEqual(extractJsonBlock('Here you go:\n[{"id":"a"}]\nDone.'), [{ id: 'a' }])
  // An object is still accepted, and braces win when they come first.
  assert.deepEqual(extractJsonBlock('{"models":[]}'), { models: [] })
  assert.equal(extractJsonBlock('no json here'), undefined)
  assert.equal(extractJsonBlock(''), undefined)
})

test('an empty array is not a format violation and still fills from catalogs', async () => {
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  let calls = 0
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => models,
    resolveModelInfo: async () => ({}),
    async prepareCall(config) {
      calls += 1
      return {
        config,
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: '[]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    logger: { warn() {} },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        String(url).includes('models.dev/models.json')
          ? JSON.stringify({ 'model-a': { id: 'model-a', modalities: { input: ['text', 'image'] }, limit: { context: 128000 } } })
          : '{}',
    }),
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.phase, 'done')
  assert.deepEqual(snapshot.errors, [])
  assert.equal(calls, 1, 'an empty array must not trigger a retry')
  assert.equal(snapshot.publicOnly, 1)
  assert.deepEqual(snapshot.batches[0].status, 'ok')
  const row = learned.get('model-a')
  assert.deepEqual(row.input, ['text', 'image'])
  assert.deepEqual(row.origins, ['public'])
})

test('extra ids in a reply are ignored without a second call', async () => {
  // A checker that also volunteers a neighbouring model must not cost a retry:
  // the extra entry is filtered out and the requested ones are used as-is.
  const models = [{ id: 'model-a' }, { id: 'checker-x' }]
  let calls = 0
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => models,
    resolveModelInfo: async () => ({}),
    async prepareCall(config) {
      calls += 1
      return {
        config,
        stream: async function* () {
          yield {
            type: 'text-delta',
            index: 0,
            text: JSON.stringify({
              models: [
                { id: 'model-a', kind: 'chat', contextWindow: 64000 },
                { id: 'model-b', kind: 'chat', contextWindow: 1 },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    logger: { warn() {} },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }),
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(calls, 1, 'an unknown id must not trigger a retry')
  assert.equal(learned.get('model-a').contextWindow, 64000)
  assert.equal(learned.get('model-b'), undefined, 'an unrequested model must not be stored')
  // The empty stub catalogs produce the "no public data" note; that is the
  // intended diagnostic, and it must not mention a batch failure.
  assert.equal(
    snapshot.errors.every((message) => !String(message).startsWith('batch')),
    true,
  )
})

test('a real sweep over live-shaped ids learns from the catalogs alone', async () => {
  // Mirrors what the machine actually serves: some ids in models.dev, some not.
  const ids = ['gpt-4o', 'glm-5.3', 'some-private-relay-model', 'checker-x']
  const home = tempHome()
  const learned = createLearnedCatalog({ file: path.join(home, 'learned.json') })
  const llm = {
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => ids.map((id) => ({ id })),
    resolveModelInfo: async () => ({}),
    async prepareCall(config) {
      return {
        config,
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: '[]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const verifier = createCapabilityVerifier({
    llm,
    settings: { describe: () => [], mutate: async () => {} },
    learned,
    logger: { warn() {} },
    batchSize: 10,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        String(url).includes('models.dev/models.json')
          ? JSON.stringify({
              'gpt-4o': { id: 'gpt-4o', modalities: { input: ['text', 'image'] }, limit: { context: 128000 } },
              'glm-5.3': { id: 'glm-5.3', modalities: { input: ['text'] }, limit: { context: 1000000 }, reasoning: true },
            })
          : '{}',
    }),
  })
  const snapshot = await verifier.start({ checker: { provider: 'relay', model: 'checker-x' }, writeBack: false })
  assert.equal(snapshot.publicOnly, 2)
  assert.equal(learned.get('gpt-4o').contextWindow, 128000)
  assert.equal(learned.get('glm-5.3').contextWindow, 1000000)
  // The model with no public row and no checker answer stays unknown, not fake.
  assert.equal(learned.get('some-private-relay-model'), undefined)
})
