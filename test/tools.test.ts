import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { registerBrowserTools } from '../src/tools'
import type { BrowserProvider, BrowserSession } from '../src/types'

const running: BrowserSession = {
  id: 'b1',
  status: 'running',
  createdAt: 'C',
  expiresAt: 'E',
  connectUrl: 'wss://x/devtools/browser/1',
  cdpUrl: 'https://x/cdp/b1',
  liveViewUrl: 'https://x/live/b1/',
}

function stubProvider(overrides: Partial<BrowserProvider> = {}) {
  const calls: unknown[][] = []
  const provider: BrowserProvider = {
    name: 'stub',
    capabilities: {
      timeout: { kind: 'absolute', defaultSeconds: 3600, maxSeconds: 86400 },
      liveView: true,
      httpCdp: true,
      metadata: true,
    },
    async createSession(opts) {
      calls.push(['create', opts])
      return running
    },
    async listSessions(opts) {
      calls.push(['list', opts])
      return [running]
    },
    async releaseSession(id) {
      calls.push(['release', id])
    },
    ...overrides,
  }
  return { provider, calls }
}

async function connect(provider: BrowserProvider, scope?: Record<string, string>) {
  const server = new McpServer({ name: 'test', version: '0' })
  registerBrowserTools(server, { provider, scope })
  const client = new Client({ name: 'test-client', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0].text
  return { text, isError: result.isError === true }
}

describe('browser tools', () => {
  it('registers file tools only when the provider has file access', async () => {
    const without = await connect(stubProvider().provider)
    expect((await without.listTools()).tools.map((t) => t.name)).toEqual([
      'create_browser',
      'list_browsers',
      'delete_browser',
    ])

    const withFiles = await connect(
      stubProvider({
        files: { defaultPath: '/downloads', list: async () => [], downloadUrl: async () => '' },
      }).provider,
    )
    expect((await withFiles.listTools()).tools.map((t) => t.name)).toEqual([
      'create_browser',
      'list_browsers',
      'delete_browser',
      'list_browser_files',
      'get_browser_file_url',
    ])
  })

  it('registers a file tool for each way the provider can get at a file', async () => {
    const names = async (files: BrowserProvider['files']) => {
      const client = await connect(stubProvider({ files }).provider)
      return (await client.listTools()).tools.map((t) => t.name).slice(3)
    }
    const list = async () => []
    const downloadUrl = async () => 'https://x'
    const read = async () => new Response('x')

    expect(await names({ defaultPath: '/d', list })).toEqual(['list_browser_files'])
    expect(await names({ defaultPath: '/d', list, downloadUrl })).toEqual([
      'list_browser_files',
      'get_browser_file_url',
    ])
    expect(await names({ defaultPath: '/d', list, read })).toEqual([
      'list_browser_files',
      'read_browser_file',
    ])
    expect(await names({ defaultPath: '/d', list, downloadUrl, read })).toEqual([
      'list_browser_files',
      'get_browser_file_url',
      'read_browser_file',
    ])
  })

  it('reads a file as text, as a base64 resource when it is not text, and refuses a large one', async () => {
    const replies: Record<string, Response> = {
      '/d/a.txt': new Response('héllo'),
      '/d/a.bin': new Response(new Uint8Array([0xff, 0xfe, 0x00]), {
        headers: { 'content-type': 'application/pdf' },
      }),
      '/d/declared.bin': new Response('x', { headers: { 'content-length': '999999' } }),
      '/d/big.bin': new Response(new Uint8Array(256 * 1024 + 1)),
    }
    const { provider } = stubProvider({
      files: {
        defaultPath: '/d',
        list: async () => [],
        read: async (_id, path) => {
          if (!replies[path]) throw new Error('not found')
          return replies[path]
        },
      },
    })
    const client = await connect(provider)
    const read = (path: string) =>
      client.callTool({ name: 'read_browser_file', arguments: { browser_id: 'b1', path } })

    expect((await read('/d/a.txt')).content).toEqual([{ type: 'text', text: 'héllo' }])
    expect((await read('/d/a.bin')).content).toEqual([
      {
        type: 'resource',
        resource: { uri: 'browser-file://b1/d/a.bin', mimeType: 'application/pdf', blob: '//4A' },
      },
    ])
    for (const [path, bytes] of [
      ['/d/declared.bin', 999999],
      ['/d/big.bin', 256 * 1024 + 1],
    ] as const) {
      const result = await read(path)
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        {
          type: 'text',
          text: `Error reading file: ${path} is ${bytes} bytes, over the 256 KB limit`,
        },
      ])
    }
    const missing = await read('/d/none')
    expect(missing.isError).toBe(true)
    expect(missing.content).toEqual([{ type: 'text', text: 'Error reading file: not found' }])
  })

  it('describes the tools from what the provider declares', async () => {
    const describe = async (provider: BrowserProvider) => {
      const { tools } = await (await connect(provider)).listTools()
      return Object.fromEntries(tools.map((t) => [t.name, t.description]))
    }

    const full = await describe(stubProvider().provider)
    expect(full.create_browser).toBe(`Create a headless Chrome browser instance.
Returns browser_id plus connection info:
- connect_command: a ready-to-run agent-browser command — just run it as-is to start driving the browser.
- connect_url: a wss:// URL for "agent-browser connect". Do NOT pass cdp_url here.
- cdp_url: an https:// URL for Playwright only, via browser.connectOverCDP(cdp_url).
- live_view_url: share with the user so they can watch.
The browser auto-expires after the timeout (default 1 hour, max 24 hours).`)
    expect(full.list_browsers).toContain(
      '(cdp_url, live_view_url, plus connect_url/connect_command',
    )

    const bare = await describe(
      stubProvider({
        capabilities: {
          timeout: { kind: 'idle', defaultSeconds: 300, maxSeconds: 5400 },
          liveView: false,
          httpCdp: false,
          metadata: false,
        },
      }).provider,
    )
    expect(bare.create_browser).not.toMatch(/cdp_url|live_view_url/)
    expect(bare.create_browser).toContain('connectOverCDP(connect_url)')
    expect(bare.create_browser).toContain(
      'reclaimed once it has been idle for the timeout (default 5 minutes, max 90 minutes)',
    )
    expect(bare.list_browsers).toContain('(connect_url/connect_command for running browsers)')
  })

  it('refuses a scope when the provider cannot tag sessions', async () => {
    const { provider } = stubProvider({
      capabilities: {
        timeout: { kind: 'absolute', defaultSeconds: 3600, maxSeconds: 86400 },
        liveView: true,
        httpCdp: true,
        metadata: false,
      },
    })
    const server = new McpServer({ name: 'test', version: '0' })
    expect(() => registerBrowserTools(server, { provider, scope: { ws: 'w1' } })).toThrow(
      /cannot be confined to a scope/,
    )
    expect(() => registerBrowserTools(server, { provider })).not.toThrow()
  })

  it('creates a browser inside the scope and returns connection info', async () => {
    const { provider, calls } = stubProvider()
    const client = await connect(provider, { 'browser.workspace_id': 'w1' })

    const { text } = await call(client, 'create_browser', { timeout_seconds: 120 })

    expect(calls).toEqual([
      ['create', { timeoutSeconds: 120, metadata: { 'browser.workspace_id': 'w1' } }],
    ])
    expect(JSON.parse(text)).toEqual({
      browser_id: 'b1',
      status: 'running',
      expires_at: 'E',
      cdp_url: 'https://x/cdp/b1',
      connect_url: 'wss://x/devtools/browser/1',
      connect_command: 'agent-browser connect "wss://x/devtools/browser/1"',
      live_view_url: 'https://x/live/b1/',
    })
  })

  it('warns when the browser has no connect URL yet', async () => {
    const { provider } = stubProvider({
      createSession: async () => ({ ...running, status: 'pending', connectUrl: null }),
    })
    const { text } = await call(await connect(provider), 'create_browser')
    const body = JSON.parse(text)
    expect(body.connect_command).toBeNull()
    expect(body.warning).toMatch(/list_browsers/)
  })

  it('lists browsers within the scope', async () => {
    const { provider, calls } = stubProvider()
    const { text } = await call(await connect(provider, { ws: 'w1' }), 'list_browsers')
    expect(calls).toEqual([['list', { metadata: { ws: 'w1' } }]])
    expect(JSON.parse(text).items).toEqual([
      {
        id: 'b1',
        status: 'running',
        expires_at: 'E',
        created_at: 'C',
        cdp_url: 'https://x/cdp/b1',
        connect_url: 'wss://x/devtools/browser/1',
        connect_command: 'agent-browser connect "wss://x/devtools/browser/1"',
        live_view_url: 'https://x/live/b1/',
      },
    ])
  })

  it('deletes a browser and reports provider failures as errors', async () => {
    const ok = stubProvider()
    expect(await call(await connect(ok.provider), 'delete_browser', { browser_id: 'b1' })).toEqual({
      text: 'Browser b1 deleted',
      isError: false,
    })
    expect(ok.calls).toEqual([['release', 'b1']])

    const failing = stubProvider({
      releaseSession: async () => {
        throw new Error('boom')
      },
    })
    expect(
      await call(await connect(failing.provider), 'delete_browser', { browser_id: 'b1' }),
    ).toEqual({ text: 'Error deleting browser: boom', isError: true })
  })

  it('lists files in the default directory and resolves a download URL', async () => {
    const listed: unknown[][] = []
    const { provider } = stubProvider({
      files: {
        defaultPath: '/downloads',
        async list(id, path, pattern) {
          listed.push([id, path, pattern])
          return [{ path: '/downloads/a.pdf', size: 3, modifiedAt: 'M' }]
        },
        downloadUrl: async (id, path) => `https://x/files/${id}${path}`,
      },
    })
    const client = await connect(provider)

    const list = await call(client, 'list_browser_files', { browser_id: 'b1' })
    expect(JSON.parse(list.text).files).toHaveLength(1)

    const found = await call(client, 'get_browser_file_url', {
      browser_id: 'b1',
      path: '/downloads/a.pdf',
    })
    expect(JSON.parse(found.text)).toEqual({
      ready: true,
      url: 'https://x/files/b1/downloads/a.pdf',
      path: '/downloads/a.pdf',
      size: 3,
      modified_at: 'M',
    })

    const missing = await call(client, 'get_browser_file_url', {
      browser_id: 'b1',
      path: '/downloads/b.pdf',
    })
    expect(JSON.parse(missing.text)).toEqual({ ready: false, path: '/downloads/b.pdf' })

    expect(listed).toEqual([
      ['b1', '/downloads', undefined],
      ['b1', '/downloads', 'a.pdf'],
      ['b1', '/downloads', 'b.pdf'],
    ])
  })
})
