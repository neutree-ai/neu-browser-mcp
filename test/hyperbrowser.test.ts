import { describe, expect, it } from 'vitest'
import { createHyperbrowserProvider } from '../src/providers/hyperbrowser'

type Reply = { body?: unknown; status?: number }

function provider(handler: (url: URL, init: RequestInit) => Reply) {
  const calls: { method: string; url: URL; body: unknown; key: string | null }[] = []
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      key: new Headers(init.headers).get('x-api-key'),
    })
    const { body, status = 200 } = handler(url, init)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
  return { calls, provider: createHyperbrowserProvider({ apiKey: 'key', fetch: fakeFetch }) }
}

const detail = (id: string) => ({
  id,
  status: 'active',
  createdAt: 'C',
  wsEndpoint: `wss://connect.example.com/?token=${id}`,
  liveUrl: `https://live.example.com/?token=${id}`,
})

describe('hyperbrowser provider', () => {
  it('declares that sessions carry no metadata', () => {
    expect(provider(() => ({})).provider.capabilities).toEqual({
      timeout: { kind: 'absolute', defaultSeconds: 3600, maxSeconds: 43200 },
      liveView: true,
      httpCdp: false,
      metadata: false,
    })
  })

  it('creates a session and asks the browser to outlive disconnects', async () => {
    const { provider: p, calls } = provider(() => ({ body: detail('s1') }))

    const session = await p.createSession({ timeoutSeconds: 600 })

    expect(calls[0]).toMatchObject({ method: 'POST', body: { timeoutMinutes: 10 }, key: 'key' })
    expect(calls[0].url.href).toBe('https://api.hyperbrowser.ai/api/session')
    expect(session).toEqual({
      id: 's1',
      status: 'running',
      createdAt: 'C',
      expiresAt: null,
      connectUrl: 'wss://connect.example.com/?token=s1&keepAlive=true',
      cdpUrl: null,
      liveViewUrl: 'https://live.example.com/?token=s1',
    })
  })

  it('refuses metadata instead of dropping it', async () => {
    const { provider: p, calls } = provider(() => ({ body: detail('s1') }))
    await expect(p.createSession({ metadata: { ws: 'w1' } })).rejects.toThrow(
      'cannot carry metadata',
    )
    await expect(p.listSessions({ metadata: { ws: 'w1' } })).rejects.toThrow(
      'cannot carry metadata',
    )
    expect(calls).toHaveLength(0)
  })

  it('lists active sessions across pages and reads each for its connection info', async () => {
    const { provider: p, calls } = provider((url) => {
      if (url.pathname === '/api/sessions') {
        const page = url.searchParams.get('page')
        return {
          body: {
            sessions: [{ id: page === '1' ? 's1' : 's2', status: 'active' }],
            totalCount: 2,
          },
        }
      }
      return { body: detail(url.pathname.split('/').pop() as string) }
    })

    const sessions = await p.listSessions()

    expect(sessions.map((s) => [s.id, s.connectUrl])).toEqual([
      ['s1', 'wss://connect.example.com/?token=s1&keepAlive=true'],
      ['s2', 'wss://connect.example.com/?token=s2&keepAlive=true'],
    ])
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual([
      '/api/sessions?status=active&page=1',
      '/api/sessions?status=active&page=2',
      '/api/session/s1',
      '/api/session/s2',
    ])
  })

  it('stops a session, and surfaces API errors', async () => {
    const ok = provider(() => ({ body: { success: true } }))
    await ok.provider.releaseSession('s1')
    expect(ok.calls[0].method).toBe('PUT')
    expect(ok.calls[0].url.pathname).toBe('/api/session/s1/stop')

    const failing = provider(() => ({ status: 401, body: 'bad key' }))
    await expect(failing.provider.createSession()).rejects.toThrow('Hyperbrowser 401: bad key')
  })
})
