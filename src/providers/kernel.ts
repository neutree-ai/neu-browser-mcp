import type {
  BrowserFile,
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
  ListSessionsOptions,
} from '../types'

export interface KernelProviderConfig {
  apiKey: string
  /** Defaults to Kernel's public API. */
  baseUrl?: string
  /** Timeout of a single API request. */
  requestTimeoutMs?: number
  fetch?: typeof fetch
}

interface ApiBrowser {
  session_id: string
  cdp_ws_url: string
  browser_live_view_url?: string
  created_at?: string
}

interface ApiFile {
  path: string
  name: string
  is_dir: boolean
  size_bytes?: number
  mod_time?: string
}

/** Match a file name against a glob with `*` and `?`. */
function matches(name: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(name)
}

// Kernel's own default is 60 seconds of inactivity, which a browser can spend
// just waiting for its agent's next step. An hour matches how agents work.
const DEFAULT_TIMEOUT_SECONDS = 3600
const PAGE_SIZE = 100

function toSession(api: ApiBrowser): BrowserSession {
  return {
    id: api.session_id,
    // Kernel hands out a browser once it is up, and lists only live ones.
    status: 'running',
    createdAt: api.created_at ?? null,
    // The timeout counts inactivity, so there is no fixed expiry to report.
    expiresAt: null,
    connectUrl: api.cdp_ws_url,
    cdpUrl: null,
    liveViewUrl: api.browser_live_view_url ?? null,
  }
}

/**
 * Provider for Kernel's hosted browsers (https://www.kernel.sh).
 */
export function createKernelProvider(config: KernelProviderConfig): BrowserProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.onkernel.com').replace(/\/+$/, '')
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000
  const doFetch = config.fetch ?? fetch

  // No retry: a create that reached Kernel but lost its response would be
  // repeated as a second, billed browser.
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...init?.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Kernel ${res.status}: ${body}`)
    }
    return res
  }

  return {
    name: 'kernel',

    capabilities: {
      timeout: { kind: 'idle', defaultSeconds: DEFAULT_TIMEOUT_SECONDS, maxSeconds: 259_200 },
      liveView: true,
      httpCdp: false,
      metadata: true,
    },

    async createSession(opts?: CreateSessionOptions): Promise<BrowserSession> {
      const res = await request('/browsers', {
        method: 'POST',
        body: JSON.stringify({
          timeout_seconds: opts?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
          tags: opts?.metadata,
        }),
      })
      return toSession((await res.json()) as ApiBrowser)
    },

    async listSessions(opts?: ListSessionsOptions): Promise<BrowserSession[]> {
      const sessions: BrowserSession[] = []
      let offset = 0
      while (true) {
        const params = new URLSearchParams({
          status: 'active',
          limit: String(PAGE_SIZE),
          offset: String(offset),
        })
        for (const [k, v] of Object.entries(opts?.metadata ?? {})) {
          params.set(`tags[${k}]`, v)
        }
        const res = await request(`/browsers?${params.toString()}`)
        const page = (await res.json()) as ApiBrowser[]
        sessions.push(...page.map(toSession))

        if (res.headers.get('X-Has-More') !== 'true') return sessions
        const next = Number(res.headers.get('X-Next-Offset'))
        // Stop rather than loop forever if the service stops advancing.
        if (!(next > offset)) return sessions
        offset = next
      }
    },

    async releaseSession(id: string): Promise<void> {
      await request(`/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    // Kernel serves file contents only to a caller holding the API key, so it
    // offers `read` and no `downloadUrl`.
    files: {
      defaultPath: '/tmp/downloads',

      async list(sessionId: string, path: string, pattern?: string): Promise<BrowserFile[]> {
        const params = new URLSearchParams({ path })
        let res: Response
        try {
          res = await request(
            `/browsers/${encodeURIComponent(sessionId)}/fs/list_files?${params.toString()}`,
          )
        } catch (e) {
          // The download directory does not exist until the first download lands.
          if (e instanceof Error && e.message.includes('directory not found')) return []
          throw e
        }
        const entries = (await res.json()) as ApiFile[]
        return entries
          .filter((f) => !f.is_dir && (!pattern || matches(f.name, pattern)))
          .map((f) => ({ path: f.path, size: f.size_bytes, modifiedAt: f.mod_time }))
      },

      read(sessionId: string, path: string): Promise<Response> {
        const params = new URLSearchParams({ path })
        return request(
          `/browsers/${encodeURIComponent(sessionId)}/fs/read_file?${params.toString()}`,
        )
      },
    },
  }
}
