#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createNapProvider } from './providers/nap'
import { registerBrowserTools } from './tools'

const baseUrl = process.env.NAP_BROWSER_URL
const token = process.env.NAP_BROWSER_TOKEN
if (!baseUrl || !token) {
  console.error('neu-browser-mcp: set NAP_BROWSER_URL and NAP_BROWSER_TOKEN')
  process.exit(1)
}

const server = new McpServer({ name: 'neu-browser-mcp', version: '0.1.0' })
registerBrowserTools(server, {
  provider: createNapProvider({
    baseUrl,
    token,
    publicBaseUrl: process.env.NAP_BROWSER_PUBLIC_URL,
  }),
})
await server.connect(new StdioServerTransport())
