import { z } from 'zod'
import type { BrowserProvider, BrowserSession } from './types'

export interface BrowserToolsOptions {
  provider: BrowserProvider
  /**
   * Tags that confine the tools to one tenant: stamped on every browser they
   * create, and the filter for every list.
   */
  scope?: Record<string, string>
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function connectInfo(session: BrowserSession) {
  return {
    cdp_url: session.cdpUrl,
    connect_url: session.connectUrl,
    connect_command: session.connectUrl ? `agent-browser connect "${session.connectUrl}"` : null,
    live_view_url: session.liveViewUrl,
  }
}

/** `3600` → `1 hour`, `5400` → `90 minutes`. */
function duration(seconds: number): string {
  const [n, unit] =
    seconds % 3600 === 0
      ? [seconds / 3600, 'hour']
      : seconds % 60 === 0
        ? [seconds / 60, 'minute']
        : [seconds, 'second']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

type ToolResult = ReturnType<typeof textResult> | ReturnType<typeof errorResult>

/**
 * The part of an MCP server the tools need. It is declared here with loose
 * parameters, not taken from an SDK, so a host on either SDK generation can
 * pass its own `McpServer`.
 */
export interface ToolRegistrar {
  registerTool(name: string, config: any, handler: any): unknown
}

export function registerBrowserTools(
  server: ToolRegistrar,
  { provider, scope }: BrowserToolsOptions,
) {
  const registerTool = <Schema extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: Schema },
    handler: (args: z.infer<Schema>) => Promise<ToolResult>,
  ) => server.registerTool(name, config, handler)

  const { timeout, liveView, httpCdp, metadata } = provider.capabilities
  if (scope && Object.keys(scope).length > 0 && !metadata) {
    throw new Error(
      `Provider "${provider.name}" cannot tag sessions with metadata, so it cannot be confined to a scope`,
    )
  }

  const connectionInfo = [
    '- connect_command: a ready-to-run agent-browser command — just run it as-is to start driving the browser.',
    httpCdp
      ? '- connect_url: a wss:// URL for "agent-browser connect". Do NOT pass cdp_url here.'
      : '- connect_url: a wss:// CDP URL, for "agent-browser connect" or Playwright\'s browser.connectOverCDP(connect_url).',
    ...(httpCdp
      ? ['- cdp_url: an https:// URL for Playwright only, via browser.connectOverCDP(cdp_url).']
      : []),
    ...(liveView ? ['- live_view_url: share with the user so they can watch.'] : []),
  ].join('\n')
  const listedInfo = [...(httpCdp ? ['cdp_url'] : []), ...(liveView ? ['live_view_url'] : [])].join(
    ', ',
  )

  registerTool(
    'create_browser',
    {
      title: 'Create Browser',
      description: `Create a headless Chrome browser instance.
Returns browser_id plus connection info:
${connectionInfo}
The browser auto-expires after the timeout (default ${duration(timeout.defaultSeconds)}, max ${duration(timeout.maxSeconds)}).`,
      inputSchema: z.object({
        timeout_seconds: z
          .number()
          .optional()
          .describe(
            `Browser timeout in seconds (default: ${timeout.defaultSeconds}, max: ${timeout.maxSeconds})`,
          ),
      }),
    },
    async ({ timeout_seconds }) => {
      try {
        const session = await provider.createSession({
          timeoutSeconds: timeout_seconds,
          metadata: scope,
        })
        return textResult(
          JSON.stringify({
            browser_id: session.id,
            status: session.status,
            expires_at: session.expiresAt,
            ...connectInfo(session),
            ...(session.connectUrl
              ? {}
              : {
                  warning:
                    'Browser created but connect_url could not be resolved in time. Call list_browsers to check status before connecting.',
                }),
          }),
        )
      } catch (e) {
        return errorResult(`Error creating browser: ${message(e)}`)
      }
    },
  )

  registerTool(
    'list_browsers',
    {
      title: 'List Browsers',
      description: `List all active browser instances.
Each item includes the same connection info as create_browser (${listedInfo ? `${listedInfo}, plus ` : ''}connect_url/connect_command for running browsers), so this doubles as a reconnect path — pick a running browser and run its connect_command.`,
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const sessions = await provider.listSessions({ metadata: scope })
        const items = sessions.map((session) => ({
          id: session.id,
          status: session.status,
          expires_at: session.expiresAt,
          created_at: session.createdAt,
          ...connectInfo(session),
        }))
        return textResult(JSON.stringify({ items }))
      } catch (e) {
        return errorResult(`Error listing browsers: ${message(e)}`)
      }
    },
  )

  registerTool(
    'delete_browser',
    {
      title: 'Delete Browser',
      description: 'Stop and destroy a browser instance.',
      inputSchema: z.object({
        browser_id: z.string().describe('ID of the browser to delete'),
      }),
    },
    async ({ browser_id }) => {
      try {
        await provider.releaseSession(browser_id)
        return textResult(`Browser ${browser_id} deleted`)
      } catch (e) {
        return errorResult(`Error deleting browser: ${message(e)}`)
      }
    },
  )

  const files = provider.files
  if (!files) return

  registerTool(
    'list_browser_files',
    {
      title: 'List Browser Files',
      description: `List files inside the browser sandbox.
Defaults to ${files.defaultPath} — the conventional directory agents configure via CDP \`Browser.setDownloadBehavior\`.
Use after a download completes to discover what was saved. The browser sandbox is ephemeral, so files only exist while the browser is alive.
There can be a brief delay between CDP \`downloadProgress\` reporting "completed" and the file being readable; if a file looks truncated, retry after a moment.`,
      inputSchema: z.object({
        browser_id: z.string().describe('ID of the browser'),
        path: z.string().optional().describe(`Directory path (default: ${files.defaultPath})`),
        pattern: z.string().optional().describe('Optional glob pattern to filter results'),
      }),
    },
    async ({ browser_id, path, pattern }) => {
      try {
        const list = await files.list(browser_id, path ?? files.defaultPath, pattern)
        return textResult(JSON.stringify({ files: list }))
      } catch (e) {
        return errorResult(`Error listing files: ${message(e)}`)
      }
    },
  )

  registerTool(
    'get_browser_file_url',
    {
      title: 'Get Browser File Download URL',
      description: `Get a download URL for a file inside the browser sandbox.
Returns the URL alongside the current file state — use \`ready: true\` to confirm the file exists. The URL embeds an auth token and can be handed to the user (e.g. as a clickable link in chat) or fetched directly.
Files are only available while the browser is alive.`,
      inputSchema: z.object({
        browser_id: z.string().describe('ID of the browser'),
        path: z.string().describe('Full file path (e.g. /downloads/foo.pdf)'),
      }),
    },
    async ({ browser_id, path }) => {
      try {
        const lastSlash = path.lastIndexOf('/')
        const dir = lastSlash > 0 ? path.slice(0, lastSlash) : '/'
        const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
        const list = await files.list(browser_id, dir, name)
        const match = list.find((f) => f.path === path)
        if (!match) {
          return textResult(JSON.stringify({ ready: false, path }))
        }
        return textResult(
          JSON.stringify({
            ready: true,
            url: await files.downloadUrl(browser_id, path),
            path,
            size: match.size,
            modified_at: match.modifiedAt,
          }),
        )
      } catch (e) {
        return errorResult(`Error resolving file URL: ${message(e)}`)
      }
    },
  )
}
