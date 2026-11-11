/** The browser half registers its footer section, follows credential and connection invalidations, and leaves with its fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { SignInFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
  const remote = new TestRemote(ctx, { authorization: { list } })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'settings.models.footer': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  return { ctx, slots, list, remote }
}

describe('ui-settings-sign-in apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.authorization'])
  })

  it('registers the footer section, refreshing on mount, credential changes, and reconnects', async () => {
    const { ctx, slots, list, remote } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('settings.models.footer')).toHaveLength(1) })
    const entry = slots.entries('settings.models.footer')[0]!
    expect(entry.options).toMatchObject({ id: 'subscription-sign-in', order: 0 })
    expect(entry.locale).toBe('settings.signIn')
    const face = (entry.inject as () => Pick<SignInFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['signIn'])
    expect(list).toHaveBeenCalledTimes(1)
    remote.emit('credentials/record-updated', ['llm-kiro/kiro'])
    ctx.emit('connection/reset')
    expect(list).toHaveBeenCalledTimes(3)

    await fiber.dispose()
    expect(slots.entries('settings.models.footer')).toHaveLength(0)
    remote.emit('credentials/record-updated', ['llm-kiro/kiro'])
    expect(list).toHaveBeenCalledTimes(3)
  })
})
