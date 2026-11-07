/** Installation facts derived from the running dsh application manifest. */
import { readFileSync, realpathSync } from 'node:fs'
import type { ProfileManifest } from './profile.ts'

/**
 * Whether the running DSH CLI comes from a repository workspace checkout: its real
 * `@deepseek-ai/dsh` manifest declares `workspace:` dependencies. True for `pnpm dsh`,
 * `pnpm run dev:web`, `start:web`, and development Desktop; false for registry
 * installations and packaged Desktop.
 * @param installAnchor - the dsh app package.json, possibly reached through a symlink.
 * @returns whether the installation is a source checkout.
 * @throws when the manifest cannot be read or parsed.
 */
export function isSourceInstallation(installAnchor: string): boolean {
  const manifest = JSON.parse(readFileSync(realpathSync(installAnchor), 'utf8')) as ProfileManifest
  return manifest.name === '@deepseek-ai/dsh'
    && Object.values(manifest.dependencies ?? {}).some(value => value.startsWith('workspace:'))
}
