export interface CreateSessionOptions {
  /** Lifetime of the browser before the provider reclaims it. */
  timeoutSeconds?: number
  /** Tags recorded on the session; `listSessions` can filter on them. */
  metadata?: Record<string, string>
}

export interface ListSessionsOptions {
  /** Only return sessions carrying every one of these tags. */
  metadata?: Record<string, string>
}

export interface BrowserSession {
  id: string
  /** Provider-reported state, lower-cased (e.g. `running`, `pending`). */
  status: string
  createdAt: string | null
  expiresAt: string | null
  /** CDP WebSocket URL. Null until the browser is reachable. */
  connectUrl: string | null
  /** CDP HTTP endpoint, for clients that discover the WebSocket URL themselves. */
  cdpUrl: string | null
  /** URL a human can open to watch the browser. */
  liveViewUrl: string | null
}

export interface BrowserFile {
  path: string
  size?: number
  modifiedAt?: string
}

/**
 * Access to files the browser wrote, such as downloads. Listing is the base;
 * `downloadUrl` and `read` are separate, optional ways to get at a file, and a
 * backend offers whichever it really has.
 */
export interface BrowserFiles {
  /** Directory listed when the caller gives no path. */
  readonly defaultPath: string
  list(sessionId: string, path: string, pattern?: string): Promise<BrowserFile[]>
  /**
   * A URL that downloads the file without further credentials, for handing to
   * a user. Only for backends that can issue one.
   */
  downloadUrl?(sessionId: string, path: string): Promise<string>
  /**
   * Fetch the file's contents, with the backend's credentials added, for
   * returning to the agent.
   */
  read?(sessionId: string, path: string): Promise<Response>
}

/**
 * What a backend supports beyond the session lifecycle. The tool layer reads
 * this to describe the tools accurately and to refuse setups the backend
 * cannot honor. File access is declared by the presence of `files`.
 */
export interface ProviderCapabilities {
  /**
   * Session lifetime when the caller gives none, and the longest it may ask
   * for. `absolute` counts from creation; `idle` counts time with no activity.
   */
  timeout: { kind: 'absolute' | 'idle'; defaultSeconds: number; maxSeconds: number }
  /** Sessions carry a `liveViewUrl` a human can open. */
  liveView: boolean
  /** Sessions carry a `cdpUrl`, a CDP endpoint over HTTP next to the WebSocket one. */
  httpCdp: boolean
  /** Sessions can be tagged with metadata and listed by it. Required to use a scope. */
  metadata: boolean
}

/**
 * A backend that hands out remote browsers. The only contract is the session
 * lifecycle plus a CDP URL; everything else is declared in `capabilities` or by
 * an optional member, and the tool layer adapts to what is declared.
 */
export interface BrowserProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  /** Resolves once the browser is reachable, or with `connectUrl: null` if it is not yet. */
  createSession(opts?: CreateSessionOptions): Promise<BrowserSession>
  /** Active sessions. Connection info is best-effort and may be null. */
  listSessions(opts?: ListSessionsOptions): Promise<BrowserSession[]>
  releaseSession(id: string): Promise<void>
  readonly files?: BrowserFiles
}
