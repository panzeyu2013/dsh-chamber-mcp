// Smoke-test fixture: a tiny stdio MCP server used to prove dsh-chamber-mcp wiring.
// Tools:
//   echo        { text: string } -> { text }          (protocol round-trip)
//   env_report  {} -> { tokenPresent: bool, tokenLength: number }  (proves envKeys injection)
// Spawn/marker evidence: appends a JSON line per lifecycle event to a marker file
// next to this script (cwd-independent), including whether the credential env landed.
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// NOTE: absolute path on purpose — the SDK's exports map re-maps the bare
// subpath (dist/esm/dist/esm), while a direct file URL resolves correctly.
import { McpServer } from '/root/projects/dsh-mcp-scope/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'
import { StdioServerTransport } from '/root/projects/dsh-mcp-scope/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'

// Marker next to the fixture would dirty a tracked dir; write into .smoke/logs instead.
const MARKER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.smoke', 'logs', 'fixture-events.log')
const mark = (event, extra = {}) => {
  try {
    appendFileSync(MARKER, JSON.stringify({ ts: Date.now(), event, tokenPresent: (process.env.MCP_SCOPE_TEST_TOKEN ?? '') !== '', ...extra }) + '\n')
  } catch { /* marker is best-effort */ }
}

const server = new McpServer({ name: 'dsh-chamber-mcp-fixture', version: '1.0.0' }, {
  capabilities: { tools: { listChanged: true } },
})

server.registerTool('echo', { text: { type: 'string', description: 'text to echo' } }, async ({ text }) => {
  mark('tool', { tool: 'echo' })
  return { content: [{ type: 'text', text }] }
})

server.registerTool('env_report', {}, async () => {
  mark('tool', { tool: 'env_report' })
  const token = process.env.MCP_SCOPE_TEST_TOKEN ?? ''
  return {
    content: [{ type: 'text', text: JSON.stringify({ tokenPresent: token !== '', tokenLength: token.length }) }],
  }
})

mark('start')
await server.connect(new StdioServerTransport())
mark('connected')
