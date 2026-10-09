import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, it } from 'vitest'
import { registerBrowserTools } from '../src/tools'
import type { BrowserProvider } from '../src/types'

const provider: BrowserProvider = {
  name: 'stub',
  capabilities: {
    timeout: { kind: 'absolute', defaultSeconds: 3600, maxSeconds: 86400 },
    liveView: true,
    httpCdp: true,
    metadata: true,
  },
  createSession: async (opts) => ({
    id: `b-${opts?.timeoutSeconds}`,
    status: 'running',
    createdAt: null,
    expiresAt: null,
    connectUrl: 'wss://x/devtools/browser/1',
    cdpUrl: null,
    liveViewUrl: null,
  }),
  listSessions: async () => [],
  releaseSession: async () => {},
}

it('registers and serves the tools on a server from SDK v1', async () => {
  const server = new McpServer({ name: 'test', version: '0' })
  registerBrowserTools(server, { provider })
  const client = new Client({ name: 'test-client', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])

  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toEqual(['create_browser', 'list_browsers', 'delete_browser'])
  expect(tools[0].inputSchema.properties).toHaveProperty('timeout_seconds')

  const result = await client.callTool({
    name: 'create_browser',
    arguments: { timeout_seconds: 60 },
  })
  const text = (result.content as { text: string }[])[0].text
  expect(JSON.parse(text).browser_id).toBe('b-60')
})
