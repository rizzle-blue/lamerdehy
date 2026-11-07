import { describe, expect, it } from 'vitest'
import { clearProgramEnvironment } from '../src/environment.ts'

/** A stand-in for the native process: only its `env` is replaced. */
function processWith(values: Record<string, string>): { env: NodeJS.ProcessEnv } {
  return { env: { ...values } }
}

describe('clearProgramEnvironment', () => {
  it('removes inherited credentials and keeps nothing the sandbox did not supply', () => {
    const state = processWith({ PATH: '/bin', SECRET_TOKEN: 'leak', HOME: '/home/u' })
    clearProgramEnvironment(state)
    expect(Object.keys(state.env)).toEqual([])
  })

  it('keeps the network settings of the confining sandbox so Node still reaches its proxy', () => {
    const proxy = { HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }
    const state = processWith({ ...proxy, SECRET_TOKEN: 'leak' })
    clearProgramEnvironment(state)
    expect({ ...state.env }).toEqual(proxy)
    expect(state.env.SECRET_TOKEN).toBeUndefined()
  })
})
