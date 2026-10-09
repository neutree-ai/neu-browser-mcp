import { afterAll, expect, it } from 'vitest'
import { providerFromEnv } from '../src/env'
import type { BrowserSession } from '../src/types'

// Runs against a real backend, chosen and configured through the same
// environment variables as the standalone server. Every backend must pass it.
const provider = providerFromEnv(process.env)
const { capabilities } = provider
const tags = capabilities.metadata ? { neu_browser_smoke: `run-${Date.now()}` } : undefined

let session: BrowserSession | undefined

afterAll(async () => {
  if (session) await provider.releaseSession(session.id)
})

/** A minimal CDP client: enough to send commands and wait for one event. */
async function cdp(connectUrl: string) {
  const ws = new WebSocket(connectUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('CDP WebSocket failed to connect'))
  })
  let nextId = 0
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Set<(message: any) => void>()
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id) pending.get(message.id)?.(message.result ?? message.error)
    else for (const listener of listeners) listener(message)
  }
  const within = <T>(what: string, promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`No ${what} within 30s`)), 30_000),
      ),
    ])
  return {
    send(method: string, params: object = {}, sessionId?: string): Promise<any> {
      const id = ++nextId
      ws.send(JSON.stringify({ id, method, params, sessionId }))
      return within(`reply to ${method}`, new Promise((resolve) => pending.set(id, resolve)))
    },
    event(method: string, match: (params: any) => boolean): Promise<any> {
      return within(
        method,
        new Promise((resolve) => {
          listeners.add((message) => {
            if (message.method === method && match(message.params)) resolve(message.params)
          })
        }),
      )
    },
    close: () => ws.close(),
  }
}

it(`${provider.name}: creates a browser that answers over CDP`, async () => {
  session = await provider.createSession({ timeoutSeconds: 300, metadata: tags })

  expect(session.id).toBeTruthy()
  expect(session.connectUrl).toMatch(/^wss?:\/\//)
  const browser = await cdp(session.connectUrl as string)
  expect((await browser.send('Browser.getVersion')).product).toMatch(/Chrome/)
  browser.close()
  if (capabilities.liveView) expect(session.liveViewUrl).toMatch(/^https?:\/\//)
  if (capabilities.httpCdp) expect(session.cdpUrl).toMatch(/^https?:\/\//)
})

it(`${provider.name}: lists the browser with a connect URL`, async () => {
  const sessions = await provider.listSessions({ metadata: tags })
  const listed = sessions.find((s) => s.id === session?.id)

  expect(listed).toBeDefined()
  expect(listed?.connectUrl).toMatch(/^wss?:\/\//)
  if (tags) expect(sessions.every((s) => s.id === session?.id)).toBe(true)
})

it.skipIf(!provider.files)(
  `${provider.name}: lists a file the browser downloaded and gets it back`,
  async () => {
    const files = provider.files
    if (!files || !session) return

    const browser = await cdp(session.connectUrl as string)
    await browser.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: files.defaultPath,
      eventsEnabled: true,
    })
    const done = browser.event('Browser.downloadProgress', (p) => p.state === 'completed')
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    await browser.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob(['neu-browser-smoke']))
        a.download = 'neu-browser-smoke.txt'
        document.body.appendChild(a)
        a.click()
      })()`,
        userGesture: true,
      },
      sessionId,
    )
    await done
    browser.close()

    const listed = await files.list(session.id, files.defaultPath, 'neu-browser-smoke*')
    expect(listed).toHaveLength(1)
    expect(listed[0].size).toBe(17)

    if (files.downloadUrl) {
      const res = await fetch(await files.downloadUrl(session.id, listed[0].path))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('neu-browser-smoke')
    }
    if (files.read) {
      const res = await files.read(session.id, listed[0].path)
      expect(await res.text()).toBe('neu-browser-smoke')
    }
  },
)

it(`${provider.name}: releases the browser`, async () => {
  if (!session) return
  await provider.releaseSession(session.id)
  session = undefined
})
