import assert from 'node:assert/strict'
import test from 'node:test'

import * as publicCatalog from '../lib/public-catalog.js'
import * as checkCatalog from '../lib/check-catalog.js'

const publicExports = [
  'PUBLIC_SOURCES',
  'HUGGING_FACE_HOSTS',
  'PUBLIC_BODY_LIMIT',
  'huggingFaceUrl',
  'readModelsDevRecord',
  'readModelsDev',
  'readOpenRouter',
  'kindOfPipelineTag',
  'readHuggingFace',
  'mergePublicSources',
  'publicFactToCapability',
  'lookupPublicFact',
  'publicOnlyFacts',
]

test('the standalone public catalog keeps every legacy export compatible', () => {
  assert.deepEqual(Object.keys(publicCatalog).sort(), [...publicExports].sort())
  for (const name of publicExports) {
    assert.strictEqual(checkCatalog[name], publicCatalog[name], `${name} must be a re-export`)
  }
})

test('standalone public parsers merge and match relay aliases without changing source facts', () => {
  const modelsDev = publicCatalog.readModelsDev({
    'vendor/model-a': {
      id: 'vendor/model-a',
      modalities: { input: ['text', 'image'] },
      limit: { context: 128000 },
      reasoning: false,
    },
  })
  const openRouter = publicCatalog.readOpenRouter({
    data: [{ id: 'model-a', context_length: 99999, top_provider: { max_completion_tokens: 8192 } }],
  })
  const huggingFace = publicCatalog.readHuggingFace([
    { id: 'vendor/model-a', pipeline_tag: 'text-generation', tags: ['reasoning'] },
    { id: 'vendor/model-b', pipeline_tag: 'text-to-image' },
  ])
  const original = structuredClone(modelsDev.get('model-a'))
  const merged = publicCatalog.mergePublicSources(modelsDev, openRouter, huggingFace)
  const fact = publicCatalog.lookupPublicFact(merged, '~relay/model-a:free:batch')

  assert.deepEqual(publicCatalog.publicFactToCapability(fact), {
    type: 'chat',
    input: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
  })
  assert.deepEqual(modelsDev.get('model-a'), original)
  assert.deepEqual(
    publicCatalog.publicOnlyFacts(['model-a', 'relay/model-b:free', 'unknown'], ['MODEL-A'], merged),
    [{ id: 'relay/model-b:free', fact: { id: 'relay/model-b:free', type: 'image' }, origins: ['public'] }],
  )
})
