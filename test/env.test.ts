import { describe, expect, it } from 'vitest'
import { providerFromEnv } from '../src/env'

const nap = { NAP_BROWSER_URL: 'https://browser.example.com', NAP_BROWSER_TOKEN: 'tok' }

describe('providerFromEnv', () => {
  it('builds the nap backend by default and when named', () => {
    expect(providerFromEnv(nap).name).toBe('nap')
    expect(providerFromEnv({ ...nap, NEU_BROWSER_BACKEND: 'nap' }).name).toBe('nap')
  })

  it('builds the kernel backend when named', () => {
    const env = { NEU_BROWSER_BACKEND: 'kernel', KERNEL_API_KEY: 'k' }
    expect(providerFromEnv(env).name).toBe('kernel')
    expect(() => providerFromEnv({ NEU_BROWSER_BACKEND: 'kernel' })).toThrow(
      'Backend "kernel" needs KERNEL_API_KEY',
    )
  })

  it('names the variable a backend is missing', () => {
    expect(() => providerFromEnv({ NAP_BROWSER_URL: 'https://browser.example.com' })).toThrow(
      'Backend "nap" needs NAP_BROWSER_TOKEN',
    )
  })

  it('rejects a backend it does not know', () => {
    expect(() => providerFromEnv({ ...nap, NEU_BROWSER_BACKEND: 'other' })).toThrow(
      'Unknown NEU_BROWSER_BACKEND "other". Supported: nap, kernel',
    )
  })
})
