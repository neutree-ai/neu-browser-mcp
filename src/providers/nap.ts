import type {
  BrowserFile,
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
  ListSessionsOptions,
} from '../types'
import { waitUntil } from '../wait'

export interface NapProviderConfig {
  /** Base URL of the browser service API, as reachable from this process. */
  baseUrl: string
  /** Bearer token for the browser service. A function is called once and cached. */
  token: string | (() => Promise<string>)
  /** Base URL used in file download links handed to users. Defaults to `baseUrl`. */
  publicBaseUrl?: string
  /** How long `createSession` waits for the browser to run and to expose CDP. */
  readyTimeoutMs?: number
  /** How long `listSessions` waits per browser to resolve its CDP WebSocket URL. */
  listResolveTimeoutMs?: number
  pollIntervalMs?: number
  /** Timeout of a single API request. */
  requestTimeoutMs?: number
  fetch?: typeof fetch
}

interface ApiSession {
  id: string
  status: string
  expires_at: string | null
  created_at: string | null
  endpoints?: {
    cdp: string | null
    live_view: string | null
  }
}

/**
 * Provider for the self-hosted browser service of Neutree Agent Platform.
 */
export function createNapProvider(config: NapProviderConfig): BrowserProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const publicBaseUrl = (config.publicBaseUrl ?? config.baseUrl).replace(/\/+$/, '')
  const readyTimeoutMs = config.readyTimeoutMs ?? 60_000
  const listResolveTimeoutMs = config.listResolveTimeoutMs ?? 8_000
  const pollIntervalMs = config.pollIntervalMs ?? 2_000
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000
  const doFetch = config.fetch ?? fetch

  let cachedToken: string | null = null
  async function getToken(): Promise<string> {
    if (cachedToken) return cachedToken
    cachedToken = typeof config.token === 'string' ? config.token : await config.token()
    return cachedToken
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getToken()
    const fetchOnce = () =>
      doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      })

    // A rejected fetch means no HTTP response arrived, so the request had no
    // effect and is safe to send once more. An HTTP error response is final.
    let res: Response
    try {
      res = await fetchOnce()
    } catch {
      res = await fetchOnce()
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Browser service ${res.status}: ${body}`)
    }
    return (await res.json()) as T
  }

  /**
   * The service reports the CDP WebSocket URL with its in-cluster host; swap in
   * the public origin of the session's CDP endpoint so clients can reach it.
   */
  async function resolveConnectUrl(
    id: string,
    cdpUrl: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const external = new URL(cdpUrl)
    return waitUntil(
      async () => {
        const info = await request<{ webSocketDebuggerUrl?: string }>(`/cdp/${id}/json/version`)
        if (!info.webSocketDebuggerUrl) return null
        const ws = new URL(info.webSocketDebuggerUrl)
        ws.protocol = external.protocol === 'https:' ? 'wss:' : 'ws:'
        ws.hostname = external.hostname
        ws.port = external.port
        return ws.toString()
      },
      { timeoutMs, intervalMs: pollIntervalMs },
    )
  }

  async function toSession(
    api: ApiSession,
    status: string,
    resolveTimeoutMs: number,
  ): Promise<BrowserSession> {
    const qs = `?token=${encodeURIComponent(await getToken())}`
    const cdpUrl = api.endpoints?.cdp ? `${api.endpoints.cdp}${qs}` : null
    const liveViewUrl = api.endpoints?.live_view ? `${api.endpoints.live_view}${qs}` : null
    const running = status === 'running'
    return {
      id: api.id,
      status,
      createdAt: api.created_at,
      expiresAt: api.expires_at,
      connectUrl:
        running && cdpUrl ? await resolveConnectUrl(api.id, cdpUrl, resolveTimeoutMs) : null,
      cdpUrl,
      liveViewUrl,
    }
  }

  return {
    name: 'nap',

    capabilities: {
      timeout: { defaultSeconds: 3600, maxSeconds: 86400 },
      liveView: true,
      httpCdp: true,
      metadata: true,
    },

    async createSession(opts?: CreateSessionOptions): Promise<BrowserSession> {
      const created = await request<ApiSession>('/api/browsers', {
        method: 'POST',
        body: JSON.stringify({
          timeout_seconds: opts?.timeoutSeconds,
          metadata: opts?.metadata,
        }),
      })
      const running = await waitUntil(
        async () => {
          const current = await request<ApiSession>(`/api/browsers/${created.id}`)
          return current.status.toLowerCase() === 'running'
        },
        { timeoutMs: readyTimeoutMs, intervalMs: pollIntervalMs },
      )
      const status = running ? 'running' : created.status.toLowerCase()
      return toSession(created, status, readyTimeoutMs)
    },

    async listSessions(opts?: ListSessionsOptions): Promise<BrowserSession[]> {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(opts?.metadata ?? {})) {
        params.set(`metadata.${k}`, v)
      }
      const qs = params.toString()
      const { items } = await request<{ items: ApiSession[] }>(`/api/browsers${qs ? `?${qs}` : ''}`)
      // The list response omits endpoints, so read each browser for them. A short
      // per-browser timeout keeps one stuck browser from stalling the list.
      return Promise.all(
        items.map(async (item) => {
          const detail = item.endpoints
            ? item
            : await request<ApiSession>(`/api/browsers/${item.id}`).catch(() => item)
          return toSession(detail, item.status.toLowerCase(), listResolveTimeoutMs)
        }),
      )
    },

    async releaseSession(id: string): Promise<void> {
      await request(`/api/browsers/${id}`, { method: 'DELETE' })
    },

    files: {
      // The browser's user cannot create a directory at the filesystem root, so a
      // download aimed there is cancelled; /tmp is writable.
      defaultPath: '/tmp/downloads',

      async list(sessionId: string, path: string, pattern?: string): Promise<BrowserFile[]> {
        const params = new URLSearchParams({ path })
        if (pattern) params.set('pattern', pattern)
        const { files } = await request<{ files: BrowserFile[] }>(
          `/api/browsers/${sessionId}/files?${params.toString()}`,
        )
        return files.map((f) => ({ path: f.path, size: f.size, modifiedAt: f.modifiedAt }))
      },

      async downloadUrl(sessionId: string, path: string): Promise<string> {
        const params = new URLSearchParams({ path, token: await getToken() })
        return `${publicBaseUrl}/api/browsers/${sessionId}/files/content?${params.toString()}`
      },
    },
  }
}
