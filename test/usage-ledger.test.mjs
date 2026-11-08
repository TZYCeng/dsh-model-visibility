/**
 * Token-usage ledger: frame decoding, the projection-preserving fold, day and
 * model attribution, and the incremental scan contract.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import test from 'node:test'

import {
  createUsageLedger,
  dayKeyOf,
  decodeLogLines,
  foldLogToBuckets,
  monthKeyOf,
  weekStartKey,
} from '../lib/usage-ledger.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-usage-'))
}

function frame(line) {
  return zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
}

function messageEvent({ time, turn, step, input, output, cacheRead = 0, provider = 'relay', model = 'gpt-x', cacheWrite = 0 }) {
  return JSON.stringify({
    type: 'assistant/message',
    seq: time,
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    },
  })
}

const attemptEvent = ({ time, turn, step, input, output, provider = 'relay', model = 'gpt-x' }) =>
  JSON.stringify({
    type: 'assistant/attempt',
    seq: time,
    time,
    data: {
      turn,
      step,
      stream: [
        { type: 'chunk', time, chunk: { type: 'text-delta', text: 'hi' } },
        { type: 'chunk', time, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output } } },
      ],
    },
  })

test('the frame scanner round-trips concatenated checksummed frames', () => {
  const container = Buffer.concat([
    frame('{"type":"session"}'),
    frame(messageEvent({ time: 1, turn: 0, step: 0, input: 5, output: 6 })),
  ])
  const lines = decodeLogLines(container, true)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).type, 'session')
  assert.equal(JSON.parse(lines[1]).data.usage.outputTokens, 6)
})

test('decodeLogLines tolerates a torn final frame', () => {
  const container = Buffer.concat([
    frame('{"type":"session"}'),
    frame(messageEvent({ time: 1, turn: 0, step: 0, input: 5, output: 6 })),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04]),
  ])
  const lines = decodeLogLines(container, true)
  assert.equal(lines.length, 2)
})

test('foldLogToBuckets attributes days and routes exactly', () => {
  const day = (time) => time
  const lines = [
    `{"type":"session","id":"s","createdAt":${day(0)}}`,
    messageEvent({ time: day(1), turn: 0, step: 0, input: 10, output: 5, provider: 'relay', model: 'a' }),
    messageEvent({ time: day(2), turn: 0, step: 1, input: 20, output: 6, cacheRead: 3, provider: 'other', model: 'b' }),
  ]
  const folded = foldLogToBuckets(lines, { preciseFrom: dayKeyOf(day(0)) })
  const days = folded.buckets
  const first = days[dayKeyOf(day(1))]
  assert.deepEqual(first['relay/a'], [10, 5, 0, 0])
  const second = days[dayKeyOf(day(2))]
  assert.deepEqual(second['other/b'], [20, 6, 3, 0])
  assert.equal(second['other/b'].length, 4)
})

test('a revised settlement replaces its previous day and route buckets', () => {
  const lines = [
    messageEvent({ time: 500, turn: 0, step: 2, input: 100, output: 10, provider: 'relay', model: 'a' }),
    // Same (turn, step), different bucket: replacement that must subtract the sample.
    messageEvent({ time: 700, turn: 0, step: 2, input: 120, output: 10, provider: 'relay', model: 'a' }),
  ]
  const folded = foldLogToBuckets(lines, {})
  const anyDayKey = Object.keys(folded.buckets)[0]
  const byModel = folded.buckets[anyDayKey]
  // Exclude the `*` convenience row: it mirrors the same totals.
  let sum = [0, 0, 0, 0]
  for (const [route, values] of Object.entries(byModel)) {
    if (route === '*') continue
    for (let i = 0; i < 4; i += 1) sum[i] += values[i]
  }
  assert.deepEqual(sum, [120, 10, 0, 0])
})

test('a retry makes the following sample count on top of the old one', () => {
  const lines = [
    messageEvent({ time: 5, turn: 3, step: 1, input: 10, output: 10 }),
    `{"type":"llm/retry-started","data":{"turn":3,"step":1}}`,
    messageEvent({ time: 9, turn: 3, step: 1, input: 12, output: 11 }),
  ]
  const folded = foldLogToBuckets(lines, {})
  const anyDay = Object.values(folded.buckets)[0]
  assert.deepEqual(anyDay['*'], [22, 21, 0, 0])
})

test('the same settlement logged twice does not double count', () => {
  const lines = [
    messageEvent({ time: 5, turn: 1, step: 1, input: 50, output: 5 }),
    messageEvent({ time: 6, turn: 1, step: 1, input: 50, output: 5 }),
  ]
  const folded = foldLogToBuckets(lines, {})
  assert.deepEqual(Object.values(folded.buckets)[0]['*'], [50, 5, 0, 0])
})

test('attempt streams contribute their last usage chunk', () => {
  const lines = [attemptEvent({ time: 4, turn: 0, step: 0, input: 7, output: 8 })]
  const folded = foldLogToBuckets(lines, {})
  assert.deepEqual(Object.values(folded.buckets)[0]['*'], [7, 8, 0, 0])
})

test('older months are attributed to the session creation day, newer months exactly', () => {
  const oldTime = 1_000_000 // far in the past
  const lines = [
    `{"type":"session","id":"s","createdAt":${oldTime + 1}}`,
    messageEvent({ time: oldTime, turn: 0, step: 0, input: 30, output: 3 }),
  ]
  const folded = foldLogToBuckets(lines, { preciseFrom: dayKeyOf(Date.now()) })
  assert.deepEqual(Object.values(folded.buckets)[0]['*'], [30, 3, 0, 0])
})

test('the ledger scans incrementally and persists its cache', async () => {
  const home = tempDir()
  const sessions = path.join(home, 'sessions', 'proj', 'session-a')
  fs.mkdirSync(sessions, { recursive: true })
  fs.writeFileSync(
    path.join(sessions, 'session.v4.jsonl.zstd'),
    Buffer.concat([
      frame(`{"type":"session","id":"s","createdAt":${Date.now()}}`),
      frame(messageEvent({ time: Date.now(), turn: 0, step: 0, input: 11, output: 4 })),
    ]),
  )
  const file = path.join(home, 'dsh-model-visibility', 'usage-ledger.json')
  const ledger = createUsageLedger({ home, file, sessionsRoot: path.join(home, 'sessions') })
  await ledger.rescan()
  const first = ledger.read()
  assert.deepEqual(first.ranges.month, [11, 4, 0, 0])
  assert.ok(fs.existsSync(file))
  assert.equal(ledger.read().computing, false)

  // An unchanged scan touches nothing; new content is picked up by (mtime, size).
  fs.appendFileSync(
    path.join(sessions, 'session.v4.jsonl.zstd'),
    frame(messageEvent({ time: Date.now(), turn: 0, step: 1, input: 3, output: 1 })),
  )
  await ledger.rescan()
  const second = ledger.read()
  assert.deepEqual(second.ranges.month, [14, 5, 0, 0])
})

test('plugin-attributed usage lands in the same day buckets', () => {
  const home = tempDir()
  const file = path.join(home, 'usage-ledger.json')
  const ledger = createUsageLedger({ home, file, sessionsRoot: path.join(home, 'sessions'), now: () => 1_800_000_000_000 })
  ledger.notePluginUsage({
    timer: undefined,
    time: 1_800_000_000_000,
    provider: 'checker',
    model: 'gpt-6',
    usage: { inputTokens: 1000, outputTokens: 200 },
  })
  const snap = ledger.read({ now: () => 1_800_000_000_000 })
  assert.deepEqual(snap.ranges.month, [1000, 200, 0, 0])
  assert.equal(snap.byModel['checker/gpt-6'][0], 1000)
})

test('weekStartKey and monthKeyOf follow the local calendar', () => {
  // 2026-11-08 is a Sunday; the ISO week containing it starts Monday 2026-11-02.
  const stamp = new Date(2026, 10, 8).getTime()
  assert.equal(dayKeyOf(stamp), '2026-11-08')
  assert.equal(weekStartKey(stamp), '2026-11-02')
  assert.equal(monthKeyOf('2026-11-08'), '2026-11')
  assert.equal(monthKeyOf(''), undefined)
})
