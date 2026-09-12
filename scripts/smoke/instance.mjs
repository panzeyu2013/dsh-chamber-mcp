// dsh-chamber-mcp smoke driver: boot a SCRATCH dsh instance (the anchor 0.1.2-rc.1
// CLI — the same generation users run via chamber) and drive its HTTP RPC surface.
// rc.1 wire generation: slash typert endpoints (/api/settings/describe etc.), payloads
// {args:{...}} inside the client-request envelope, launch-token cookie auth.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')
export const SMOKE = join(ROOT, '.smoke')

export const ANCHOR_CLI =
  process.env.DSH_ANCHOR_CLI ??
  '/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/dsh/lib/bin.js'
// Spawn the anchor dsh and MCP fixture children with the interpreter the
// driver itself runs under (override with DSH_SMOKE_NODE for pinning).
export const NODE = process.env.DSH_SMOKE_NODE ?? process.execPath

export function log(...parts) { console.log(new Date().toISOString().slice(11, 19), ...parts) }

/**
 * Mask launch-token values in anything the driver echoes or writes.
 *
 * `dsh web` prints its startup URL carrying a FRESH process token on every
 * boot, and this driver forwards child output verbatim. Unmasked, every smoke
 * run commits a live GUI credential (it authenticates the instance's whole
 * Host API and WebSocket surface) into the evidence transcripts. The raw chunk
 * still reaches the URL parser below — only the transcript is masked.
 *
 * @param text - child output about to be echoed or written to an evidence log.
 * @returns the same text with every `token=<value>` replaced by `token=[redacted]`.
 */
export function maskSecrets(text) {
  return String(text).replace(/([?&\s]|^)token=[A-Za-z0-9._~-]+/gim, '$1token=[redacted]')
}

export class Instance {
  constructor({ home, port, label = 'smoke' }) {
    this.home = home
    this.port = port
    this.label = label
    this.child = null
    this.base = `http://127.0.0.1:${port}`
    this.logPath = join(SMOKE, 'logs', `${label}.log`)
    this.jarPath = join(SMOKE, 'logs', `${label}-cookies.txt`)
    mkdirSync(join(SMOKE, 'logs'), { recursive: true })
    mkdirSync(this.home, { recursive: true })
  }

  /** Boot dsh web headless against a scratch DSH_HOME. Resolves once the URL line appears. */
  async boot(timeoutMs = 60_000, extraEnv = {}) {
    const env = {
      ...process.env,
      PATH: '/root/.nvm/versions/node/v22.22.3/bin:' + (process.env.PATH ?? ''),
      DSH_HOME: this.home,
      HOME: join(SMOKE, 'homedir'),
      DSH_TELEMETRY_DISABLED: '1',
      npm_config_cache: join(SMOKE, 'npm-cache'),
      ...extraEnv,
    }
    this.child = spawn(NODE, [ANCHOR_CLI, 'web', '--no-open', '--port', String(this.port)], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    this.child.stdout.on('data', (d) => { stdout += d; process.stdout.write(`[${this.label}:out] ${maskSecrets(d)}`) })
    this.child.stderr.on('data', (d) => process.stdout.write(`[${this.label}:err] ${maskSecrets(d)}`))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`instance ${this.label} exited early (${this.child.exitCode})`)
      const m = stdout.match(/dsh web: (http:\/\/\S+)/)
      if (m) {
        const url = new URL(m[1])
        const token = url.searchParams.get('token')
        // rc.1 mints the authority-bound cookie on GET /?token=… (303). Bootstrap it.
        const res = await fetch(url.href, { redirect: 'manual' }).catch(() => null)
        const setCookies = res?.headers.getSetCookie?.() ?? []
        if (setCookies.length === 0 && token) log(`note: no cookie minted (status ${res?.status})`)
        this.cookies = setCookies.map((c) => c.split(';')[0]).join('; ')
        log(`instance ${this.label} up at ${url.origin}`)
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`instance ${this.label} did not come up in ${timeoutMs}ms`)
  }

  /** RPC call over the rc.1 slash-typert wire. */
  async rpc(namespaceMethod, args = {}) {
    const [ns, method] = namespaceMethod.split('/')
    const url = `${this.base}/api/${ns}/${method}`
    const headers = { 'Content-Type': 'application/json' }
    if (this.cookies) headers.Cookie = this.cookies
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'client-request', rpcId: `r${Math.random().toString(36).slice(2)}`, method: `${ns}/${method}`, payload: { args } }),
    })
    const body = await res.json()
    const out = body?.result
    if (out?.ok === false) {
      const err = out.error
      throw new Error(`rpc ${ns}/${method} failed: ${err.code}: ${err.message}`)
    }
    if (out?.ok !== true) throw new Error(`rpc ${ns}/${method} unexpected envelope: ${JSON.stringify(body).slice(0, 300)}`)
    return out.value
  }

  async stop() {
    if (!this.child) return
    this.child.kill('SIGTERM')
    await new Promise((r) => { this.child.once('exit', r); setTimeout(r, 3000) })
    this.child = null
  }
}
