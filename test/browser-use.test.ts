import { describe, expect, it } from 'vitest'
import { createBrowserUseProvider } from '../src/providers/browser-use'

type Reply = { body?: unknown; status?: number }

function provider(handler: (url: URL, init: RequestInit) => Reply) {
  const calls: { method: string; url: URL; body: unknown; key: string | null }[] = []
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      key: new Headers(init.headers).get('x-browser-use-api-key'),
    })
    const { body, status = 200 } = handler(url, init)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
  return { calls, provider: createBrowserUseProvider({ apiKey: 'key', fetch: fakeFetch }) }
}

const browser = (id: string, extra: object = {}) => ({
  id,
  status: 'active',
  cdpUrl: `https://${id}.cdp.example.com`,
  liveUrl: `https://live.example.com/${id}`,
  timeoutAt: 'T',
  startedAt: 'S',
  ...extra,
})
const version = (url: URL) => ({
  body: { webSocketDebuggerUrl: `wss://${url.hostname}/devtools/browser/1` },
})

describe('browser-use provider', () => {
  it('creates a browser, counting the timeout in minutes, and resolves its WebSocket URL', async () => {
    const { provider: p, calls } = provider((url) =>
      url.pathname === '/json/version' ? version(url) : { body: browser('b1'), status: 201 },
    )

    const session = await p.createSession({ timeoutSeconds: 90, metadata: { ws: 'w1' } })

    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { timeout: 2, metadata: { ws: 'w1' } },
      key: 'key',
    })
    expect(calls[0].url.href).toBe('https://api.browser-use.com/api/v2/browsers')
    expect(calls[1].key).toBeNull()
    expect(session).toEqual({
      id: 'b1',
      status: 'running',
      createdAt: 'S',
      expiresAt: 'T',
      connectUrl: 'wss://b1.cdp.example.com/devtools/browser/1',
      cdpUrl: 'https://b1.cdp.example.com',
      liveViewUrl: 'https://live.example.com/b1',
    })
  })

  it('defaults to an hour and caps the timeout at four hours', async () => {
    const { provider: p, calls } = provider((url) =>
      url.pathname === '/json/version' ? version(url) : { body: browser('b1') },
    )
    await p.createSession()
    await p.createSession({ timeoutSeconds: 86400 })
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { timeout: 60 },
      { timeout: 240 },
    ])
  })

  it('uses a WebSocket CDP URL as it is, and leaves the connect URL null when it cannot be resolved', async () => {
    const ws = provider(() => ({ body: browser('b1', { cdpUrl: 'wss://cdp.example.com/b1' }) }))
    const direct = await ws.provider.createSession()
    expect(direct.connectUrl).toBe('wss://cdp.example.com/b1')
    expect(direct.cdpUrl).toBeNull()
    expect(ws.calls).toHaveLength(1)

    const down = provider((url) =>
      url.pathname === '/json/version' ? { status: 502, body: 'x' } : { body: browser('b1') },
    )
    expect((await down.provider.createSession()).connectUrl).toBeNull()
  })

  it('lists active browsers by metadata across pages', async () => {
    const { provider: p, calls } = provider((url) => {
      if (url.pathname === '/json/version') return version(url)
      return url.searchParams.get('pageNumber') === '1'
        ? { body: { items: [browser('b1')], totalItems: 2 } }
        : { body: { items: [browser('b2')], totalItems: 2 } }
    })

    const sessions = await p.listSessions({ metadata: { ws: 'w1', env: 'prod' } })

    expect(sessions.map((s) => s.id)).toEqual(['b1', 'b2'])
    const lists = calls.filter((c) => c.url.pathname.endsWith('/browsers'))
    expect(lists.map((c) => c.url.search)).toEqual([
      '?filterBy=active&pageSize=100&pageNumber=1&metadata=ws%3Dw1&metadata=env%3Dprod',
      '?filterBy=active&pageSize=100&pageNumber=2&metadata=ws%3Dw1&metadata=env%3Dprod',
    ])
  })

  it('lists without resolving WebSocket URLs when only identity is wanted', async () => {
    const { provider: p, calls } = provider(() => ({
      body: { items: [browser('b1')], totalItems: 1 },
    }))
    const sessions = await p.listSessions({ connectInfo: false })
    expect(sessions.map((s) => [s.id, s.connectUrl])).toEqual([['b1', null]])
    expect(calls).toHaveLength(1)
  })

  it('stops a browser, and surfaces API errors', async () => {
    const ok = provider(() => ({ body: browser('b1', { status: 'stopped' }) }))
    await ok.provider.releaseSession('b1')
    expect(ok.calls[0]).toMatchObject({ method: 'PATCH', body: { action: 'stop' } })
    expect(ok.calls[0].url.pathname).toBe('/api/v2/browsers/b1')

    const failing = provider(() => ({ status: 402, body: 'no credits' }))
    await expect(failing.provider.createSession()).rejects.toThrow('Browser Use 402: no credits')
  })
})
