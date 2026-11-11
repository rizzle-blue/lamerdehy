/**
 * Subscription-account sign-ins on the Models page, browser half: lists the
 * accounts the Host's `authorization` namespace offers, signs in through a
 * dialog that relays the Host flow's notices and questions, and signs out.
 * The section registers into the Models page footer and refreshes when a
 * credential record changes on any surface.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Models page SlotMap merge (the 'settings.models.footer' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SignInController } from './controller.ts'
import { SignInSection } from './SignInSection.tsx'
import { en, type SignInLocaleKey } from './locales.ts'

export type { SignInFace, SignInState } from './controller.ts'
export type { SignInSectionProps } from './SignInSection.tsx'
export type { SignInLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subscription-account sign-in section copy. */
    'settings.signIn': SignInLocaleKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.authorization']

/**
 * Mount the sign-in section in the Models page footer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // English only (LAMHY.md); the single-locale form avoids the typed form's required `zh` dictionary.
  ctx.effect(() => ctx.locale.register('settings.signIn', 'en', en), 'ui-settings-sign-in: dictionaries')
  const controller = new SignInController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-sign-in: attempt watch')
  ctx.effect(() => {
    const refresh = (): void => { void controller.refresh() }
    const disposers = [
      ctx.remote.$on('credentials/record-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    refresh()
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-sign-in: list invalidations')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'subscription-sign-in',
    order: 0,
    locale: 'settings.signIn',
    inject: () => controller.inject(),
  }, SignInSection))
}
