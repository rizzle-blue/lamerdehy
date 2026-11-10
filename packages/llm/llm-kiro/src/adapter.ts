/**
 * Native Kiro adapter: account-scoped model discovery and one cancellable
 * conversation request per call.
 *
 * Failures reach consumers as `LlmError`s with stable codes: credential and
 * catalog failures keep the codes their owners assign (`MISSING_CREDENTIAL`,
 * `AUTH`, ...), HTTP failures are classified by status and wording, a stalled
 * stream is `TIMEOUT`, a caller abort is `ABORTED`, a network failure is
 * `TRANSPORT`, and corrupt frames or payloads are `MALFORMED_RESPONSE`.
 * Wire behavior is adapted from omp-kiro-provider (MIT, see ../LICENSE).
 * @module @deepseek-ai/dsh-llm-kiro/adapter
 */

import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, ImageAttachmentAccess, ImageAttachmentAccessResolver, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { KiroAccess } from './auth.ts'
import { listModels as loadCatalog } from './catalog.ts'
import type { KiroModel } from './catalog.ts'
import type { KiroConfig } from './config.ts'
import { KIRO_USER_AGENT, runtimeBaseUrl } from './endpoints.ts'
import { readEventStream } from './eventstream.ts'
import { httpErrorFrom, systemRuntime } from './http.ts'
import type { KiroRuntime } from './http.ts'
import { assertSupportedOptions, buildKiroRequest, currentImages } from './request.ts'
import { translate } from './stream.ts'

/** Timeout code of the wait for the first stream output. */
const FIRST_EVENT = 'KIRO_FIRST_EVENT'
/** Timeout code of a gap between network reads once output has begun. */
const IDLE = 'KIRO_STREAM_IDLE'

/** The credential operation the adapter needs; `KiroAuth` provides it. */
export interface KiroAccessSource {
  /**
   * Read the current access, refreshing an expiring token first.
   * @param signal - cancels the lookup.
   * @returns the bearer token, serving region, and profile.
   */
  access(signal?: AbortSignal): Promise<KiroAccess>
}

/** Optional host facilities of the adapter. */
export interface KiroAdapterOptions {
  /** Transport for catalog and conversation requests; omission uses the platform `fetch`. */
  runtime?: KiroRuntime
  /** Resolve the durable attachment service at request time; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/** One model-resolution generation: the access and catalog entry a request is built from. */
interface Resolution {
  readonly access: KiroAccess
  readonly entry: KiroModel | undefined
}

/** The account catalog loaded for one credential. */
interface CatalogEntry {
  readonly scope: string
  readonly models: Promise<readonly KiroModel[]>
}

/**
 * Wait for `task` unless `signal` aborts first; the task keeps running for its other waiters.
 * @param task - the shared work to wait for.
 * @param signal - cancels this wait only.
 * @param operation - names the work in the cancellation failure.
 * @returns the task's result.
 * @throws {LlmError} `ABORTED` when the signal aborts first, including a signal that is already aborted.
 */
async function untilAborted<T>(task: Promise<T>, signal: AbortSignal | undefined, operation: string): Promise<T> {
  if (signal === undefined) return task
  const aborted = Promise.withResolvers<never>()
  const abort = (): void => { aborted.reject(new LlmError(`${operation} was cancelled`, 'ABORTED', { cause: signal.reason })) }
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    // The abort side is listed first so an already-aborted signal wins over an already-settled task.
    return await Promise.race([aborted.promise, task])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function modelInfo(provider: string, model: KiroModel): LlmModelInfo {
  return { provider, id: model.id, name: model.name, inputModalities: [...model.inputModalities] }
}

/** Metadata for one requested model; an unlisted model is text-only with nothing else declared. */
function resolvedInfo(provider: string, id: string, entry: KiroModel | undefined): LlmResolvedModelInfo {
  if (entry === undefined) return { provider, id, name: id, inputModalities: ['text'] }
  return {
    ...modelInfo(provider, entry),
    context: { contextWindow: entry.contextWindow },
    ...entry.reasoning === undefined ? {} : {
      reasoning: {
        efforts: entry.reasoning.efforts.map(effort => ({
          id: ReasoningEffortId(effort),
          name: `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`,
        })),
      },
    },
  }
}

/** Kiro model provider over AWS EventStream. */
export class KiroAdapter extends LlmAdapter {
  private readonly runtime: KiroRuntime
  private catalog: CatalogEntry | undefined
  private readonly imageAccess: ImageAttachmentAccessResolver = (ref) => {
    const attachments = this.options.resolveAttachments?.()
    return attachments === undefined ? undefined : this.options.resolveImageAccess?.(attachments, ref)
  }

  /**
   * @param auth - supplies the signed-in account's access; its errors reach callers unchanged.
   * @param config - validated request budgets and stream stall limits.
   * @param options - transport and attachment facilities; omissions use the platform and reject image input.
   */
  constructor(
    private readonly auth: KiroAccessSource,
    private readonly config: KiroConfig,
    private readonly options: KiroAdapterOptions = {},
  ) {
    super()
    this.runtime = options.runtime ?? systemRuntime
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kiro' }
  }

  /**
   * List the signed-in account's models, reloading the catalog. A route that is
   * not signed in lists nothing so it cannot break a catalog that lists every
   * provider; any other failure propagates.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    let access: KiroAccess
    try {
      access = await this.auth.access()
    } catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
      throw error
    }
    return (await this.models(access, undefined, true)).map(model => modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return resolvedInfo(provider, model, (await this.lookup(model, signal)).entry)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolution = await this.lookup(model, signal)
    return {
      model: resolvedInfo(provider, model, resolution.entry),
      stream: options => this.generate(options, resolution),
    }
  }

  stream(options: GenerateOptions<string>): AsyncIterable<StreamChunk> {
    return this.generate(options, undefined)
  }

  /** The account catalog of one credential; the shared load serves concurrent callers and later calls until `refresh`. */
  private models(access: KiroAccess, signal: AbortSignal | undefined, refresh: boolean): Promise<readonly KiroModel[]> {
    // The token joins the scope because Builder ID accounts share one profile ARN.
    const scope = `${access.region}\n${access.profileArn}\n${access.token}`
    let entry = this.catalog
    if (refresh || entry?.scope !== scope) {
      const created: CatalogEntry = { scope, models: loadCatalog(access, this.config, undefined, this.runtime) }
      entry = created
      this.catalog = created
      // A failed load is not remembered, so the next call retries.
      void created.models.catch(() => {
        if (this.catalog === created) this.catalog = undefined
      })
    }
    return untilAborted(entry.models, signal, 'Kiro model discovery')
  }

  private async lookup(model: string, signal: AbortSignal | undefined): Promise<Resolution> {
    const access = await untilAborted(this.auth.access(signal), signal, 'Kiro credential lookup')
    return { access, entry: (await this.models(access, signal, false)).find(entry => entry.id === model) }
  }

  /**
   * Stream one call. One adapter call is one provider attempt, bounded by the
   * first-output and idle stall limits and cancelled with the caller's signal.
   */
  private async * generate(options: GenerateOptions<string>, prepared: Resolution | undefined): AsyncGenerator<StreamChunk> {
    assertSupportedOptions(options)
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    let watchdog = idleWatchdog(signal, this.config.firstEventTimeoutMs, FIRST_EVENT)
    let idling = false
    // Only reads after output began count as idle time; the first-output wait is one budget.
    const iterator = this.request(options, prepared, signal, () => { if (idling) watchdog.pulse() })
    try {
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        if (!idling) {
          watchdog[Symbol.dispose]()
          watchdog = idleWatchdog(signal, this.config.idleTimeoutMs, IDLE)
          idling = true
        }
        yield next.value
      }
    } catch (error) {
      const timeout = timeoutOf(watchdog.signal, FIRST_EVENT) ?? timeoutOf(watchdog.signal, IDLE)
      if (timeout !== undefined) {
        const waited = timeout.code === FIRST_EVENT ? 'the first output' : 'the next event'
        throw new LlmError(`Kiro stream timed out after ${timeout.timeoutMs}ms waiting for ${waited}`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw new LlmError('Kiro request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('Kiro transport failed', 'TRANSPORT', { cause: error })
    } finally {
      watchdog[Symbol.dispose]()
      consumer.abort()
      // The abort above owns teardown; a demand the deadline abandoned can stay pending, and awaiting this drain would re-hang.
      /* v8 ignore next -- the detached drain only rejects while unwinding an abandoned request. */
      void iterator.return(undefined).catch(() => {})
    }
  }

  /** Resolve the account, build the body, POST it, and translate the response stream. */
  private async * request(
    options: GenerateOptions<string>, prepared: Resolution | undefined, signal: AbortSignal, activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const { access, entry } = prepared ?? await this.lookup(options.model, signal)
    const images = await this.prepareImages(options, entry, signal)
    const body = buildKiroRequest({
      options,
      model: entry,
      profileArn: access.profileArn,
      conversationId: options.sessionId === undefined ? randomUUID() : String(options.sessionId),
      images,
      access: this.imageAccess,
    })
    const response = await untilAborted(this.runtime.fetch(`${runtimeBaseUrl(access.region)}/generateAssistantResponse`, {
      method: 'POST',
      // The bearer token must stay on the host it was sent to.
      redirect: 'error',
      signal,
      body: JSON.stringify(body),
      headers: {
        'user-agent': KIRO_USER_AGENT,
        'content-type': 'application/json',
        'accept': 'application/vnd.amazon.eventstream',
        'authorization': `Bearer ${access.token}`,
        'x-amzn-codewhisperer-optout': 'true',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amzn-kiro-profile-arn': access.profileArn,
        'amz-sdk-request': 'attempt=1; max=1',
        'amz-sdk-invocation-id': randomUUID(),
        'x-amz-user-agent': KIRO_USER_AGENT,
      },
    }).then(async (response) => {
      // A transport may resolve after cancellation; no consumer can own that response body.
      if (signal.aborted) {
        await response.body?.cancel(signal.reason)
        signal.throwIfAborted()
      }
      return response
    }), signal, 'Kiro request')
    if (!response.ok) throw await httpErrorFrom(response, 'Kiro request', this.runtime.now())
    if (response.body === null) throw new LlmError('Kiro returned no response body', 'EMPTY_RESPONSE')
    yield* translate(readEventStream(response.body, signal, activity))
  }

  /** Request versions of the images the final user turn carries. */
  private async prepareImages(
    options: GenerateOptions<string>, entry: KiroModel | undefined, signal: AbortSignal,
  ): Promise<Map<AttachmentId, RequestImageAttachment>> {
    const versions = new Map<AttachmentId, RequestImageAttachment>()
    const refs = currentImages(options.messages)
    if (refs.length === 0) return versions
    if (entry?.inputModalities.includes('image') !== true) {
      throw new LlmError(`Kiro model "${options.model}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = this.options.resolveAttachments?.()
    if (attachments === undefined) throw new LlmError('Kiro image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    for (const ref of refs) {
      const target = this.imageRequestTarget(options.provider, options.model, ref)
      versions.set(ref.attachmentId, await attachments.readImageRequest(ref, target, signal))
    }
    return versions
  }
}
