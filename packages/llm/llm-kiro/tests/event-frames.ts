/**
 * Builders for AWS event-stream bytes and messages. Frames are laid out here
 * independently of the decoder under test; the checksums come from `node:zlib`,
 * and the known-answer frame in the decoder suite fixes the layout and CRCs
 * against bytes computed outside this repository.
 */

import { readFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import type { EventStreamMessage } from '../src/eventstream.ts'

const encoder = new TextEncoder()

/**
 * Join byte arrays.
 * @param parts - arrays in order.
 * @returns one array holding all of them.
 */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

/**
 * One string header (AWS type 7).
 * @param name - header name.
 * @param value - header value.
 * @returns its encoded bytes.
 */
export function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = encoder.encode(name)
  const valueBytes = encoder.encode(value)
  const header = new Uint8Array(1 + nameBytes.byteLength + 1 + 2 + valueBytes.byteLength)
  header[0] = nameBytes.byteLength
  header.set(nameBytes, 1)
  header[1 + nameBytes.byteLength] = 7
  new DataView(header.buffer).setUint16(2 + nameBytes.byteLength, valueBytes.byteLength)
  header.set(valueBytes, 4 + nameBytes.byteLength)
  return header
}

/**
 * Frame a raw header block and payload with valid prelude and message checksums.
 * @param headerBytes - already encoded headers; their length may disagree with the frame to test refusals.
 * @param payload - payload bytes.
 * @param headersLength - header length written in the prelude; defaults to the real one.
 * @returns the frame.
 */
export function frameOf(headerBytes: Uint8Array, payload: Uint8Array, headersLength = headerBytes.byteLength): Uint8Array {
  const total = 12 + headerBytes.byteLength + payload.byteLength + 4
  const frame = new Uint8Array(total)
  const view = new DataView(frame.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headersLength)
  view.setUint32(8, crc32(frame.subarray(0, 8)))
  frame.set(headerBytes, 12)
  frame.set(payload, 12 + headerBytes.byteLength)
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)))
  return frame
}

/**
 * Frame string headers and a payload.
 * @param headers - string-valued headers.
 * @param payload - payload bytes.
 * @returns the frame.
 */
export function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  return frameOf(concat(Object.entries(headers).map(([name, value]) => stringHeader(name, value))), payload)
}

/**
 * An event frame as Kiro sends it.
 * @param eventType - the `:event-type` header, such as `assistantResponseEvent`.
 * @param payload - JSON payload.
 * @returns the frame.
 */
export function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return encodeFrame(
    { ':message-type': 'event', ':event-type': eventType, ':content-type': 'application/json' },
    encoder.encode(JSON.stringify(payload)),
  )
}

/**
 * An exception frame as Kiro sends it.
 * @param exceptionType - the `:exception-type` header, such as `ThrottlingException`.
 * @param payload - JSON payload.
 * @returns the frame.
 */
export function exceptionFrame(exceptionType: string, payload: unknown): Uint8Array {
  return encodeFrame(
    { ':message-type': 'exception', ':exception-type': exceptionType, ':content-type': 'application/json' },
    encoder.encode(JSON.stringify(payload)),
  )
}

/**
 * Cut bytes into chunks of at most `size`.
 * @param bytes - the bytes.
 * @param size - chunk size.
 * @returns the chunks in order.
 */
export function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += size) chunks.push(bytes.slice(offset, offset + size))
  return chunks
}

/**
 * A response body that delivers chunks and then ends.
 * @param chunks - the network chunks.
 * @returns the byte stream.
 */
export function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/**
 * A 200 response whose body delivers frames in awkward chunks, splitting frames mid-prelude.
 * @param frames - frames in order.
 * @param chunkSize - network chunk size in bytes.
 * @returns the response.
 */
export function eventStreamResponse(frames: readonly Uint8Array[], chunkSize = 7): Response {
  return new Response(bodyOf(chunked(concat(frames), chunkSize)), {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}

/**
 * A decoded message without framing.
 * @param eventType - the `:event-type` header.
 * @param payload - JSON payload.
 * @returns the message.
 */
export function eventMessage(eventType: string, payload: unknown): EventStreamMessage {
  return {
    headers: { ':message-type': 'event', ':event-type': eventType },
    payload: encoder.encode(JSON.stringify(payload)),
  }
}

/**
 * Read a recorded reply: one hex frame per line, `#` lines are comments.
 * @param name - fixture file name under `tests/fixtures`.
 * @returns the frames in arrival order.
 */
export async function recordedFrames(name: string): Promise<Uint8Array[]> {
  const text = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  return text.split('\n').filter(line => line !== '' && !line.startsWith('#')).map(line => Uint8Array.from(Buffer.from(line, 'hex')))
}

/**
 * Drain an async iterable.
 * @param source - the iterable.
 * @returns every value in order.
 */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}
