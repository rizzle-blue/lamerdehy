/** Feedback stays available in the shipped browser composition. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('includes local message feedback without analytics or a Session upload setting', () => {
  const path = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const rowIds = loadOverlayPatches('web-app', path).flatMap(patch => patch.insert ?? []).map(row => row.id)

  expect(rowIds).toContain('message-feedback')
  expect(rowIds).toContain('ui-message-feedback')
  expect(rowIds).not.toContain('desktop-product-telemetry')
  expect(rowIds).not.toContain('product-analytics')
  expect(rowIds).not.toContain('ui-settings-session-log')
})
