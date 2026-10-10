# neu-browser-mcp

An MCP server that gives an agent a remote browser: create one, get a CDP URL to drive it, hand the user a live view, pick up the files it downloaded, and shut it down.

The tools stay the same whichever backend hosts the browser. A backend is a small adapter behind one interface, so the agent's prompts and skills do not change when the browser moves.

<p>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
  <a href="CONTRIBUTING.md"><img alt="Contributions welcome" src="https://img.shields.io/badge/contributions-welcome-brightgreen.svg"></a>
</p>

## What it is not

It does not click, type or navigate. The agent drives the browser itself over CDP, with [agent-browser](https://github.com/vercel-labs/agent-browser), Playwright, or any other CDP client. This server only owns the browser's lifecycle, so backend credentials stay on the server and never enter the agent's context.

## Tools

| Tool | What it does |
| --- | --- |
| `create_browser` | Starts a browser and returns `browser_id`, `connect_url` (CDP WebSocket), `connect_command` (a ready-to-run `agent-browser connect …`), `cdp_url` (CDP over HTTP, for Playwright's `connectOverCDP`) and `live_view_url`. Takes an optional `timeout_seconds`. |
| `list_browsers` | Lists active browsers with the same connection info, so an agent can reconnect to one it lost track of. |
| `delete_browser` | Stops a browser. |
| `list_browser_files` | Lists files in the browser's sandbox, the backend's download directory by default. |
| `get_browser_file_url` | Returns a download URL for one file, or `ready: false` if it is not there yet. |
| `read_browser_file` | Returns the contents of one file: text as text, anything else as a base64 resource. |

The file tools follow what the backend offers. Listing is the base. Getting at a file comes in two separate forms, and a backend exposes whichever it really has:

- **A download link** (`get_browser_file_url`), for handing to a user. Only backends that can issue a link needing no credentials have it.
- **Reading the contents** (`read_browser_file`), returned to the agent. The server reads the file with the backend's credentials, so they never reach the agent. Reads are capped at 256 KB.

## Backends

Each backend declares what it supports, and the tools follow the declaration.

| Backend | Timeout (default / max) | Live view | CDP over HTTP | Metadata | List files | Download link | Read file |
| --- | --- | :---: | :---: | :---: | :---: | :---: | :---: |
| [`nap`](https://github.com/neutree-ai/agent-platform) | 1 hour / 24 hours | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| [`kernel`](https://www.kernel.sh) | 1 hour idle / 72 hours idle | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| [`browser-use`](https://browser-use.com) | 1 hour / 4 hours | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| [`hyperbrowser`](https://hyperbrowser.ai) | 1 hour / 12 hours | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

More backends are planned. See [Adding a backend](#adding-a-backend).

## Run it as a server

Requires Node.js 22 or newer. The server speaks MCP over stdio.

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "neu-browser-mcp"],
      "env": {
        "NEU_BROWSER_BACKEND": "nap",
        "NAP_BROWSER_URL": "https://browser.example.com",
        "NAP_BROWSER_TOKEN": "<token>"
      }
    }
  }
}
```

`NEU_BROWSER_BACKEND` picks the backend and defaults to `nap`. Each backend then reads its own variables.

**`nap`**

| Variable | Meaning |
| --- | --- |
| `NAP_BROWSER_URL` | Base URL of the browser service API. Required. |
| `NAP_BROWSER_TOKEN` | Bearer token for the browser service. Required. |
| `NAP_BROWSER_PUBLIC_URL` | Base URL used in file download links. Set it when `NAP_BROWSER_URL` is an internal address users cannot reach. Defaults to `NAP_BROWSER_URL`. |

**`kernel`**

| Variable | Meaning |
| --- | --- |
| `KERNEL_API_KEY` | Kernel API key. Required. |

**`browser-use`**

| Variable | Meaning |
| --- | --- |
| `BROWSER_USE_API_KEY` | Browser Use Cloud API key. Required. |

**`hyperbrowser`**

| Variable | Meaning |
| --- | --- |
| `HYPERBROWSER_API_KEY` | Hyperbrowser API key. Required. |

## Use it as a library

To add the tools to an MCP server you already run, register them on it:

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { createNapProvider, registerBrowserTools } from 'neu-browser-mcp'

const server = new McpServer({ name: 'my-server', version: '1.0.0' })

registerBrowserTools(server, {
  provider: createNapProvider({
    baseUrl: 'http://browser.internal:3005',
    publicBaseUrl: 'https://browser.example.com',
    token: async () => lookUpTokenFor(tenant),
  }),
  scope: { tenant_id: tenant.id },
})
```

The server can come from either generation of the MCP TypeScript SDK: `@modelcontextprotocol/server` (v2) or `@modelcontextprotocol/sdk` (v1).

`scope` is a set of tags that confines the tools to one tenant. Every browser they create carries the tags, and `list_browsers` returns only browsers that carry them. `token` can be a string or an async function; a function is called once, on first use.

## Adding a backend

A backend implements `BrowserProvider` from [`src/types.ts`](src/types.ts):

```ts
interface BrowserProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  createSession(opts?: CreateSessionOptions): Promise<BrowserSession>
  listSessions(opts?: ListSessionsOptions): Promise<BrowserSession[]>
  releaseSession(id: string): Promise<void>
  readonly files?: BrowserFiles // list, and optionally downloadUrl and read
}

interface ProviderCapabilities {
  timeout: { kind: 'absolute' | 'idle'; defaultSeconds: number; maxSeconds: number }
  liveView: boolean
  httpCdp: boolean
  metadata: boolean
}
```

The required part is the session lifecycle plus a CDP WebSocket URL. Everything else is declared, and the tools adapt:

| Declaration | Effect when absent |
| --- | --- |
| `timeout` | Always present. Sets the default and maximum the agent is told about, and whether the timeout counts from creation (`absolute`) or inactivity (`idle`). |
| `liveView` | `live_view_url` is null and the tool descriptions do not mention it. |
| `httpCdp` | `cdp_url` is null, and the agent is told to use `connect_url` with Playwright too. |
| `metadata` | `registerBrowserTools` throws if a `scope` is given, since the backend could not keep tenants apart. |
| `files` member | No file tools are registered. |
| `files.downloadUrl` | `get_browser_file_url` is not registered. |
| `files.read` | `read_browser_file` is not registered. |

[`src/providers/nap.ts`](src/providers/nap.ts) is the reference implementation.

## Development

```bash
npm install
npx tsc --noEmit
npx biome check .
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE)
