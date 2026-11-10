// Web e2e: account commands render without a conversation Turn or AWS requests.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-commands/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/kiro-command-presentation', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/kiro-command-presentation/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const STATUS = 'Run /kiro-login to sign in with AWS Builder ID.'

describe('web e2e: Kiro command-only conversation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows account status in a new Session and restores it after reload without inference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-kiro-command-presentation'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/kiro-login status')
    await input.press('Enter')
    await page.getByText(STATUS, { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)
    expect(await page.getByText('Into the Unknown', { exact: false }).count()).toBe(0)
    await expect.poll(() => input.textContent()).toBe('')
    await compareOrRefreshGolden(UI_EXPECTED,
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByText(STATUS, { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)

    const sessions = scaffold.ctx.sessions.list()
    expect(sessions).toHaveLength(1)
    const persisted = sessions[0]?.snapshotEvents() ?? []
    expect(persisted.filter(event => event.type === 'command/run' || event.type === 'command/done'))
      .toMatchObject([
        { type: 'command/run', data: { name: 'kiro-login' } },
        { type: 'command/done', data: { kind: 'success', text: STATUS } },
      ])
    expect(persisted.some(event => event.type === 'user/message' || event.type === 'turn/start'
      || event.type === 'step/start' || event.type === 'request/header')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 90_000)
})
