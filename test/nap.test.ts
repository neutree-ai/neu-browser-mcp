import { describe, expect, it } from 'vitest'
import { createNapProvider } from '../src/providers/nap'

type Handler = (url: URL, init: RequestInit) => unknown

/** A fetch stand-in that records calls and answers each with `handler`'s JSON. */
function fakeFetch(handler: Handler) {
  const calls: { method: string; url: URL; body: unknown; auth: string | null }[] = []
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get('authorization'),
    })
    const result = handler(url, init)
    if (result instanceof Response) return result
    return Response.json(result)
  }
  return { fetch: impl as typeof fetch, calls }
}

const endpoints = {
  cdp: 'https://browser.example.com/cdp/b1',
  live_view: 'https://browser.example.com/live/b1/',
}

function provider(handler: Handler, token: string | (() => Promise<string>) = 'tok') {
  const fake = fakeFetch(handler)
  return {
    ...fake,
    provider: createNapProvider({
      baseUrl: 'http://browser.internal:3005/',
      publicBaseUrl: 'https://browser.example.com',
      token,
      fetch: fake.fetch,
      pollIntervalMs: 1,
      readyTimeoutMs: 50,
      listResolveTimeoutMs: 20,
    }),
  }
}

describe('nap provider', () => {
  it('creates a browser, waits for it to run, and resolves a public CDP WebSocket URL', async () => {
    let polls = 0
    const { provider: p, calls } = provider((url, init) => {
      if (init.method === 'POST') {
        return { id: 'b1', status: 'Pending', expires_at: 'E', created_at: 'C', endpoints }
      }
      if (url.pathname === '/api/browsers/b1') {
        polls++
        return { id: 'b1', status: polls > 1 ? 'Running' : 'Pending', endpoints }
      }
      if (url.pathname === '/cdp/b1/json/version') {
        return { webSocketDebuggerUrl: 'ws://10.0.0.5:9222/cdp/b1/devtools/browser/x?token=tok' }
      }
      throw new Error(`unexpected ${url}`)
    })

    const session = await p.createSession({ timeoutSeconds: 600, metadata: { ws: 'w1' } })

    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { timeout_seconds: 600, metadata: { ws: 'w1' } },
      auth: 'Bearer tok',
    })
    expect(calls[0].url.href).toBe('http://browser.internal:3005/api/browsers')
    expect(session).toEqual({
      id: 'b1',
      status: 'running',
      createdAt: 'C',
      expiresAt: 'E',
      connectUrl: 'wss://browser.example.com/cdp/b1/devtools/browser/x?token=tok',
      cdpUrl: 'https://browser.example.com/cdp/b1?token=tok',
      liveViewUrl: 'https://browser.example.com/live/b1/?token=tok',
    })
  })

  it('returns a null connectUrl when the browser never reaches running', async () => {
    const { provider: p, calls } = provider((_url, init) => {
      if (init.method === 'POST') return { id: 'b1', status: 'Pending', endpoints }
      return { id: 'b1', status: 'Pending', endpoints }
    })

    const session = await p.createSession()

    expect(session.status).toBe('pending')
    expect(session.connectUrl).toBeNull()
    expect(session.cdpUrl).toBe('https://browser.example.com/cdp/b1?token=tok')
    expect(calls.some((c) => c.url.pathname.includes('/json/version'))).toBe(false)
  })

  it('lists browsers filtered by metadata and fills in endpoints the list omits', async () => {
    const { provider: p, calls } = provider((url) => {
      if (url.pathname === '/api/browsers') {
        return {
          items: [
            { id: 'b1', status: 'Running', expires_at: 'E', created_at: 'C' },
            { id: 'b2', status: 'Pending', expires_at: 'E', created_at: 'C' },
          ],
        }
      }
      if (url.pathname === '/api/browsers/b1') return { id: 'b1', status: 'Running', endpoints }
      if (url.pathname === '/api/browsers/b2') return { id: 'b2', status: 'Pending' }
      if (url.pathname === '/cdp/b1/json/version') {
        return { webSocketDebuggerUrl: 'ws://10.0.0.5:9222/devtools/browser/x' }
      }
      throw new Error(`unexpected ${url}`)
    })

    const sessions = await p.listSessions({ metadata: { 'browser.workspace_id': 'w1' } })

    expect(calls[0].url.search).toBe('?metadata.browser.workspace_id=w1')
    expect(sessions.map((s) => [s.id, s.status, s.connectUrl])).toEqual([
      ['b1', 'running', 'wss://browser.example.com/devtools/browser/x'],
      ['b2', 'pending', null],
    ])
  })

  it('releases a browser', async () => {
    const { provider: p, calls } = provider(() => ({ success: true }))
    await p.releaseSession('b1')
    expect(calls[0]).toMatchObject({ method: 'DELETE' })
    expect(calls[0].url.pathname).toBe('/api/browsers/b1')
  })

  it('surfaces HTTP errors without retrying, and retries once when no response arrived', async () => {
    const failing = provider(() => new Response('nope', { status: 404 }))
    await expect(failing.provider.releaseSession('b1')).rejects.toThrow('Browser service 404: nope')
    expect(failing.calls).toHaveLength(1)

    let attempts = 0
    const flaky = provider(() => {
      attempts++
      if (attempts === 1) throw new TypeError('fetch failed')
      return { success: true }
    })
    await flaky.provider.releaseSession('b1')
    expect(attempts).toBe(2)
  })

  it('lists files and builds a public download URL carrying the token', async () => {
    let tokenCalls = 0
    const { provider: p, calls } = provider(
      () => ({ files: [{ path: '/downloads/a.pdf', size: 3, modifiedAt: 'M', mode: 420 }] }),
      async () => {
        tokenCalls++
        return 'lazy tok'
      },
    )

    const files = await p.files?.list('b1', '/downloads', '*.pdf')
    const url = await p.files?.downloadUrl('b1', '/downloads/a.pdf')

    expect(calls[0].url.search).toBe('?path=%2Fdownloads&pattern=*.pdf')
    expect(calls[0].auth).toBe('Bearer lazy tok')
    expect(files).toEqual([{ path: '/downloads/a.pdf', size: 3, modifiedAt: 'M' }])
    expect(url).toBe(
      'https://browser.example.com/api/browsers/b1/files/content?path=%2Fdownloads%2Fa.pdf&token=lazy+tok',
    )
    expect(tokenCalls).toBe(1)
  })
})
