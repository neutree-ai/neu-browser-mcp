import { describe, expect, it } from 'vitest'
import { createKernelProvider } from '../src/providers/kernel'

type Reply = { body?: unknown; status?: number; headers?: Record<string, string> }

function provider(handler: (url: URL, init: RequestInit) => Reply) {
  const calls: { method: string; url: URL; body: unknown; auth: string | null }[] = []
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get('authorization'),
    })
    const { body, status = 200, headers } = handler(url, init)
    if (status === 204) return new Response(null, { status })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  }) as typeof fetch
  return { calls, provider: createKernelProvider({ apiKey: 'key', fetch: fakeFetch }) }
}

const browser = (id: string) => ({
  session_id: id,
  cdp_ws_url: `wss://cdp.example.com/${id}?jwt=x`,
  browser_live_view_url: `https://live.example.com/${id}`,
  created_at: 'C',
})

describe('kernel provider', () => {
  it('declares an idle timeout, live view and metadata, and files it can list and read', () => {
    const { provider: p } = provider(() => ({ body: {} }))
    expect(p.capabilities).toEqual({
      timeout: { kind: 'idle', defaultSeconds: 3600, maxSeconds: 259200 },
      liveView: true,
      httpCdp: false,
      metadata: true,
    })
    expect(p.files?.defaultPath).toBe('/tmp/downloads')
    expect(p.files?.downloadUrl).toBeUndefined()
    expect(p.files?.read).toBeTypeOf('function')
  })

  it('creates a browser with tags and an hour of idle time by default', async () => {
    const { provider: p, calls } = provider(() => ({ body: browser('s1') }))

    const session = await p.createSession({ metadata: { 'browser.workspace_id': 'w1' } })

    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { timeout_seconds: 3600, tags: { 'browser.workspace_id': 'w1' } },
      auth: 'Bearer key',
    })
    expect(calls[0].url.href).toBe('https://api.onkernel.com/browsers')
    expect(session).toEqual({
      id: 's1',
      status: 'running',
      createdAt: 'C',
      expiresAt: null,
      connectUrl: 'wss://cdp.example.com/s1?jwt=x',
      cdpUrl: null,
      liveViewUrl: 'https://live.example.com/s1',
    })
  })

  it('passes the requested timeout through and reports a headless browser without live view', async () => {
    const { provider: p, calls } = provider(() => ({
      body: { session_id: 's1', cdp_ws_url: 'wss://cdp.example.com/s1' },
    }))
    const session = await p.createSession({ timeoutSeconds: 120 })
    expect(calls[0].body).toEqual({ timeout_seconds: 120 })
    expect(session.liveViewUrl).toBeNull()
    expect(session.createdAt).toBeNull()
  })

  it('lists active browsers by tag across pages', async () => {
    const { provider: p, calls } = provider((url): Reply => {
      if (url.searchParams.get('offset') === '0') {
        return {
          body: [browser('s1')],
          headers: { 'X-Has-More': 'true', 'X-Next-Offset': '100' },
        }
      }
      return { body: [browser('s2')], headers: { 'X-Has-More': 'false' } }
    })

    const sessions = await p.listSessions({ metadata: { ws: 'w1' } })

    expect(sessions.map((s) => [s.id, s.connectUrl])).toEqual([
      ['s1', 'wss://cdp.example.com/s1?jwt=x'],
      ['s2', 'wss://cdp.example.com/s2?jwt=x'],
    ])
    expect(calls.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      { status: 'active', limit: '100', offset: '0', 'tags[ws]': 'w1' },
      { status: 'active', limit: '100', offset: '100', 'tags[ws]': 'w1' },
    ])
  })

  it('stops paging when the service does not advance', async () => {
    const { provider: p, calls } = provider(() => ({
      body: [browser('s1')],
      headers: { 'X-Has-More': 'true', 'X-Next-Offset': '0' },
    }))
    expect(await p.listSessions()).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('releases a browser, and surfaces API errors without retrying', async () => {
    const ok = provider(() => ({ status: 204 }))
    await ok.provider.releaseSession('s 1')
    expect(ok.calls[0].method).toBe('DELETE')
    expect(ok.calls[0].url.pathname).toBe('/browsers/s%201')

    const failing = provider(() => ({ status: 401, body: 'unauthorized' }))
    await expect(failing.provider.createSession()).rejects.toThrow('Kernel 401: unauthorized')
    expect(failing.calls).toHaveLength(1)
  })

  it('lists files, skipping directories and applying the glob, and treats a missing directory as empty', async () => {
    const listing = provider(() => ({
      body: [
        {
          path: '/tmp/downloads/a.pdf',
          name: 'a.pdf',
          is_dir: false,
          size_bytes: 3,
          mod_time: 'M',
        },
        { path: '/tmp/downloads/b.txt', name: 'b.txt', is_dir: false, size_bytes: 1 },
        { path: '/tmp/downloads/pdfs', name: 'pdfs', is_dir: true },
      ],
    }))
    expect(await listing.provider.files?.list('s1', '/tmp/downloads')).toHaveLength(2)
    expect(await listing.provider.files?.list('s1', '/tmp/downloads', '*.pdf')).toEqual([
      { path: '/tmp/downloads/a.pdf', size: 3, modifiedAt: 'M' },
    ])
    expect(listing.calls[0].url.pathname).toBe('/browsers/s1/fs/list_files')
    expect(listing.calls[0].url.searchParams.get('path')).toBe('/tmp/downloads')

    const missing = provider(() => ({
      status: 404,
      body: '{"code":"not_found","message":"directory not found"}',
    }))
    expect(await missing.provider.files?.list('s1', '/tmp/downloads')).toEqual([])

    const denied = provider(() => ({ status: 401, body: 'unauthorized' }))
    await expect(denied.provider.files?.list('s1', '/tmp/downloads')).rejects.toThrow('Kernel 401')
  })

  it('reads a file with the API key', async () => {
    const { provider: p, calls } = provider(() => ({ body: 'hello' }))
    const res = await p.files?.read?.('s1', '/tmp/downloads/a b.txt')
    expect(await res?.text()).toBe('hello')
    expect(calls[0].auth).toBe('Bearer key')
    expect(calls[0].url.pathname).toBe('/browsers/s1/fs/read_file')
    expect(calls[0].url.searchParams.get('path')).toBe('/tmp/downloads/a b.txt')
  })
})
