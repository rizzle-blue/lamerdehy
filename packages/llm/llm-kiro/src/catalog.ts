/**
 * Kiro profile resolution and the account-scoped model catalog. A Kiro catalog
 * belongs to the signed-in account and its profile, so models are requested
 * with the profile ARN and are never a static list: a fixed list would
 * advertise models the account cannot use.
 *
 * Adapted from omp-kiro-provider (https://github.com/HoangNguyen17193/omp-kiro-provider),
 * MIT License, Copyright (c) 2026 tino; the notice is in ../LICENSE.
 *
 * @module dsh-llm-kiro/catalog
 */

import { z } from 'zod'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import type { KiroAccess } from './auth.ts'
import type { KiroConfig } from './config.ts'
import { BUILDER_ID_PROFILE_ARN, KIRO_DEFAULT_REGION, managementBaseUrl, profileRegion } from './endpoints.ts'
import { KiroHttpError, requestJson, systemRuntime } from './http.ts'
import type { KiroRuntime } from './http.ts'

/** Context capacity assumed for a model whose listing states none. */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** Output capability assumed for a model whose listing states none. */
const DEFAULT_MAX_TOKENS = 8_192

/** Most catalog pages one discovery follows; a listing that never ends is a failure, not a long catalog. */
const MAX_CATALOG_PAGES = 100

/** Reasoning efforts Kiro models can advertise, from least to greatest. */
export const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** How one Kiro model takes a reasoning effort, derived from the request fields it declares. */
export interface KiroReasoning {
  /**
   * `effort` sends `{ reasoning: { effort } }` in the request's additional fields. `adaptive` sends
   * `{ output_config: { effort }, thinking: { type: 'adaptive' } }`.
   */
  readonly mode: 'effort' | 'adaptive'
  /** The efforts the model accepts as wire values, from least to greatest in {@link EFFORT_LADDER} order; unknown values are dropped. */
  readonly efforts: readonly string[]
  /** Whether an `adaptive` model accepts `thinking.display: 'summarized'`; always false for `effort` models. */
  readonly summarizedDisplay: boolean
}

/** One model of the signed-in account's catalog. */
export interface KiroModel {
  /** Model id sent in conversation requests. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Maximum input tokens. */
  readonly contextWindow: number
  /** Maximum output tokens. */
  readonly maxTokens: number
  /** Accepted request modalities. */
  readonly inputModalities: readonly ModelModality[]
  /** Reasoning support; absent for a model that declares none. */
  readonly reasoning?: KiroReasoning
}

const ProfilesPage = z.looseObject({
  profiles: z.array(z.looseObject({ arn: z.string().nullish() })).default([]),
})

const ModelEntry = z.looseObject({
  modelId: z.string().min(1),
  modelName: z.string().nullish(),
  displayName: z.string().nullish(),
  supportedInputTypes: z.array(z.string()).nullish(),
  tokenLimits: z.looseObject({
    maxInputTokens: z.number().int().positive().nullish(),
    maxOutputTokens: z.number().int().positive().nullish(),
  }).nullish(),
  // Zod 4 requires an `unknown` member to be present unless it is declared optional.
  additionalModelRequestFieldsSchema: z.unknown().optional(),
})

const ModelsPage = z.looseObject({
  models: z.array(ModelEntry).default([]),
  nextToken: z.string().nullish(),
})

/** The profile a Kiro account's requests name, and where it is served. */
export interface ProfileResolution {
  /** Profile ARN that every Kiro request names. */
  readonly arn: string
  /** Region of the management and runtime hosts: the ARN's own region. */
  readonly region: string
}

/**
 * Find the account's Kiro profile. Profiles live in one of Kiro's API regions,
 * so the search tries the given region, then both API regions. For IAM
 * Identity Center a 403 means "no profile here" and any other HTTP failure
 * stops the search. AWS Builder ID accounts may have no listable profile, so
 * any HTTP failure there falls back to Kiro's public Builder ID placeholder.
 * @param token - bearer token of the signed-in account.
 * @param region - Kiro API region the search starts in.
 * @param config - request budget.
 * @param options - `builderId` selects the Builder ID fallback; `signal` cancels the search.
 * @param runtime - transport and clock.
 * @returns the profile ARN and the region it is served from.
 * @throws {LlmError} code `NO_PROFILE` when an Identity Center account has no profile in any region,
 *   or the failure of a request that is not an HTTP 403 answer.
 */
export async function resolveProfile(
  token: string,
  region: string,
  config: KiroConfig,
  options: { readonly builderId: boolean; readonly signal?: AbortSignal | undefined },
  runtime: KiroRuntime = systemRuntime,
): Promise<ProfileResolution> {
  const candidates = [...new Set([region, KIRO_DEFAULT_REGION, 'eu-central-1'])]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const { profiles } = await requestJson(runtime, {
        method: 'POST',
        url: `${managementBaseUrl(candidate)}/List-Available-Profiles`,
        headers: { authorization: `Bearer ${token}` },
        body: {},
        signal: options.signal,
        timeoutMs: config.requestTimeoutMs,
        label: 'Kiro profile discovery',
      }, ProfilesPage)
      const arn = profiles.find(profile => profile.arn)?.arn
      if (arn) return { arn, region: profileRegion(arn, candidate) }
    } catch (error) {
      if (!(error instanceof KiroHttpError) || (error.status !== 403 && !options.builderId)) throw error
      lastError = error
    }
  }
  if (options.builderId) return { arn: BUILDER_ID_PROFILE_ARN, region: KIRO_DEFAULT_REGION }
  throw new LlmError(
    'Kiro: no Kiro profile is available for this account. Ask your AWS administrator to assign you Kiro access,'
    + ' then sign in again.',
    'NO_PROFILE',
    { cause: lastError },
  )
}

/** The string members at `path` inside a JSON Schema document, when every member is a string. */
function enumAt(root: unknown, path: readonly string[]): string[] | undefined {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = Reflect.get(node, key)
  }
  if (!Array.isArray(node)) return undefined
  const values: unknown[] = node
  return values.every((value): value is string => typeof value === 'string') ? values : undefined
}

/** A JSON document, or undefined when the text is not one. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A schema Kiro sent as unreadable text declares no reasoning support.
    return undefined
  }
}

/**
 * Derive reasoning support from a model's `additionalModelRequestFieldsSchema`:
 * `reasoning.effort` models take `effort` mode and `output_config.effort`
 * models take `adaptive` mode. The schema may arrive as a JSON string.
 */
function reasoningOf(raw: unknown): KiroReasoning | undefined {
  const schema = typeof raw === 'string' ? parseJson(raw) : raw
  const effortEnum = enumAt(schema, ['properties', 'reasoning', 'properties', 'effort', 'enum'])
  const adaptiveEnum = enumAt(schema, ['properties', 'output_config', 'properties', 'effort', 'enum'])
  const wire = effortEnum ?? adaptiveEnum
  if (wire === undefined) return undefined
  const efforts = EFFORT_LADDER.filter(effort => wire.includes(effort))
  if (efforts.length === 0) return undefined
  const display = enumAt(schema, ['properties', 'thinking', 'properties', 'display', 'enum'])
  return {
    mode: effortEnum === undefined ? 'adaptive' : 'effort',
    efforts,
    summarizedDisplay: effortEnum === undefined && display?.includes('summarized') === true,
  }
}

/** One listed model in this package's vocabulary. */
function toKiroModel(entry: z.infer<typeof ModelEntry>): KiroModel {
  const reasoning = reasoningOf(entry.additionalModelRequestFieldsSchema)
  return {
    id: entry.modelId,
    name: entry.displayName ?? entry.modelName ?? entry.modelId,
    contextWindow: entry.tokenLimits?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.tokenLimits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    inputModalities: entry.supportedInputTypes?.some(type => type.toUpperCase() === 'IMAGE') ? ['text', 'image'] : ['text'],
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * List the models the signed-in account's profile can use. Every page is
 * followed, and a model repeated across pages keeps its first entry. The
 * request names `access.profileArn`, so the catalog is scoped to that profile,
 * and goes to the profile ARN's region.
 * @param access - bearer token, region, and profile of the signed-in account.
 * @param config - budget of each page request.
 * @param signal - cancels the discovery.
 * @param runtime - transport and clock.
 * @returns the account's models in listing order; never empty.
 * @throws {KiroHttpError} for a non-2xx answer; code `AUTH` when Kiro rejects the token.
 * @throws {LlmError} code `INVALID_RESPONSE` when a page is malformed, no model is listed,
 *   or the listing does not end within {@link MAX_CATALOG_PAGES} pages; `TIMEOUT`, `ABORTED`,
 *   or `TRANSPORT` when a request fails before an answer.
 */
export async function listModels(
  access: KiroAccess,
  config: KiroConfig,
  signal?: AbortSignal,
  runtime: KiroRuntime = systemRuntime,
): Promise<KiroModel[]> {
  const base = managementBaseUrl(profileRegion(access.profileArn, access.region))
  const models = new Map<string, KiroModel>()
  let nextToken: string | undefined
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const query = new URLSearchParams({ origin: 'KIRO_CLI', profileArn: access.profileArn })
    if (nextToken !== undefined) query.set('nextToken', nextToken)
    const body = await requestJson(runtime, {
      method: 'GET',
      url: `${base}/List-Available-Models?${query.toString()}`,
      headers: { authorization: `Bearer ${access.token}` },
      signal,
      timeoutMs: config.requestTimeoutMs,
      label: 'Kiro model discovery',
    }, ModelsPage)
    for (const entry of body.models) {
      if (!models.has(entry.modelId)) models.set(entry.modelId, toKiroModel(entry))
    }
    if (!body.nextToken) {
      // Discovery is authoritative, so an empty success would erase a working catalog.
      if (models.size === 0) throw new LlmError('Kiro model discovery returned no models', 'INVALID_RESPONSE')
      return [...models.values()]
    }
    nextToken = body.nextToken
  }
  throw new LlmError(`Kiro model discovery did not finish within ${MAX_CATALOG_PAGES} pages`, 'INVALID_RESPONSE')
}
