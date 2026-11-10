/**
 * Decoder for the `application/vnd.amazon.eventstream` framing of Kiro responses.
 * Adapted from omp-kiro-provider (MIT, see ../LICENSE).
 *
 * Frame layout, all integers big-endian: total length u32, headers length u32,
 * prelude CRC32 u32, headers, payload, message CRC32 u32. Both checksums are
 * IEEE CRC32. A frame that fails a check is refused as `MALFORMED_RESPONSE`:
 * the byte stream has lost sync and nothing after it can be trusted.
 * @module @deepseek-ai/dsh-llm-kiro/eventstream
 */

import { crc32 } from 'node:zlib'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** One decoded header value; AWS header types 0-9 map onto these. */
export type EventStreamHeaderValue = string | number | bigint | boolean | Uint8Array

/** One checksum-verified message. */
export interface EventStreamMessage {
  /** Headers by name, such as `:message-type` and `:event-type`. */
  readonly headers: Readonly<Record<string, EventStreamHeaderValue>>
  /** Undecoded payload bytes. */
  readonly payload: Uint8Array
}

const PRELUDE_BYTES = 12
const CRC_BYTES = 4
const MIN_FRAME_BYTES = PRELUDE_BYTES + CRC_BYTES
/** The frame size limit AWS documents; a larger claimed length is corruption. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

const textDecoder = new TextDecoder()

function malformed(detail: string): never {
  throw new LlmError(`Kiro event stream ${detail}`, 'MALFORMED_RESPONSE')
}

function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headers: Record<string, EventStreamHeaderValue> = {}
  let offset = 0
  /** Reserve `count` bytes and return where they start. */
  const take = (count: number): number => {
    if (offset + count > bytes.byteLength) malformed('header is truncated')
    const start = offset
    offset += count
    return start
  }
  while (offset < bytes.byteLength) {
    const nameLength = view.getUint8(take(1))
    const nameStart = take(nameLength)
    const name = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const type = view.getUint8(take(1))
    switch (type) {
      case 0: headers[name] = true; break
      case 1: headers[name] = false; break
      case 2: headers[name] = view.getInt8(take(1)); break
      case 3: headers[name] = view.getInt16(take(2)); break
      case 4: headers[name] = view.getInt32(take(4)); break
      // 5 is a long and 8 a millisecond timestamp; both are 64-bit integers.
      case 5:
      case 8: headers[name] = view.getBigInt64(take(8)); break
      case 6:
      case 7: {
        const length = view.getUint16(take(2))
        const start = take(length)
        const value = bytes.subarray(start, start + length)
        headers[name] = type === 7 ? textDecoder.decode(value) : value.slice()
        break
      }
      case 9: {
        const start = take(16)
        headers[name] = bytes.slice(start, start + 16)
        break
      }
      default: malformed(`header type ${type} is unknown`)
    }
  }
  return headers
}

/** Decode one complete frame whose prelude checksum and length were already verified. */
function decodeFrame(frame: Uint8Array): EventStreamMessage {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const totalLength = frame.byteLength
  if (view.getUint32(totalLength - CRC_BYTES) !== crc32(frame.subarray(0, totalLength - CRC_BYTES))) {
    malformed('message CRC mismatch')
  }
  const headersEnd = PRELUDE_BYTES + view.getUint32(4)
  if (headersEnd > totalLength - CRC_BYTES) malformed('headers overrun the frame')
  return {
    headers: decodeHeaders(frame.subarray(PRELUDE_BYTES, headersEnd)),
    payload: frame.slice(headersEnd, totalLength - CRC_BYTES),
  }
}

/**
 * Accumulates arbitrary network chunks and yields every complete frame. A
 * chunk may split a frame anywhere, including inside the prelude.
 */
export class EventStreamDecoder {
  #pending: Uint8Array = new Uint8Array(0)

  /**
   * Add network bytes.
   * @param chunk - the next bytes of the response body.
   * @returns every frame the accumulated bytes now complete, in order.
   * @throws {LlmError} `MALFORMED_RESPONSE` when a prelude or message checksum fails or a length is outside the AWS limits.
   */
  push(chunk: Uint8Array): EventStreamMessage[] {
    let bytes = chunk
    if (this.#pending.byteLength > 0) {
      bytes = new Uint8Array(this.#pending.byteLength + chunk.byteLength)
      bytes.set(this.#pending)
      bytes.set(chunk, this.#pending.byteLength)
    }
    const messages: EventStreamMessage[] = []
    let offset = 0
    while (bytes.byteLength - offset >= PRELUDE_BYTES) {
      const prelude = new DataView(bytes.buffer, bytes.byteOffset + offset, PRELUDE_BYTES)
      // Verifying the prelude before waiting on its length keeps a corrupt length from stalling the stream.
      if (prelude.getUint32(8) !== crc32(bytes.subarray(offset, offset + 8))) malformed('prelude CRC mismatch')
      const totalLength = prelude.getUint32(0)
      if (totalLength < MIN_FRAME_BYTES || totalLength > MAX_FRAME_BYTES) malformed(`frame length ${totalLength} is invalid`)
      if (bytes.byteLength - offset < totalLength) break
      messages.push(decodeFrame(bytes.subarray(offset, offset + totalLength)))
      offset += totalLength
    }
    this.#pending = bytes.slice(offset)
    return messages
  }

  /** Bytes held back for an incomplete frame; non-zero after the stream ends means truncation. */
  get pendingBytes(): number {
    return this.#pending.byteLength
  }
}

/** Cancelling a body that already failed rejects with that failure, which the read has already reported. */
function ignoreCancelFailure(): void {}

/**
 * Decode a response body into checksum-verified messages.
 * @param body - the response byte stream; this function owns it and always cancels it on exit.
 * @param signal - cancellation; a pending read settles promptly even when the transport ignores the signal.
 * @param activity - called for every network chunk, including chunks that complete no frame.
 * @returns the messages in order.
 * @throws {LlmError} `MALFORMED_RESPONSE` for a corrupt frame and `STREAM_CLOSED` when the body ends inside a frame;
 *   the abort reason when `signal` aborts.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  activity: () => void,
): AsyncGenerator<EventStreamMessage> {
  const decoder = new EventStreamDecoder()
  const reader = body.getReader()
  // Cancelling the reader settles a read the transport left pending after the abort.
  const cancelOnAbort = (): void => { void reader.cancel(signal.reason).catch(ignoreCancelFailure) }
  signal.addEventListener('abort', cancelOnAbort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      activity()
      yield* decoder.push(value)
    }
    if (decoder.pendingBytes > 0) throw new LlmError('Kiro event stream ended inside a frame', 'STREAM_CLOSED')
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    // Stops server-side generation nobody reads; resolves at once for a closed body.
    void reader.cancel().catch(ignoreCancelFailure)
  }
}
