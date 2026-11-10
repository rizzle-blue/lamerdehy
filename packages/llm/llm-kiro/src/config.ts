/**
 * Settings of the Kiro provider: the budget of every Kiro request, the stream
 * stall limits, and how early an access token is refreshed. The endpoints are
 * fixed by AWS and Kiro, so only budgets are configurable.
 *
 * @module dsh-llm-kiro/config
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Validated Kiro settings, read by sign-in, model discovery, usage, and streaming alike. */
export interface KiroConfig {
  /**
   * Longest one Kiro sign-in, profile, catalog, or usage request may take, in
   * milliseconds, from 1 to 25,000 (default 15,000). A token refresh holds the
   * credential record's write lock for one such request, and the local
   * credential store makes other writers wait at most 30 seconds, so the
   * bound keeps a refresh from failing them.
   */
  requestTimeoutMs: number
  /** Longest wait for the first stream event after a conversation request is sent, in milliseconds (default 180,000). */
  firstEventTimeoutMs: number
  /** Longest gap between stream events once output has begun, in milliseconds (default 300,000). */
  idleTimeoutMs: number
  /** How long before its expiry an access token is refreshed, in milliseconds (default 300,000). */
  expiryMarginMs: number
}

/** Schema of the plugin's configuration; every field has a default, so an empty configuration is valid. */
export const Config = z.object({
  requestTimeoutMs: z.number().step(1).min(1).max(25_000).default(15_000),
  firstEventTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(180_000),
  idleTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  expiryMarginMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(300_000),
})
