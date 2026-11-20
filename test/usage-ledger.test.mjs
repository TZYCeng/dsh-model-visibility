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
import { setTimeout as delay } from 'node:timers/promises'

import {
  createUsageLedger,
  dayKeyOf,
  decodeLogLines,
  foldLogToBuckets,
  monthKeyOf,
  weekStartKey,
} from '../lib/usage-ledger.js'

function tempDir(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-usage-'))
  t?.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function seedLog({ id, parentSession, time }, events) {
  const lines = [
    { type: 'session', version: 4, id, createdAt: time, isSeeded: parentSession !== undefined, parentSession, delegationDepth: 0 },
    ...events.map((event, seq) => ({ ...JSON.parse(event), seq })),
  ]
  return lines.map((line) => JSON.stringify(line))
}

function endSeed(time, data = {}) {
  return JSON.stringify({ type: 'session/end-seed', time, data })
}

function writeLog(home, id, lines, filename = 'session.v4.jsonl') {
  const dir = path.join(home, 'sessions', 'proj', id)
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, filename)
  fs.writeFileSync(log, filename.endsWith('.zstd') ? Buffer.concat(lines.map(frame)) : `${lines.join('\n')}\n`)
  return log
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

const attemptEvent = ({ time, turn, step, input, output, headerSeq }) =>
  JSON.stringify({
    type: 'assistant/attempt',
    seq: time,
    time,
    data: {
      turn,
      step,
      headerSeq,
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

test('message settlement prefers top-level usage, otherwise uses the last stream sample', () => {
  const time = new Date(2026, 11, 2, 12).getTime()
  const stream = JSON.parse(attemptEvent({ time, turn: 0, step: 0, input: 7, output: 8 })).data.stream
  stream.unshift({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 99, outputTokens: 99 } } })
  const streamOnly = JSON.parse(messageEvent({ time, turn: 0, step: 0, provider: 'relay', model: 'stream' }))
  streamOnly.data.stream = stream
  delete streamOnly.data.usage
  const direct = JSON.parse(messageEvent({ time, turn: 0, step: 1, input: 3, output: 4, model: 'direct' }))
  direct.data.stream = stream
  const { buckets } = foldLogToBuckets([JSON.stringify(streamOnly), JSON.stringify(direct)])
  assert.deepEqual(buckets[dayKeyOf(time)]['relay/stream'], [7, 8, 0, 0])
  assert.deepEqual(buckets[dayKeyOf(time)]['relay/direct'], [3, 4, 0, 0])
})

test('an attempt takes the exact header when referenced and otherwise uses the current request', () => {
  const time = new Date(2026, 11, 2, 12).getTime()
  const header = (seq, model) => JSON.stringify({ type: 'request/header', seq, time, data: { header: { config: { provider: 'r', model } }, reason: 'change' } })
  const context = (model) => JSON.stringify({ type: 'request/context', time, data: { provider: 'r', model } })
  const attempt = (step, input, headerSeq) => attemptEvent({ time, turn: 0, step, input, output: 1, headerSeq })
  const lines = [
    header(0, 'exact'), context('exact'), header(5, 'latest'), context('latest'),
    attempt(0, 1, 0), attempt(1, 2), attempt(2, 4, 999),
    '{"type":"developer/message","data":{"turn":0,"step":3,"headerSeq":0}}', attempt(3, 8),
    '{"type":"llm/retry-started","data":{"turn":0,"step":3}}', header(9, 'retry'), attempt(3, 16),
  ]
  const { buckets } = foldLogToBuckets(lines)
  assert.deepEqual(buckets[dayKeyOf(time)]['r/exact'], [9, 2, 0, 0])
  assert.deepEqual(buckets[dayKeyOf(time)]['r/latest'], [2, 1, 0, 0])
  assert.deepEqual(buckets[dayKeyOf(time)]['r/retry'], [16, 1, 0, 0])
  assert.deepEqual(buckets[dayKeyOf(time)].unknown, [4, 1, 0, 0])
})

test('month-end retention keeps exact event dates even for very old sessions', async (t) => {
  const home = tempDir(t)
  const date = (year, month, day) => new Date(year, month - 1, day, 12).getTime()
  let now = date(2026, 4, 30)
  const ledger = createUsageLedger({ home, now: () => now })
  const event = (time, step, input) => messageEvent({ time, turn: 0, step, input, output: 1 })
  writeLog(home, 'old', seedLog({ id: 'old', time: date(2022, 1, 1) }, [
    event(date(2025, 2, 27), 0, 1), event(date(2025, 2, 28), 1, 2),
    event(date(2025, 9, 3), 2, 4), event(date(2026, 4, 29), 3, 8), event(date(2026, 5, 1), 4, 16),
  ]))
  await ledger.rescan()
  const summary = ledger.read()
  assert.equal(summary.retainedFrom, '2025-02-28')
  assert.deepEqual(summary.ranges.total, [14, 3, 0, 0])
  assert.deepEqual(summary.ranges.month, [8, 1, 0, 0])
  assert.deepEqual(Object.keys(summary.days), ['2025-02-28', '2025-09-03', '2026-04-29'])
  assert.equal(summary.byModelRange, '2026-04-01 through 2026-04-30 (local dates, inclusive)')
  now = date(2026, 5, 1)
  assert.equal(ledger.read().retainedFrom, '2025-03-01')
  assert.deepEqual(ledger.read().ranges.total, [28, 3, 0, 0])
  await ledger.rescan()
  assert.equal(JSON.parse(fs.readFileSync(ledger.file, 'utf8')).files['proj/old'].buckets['2025-02-28'], undefined)
})

test('nested forks count only work after their last tagged seed marker', async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 10, 10, 12).getTime()
  const root = [
    attemptEvent({ time, turn: 0, step: 0, input: 10, output: 1 }),
    endSeed(time), // Untagged restore keeps the prior settlement.
    messageEvent({ time, turn: 0, step: 1, input: 20, output: 2, model: 'root' }),
  ]
  const child = [
    ...root,
    endSeed(time, { inherited: true }),
    messageEvent({ time, turn: 0, step: 1, input: 20, output: 2, model: 'child' }),
  ]
  const grandchild = [
    ...child,
    endSeed(time, { inherited: true }),
    messageEvent({ time, turn: 0, step: 1, input: 20, output: 2, model: 'grandchild' }),
    endSeed(time), // A later untagged marker must not move the fork cut.
    messageEvent({ time, turn: 0, step: 2, input: 4, output: 3, model: 'grandchild' }),
  ]
  writeLog(home, 'root', seedLog({ id: 'root', time }, root))
  writeLog(home, 'child', seedLog({ id: 'child', parentSession: 'root', time }, child))
  writeLog(home, 'grandchild', seedLog({ id: 'grandchild', parentSession: 'child', time }, grandchild))
  const ledger = createUsageLedger({ home, now: () => time })
  await ledger.rescan()
  const snapshot = ledger.read()
  assert.deepEqual(snapshot.ranges.total, [74, 10, 0, 0])
  assert.deepEqual(snapshot.byModel, {
    unknown: [10, 1, 0, 0],
    'relay/root': [20, 2, 0, 0],
    'relay/child': [20, 2, 0, 0],
    'relay/grandchild': [24, 5, 0, 0],
  })
})

for (const version of [1, 2]) test(`opening a v${version} cache invalidates unchanged file aggregates but keeps plugin usage`, async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 10, 10, 12).getTime()
  const today = dayKeyOf(time)
  const relPath = 'proj/child/session.v4.jsonl'
  const log = writeLog(home, 'child', seedLog({ id: 'child', parentSession: 'root', time }, [
    messageEvent({ time, turn: 0, step: 0, input: 30, output: 3 }),
    endSeed(time, { inherited: true }),
    messageEvent({ time, turn: 1, step: 0, input: 6, output: 2 }),
  ]))
  const stat = fs.statSync(log)
  const file = path.join(home, 'usage-ledger.json')
  const plugin = { [today]: { 'checker/test': [5, 4, 0, 0], '*': [5, 4, 0, 0] } }
  fs.writeFileSync(file, JSON.stringify({
    version,
    plugin,
    files: {
      [relPath]: { mtime: Math.trunc(stat.mtimeMs), size: stat.size, buckets: { [today]: { 'relay/gpt-x': [36, 5, 0, 0] } } },
      'gone/session.v4.jsonl': { buckets: { [today]: { 'relay/gone': [99, 99, 0, 0] } } },
    },
  }))

  const options = { home, file, now: () => time }
  const ledger = createUsageLedger(options)
  assert.deepEqual(ledger.read().ranges.total, [5, 4, 0, 0])
  await ledger.rescan()
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(cache.version, 3)
  assert.deepEqual(cache.plugin, plugin)
  assert.deepEqual(Object.keys(cache.files), ['proj/child'])
  assert.deepEqual(cache.files['proj/child'].buckets[today]['relay/gpt-x'], [6, 2, 0, 0])
  const reopened = createUsageLedger(options)
  assert.deepEqual(reopened.read().ranges.total, [11, 6, 0, 0])
})

test('the ledger scans incrementally and persists its cache', async (t) => {
  const home = tempDir(t)
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

test('a damaged log keeps its published usage and retries until repaired', async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 3, 30, 12).getTime()
  const options = { home, now: () => time, logger: { warn() {} } }
  const ledger = createUsageLedger(options)
  const lines = seedLog({ id: 'damaged', time }, [messageEvent({ time, turn: 0, step: 0, input: 2, output: 1 })])
  const log = writeLog(home, 'damaged', lines, 'session.v4.jsonl.zstd')
  const good = fs.readFileSync(log)
  await ledger.rescan()
  const cached = fs.readFileSync(ledger.file, 'utf8')
  fs.writeFileSync(log, Buffer.concat([good.subarray(0, frame(lines[0]).length), Buffer.from('damaged frame')]))
  await ledger.rescan({ force: true })
  assert.deepEqual(ledger.read().ranges.total, [2, 1, 0, 0])
  assert.match(ledger.read().error, /Usage scan incomplete.*invalid Zstandard frame/)
  assert.equal(fs.readFileSync(ledger.file, 'utf8'), cached)
  const restarted = createUsageLedger(options)
  await restarted.rescan()
  assert.deepEqual(restarted.read().ranges.total, [2, 1, 0, 0])
  assert.match(restarted.read().error, /Last good totals were kept/)
  const next = messageEvent({ time, turn: 0, step: 1, input: 4, output: 2 })
  fs.writeFileSync(log, Buffer.concat([good, frame(next)]))
  await restarted.rescan()
  assert.equal(restarted.read().error, undefined)
  assert.deepEqual(restarted.read().ranges.total, [6, 3, 0, 0])
})

for (const [encoding, damage, reason] of [
  ['jsonl', Buffer.from('not JSON\n'), /invalid JSONL at line 3/],
  ['jsonl', Buffer.from('{"type":"assistant/attempt"'), /incomplete JSONL tail/],
  ['jsonl.zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04]), /incomplete Zstandard tail/],
  ['jsonl.zstd', Buffer.from('bad frame after good prefix'), /invalid Zstandard frame/],
]) test(`a cold ${encoding} scan recovers a prefix without caching ${reason}`, async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 3, 30, 12).getTime()
  const ledger = createUsageLedger({ home, now: () => time, logger: { warn() {} } })
  const lines = seedLog({ id: 'partial', time }, [messageEvent({ time, turn: 0, step: 0, input: 2, output: 1 })])
  const log = writeLog(home, 'partial', lines, `session.v4.${encoding}`)
  const good = fs.readFileSync(log)
  fs.appendFileSync(log, damage)
  await ledger.ensureScanned()
  assert.deepEqual(ledger.read().ranges.total, [2, 1, 0, 0])
  assert.match(ledger.read().error, reason)
  assert.equal(fs.existsSync(ledger.file), false)
  fs.writeFileSync(log, good)
  await ledger.rescan()
  assert.equal(ledger.read().error, undefined)
  assert.deepEqual(ledger.read().ranges.total, [2, 1, 0, 0])
  assert.ok(fs.existsSync(ledger.file))
})

test('disk fallback admits only one supported generation in the official layout', async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 3, 30, 12).getTime()
  const ledger = createUsageLedger({ home, now: () => time, logger: { warn() {} } })
  const lines = (id) => seedLog({ id, time }, [messageEvent({ time, turn: 0, step: 0, input: 2, output: 1 })])
  writeLog(home, 'current', lines('current'), 'session.v3.jsonl')
  writeLog(home, 'current', lines('current'))
  writeLog(home, 'future', lines('future'))
  writeLog(home, 'future', lines('future'), 'session.v5.jsonl')
  writeLog(home, 'conflict', lines('conflict'))
  writeLog(home, 'conflict', lines('conflict'), 'session.v4.jsonl.zstd')
  await ledger.rescan()
  assert.deepEqual(ledger.read().ranges.total, [2, 1, 0, 0])
  assert.match(ledger.read().error, /2 storage issues/)
})

test('an optional persistence service supplies the supported root/format, and a cold read joins its scan', async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 3, 30, 12).getTime()
  writeLog(home, 'ignored', seedLog({ id: 'ignored', time }, [messageEvent({ time, turn: 0, step: 0, input: 64, output: 1 })]))
  const events = [
    { type: 'request/header', seq: 0, time, data: { header: { config: { provider: 'custom', model: 'backend' } } } },
    JSON.parse(messageEvent({ time, turn: 0, step: 0, input: 7, output: 1 })),
    JSON.parse(attemptEvent({ time, turn: 1, step: 0, input: 2, output: 1 })),
  ]
  let listCalls = 0
  let openCalls = 0
  let closed = 0
  let revision = 'rev1'
  let listingFails = false
  let readFails = false
  const gate = Promise.withResolvers()
  const ledger = createUsageLedger({ home, now: () => time, logger: { warn() {} }, sessionPersistence: {
    async list() {
      listCalls += 1
      await gate.promise
      if (listingFails) throw new Error('private backend path')
      return [{ header: { id: 'custom' }, revision, formatStatus: 'migration-required' }]
    },
    async open(id, access) {
      openCalls += 1
      assert.equal(id, 'custom')
      assert.equal(access, 'read')
      return { header: { createdAt: time }, inheritedEventCount: 2,
        async read() { if (readFails) throw new Error('private backend data'); return { events } },
        async close() { closed += 1 },
      }
    },
  } })
  const first = ledger.ensureScanned()
  assert.equal(first, ledger.ensureScanned())
  assert.equal(first, ledger.rescan())
  assert.deepEqual(ledger.read().ranges.total, [0, 0, 0, 0])
  assert.equal(ledger.read().computing, true)
  gate.resolve()
  await first
  assert.deepEqual(ledger.read().byModel, { 'custom/backend': [2, 1, 0, 0] })
  assert.equal(ledger.read().computing, false)
  await ledger.ensureScanned()
  assert.equal(listCalls, 1)
  await ledger.rescan()
  assert.equal(openCalls, 1)
  revision = 'rev2'
  readFails = true
  await ledger.rescan()
  assert.equal(openCalls, 2)
  assert.equal(closed, 2)
  assert.deepEqual(ledger.read().ranges.total, [2, 1, 0, 0])
  assert.match(ledger.read().error, /could not read a session log from storage/)
  assert.doesNotMatch(ledger.read().error, /private/)
  readFails = false
  await ledger.rescan()
  assert.equal(openCalls, 3)
  assert.equal(ledger.read().error, undefined)
  listingFails = true
  await ledger.rescan()
  assert.match(ledger.read().error, /Could not list stored sessions/)
  assert.deepEqual(ledger.read().ranges.total, [2, 1, 0, 0])
})

test('plugin-attributed usage lands in the same day buckets', async (t) => {
  const home = tempDir(t)
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
  await ledger.dispose()
})

test('plugin usage persists while open without a scan or read', async (t) => {
  const home = tempDir(t)
  const file = path.join(home, 'usage-ledger.json')
  const time = new Date(2026, 10, 10, 12).getTime()
  const options = { home, file, now: () => time }
  const ledger = createUsageLedger(options)
  const note = () => ledger.notePluginUsage({ provider: 'checker', model: 'test', usage: { inputTokens: 10, outputTokens: 2 } })
  note()
  note()
  const deadline = Date.now() + 2_000
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(20)
  assert.ok(fs.existsSync(file), 'a plugin settlement must persist without a UI scan')
  const reopened = createUsageLedger(options)
  assert.deepEqual(reopened.read().byModel['checker/test'], [20, 4, 0, 0])
  await ledger.dispose()
})

test('dispose flushes dirty plugin usage before reopen without writing the interrupted scan', async (t) => {
  const home = tempDir(t)
  const time = new Date(2026, 10, 10, 12).getTime()
  writeLog(home, 'root', seedLog({ id: 'root', time }, [
    messageEvent({ time, turn: 0, step: 0, input: 99, output: 99 }),
  ]))
  const file = path.join(home, 'usage-ledger.json')
  const options = { home, file, now: () => time }
  const ledger = createUsageLedger(options)
  const scan = ledger.rescan()
  ledger.notePluginUsage({ provider: 'checker', model: 'test', usage: { inputTokens: 7, outputTokens: 2 } })
  assert.equal(fs.existsSync(file), false) // Don't let the background flush fire first.
  const closing = ledger.dispose()
  const alsoClosing = ledger.dispose()
  ledger.notePluginUsage({ provider: 'checker', model: 'test', usage: { inputTokens: 20, outputTokens: 3 } })
  await alsoClosing
  const reopened = createUsageLedger(options)
  assert.deepEqual(reopened.read().ranges.total, [7, 2, 0, 0])
  assert.deepEqual(reopened.read().byModel['checker/test'], [7, 2, 0, 0])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).files, {})
  await closing
  await scan
})

test('dispose joins the scan and prevents later persistence', async (t) => {
  const home = tempDir(t)
  const sessions = path.join(home, 'sessions', 'proj', 'session-a')
  fs.mkdirSync(sessions, { recursive: true })
  fs.writeFileSync(
    path.join(sessions, 'session.v4.jsonl.zstd'),
    frame(messageEvent({ time: Date.now(), turn: 0, step: 0, input: 10, output: 5 })),
  )
  const file = path.join(home, 'dsh-model-visibility', 'usage-ledger.json')
  const ledger = createUsageLedger({ home, file, sessionsRoot: path.join(home, 'sessions') })
  const scan = ledger.rescan()
  await ledger.dispose()
  await scan
  assert.equal(ledger.isScanning(), false)
  assert.equal(fs.existsSync(file), false)
  ledger.notePluginUsage({ usage: { inputTokens: 10, outputTokens: 1 } })
  await ledger.rescan()
  assert.equal(fs.existsSync(file), false)
})

test('weekStartKey and monthKeyOf follow the local calendar', () => {
  // 2026-11-08 is a Sunday; the ISO week containing it starts Monday 2026-11-02.
  const stamp = new Date(2026, 10, 8).getTime()
  assert.equal(dayKeyOf(stamp), '2026-11-08')
  assert.equal(weekStartKey(stamp), '2026-11-02')
  assert.equal(monthKeyOf('2026-11-08'), '2026-11')
  assert.equal(monthKeyOf(''), undefined)
})
