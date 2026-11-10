/** Translation of Kiro conversation events into native stream chunks, including the recorded wire reply. */

import { describe, expect, it } from 'vitest'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { readEventStream } from '../src/eventstream.ts'
import type { EventStreamMessage } from '../src/eventstream.ts'
import { translate } from '../src/stream.ts'
import { bodyOf, chunked, collect, concat, eventMessage, recordedFrames } from './event-frames.ts'

async function* source(messages: readonly EventStreamMessage[]): AsyncGenerator<EventStreamMessage> {
  yield* messages
}

function run(...messages: EventStreamMessage[]): Promise<StreamChunk[]> {
  return collect(translate(source(messages)))
}

/** The chunks delivered before the stream failed, and the failure. */
async function failing(...messages: EventStreamMessage[]): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of translate(source(messages))) chunks.push(chunk)
  } catch (error) {
    return { chunks, error }
  }
  throw new Error('expected the stream to fail')
}

const text = (content: string) => eventMessage('assistantResponseEvent', { content })
const thinking = (value: string) => eventMessage('reasoningContentEvent', { text: value })
const tool = (payload: Record<string, unknown>) => eventMessage('toolUseEvent', payload)
const metadata = (payload: Record<string, unknown>) => eventMessage('metadataEvent', payload)
const encoder = new TextEncoder()

/** An in-band exception or error frame without framing. */
function fault(type: 'exception' | 'error', headers: Record<string, string>, payload: unknown = {}): EventStreamMessage {
  return {
    headers: { ':message-type': type, ...headers },
    payload: encoder.encode(JSON.stringify(payload)),
  }
}

const start = (index: number, blockType: string): StreamChunk => ({ type: 'block-start', index, blockType }) as StreamChunk
const callDelta = (index: number, id: string, argumentsDelta: string, name?: string): StreamChunk =>
  ({ type: 'tool-call-delta', index, id, ...name === undefined ? {} : { name }, argumentsDelta }) as StreamChunk

describe('text and reasoning blocks', () => {
  it('streams first-seen blocks, closing each when another kind begins or a signature ends thinking', async () => {
    const chunks = await run(
      thinking('Let me look.'),
      eventMessage('reasoningContentEvent', { signature: 'sig-1' }),
      text('Reading '),
      text('now.'),
      thinking('Second thought'),
      text('Done.'),
    )

    expect(chunks).toEqual([
      start(0, 'reasoning'),
      { type: 'reasoning-delta', index: 0, text: 'Let me look.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me look.' } },
      start(1, 'text'),
      { type: 'text-delta', index: 1, text: 'Reading ' },
      { type: 'text-delta', index: 1, text: 'now.' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Reading now.' } },
      start(2, 'reasoning'),
      { type: 'reasoning-delta', index: 2, text: 'Second thought' },
      { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'Second thought' } },
      start(3, 'text'),
      { type: 'text-delta', index: 3, text: 'Done.' },
      { type: 'block-end', index: 3, block: { type: 'text', text: 'Done.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('ignores empty text, a signature with no thinking to end, and events it has no counterpart for', async () => {
    const chunks = await run(
      text(''),
      eventMessage('reasoningContentEvent', { signature: 'orphan' }),
      eventMessage('contextUsageEvent', { contextUsagePercentage: 2.5 }),
      eventMessage('meteringEvent', { unit: 'credit', usage: 0.25 }),
      eventMessage('followupPromptEvent', { followupPrompt: { content: 'next?' } }),
      { headers: { ':message-type': 'event' }, payload: encoder.encode('{"content":"no event type"}') },
      { headers: { ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, payload: new Uint8Array(0) },
      text('ok'),
    )

    expect(chunks).toEqual([
      start(0, 'text'),
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('tool calls', () => {
  const id = 'tooluse_1'

  it('opens a call on its id, skips the empty and `{}` placeholders, and streams raw JSON fragments', async () => {
    const chunks = await run(
      tool({ toolUseId: id, name: 'read', input: '' }),
      tool({ input: '{}' }),
      tool({ toolUseId: id, name: 'read', input: '{"pa' }),
      tool({ input: 'th":"a.ts"}' }),
      tool({ stop: true }),
    )

    expect(chunks).toEqual([
      start(0, 'tool-call'),
      callDelta(0, id, '', 'read'),
      callDelta(0, id, '{"pa'),
      callDelta(0, id, 'th":"a.ts"}'),
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: '{"path":"a.ts"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('gives a call that only ever sent the `{}` placeholder empty-object arguments', async () => {
    const chunks = await run(tool({ toolUseId: id, name: 'ping', input: '{}' }), tool({ stop: true }))

    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'ping', arguments: '{}' } })
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toEqual([callDelta(0, id, '', 'ping')])
  })

  it('serializes an object input and appends a nested `{}` once arguments have started', async () => {
    const objectInput = await run(tool({ toolUseId: id, name: 'read', input: { path: 'a' } }), tool({ stop: true }))
    const nested = await run(
      tool({ toolUseId: id, name: 'read', input: '{"a":' }),
      tool({ input: '{}' }),
      tool({ input: '}' }),
      tool({ stop: true }),
    )

    expect(objectInput).toContainEqual(callDelta(0, id, '{"path":"a"}'))
    expect(nested).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: '{"a":{}}' } })
  })

  it('closes a call when another id begins and keeps indexes in first-seen order', async () => {
    const chunks = await run(
      thinking('plan'),
      tool({ toolUseId: 'first', name: 'read', input: '{"path":"a"}' }),
      tool({ toolUseId: 'second', name: 'write', input: '{"path":"b"}' }),
      tool({ toolUseId: 'second', stop: true }),
    )

    expect(chunks.filter(chunk => chunk.type === 'block-start')).toEqual([start(0, 'reasoning'), start(1, 'tool-call'), start(2, 'tool-call')])
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.type === 'block-end' ? chunk.block : undefined)).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'tool-call', id: 'first', name: 'read', arguments: '{"path":"a"}' },
      { type: 'tool-call', id: 'second', name: 'write', arguments: '{"path":"b"}' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('accepts the name after the call opened', async () => {
    const chunks = await run(
      tool({ toolUseId: id, input: '{"a":' }),
      tool({ input: '1}' }),
      tool({ name: 'read' }),
      tool({ stop: true }),
    )

    expect(chunks).toEqual([
      start(0, 'tool-call'),
      callDelta(0, id, ''),
      callDelta(0, id, '{"a":'),
      callDelta(0, id, '1}'),
      callDelta(0, id, '', 'read'),
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: '{"a":1}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('ignores fragments, names, and stops that have no open call to extend', async () => {
    const chunks = await run(tool({ input: '{"x":1}' }), tool({ name: 'orphan' }), tool({ stop: true }), text('hi'), tool({ input: '{"y":2}' }))

    expect(chunks).toEqual([
      start(0, 'text'),
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('validates a call that never sent a stop marker when the stream ends', async () => {
    const { error } = await failing(tool({ toolUseId: id, name: 'read', input: '{"path"' }))

    expect(error).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect((error as LlmError).cause).toBeInstanceOf(SyntaxError)
  })

  it.each([
    ['a string', '"text"'],
    ['null', 'null'],
    ['an array', '[1]'],
  ])('refuses arguments that are %s rather than a JSON object', async (_label, input) => {
    const { error } = await failing(tool({ toolUseId: id, name: 'read', input }), tool({ stop: true }))

    expect(error).toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses a call without a name', async () => {
    const { error } = await failing(tool({ toolUseId: id, input: '{}' }), tool({ stop: true }))

    expect(error).toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('finish and usage', () => {
  it('cuts a truncated call at the output limit, keeps its raw arguments, and lets the assembler drop it', async () => {
    const chunks = await run(
      text('writing'),
      tool({ toolUseId: 'cut', name: 'write', input: '{"path":"/very lo' }),
      metadata({ stopReason: 'MAX_TOKENS' }),
    )

    expect(chunks.slice(-2)).toEqual([
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'cut', name: 'write', arguments: '{"path":"/very lo' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'writing' }])
  })

  it.each(['max_tokens', 'length'])('maps the %s stop reason to max-tokens, even with no content', async (stopReason) => {
    expect(await run(metadata({ stopReason }))).toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  })

  it('treats any other stop reason as an ordinary stop', async () => {
    expect((await run(text('x'), metadata({ stopReason: 'end_turn' }))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('fails a response that completed without content', async () => {
    await expect(run()).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(run(metadata({ tokenUsage: { outputTokens: 1 } }))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it.each([
    [
      'every counter',
      { uncachedInputTokens: 120, outputTokens: 30, totalTokens: 190, cacheReadInputTokens: 25, cacheWriteInputTokens: 15 },
      { inputTokens: 120, outputTokens: 30, totalTokens: 190, cacheReadTokens: 25, cacheWriteTokens: 15 },
    ],
    ['no reported total', { uncachedInputTokens: 10, outputTokens: 2 }, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }],
    ['only output tokens', { outputTokens: 7 }, { inputTokens: 0, outputTokens: 7, totalTokens: 7 }],
    [
      'input tokens and a cache read',
      { uncachedInputTokens: 5, cacheReadInputTokens: 3 },
      { inputTokens: 5, outputTokens: 0, totalTokens: 8, cacheReadTokens: 3 },
    ],
    ['only a cache write', { cacheWriteInputTokens: 4 }, { inputTokens: 0, outputTokens: 0, totalTokens: 4, cacheWriteTokens: 4 }],
    ['a total below its components', { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 3 }, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }],
  ])('reports %s as disjoint usage immediately before finish', async (_label, tokenUsage, usage) => {
    const chunks = await run(text('ok'), metadata({ tokenUsage }))

    expect(chunks.at(-2)).toStrictEqual({ type: 'usage', usage })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('merges usage that arrives in several events', async () => {
    const chunks = await run(
      metadata({ tokenUsage: { uncachedInputTokens: 120 } }),
      text('ok'),
      metadata({ tokenUsage: { outputTokens: 30 } }),
    )

    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } })
  })

  it('omits usage Kiro did not report or reported unusably, and never fails the response for it', async () => {
    const chunks = await run(text('ok'), metadata({ tokenUsage: { outputTokens: -1 }, stopReason: 7 }))

    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('malformed events', () => {
  it('refuses a payload that is not JSON', async () => {
    const { error } = await failing({ headers: { ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, payload: encoder.encode('not json') })

    expect(error).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect((error as LlmError).cause).toBeInstanceOf(SyntaxError)
  })

  it.each([
    ['assistantResponseEvent', { content: 5 }],
    ['reasoningContentEvent', ['not', 'an object']],
    ['toolUseEvent', { toolUseId: '' }],
    ['metadataEvent', 'text'],
  ])('refuses an invalid %s payload', async (eventType, payload) => {
    const { error } = await failing(eventMessage(eventType, payload))

    expect(error).toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('in-band failures', () => {
  it.each([
    ['ThrottlingException', { message: 'Too many requests', reason: 'USER_REQUEST_RATE_EXCEEDED' }, 'RATE_LIMIT'],
    ['ThrottlingException', { message: 'Limit reached', reason: 'MONTHLY_REQUEST_COUNT' }, 'QUOTA'],
    ['ServiceQuotaExceededException', { message: 'No credits left' }, 'QUOTA'],
    ['AccessDeniedException', { message: 'Denied' }, 'AUTH'],
    ['ExpiredTokenException', { message: 'Expired' }, 'AUTH'],
    ['UnrecognizedClientException', { message: 'Unknown client' }, 'AUTH'],
    ['ValidationException', { message: 'Bad input' }, 'INVALID_REQUEST'],
    ['ValidationException', { message: 'Too much', reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }, 'CONTEXT_WINDOW_EXCEEDED'],
    ['InternalServerException', { message: 'Boom' }, 'SERVER'],
    // The message is display text: wording that resembles another failure class never selects its code.
    ['SomethingNewException', { message: 'input is too long; quota exceeded; throttled' }, 'SERVER'],
  ])('maps %s %j to %s by its type and reason tag', async (type, payload, code) => {
    const { chunks, error } = await failing(text('partial'), fault('exception', { ':exception-type': type }, payload))

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code })
    // Output delivered before the failure stays delivered; no usage or finish follows it.
    expect(chunks).toEqual([start(0, 'text'), { type: 'text-delta', index: 0, text: 'partial' }])
  })

  it('reports an error frame by its error code and header message', async () => {
    const { error } = await failing(fault('error', { ':error-code': 'InternalFailure', ':error-message': 'The service failed' }))

    expect(error).toMatchObject({ code: 'SERVER' })
  })

  it('reports a bare error frame and an unreadable error body without losing the failure', async () => {
    const bare = await failing(fault('error', {}))
    const unreadable = await failing(fault('exception', { ':exception-type': 'ThrottlingException' }, 'oops'))

    expect(bare.error).toMatchObject({ code: 'SERVER' })
    expect(unreadable.error).toMatchObject({ code: 'RATE_LIMIT' })
  })
})

describe('recorded Kiro reply', () => {
  async function replay(chunkSize: number): Promise<StreamChunk[]> {
    const frames = await recordedFrames('kiro-tool-call.eventstream.hex')
    const body = bodyOf(chunked(concat(frames), chunkSize))
    return collect(translate(readEventStream(body, new AbortController().signal, () => {})))
  }

  it('translates the wire bytes into native chunks', async () => {
    const chunks = await replay(7)

    await expect(`${JSON.stringify(chunks, null, 2)}\n`).toMatchFileSnapshot('expected/kiro-tool-call.chunks.json')
  })

  it('is independent of how the network splits the bytes', async () => {
    expect(await replay(1)).toEqual(await replay(4096))
  })

  it('assembles into the thinking, text, and tool call the model produced, with usage before finish', async () => {
    const chunks = await replay(7)
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'The user wants the file read.' },
      { type: 'text', text: 'I\'ll read the file.' },
      { type: 'tool-call', id: 'tooluse_8xQmZkLw3PqNvRt5Yb2HcA', name: 'read', arguments: '{"path":"notes.txt"}' },
    ])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.usage).toEqual({ inputTokens: 1292, outputTokens: 57, totalTokens: 1349, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(chunks.map(chunk => chunk.type).slice(-2)).toEqual(['usage', 'finish'])
  })
})
