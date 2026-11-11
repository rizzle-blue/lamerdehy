// @vitest-environment jsdom
/** The sign-in section as the Models page footer renders it: account rows, the sign-in dialog, and sign-out confirmation. */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CredentialKey, SignInAttemptView, SignInPromptView } from '@deepseek-ai/dsh-api-authorization-controller/types'
import { SignInSection, type SignInSectionProps } from '../src/client/SignInSection.tsx'
import type { SignInState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const CHATGPT = 'llm-pi-ai/openai-codex' as CredentialKey
const KIRO = 'llm-kiro/kiro' as CredentialKey

const t = ((key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) => params !== undefined && name in params ? String(params[name]) : match)) as SignInSectionProps['t']

const ready: SignInState = {
  status: 'ready',
  entries: [
    { key: CHATGPT, label: 'OpenAI (ChatGPT Plus/Pro)', methods: [], signedIn: false },
    { key: KIRO, label: 'Kiro', methods: [], signedIn: true },
  ],
}

function attempt(rest: Partial<SignInAttemptView> = {}): SignInAttemptView {
  return { attemptId: 'a1' as SignInAttemptView['attemptId'], key: CHATGPT, status: 'running', notices: [], ...rest }
}

function opened(view: SignInAttemptView | null, failed = false): SignInState {
  return { ...ready, open: { key: CHATGPT, label: 'OpenAI (ChatGPT Plus/Pro)', attempt: view, failed } }
}

function renderSection(state: SignInState = ready) {
  const store = createSnapshotStore<SignInState>(state)
  const actions = {
    start: vi.fn(), answer: vi.fn(), cancel: vi.fn(), close: vi.fn(),
    requestSignOut: vi.fn(), confirmSignOut: vi.fn(), openUrl: vi.fn(), retry: vi.fn(),
  }
  const props = { ...actions, t, useSignIn: bindSnapshotSelector(store) } as SignInSectionProps
  render(<SignInSection {...props} />)
  return { actions, store }
}

const dialog = () => within(screen.getByRole('dialog'))

describe('SignInSection', () => {
  it('lists accounts with their state and the matching action', () => {
    const { actions } = renderSection()
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    const [chatgpt, kiro] = screen.getAllByRole('listitem')
    expect(within(chatgpt!).getByText(en.notSignedIn)).toBeTruthy()
    expect(within(kiro!).getByText(en.signedIn)).toBeTruthy()
    fireEvent.click(within(chatgpt!).getByRole('button', { name: en.signIn }))
    expect(actions.start).toHaveBeenCalledWith(CHATGPT)
    fireEvent.click(within(kiro!).getByRole('button', { name: en.signOut }))
    expect(actions.requestSignOut).toHaveBeenCalledWith(KIRO)
  })

  it('renders nothing when no account is offered, and an alert when the list failed', () => {
    renderSection({ status: 'ready', entries: [] })
    expect(screen.queryByRole('heading')).toBeNull()
    cleanup()
    const { actions } = renderSection({ status: 'failed', entries: [] })
    expect(screen.getByRole('alert').textContent).toContain(en.loadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.retry).toHaveBeenCalled()
  })

  it('shows the starting notice until the Host reports, and cancels from the dialog', () => {
    const { actions } = renderSection(opened(null))
    expect(screen.getByRole('dialog', { name: 'Sign in to OpenAI (ChatGPT Plus/Pro)' })).toBeTruthy()
    expect(dialog().getByText(en.starting)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: en.cancel }))
    expect(actions.cancel).toHaveBeenCalled()
  })

  it('shows the latest notice, the sign-in link, and the code to check', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { actions } = renderSection(opened(attempt({
      notices: [
        { message: 'Approve in your browser.', url: 'https://device.example/verify', code: 'WXYZ-1234' },
        { message: 'Waiting for approval…' },
      ],
    })))
    expect(dialog().getByText('Waiting for approval…')).toBeTruthy()
    expect(dialog().getByText('WXYZ-1234')).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: en.openPage }))
    expect(actions.openUrl).toHaveBeenCalledWith('https://device.example/verify')
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: en.copyCode })) })
    expect(writeText).toHaveBeenCalledWith('WXYZ-1234')
    expect(dialog().getByRole('button', { name: en.copied })).toBeTruthy()
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: en.copyLink })) })
    expect(writeText).toHaveBeenCalledWith('https://device.example/verify')
  })

  it('shows a link without a code', () => {
    renderSection(opened(attempt({ notices: [{ message: 'Open the page.', url: 'https://auth.example' }] })))
    expect(dialog().queryByText(en.code)).toBeNull()
    expect(dialog().getByRole('button', { name: en.openPage })).toBeTruthy()
  })

  it('answers a choice with the option id', () => {
    const prompt: SignInPromptView = {
      promptId: 'p1' as SignInPromptView['promptId'],
      kind: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'device_code', label: 'Device code login (headless)' }],
    }
    const { actions } = renderSection(opened(attempt({ prompt })))
    expect(dialog().getByRole('group', { name: prompt.message })).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Device code login (headless)' }))
    expect(actions.answer).toHaveBeenCalledWith('device_code')
  })

  it('submits typed text and masks secrets', () => {
    const text: SignInPromptView = {
      promptId: 'p1' as SignInPromptView['promptId'],
      kind: 'text',
      message: 'IAM Identity Center start URL (leave blank for AWS Builder ID)',
      placeholder: 'https://<org>.awsapps.com/start',
    }
    const { actions, store } = renderSection(opened(attempt({ prompt: text })))
    const field = dialog().getByRole('textbox', { name: text.message })
    expect(field.getAttribute('placeholder')).toBe(text.placeholder)
    fireEvent.change(field, { target: { value: 'https://org.awsapps.com/start' } })
    fireEvent.click(dialog().getByRole('button', { name: en.submit }))
    expect(actions.answer).toHaveBeenCalledWith('https://org.awsapps.com/start')
    act(() => { store.set(opened(attempt({ prompt: { promptId: 'p2' as SignInPromptView['promptId'], kind: 'secret', message: 'Paste the code' } }))) })
    const secret = dialog().getByLabelText('Paste the code')
    expect(secret.getAttribute('type')).toBe('password')
    expect((secret as HTMLInputElement).value).toBe('')
    fireEvent.submit(secret)
    expect(actions.answer).toHaveBeenLastCalledWith('')
  })

  it.each([
    ['authorized', attempt({ status: 'authorized' }), false, en.authorized, false],
    ['cancelled', attempt({ status: 'cancelled' }), false, en.cancelled, true],
    ['failed with a message', attempt({ status: 'failed', error: 'Kiro sign-in code expired.' }), false, 'Kiro sign-in code expired.', true],
    ['failed without a message', attempt({ status: 'failed' }), false, en.failed, true],
    ['disconnected', null, true, en.connectionFailed, true],
  ])('reports a %s attempt', (_name, view, failed, message, retry) => {
    const { actions } = renderSection(opened(view, failed))
    expect(dialog().getByText(message)).toBeTruthy()
    expect(dialog().queryByRole('button', { name: en.tryAgain }) !== null).toBe(retry)
    if (retry) {
      fireEvent.click(dialog().getByRole('button', { name: en.tryAgain }))
      expect(actions.start).toHaveBeenCalledWith(CHATGPT)
    }
    fireEvent.click(dialog().getByRole('button', { name: en.done }))
    expect(actions.close).toHaveBeenCalled()
  })

  it('retains a sign-out error in the confirmation dialog', () => {
    renderSection({ ...ready, confirmSignOut: { key: KIRO, label: 'Kiro', failed: true } })
    expect(dialog().getByRole('alert').textContent).toBe(en.signOutFailed)
  })

  it('confirms sign-out in a warning dialog', () => {
    const { actions } = renderSection({ ...ready, confirmSignOut: { key: KIRO, label: 'Kiro' } })
    expect(screen.getByRole('dialog', { name: 'Sign out of Kiro?' })).toBeTruthy()
    expect(dialog().getByText(en.signOutDescription)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: en.signOutConfirm }))
    expect(actions.confirmSignOut).toHaveBeenLastCalledWith(true)
    fireEvent.click(dialog().getByRole('button', { name: en.cancel }))
    expect(actions.confirmSignOut).toHaveBeenLastCalledWith(false)
    fireEvent.click(dialog().getByRole('button', { name: en.close }))
    expect(actions.confirmSignOut).toHaveBeenCalledTimes(3)
  })
})
