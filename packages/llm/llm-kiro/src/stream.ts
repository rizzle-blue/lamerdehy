/**
 * Translation of Kiro conversation events into the native stream protocol.
 * Adapted from omp-kiro-provider (MIT, see ../LICENSE).
 *
 * Kiro streams `assistantResponseEvent` text, `reasoningContentEvent` thinking,
 * `toolUseEvent` call fragments, and a `metadataEvent` with token usage and an
 * optional stop reason. Credit metering, context-usage percentages, citations,
 * and follow-up prompts have no native counterpart and are ignored.
 * @module @deepseek-ai/dsh-llm-kiro/stream
 */

import { z } from 'zod'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { EventStreamMessage } from './eventstream.ts'

const count = z.number().int().nonnegative()
const AssistantEvent = z.looseObject({ content: z.string().optional() })
const ReasoningEvent = z.looseObject({ text: z.string().optional(), signature: z.string().optional() })
const ToolUseEvent = z.looseObject({
  toolUseId: z.string().min(1).optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  stop: z.boolean().optional(),
})
const UsageFields = z.looseObject({
  uncachedInputTokens: count.optional(),
  outputTokens: count.optional(),
  totalTokens: count.optional(),
  cacheReadInputTokens: count.optional(),
  cacheWriteInputTokens: count.optional(),
})
// Accounting problems never fail a response whose content arrived intact.
const MetadataEvent = z.looseObject({
  tokenUsage: UsageFields.optional().catch(undefined),
  stopReason: z.string().optional().catch(undefined),
})
// An unreadable error body must not hide the failure it describes.
const ExceptionBody = z.looseObject({ message: z.string().optional(), reason: z.string().optional() }).catch({})

type ToolUse = z.output<typeof ToolUseEvent>
type Usage = z.output<typeof UsageFields>

// Wire strings key these tables, so Maps and Sets keep names such as `constructor` from reading prototype members.
/** Stop reasons that mean Kiro cut the response short at its output limit. */
const OUTPUT_LIMIT_STOP_REASONS: ReadonlySet<string> = new Set(['max_tokens', 'length'])

/** Stable codes of the exception types Kiro streams; any other type is a generic provider failure (`SERVER`). */
const EXCEPTION_CODES: ReadonlyMap<string, string> = new Map([
  ['ThrottlingException', 'RATE_LIMIT'],
  ['ServiceQuotaExceededException', QUOTA_EXCEEDED_CODE],
  ['AccessDeniedException', 'AUTH'],
  ['ExpiredTokenException', 'AUTH'],
  ['UnrecognizedClientException', 'AUTH'],
  ['ValidationException', 'INVALID_REQUEST'],
])

/** Kiro `reason` tags that name a condition more precisely than the exception type that carries them. */
const REASON_CODES: ReadonlyMap<string, string> = new Map([
  ['CONTENT_LENGTH_EXCEEDS_THRESHOLD', CONTEXT_WINDOW_EXCEEDED_CODE],
  ['MONTHLY_REQUEST_COUNT', QUOTA_EXCEEDED_CODE],
])

const textDecoder = new TextDecoder()

function malformed(detail: string): never {
  throw new LlmError(`Kiro stream ${detail}`, 'MALFORMED_RESPONSE')
}

function headerString(message: EventStreamMessage, name: string): string | undefined {
  const value = message.headers[name]
  return typeof value === 'string' ? value : undefined
}

function payloadOf(message: EventStreamMessage): unknown {
  const text = textDecoder.decode(message.payload)
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new LlmError('Kiro stream sent a non-JSON event payload', 'MALFORMED_RESPONSE', { cause })
  }
}

function decode<Schema extends z.ZodType>(schema: Schema, payload: unknown, event: string): z.output<Schema> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) malformed(`${event} has an invalid payload`)
  return parsed.data
}

/**
 * Convert an in-band exception or error frame into the failure it reports. The
 * stable code comes from the structured `reason` tag, then the exception type;
 * the message is display text and never selects a code.
 */
function exceptionError(message: EventStreamMessage, payload: unknown): LlmError {
  const body = ExceptionBody.parse(payload)
  const kind = headerString(message, ':exception-type') ?? headerString(message, ':error-code') ?? 'error'
  const detail = body.message ?? headerString(message, ':error-message') ?? 'no message'
  const reason = body.reason ?? ''
  const code = REASON_CODES.get(reason) ?? EXCEPTION_CODES.get(kind) ?? 'SERVER'
  return new LlmError(`Kiro stream ${kind}: ${detail}${reason === '' ? '' : ` (${reason})`}`, code)
}

function nativeUsage(usage: Usage): TokenUsage {
  const inputTokens = usage.uncachedInputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const { cacheReadInputTokens: cacheReadTokens, cacheWriteInputTokens: cacheWriteTokens } = usage
  const summed = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  return {
    inputTokens,
    outputTokens,
    // A reported total below its own components is inconsistent; the components are authoritative.
    totalTokens: Math.max(usage.totalTokens ?? 0, summed),
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
  }
}

interface OpenText {
  kind: 'text' | 'reasoning'
  index: number
  text: string
}

interface OpenTool {
  kind: 'tool'
  index: number
  id: ToolCallId
  name: string
  /** Raw argument JSON accumulated from fragments. */
  json: string
}

/** Kiro streams one block at a time: a different kind of event closes the open block. */
type OpenBlock = OpenText | OpenTool

/** The delta that announces a call; it carries the name once Kiro has supplied it. */
function toolStart(tool: OpenTool): StreamChunk {
  return {
    type: 'tool-call-delta',
    index: tool.index,
    id: tool.id,
    ...tool.name === '' ? {} : { name: tool.name },
    argumentsDelta: '',
  }
}

/**
 * The closed call with its raw argument JSON. A call the stop reason cut short
 * skips validation: the finish reason tells consumers it is unsafe to run.
 */
function toolCall(tool: OpenTool, validate: boolean): ToolCallBlock {
  const raw = tool.json === '' ? '{}' : tool.json
  if (validate) {
    if (tool.name === '') malformed('returned a tool call without a name')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new LlmError(`Kiro returned malformed arguments for tool "${tool.name}"`, 'MALFORMED_RESPONSE', { cause })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      malformed(`returned non-object arguments for tool "${tool.name}"`)
    }
  }
  return { type: 'tool-call', id: tool.id, name: tool.name, arguments: raw }
}

function isOpenText(block: OpenBlock | undefined, kind: OpenText['kind']): block is OpenText {
  return block?.kind === kind
}

class EventTranslator {
  #open: OpenBlock | undefined
  #blocks = 0
  #toolCalls = 0
  #usage: Usage | undefined
  #stopReason: string | undefined

  handle(message: EventStreamMessage): StreamChunk[] {
    const messageType = headerString(message, ':message-type')
    const payload = payloadOf(message)
    if (messageType === 'exception' || messageType === 'error') throw exceptionError(message, payload)
    switch (headerString(message, ':event-type')) {
      case 'assistantResponseEvent': {
        const { content } = decode(AssistantEvent, payload, 'assistantResponseEvent')
        return content ? this.#delta('text', content) : []
      }
      case 'reasoningContentEvent': {
        const { text, signature } = decode(ReasoningEvent, payload, 'reasoningContentEvent')
        const chunks = text ? this.#delta('reasoning', text) : []
        // The signature is the last event of a thinking block.
        if (signature && this.#open?.kind === 'reasoning') chunks.push(...this.#close(true))
        return chunks
      }
      case 'toolUseEvent': return this.#toolUse(decode(ToolUseEvent, payload, 'toolUseEvent'))
      case 'metadataEvent': {
        const { tokenUsage, stopReason } = decode(MetadataEvent, payload, 'metadataEvent')
        if (tokenUsage !== undefined) this.#usage = { ...this.#usage, ...tokenUsage }
        if (stopReason !== undefined) this.#stopReason = stopReason
        return []
      }
      default: return []
    }
  }

  /**
   * Close the stream: flush the open block, then usage, then exactly one finish.
   * @returns the final chunks, with usage before finish.
   * @throws {LlmError} `EMPTY_RESPONSE` when the response completed without content.
   */
  finish(): StreamChunk[] {
    const truncated = this.#stopReason !== undefined && OUTPUT_LIMIT_STOP_REASONS.has(this.#stopReason.toLowerCase())
    const chunks = this.#close(!truncated)
    const reason: FinishReason = truncated
      ? { kind: 'max-tokens' }
      : this.#toolCalls > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }
    if (this.#blocks === 0 && reason.kind === 'stop') throw new LlmError('Kiro returned no content', EMPTY_RESPONSE_CODE)
    if (this.#usage !== undefined) chunks.push({ type: 'usage', usage: nativeUsage(this.#usage) })
    chunks.push({ type: 'finish', reason })
    return chunks
  }

  #delta(kind: OpenText['kind'], text: string): StreamChunk[] {
    const chunks: StreamChunk[] = []
    let block = this.#open
    if (!isOpenText(block, kind)) {
      chunks.push(...this.#close(true))
      block = { kind, index: this.#blocks++, text: '' }
      this.#open = block
      chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    }
    block.text += text
    chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text })
    return chunks
  }

  #toolUse(event: ToolUse): StreamChunk[] {
    const chunks: StreamChunk[] = []
    let open = this.#open
    if (event.toolUseId !== undefined && !(open?.kind === 'tool' && open.id === event.toolUseId)) {
      chunks.push(...this.#close(true))
      open = { kind: 'tool', index: this.#blocks++, id: ToolCallId(event.toolUseId), name: event.name ?? '', json: '' }
      this.#open = open
      this.#toolCalls += 1
      chunks.push({ type: 'block-start', index: open.index, blockType: 'tool-call' }, toolStart(open))
    } else if (open?.kind === 'tool' && open.name === '' && event.name) {
      open.name = event.name
      chunks.push(toolStart(open))
    }
    // Fragments and stop markers continue the open call; without one they have nothing to extend.
    if (open?.kind !== 'tool') return chunks
    if (event.input !== undefined) {
      const fragment = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
      // Kiro opens a call with an empty or `{}` placeholder before the argument fragments arrive.
      if (fragment !== '' && (fragment !== '{}' || open.json !== '')) {
        open.json += fragment
        chunks.push({ type: 'tool-call-delta', index: open.index, id: open.id, argumentsDelta: fragment })
      }
    }
    if (event.stop === true) chunks.push(...this.#close(true))
    return chunks
  }

  /**
   * End the open block.
   * @param validate - require a tool call's arguments to be a JSON object; false for a call the stop reason cut short.
   * @returns the `block-end` chunk, or nothing when no block is open.
   */
  #close(validate: boolean): StreamChunk[] {
    const open = this.#open
    if (open === undefined) return []
    this.#open = undefined
    const block: ContentBlock = open.kind === 'tool' ? toolCall(open, validate) : { type: open.kind, text: open.text }
    return [{ type: 'block-end', index: open.index, block }]
  }
}

/**
 * Translate decoded Kiro events into native chunks: first-seen block indexes,
 * raw JSON tool-argument fragments, one `usage` when Kiro reported tokens, and
 * exactly one terminal `finish`; nothing follows it.
 * @param messages - checksum-verified event-stream messages in arrival order.
 * @returns the chunks.
 * @throws {LlmError} `MALFORMED_RESPONSE` for invalid payloads or tool arguments, `EMPTY_RESPONSE` for a response
 *   without content, and a classified failure code for an in-band exception frame.
 */
export async function* translate(messages: AsyncIterable<EventStreamMessage>): AsyncGenerator<StreamChunk> {
  const translator = new EventTranslator()
  for await (const message of messages) yield* translator.handle(message)
  yield* translator.finish()
}
