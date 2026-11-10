import { describe, expect, it } from 'vitest'
import { findLamhyDrift, findLamhyFileDrift, newLamhyDrift } from './verify-lamhy-fork.ts'

const KIRO = 'packages/llm/llm-kiro/src/adapter.ts'
const KIRO_SOURCE = "headers: { 'x-amzn-codewhisperer-optout': 'true' }"

function drift(files: Record<string, string>) {
  return findLamhyDrift(Object.keys(files), file => files[file])
}

describe('Lam Hy fork drift check', () => {
  it('rejects files under removed telemetry packages without reading them', () => {
    expect(findLamhyFileDrift('packages/telemetry/otel/src/index.ts', () => { throw new Error('read') }))
      .toEqual([{ category: 'telemetry', file: 'packages/telemetry/otel/src/index.ts', line: null, reason: 'removed telemetry path packages/telemetry/' }])
    expect(findLamhyFileDrift('apps/desktop/src/update-coordinator.ts', () => ''))
      .toMatchObject([{ category: 'telemetry', line: null }])
  })

  it('rejects collector hosts, id headers, switch variables, and reporting dependencies in sources and manifests', () => {
    expect(drift({
      'packages/llm/llm-deepseek/src/adapter.ts': "ok\n'x-deepseek-harness-user-id': id",
      'packages/bundle/base/cordis.patch.yml': "url: 'https://dsh-otel-collector.deepseeksvc.com/v1/logs'",
      'apps/cli/src/profile-boot.ts': 'process.env.DSH_TELEMETRY_DISABLED',
      'apps/desktop/package.json': '    "electron-updater": "^6.8.9",',
    }).map(row => [row.file, row.line])).toEqual([
      ['packages/llm/llm-deepseek/src/adapter.ts', 2],
      ['packages/bundle/base/cordis.patch.yml', 1],
      ['apps/cli/src/profile-boot.ts', 1],
      ['apps/desktop/package.json', 1],
    ])
  })

  it('accepts user-configured provider hosts and test sources', () => {
    expect(drift({
      'packages/llm/llm-deepseek/src/config.ts': "export const PUBLIC_BASE_URL = 'https://api.deepseek.com/anthropic'",
      'packages/telemetry-free/tests/fixture.spec.ts': 'deepseeksvc.com',
    })).toEqual([])
  })

  it('rejects Chinese docs, translation records, locale data, and localized assets', () => {
    const files = [
      'README.zh.md', 'docs/glossary.i18n.yaml', 'packages/acp/acp/locale/zh.json',
      'packages/client/locale/src/locales/zh.ts', 'docs/user/guide/providers-models-page.zh.png',
      'packages/client/ui-settings-account/src/client/assets/onboarding-welcome-zh-dark.webp',
      'apps/desktop/tests/expected/fatal-dialog-zh-CN.txt', 'apps/desktop/installer/locales/zh_CN.json',
    ]
    expect(drift(Object.fromEntries(files.map(file => [file, 'DeepSeek Harness']))).map(row => [row.category, row.file]))
      .toEqual(files.map(file => ['english-only', file]))
  })

  it('accepts other locales and names that merely contain zh', () => {
    expect(drift({ 'packages/acp/acp/locale/ja.json': '{}', 'packages/x/src/zhuyin.ts': '', 'docs/zh-free.md': '' })).toEqual([])
  })

  it('rejects the upstream product name in Markdown and UI dictionaries, not in code comments', () => {
    expect(drift({
      'README.md': '# DeepSeek Harness',
      'packages/client/ui-chat/locale/en.json': '{ "title": "DeepSeek-Harness" }',
      'packages/client/ui-chat/src/client/locales.ts': "title: 'DeepSeek Harness'",
      'packages/core/agent/src/index.ts': '/** DeepSeek Harness agent. */',
    }).map(row => [row.category, row.file])).toEqual([
      ['rebrand', 'README.md'],
      ['rebrand', 'packages/client/ui-chat/locale/en.json'],
      ['rebrand', 'packages/client/ui-chat/src/client/locales.ts'],
    ])
  })

  it('keeps attribution files, vendor copies, frozen notes, and fork policy text', () => {
    expect(drift({
      'LAMHY.md': 'fork of DeepSeek Harness, deepseeksvc.com',
      'THIRD_PARTY_NOTICES.md': 'DeepSeek Harness',
      'vendor/timer/locale/zh.json': '{}',
      '.agents/notes/archived/feature/x.zh.md': '',
      '.agents/skills/lamhy-no-telemetry/SKILL.md': 'deepseeksvc.com DeepSeek Harness',
    })).toEqual([])
  })

  it('requires the Kiro data-use opt-out header while the Kiro adapter exists', () => {
    expect(drift({ [KIRO]: KIRO_SOURCE })).toEqual([])
    expect(drift({ [KIRO]: "headers: { 'x-amzn-codewhisperer-optout': 'false' }" }))
      .toMatchObject([{ category: 'telemetry', file: KIRO, line: null }])
    expect(drift({ 'packages/llm/llm-kiro/README.md': '' })).toEqual([])
  })

  it('skips agent workflow files in the rebrand scan', () => {
    expect(drift({ '.agents/notes/implemented/process/x.md': 'DeepSeek Harness', '.agents/skills/dsh-doc/SKILL.md': 'DeepSeek Harness' })).toEqual([])
  })

  it('reports only drift beyond the baseline, ignoring line shifts', () => {
    const baseline = drift({ 'README.md': '# DeepSeek Harness', 'docs/a.zh.md': '' })
    const current = drift({ 'README.md': 'intro\n# DeepSeek Harness\nDeepSeek Harness', 'docs/a.zh.md': '', 'docs/b.zh.md': '' })
    expect(newLamhyDrift(current, baseline).map(row => [row.file, row.line])).toEqual([['README.md', 3], ['docs/b.zh.md', null]])
    expect(newLamhyDrift(baseline, current)).toEqual([])
  })
})
