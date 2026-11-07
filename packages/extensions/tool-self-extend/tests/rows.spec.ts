import { describe, expect, it } from 'vitest'
import { allRowIds, findGroup, readModuleRow, readModuleTools, readPresetDeclaration, SANDBOXED_MODULE_PLUGIN, validatePackageSpecifier, withGroup } from '../src/rows.ts'
import { presentSelfExtendCall } from '../src/present.ts'

describe('preset composition', () => {
  it('accepts declarations and rejects malformed durable values', () => {
    const plugins: unknown[] = []
    expect(readPresetDeclaration({ id: 'tidebloom', plugins }, 'preset')).toEqual({ id: 'tidebloom', plugins })
    for (const value of [null, 1, {}, { id: 1 }, { id: '' }, { id: '  ' }, { id: 'x' }, { id: 'x', plugins: {} }]) {
      expect(() => readPresetDeclaration(value, 'preset')).toThrow()
    }
  })

  it('finds and validates the extension group', () => {
    const row = { id: 'one', name: 'pkg' }
    expect(findGroup([null, 1, {}, { id: 'other' }, { id: 'extensions', group: true, config: [row] }], 'extensions', 'preset')).toEqual([row])
    for (const group of [{ id: 'extensions' }, { id: 'extensions', group: false }, { id: 'extensions', group: true }, { id: 'extensions', group: true, config: {} }]) {
      expect(() => findGroup([group], 'extensions', 'preset')).toThrow()
    }
    for (const bad of [null, 1, {}, { id: 1 }, { id: 'a' }, { id: 'a', name: 1 }]) {
      expect(() => findGroup([{ id: 'extensions', group: true, config: [bad] }], 'extensions', 'preset')).toThrow()
    }
  })

  it('copies only the target group and preserves expression identity', () => {
    const sibling = { id: 'other', disabled: { __jsExpr: 'ctx.test' } }
    const original = { id: 'tidebloom', plugins: [null, 1, {}, { id: 'extensions' }, sibling, { id: 'extensions', group: true, config: [] }] }
    const rows = [{ id: 'new', name: 'pkg' }]
    const changed = withGroup(original, 'extensions', rows)
    const plugins = changed.plugins as unknown[]
    expect(plugins).not.toBe(original.plugins)
    expect(plugins[4]).toBe(sibling)
    expect(plugins[5]).toEqual({ id: 'extensions', group: true, config: rows })
    expect(original.plugins[5]).toEqual({ id: 'extensions', group: true, config: [] })
  })

  it('collects nested group ids without treating ordinary configs as groups', () => {
    expect(allRowIds([null, 3, {}, { id: 1 }, { id: 'root', config: [{ id: 'ignored' }] }, { group: true, config: null }, { id: 'group', group: true, config: [{ id: 'nested' }] }])).toEqual(new Set(['root', 'group', 'nested']))
  })

  it('accepts installed package names but not paths or URLs', () => {
    for (const spec of ['pkg', '@scope/pkg']) expect(() => { validatePackageSpecifier(spec) }).not.toThrow()
    for (const spec of ['', '  ', './foo', '../foo', '/foo', 'node:fs']) expect(() => { validatePackageSpecifier(spec) }).toThrow()
  })

  it('accepts 1 to 16 uniquely named module tools and copies only declared fields', () => {
    const tool = { name: 'echo_tool', description: 'Echo.', parameters: { type: 'object' } }
    expect(readModuleTools([{ ...tool, extra: true }], 'echo')).toEqual([tool])
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ ...tool, name: `t${i}` }))
    expect(readModuleTools(sixteen, 'echo')).toHaveLength(16)
    expect(readModuleTools([{ ...tool, name: `a${'b'.repeat(63)}`, description: 'd'.repeat(2000) }], 'echo')).toHaveLength(1)
  })

  it.each([
    ['not an array', { tools: true }, 'tools must be an array of 1 to 16 tool declarations'],
    ['empty', [], 'tools must be an array of 1 to 16 tool declarations'],
    ['too long', Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, description: 'd', parameters: { type: 'object' } })), 'tools must be an array of 1 to 16'],
    ['a non-object entry', [null], 'tools[0] must be an object'],
    ['an array entry', [[]], 'tools[0] must be an object'],
    ['a non-string name', [{ name: 1 }], 'tools[0].name must match'],
    ['an invalid name', [{ name: '1tool' }], 'tools[0].name must match'],
    ['a name over 64 characters', [{ name: `a${'b'.repeat(64)}` }], 'tools[0].name must match'],
    ['a duplicate name', [{ name: 'a', description: 'd', parameters: { type: 'object' } }, { name: 'a' }], 'tool name "a" is declared more than once'],
    ['a missing description', [{ name: 'a' }], 'tools[0].description must be a non-empty string'],
    ['an empty description', [{ name: 'a', description: '' }], 'tools[0].description must be a non-empty string'],
    ['a long description', [{ name: 'a', description: 'd'.repeat(2001) }], 'tools[0].description must be a non-empty string of at most 2000 characters'],
    ['missing parameters', [{ name: 'a', description: 'd' }], 'tools[0].parameters must be a JSON Schema object'],
    ['array parameters', [{ name: 'a', description: 'd', parameters: [] }], 'tools[0].parameters must be a JSON Schema object'],
    ['non-object parameter schemas', [{ name: 'a', description: 'd', parameters: { type: 'string' } }], 'tools[0].parameters must be a JSON Schema object whose type is "object"'],
  ])('rejects module tools that are %s', (_case, value, reason) => {
    expect(() => readModuleTools(value, 'echo')).toThrow(`Self-extension module "echo" failed its sandboxed manifest check: ${reason}`)
  })

  it('reads sandboxed module rows and rejects malformed stored configs', () => {
    const config = { module: 'file:///m.mjs', dataDir: '/data/echo', write: 'none', tools: [{ name: 'a', description: 'd', parameters: { type: 'object' } }] }
    expect(readModuleRow({ id: 'pkg', name: 'pkg' })).toBeUndefined()
    expect(readModuleRow({ id: 'echo', name: SANDBOXED_MODULE_PLUGIN, config: { ...config, extra: 1 } })).toEqual(config)
    for (const bad of [undefined, { ...config, module: 1 }, { ...config, dataDir: null }, { ...config, write: 'all' }]) {
      expect(() => readModuleRow({ id: 'echo', name: SANDBOXED_MODULE_PLUGIN, ...(bad === undefined ? {} : { config: bad }) })).toThrow('Self-extension "echo" has a malformed sandboxed module config')
    }
    expect(() => readModuleRow({ id: 'echo', name: SANDBOXED_MODULE_PLUGIN, config: { ...config, tools: [] } })).toThrow('failed its sandboxed manifest check')
  })
})

describe('self-extension presentation', () => {
  it('presents reads and each mutation', () => {
    expect(presentSelfExtendCall({ action: 'list' })).toMatchObject({ card: 'generic', kind: 'read' })
    for (const action of ['add', 'update', 'remove']) {
      const args = { action, id: 'echo' }
      expect(presentSelfExtendCall(args)).toMatchObject({ card: 'generic', kind: 'other', rawInput: args })
    }
    expect(presentSelfExtendCall({ action: 'remove' }).title).not.toMatch(/\s$/)
  })
})
