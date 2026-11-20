/**
 * Ledger append semantics on the default disk layout.
 *
 * `usage-ledger.test.mjs` covers the scanner, folding and cache contract with an
 * explicit `sessionsRoot`. This case is deliberately separate: it lets the
 * ledger derive the default `$DSH_HOME/sessions` root from `home` alone and
 * appends a checksummed frame after the first scan, which is the shape a live
 * session actually grows in. A regression here double-counted the replayed
 * prefix instead of folding only the new settlement.
 *
 * It used to be called `tmp-usage2.test.mjs` (a scratch name that was committed
 * and then picked up by the suite forever). The name now says what it tests.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import test from 'node:test'
import { createUsageLedger } from '../lib/usage-ledger.js'

/** One checksummed Zstandard frame, the way DSH appends a session record. */
const frame = (value) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), {
  params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
})

test('appending a checksummed settlement is picked up without replaying old usage twice', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-usage-append-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const time = new Date(2026, 10, 10, 12).getTime()
  const sessions = path.join(home, 'sessions', 'proj', 'session-a')
  fs.mkdirSync(sessions, { recursive: true })
  const log = path.join(sessions, 'session.v4.jsonl.zstd')
  const message = (step, input, output) => frame({
    type: 'assistant/message', seq: step, time, surfaceOp: 'append', data: {
      turn: 0, step, message: { role: 'assistant', source: { kind: 'model', provider: 'relay', model: 'gpt-x' } },
      usage: { inputTokens: input, outputTokens: output }, stream: [],
    },
  })
  fs.writeFileSync(log, Buffer.concat([
    frame({ type: 'session', version: 4, id: 'session-a', createdAt: time, isSeeded: false, delegationDepth: 0 }),
    message(0, 11, 4),
  ]))
  // No `sessionsRoot`: the ledger must resolve the default layout from `home`.
  const ledger = createUsageLedger({ home, now: () => time })
  await ledger.rescan()
  assert.deepEqual(ledger.read().ranges.month, [11, 4, 0, 0])
  fs.appendFileSync(log, message(1, 3, 1))
  await ledger.rescan()
  assert.deepEqual(ledger.read().ranges.month, [14, 5, 0, 0])
})
