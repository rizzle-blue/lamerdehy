/**
 * Subscription-account sign-in section, rendered in the Models page footer:
 * one row per offered account with its sign-in state, and a dialog that shows
 * a running sign-in's notices and asks its questions.
 */

import { useState } from 'react'
import {
  Button, IconCheckOutlineRegular, IconCopyOutlineRegular, Input, Modal, StateDot, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuthorizationNotice, SignInPromptView } from '@deepseek-ai/dsh-api-authorization-controller/types'
import type { SignInFace, SignInState } from './controller.ts'
import styles from './SignInSection.module.css'

/** Props the renderer binds for the section. */
export type SignInSectionProps =
  PropsRuntime<'settings.models.footer'>
  & PropsLocale<'settings.signIn'>
  & InjectFace<SignInFace>

type T = SignInSectionProps['t']
type OpenSignIn = NonNullable<SignInState['open']>

/**
 * Render the section and its dialogs.
 * @param props - the section snapshot hook, its actions, and the locale reader.
 * @returns the section, or nothing while no account is offered.
 */
export function SignInSection(props: SignInSectionProps) {
  const { t } = props
  const state = props.useSignIn(snapshot => snapshot)
  if (state.status === 'ready' && state.entries.length === 0) return null
  return (
    <section className={styles['section']} aria-labelledby="settings-sign-in-title">
      <h3 id="settings-sign-in-title" className={styles['title']}>{t('title')}</h3>
      <p className={styles['intro']}>{t('intro')}</p>
      {state.status === 'failed'
        ? <div role="alert"><p className={styles['error']}>{t('loadFailed')}</p><Button onClick={props.retry}>{t('retry')}</Button></div>
        : null}
      <ul className={styles['rows']}>
        {state.entries.map(entry => (
          <li key={entry.key} className={styles['row']}>
            <span className={styles['identity']}>
              <span className={styles['name']}>{entry.label}</span>
              <span className={styles['status']}>
                <StateDot state={entry.signedIn ? 'done' : 'idle'} />
                {t(entry.signedIn ? 'signedIn' : 'notSignedIn')}
              </span>
            </span>
            {entry.signedIn
              ? <Button size="sm" variant="ghost" onClick={() => { props.requestSignOut(entry.key) }}>{t('signOut')}</Button>
              : <Button size="sm" variant="outline" onClick={() => { props.start(entry.key) }}>{t('signIn')}</Button>}
          </li>
        ))}
      </ul>
      {state.open === undefined ? null : <SignInDialog open={state.open} props={props} />}
      <Modal
        open={state.confirmSignOut !== undefined}
        onClose={() => { props.confirmSignOut(false) }}
        tone="warning"
        title={t('signOutTitle', { label: state.confirmSignOut?.label ?? '' })}
        description={t('signOutDescription')}
        closeLabel={t('close')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { props.confirmSignOut(false) }}>{t('cancel')}</Button>
            <Button variant="primary" data-modal-autofocus onClick={() => { props.confirmSignOut(true) }}>{t('signOutConfirm')}</Button>
          </>
        )}
      >
        {state.confirmSignOut?.failed ? <p role="alert" className={styles['error']}>{t('signOutFailed')}</p> : null}
      </Modal>
    </section>
  )
}

/** The running or finished sign-in, with the question it waits on. */
function SignInDialog({ open, props }: { open: OpenSignIn; props: SignInSectionProps }) {
  const { t } = props
  const attempt = open.attempt
  const status = open.failed ? 'connection' : attempt?.status ?? 'running'
  const notices = attempt?.notices ?? []
  const link = notices.findLast(notice => notice.url !== undefined)
  const latest = notices.at(-1)
  const finished = status !== 'running'
  const footer = finished
    ? (
      <>
        {status === 'authorized'
          ? null
          : <Button variant="ghost" onClick={() => { props.start(open.key) }}>{t('tryAgain')}</Button>}
        <Button variant="primary" data-modal-autofocus onClick={props.close}>{t('done')}</Button>
      </>
    )
    : <Button variant="ghost" onClick={props.cancel}>{t('cancel')}</Button>
  return (
    <Modal
      open
      onClose={props.close}
      title={t('dialogTitle', { label: open.label })}
      closeLabel={t('close')}
      footer={footer}
    >
      <div className={styles['dialogBody']} aria-live="polite">
        {finished
          ? <Outcome t={t} status={status} error={attempt?.error} />
          : <p className={styles['notice']}>{latest?.message ?? t('starting')}</p>}
        {!finished && link?.url !== undefined ? <LinkNotice t={t} notice={link} url={link.url} openUrl={props.openUrl} /> : null}
        {!finished && attempt?.prompt !== undefined
          ? <PromptForm key={attempt.prompt.promptId} t={t} prompt={attempt.prompt} answer={props.answer} />
          : null}
      </div>
    </Modal>
  )
}

/** The final message of a settled attempt. */
function Outcome({ t, status, error }: { t: T; status: 'authorized' | 'cancelled' | 'failed' | 'connection'; error: string | undefined }) {
  switch (status) {
    case 'authorized': return <p role="status" className={styles['success']}>{t('authorized')}</p>
    case 'cancelled': return <p role="status" className={styles['notice']}>{t('cancelled')}</p>
    case 'connection': return <p role="alert" className={styles['error']}>{t('connectionFailed')}</p>
    case 'failed': return <p role="alert" className={styles['error']}>{error ?? t('failed')}</p>
  }
}

/** A page the user must open, with the code to check there. */
function LinkNotice({ t, notice, url, openUrl }: { t: T; notice: AuthorizationNotice; url: string; openUrl: (url: string) => void }) {
  const copyLink = useClipboardCopy(url)
  const copyCode = useClipboardCopy(notice.code ?? '')
  return (
    <div className={styles['link']}>
      {notice.code === undefined
        ? null
        : (
          <div className={styles['codeRow']}>
            <span className={styles['codeLabel']}>{t('code')}</span>
            <code className={styles['code']}>{notice.code}</code>
            <Button
              size="sm"
              variant="ghost"
              icon={copyCode.copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
              onClick={copyCode.onCopy}
            >
              {t(copyCode.copied ? 'copied' : 'copyCode')}
            </Button>
          </div>
        )}
      <div className={styles['actions']}>
        <Button variant="primary" onClick={() => { openUrl(url) }}>{t('openPage')}</Button>
        <Button
          variant="ghost"
          icon={copyLink.copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
          onClick={copyLink.onCopy}
        >
          {t(copyLink.copied ? 'copied' : 'copyLink')}
        </Button>
      </div>
    </div>
  )
}

/** The pending question: option buttons for a choice, otherwise a text or masked field. */
function PromptForm({ t, prompt, answer }: { t: T; prompt: SignInPromptView; answer: (value: string) => void }) {
  const [value, setValue] = useState('')
  if (prompt.kind === 'select') {
    return (
      <fieldset className={styles['prompt']}>
        <legend className={styles['promptLabel']}>{prompt.message}</legend>
        <div className={styles['options']}>
          {prompt.options.map((option, index) => (
            <Button
              key={option.id}
              variant={index === 0 ? 'primary' : 'outline'}
              {...index === 0 ? { 'data-modal-autofocus': true } : {}}
              onClick={() => { answer(option.id) }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </fieldset>
    )
  }
  return (
    <form
      className={styles['prompt']}
      onSubmit={(event) => { event.preventDefault(); answer(value) }}
    >
      <label className={styles['promptLabel']}>
        {prompt.message}
        <Input
          type={prompt.kind === 'secret' ? 'password' : 'text'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          data-modal-autofocus
          {...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }}
          onChange={(event) => { setValue(event.target.value) }}
        />
      </label>
      <div className={styles['actions']}>
        <Button type="submit" variant="primary">{t('submit')}</Button>
      </div>
    </form>
  )
}
