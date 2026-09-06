// Minimal in-repo fixture MCP server over stdio for the host-half tests,
// mirroring the official ref-dsh mcp-client tests/fixture-server.ts.
// Plain JS (.mjs) so a spawned `node` child can run it directly.
//
// Tools:
//   add          returns a+b as text
//   greet        returns a greeting
//   fail         returns isError: true
//   crash        replies then exits the process (crash-recovery test)
//   admin.reset  dotted name (normalization test)
//   dyn_add      registers a NEW tool at runtime → tools/list_changed fires
//                (re-sync test); the child exits after replying when the
//                dynamically registered tool is named "boom"

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'fixture-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.registerTool('add', {
  title: 'Add Tool',
  description: 'Adds two numbers.',
  inputSchema: { a: z.number().describe('First number'), b: z.number().describe('Second number') },
}, async (args) => ({
  content: [{ type: 'text', text: String(args.a + args.b) }],
}))

server.registerTool('greet', {
  title: 'Greet Tool',
  description: 'Greets a person by name.',
  inputSchema: { name: z.string().describe('Name to greet') },
}, async (args) => ({
  content: [{ type: 'text', text: `Hello, ${args.name}!` }],
}))

server.registerTool('fail', {
  title: 'Fail Tool',
  description: 'Always returns an error.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'Something went wrong' }],
  isError: true,
}))

server.registerTool('image', {
  title: 'Image Tool',
  description: 'Returns text + an image block (placeholder projection).',
  inputSchema: {},
}, async () => ({
  content: [
    { type: 'text', text: 'Here is an image:' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'text', text: 'End of image.' },
  ],
}))

server.registerTool('crash', {
  title: 'Crash Tool',
  description: 'Replies, then exits the server process (crash-recovery test).',
  inputSchema: {},
}, async () => {
  // Exit AFTER the response flushes so the caller observes a clean result
  // followed by a transport close, like a real post-reply crash.
  setTimeout(() => process.exit(7), 25)
  return { content: [{ type: 'text', text: 'crashing' }] }
})

// Dotted name: legal in MCP, illegal in the DeepSeek function-name contract.
server.registerTool('admin.reset', {
  title: 'Admin Reset Tool',
  description: 'Tool with a dotted name (normalization test).',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'reset done' }],
}))

// Registers a brand-new tool at runtime → the server sends
// notifications/tools/list_changed → the supervisor re-syncs.
server.registerTool('dyn_add', {
  title: 'Dynamic Add Tool',
  description: 'Registers a new dynamic tool named by the caller.',
  inputSchema: { name: z.string().describe('Tool name to register') },
}, async (args) => {
  const name = String(args.name)
  await server.registerTool(name, {
    title: `Dynamic ${name}`,
    description: `Dynamically registered by dyn_add (${name}).`,
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: `dynamic result from ${name}` }],
  }))
  if (name === 'boom') {
    setTimeout(() => process.exit(7), 25)
  }
  return { content: [{ type: 'text', text: `added ${name}` }] }
})

// Echoes PROBE_TOKEN from the child env (transport env-resolution test).
server.registerTool('env_probe', {
  title: 'Env Probe Tool',
  description: 'Returns the PROBE_TOKEN the child was spawned with.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: process.env.PROBE_TOKEN ?? '(unset)' }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
