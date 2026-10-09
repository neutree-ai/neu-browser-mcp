import { createKernelProvider } from './providers/kernel'
import { createNapProvider } from './providers/nap'
import type { BrowserProvider } from './types'

type Env = Record<string, string | undefined>

function required(env: Env, backend: string, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Backend "${backend}" needs ${name}`)
  return value
}

/**
 * Build the provider the standalone server runs with. `NEU_BROWSER_BACKEND`
 * picks the backend; each backend then reads its own variables.
 */
export function providerFromEnv(env: Env): BrowserProvider {
  const backend = env.NEU_BROWSER_BACKEND ?? 'nap'
  switch (backend) {
    case 'nap':
      return createNapProvider({
        baseUrl: required(env, backend, 'NAP_BROWSER_URL'),
        token: required(env, backend, 'NAP_BROWSER_TOKEN'),
        publicBaseUrl: env.NAP_BROWSER_PUBLIC_URL,
      })
    case 'kernel':
      return createKernelProvider({ apiKey: required(env, backend, 'KERNEL_API_KEY') })
    default:
      throw new Error(`Unknown NEU_BROWSER_BACKEND "${backend}". Supported: nap, kernel`)
  }
}
