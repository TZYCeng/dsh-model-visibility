import assert from 'node:assert/strict'
import test from 'node:test'

import {
  exactModelIdentity, modelIdNamespace, modelIdVariants,
  publicModelSearchKeys, publicModelSearchKeyTiers, publicModelSearchVendor,
} from '../lib/model-id.js'

const keys = publicModelSearchKeys
const tiers = publicModelSearchKeyTiers

test('public search orders literal leaves, normalized spelling, then terminal modifier removal', () => {
  assert.deepEqual(tiers('Qwen/QWEN4-MAX:free'), {
    strict: 'qwen4-max:free', spelling: 'qwen4-max-free', stripped: ['qwen4-max'],
  })
  assert.deepEqual(keys('Qwen/QWEN4-MAX:free'), ['qwen4-max:free', 'qwen4-max-free', 'qwen4-max'])
  assert.deepEqual(keys('Qwen/Qwen4-max-preview-27b-fast'), [
    'qwen4-max-preview-27b-fast', 'qwen4-max-preview-27b', 'qwen4-max-preview', 'qwen4-max',
  ])
  assert.deepEqual(keys('Qwen/Qwen4-max'), ['qwen4-max'])
})

test('public spelling folds width, Latin case, whitespace and separator punctuation', () => {
  for (const value of [
    'Ｑｗｅｎ／ＱＷＥＮ４＿Ｍａｘ　（Ｐｒｅｖｉｅｗ）',
    'Qwen 4–MAX：Preview', 'qwen4.max.preview', ' QWEN_4_MAX-preview ',
  ]) assert.equal(tiers(value).spelling, 'qwen4-max-preview', value)
  assert.equal(tiers('Gemini3.5 Flash').spelling, 'gemini-3.5-flash')
  assert.equal(tiers('Qwen . 3 . 6 Max').spelling, 'qwen3.6-max')
  assert.equal(tiers('Qwen.4-max').spelling, 'qwen4-max')
  assert.ok(!keys('Qwen.4-max').includes('4-max'), 'a dotted generation is not a namespace')
  assert.equal(tiers('DeepSeek.v3.2').spelling, 'deepseek-v3.2')
  assert.equal(tiers('custom#foo+opaque').spelling, 'custom#foo+opaque')
  assert.equal(tiers('custom@foo=v1').spelling, 'custom@foo=v1')
})

test('localized public model brands use contextual numeral and edition aliases', () => {
  assert.deepEqual(keys('千问4 max .preview'), ['千问4 max .preview', 'qwen4-max-preview', 'qwen4-max'])
  assert.deepEqual(keys('千问四max'), ['千问四max', 'qwen4-max'])
  assert.equal(tiers('通义千问四').spelling, 'qwen4')
  assert.equal(tiers('通义　千問四').spelling, 'qwen4')
  assert.equal(tiers('通義千問／通義千問四 Max 預覽版').spelling, 'qwen4-max-preview')
  assert.equal(tiers('千问三点六-27 b').spelling, 'qwen3.6-27b')
  assert.equal(tiers('千问四点零二 Max').spelling, 'qwen4.02-max')
  assert.equal(tiers('千问十二Max').spelling, 'qwen12-max')
  assert.equal(tiers('智谱五点三').spelling, 'glm-5.3')
  assert.equal(tiers('深度求索Ｖ３．２').spelling, 'deepseek-v3.2')
  assert.equal(tiers('豆包二点零').spelling, 'doubao-2.0')
  assert.equal(tiers('千问用户手册').spelling, '千问用户手册')
  assert.equal(tiers('模型四').spelling, '模型四')
})

test('public terminal modifiers include units, dimensions, and recognizable release dates', () => {
  for (const [query, spelling, stripped] of [
    ['Qwen3.6 27 b', 'qwen3.6-27b', ['qwen3.6']],
    ['Qwen3.6-0.5 B', 'qwen3.6-0.5b', ['qwen3.6']],
    ['Qwen3.6-35B-A3B', 'qwen3.6-35b-a3b', ['qwen3.6']],
    ['image-2（４ K）', 'image-2-4k', ['image-2']],
    ['image-2-1024 × 1536', 'image-2-1024x1536', ['image-2']],
    ['image-2-fhd', 'image-2-fhd', ['image-2']],
    ['image-2-1080p-preview', 'image-2-1080p-preview', ['image-2-1080p', 'image-2']],
    ['qwen4-max-v20260418', 'qwen4-max-v20260418', ['qwen4-max']],
    ['gpt-4o-2024-08-06', 'gpt-4o-2024-08-06', ['gpt-4o']],
    ['gpt-4o-2024.08.06', 'gpt-4o-2024.08.06', ['gpt-4o']],
    ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-05-06', ['gemini-2.5-pro-preview', 'gemini-2.5-pro']],
  ]) {
    assert.equal(tiers(query).spelling, spelling, query)
    assert.deepEqual(tiers(query).stripped, stripped, query)
  }
})

test('broad keys preserve base generations, nonterminal variants, and opaque identifiers', () => {
  const disjoint = (a, b) => assert.equal(keys(a).some(key => keys(b).includes(key)), false, `${a} vs ${b}`)
  disjoint('qwen4-max-preview-27b', 'qwen3.6-max')
  disjoint('qwen3.6-27b', 'qwen36-27b')
  disjoint('qwen3.6-27b', 'qwen3-6-27b')
  disjoint('other/model-5.1', 'other/model-5-1')
  disjoint('qwen4-max-preview', 'qwen4-plus-preview')
  disjoint('model-2024-02-30', 'model')
  disjoint('model-05-06', 'model')
  disjoint('model-v2', 'model')
  disjoint('model-preview-thinking', 'model-thinking')
  disjoint('model-preview:batch', 'model')
  for (const value of ['preview', '.preview', '27 b', 'preview-27b-fast', '2026-04-18', '27b-preview', 'qwen-preview', '…', '---']) {
    assert.deepEqual(tiers(value).stripped, [], value)
    assert.ok(keys(value).length > 0 && keys(value).every(Boolean), value)
  }
  for (const value of [null, {}, '', '  ', 'namespace/']) assert.deepEqual(keys(value), [])
})

test('public vendor scope canonicalizes known names but does not borrow a namespace from the leaf', () => {
  assert.equal(publicModelSearchVendor('千问四max'), 'qwen')
  assert.equal(publicModelSearchVendor('Qwen/Qwen4-Max'), 'qwen')
  assert.equal(publicModelSearchVendor('GLOBAL.QWEN.Qwen4-Max'), 'qwen')
  assert.equal(publicModelSearchVendor('Ａｌｉｂａｂａ／Ｑｗｅｎ４－Ｍａｘ'), 'qwen')
  assert.equal(publicModelSearchVendor('智譜/GLM-5.3'), 'zai')
  assert.equal(publicModelSearchVendor('z-ai/GLM-5.3'), 'zai')
  assert.equal(publicModelSearchVendor('x-ai/grok-4'), 'xai')
  assert.equal(publicModelSearchVendor('other/qwen4-max'), 'other')
  assert.equal(publicModelSearchVendor('relay/qwen/qwen4-max'), 'relay/qwen')
  assert.deepEqual(keys('other/qwen4-max'), keys('qwen/qwen4-max'), 'the caller must scope leaf matches')
  assert.equal(publicModelSearchVendor('qwengine-preview'), '')
  assert.equal(publicModelSearchVendor('opaque-checkpoint'), '')
})

test('strict model identity and route-side variants do not adopt public key rules', () => {
  assert.equal(exactModelIdentity(' Qwen/Qwen4-Max-Preview:FREE '), 'Qwen/Qwen4-Max-Preview:FREE')
  assert.deepEqual(modelIdVariants('Qwen/Qwen4-Max-Preview:FREE'), ['qwen4-max-preview'])
  assert.deepEqual(modelIdVariants('Qwen/Qwen3.6-27B'), ['qwen3.6-27b'])
  assert.deepEqual(modelIdVariants('千问4 max .preview'), ['千问4 max .preview'])
  assert.deepEqual(modelIdVariants('Ｑｗｅｎ／ＱＷＥＮ４＿ＭＡＸ'), ['ｑｗｅｎ／ｑｗｅｎ４＿ｍａｘ'])
  assert.equal(modelIdNamespace('z-ai/GLM-5.3'), 'z-ai')
})
