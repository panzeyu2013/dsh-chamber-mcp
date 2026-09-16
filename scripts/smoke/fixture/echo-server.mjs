// Smoke-test fixture: a tiny stdio MCP server used to prove dsh-chamber-mcp wiring.
// Tools:
//   echo        { text: string } -> { text }          (protocol round-trip)
//   env_report  {} -> { tokenPresent: bool, tokenLength: number }  (proves envKeys injection)
// Spawn/marker evidence: appends a JSON line per lifecycle event to a marker file
// next to this script (cwd-independent), including whether the credential env landed.
//
// Built on the 2.0 server packages (@modelcontextprotocol/server + /stdio) — the
// same generation the plugin's client speaks.
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

// Marker next to the fixture would dirty a tracked dir; write into .smoke/logs instead.
const MARKER = join(REPO, '.smoke', 'logs', 'fixture-events.log')
const mark = (event, extra = {}) => {
  try {
    appendFileSync(MARKER, JSON.stringify({ ts: Date.now(), event, tokenPresent: (process.env.MCP_SCOPE_TEST_TOKEN ?? '') !== '', ...extra }) + '\n')
  } catch { /* marker is best-effort */ }
}

function createFixtureServer() {
  const server = new McpServer({ name: 'dsh-chamber-mcp-fixture', version: '1.0.0' }, {
    capabilities: { tools: { listChanged: true } },
  })

  server.registerTool('echo', {
    description: 'Echoes the given text.',
    inputSchema: z.object({ text: z.string().describe('text to echo') }),
  }, async ({ text }) => {
    mark('tool', { tool: 'echo' })
    return { content: [{ type: 'text', text }] }
  })

  server.registerTool('env_report', {
    description: 'Reports whether the injected credential env landed.',
    inputSchema: z.object({}),
  }, async () => {
    mark('tool', { tool: 'env_report' })
    const token = process.env.MCP_SCOPE_TEST_TOKEN ?? ''
    return {
      content: [{ type: 'text', text: JSON.stringify({ tokenPresent: token !== '', tokenLength: token.length }) }],
    }
  })

  return server
}

mark('start')
serveStdio(createFixtureServer)
mark('connected')
