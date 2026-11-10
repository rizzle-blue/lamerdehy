/**
 * Serialization of native requests into Kiro `generateAssistantResponse` bodies.
 * Adapted from omp-kiro-provider (MIT, see ../LICENSE).
 *
 * Kiro enforces conversation invariants and answers a violation with
 * `400 Improperly formed request` or `TOOL_USE_RESULT_MISMATCH`: history starts
 * and ends with a user turn, roles alternate, every assistant tool use is
 * answered by a result in the next user turn, no result lacks its tool use,
 * tool-use ids are unique, and every user turn has content or tool results. The
 * builder normalizes history into that shape instead of hoping the transcript
 * fits. Kiro accepts no system role, sampling controls, or reasoning replay, so
 * the system prompt joins the first user turn and reasoning blocks stay out of
 * history.
 * @module @deepseek-ai/dsh-llm-kiro/request
 */

import { createHash } from 'node:crypto'
import { LlmError, offloadedImageText, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, ReasoningEffortId, RequestMessage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentId, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { KiroModel } from './catalog.ts'

const ORIGIN = 'KIRO_CLI'
const EMPTY_TURN_PLACEHOLDER = 'Please proceed with the task.'
const INTERRUPTED_RESULT = 'Tool use was interrupted and did not produce a result.'
const EMPTY_RESULT = '(no output)'
const UNAVAILABLE_TOOL = 'Tool no longer available.'
/** Kiro rejects larger tool results; the head and tail stay around a marker. */
const MAX_TOOL_RESULT_CHARS = 250_000
const TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/

interface KiroImage {
  format: string
  source: { bytes: string }
}

interface KiroToolResult {
  toolUseId: string
  content: { text: string }[]
  status: 'success' | 'error'
}

interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } }
}

interface KiroUserInput {
  content: string
  modelId: string
  origin: typeof ORIGIN
  images?: KiroImage[]
  userInputMessageContext?: { tools?: KiroToolSpec[]; toolResults?: KiroToolResult[] }
}

type KiroReasoningFields =
  | { reasoning: { effort: string } }
  | { output_config: { effort: string }; thinking: { type: 'adaptive'; display?: 'summarized' } }

type KiroHistoryMessage =
  | { userInputMessage: KiroUserInput }
  | { assistantResponseMessage: { content: string; toolUses?: KiroToolUse[] } }

/** The `generateAssistantResponse` request body. */
export interface KiroChatRequest {
  conversationState: {
    chatTriggerType: 'MANUAL'
    agentTaskType: 'vibe'
    conversationId: string
    history?: KiroHistoryMessage[]
    currentMessage: { userInputMessage: KiroUserInput }
  }
  profileArn: string
  agentMode: 'vibe'
  additionalModelRequestFields?: KiroReasoningFields
}

/** Everything the serializer needs beyond the routed request. */
export interface KiroRequestInput {
  /** The routed request; {@link assertSupportedOptions} has already accepted it. */
  readonly options: GenerateOptions<string>
  /** Account catalog entry for `options.model`; absent when the account does not list it. */
  readonly model: KiroModel | undefined
  /** Kiro profile the request bills against. */
  readonly profileArn: string
  /** Kiro conversation identity. */
  readonly conversationId: string
  /** Request versions of the images {@link currentImages} selected, by attachment id. */
  readonly images: ReadonlyMap<AttachmentId, RequestImageAttachment>
  /** Current execution-world access to normalized images for model-visible handles. */
  readonly access: ImageAttachmentAccessResolver
}

interface UserTurn {
  role: 'user'
  text: string[]
  images: KiroImage[]
  toolResults: KiroToolResult[]
}

interface AssistantTurn {
  role: 'assistant'
  text: string[]
  toolUses: KiroToolUse[]
}

type Turn = UserTurn | AssistantTurn

function unsupported(detail: string): never {
  throw new LlmError(`Kiro cannot represent ${detail}`, 'UNSUPPORTED_CONTENT')
}

function refuse(option: string): never {
  throw new LlmError(`Kiro does not support ${option}`, 'UNSUPPORTED_OPTION')
}

/**
 * Refuse request fields Kiro cannot honor, before any network work.
 * @param options - the routed request.
 * @throws {LlmError} `UNSUPPORTED_OPTION` for sampling controls, a token limit, stop sequences, or deferred tool declarations.
 */
export function assertSupportedOptions(options: GenerateOptions<string>): void {
  if (options.temperature !== undefined) refuse('GenerateOptions.temperature')
  if (options.maxTokens !== undefined) refuse('GenerateOptions.maxTokens')
  if (options.stop !== undefined) refuse('GenerateOptions.stop')
  if (options.tools?.some(tool => tool.deferLoading === true)) refuse('deferred tool declarations (ToolSchema.deferLoading)')
}

/**
 * Kiro tool-use ids must match `[a-zA-Z0-9_.:-]{1,64}`; other providers' ids
 * are mapped to a deterministic replacement.
 * @param id - the id the history carries.
 * @returns `id` when Kiro accepts it, otherwise a stable hash-derived id.
 */
export function kiroToolUseId(id: string): string {
  if (TOOL_USE_ID_PATTERN.test(id)) return id
  return `t_${createHash('sha256').update(id).digest('base64url').slice(0, 40)}`
}

/** A message ends an assistant turn when it says something Kiro can replay. */
function producesAssistantTurn(message: RequestMessage): boolean {
  return message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' || (block.type === 'text' && block.text.trim() !== ''))
}

/** Index of the first message after the last assistant turn; those messages form the one final user turn. */
function currentRunStart(messages: readonly RequestMessage[]): number {
  return messages.findLastIndex(producesAssistantTurn) + 1
}

/**
 * Select the images whose bytes the request carries. Kiro accepts image bytes
 * only on the final user turn's own content; every other occurrence is sent as
 * the omitted-image text.
 * @param messages - the routed request's messages.
 * @returns the distinct, non-offloaded images of the trailing user messages, in order.
 */
export function currentImages(messages: readonly RequestMessage[]): ImageAttachmentRef[] {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of messages.slice(currentRunStart(messages))) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  return [...refs.values()]
}

function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const half = MAX_TOOL_RESULT_CHARS / 2
  return `${text.slice(0, half)}\n[TRUNCATED ${text.length - MAX_TOOL_RESULT_CHARS} characters]\n${text.slice(-half)}`
}

/** Historical arguments Kiro cannot represent use empty input; the durable call is unchanged. */
function toolInput(raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (_invalidHistoricalJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function emptyUser(text: string[]): UserTurn {
  return { role: 'user', text, images: [], toolResults: [] }
}

interface Conversion {
  readonly images: ReadonlyMap<AttachmentId, RequestImageAttachment>
  readonly access: ImageAttachmentAccessResolver
  readonly currentFrom: number
}

/** Append one user or tool-result block's text to `parts`, and its bytes to `images` when this occurrence carries them. */
function userBlocks(
  blocks: readonly ContentBlock[], carriesImages: boolean, conversion: Conversion, parts: string[], images: KiroImage[],
): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push(block.text)
    } else if (block.type === 'image') {
      const { attachment } = block
      if (!carriesImages || block.offloaded === true) {
        parts.push(offloadedImageText(attachment, conversion.access(attachment)))
        continue
      }
      const version = conversion.images.get(attachment.attachmentId)
      if (version === undefined) throw new LlmError('Kiro request image was not prepared', 'INVALID_REQUEST')
      parts.push(requestImageHandleText(attachment, version, conversion.access(attachment)))
      images.push({ format: version.mediaType.slice('image/'.length), source: { bytes: Buffer.from(version.data).toString('base64') } })
    } else {
      unsupported(`${block.type} content in a user or tool-result message`)
    }
  }
}

function assistantTurn(blocks: readonly ContentBlock[]): AssistantTurn | undefined {
  const turn: AssistantTurn = { role: 'assistant', text: [], toolUses: [] }
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.trim() !== '') turn.text.push(block.text)
        break
      // Kiro accepts no reasoning in history.
      case 'reasoning': break
      case 'tool-call':
        turn.toolUses.push({ toolUseId: kiroToolUseId(block.id), name: block.name, input: toolInput(block.arguments) })
        break
      default: unsupported(`${block.type} content in an assistant message`)
    }
  }
  return turn.text.length > 0 || turn.toolUses.length > 0 ? turn : undefined
}

/** Convert one conversation message; assistant messages Kiro cannot replay yield nothing. */
function turnFrom(message: RequestMessage, index: number, conversion: Conversion): Turn | undefined {
  if (message.role === 'assistant') return assistantTurn(message.content)
  if (message.role === 'tool') {
    const parts: string[] = []
    userBlocks(message.content, false, conversion, parts, [])
    return {
      ...emptyUser([]),
      toolResults: [{
        toolUseId: kiroToolUseId(message.toolCallId),
        content: [{ text: truncateToolResult(parts.join('\n') || EMPTY_RESULT) }],
        status: message.isError === true ? 'error' : 'success',
      }],
    }
  }
  if (message.role === 'user') {
    const turn = emptyUser([])
    userBlocks(message.content, index >= conversion.currentFrom, conversion, turn.text, turn.images)
    return turn
  }
  return unsupported(`a ${message.role} message after the system prompt`)
}

/** Merge same-role neighbours so roles alternate. */
function mergeTurns(messages: readonly RequestMessage[], start: number, conversion: Conversion): Turn[] {
  const turns: Turn[] = []
  for (const [index, message] of messages.entries()) {
    if (index < start) continue
    const turn = turnFrom(message, index, conversion)
    if (turn === undefined) continue
    const previous = turns.at(-1)
    if (previous?.role === 'user' && turn.role === 'user') {
      previous.text.push(...turn.text)
      previous.images.push(...turn.images)
      previous.toolResults.push(...turn.toolResults)
    } else if (previous?.role === 'assistant' && turn.role === 'assistant') {
      previous.text.push(...turn.text)
      previous.toolUses.push(...turn.toolUses)
    } else {
      turns.push(turn)
    }
  }
  return turns
}

/**
 * Kiro rejects a conversation that reuses a tool-use id. Providers that mint
 * per-response ids (`call_0`) reuse them across turns, so a repeated id gets a
 * deterministic replacement and the following user turn's results are
 * re-pointed in order, keeping each pair together.
 */
function dedupeToolUseIds(turns: Turn[]): void {
  const seen = new Set<string>()
  for (const [index, turn] of turns.entries()) {
    if (turn.role !== 'assistant') continue
    const assigned = new Map<string, string[]>()
    for (const use of turn.toolUses) {
      let id = use.toolUseId
      for (let attempt = 1; seen.has(id); attempt += 1) id = kiroToolUseId(`${use.toolUseId}#${index}.${attempt}`)
      seen.add(id)
      assigned.set(use.toolUseId, [...assigned.get(use.toolUseId) ?? [], id])
      use.toolUseId = id
    }
    const next = turns[index + 1]
    if (next?.role === 'user') {
      for (const result of next.toolResults) {
        const id = assigned.get(result.toolUseId)?.shift()
        if (id !== undefined) result.toolUseId = id
      }
    }
  }
}

/**
 * Give each user turn exactly one result per tool use of the assistant turn
 * before it, in order, and nothing else. A missing result becomes an explicit
 * interrupted-tool error; a result with no matching use is not sent.
 */
function pairToolResults(turns: Turn[]): void {
  for (const [index, turn] of turns.entries()) {
    if (turn.role !== 'user') continue
    const previous = turns[index - 1]
    const uses = previous?.role === 'assistant' ? previous.toolUses : []
    const byId = new Map(turn.toolResults.map(result => [result.toolUseId, result] as const))
    turn.toolResults = uses.map(use => byId.get(use.toolUseId) ?? {
      toolUseId: use.toolUseId,
      content: [{ text: INTERRUPTED_RESULT }],
      status: 'error',
    })
  }
}

function userContent(turn: UserTurn): string {
  const content = turn.text.join('\n\n')
  return content === '' && turn.toolResults.length === 0 ? EMPTY_TURN_PLACEHOLDER : content
}

function inputContext(tools: readonly KiroToolSpec[], toolResults: readonly KiroToolResult[]): Pick<KiroUserInput, 'userInputMessageContext'> {
  const context = {
    ...tools.length > 0 ? { tools: [...tools] } : {},
    ...toolResults.length > 0 ? { toolResults: [...toolResults] } : {},
  }
  return Object.keys(context).length > 0 ? { userInputMessageContext: context } : {}
}

function toolSpecs(tools: readonly ToolSchema[] | undefined, turns: readonly Turn[]): KiroToolSpec[] {
  const specs: KiroToolSpec[] = (tools ?? []).map(tool => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description === '' ? tool.name : tool.description,
      inputSchema: { json: tool.parameters },
    },
  }))
  // Kiro rejects history that names a tool the request does not declare.
  const declared = new Set(specs.map(spec => spec.toolSpecification.name))
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue
    for (const use of turn.toolUses) {
      if (declared.has(use.name)) continue
      declared.add(use.name)
      specs.push({
        toolSpecification: { name: use.name, description: UNAVAILABLE_TOOL, inputSchema: { json: { type: 'object', properties: {} } } },
      })
    }
  }
  return specs
}

function reasoningFields(
  effort: ReasoningEffortId | undefined, model: KiroModel | undefined, modelId: string,
): KiroReasoningFields | undefined {
  if (effort === undefined) return undefined
  const reasoning = model?.reasoning
  if (reasoning === undefined || !reasoning.efforts.includes(effort)) {
    throw new LlmError(`Kiro model "${modelId}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  if (reasoning.mode === 'effort') return { reasoning: { effort } }
  return {
    output_config: { effort },
    thinking: { type: 'adaptive', ...reasoning.summarizedDisplay ? { display: 'summarized' as const } : {} },
  }
}

/**
 * Build the `generateAssistantResponse` body for one request.
 *
 * The system prompt (`options.system` and the leading system messages) opens
 * the first user turn. Consecutive same-role messages merge, a placeholder user
 * turn fills a missing first or last user turn, tool-use ids are made valid and
 * unique, and every tool use gets its result (or an interrupted-tool error).
 * Tool declarations travel on the final turn and also cover tools the history
 * names. Only the final user turn carries image bytes; other images, and every
 * tool-result image, become the omitted-image text. A reasoning effort maps to
 * the field family the account catalog advertises for the model.
 * @param input - the request, its catalog entry, and prepared images.
 * @returns the JSON-serializable request body.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for content Kiro cannot carry, `INVALID_REQUEST` for an unprepared image, and
 *   `UNSUPPORTED_REASONING_EFFORT` when the model does not advertise the requested effort.
 */
export function buildKiroRequest(input: KiroRequestInput): KiroChatRequest {
  const { options, model, profileArn, conversationId } = input
  const conversion: Conversion = { images: input.images, access: input.access, currentFrom: currentRunStart(options.messages) }
  const system: string[] = options.system === undefined ? [] : [options.system]
  let start = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    system.push(message.content.map(block => block.type === 'text' ? block.text : unsupported('non-text system content')).join(''))
    start += 1
  }
  const turns = mergeTurns(options.messages, start, conversion)
  const head = turns[0]
  const first = head?.role === 'user' ? head : emptyUser([EMPTY_TURN_PLACEHOLDER])
  if (first !== head) turns.unshift(first)
  const tail = turns.at(-1)
  const current = tail?.role === 'user' ? tail : emptyUser([])
  if (current !== tail) turns.push(current)
  dedupeToolUseIds(turns)
  pairToolResults(turns)
  const prompt = system.filter(part => part.trim() !== '').join('\n\n')
  if (prompt !== '') first.text.unshift(prompt)

  const modelId = options.model
  const userInput = (turn: UserTurn, tools: readonly KiroToolSpec[]): KiroUserInput => ({
    content: userContent(turn),
    modelId,
    origin: ORIGIN,
    ...turn.images.length > 0 ? { images: turn.images } : {},
    ...inputContext(tools, turn.toolResults),
  })
  const history = turns.slice(0, -1).map((turn): KiroHistoryMessage => turn.role === 'assistant'
    ? {
      assistantResponseMessage: {
        content: turn.text.join('\n\n'),
        ...turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {},
      },
    }
    : { userInputMessage: userInput(turn, []) })
  const fields = reasoningFields(options.reasoningEffort, model, modelId)
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      agentTaskType: 'vibe',
      conversationId,
      ...history.length > 0 ? { history } : {},
      currentMessage: { userInputMessage: userInput(current, toolSpecs(options.tools, turns)) },
    },
    profileArn,
    agentMode: 'vibe',
    ...fields === undefined ? {} : { additionalModelRequestFields: fields },
  }
}
