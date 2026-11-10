/** The native Kiro adapter through its consumer-visible surface: discovery, resolution, streaming, failures, stalls, and cancellation. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import {
  BlockAssembler, createSystemMessage, createToolResultMessage, createUserMessage, LlmError, ReasoningEffortId,
  requestImageHandleText, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroAccessSource, KiroAdapterOptions } from '../src/adapter.ts'
import type { KiroAccess } from '../src/auth.ts'
import type { KiroConfig } from '../src/config.ts'
import { KIRO_USER_AGENT } from '../src/endpoints.ts'
import { collect, eventFrame, eventStreamResponse, exceptionFrame, recordedFrames } from './event-frames.ts'
import { config, failureOf, json, PROFILE_ARN, recorder, runtimeOf } from './wire.ts'
import type { Call, Handler } from './wire.ts'

afterEach(() => {
  vi.useRealTimers()
})

const MODEL = 'claude-sonnet-4.6'
const ACCESS: KiroAccess = { token: 'tok-1', region: 'eu-central-1', profileArn: PROFILE_ARN }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The account catalog as Kiro's management API lists it. */
const CATALOG = {
  models: [
    {
      modelId: MODEL,
      displayName: 'Claude Sonnet 4.6',
      supportedInputTypes: ['TEXT', 'IMAGE'],
      tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ['low', 'medium', 'high', 'max'] } } },
          thinking: { properties: { display: { enum: ['summarized', 'omitted'] } } },
        },
      },
    },
    {
      modelId: 'gpt-5.6-sol',
      modelName: 'GPT 5.6 Sol',
      additionalModelRequestFieldsSchema: JSON.stringify({
        properties: { reasoning: { properties: { effort: { enum: ['low', 'high', 'ultra'] } } } },
      }),
    },
    { modelId: 'minimax-m2.5' },
  ],
}

const readTool: ToolSchema = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const user = (...content: ContentBlock[]) => createUserMessage({ content, source: { kind: 'user' } })

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'kiro', model: MODEL, messages: [user(text('hello'))], ...overrides }
}

interface Harness {
  readonly adapter: KiroAdapter
  /** Every request the transport received, catalog and conversation alike. */
  readonly calls: Call[]
  /** The signal of every credential lookup, in order. */
  readonly lookups: (AbortSignal | undefined)[]
  readonly catalogLoads: () => Call[]
  readonly conversations: () => Call[]
}

interface HarnessOptions {
  readonly auth?: KiroAccessSource
  readonly access?: () => KiroAccess
  readonly catalog?: Handler
  readonly settings?: KiroConfig
  readonly adapter?: KiroAdapterOptions
}

function harness(reply: Handler, extra: HarnessOptions = {}): Harness {
  const lookups: (AbortSignal | undefined)[] = []
  const auth: KiroAccessSource = extra.auth ?? {
    access: (signal) => {
      lookups.push(signal)
      return Promise.resolve(extra.access?.() ?? ACCESS)
    },
  }
  const { fetch, calls } = recorder((call, index) => call.url.includes('/List-Available-Models')
    ? extra.catalog?.(call, index) ?? json(200, CATALOG)
    : reply(call, index))
  const adapter = new KiroAdapter(auth, extra.settings ?? config, { runtime: runtimeOf(fetch), ...extra.adapter })
  return {
    adapter,
    calls,
    lookups,
    catalogLoads: () => calls.filter(call => call.url.includes('/List-Available-Models')),
    conversations: () => calls.filter(call => call.url.endsWith('/generateAssistantResponse')),
  }
}

const unexpected: Handler = () => {
  throw new Error('unexpected conversation request')
}

async function recordedReply(): Promise<Handler> {
  const frames = await recordedFrames('kiro-tool-call.eventstream.hex')
  return () => eventStreamResponse(frames)
}

/** The chunks delivered before the stream failed, and the failure. */
async function failing(stream: AsyncIterable<StreamChunk>): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of stream) chunks.push(chunk)
  } catch (error) {
    return { chunks, error }
  }
  throw new Error('expected the stream to fail')
}

const sessionId = (value: string): Branded<'SessionId'> => brandString<Branded<'SessionId'>>(value)

describe('discovery', () => {
  it('names its route Kiro', () => {
    const adapter = new KiroAdapter({ access: () => Promise.resolve(ACCESS) }, config)

    expect(adapter.providerInfo('kiro')).toEqual({ id: 'kiro', name: 'Kiro' })
  })

  it('lists the signed-in account\'s models and reloads the catalog on every listing', async () => {
    const { adapter, catalogLoads } = harness(unexpected)

    const listed = await adapter.listModels('kiro')
    await adapter.listModels('kiro')

    expect(listed).toEqual([
      { provider: 'kiro', id: MODEL, name: 'Claude Sonnet 4.6', inputModalities: ['text', 'image'] },
      { provider: 'kiro', id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', inputModalities: ['text'] },
      { provider: 'kiro', id: 'minimax-m2.5', name: 'minimax-m2.5', inputModalities: ['text'] },
    ])
    expect(catalogLoads()).toHaveLength(2)
  })

  it('lists nothing while signed out, without a catalog request, but propagates every other failure', async () => {
    const signedOut = harness(unexpected, { auth: { access: () => Promise.reject(new LlmError('Kiro is not signed in.', 'MISSING_CREDENTIAL')) } })
    const expired = harness(unexpected, { auth: { access: () => Promise.reject(new LlmError('Sign-in expired.', 'AUTH')) } })
    const broken = harness(unexpected, { auth: { access: () => Promise.reject(new Error('credential store unavailable')) } })

    expect(await signedOut.adapter.listModels('kiro')).toEqual([])
    expect(signedOut.calls).toEqual([])
    await expect(expired.adapter.listModels('kiro')).rejects.toMatchObject({ code: 'AUTH' })
    await expect(broken.adapter.listModels('kiro')).rejects.toThrow('credential store unavailable')
  })

  it('propagates a catalog failure and does not remember it', async () => {
    let attempt = 0
    const { adapter, catalogLoads } = harness(unexpected, { catalog: () => ++attempt === 1 ? json(500, { message: 'Service unavailable' }) : json(200, CATALOG) })

    await expect(adapter.listModels('kiro')).rejects.toMatchObject({ code: 'SERVER', status: 500 })
    expect(await adapter.listModels('kiro')).toHaveLength(3)
    expect(catalogLoads()).toHaveLength(2)
  })
})

describe('model resolution', () => {
  it('describes a reasoning model from the account catalog and declares no request defaults', async () => {
    const { adapter } = harness(unexpected)

    // `toStrictEqual` also proves the absence of defaultMaxTokens, defaultEffort, and conversation-update modes.
    expect(await adapter.resolveModel('kiro', MODEL)).toStrictEqual({
      provider: 'kiro',
      id: MODEL,
      name: 'Claude Sonnet 4.6',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('medium'), name: 'Medium' },
          { id: ReasoningEffortId('high'), name: 'High' },
          { id: ReasoningEffortId('max'), name: 'Max' },
        ],
      },
    })
    expect(await adapter.resolveModel('kiro', 'gpt-5.6-sol')).toStrictEqual({
      provider: 'kiro',
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      inputModalities: ['text'],
      context: { contextWindow: 200_000 },
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }] },
    })
    expect(await adapter.resolveModel('kiro', 'minimax-m2.5')).toStrictEqual({
      provider: 'kiro',
      id: 'minimax-m2.5',
      name: 'minimax-m2.5',
      inputModalities: ['text'],
      context: { contextWindow: 200_000 },
    })
  })

  it('resolves a model the account does not list as text-only', async () => {
    const { adapter } = harness(unexpected)

    expect(await adapter.resolveModel('kiro', 'unlisted')).toStrictEqual({ provider: 'kiro', id: 'unlisted', name: 'unlisted', inputModalities: ['text'] })
  })

  it('serves resolution from one shared catalog load, per credential', async () => {
    let token = 'tok-1'
    const { adapter, catalogLoads } = harness(unexpected, { access: () => ({ ...ACCESS, token }) })

    await Promise.all([adapter.resolveModel('kiro', MODEL), adapter.resolveModel('kiro', 'gpt-5.6-sol')])
    await adapter.resolveModel('kiro', 'minimax-m2.5')
    expect(catalogLoads()).toHaveLength(1)

    // A refreshed token, or another account, never reads the previous credential's catalog.
    token = 'tok-2'
    await adapter.resolveModel('kiro', MODEL)
    expect(catalogLoads()).toHaveLength(2)
    expect(catalogLoads().map(call => call.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('lets a cancelled caller leave without cancelling the load other callers wait for', async () => {
    const gate = Promise.withResolvers<Response>()
    const loading = Promise.withResolvers<undefined>()
    const { adapter, catalogLoads } = harness(unexpected, { catalog: () => { loading.resolve(undefined); return gate.promise } })
    const controller = new AbortController()

    const cancelled = failureOf(adapter.resolveModel('kiro', MODEL, controller.signal))
    await loading.promise
    controller.abort(new Error('picker closed'))
    expect(await cancelled).toMatchObject({ code: 'ABORTED' })

    gate.resolve(json(200, CATALOG))
    expect(await adapter.resolveModel('kiro', MODEL)).toMatchObject({ id: MODEL })
    expect(catalogLoads()).toHaveLength(1)
  })

  it('fails promptly for a signal that is already aborted, whatever the credential lookup answers', async () => {
    const { adapter, calls } = harness(unexpected)

    await expect(failureOf(adapter.resolveModel('kiro', MODEL, AbortSignal.abort(new Error('stopped'))))).resolves.toMatchObject({ code: 'ABORTED' })
    expect(calls).toEqual([])
  })

  it('fails resolution while signed out with the credential owner\'s actionable error', async () => {
    const signedOut = new LlmError('Kiro is not signed in. Run /kiro-login.', 'MISSING_CREDENTIAL')
    const { adapter } = harness(unexpected, { auth: { access: () => Promise.reject(signedOut) } })

    await expect(adapter.resolveModel('kiro', MODEL)).rejects.toBe(signedOut)
    await expect(collect(adapter.stream(options()))).rejects.toBe(signedOut)
  })
})

describe('prepared calls', () => {
  it('binds the resolved metadata and the request to one credential and catalog generation', async () => {
    const reply = await recordedReply()
    const { adapter, lookups, catalogLoads, conversations } = harness(reply)

    const prepared = await adapter.prepareCall('kiro', MODEL)
    const chunks = await collect(prepared.stream(options({ reasoningEffort: ReasoningEffortId('max') })))

    expect(prepared.model).toStrictEqual(await adapter.resolveModel('kiro', MODEL))
    // Dispatch reused the prepared credential and catalog instead of reading them again.
    expect(lookups).toHaveLength(2)
    expect(catalogLoads()).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(conversations()[0]?.body).toMatchObject({
      additionalModelRequestFields: { output_config: { effort: 'max' }, thinking: { type: 'adaptive', display: 'summarized' } },
    })
  })

  it('refuses an effort for a model the catalog does not list, naming the model', async () => {
    const { adapter, conversations } = harness(unexpected)
    const prepared = await adapter.prepareCall('kiro', 'unlisted')

    await expect(collect(prepared.stream(options({ model: 'unlisted', reasoningEffort: ReasoningEffortId('high') }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(conversations()).toEqual([])
  })
})

describe('streaming', () => {
  it('sends the conversation to the profile\'s runtime host with attribution and streams native chunks from the recorded reply', async () => {
    const reply = await recordedReply()
    const { adapter, conversations } = harness(reply)

    const chunks = await collect(adapter.stream(options({ sessionId: sessionId('session-1') })))

    const [request] = conversations()
    expect(request?.url).toBe('https://runtime.eu-central-1.kiro.dev/generateAssistantResponse')
    expect(request?.init.method).toBe('POST')
    expect(request?.init.redirect).toBe('error')
    expect(request?.headers).toEqual({
      'user-agent': KIRO_USER_AGENT,
      'content-type': 'application/json',
      'accept': 'application/vnd.amazon.eventstream',
      'authorization': 'Bearer tok-1',
      'x-amzn-codewhisperer-optout': 'true',
      'x-amzn-kiro-agent-mode': 'vibe',
      'x-amzn-kiro-profile-arn': PROFILE_ARN,
      'amz-sdk-request': 'attempt=1; max=1',
      'amz-sdk-invocation-id': expect.stringMatching(UUID) as string,
      'x-amz-user-agent': KIRO_USER_AGENT,
    })
    expect(request?.body).toEqual({
      conversationState: {
        chatTriggerType: 'MANUAL',
        agentTaskType: 'vibe',
        conversationId: 'session-1',
        currentMessage: { userInputMessage: { content: 'hello', modelId: MODEL, origin: 'KIRO_CLI' } },
      },
      profileArn: PROFILE_ARN,
      agentMode: 'vibe',
    })
    await expect(`${JSON.stringify(chunks, null, 2)}\n`).toMatchFileSnapshot('expected/kiro-tool-call.chunks.json')
  })

  it('mints a conversation id and invocation id per request when the call has no session', async () => {
    const reply = await recordedReply()
    const { adapter, conversations } = harness(reply)

    await collect(adapter.stream(options()))
    await collect(adapter.stream(options()))

    const [first, second] = conversations()
    const request = z.object({ conversationState: z.object({ conversationId: z.string() }) })
    const ids = [first, second].map(call => request.parse(call?.body).conversationState.conversationId)
    expect(ids.every(id => UUID.test(id))).toBe(true)
    expect(ids[0]).not.toBe(ids[1])
    expect(first?.headers['amz-sdk-invocation-id']).not.toBe(second?.headers['amz-sdk-invocation-id'])
  })

  it('round-trips a tool call: the next request replays the call and answers it with its result', async () => {
    const replies = [
      eventStreamResponse(await recordedFrames('kiro-tool-call.eventstream.hex')),
      eventStreamResponse([
        eventFrame('assistantResponseEvent', { content: 'The file says ' }),
        eventFrame('assistantResponseEvent', { content: 'hello.' }),
        eventFrame('metadataEvent', { tokenUsage: { uncachedInputTokens: 40, outputTokens: 5 } }),
      ]),
    ]
    let turn = 0
    const { adapter, conversations } = harness(() => replies[turn++] as Response)
    const request = { system: 'You are careful.', tools: [readTool] }

    const first = new BlockAssembler()
    for await (const chunk of adapter.stream(options({ ...request, messages: [user(text('Read notes.txt'))] }))) first.push(chunk)
    const callBlock = first.blocks().find(block => block.type === 'tool-call')
    expect(callBlock).toEqual({ type: 'tool-call', id: 'tooluse_8xQmZkLw3PqNvRt5Yb2HcA', name: 'read', arguments: '{"path":"notes.txt"}' })

    const second = new BlockAssembler()
    const history = [
      user(text('Read notes.txt')),
      first.message({ provider: 'kiro', model: MODEL }),
      createToolResultMessage({ callId: ToolCallId('tooluse_8xQmZkLw3PqNvRt5Yb2HcA'), content: [text('hello from notes.txt')], isError: false }),
    ]
    for await (const chunk of adapter.stream(options({ ...request, messages: [createSystemMessage('Persona.'), ...history] }))) second.push(chunk)

    expect(second.blocks()).toEqual([{ type: 'text', text: 'The file says hello.' }])
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(second.usage).toEqual({ inputTokens: 40, outputTokens: 5, totalTokens: 45 })
    const body = conversations()[1]?.body as { conversationState: { history: unknown[]; currentMessage: unknown } }
    expect(body.conversationState.history).toEqual([
      { userInputMessage: { content: 'You are careful.\n\nPersona.\n\nRead notes.txt', modelId: MODEL, origin: 'KIRO_CLI' } },
      {
        assistantResponseMessage: {
          content: 'I\'ll read the file.',
          toolUses: [{ toolUseId: 'tooluse_8xQmZkLw3PqNvRt5Yb2HcA', name: 'read', input: { path: 'notes.txt' } }],
        },
      },
    ])
    expect(body.conversationState.currentMessage).toEqual({
      userInputMessage: {
        content: '',
        modelId: MODEL,
        origin: 'KIRO_CLI',
        userInputMessageContext: {
          tools: [{ toolSpecification: { name: 'read', description: 'Read a file', inputSchema: { json: readTool.parameters } } }],
          toolResults: [{ toolUseId: 'tooluse_8xQmZkLw3PqNvRt5Yb2HcA', content: [{ text: 'hello from notes.txt' }], status: 'success' }],
        },
      },
    })
  })

  it.each([
    ['temperature', { temperature: 0.2 }],
    ['a token limit', { maxTokens: 512 }],
    ['stop sequences', { stop: ['END'] }],
    ['deferred tools', { tools: [{ ...readTool, deferLoading: true as const }] }],
  ])('refuses %s before any credential or network work', async (_label, fields) => {
    const { adapter, calls, lookups } = harness(unexpected)

    await expect(collect(adapter.stream(options(fields)))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })

    expect(calls).toEqual([])
    expect(lookups).toEqual([])
  })

  it('stops the transport when the consumer stops reading', async () => {
    let cancelled = false
    const { adapter } = harness(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(eventFrame('assistantResponseEvent', { content: 'first' })) },
      cancel() { cancelled = true },
    }), { status: 200 }))

    for await (const chunk of adapter.stream(options())) {
      expect(chunk).toMatchObject({ type: 'block-start' })
      break
    }

    expect(cancelled).toBe(true)
  })
})

describe('failures', () => {
  it('reports a rejected request with the status and the code its answer maps to', async () => {
    const { adapter, conversations } = harness(() => json(401, { message: 'The token is invalid.' }))

    const failure = await failureOf(collect(adapter.stream(options())))

    expect(failure).toMatchObject({ code: 'AUTH' })
    expect(failure.failure.status).toBe(401)
    expect(conversations()).toHaveLength(1)
  })

  it('does not retry inside the adapter: one call is one provider attempt', async () => {
    const { adapter, conversations } = harness(() => json(400, { message: 'Invalid tool use format.' }))

    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    expect(conversations()).toHaveLength(1)
  })

  it('classifies context overflow by Kiro\'s structured reason and carries the provider\'s retry delay', async () => {
    const overflow = harness(() => json(400, { message: 'Input is too long.', reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }))
    const limited = harness(() => json(429, { message: 'Too many requests' }, { 'retry-after': '2' }))

    await expect(collect(overflow.adapter.stream(options()))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    const throttled = await failureOf(collect(limited.adapter.stream(options())))
    expect(throttled.code).toBe('RATE_LIMIT')
    expect(throttled.failure.providerRetryAfterMs).toBe(2000)
  })

  it('reports a network failure as TRANSPORT with its cause', async () => {
    const networkError = new TypeError('fetch failed')
    const { adapter } = harness(() => Promise.reject(networkError))

    const failure = await failureOf(collect(adapter.stream(options())))

    expect(failure).toMatchObject({ code: 'TRANSPORT' })
    expect(failure.cause).toBe(networkError)
  })

  it('fails an answer without a body', async () => {
    const { adapter } = harness(() => new Response(null, { status: 200 }))

    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('fails a reply that carried no content, which the agent\'s retry policy treats as transient', async () => {
    const { adapter } = harness(() => eventStreamResponse([eventFrame('metadataEvent', { tokenUsage: { outputTokens: 1 } })]))

    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('surfaces an in-band exception after the output that preceded it', async () => {
    const { adapter } = harness(() => eventStreamResponse([
      eventFrame('assistantResponseEvent', { content: 'partial' }),
      exceptionFrame('ThrottlingException', { message: 'Too many requests', reason: 'USER_REQUEST_RATE_EXCEEDED' }),
    ]))

    const { chunks, error } = await failing(adapter.stream(options()))

    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta'])
    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('refuses a corrupt frame and a body that ends inside one', async () => {
    const frame = eventFrame('assistantResponseEvent', { content: 'x' })
    const corrupt = frame.slice()
    corrupt[corrupt.byteLength - 6] = (corrupt[corrupt.byteLength - 6] as number) ^ 0xff
    const checksum = harness(() => eventStreamResponse([frame, corrupt]))
    const truncated = harness(() => eventStreamResponse([frame, frame.subarray(0, 20)]))

    await expect(collect(checksum.adapter.stream(options()))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect(truncated.adapter.stream(options()))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

describe('stall limits', () => {
  const limits = { ...config, firstEventTimeoutMs: 30, idleTimeoutMs: 40 }

  it('times out a request that produces no output within the first-event budget and aborts the transport', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const posted = Promise.withResolvers<undefined>()
    let transport: AbortSignal | null | undefined
    const { adapter } = harness((call) => {
      transport = call.init.signal
      posted.resolve(undefined)
      // The transport ignores its signal, like an unresponsive proxy.
      return new Promise<Response>(() => {})
    }, { settings: limits })

    const failure = failureOf(collect(adapter.stream(options())))
    await posted.promise
    await vi.advanceTimersByTimeAsync(30)

    expect(await failure).toMatchObject({ code: 'TIMEOUT' })
    expect(transport?.aborted).toBe(true)
  })

  it('counts the first-event wait as one budget, then times out gaps between network reads, partial frames included', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frames = [eventFrame('assistantResponseEvent', { content: 'partial' }), eventFrame('assistantResponseEvent', { content: 'more' })]
    let feed!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const posted = Promise.withResolvers<undefined>()
    const { adapter } = harness(() => {
      posted.resolve(undefined)
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { feed = controller },
        cancel() { cancelled = true },
      }), { status: 200 })
    }, { settings: { ...limits, firstEventTimeoutMs: 1_000 } })

    const stream = adapter.stream(options())[Symbol.asyncIterator]()
    const opening = stream.next()
    await posted.promise
    feed.enqueue(frames[0] as Uint8Array)
    expect((await opening).value).toMatchObject({ type: 'block-start' })
    expect((await stream.next()).value).toMatchObject({ type: 'text-delta', text: 'partial' })

    let outcome: unknown = 'pending'
    const waiting = stream.next().then(() => { outcome = 'chunk' }, (error: unknown) => { outcome = error })
    await vi.advanceTimersByTimeAsync(30)
    // Part of the next frame proves the connection is alive without completing an event.
    feed.enqueue((frames[1] as Uint8Array).slice(0, 5))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(39)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await waiting

    expect(outcome).toMatchObject({ code: 'TIMEOUT' })
    expect(cancelled).toBe(true)
  })
})

describe('cancellation', () => {
  it('aborts a pending read at once and releases the body', async () => {
    const controller = new AbortController()
    const posted = Promise.withResolvers<undefined>()
    let cancelled = false
    const { adapter } = harness(() => {
      posted.resolve(undefined)
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { status: 200 })
    })

    const failure = failureOf(collect(adapter.stream(options({ signal: controller.signal }))))
    await posted.promise
    controller.abort(new Error('user pressed stop'))

    expect(await failure).toMatchObject({ code: 'ABORTED' })
    expect(cancelled).toBe(true)
  })

  it('aborts a request still waiting for response headers, even when the transport ignores the signal', async () => {
    const controller = new AbortController()
    const posted = Promise.withResolvers<undefined>()
    const { adapter } = harness(() => {
      posted.resolve(undefined)
      return new Promise<Response>(() => {})
    })

    const failure = failureOf(collect(adapter.stream(options({ signal: controller.signal }))))
    await posted.promise
    controller.abort()

    expect(await failure).toMatchObject({ code: 'ABORTED' })
  })

  it('does no work for a signal that is already aborted', async () => {
    const { adapter, calls, lookups } = harness(unexpected)

    await expect(collect(adapter.stream(options({ signal: AbortSignal.abort() })))).rejects.toMatchObject({ code: 'ABORTED' })

    expect(calls).toEqual([])
    expect(lookups).toEqual([])
  })

  it('abandons a catalog load for the caller who cancelled it', async () => {
    const gate = Promise.withResolvers<Response>()
    const loading = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const { adapter, conversations } = harness(unexpected, { catalog: () => { loading.resolve(undefined); return gate.promise } })

    const failure = failureOf(collect(adapter.stream(options({ signal: controller.signal }))))
    await loading.promise
    controller.abort()

    expect(await failure).toMatchObject({ code: 'ABORTED' })
    expect(conversations()).toEqual([])
    gate.resolve(json(200, CATALOG))
  })
})

describe('images', () => {
  const png: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 4, height: 2 }
  const version: RequestImageAttachment = {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: png,
    data: Uint8Array.of(1, 2, 3),
    mediaType: 'image/png',
    bytes: 3,
    width: 4,
    height: 2,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
  const picture: ContentBlock = { type: 'image', attachment: png }

  /** Supply only the image projection; any other storage work fails the test. */
  function store(readImageRequest: AttachmentStore['readImageRequest']): AttachmentStore {
    class ProjectedAttachments extends AttachmentStore {
      get imageLimits(): never { throw new Error('unexpected image policy read') }
      validateImage(): never { throw new Error('unexpected image validation') }
      saveImage(): never { throw new Error('unexpected image save') }
      readImage(): never { throw new Error('unexpected original image read') }
      override readImageRequest = readImageRequest
    }
    return new ProjectedAttachments(new Context())
  }

  it('sends the final turn\'s image bytes with a handle, preparing them through the attachment service', async () => {
    const reads: unknown[][] = []
    const attachments = store((ref, target, signal) => { reads.push([ref, target, signal]); return Promise.resolve(version) })
    const reply = await recordedReply()
    const { adapter, conversations } = harness(reply, {
      adapter: { resolveAttachments: () => attachments, resolveImageAccess: (_store, ref) => ref.attachmentId === png.attachmentId ? { readonlyPath: '/world/a.png' } : undefined },
    })

    await collect(adapter.stream(options({ messages: [user(text('look'), picture)] })))

    expect(reads).toEqual([[png, { width: 4, height: 2, maxBytes: 3 }, expect.any(AbortSignal)]])
    expect(conversations()[0]?.body).toMatchObject({
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: `look\n\n${requestImageHandleText(png, version, { readonlyPath: '/world/a.png' })}`,
            images: [{ format: 'png', source: { bytes: 'AQID' } }],
          },
        },
      },
    })
  })

  it('needs the attachment service only for images it will send', async () => {
    const reply = await recordedReply()
    const withoutStore = harness(reply)
    const older = [user(picture), createToolResultMessage({ callId: ToolCallId('x'), content: [], isError: false }), user(text('later'))]

    // The image before the last assistant turn is only described, so no service is needed.
    const messages = [
      user(picture),
      { ...createUserMessage({ content: [text('x')], source: { kind: 'user' } }), role: 'assistant' as const, source: { kind: 'model' as const, provider: 'kiro', model: MODEL } },
      user(text('later')),
    ]

    expect(older).toHaveLength(3)
    await expect(collect(withoutStore.adapter.stream(options({ messages: [user(text('look'), picture)] }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(withoutStore.conversations()).toEqual([])
    expect(messages).toHaveLength(3)
  })

  it('refuses image input for a model that does not accept it, listed or not', async () => {
    const attachments = store(() => Promise.resolve(version))
    const { adapter, conversations } = harness(unexpected, { adapter: { resolveAttachments: () => attachments } })

    for (const model of ['minimax-m2.5', 'unlisted']) {
      await expect(collect(adapter.stream(options({ model, messages: [user(picture)] }))))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    }
    expect(conversations()).toEqual([])
  })
})

describe('request options passed through', () => {
  it('requests the effort a caller selected from the advertised list', async () => {
    const reply = await recordedReply()
    const { adapter, conversations } = harness(reply)

    await collect(adapter.stream(options({ reasoningEffort: ReasoningEffortId('low') })))
    await expect(collect(adapter.stream(options({ reasoningEffort: ReasoningEffortId('xhigh') })))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })

    expect(conversations()).toHaveLength(1)
    expect(conversations()[0]?.body).toMatchObject({ additionalModelRequestFields: { output_config: { effort: 'low' } } })
  })
})
