import type {
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
  ListSessionsOptions,
} from '../types'

export interface BrowserUseProviderConfig {
  apiKey: string
  /** Defaults to Browser Use Cloud's public API. */
  baseUrl?: string
  /** Timeout of a single API request. */
  requestTimeoutMs?: number
  fetch?: typeof fetch
}

interface ApiBrowser {
  id: string
  status: string
  cdpUrl: string | null
  liveUrl: string | null
  timeoutAt: string | null
  startedAt: string | null
}

const DEFAULT_TIMEOUT_SECONDS = 3600
const MAX_TIMEOUT_SECONDS = 240 * 60
const PAGE_SIZE = 100

/**
 * Provider for Browser Use Cloud's hosted browsers (https://browser-use.com).
 */
export function createBrowserUseProvider(config: BrowserUseProviderConfig): BrowserProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.browser-use.com/api/v2').replace(/\/+$/, '')
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
        'X-Browser-Use-API-Key': config.apiKey,
        ...init?.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Browser Use ${res.status}: ${body}`)
    }
    return (await res.json()) as T
  }

  /** The service gives CDP over HTTP; ask that endpoint for its WebSocket URL. */
  async function resolveConnectUrl(cdpUrl: string | null): Promise<string | null> {
    if (!cdpUrl) return null
    if (/^wss?:\/\//.test(cdpUrl)) return cdpUrl
    try {
      const res = await doFetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null
      const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string }
      return webSocketDebuggerUrl ?? null
    } catch {
      return null
    }
  }

  async function toSession(api: ApiBrowser, connectInfo = true): Promise<BrowserSession> {
    const running = api.status === 'active'
    return {
      id: api.id,
      status: running ? 'running' : api.status,
      createdAt: api.startedAt,
      expiresAt: api.timeoutAt,
      connectUrl: running && connectInfo ? await resolveConnectUrl(api.cdpUrl) : null,
      cdpUrl: /^https?:\/\//.test(api.cdpUrl ?? '') ? api.cdpUrl : null,
      liveViewUrl: api.liveUrl,
    }
  }

  return {
    name: 'browser-use',

    capabilities: {
      timeout: {
        kind: 'absolute',
        defaultSeconds: DEFAULT_TIMEOUT_SECONDS,
        maxSeconds: MAX_TIMEOUT_SECONDS,
      },
      liveView: true,
      httpCdp: true,
      metadata: true,
    },

    async createSession(opts?: CreateSessionOptions): Promise<BrowserSession> {
      const seconds = Math.min(opts?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
      const created = await request<ApiBrowser>('/browsers', {
        method: 'POST',
        body: JSON.stringify({
          // The service counts in minutes.
          timeout: Math.max(1, Math.ceil(seconds / 60)),
          metadata: opts?.metadata,
        }),
      })
      return toSession(created)
    },

    async listSessions(opts?: ListSessionsOptions): Promise<BrowserSession[]> {
      const items: ApiBrowser[] = []
      for (let pageNumber = 1; ; pageNumber++) {
        const params = new URLSearchParams({
          filterBy: 'active',
          pageSize: String(PAGE_SIZE),
          pageNumber: String(pageNumber),
        })
        for (const [k, v] of Object.entries(opts?.metadata ?? {})) {
          params.append('metadata', `${k}=${v}`)
        }
        const page = await request<{ items: ApiBrowser[]; totalItems: number }>(
          `/browsers?${params.toString()}`,
        )
        items.push(...page.items)
        if (page.items.length === 0 || items.length >= page.totalItems) break
      }
      return Promise.all(items.map((item) => toSession(item, opts?.connectInfo !== false)))
    },

    async releaseSession(id: string): Promise<void> {
      await request(`/browsers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'stop' }),
      })
    },
  }
}
