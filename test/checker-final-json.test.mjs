import test from 'node:test'
import assert from 'node:assert/strict'
import { exactCheckerJson, parseCheckerAnswer } from '../lib/checker-answer.js'
import { batchPrompt, recoverCompleteCheckerRows, validateReplyShape } from '../lib/checker-contract.js'
import { callChecker } from '../lib/checker-call.js'
import { createCapabilityVerifier } from '../lib/check-catalog.js'

const url = 'https://vendor.example/spec'
const foreignUrl = 'https://unused.example/spec'
const online = { allowedUrls: new Set([url]) }
const shape = (value, ids, options) => validateReplyShape(exactCheckerJson(JSON.stringify(value)), ids, options)

test('exact final parsing accepts only a complete JSON value or one whole JSON fence', () => {
  const json = '[{"id":"a","input":["image"]}]'
  assert.deepEqual(exactCheckerJson(`\n\`\`\`json\r\n${json}\r\n\`\`\`\n`), JSON.parse(json))
  for (const bad of [
    `The answer is ${json}`, `${json}\nDone`, `<think>${json}</think>`, `\`\`\`js\n${json}\n\`\`\``,
    '[{"id":"b","\\u0069d":"a"}]', '{"a":{},"\\u0061":{"input":["image"]}}',
    '{"models":[],"models":[]}', '[] []', '"hello"', 'null', ' '.repeat(128_001) + json,
  ]) assert.equal(exactCheckerJson(bad), undefined)
  assert.deepEqual(recoverCompleteCheckerRows('[{"id":"b","id":"a"}, {"id":"'), [])
  assert.deepEqual(recoverCompleteCheckerRows(`${json}\nI am explaining my reasoning`), [])
})

test('sparse array, wrapper and exact-key forms project the same claims', () => {
  const id = 'Vendor/Qwen-vl:free'
  const fields = { inputModalities: ['text', 'vision'], context_window: 65_536, evidence: { input_modalities: url, context_window: [url] } }
  for (const parsed of [[{ id, ...fields }], { models: [{ model_id: id, ...fields }] }, { results: { [id]: fields } }, { [id]: fields }]) {
    const result = shape(parsed, [id], online)
    assert.equal(result.ok, true)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.validRows, [{
      id, kind: null, input: ['text', 'image'], output: null,
      contextWindow: 65_536, maxTokens: null, reasoning: null, reasoningEfforts: null, defaultEffort: null,
      evidence: [{ url, fields: ['input', 'contextWindow'] }],
    }])
  }
  assert.equal(shape({ models: { input: ['text'] } }, ['models']).validRows[0].id, 'models')
  assert.equal(shape(JSON.parse('{"__proto__":{"input":["text"]}}'), ['__proto__']).validRows[0].id, '__proto__')
  assert.equal(shape({ models: [{ id }], results: [{ id }] }, [id]).ok, false)
  assert.deepEqual(shape([{ id }, { id: 'extra' }], [id], online).validRows[0].evidence, [])
})

test('explicit refs are local, order-independent and not identity guesses', () => {
  const ids = ['Vendor/Å', 'Vendor/B']
  const [heading, data, instructions] = batchPrompt(ids).split('\n')
  assert.match(heading, /1-based numeric ref/)
  assert.deepEqual(JSON.parse(data), ids)
  assert.match(instructions, /1-based position/)
  assert.doesNotMatch(instructions, /Vendor/)
  assert.deepEqual(shape([{ ref: '2', input: ['text'] }, { ref: 1, modelId: ids[0] }], ids).validRows.map(row => row.id), [...ids].reverse())
  for (const bad of [0, '01', ' 1', '1.0', 3, null, true]) {
    assert.deepEqual(shape([{ ref: bad, input: ['text'] }], [ids[0]]).missing, [ids[0]])
  }
  assert.deepEqual(shape([{ input: ['text'] }, { id: 'Vendor/Å' }], [ids[0]]).validRows, [])
  assert.deepEqual(shape({ [ids[0].toLowerCase()]: { id: ids[0], input: ['text'] } }, [ids[0]]).validRows, [])
  const dup = shape([{ id: ids[0] }, { ref: '1' }, { ref: 2 }], ids)
  assert.deepEqual(dup.validRows.map(row => row.id), [ids[1]])
  assert.match(dup.reasons.join(), /duplicate id/)
  const conflict = shape({ [ids[0]]: { id: ids[1] }, [ids[1]]: { input: ['image'] } }, ids)
  assert.deepEqual(conflict.missing, ids)
  assert.match(conflict.reasons.join(), /conflicting or invalid identity/)
})

test('invalid individual fields, contradictory ladders and bad citations do not erase siblings', () => {
  const result = shape([{
    id: 'a', kind: 'chat', type: 'embedding', input: ['text', 'image'], output: ['text'], contextWindow: '65536',
    maxTokens: 4096, reasoning: false, reasoningEfforts: ['low', 'high'], defaultEffort: 'high',
    evidence: [
      null, url, { url: foreignUrl, fields: ['maxTokens'] },
      { url, fields: ['input', 'reasoning', 'reasoningEfforts', 'defaultEffort', 'bad-field'] },
      { url, fields: 'output' },
    ],
  }], ['a'], online)
  assert.equal(result.ok, true)
  assert.equal(result.retryable, false)
  const [row] = result.validRows
  assert.deepEqual(row.evidence, [{ url, fields: ['input', 'reasoning', 'output'] }])
  assert.deepEqual(row.input, ['text', 'image'])
  assert.deepEqual(row.output, ['text'])
  assert.equal(row.reasoning, false)
  for (const field of ['kind', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'defaultEffort']) assert.equal(row[field], null)
  assert.match(result.diagnostics.join(), /invalid contextWindow.*conflicting aliases for kind.*unlinked evidence.*without retrieved content.*uncited maxTokens.*conflicts with reasoning=false.*requires a retained ladder/)
  assert.doesNotMatch(result.diagnostics.join(), /65536|bad-field|unused\.example/)
})

test('an unlinked URL cannot support fields and a default cannot survive its missing ladder', () => {
  const result = shape([
    { ref: 1, input: ['image'], evidence: [url] },
    { ref: 2, reasoningEfforts: ['not-a-real-effort'], defaultEffort: 'high', evidence: { defaultEffort: url } },
    { ref: 3, reasoningEfforts: [{ id: 'low' }, 'high'], defaultEffort: 'high', evidence: { reasoning_efforts: url, default_effort: foreignUrl } },
    { ref: 4, reasoning: false, reasoningEfforts: ['high'], evidence: { reasoningEfforts: url } },
    { ref: 5 },
  ], ['a', 'b', 'c', 'd', 'e'], online)
  assert.deepEqual(result.missing, ['a', 'b'])
  assert.deepEqual(result.validRows.map(row => row.id), ['c', 'd', 'e'])
  const [c, d, unknown] = result.validRows
  assert.deepEqual(c.reasoningEfforts, ['low', 'high'])
  assert.equal(c.defaultEffort, null)
  assert.equal(d.reasoning, null, 'uncited sibling flag cannot erase a cited ladder')
  assert.deepEqual(unknown.evidence, [])
  assert.equal(unknown.input, null)
  assert.deepEqual(parseCheckerAnswer(result.validRows, ['c', 'd', 'e'], undefined, { validated: true })[0].fact.evidence, [{ url, fields: ['reasoningEfforts'] }])
})

test('diagnostics remain bounded despite many invalid rows and values', () => {
  const ids = Array.from({ length: 32 }, (_, n) => String(n))
  const reply = ids.map(id => ({ id, reasoning: 'RAW_PRIVATE_THOUGHT'.repeat(75), evidence: [foreignUrl] }))
  const result = shape(reply, ids, online)
  assert.deepEqual(result.missing, ids)
  assert.ok(result.diagnostics.length <= 9)
  assert.ok(result.reasons.length <= 9)
  assert.match(result.diagnostics.at(-1), /more issues/)
  assert.doesNotMatch(result.diagnostics.join(), /RAW_PRIVATE_THOUGHT|unused\.example/)
})

test('only text deltas are final candidates; reasoning and unexpected tool calls cannot become JSON', async () => {
  const call = stream => callChecker({ llm: { prepareCall: async config => ({ config, stream }) }, checker: { provider: 'r', model: 'm' }, system: '', input: 'a' })
  const plausible = '[{"id":"a","input":["image"]}]'
  const reply = await call(async function* () {
    yield { type: 'reasoning-delta', text: plausible }
    yield { type: 'block-end', block: { type: 'reasoning', text: plausible } }
    yield { type: 'text-delta', text: '[{"id":"a"}]' }
  })
  assert.equal(reply.text, '[{"id":"a"}]')
  await assert.rejects(call(async function* () {
    yield { type: 'text-delta', text: plausible }
    yield { type: 'tool-call-delta', index: 0, name: 'search_model_docs', argumentsDelta: '{}' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }), error => error.code === 'CHECKER_UNEXPECTED_TOOL' && !Object.hasOwn(error, 'partialText'))
})

for (const webSearch of [false, true]) {
  test(`${webSearch ? 'online' : 'offline'} verifier never extracts JSON from prose or reasoning`, async () => {
    let finals = 0
    let lookups = 0
    const id = 'Vendor/Model'
    const valid = JSON.stringify([{ id, input: ['image'], evidence: { input: url } }])
    const written = []
    const verifier = createCapabilityVerifier({
      llm: {
        listProviders: () => [{ id: 'r' }], listModels: async () => [{ id }],
        prepareCall: async config => ({ config, async *stream(request) {
          if (request.tools.length) {
            if (lookups++ === 0) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 's1', name: 'search_model_docs', arguments: '{"query":"Vendor Model specs"}' } }
            else yield { type: 'text-delta', text: valid }
            return
          }
          finals += 1
          yield { type: 'reasoning-delta', text: valid }
          yield { type: 'block-end', block: { type: 'reasoning', text: valid } }
          yield { type: 'text-delta', text: `Explanation: ${valid}` }
        } }),
      },
      web: { async search() { return { sources: [{ url, snippet: 'Model accepts images' }] } } },
      fetch: async () => Response.json({}), logger: { warn() {} },
      learned: { meta: () => ({}), upsertEntries(entries) { written.push(...entries) } },
    })
    const state = await verifier.start({ checker: { provider: 'r', model: 'checker' }, webSearch })
    assert.ok(finals >= 1)
    assert.equal(lookups, webSearch ? 2 : 0)
    assert.deepEqual([state.done, state.unknown, state.failed], [0, 0, 1])
    assert.match(state.errors.join(), /no JSON/)
    assert.doesNotMatch(state.errors.join(), /Explanation:/)
    assert.deepEqual(written, [])
  })
}
