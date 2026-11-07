import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { isSourceInstallation } from '../src/index.ts'

it('detects source installations from the real CLI manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-installation-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const source = join(dir, 'source')
  mkdirSync(source)
  const manifest = join(source, 'package.json')
  const writeManifest = (value: object) => { writeFileSync(manifest, JSON.stringify(value)) }

  writeManifest({ name: '@deepseek-ai/dsh', dependencies: { a: 'workspace:*' } })
  expect(isSourceInstallation(manifest)).toBe(true)
  const link = join(dir, 'linked')
  symlinkSync(source, link, 'junction')
  expect(isSourceInstallation(join(link, 'package.json'))).toBe(true)

  writeManifest({ name: '@deepseek-ai/dsh', dependencies: { a: '^1.0.0' } })
  expect(isSourceInstallation(manifest)).toBe(false)
  writeManifest({ name: 'other', dependencies: { a: 'workspace:*' } })
  expect(isSourceInstallation(manifest)).toBe(false)
  writeManifest({ name: '@deepseek-ai/dsh' })
  expect(isSourceInstallation(manifest)).toBe(false)
  writeFileSync(manifest, '{')
  expect(() => isSourceInstallation(manifest)).toThrow()
  expect(() => isSourceInstallation(join(dir, 'missing.json'))).toThrow()
})
