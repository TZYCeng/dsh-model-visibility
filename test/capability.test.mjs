/**
 * Catalog matching, name heuristics and evidence precedence.
 *
 * These tests are pure: no DSH runtime, no network, no settings document.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inferInputModalities,
  inferModelKind,
  isGenerationKind,
  isNonChatKind,
  lookupCatalogModel,
  modelIdVariants,
  normalizeModelId,
} from '../lib/capability-catalog.js'
import { indexDiscovered, mergeCapabilities } from '../lib/model-info.js'

test('normalizeModelId strips aggregator prefixes and request suffixes', () => {
  assert.equal(normalizeModelId('openai/gpt-image-2'), 'gpt-image-2')
  assert.equal(normalizeModelId('~anthropic/claude-fable-latest'), 'claude-fable-latest')
  assert.equal(normalizeModelId('anthropic.claude-fable-5'), 'claude-fable-5')
  assert.equal(normalizeModelId('global.xai.grok-4.7'), 'grok-4.7')
  assert.equal(normalizeModelId('deepseek-v4-pro:free'), 'deepseek-v4-pro')
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

test('lookupCatalogModel finds known models through every alias', () => {
  const grok = lookupCatalogModel('x-ai/grok-4.7')
  assert.equal(grok.id, 'grok-4.7')
  assert.equal(grok.type, 'chat')
  assert.deepEqual(grok.input, ['text', 'image'])
  assert.equal(grok.reasoning, true)
  assert.equal(grok.contextWindow, 500000)

  const fable = lookupCatalogModel('anthropic/claude-fable-5')
  assert.equal(fable.type, 'chat')
  assert.deepEqual(fable.input, ['text', 'image'])
  assert.equal(fable.contextWindow, 1000000)

  const image = lookupCatalogModel('openai/gpt-image-2.5-flare')
  assert.equal(image.type, 'image')
  assert.deepEqual(image.output, ['image'])

  assert.equal(lookupCatalogModel('totally-unknown-model-xyz'), undefined)
})

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
    },
  )
  assert.equal(record.kind, 'chat')
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.sources.modalities, 'catalog')
  assert.equal(record.contextWindow, 500000)
  assert.equal(record.sources.context, 'catalog')
  assert.equal(record.catalog.provider, 'xai')
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
    },
  )
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.sources.modalities, 'config')
  assert.equal(record.contextWindow, 1234)
  assert.equal(record.sources.context, 'config')
  assert.equal(record.defaultMaxTokens, 99)
})

test('mergeCapabilities lets a relay listing beat the built-in catalog', () => {
  const record = mergeCapabilities(
    { id: 'grok-4.7', name: 'grok-4.7' },
    {
      adapter: { id: 'grok-4.7', name: 'grok-4.7', inputModalities: ['text'] },
      profile: relayProfile(['grok-4.7']),
      discovered: { id: 'grok-4.7', inputModalities: ['text'], contextWindow: 131072, reasoning: false },
    },
  )
  assert.deepEqual(record.inputModalities, ['text'])
  assert.equal(record.sources.modalities, 'provider')
  assert.equal(record.contextWindow, 131072)
  assert.equal(record.reasoningSupported, false)
  assert.equal(record.sources.reasoning, 'provider')
})

test('mergeCapabilities labels image and video models and keeps no chat facts', () => {
  const image = mergeCapabilities(
    { id: 'gpt-image-2.5-flare-4k', name: 'gpt-image-2.5-flare-4k' },
    {
      adapter: { id: 'gpt-image-2.5-flare-4k', name: 'gpt-image-2.5-flare-4k', inputModalities: ['text'], contextWindow: 262144 },
      profile: relayProfile(['gpt-image-2.5-flare-4k']),
    },
  )
  assert.equal(image.kind, 'image')
  assert.equal(image.sources.kind, 'catalog')
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
