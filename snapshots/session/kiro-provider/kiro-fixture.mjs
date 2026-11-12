/**
 * AWS stand-in for the `kiro-provider` scenario. The shipped `llm-kiro` adapter runs unmodified; this
 * plugin saves a synthetic Kiro grant through the credential seam and answers the adapter's requests
 * through `globalThis.fetch`: the account catalog, then a two-step `read` tool roundtrip delivered as
 * AWS EventStream bytes in awkward chunks. A request that departs from what the adapter must send
 * receives HTTP 400 `{ message, reason }`, and any other request to a Kiro or AWS host throws.
 *
 * Launch readiness: the headless runner creates its Agent only after `loader.await()` settles
 * (packages/bundle/headless/src/index.ts). That wait covers every entry's import and fiber lifecycle,
 * including the promise this async `apply` returns (vendor/loader/src/config/tree.ts,
 * vendor/cordis/src/fiber.ts). `apply` installs the fetch wrapper before its first await and saves the
 * grant only afterwards, so no request can carry the grant before the wrapper exists, and the first
 * model request finds both in place.
 */
import { isDeepStrictEqual } from 'node:util'
import { crc32 } from 'node:zlib'

/** Cordis plugin name. */
export const name = 'kiro-fixture'

/** The credential seam receives the synthetic grant. */
export const inject = ['credentials']

/** The profile ARN's region, not the grant's own region, selects the Kiro hosts. */
const PROFILE_REGION = 'eu-central-1'
const MANAGEMENT_HOST = `management.${PROFILE_REGION}.kiro.dev`
const RUNTIME_HOST = `runtime.${PROFILE_REGION}.kiro.dev`
const PROFILE_ARN = `arn:aws:codewhisperer:${PROFILE_REGION}:111111111111:profile/SNAPSHOTPROFILE`
const ACCESS_TOKEN = 'snapshot-kiro-access-token'
const MODEL_ID = 'claude-sonnet-4.6'
/** Equals the `reasoningEffort` of `runtime.cordis.yml`. */
const REASONING_EFFORT = 'high'
const TOOL_USE_ID = 'tooluse_k3Jx9QmWb2TnYhPz8sLd4A'
/** The file in `workspace/` and the single word it holds. */
const WORKSPACE_FILE = 'word.txt'
const WORKSPACE_WORD = 'kiro-snapshot'
const FIRST_STEP_TEXT = `I'll read ${WORKSPACE_FILE}.`

/** The grant the adapter reads; its expiry is far enough out that no refresh request can arise. */
const CREDENTIAL = {
  access: ACCESS_TOKEN,
  refresh: 'snapshot-kiro-refresh-token',
  expires: Date.UTC(2100, 0, 1),
  region: 'us-east-1',
  profileArn: PROFILE_ARN,
  clientId: 'snapshot-oidc-client',
  clientSecret: 'snapshot-oidc-secret',
  oidcRegion: 'us-east-1',
  startUrl: 'https://view.awsapps.com/start',
}

/** One Claude-style model with adaptive thinking, images, and token limits. */
const CATALOG = {
  models: [{
    modelId: MODEL_ID,
    displayName: 'Claude Sonnet 4.6',
    supportedInputTypes: ['TEXT', 'IMAGE'],
    tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
    additionalModelRequestFieldsSchema: {
      properties: {
        output_config: { properties: { effort: { enum: ['low', 'medium', 'high', 'max'] } } },
        thinking: { properties: { display: { enum: ['summarized', 'omitted'] } } },
      },
    },
  }],
}

/** Network chunk sizes in bytes; the first splits every response inside its first frame's prelude. */
const CHUNK_SIZES = [5, 11, 7, 3, 19, 2, 29, 13]

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fail the current request: the adapter sent something the scenario does not expect. */
function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function same(actual, expected, label) {
  ensure(isDeepStrictEqual(actual, expected), `${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function header(headerName, value) {
  const nameBytes = Buffer.from(headerName)
  const valueBytes = Buffer.from(value)
  const bytes = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  bytes.writeUInt8(nameBytes.length, 0)
  nameBytes.copy(bytes, 1)
  // Header value type 7 is a UTF-8 string with a big-endian u16 length.
  bytes.writeUInt8(7, 1 + nameBytes.length)
  bytes.writeUInt16BE(valueBytes.length, 2 + nameBytes.length)
  valueBytes.copy(bytes, 4 + nameBytes.length)
  return bytes
}

/** One `application/vnd.amazon.eventstream` message: prelude, headers, JSON payload, and both IEEE CRC32 checksums. */
function frame(eventType, payload) {
  const headers = Buffer.concat([
    header(':message-type', 'event'),
    header(':event-type', eventType),
    header(':content-type', 'application/json'),
  ])
  const body = Buffer.from(JSON.stringify(payload))
  const total = 12 + headers.length + body.length + 4
  const bytes = Buffer.alloc(total)
  bytes.writeUInt32BE(total, 0)
  bytes.writeUInt32BE(headers.length, 4)
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8)
  headers.copy(bytes, 12)
  body.copy(bytes, 12 + headers.length)
  bytes.writeUInt32BE(crc32(bytes.subarray(0, total - 4)), total - 4)
  return bytes
}

function eventStream(events) {
  const bytes = Buffer.concat(events.map(([eventType, payload]) => frame(eventType, payload)))
  const body = new ReadableStream({
    start(controller) {
      let offset = 0
      for (let index = 0; offset < bytes.length; index += 1) {
        const size = CHUNK_SIZES[index % CHUNK_SIZES.length]
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)))
        offset += size
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
}

/** Reasoning, one text block, and a `read` call whose arguments arrive split inside a key and a value. */
function firstStep() {
  const input = JSON.stringify({ file_path: WORKSPACE_FILE })
  const fragments = ['', input.slice(0, 7), input.slice(7, 16), input.slice(16)]
  return [
    ['reasoningContentEvent', { text: `The user wants the word stored in ${WORKSPACE_FILE}, ` }],
    ['reasoningContentEvent', { text: 'so I will read it with the read tool.' }],
    ['reasoningContentEvent', { signature: 'snapshot-thinking-signature-1' }],
    ['assistantResponseEvent', { content: FIRST_STEP_TEXT }],
    ...fragments.map(fragment => ['toolUseEvent', { name: 'read', toolUseId: TOOL_USE_ID, input: fragment }]),
    ['toolUseEvent', { name: 'read', toolUseId: TOOL_USE_ID, stop: true }],
    ['contextUsageEvent', { contextUsagePercentage: 0.27 }],
    ['metadataEvent', {
      tokenUsage: {
        uncachedInputTokens: 2704, outputTokens: 64, totalTokens: 2768, cacheReadInputTokens: 0, cacheWriteInputTokens: 0,
      },
    }],
    ['meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.0142 }],
  ]
}

/** Reasoning, then the word the tool result carried, split across two text events. */
function secondStep(word) {
  return [
    ['reasoningContentEvent', { text: 'The file holds a single word, ' }],
    ['reasoningContentEvent', { text: 'so I will reply with exactly that word.' }],
    ['reasoningContentEvent', { signature: 'snapshot-thinking-signature-2' }],
    ['assistantResponseEvent', { content: word.slice(0, 5) }],
    ['assistantResponseEvent', { content: word.slice(5) }],
    ['contextUsageEvent', { contextUsagePercentage: 0.31 }],
    ['metadataEvent', {
      tokenUsage: {
        uncachedInputTokens: 252, outputTokens: 31, totalTokens: 3083, cacheReadInputTokens: 2800, cacheWriteInputTokens: 0,
      },
    }],
    ['meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.0061 }],
  ]
}

function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (input instanceof Request) return new URL(input.url)
  } catch {
    // A relative or malformed URL is not a Kiro request.
  }
  return undefined
}

async function requestOf(url, input, init) {
  const wrapped = input instanceof Request ? input : undefined
  init?.signal?.throwIfAborted()
  return {
    url,
    method: (init?.method ?? wrapped?.method ?? 'GET').toUpperCase(),
    headers: new Headers(init?.headers ?? wrapped?.headers),
    redirect: init?.redirect ?? wrapped?.redirect,
    body: init?.body ?? (wrapped === undefined ? undefined : await wrapped.clone().text()),
  }
}

/** Kiro requests use the account bearer token and the Kiro client user agent. */
function checkIdentity(request) {
  same(request.headers.get('authorization'), `Bearer ${ACCESS_TOKEN}`, 'authorization')
  same(request.headers.get('user-agent'), 'omp-kiro-provider/0.2.0', 'user-agent')
  same(request.redirect, 'error', 'redirect')
}

function listModels(request) {
  ensure(
    request.method === 'GET' && request.url.pathname === '/List-Available-Models',
    `the management host serves only GET /List-Available-Models, got ${request.method} ${request.url.pathname}`,
  )
  checkIdentity(request)
  same(Object.fromEntries(request.url.searchParams), { origin: 'KIRO_CLI', profileArn: PROFILE_ARN }, 'catalog query')
  return json(200, CATALOG)
}

/** The fields every conversation request carries, and the pieces the step checks read. */
function checkConversation(body, remember) {
  ensure(isRecord(body), 'the request body must be a JSON object')
  same(body.profileArn, PROFILE_ARN, 'profileArn')
  const state = body.conversationState
  ensure(isRecord(state), 'conversationState is required')
  ensure(typeof state.conversationId === 'string' && state.conversationId !== '', 'conversationId is required')
  remember(state.conversationId)
  const current = state.currentMessage?.userInputMessage
  ensure(isRecord(current), 'currentMessage.userInputMessage is required')
  same(current.modelId, MODEL_ID, 'currentMessage modelId')
  same(
    body.additionalModelRequestFields,
    { output_config: { effort: REASONING_EFFORT }, thinking: { type: 'adaptive', display: 'summarized' } },
    'additionalModelRequestFields',
  )
  const tools = current.userInputMessageContext?.tools
  ensure(Array.isArray(tools), 'the current message must declare tools')
  const read = tools.find(tool => tool?.toolSpecification?.name === 'read')?.toolSpecification
  ensure(read !== undefined, 'the current message must declare the read tool')
  const schema = read.inputSchema?.json
  ensure(
    schema?.type === 'object' && schema.properties?.file_path?.type === 'string' && schema.required?.includes('file_path'),
    'the read tool must carry its JSON schema',
  )
  return { current, history: state.history }
}

function checkFirstStep({ current, history }) {
  ensure(current.userInputMessageContext.toolResults === undefined, 'the first request carries no tool results')
  const first = history?.[0]?.userInputMessage ?? current
  ensure(typeof first.content === 'string' && first.content.includes(WORKSPACE_FILE), 'the first user turn must carry the task')
}

/** Checks that the tool call and its result came back as Kiro history, and returns the word the result carried. */
function checkSecondStep({ current, history }) {
  ensure(Array.isArray(history) && history.length === 2, 'history must hold the user turn and the tool-use turn')
  const [user, assistant] = history
  ensure(user?.userInputMessage?.content?.includes(WORKSPACE_FILE) === true, 'history must open with the task')
  same(user.userInputMessage.modelId, MODEL_ID, 'history user modelId')
  same(
    assistant?.assistantResponseMessage,
    { content: FIRST_STEP_TEXT, toolUses: [{ toolUseId: TOOL_USE_ID, name: 'read', input: { file_path: WORKSPACE_FILE } }] },
    'assistant tool-use turn',
  )
  const results = current.userInputMessageContext.toolResults
  ensure(Array.isArray(results) && results.length === 1, 'the current message must carry exactly one tool result')
  same(results[0].toolUseId, TOOL_USE_ID, 'toolResults[0].toolUseId')
  same(results[0].status, 'success', 'toolResults[0].status')
  const text = results[0].content?.[0]?.text
  const word = typeof text === 'string' ? /^1: (.+)$/m.exec(text)?.[1] : undefined
  same(word, WORKSPACE_WORD, 'the word read from toolResults[0].content[0].text')
  return word
}

/** The fetch wrapper's behavior, over the fetch it replaces. */
function createAwsFetch(originalFetch) {
  let served = 0
  let conversationId

  const rememberConversation = (id) => {
    conversationId ??= id
    same(id, conversationId, 'conversationId')
  }

  function generateAssistantResponse(request) {
    ensure(
      request.method === 'POST' && request.url.pathname === '/generateAssistantResponse' && request.url.search === '',
      `the runtime host serves only POST /generateAssistantResponse, got ${request.method} ${request.url.pathname}`,
    )
    checkIdentity(request)
    same(request.headers.get('x-amzn-kiro-profile-arn'), PROFILE_ARN, 'x-amzn-kiro-profile-arn')
    same(request.headers.get('x-amzn-codewhisperer-optout'), 'true', 'x-amzn-codewhisperer-optout')
    same(request.headers.get('accept'), 'application/vnd.amazon.eventstream', 'accept')
    ensure(served < 2, 'the scripted roundtrip has two steps, and a third request arrived')
    ensure(typeof request.body === 'string', 'the request body must be a JSON string')
    const conversation = checkConversation(JSON.parse(request.body), rememberConversation)
    if (served === 0) {
      checkFirstStep(conversation)
      served = 1
      return eventStream(firstStep())
    }
    const word = checkSecondStep(conversation)
    served = 2
    return eventStream(secondStep(word))
  }

  /** A mismatch is a 400 the adapter reports in the turn's error, so a regression fails the scenario loudly. */
  function answer(handler, request) {
    try {
      return handler(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(400, { message: `kiro-fixture: ${message}`, reason: 'KIRO_FIXTURE_MISMATCH' })
    }
  }

  return async function fixtureFetch(input, init) {
    const url = urlOf(input)
    if (url === undefined) return originalFetch(input, init)
    const host = url.hostname.toLowerCase()
    if (host === MANAGEMENT_HOST) return answer(listModels, await requestOf(url, input, init))
    if (host === RUNTIME_HOST) return answer(generateAssistantResponse, await requestOf(url, input, init))
    if (/(^|\.)(kiro\.dev|amazonaws\.com)$/.test(host)) {
      throw new Error(`kiro-fixture: unexpected URL for recorded authority: ${url.href}`)
    }
    return originalFetch(input, init)
  }
}

/** Install the Kiro fetch wrapper, then save the grant through the credential seam. */
export async function apply(ctx) {
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    const fixtureFetch = createAwsFetch(originalFetch)
    globalThis.fetch = fixtureFetch
    return () => {
      if (globalThis.fetch !== fixtureFetch) {
        throw new Error('kiro-fixture: global fetch owner changed before cleanup')
      }
      globalThis.fetch = originalFetch
    }
  }, 'kiro-fixture: fetch')
  await ctx.credentials.modifyRecord('llm-kiro/kiro', () => Promise.resolve({ kind: 'grant', payload: CREDENTIAL }))
}
