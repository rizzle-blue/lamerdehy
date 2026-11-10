/** Frame decoding, checksum refusal, and cancellable body reading of the AWS event-stream transport. */

import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { EventStreamDecoder, readEventStream } from '../src/eventstream.ts'
import type { EventStreamMessage } from '../src/eventstream.ts'
import { bodyOf, chunked, collect, concat, eventFrame, frameOf, stringHeader } from './event-frames.ts'

const decoder = new TextDecoder()
const payloadText = (message: EventStreamMessage): string => decoder.decode(message.payload)

/** One `assistantResponseEvent` frame computed with Python's struct and zlib, outside this repository. */
const GOLDEN_FRAME = Uint8Array.from(Buffer.from([
  '0000007f0000005c7c7db5a80d3a6d6573736167652d747970650700056576656e74',
  '0b3a6576656e742d74797065070016617373697374616e74526573706f6e73654576',
  '656e740d3a636f6e74656e742d747970650700106170706c69636174696f6e2f6a73',
  '6f6e7b22636f6e74656e74223a2248656c6c6f227d2544327c',
].join(''), 'hex'))

function valueBytes(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

/** A header of any AWS type: name length, name, type tag, then the encoded value. */
function header(name: string, type: number, value: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  return concat([Uint8Array.of(nameBytes.byteLength), nameBytes, Uint8Array.of(type), value])
}

/** A prelude with a valid checksum claiming the given lengths. */
function prelude(total: number, headersLength: number): Uint8Array {
  const bytes = valueBytes(12, (view) => {
    view.setUint32(0, total)
    view.setUint32(4, headersLength)
  })
  new DataView(bytes.buffer).setUint32(8, crc32(bytes.subarray(0, 8)))
  return bytes
}



describe('EventStreamDecoder', () => {
  it('decodes a frame computed outside this repository', () => {
    const messages = new EventStreamDecoder().push(GOLDEN_FRAME)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.headers).toEqual({
      ':message-type': 'event',
      ':event-type': 'assistantResponseEvent',
      ':content-type': 'application/json',
    })
    expect(payloadText(messages[0] as EventStreamMessage)).toBe('{"content":"Hello"}')
  })

  it('reassembles frames split at every byte boundary', () => {
    const frames = [eventFrame('assistantResponseEvent', { content: 'Hel' }), eventFrame('assistantResponseEvent', { content: 'lo' })]
    const decoded = new EventStreamDecoder()
    const texts: string[] = []
    let heldBack = 0
    for (const byte of concat(frames)) {
      for (const message of decoded.push(Uint8Array.of(byte))) texts.push(payloadText(message))
      heldBack = Math.max(heldBack, decoded.pendingBytes)
    }

    expect(texts).toEqual(['{"content":"Hel"}', '{"content":"lo"}'])
    expect(heldBack).toBeGreaterThan(0)
    expect(decoded.pendingBytes).toBe(0)
  })

  it('returns every complete frame of a chunk and holds the partial tail', () => {
    const [first, second] = [eventFrame('metadataEvent', { n: 1 }), eventFrame('metadataEvent', { n: 2 })]
    const decoded = new EventStreamDecoder()

    expect(decoded.push(concat([first, second.subarray(0, 5)])).map(payloadText)).toEqual(['{"n":1}'])
    expect(decoded.pendingBytes).toBe(5)
    expect(decoded.push(second.subarray(5)).map(payloadText)).toEqual(['{"n":2}'])
    expect(decoded.pendingBytes).toBe(0)
  })

  it('decodes every AWS header value type', () => {
    const headers = concat([
      header('yes', 0, new Uint8Array(0)),
      header('no', 1, new Uint8Array(0)),
      header('byte', 2, valueBytes(1, (view) =>{  view.setInt8(0, -2) })),
      header('short', 3, valueBytes(2, (view) =>{  view.setInt16(0, -300) })),
      header('int', 4, valueBytes(4, (view) =>{  view.setInt32(0, -70_000) })),
      header('long', 5, valueBytes(8, (view) =>{  view.setBigInt64(0, 5n) })),
      header('bytes', 6, concat([valueBytes(2, (view) =>{  view.setUint16(0, 3) }), Uint8Array.of(1, 2, 3)])),
      stringHeader('text', 'héllo'),
      header('time', 8, valueBytes(8, (view) =>{  view.setBigInt64(0, 1_700_000_000_000n) })),
      header('id', 9, Uint8Array.from({ length: 16 }, (_, index) => index)),
    ])

    const [message] = new EventStreamDecoder().push(frameOf(headers, new Uint8Array(0)))

    expect(message?.headers).toEqual({
      yes: true,
      no: false,
      byte: -2,
      short: -300,
      int: -70_000,
      long: 5n,
      bytes: Uint8Array.of(1, 2, 3),
      text: 'héllo',
      time: 1_700_000_000_000n,
      id: Uint8Array.from({ length: 16 }, (_, index) => index),
    })
    expect(message?.payload.byteLength).toBe(0)
  })

  it('refuses an unknown header type and a header cut short', () => {
    expect(() => new EventStreamDecoder().push(frameOf(header('x', 10, new Uint8Array(0)), new Uint8Array(0)))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    expect(() => new EventStreamDecoder().push(frameOf(Uint8Array.of(50, 65), new Uint8Array(0)))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    expect(() => new EventStreamDecoder().push(frameOf(Uint8Array.of(1, 65), new Uint8Array(0)))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })

  it('refuses a corrupted prelude, payload, or header length with a stable code', () => {
    const frame = eventFrame('assistantResponseEvent', { content: 'x' })
    const flipped = (index: number): Uint8Array => {
      const copy = frame.slice()
      copy[index] = (copy[index] as number) ^ 0xff
      return copy
    }

    expect(() => new EventStreamDecoder().push(flipped(5))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    expect(() => new EventStreamDecoder().push(flipped(frame.byteLength - 6))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    expect(() => new EventStreamDecoder().push(frameOf(stringHeader('a', 'b'), new Uint8Array(0), 9_999))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    expect(() => new EventStreamDecoder().push(new Uint8Array(12))).toThrow(LlmError)
  })

  it('fails on a corrupt prelude instead of waiting for the length it claims', () => {
    const corrupt = prelude(8 * 1024 * 1024, 0).slice()
    corrupt[11] = (corrupt[11] as number) ^ 0x01

    expect(() => new EventStreamDecoder().push(corrupt)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })

  it.each([
    ['below the smallest frame', 15],
    ['above the AWS limit', 16 * 1024 * 1024 + 1],
  ])('refuses a validly checksummed length %s', (_label, total) => {
    expect(() => new EventStreamDecoder().push(prelude(total, 0))).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
})

describe('readEventStream', () => {
  const frames = [eventFrame('assistantResponseEvent', { content: 'a' }), eventFrame('assistantResponseEvent', { content: 'b' })]

  it('yields messages across awkward chunks and reports every network chunk', async () => {
    const chunks = chunked(concat(frames), 7)
    let activity = 0

    const messages = await collect(readEventStream(bodyOf(chunks), new AbortController().signal, () => { activity += 1 }))

    expect(messages.map(payloadText)).toEqual(['{"content":"a"}', '{"content":"b"}'])
    expect(activity).toBe(chunks.length)
  })

  it('fails with STREAM_CLOSED when the body ends inside a frame', async () => {
    const truncated = bodyOf([(frames[0] as Uint8Array).subarray(0, 20)])

    await expect(collect(readEventStream(truncated, new AbortController().signal, () => {})))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false
    const open = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(frames[0] as Uint8Array) },
      cancel() { cancelled = true },
    })

    for await (const message of readEventStream(open, new AbortController().signal, () => {})) {
      expect(payloadText(message)).toBe('{"content":"a"}')
      break
    }

    expect(cancelled).toBe(true)
  })

  it('settles a read the transport left pending when the signal aborts', async () => {
    let cancelled = false
    const silent = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const controller = new AbortController()

    const reading = collect(readEventStream(silent, controller.signal, () => {}))
    controller.abort(new Error('caller stopped'))

    await expect(reading).rejects.toThrow('caller stopped')
    expect(cancelled).toBe(true)
  })

  it('reads nothing from a body whose signal is already aborted, and still releases it', async () => {
    let cancelled = false
    let activity = 0
    const unread = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(frames[0] as Uint8Array) },
      cancel() { cancelled = true },
    })
    const controller = new AbortController()
    controller.abort(new Error('already stopped'))

    await expect(collect(readEventStream(unread, controller.signal, () => { activity += 1 }))).rejects.toThrow('already stopped')

    expect(activity).toBe(0)
    expect(cancelled).toBe(true)
  })

  it('reports a failing body and tolerates the cancellation of that failed body', async () => {
    const failing = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('socket reset')) } })

    await expect(collect(readEventStream(failing, new AbortController().signal, () => {}))).rejects.toThrow('socket reset')
  })
})
