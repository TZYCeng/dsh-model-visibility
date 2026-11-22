/** Bounded fallback reader for the DSH v4 JSONL and checksummed Zstd layouts. */
import { createReadStream } from 'node:fs'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

const decompress = promisify(zstdDecompress)
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const MAGIC = 0xfd2fb528
const MAX_FRAME = 64 * 1024 * 1024
const MAX_LINE = 32 * 1024 * 1024
const yieldLoop = () => new Promise(resolve => setImmediate(resolve))

/** Advance through the physical framing exactly once, even across 1-byte chunks. */
function frameReader() {
  const scratch = Buffer.alloc(4)
  let stage = 'magic', need = 4, filled = 0, size = 0, startByte = 0
  let last = false, checksum = false
  let parts = []
  const next = (name, n) => { stage = name; need = n; filled = 0 }
  const blockDone = () => last ? checksum ? next('checksum', 4) : next('end', 0) : next('block', 3)
  return {
    *feed(chunk) {
      let begin = 0, pos = 0
      while (pos < chunk.length) {
        const take = Math.min(need, chunk.length - pos)
        if (stage === 'magic' || stage === 'descriptor' || stage === 'block') chunk.copy(scratch, filled, pos, pos + take)
        pos += take; size += take; filled += take; need -= take
        if (size > MAX_FRAME) throw new Error('Zstandard frame exceeds the safe read limit')
        if (need) break
        switch (stage) {
          case 'magic':
            if (scratch.readUInt32LE() !== MAGIC) throw new Error(`invalid Zstandard frame at byte ${startByte}`)
            next('descriptor', 1); break
          case 'descriptor': {
            const d = scratch[0]
            if (d & 24) throw new Error(`invalid Zstandard frame header at byte ${startByte}`)
            const fcs = d >>> 6, single = (d & 32) !== 0, dict = d & 3
            checksum = (d & 4) !== 0
            const extra = (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs ? 1 << fcs : single ? 1 : 0)
            if (extra) next('extra', extra); else next('block', 3)
            break
          }
          case 'extra': next('block', 3); break
          case 'block': {
            const header = scratch.readUIntLE(0, 3), type = (header >>> 1) & 3
            if (type === 3) throw new Error(`invalid Zstandard block at byte ${startByte + size - 3}`)
            last = (header & 1) !== 0
            const payload = type === 1 ? 1 : header >>> 3
            if (payload) next('payload', payload); else blockDone()
            break
          }
          case 'payload': blockDone(); break
          case 'checksum': next('end', 0); break
        }
        if (stage === 'end') {
          parts.push(chunk.subarray(begin, pos))
          const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
          const offset = startByte
          startByte += size; parts = []; size = 0; begin = pos; next('magic', 4)
          yield { bytes, offset }
        }
      }
      if (begin < pos) parts.push(chunk.subarray(begin, pos))
    },
    torn: () => size !== 0,
  }
}

function lineReader(accept, signal) {
  let pieces = [], size = 0, count = 0
  return {
    async feed(bytes) {
      let pos = 0
      while (pos < bytes.length) {
        const lf = bytes.indexOf(10, pos)
        const piece = bytes.subarray(pos, lf === -1 ? bytes.length : lf)
        size += piece.length
        if (size > MAX_LINE) throw new Error('JSONL record exceeds the safe read limit')
        if (piece.length) pieces.push(piece)
        if (lf === -1) break
        let line
        try { line = UTF8.decode(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size)) }
        catch { throw new Error('invalid UTF-8 in JSONL log') }
        pieces = []; size = 0; pos = lf + 1
        if (!accept(line)) return false
        if (++count % 512 === 0) { await yieldLoop(); signal.throwIfAborted() }
      }
      return true
    },
    torn: () => size !== 0,
  }
}

/** Read/verify only one compressed frame or unfinished raw line at a time.
 * The decoder is asynchronous. Never feed unchecked decompressor output into
 * the accounting fold; a failed checksum cannot publish that frame's records.
 */
export async function streamDiskLog(file, accept, { signal, chunkBytes = 128 * 1024, trace }) {
  const lines = lineReader(accept, signal)
  const frames = file.endsWith('.zstd') ? frameReader() : null
  let chunks = 0, bytes = 0, decoded = 0
  try {
    for await (const chunk of createReadStream(file, { signal, highWaterMark: chunkBytes })) {
      signal.throwIfAborted(); chunks++; bytes += chunk.length
      if (!frames) { if (!await lines.feed(chunk)) return; continue }
      for (const frame of frames.feed(chunk)) {
        signal.throwIfAborted()
        let raw
        try { raw = await decompress(frame.bytes, { maxOutputLength: MAX_FRAME }) }
        catch { return `could not decode Zstandard frame at byte ${frame.offset}` }
        signal.throwIfAborted(); decoded++
        if (!await lines.feed(raw)) return
        if (lines.torn()) return `incomplete JSONL record in Zstandard frame at byte ${frame.offset}`
      }
    }
    if (frames?.torn()) return 'incomplete Zstandard tail'
    if (lines.torn()) return 'incomplete JSONL tail'
  } catch (error) {
    signal.throwIfAborted()
    // Stream errors can contain private absolute session paths. Only our own
    // parser diagnostics are suitable for the page and CSV.
    return /^(?:invalid Zstandard |invalid UTF-8 in JSONL|(?:JSONL record|Zstandard frame) exceeds)/.test(error?.message)
      ? error.message : 'could not read a session log from storage'
  } finally {
    if (!signal.aborted) trace?.('usage', 'disk.read', { count: chunks, total: decoded, bytes })
  }
}
