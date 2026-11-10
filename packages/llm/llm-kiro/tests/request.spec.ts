/** Kiro conversation request serialization: normalization invariants, tool pairing, images, reasoning, and refused options. */

import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  createAssistantMessage, createDeveloperMessage, createMessage, createSystemMessage, createToolResultMessage, createUserMessage,
  offloadedImageText, ReasoningEffortId, requestImageHandleText, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccess, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { KiroModel } from '../src/catalog.ts'
import { assertSupportedOptions, buildKiroRequest, currentImages, kiroToolUseId } from '../src/request.ts'
import type { KiroChatRequest, KiroRequestInput } from '../src/request.ts'

const PROFILE = 'arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST'
const MODEL = 'claude-sonnet-4.6'

const claude: KiroModel = {
  id: MODEL,
  name: 'Claude Sonnet 4.6',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  inputModalities: ['text', 'image'],
  reasoning: { mode: 'adaptive', efforts: ['low', 'medium', 'high', 'max'], summarizedDisplay: true },
}
const gpt: KiroModel = { ...claude, id: 'gpt-5.6-sol', reasoning: { mode: 'effort', efforts: ['low', 'high'], summarizedDisplay: false } }
const quiet: KiroModel = { ...claude, reasoning: { mode: 'adaptive', efforts: ['high'], summarizedDisplay: false } }

const readTool: ToolSchema = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const user = (...content: ContentBlock[]): RequestMessage => createUserMessage({ content, source: { kind: 'user' } })
const assistant = (...content: ContentBlock[]): RequestMessage => createAssistantMessage({ content, source: { provider: 'kiro', model: MODEL } })
const call = (id: string, name: string, args = '{}'): ContentBlock => ({ type: 'tool-call', id: ToolCallId(id), name, arguments: args })
const result = (id: string, value: string, isError = false): RequestMessage =>
  createToolResultMessage({ callId: ToolCallId(id), content: [text(value)], isError })

function build(
  messages: RequestMessage[],
  options: Partial<GenerateOptions<string>> = {},
  input: Partial<Omit<KiroRequestInput, 'options'>> = {},
) {
  return buildKiroRequest({
    options: { provider: 'kiro', model: MODEL, messages, ...options },
    model: claude,
    profileArn: PROFILE,
    conversationId: 'conv-1',
    images: new Map(),
    access: () => undefined,
    ...input,
  })
}

const turns = (body: KiroChatRequest) => body.conversationState.history ?? []
const current = (body: KiroChatRequest) => body.conversationState.currentMessage.userInputMessage

function image(fill: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): ImageAttachmentRef {
  return { attachmentId: AttachmentId(`sha256:${fill.repeat(64)}`), mediaType, bytes: 3, width: 4, height: 2 }
}

function version(ref: ImageAttachmentRef, data = Uint8Array.of(1, 2, 3)): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'f'.repeat(64)}`),
    attachment: ref,
    data,
    mediaType: ref.mediaType,
    bytes: data.byteLength,
    width: ref.width,
    height: ref.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

const picture = (ref: ImageAttachmentRef, offloaded?: true): ContentBlock => ({ type: 'image', attachment: ref, ...offloaded === undefined ? {} : { offloaded } })

describe('refused options', () => {
  it.each([
    ['temperature', { temperature: 0.2 }],
    ['a token limit', { maxTokens: 100 }],
    ['stop sequences', { stop: ['END'] }],
    ['deferred tool declarations', { tools: [{ ...readTool, deferLoading: true as const }] }],
  ])('refuses %s instead of dropping it', (_label, fields) => {
    expect(() => { assertSupportedOptions({ provider: 'kiro', model: MODEL, messages: [], ...fields }) })
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
  })
})

describe('kiroToolUseId', () => {
  it('keeps an id Kiro accepts and maps any other id to a stable valid one', () => {
    const foreign = `call_abc|fc_${'x'.repeat(80)}`

    expect(kiroToolUseId('tooluse_1.a:b-c')).toBe('tooluse_1.a:b-c')
    expect(kiroToolUseId(foreign)).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/)
    expect(kiroToolUseId(foreign)).toBe(kiroToolUseId(foreign))
    expect(kiroToolUseId(`${foreign}2`)).not.toBe(kiroToolUseId(foreign))
    expect(kiroToolUseId('has space')).toMatch(/^t_[A-Za-z0-9_-]{40}$/)
  })
})

describe('conversation shape', () => {
  it('carries the system prompt on the first turn, tool results on the final turn, and tools only there', () => {
    const body = build(
      [
        createSystemMessage('Follow the repo rules.'),
        user(text('first')),
        user(text('second')),
        assistant(text('Reading.'), call('tool_1', 'read', '{"path":"a"}')),
        result('tool_1', 'file a'),
        user(text('now continue')),
      ],
      { system: 'Be careful.', tools: [readTool] },
    )

    expect(body).toEqual({
      conversationState: {
        chatTriggerType: 'MANUAL',
        agentTaskType: 'vibe',
        conversationId: 'conv-1',
        history: [
          { userInputMessage: { content: 'Be careful.\n\nFollow the repo rules.\n\nfirst\n\nsecond', modelId: MODEL, origin: 'KIRO_CLI' } },
          { assistantResponseMessage: { content: 'Reading.', toolUses: [{ toolUseId: 'tool_1', name: 'read', input: { path: 'a' } }] } },
        ],
        currentMessage: {
          userInputMessage: {
            content: 'now continue',
            modelId: MODEL,
            origin: 'KIRO_CLI',
            userInputMessageContext: {
              tools: [{ toolSpecification: { name: 'read', description: 'Read a file', inputSchema: { json: readTool.parameters } } }],
              toolResults: [{ toolUseId: 'tool_1', content: [{ text: 'file a' }], status: 'success' }],
            },
          },
        },
      },
      profileArn: PROFILE,
      agentMode: 'vibe',
    })
  })

  it('drops blank prompts, joins text blocks as paragraphs, and skips empty ones', () => {
    const body = build([createSystemMessage('   '), user(text(''), text('a'), text('b'))], { system: '' })

    expect(body.conversationState.history).toBeUndefined()
    expect(current(body).content).toBe('a\n\nb')
  })

  it('starts with a user turn, ends with one, and never sends an empty one', () => {
    const body = build([assistant(text('hi'))])

    expect(turns(body)).toEqual([
      { userInputMessage: { content: 'Please proceed with the task.', modelId: MODEL, origin: 'KIRO_CLI' } },
      { assistantResponseMessage: { content: 'hi' } },
    ])
    expect(current(body).content).toBe('Please proceed with the task.')
  })

  it('sends the system prompt with the placeholder instruction for an empty conversation', () => {
    expect(current(build([], { system: 'Only a prompt.' })).content).toBe('Only a prompt.\n\nPlease proceed with the task.')
    expect(current(build([])).content).toBe('Please proceed with the task.')
  })

  it('answers a last assistant turn with an explicit interrupted-tool result', () => {
    const body = build([user(text('go')), assistant(call('t1', 'read', '{"path":"a"}'))], { tools: [readTool] })

    expect(current(body)).toMatchObject({
      content: '',
      userInputMessageContext: {
        toolResults: [{ toolUseId: 't1', content: [{ text: 'Tool use was interrupted and did not produce a result.' }], status: 'error' }],
      },
    })
  })

  it('merges consecutive assistant turns, drops turns Kiro cannot replay, and keeps reasoning out of history', () => {
    const body = build([
      user(text('q')),
      assistant({ type: 'reasoning', text: 'private thoughts' }),
      assistant(text('   ')),
      assistant({ type: 'reasoning', text: 'more' }, text('one')),
      assistant(text('two')),
      user(text('b')),
    ])

    expect(turns(body)).toEqual([
      { userInputMessage: { content: 'q', modelId: MODEL, origin: 'KIRO_CLI' } },
      { assistantResponseMessage: { content: 'one\n\ntwo' } },
    ])
    expect(current(body).content).toBe('b')
  })

  it('merges the user turns around an assistant turn that has nothing to replay', () => {
    const body = build([user(text('a')), assistant({ type: 'reasoning', text: 'x' }), user(text('b'))])

    expect(body.conversationState.history).toBeUndefined()
    expect(current(body).content).toBe('a\n\nb')
  })

  it('refuses content and roles Kiro cannot carry', () => {
    const lateSystem = createSystemMessage('late')
    const developer = createDeveloperMessage({ content: [text('x')], source: { kind: 'user' } })
    const imageSystem = createMessage({ role: 'system', content: [picture(image('a'))], source: { kind: 'system-prompt' } })

    expect(() => build([user(text('a')), lateSystem])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    expect(() => build([developer])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    expect(() => build([imageSystem])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    expect(() => build([user({ type: 'reasoning', text: 'x' })])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    expect(() => build([assistant(picture(image('a')))])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })
})

describe('tool calls and results', () => {
  it('maps foreign ids, pairs results in call order, drops orphans, and declares tools the history names', () => {
    const foreign = `call_abc|fc_${'x'.repeat(80)}`
    const body = build(
      [
        user(text('first')),
        user(text('second')),
        assistant(text('Reading.'), call(foreign, 'read', '{"path":"a"}'), call('tool_2', 'legacy_grep', '{"q":"b"}')),
        result(foreign, 'file a'),
        result('orphan', 'no matching call'),
        user(text('now continue')),
      ],
      { system: 'You are careful.', tools: [readTool] },
    )
    const mapped = kiroToolUseId(foreign)

    expect(mapped).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/)
    expect(turns(body)).toHaveLength(2)
    expect(turns(body)[1]).toEqual({
      assistantResponseMessage: {
        content: 'Reading.',
        toolUses: [
          { toolUseId: mapped, name: 'read', input: { path: 'a' } },
          { toolUseId: 'tool_2', name: 'legacy_grep', input: { q: 'b' } },
        ],
      },
    })
    expect(current(body).userInputMessageContext?.toolResults).toEqual([
      { toolUseId: mapped, content: [{ text: 'file a' }], status: 'success' },
      { toolUseId: 'tool_2', content: [{ text: 'Tool use was interrupted and did not produce a result.' }], status: 'error' },
    ])
    expect(current(body).userInputMessageContext?.tools?.map(tool => tool.toolSpecification)).toEqual([
      { name: 'read', description: 'Read a file', inputSchema: { json: readTool.parameters } },
      { name: 'legacy_grep', description: 'Tool no longer available.', inputSchema: { json: { type: 'object', properties: {} } } },
    ])
  })

  it('gives a tool-use id the history reuses a fresh id and re-points its result', () => {
    const body = build([
      user(text('a')),
      assistant(call('call_0', 'read')),
      result('call_0', 'one'),
      assistant(call('call_0', 'read')),
      result('call_0', 'two'),
    ], { tools: [readTool] })
    const [, first, , second] = turns(body)
    const firstId = first && 'assistantResponseMessage' in first ? first.assistantResponseMessage.toolUses?.[0]?.toolUseId : undefined
    const secondId = second && 'assistantResponseMessage' in second ? second.assistantResponseMessage.toolUses?.[0]?.toolUseId : undefined

    expect(firstId).toBe('call_0')
    expect(secondId).not.toBe('call_0')
    expect(secondId).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/)
    expect(turns(body)[2]).toMatchObject({ userInputMessage: { userInputMessageContext: { toolResults: [{ toolUseId: 'call_0', content: [{ text: 'one' }] }] } } })
    expect(current(body).userInputMessageContext?.toolResults).toEqual([{ toolUseId: secondId, content: [{ text: 'two' }], status: 'success' }])
  })

  it('pairs duplicate ids within one turn with their results in order', () => {
    const body = build([
      user(text('a')),
      assistant(call('dup', 'read'), call('dup', 'read')),
      result('dup', 'first'),
      result('dup', 'second'),
    ], { tools: [readTool] })
    const results = current(body).userInputMessageContext?.toolResults ?? []
    const assistantTurn = turns(body)[1]
    const ids = assistantTurn && 'assistantResponseMessage' in assistantTurn ? assistantTurn.assistantResponseMessage.toolUses?.map(use => use.toolUseId) : []

    expect(ids?.[0]).toBe('dup')
    expect(ids?.[1]).not.toBe('dup')
    expect(results.map(entry => [entry.toolUseId, entry.content[0]?.text])).toEqual([['dup', 'first'], [ids?.[1], 'second']])
  })

  it('does not send results that precede any tool use', () => {
    const body = build([result('early', 'stray'), user(text('go'))])

    expect(body.conversationState.history).toBeUndefined()
    expect(current(body).userInputMessageContext).toBeUndefined()
    expect(current(body).content).toBe('go')
  })

  it('reports errors, empty output, and omitted images in tool results', () => {
    const ref = image('c')
    const body = build([
      user(text('go')),
      assistant(call('t1', 'read'), call('t2', 'read'), call('t3', 'read')),
      result('t1', 'boom', true),
      createToolResultMessage({ callId: ToolCallId('t2'), content: [], isError: false }),
      createToolResultMessage({ callId: ToolCallId('t3'), content: [text('see'), picture(ref)], isError: false }),
    ], { tools: [readTool] })

    expect(current(body).userInputMessageContext?.toolResults).toEqual([
      { toolUseId: 't1', content: [{ text: 'boom' }], status: 'error' },
      { toolUseId: 't2', content: [{ text: '(no output)' }], status: 'success' },
      { toolUseId: 't3', content: [{ text: `see\n${offloadedImageText(ref)}` }], status: 'success' },
    ])
    expect(current(body).images).toBeUndefined()
  })

  it('truncates an oversized tool result around a marker and keeps one at the limit', () => {
    const oversized = `${'H'.repeat(125_000)}M${'T'.repeat(125_000)}`
    const exact = 'x'.repeat(250_000)
    const body = build([user(text('go')), assistant(call('t1', 'read'), call('t2', 'read')), result('t1', oversized), result('t2', exact)])
    const [first, second] = current(body).userInputMessageContext?.toolResults ?? []

    expect(first?.content[0]?.text).toBe(`${'H'.repeat(125_000)}\n[TRUNCATED 1 characters]\n${'T'.repeat(125_000)}`)
    expect(second?.content[0]?.text).toBe(exact)
  })

  it.each([
    ['an object', '{"path":"a"}', { path: 'a' }],
    ['invalid JSON', '{bad', {}],
    ['an array', '[1]', {}],
    ['a string', '"text"', {}],
    ['null', 'null', {}],
  ])('replays %s tool arguments as the object Kiro needs', (_label, args, input) => {
    const body = build([user(text('go')), assistant(call('t1', 'read', args)), result('t1', 'ok')])

    expect(turns(body)[1]).toEqual({ assistantResponseMessage: { content: '', toolUses: [{ toolUseId: 't1', name: 'read', input }] } })
  })

  it('declares an empty-description tool by its name', () => {
    const body = build([user(text('go'))], { tools: [{ name: 'bare', description: '', parameters: {} }] })

    expect(current(body).userInputMessageContext?.tools).toEqual([{ toolSpecification: { name: 'bare', description: 'bare', inputSchema: { json: {} } } }])
  })
})

describe('images', () => {
  const png = image('a')
  const jpeg = image('b', 'image/jpeg')
  const access = (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => ref.attachmentId === png.attachmentId ? { readonlyPath: '/world/a.png' } : undefined

  it('selects the distinct, non-offloaded images of the trailing user messages', () => {
    const messages = [
      user(picture(png)),
      assistant(text('seen')),
      user(picture(jpeg), picture(jpeg), picture(png, true), text('x')),
      result('t', 'tool image ignored here'),
      user(picture(png)),
    ]

    expect(currentImages(messages)).toEqual([jpeg, png])
    expect(currentImages([])).toEqual([])
  })

  it('sends the final turn\'s image bytes with a handle, and replaces every other occurrence with the omitted-image text', () => {
    const body = build(
      [user(text('before'), picture(png)), assistant(text('seen')), user(text('look'), picture(jpeg), picture(png, true))],
      {},
      { images: new Map([[jpeg.attachmentId, version(jpeg, Uint8Array.of(1, 2, 3))]]), access },
    )

    expect(turns(body)[0]).toEqual({
      userInputMessage: { content: `before\n\n${offloadedImageText(png, access(png))}`, modelId: MODEL, origin: 'KIRO_CLI' },
    })
    expect(current(body)).toEqual({
      content: `look\n\n${requestImageHandleText(jpeg, version(jpeg), undefined)}\n\n${offloadedImageText(png, access(png))}`,
      modelId: MODEL,
      origin: 'KIRO_CLI',
      images: [{ format: 'jpeg', source: { bytes: 'AQID' } }],
    })
  })

  it('shows the model the path a resolver exposes for a sent image', () => {
    const body = build([user(picture(png))], {}, { images: new Map([[png.attachmentId, version(png)]]), access })

    expect(current(body).content).toBe(requestImageHandleText(png, version(png), { readonlyPath: '/world/a.png' }))
    expect(current(body).images).toEqual([{ format: 'png', source: { bytes: 'AQID' } }])
  })

  it('fails a request whose current image was not prepared', () => {
    expect(() => build([user(picture(png))])).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
})

describe('reasoning effort', () => {
  it('requests adaptive thinking with summaries when the model offers them', () => {
    const body = build([user(text('x'))], { reasoningEffort: ReasoningEffortId('high') })

    expect(body.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' }, thinking: { type: 'adaptive', display: 'summarized' } })
  })

  it('omits the summary display when the model does not accept it', () => {
    const body = build([user(text('x'))], { reasoningEffort: ReasoningEffortId('high') }, { model: quiet })

    expect(body.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' }, thinking: { type: 'adaptive' } })
  })

  it('uses the reasoning field family of effort-mode models', () => {
    const body = build([user(text('x'))], { model: 'gpt-5.6-sol', reasoningEffort: ReasoningEffortId('low') }, { model: gpt })

    expect(body.additionalModelRequestFields).toEqual({ reasoning: { effort: 'low' } })
    expect(current(body).modelId).toBe('gpt-5.6-sol')
  })

  it('sends no reasoning fields when no effort is requested', () => {
    expect(build([user(text('x'))])).not.toHaveProperty('additionalModelRequestFields')
  })

  it('refuses an effort the model does not advertise, or any effort for an unlisted model', () => {
    const unsupported: unknown = expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' })

    expect(() => build([user(text('x'))], { reasoningEffort: ReasoningEffortId('xhigh') })).toThrow(unsupported)
    expect(() => build([user(text('x'))], { reasoningEffort: ReasoningEffortId('low') }, { model: undefined })).toThrow(unsupported)
  })
})
