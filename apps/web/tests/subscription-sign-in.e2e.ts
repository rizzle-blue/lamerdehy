/** Subscription sign-ins are reachable from the shipped Models page without a model Turn. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, openSettings } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/subscription-sign-in/ui.expected.md', import.meta.url))

it('offers ChatGPT and Kiro sign-in dialogs on the Models page', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await openSettings(page, 'en')
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  const accounts = page.getByRole('region', { name: 'Subscription accounts' })
  await accounts.getByText('Kiro', { exact: true }).waitFor()
  await accounts.getByText('ChatGPT subscription', { exact: true }).waitFor()
  await compareOrRefreshGolden(EXPECTED,
    await captureStableAria(page, 'section[aria-labelledby="settings-sign-in-title"]', scaffold.workspaceCwd), webSnapshotMode())

  const chatgpt = accounts.getByRole('listitem').filter({ hasText: 'ChatGPT subscription' })
  await chatgpt.getByRole('button', { name: 'Sign in', exact: true }).click()
  const chatgptDialog = page.getByRole('dialog', { name: 'Sign in to ChatGPT subscription', exact: true })
  await chatgptDialog.getByRole('button', { name: 'Browser login (default)' }).waitFor()
  await chatgptDialog.getByRole('button', { name: 'Device code login (headless)' }).waitFor()
  // Both choices start account network traffic, so the keyless scene cancels before choosing.
  await chatgptDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await chatgptDialog.getByText('Sign-in cancelled.', { exact: true }).waitFor()
  await chatgptDialog.getByRole('button', { name: 'Done', exact: true }).click()

  const kiro = accounts.getByRole('listitem').filter({ hasText: 'Kiro' })
  await kiro.getByRole('button', { name: 'Sign in', exact: true }).click()
  const kiroDialog = page.getByRole('dialog', { name: 'Sign in to Kiro', exact: true })
  await kiroDialog.getByRole('textbox', { name: 'IAM Identity Center start URL (leave blank for AWS Builder ID)' }).waitFor()
  await kiroDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await kiroDialog.getByText('Sign-in cancelled.', { exact: true }).waitFor()
  await kiroDialog.getByRole('button', { name: 'Done', exact: true }).click()
}, 120_000)
