/**
 * Real Streamable HTTP MCP fixture for the host tests.
 *
 * One in-process Node HTTP server wraps the official createMcpHandler +
 * McpServer (2025-era stateless serving). It exposes one echo tool, records
 * every request's transport headers, and can require or reject the bearer
 * token so the transport/supervisor error mapping is exercised on the wire.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { z } from 'zod'

export interface HttpFixtureRequest {
  method: string
  url: string
  authorization: string | undefined
  accept: string | undefined
}

export interface HttpFixture {
  url: string
  token: string
  requests: HttpFixtureRequest[]
  close(): Promise<void>
}

export type HttpFixtureAuth = 'open' | 'required' | 'forbid'

export interface HttpFixtureOptions {
  auth?: HttpFixtureAuth
  token?: string
}

function createServerInstance(): McpServer {
  const server = new McpServer(
    { name: 'http-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Echoes the supplied text.',
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  return server
}

/** Start one fixture on an ephemeral loopback port. */
export async function startHttpMcpFixture(options: HttpFixtureOptions = {}): Promise<HttpFixture> {
  const auth = options.auth ?? 'required'
  const token = options.token ?? 'fixture-token'
  const requests: HttpFixtureRequest[] = []
  const handler = createMcpHandler(createServerInstance)

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    })

    if (auth === 'forbid' || (auth === 'required' && req.headers.authorization !== `Bearer ${token}`)) {
      res.writeHead(auth === 'forbid' ? 403 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: auth === 'forbid' ? 'forbidden' : 'unauthorized' }))
      return
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value)
    }
    const request = new Request(new URL(req.url ?? '/', 'http://127.0.0.1'), {
      method: req.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    })
    try {
      const response = await handler.fetch(request)
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      res.writeHead(response.status, responseHeaders)
      if (response.body === null) res.end()
      else Readable.fromWeb(response.body as never).pipe(res)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(error))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('http fixture failed to bind a loopback port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    requests,
    async close() {
      await handler.close()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
