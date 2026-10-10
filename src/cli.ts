#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { providerFromEnv } from './env'
import { registerBrowserTools } from './tools'
import type { BrowserProvider } from './types'

let provider: BrowserProvider
try {
  provider = providerFromEnv(process.env)
} catch (e) {
  console.error(`neu-browser-mcp: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

const server = new McpServer({ name: 'neu-browser-mcp', version: '0.2.4' })
registerBrowserTools(server, { provider })
await server.connect(new StdioServerTransport())
