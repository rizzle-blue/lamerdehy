import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KiroAccess } from '../src/auth.ts'
import { listModels, resolveProfile } from '../src/catalog.ts'
import { BUILDER_ID_PROFILE_ARN, KIRO_USER_AGENT } from '../src/endpoints.ts'
import { KiroHttpError } from '../src/http.ts'
import { config, failureOf, hangingFetch, json, PROFILE_ARN, recorder, runtimeOf } from './wire.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const ACCESS: KiroAccess = { token: 'tok-1', region: 'us-east-1', profileArn: PROFILE_ARN }

const claude = {
  modelId: 'claude-sonnet-4.6',
  displayName: 'Claude Sonnet 4.6',
  supportedInputTypes: ['TEXT', 'IMAGE'],
  tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
  additionalModelRequestFieldsSchema: {
    properties: {
      output_config: { properties: { effort: { enum: ['low', 'medium', 'high', 'max'] } } },
      thinking: { properties: { display: { enum: ['summarized', 'omitted'] } } },
    },
  },
}
const gpt = {
  modelId: 'gpt-5.6-sol',
  modelName: 'GPT 5.6 Sol',
  // Kiro may send the schema as JSON text; `ultra` is not on the effort ladder.
  additionalModelRequestFieldsSchema: JSON.stringify({
    properties: { reasoning: { properties: { effort: { enum: ['low', 'high', 'ultra'] } } } },
  }),
}
const plain = { modelId: 'minimax-m2.5' }

describe('listModels', () => {
  it('lists the account catalog from the profile\'s region, scoped to the profile, with reasoning metadata', async () => {
    const { fetch, calls } = recorder(() => json(200, { models: [claude, gpt, plain] }))

    const models = await listModels(ACCESS, config, undefined, runtimeOf(fetch))

    const [call] = calls
    const url = new URL(call?.url ?? '')
    // The credential says us-east-1, the profile says eu-central-1, and the profile decides.
    expect(url.origin + url.pathname).toBe('https://management.eu-central-1.kiro.dev/List-Available-Models')
    expect(Object.fromEntries(url.searchParams)).toEqual({ origin: 'KIRO_CLI', profileArn: PROFILE_ARN })
    expect(call?.init.method).toBe('GET')
    expect(call?.headers).toEqual({ accept: 'application/json', authorization: 'Bearer tok-1', 'user-agent': KIRO_USER_AGENT })
    expect(models).toEqual([
      {
        id: 'claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        inputModalities: ['text', 'image'],
        reasoning: { mode: 'adaptive', efforts: ['low', 'medium', 'high', 'max'], summarizedDisplay: true },
      },
      {
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        contextWindow: 200_000,
        maxTokens: 8_192,
        inputModalities: ['text'],
        reasoning: { mode: 'effort', efforts: ['low', 'high'], summarizedDisplay: false },
      },
      { id: 'minimax-m2.5', name: 'minimax-m2.5', contextWindow: 200_000, maxTokens: 8_192, inputModalities: ['text'] },
    ])
    expect(models[2]).not.toHaveProperty('reasoning')
  })

  it('follows every page and keeps the first entry of a model repeated across pages', async () => {
    const pages = [
      json(200, { models: [claude, plain], nextToken: 'page-2' }),
      json(200, { models: [{ ...plain, displayName: 'Repeated' }, gpt] }),
    ]
    const { fetch, calls } = recorder((_call, index) => pages[index] ?? json(500, {}))

    const models = await listModels(ACCESS, config, undefined, runtimeOf(fetch))

    expect(models.map(model => [model.id, model.name])).toEqual([
      ['claude-sonnet-4.6', 'Claude Sonnet 4.6'],
      ['minimax-m2.5', 'minimax-m2.5'],
      ['gpt-5.6-sol', 'GPT 5.6 Sol'],
    ])
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0]?.url ?? '').searchParams.has('nextToken')).toBe(false)
    expect(new URL(calls[1]?.url ?? '').searchParams.get('nextToken')).toBe('page-2')
  })

  it('reads a request region from the credential when the profile ARN names none', async () => {
    const { fetch, calls } = recorder(() => json(200, { models: [plain] }))

    await listModels({ ...ACCESS, profileArn: 'not-an-arn' }, config, undefined, runtimeOf(fetch))

    expect(new URL(calls[0]?.url ?? '').host).toBe('management.us-east-1.kiro.dev')
  })

  it('names a model by display name, then model name, then id, and tolerates members sent as null', async () => {
    const { fetch } = recorder(() => json(200, {
      models: [
        { modelId: 'a', displayName: null, modelName: null, supportedInputTypes: null, tokenLimits: null },
        { modelId: 'b', modelName: 'B model', tokenLimits: { maxInputTokens: null, maxOutputTokens: 4096 } },
      ],
    }))

    const models = await listModels(ACCESS, config, undefined, runtimeOf(fetch))

    expect(models).toEqual([
      { id: 'a', name: 'a', contextWindow: 200_000, maxTokens: 8_192, inputModalities: ['text'] },
      { id: 'b', name: 'B model', contextWindow: 200_000, maxTokens: 4096, inputModalities: ['text'] },
    ])
  })

  it('derives reasoning only from efforts the ladder knows, in ladder order', async () => {
    const withSchema = (modelId: string, additionalModelRequestFieldsSchema: unknown): object => ({
      modelId,
      additionalModelRequestFieldsSchema,
    })
    const { fetch } = recorder(() => json(200, {
      models: [
        withSchema('ladder', {
          properties: {
            reasoning: { properties: { effort: { enum: ['max', 'minimal', 'xhigh', 'high', 'medium', 'low'] } } },
            // `display` belongs to adaptive models only.
            thinking: { properties: { display: { enum: ['summarized'] } } },
          },
        }),
        withSchema('adaptive-without-display', { properties: { output_config: { properties: { effort: { enum: ['high'] } } } } }),
        withSchema('unknown-efforts', { properties: { reasoning: { properties: { effort: { enum: ['ultra'] } } } } }),
        withSchema('unreadable-text', '{not json'),
        withSchema('non-string-efforts', { properties: { reasoning: { properties: { effort: { enum: [1, 2] } } } } }),
        withSchema('null-in-path', { properties: null }),
        withSchema('enum-not-a-list', { properties: { reasoning: { properties: { effort: { enum: 'low' } } } } }),
      ],
    }))

    const models = await listModels(ACCESS, config, undefined, runtimeOf(fetch))

    const byId = new Map(models.map(model => [model.id, model.reasoning] as const))
    expect(byId.get('ladder')).toEqual({
      mode: 'effort',
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      summarizedDisplay: false,
    })
    expect(byId.get('adaptive-without-display')).toEqual({ mode: 'adaptive', efforts: ['high'], summarizedDisplay: false })
    for (const id of ['unknown-efforts', 'unreadable-text', 'non-string-efforts', 'null-in-path', 'enum-not-a-list']) {
      expect(byId.get(id)).toBeUndefined()
    }
  })

  it('refuses a catalog that lists no model, so an empty success cannot erase a working one', async () => {
    for (const body of [{ models: [] }, {}]) {
      const { fetch } = recorder(() => json(200, body))

      const error = await failureOf(listModels(ACCESS, config, undefined, runtimeOf(fetch)))

      expect(error.code).toBe('INVALID_RESPONSE')
    }
  })

  it('rejects a malformed page without quoting it', async () => {
    const { fetch } = recorder(() => json(200, { models: [{ modelName: 'secret-name' }] }))

    const error = await failureOf(listModels(ACCESS, config, undefined, runtimeOf(fetch)))

    expect(error.code).toBe('INVALID_RESPONSE')
    expect(error.message).not.toContain('secret-name')
  })

  it('reports a rejected token as an AUTH failure', async () => {
    const { fetch } = recorder(() => json(403, { message: 'The security token included in the request is expired' }))

    const error = await failureOf(listModels(ACCESS, config, undefined, runtimeOf(fetch)))

    expect(error).toBeInstanceOf(KiroHttpError)
    expect(error.code).toBe('AUTH')
  })

  it('stops following a listing that never ends', async () => {
    const { fetch, calls } = recorder(() => json(200, { models: [plain], nextToken: 'more' }))

    const error = await failureOf(listModels(ACCESS, config, undefined, runtimeOf(fetch)))

    expect(error.code).toBe('INVALID_RESPONSE')
    expect(calls).toHaveLength(100)
  })

  it('applies the configured request budget to each request and honors cancellation', async () => {
    vi.useFakeTimers()
    const slow = failureOf(listModels(ACCESS, { ...config, requestTimeoutMs: 50 }, undefined, runtimeOf(hangingFetch())))
    await vi.advanceTimersByTimeAsync(50)
    expect((await slow).code).toBe('TIMEOUT')
    vi.useRealTimers()

    const controller = new AbortController()
    controller.abort()
    const cancelled = await failureOf(listModels(ACCESS, config, controller.signal, runtimeOf(hangingFetch())))
    expect(cancelled.code).toBe('ABORTED')
  })
})

const IDC = { builderId: false }
const BUILDER_ID = { builderId: true }
const OTHER_ARN = 'arn:aws:codewhisperer:us-east-1:222222222222:profile/OTHER'

describe('resolveProfile', () => {
  it('takes the first profile with an ARN and serves it from the ARN\'s region', async () => {
    const { fetch, calls } = recorder(() => json(200, { profiles: [{ arn: null }, { arn: PROFILE_ARN }, { arn: OTHER_ARN }] }))

    await expect(resolveProfile('tok-1', 'us-east-1', config, IDC, runtimeOf(fetch)))
      .resolves.toEqual({ arn: PROFILE_ARN, region: 'eu-central-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://management.us-east-1.kiro.dev/List-Available-Profiles')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.body).toEqual({})
    expect(calls[0]?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer tok-1',
      'user-agent': KIRO_USER_AGENT,
    })
  })

  it('treats an Identity Center 403 as "no profile in this region" and keeps searching the API regions', async () => {
    const { fetch, calls } = recorder(call => call.url.includes('eu-central-1')
      ? json(200, { profiles: [{ arn: PROFILE_ARN }] })
      : json(403, { message: 'denied' }))

    await expect(resolveProfile('tok-1', 'ap-south-1', config, IDC, runtimeOf(fetch)))
      .resolves.toEqual({ arn: PROFILE_ARN, region: 'eu-central-1' })

    expect(calls.map(call => new URL(call.url).host)).toEqual([
      'management.ap-south-1.kiro.dev',
      'management.us-east-1.kiro.dev',
      'management.eu-central-1.kiro.dev',
    ])
  })

  it('stops an Identity Center search at any failure other than a 403', async () => {
    const { fetch, calls } = recorder(() => json(500, { message: 'down' }))

    const error = await failureOf(resolveProfile('tok-1', 'us-east-1', config, IDC, runtimeOf(fetch)))

    expect(error.code).toBe('SERVER')
    expect(calls).toHaveLength(1)
  })

  it('reports an Identity Center account with no profile in any region', async () => {
    const denied = recorder(() => json(403, { message: 'denied' }))

    const error = await failureOf(resolveProfile('tok-1', 'us-east-1', config, IDC, runtimeOf(denied.fetch)))

    expect(error.code).toBe('NO_PROFILE')
    expect(error.cause).toBeInstanceOf(KiroHttpError)
    expect(denied.calls).toHaveLength(2)

    const empty = recorder(() => json(200, { profiles: [{ arn: null }] }))
    const none = await failureOf(resolveProfile('tok-1', 'us-east-1', config, IDC, runtimeOf(empty.fetch)))
    expect(none.code).toBe('NO_PROFILE')
    expect(none.cause).toBeUndefined()
  })

  it('falls back to the public Builder ID profile after any HTTP failure', async () => {
    for (const status of [403, 500]) {
      const { fetch } = recorder(() => json(status, { message: 'no profile' }))

      await expect(resolveProfile('tok-1', 'us-east-1', config, BUILDER_ID, runtimeOf(fetch)))
        .resolves.toEqual({ arn: BUILDER_ID_PROFILE_ARN, region: 'us-east-1' })
    }
  })

  it('does not fall back on a network failure, a malformed region, or a cancellation', async () => {
    const offline = await failureOf(resolveProfile(
      'tok-1', 'us-east-1', config, BUILDER_ID, runtimeOf(() => Promise.reject(new TypeError('fetch failed'))),
    ))
    expect(offline.code).toBe('TRANSPORT')

    const { fetch, calls } = recorder(() => json(200, { profiles: [] }))
    const malformed = await failureOf(resolveProfile('tok-1', 'bad region', config, IDC, runtimeOf(fetch)))
    expect(malformed.code).toBe('INVALID_REGION')
    expect(calls).toHaveLength(0)

    const controller = new AbortController()
    controller.abort()
    const cancelled = await failureOf(resolveProfile(
      'tok-1', 'us-east-1', config, { builderId: true, signal: controller.signal }, runtimeOf(hangingFetch()),
    ))
    expect(cancelled.code).toBe('ABORTED')
  })
})

describe('default transport', () => {
  it('sends through the global fetch when no runtime is given', async () => {
    const stub = vi.fn((url: string) => Promise.resolve(url.includes('List-Available-Models')
      ? json(200, { models: [plain] })
      : json(200, { profiles: [{ arn: PROFILE_ARN }] })))
    vi.stubGlobal('fetch', stub)

    await expect(listModels(ACCESS, config)).resolves.toHaveLength(1)
    await expect(resolveProfile('tok-1', 'us-east-1', config, IDC)).resolves.toMatchObject({ arn: PROFILE_ARN })
    expect(stub).toHaveBeenCalledTimes(2)
  })
})
