/**
 * Learned-snapshot matching, name heuristics and evidence precedence.
 *
 * These tests are pure: no DSH runtime, no network, no settings document.
 *
 * DSH_HOME must point at a scratch directory BEFORE the modules load: the
 * catalog layer falls back to `$DSH_HOME/dsh-model-visibility/learned.json` for
 * callers that do not inject a store, and reading the machine's real snapshot
 * made these assertions depend on whatever the user had verified.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-capability-'))
process.env.DSH_HOME = SANDBOX_HOME

import {
  inferInputModalities,
  inferModelKind,
  isGenerationKind,
  isNonChatKind,
} from '../lib/capability-catalog.js'
import { modelIdVariants, normalizeModelId } from '../lib/model-id.js'
import { createLearnedCatalog } from '../lib/learned-catalog.js'
import { lookupCorrection } from '../lib/capability-corrections.js'
import { indexDiscovered, mergeCapabilities } from '../lib/model-info.js'

/** The learned file the module-level fallback would read, for the assertions. */
const FALLBACK_FILE = path.join(SANDBOX_HOME, 'dsh-model-visibility', 'learned.json')

test('the pure merge never reads the machine’s real learned snapshot', () => {
  // Guard the sandbox itself: if this file exists, the isolation is broken and
  // the assertions below would be measuring the user's data.
  assert.equal(fs.existsSync(FALLBACK_FILE), false)
})

test('normalizeModelId strips aggregator prefixes and request suffixes', () => {
  assert.equal(normalizeModelId('openai/gpt-image-2'), 'gpt-image-2')
  assert.equal(normalizeModelId('~anthropic/claude-fable-latest'), 'claude-fable-latest')
  assert.equal(normalizeModelId('anthropic.claude-fable-5'), 'claude-fable-5')
  assert.equal(normalizeModelId('global.xai.grok-4.7'), 'grok-4.7')
  assert.equal(normalizeModelId('deepseek-v4-pro:free'), 'deepseek-v4-pro')
  assert.equal(normalizeModelId('gpt-4:free:batch'), 'gpt-4')
  assert.equal(normalizeModelId('gpt-4-free:thinking'), 'gpt-4')
  assert.equal(normalizeModelId('  GPT-6-SOL  '), 'gpt-6-sol')
})

test('modelIdVariants falls back through resolution and compact forms', () => {
  const variants = modelIdVariants('openai/gpt-image-2.5-flare-4k')
  assert.deepEqual(variants, [
    'gpt-image-2.5-flare-4k',
    'gpt-image-2.5-flare',
    'gptimage25flare4k',
  ])
  assert.equal(variants[0], 'gpt-image-2.5-flare-4k')
})

test('the learned store resolves every alias spelling of one id', () => {
  const store = createLearnedCatalog({ file: unreachable() })
  store.upsertEntries([
    {
      id: 'grok-4.7',
      type: 'chat',
      input: ['text', 'image'],
      reasoning: true,
      contextWindow: 500000,
      provider: 'xai',
      origins: ['checker'],
      verifiedAt: 1000,
    },
  ])
  const grok = store.get('x-ai/grok-4.7')
  assert.equal(grok.id, 'grok-4.7')
  assert.equal(grok.type, 'chat')
  assert.deepEqual(grok.input, ['text', 'image'])
  assert.equal(grok.reasoning, true)
  assert.equal(grok.contextWindow, 500000)
  assert.equal(store.get('totally-unknown-model-xyz'), undefined)
})

/** A broken path forces an in-memory store the mtime memoizer never reloads. */
function unreachable() {
  if (process.platform === 'win32') return 'C:\\<unreachable>\\learned.json'
  return '/<unreachable>/learned.json'
}

test('inferModelKind recognizes generation and infrastructure models', () => {
  assert.equal(inferModelKind('gpt-image-2.5-flare'), 'image')
  assert.equal(inferModelKind('gemini-3.1-flash-image'), 'image')
  assert.equal(inferModelKind('grok-imagine-video-1.5'), 'video')
  assert.equal(inferModelKind('sora-2'), 'video')
  assert.equal(inferModelKind('nemotron-3.5-embed-1b'), 'embedding')
  assert.equal(inferModelKind('nv-embed-v1'), 'embedding')
  assert.equal(inferModelKind('bge-reranker-v2'), 'rerank')
  assert.equal(inferModelKind('riva-translate-4b-instruct-v2'), 'translation')
  assert.equal(inferModelKind('nemotron-3.5-content-safety'), 'classifier')
  assert.equal(inferModelKind('grok-4.7'), 'chat')
  assert.equal(inferModelKind('codex-auto-review'), 'chat')
  assert.equal(inferModelKind(''), undefined)
  assert.equal(isGenerationKind('image'), true)
  assert.equal(isGenerationKind('video'), true)
  assert.equal(isGenerationKind('embedding'), false)
  assert.equal(isNonChatKind('embedding'), true)
  assert.equal(isNonChatKind('chat'), false)
})

test('inferInputModalities only claims image for known chat families', () => {
  assert.deepEqual(inferInputModalities('grok-4.7'), ['text', 'image'])
  assert.deepEqual(inferInputModalities('claude-fable-5'), ['text', 'image'])
  assert.deepEqual(inferInputModalities('gemini-3.8-flash'), ['text', 'image'])
  assert.deepEqual(inferInputModalities('gpt-6-sol'), ['text', 'image'])
  assert.equal(inferInputModalities('totally-new-model'), undefined)
  assert.equal(inferInputModalities('gpt-3.5-turbo'), undefined)
})

/** A relay profile whose per-model `input` is the empty array (DSH default). */
function relayProfile(models) {
  return {
    id: 'relay',
    api: 'openai-completions',
    baseURL: 'https://relay.example/v1',
    defaultInput: ['text'],
    models: new Map(models.map((id) => [id, { id, input: [] }])),
  }
}

test('mergeCapabilities ignores a defaulted text-only adapter declaration', () => {
  const record = mergeCapabilities(
    { id: 'grok-4.7', name: 'grok-4.7' },
    {
      adapter: { id: 'grok-4.7', name: 'grok-4.7', inputModalities: ['text'], contextWindow: 262144 },
      profile: relayProfile(['grok-4.7']),
      learned: {
        id: 'grok-4.7',
        type: 'chat',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 500000,
        provider: 'xai',
        origins: ['checker'],
        verifiedAt: 1000,
      },
    },
  )
  assert.equal(record.kind, 'chat')
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.sources.modalities, 'snapshot')
  assert.equal(record.contextWindow, 500000)
  assert.equal(record.sources.context, 'snapshot')
  assert.equal(record.learned.id, 'grok-4.7')
})

test('mergeCapabilities prefers explicit config over every fallback', () => {
  const profile = {
    id: 'relay',
    defaultInput: ['text'],
    models: new Map([['mystery-vl', { id: 'mystery-vl', input: ['text', 'image'], contextWindow: 1234, maxTokens: 99 }]]),
  }
  const record = mergeCapabilities(
    { id: 'mystery-vl', name: 'Mystery VL' },
    {
      adapter: { id: 'mystery-vl', name: 'Mystery VL', inputModalities: ['text'], contextWindow: 262144 },
      profile,
      discovered: { id: 'mystery-vl', inputModalities: ['text'], contextWindow: 2048 },
      learned: { id: 'mystery-vl', type: 'chat', contextWindow: 999 },
    },
  )
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.sources.modalities, 'config')
  assert.equal(record.contextWindow, 1234)
  assert.equal(record.sources.context, 'config')
  assert.equal(record.defaultMaxTokens, 99)
})

test('mergeCapabilities lets a relay listing beat a learned fact', () => {
  const record = mergeCapabilities(
    { id: 'grok-4.7', name: 'grok-4.7' },
    {
      adapter: { id: 'grok-4.7', name: 'grok-4.7', inputModalities: ['text'] },
      profile: relayProfile(['grok-4.7']),
      discovered: { id: 'grok-4.7', inputModalities: ['text'], contextWindow: 131072, reasoning: false },
      learned: { id: 'grok-4.7', type: 'chat', input: ['text', 'image'], reasoning: true },
    },
  )
  assert.deepEqual(record.inputModalities, ['text'])
  assert.equal(record.sources.modalities, 'provider')
  assert.equal(record.contextWindow, 131072)
  assert.equal(record.reasoningSupported, false)
  assert.equal(record.sources.reasoning, 'provider')
})

test('a learned fact can supply a reasoning ladder', () => {
  const record = mergeCapabilities(
    { id: 'relay-only-model', name: 'relay-only-model' },
    {
      profile: relayProfile(['relay-only-model']),
      learned: {
        id: 'relay-only-model',
        type: 'chat',
        reasoning: true,
        reasoningEfforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'high',
        origins: ['public'],
        verifiedAt: 42,
      },
    },
  )
  assert.equal(record.reasoningSupported, true)
  assert.equal(record.sources.reasoning, 'snapshot')
  assert.deepEqual(record.reasoning.efforts, [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ])
  assert.equal(record.reasoning.defaultEffort, 'high')
  assert.equal(record.learned.origins[0], 'public')
})

test('mergeCapabilities labels image and video models and keeps no chat facts', () => {
  const image = mergeCapabilities(
    { id: 'gpt-image-2.5-flare-4k', name: 'gpt-image-2.5-flare-4k' },
    {
      adapter: { id: 'gpt-image-2.5-flare-4k', name: 'gpt-image-2.5-flare-4k', inputModalities: ['text'], contextWindow: 262144 },
      profile: relayProfile(['gpt-image-2.5-flare-4k']),
      learned: { id: 'gpt-image-2.5-flare-4k', type: 'image', input: ['text', 'image'], output: ['image'] },
    },
  )
  assert.equal(image.kind, 'image')
  assert.equal(image.sources.kind, 'snapshot')
  assert.deepEqual(image.outputModalities, ['image'])
  assert.deepEqual(image.inputModalities, ['text', 'image'])
  assert.equal(image.contextWindow, undefined)

  const video = mergeCapabilities(
    { id: 'grok-imagine-video-1.5', name: 'grok-imagine-video-1.5' },
    {
      adapter: {
        id: 'grok-imagine-video-1.5',
        name: 'grok-imagine-video-1.5',
        inputModalities: ['text'],
        contextWindow: 262144,
      },
      profile: relayProfile(['grok-imagine-video-1.5']),
    },
  )
  assert.equal(video.kind, 'video')
  assert.deepEqual(video.outputModalities, ['video'])
  assert.equal(video.contextWindow, undefined)
})

test('mergeCapabilities leaves unknown facts unknown instead of using adapter defaults', () => {
  const record = mergeCapabilities(
    { id: 'brand-new-relay-model', name: 'Brand New Relay Model' },
    {
      adapter: {
        id: 'brand-new-relay-model',
        name: 'Brand New Relay Model',
        inputModalities: ['text'],
        contextWindow: 262144,
        defaultMaxTokens: 32768,
      },
      profile: relayProfile(['brand-new-relay-model']),
    },
  )
  assert.equal(record.kind, 'chat')
  assert.equal(record.inputModalities, undefined)
  assert.equal(record.contextWindow, undefined)
  assert.equal(record.sources.modalities, 'unknown')
  assert.equal(record.sources.context, 'unknown')
  assert.equal(record.reasoningSupported, undefined)
  assert.equal(record.sources.reasoning, 'unknown')
  assert.equal(record.defaultMaxTokens, undefined)
})

test('mergeCapabilities trusts built-in adapters that have no settings profile', () => {
  const record = mergeCapabilities(
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    {
      adapter: {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        inputModalities: ['text'],
        contextWindow: 1048576,
        defaultMaxTokens: 65536,
      },
    },
  )
  assert.deepEqual(record.inputModalities, ['text'])
  assert.equal(record.sources.modalities, 'adapter')
  assert.equal(record.contextWindow, 1048576)
  assert.equal(record.sources.context, 'adapter')
  assert.equal(record.defaultMaxTokens, 65536)
})

test('mergeCapabilities uses an explicitly multimodal provider default', () => {
  const profile = {
    id: 'relay',
    defaultInput: ['text', 'image'],
    models: new Map([['custom-vision', { id: 'custom-vision', input: [] }]]),
  }
  const record = mergeCapabilities(
    { id: 'custom-vision', name: 'Custom Vision' },
    { adapter: { id: 'custom-vision', name: 'Custom Vision', inputModalities: ['text'] }, profile },
  )
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.sources.modalities, 'config')
})

test('lookupCorrection targets the exact catalog row, not its variants', () => {
  const glm = lookupCorrection('z-ai/glm-5.3')
  assert.equal(glm.code, 'glm-5.3-text-only')
  assert.deepEqual(glm.input, ['text'])
  assert.equal(glm.source, 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3')
  assert.equal(lookupCorrection('glm-5.3-flash'), undefined)
  assert.equal(lookupCorrection('glm-5p3'), undefined)
  assert.equal(lookupCorrection('grok-4.7'), undefined)
})

test('mergeCapabilities lets a vendor correction beat a wrong learned row', () => {
  const record = mergeCapabilities(
    { id: 'glm-5.3', name: 'glm-5.3' },
    {
      profile: relayProfile(['glm-5.3']),
      learned: {
        id: 'glm-5.3',
        type: 'chat',
        input: ['text', 'image'],
        contextWindow: 1048576,
        origins: ['public'],
        verifiedAt: 7,
      },
    },
  )
  assert.deepEqual(record.inputModalities, ['text'])
  assert.equal(record.sources.modalities, 'official')
  assert.equal(record.correction.code, 'glm-5.3-text-only')
  // The rest of the learned row stays useful.
  assert.equal(record.contextWindow, 1048576)
  assert.equal(record.sources.context, 'snapshot')
})

test('mergeCapabilities lets a vendor correction beat a relay listing too', () => {
  const record = mergeCapabilities(
    { id: 'glm-5.3', name: 'glm-5.3' },
    {
      profile: relayProfile(['glm-5.3']),
      discovered: { id: 'glm-5.3', inputModalities: ['text', 'image'], contextWindow: 2048 },
    },
  )
  assert.deepEqual(record.inputModalities, ['text'])
  assert.equal(record.sources.modalities, 'official')
  assert.equal(record.correction.code, 'glm-5.3-text-only')
  // Other relay facts still come from the relay.
  assert.equal(record.contextWindow, 2048)
  assert.equal(record.sources.context, 'provider')
})

test('mergeCapabilities keeps an explicit provider declaration over a correction', () => {
  const profile = {
    id: 'relay',
    defaultInput: ['text'],
    models: new Map([['glm-5.3', { id: 'glm-5.3', input: ['text', 'image'] }]]),
  }
  const record = mergeCapabilities(
    { id: 'glm-5.3', name: 'glm-5.3' },
    { profile },
  )
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.sources.modalities, 'config')
  assert.equal(record.correction, undefined)
})

test('indexDiscovered matches case and variant spellings', () => {
  const index = indexDiscovered(
    new Map([
      ['openai/GPT-Image-2', { id: 'openai/GPT-Image-2', inputModalities: ['text', 'image'] }],
      ['grok-4.7:free', { id: 'grok-4.7:free', reasoning: true }],
    ]),
  )
  assert.deepEqual(index.get('gpt-image-2').inputModalities, ['text', 'image'])
  assert.equal(index.get('grok-4.7').reasoning, true)
})
