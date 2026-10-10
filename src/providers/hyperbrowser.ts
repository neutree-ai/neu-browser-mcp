import type {
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
  ListSessionsOptions,
} from '../types'

export interface HyperbrowserProviderConfig {
  apiKey: string
  /** Defaults to Hyperbrowser's public API. */
  baseUrl?: string
  /** Timeout of a single API request. */
  requestTimeoutMs?: number
  fetch?: typeof fetch
}

interface ApiSession {
  id: string
  status: string
  createdAt?: string
  wsEndpoint?: string
  liveUrl?: string
}

const DEFAULT_TIMEOUT_SECONDS = 3600
const MAX_TIMEOUT_SECONDS = 720 * 60

function toSession(api: ApiSession): BrowserSession {
  const running = api.status === 'active'
  let connectUrl: string | null = null
  if (running && api.wsEndpoint) {
    // Without keepAlive the service stops the browser when a client
    // disconnects, and an agent connects and disconnects many times.
    const url = new URL(api.wsEndpoint)
    url.searchParams.set('keepAlive', 'true')
    connectUrl = url.toString()
  }
  return {
    id: api.id,
    status: running ? 'running' : api.status,
    createdAt: api.createdAt ?? null,
    // The service reports no expiry time.
    expiresAt: null,
    connectUrl,
    cdpUrl: null,
    liveViewUrl: api.liveUrl ?? null,
  }
}

/**
 * Provider for Hyperbrowser's hosted browsers (https://hyperbrowser.ai).
 */
export function createHyperbrowserProvider(config: HyperbrowserProviderConfig): BrowserProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.hyperbrowser.ai').replace(/\/+$/, '')
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000
  const doFetch = config.fetch ?? fetch

  // No retry: a create that reached the service but lost its response would
  // be repeated as a second, billed browser.
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        ...init?.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Hyperbrowser ${res.status}: ${body}`)
    }
    return (await res.json()) as T
  }

  function refuseMetadata(metadata?: Record<string, string>) {
    if (metadata && Object.keys(metadata).length > 0) {
      throw new Error('Hyperbrowser sessions cannot carry metadata')
    }
  }

  return {
    name: 'hyperbrowser',

    capabilities: {
      timeout: {
        kind: 'absolute',
        defaultSeconds: DEFAULT_TIMEOUT_SECONDS,
        maxSeconds: MAX_TIMEOUT_SECONDS,
      },
      liveView: true,
      httpCdp: false,
      metadata: false,
    },

    async createSession(opts?: CreateSessionOptions): Promise<BrowserSession> {
      refuseMetadata(opts?.metadata)
      const seconds = Math.min(opts?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
      const created = await request<ApiSession>('/api/session', {
        method: 'POST',
        // The service counts in minutes.
        body: JSON.stringify({ timeoutMinutes: Math.max(1, Math.ceil(seconds / 60)) }),
      })
      return toSession(created)
    },

    async listSessions(opts?: ListSessionsOptions): Promise<BrowserSession[]> {
      refuseMetadata(opts?.metadata)
      const listed: ApiSession[] = []
      for (let page = 1; ; page++) {
        const result = await request<{ sessions: ApiSession[]; totalCount: number }>(
          `/api/sessions?status=active&page=${page}`,
        )
        listed.push(...result.sessions)
        if (result.sessions.length === 0 || listed.length >= result.totalCount) break
      }
      if (opts?.connectInfo === false) return listed.map(toSession)
      // The list carries no connection info, so read each session for it.
      return Promise.all(
        listed.map(async (item) =>
          toSession(
            await request<ApiSession>(`/api/session/${encodeURIComponent(item.id)}`).catch(
              () => item,
            ),
          ),
        ),
      )
    },

    async releaseSession(id: string): Promise<void> {
      await request(`/api/session/${encodeURIComponent(id)}/stop`, { method: 'PUT' })
    },
  }
}
