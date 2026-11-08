import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import test from 'node:test'
import { createUsageLedger, decodeLogLines } from '../lib/usage-ledger.js'

const frame = (l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
const messageEvent = ({ time, turn, step, input, output }) =>
  JSON.stringify({ type: 'assistant/message', seq: time, time, data: { turn, step, message: { role: 'assistant', source: { kind: 'model', provider: 'relay', model: 'gpt-x' } }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 } } })

test('debug scan two-stage', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-usage2-'))
  const sessions = path.join(home, 'sessions', 'proj', 'session-a')
  fs.mkdirSync(sessions, { recursive: true })
  const logPath = path.join(sessions, 'session.v4.jsonl.zstd')
  fs.writeFileSync(logPath, Buffer.concat([
    frame(`{"type":"session","id":"s","createdAt":${Date.now()}}`),
    frame(messageEvent({ time: Date.now(), turn: 0, step: 0, input: 11, output: 4 })),
  ]))
  const ledger = createUsageLedger({ home, file: path.join(home, 'usage-ledger.json'), sessionsRoot: path.join(home, 'sessions'), logger: { warn: (...a) => console.log('WARN', ...a) } })
  await ledger.rescan()
  console.log('first ok')
  fs.appendFileSync(logPath, frame(messageEvent({ time: Date.now(), turn: 0, step: 1, input: 3, output: 1 })))
  const s = fs.statSync(logPath)
  console.log('appended size', s.size, 'mtime', s.mtimeMs, 'lines now', decodeLogLines(fs.readFileSync(logPath), true).length)
  await ledger.rescan()
  const second = ledger.read()
  console.log('second month', JSON.stringify(second.ranges.month))
  assert.deepEqual(second.ranges.month, [14, 5, 0, 0])
})
