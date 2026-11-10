/**
 * Kiro hosts, AWS region mapping, and the Builder ID constants of device
 * sign-in. Nothing here touches the network.
 *
 * Kiro serves its management and runtime APIs from two regions, and an SSO/OIDC
 * region maps onto one of them. The runtime host must follow the profile ARN's
 * region; otherwise Kiro answers `400 Improperly formed request.`
 *
 * Adapted from omp-kiro-provider (https://github.com/HoangNguyen17193/omp-kiro-provider),
 * MIT License, Copyright (c) 2026 tino; the notice is in ../LICENSE.
 *
 * @module dsh-llm-kiro/endpoints
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Region used for AWS Builder ID, and the first Kiro API region every profile search tries. */
export const KIRO_DEFAULT_REGION = 'us-east-1'

/** Start URL of AWS Builder ID, the sign-in used when no IAM Identity Center start URL is given. */
export const BUILDER_ID_START_URL = 'https://view.awsapps.com/start'

/**
 * Public placeholder profile Kiro accepts for AWS Builder ID accounts, which
 * may have no listable profile of their own.
 */
export const BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'

/**
 * `User-Agent` and `x-amz-user-agent` of every Kiro and AWS sign-in request. Kiro's runtime answers
 * `403 User is not authorized to make this call.` for the shared Harness attribution, so this
 * package sends the upstream omp-kiro-provider identity instead.
 */
export const KIRO_USER_AGENT = 'omp-kiro-provider/0.2.0'

/** Kiro API region serving each SSO/OIDC region; a region absent here serves itself. */
const API_REGION_BY_SSO_REGION: Record<string, string> = {
  'us-east-1': 'us-east-1',
  'us-east-2': 'us-east-1',
  'us-west-1': 'us-east-1',
  'us-west-2': 'us-east-1',
  'ca-central-1': 'us-east-1',
  'sa-east-1': 'us-east-1',
  'ap-northeast-1': 'us-east-1',
  'ap-northeast-2': 'us-east-1',
  'ap-south-1': 'us-east-1',
  'ap-southeast-1': 'us-east-1',
  'ap-southeast-2': 'us-east-1',
  'eu-central-1': 'eu-central-1',
  'eu-west-1': 'eu-central-1',
  'eu-west-2': 'eu-central-1',
  'eu-west-3': 'eu-central-1',
  'eu-north-1': 'eu-central-1',
  'eu-south-1': 'eu-central-1',
}

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/

/**
 * Whether a string has the shape of an AWS region such as `us-east-1`. Regions
 * become host names that receive bearer tokens, so every region is checked
 * before it is placed in a URL.
 * @param value - candidate region.
 * @returns whether the value is a region identifier.
 */
export function isRegion(value: string): boolean {
  return REGION_PATTERN.test(value)
}

/**
 * The Kiro API region that serves an SSO/OIDC region.
 * @param ssoRegion - region of the SSO directory or OIDC client.
 * @returns `us-east-1` or `eu-central-1` for a known region, otherwise the region itself.
 */
export function apiRegionFor(ssoRegion: string): string {
  // Own keys only: a region string is arbitrary text here, and `constructor` must not read as a mapping.
  const mapped = Object.hasOwn(API_REGION_BY_SSO_REGION, ssoRegion) ? API_REGION_BY_SSO_REGION[ssoRegion] : undefined
  return mapped ?? ssoRegion
}

/**
 * Region field of `arn:aws:codewhisperer:<region>:<account>:profile/<id>`.
 * @param arn - profile ARN.
 * @returns the region, or undefined when the ARN does not carry a valid one.
 */
export function regionFromProfileArn(arn: string): string | undefined {
  const region = arn.split(':')[3]
  return region !== undefined && REGION_PATTERN.test(region) ? region : undefined
}

/**
 * The region every request for one profile goes to: the profile ARN's own
 * region, because a profile is only served from where it lives.
 * @param profileArn - profile the request names.
 * @param fallback - region recorded beside the profile, used when the ARN names none.
 * @returns the region of the management and runtime hosts.
 */
export function profileRegion(profileArn: string, fallback: string): string {
  return regionFromProfileArn(profileArn) ?? fallback
}

/** Refuse a region that cannot safely become part of a host name. */
function checked(region: string): string {
  if (!isRegion(region)) throw new LlmError(`Kiro: "${region}" is not an AWS region such as us-east-1`, 'INVALID_REGION')
  return region
}

/**
 * AWS SSO OIDC host of a region.
 * @param region - SSO/OIDC region.
 * @returns the origin that registers clients and issues tokens.
 * @throws {LlmError} code `INVALID_REGION` when `region` is not an AWS region.
 */
export function oidcBaseUrl(region: string): string {
  return `https://oidc.${checked(region)}.amazonaws.com`
}

/**
 * Kiro management host of a region: profiles, models, and usage.
 * @param region - Kiro API region.
 * @returns the management origin.
 * @throws {LlmError} code `INVALID_REGION` when `region` is not an AWS region.
 */
export function managementBaseUrl(region: string): string {
  return `https://management.${checked(region)}.kiro.dev`
}

/**
 * Kiro runtime host of a region: conversation streaming.
 * @param region - Kiro API region.
 * @returns the runtime origin.
 * @throws {LlmError} code `INVALID_REGION` when `region` is not an AWS region.
 */
export function runtimeBaseUrl(region: string): string {
  return `https://runtime.${checked(region)}.kiro.dev`
}
