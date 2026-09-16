// Minimal in-repo fixture MCP server over stdio for the host-half tests,
// mirroring the official ref-dsh mcp-client tests/fixture-server.ts — on the
// 2.0 server package (@modelcontextprotocol/server + /stdio), the same
// generation the host half's client speaks.
//
// Tools:
//   add          returns a+b as text
//   greet        returns a greeting
//   fail         returns isError: true
//   image        returns text + an image block (durable-image projection)
//   crash        replies then exits the process (crash-recovery test)
//   admin.reset  dotted name (normalization test)
//   dyn_add      registers a NEW tool at runtime → tools/list_changed fires
//                (re-sync test); the child exits after replying when the
//                dynamically registered tool is named "boom"
//   env_probe    echoes PROBE_TOKEN from the child env

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

// Published through initialize; FIXTURE_HUGE_INSTRUCTIONS makes it exceed the
// host's MAX_INSTRUCTION_BYTES bound (the oversized-block test).
const INSTRUCTIONS = process.env.FIXTURE_HUGE_INSTRUCTIONS === '1'
  ? 'x'.repeat(33_000)
  : 'Fixture guidance for MCP tools: call add before greet.'

function createFixtureServer() {
  const server = new McpServer(
    { name: 'fixture-server', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions: INSTRUCTIONS,
    },
  )

  server.registerTool('add', {
    title: 'Add Tool',
    description: 'Adds two numbers.',
    inputSchema: z.object({ a: z.number().describe('First number'), b: z.number().describe('Second number') }),
  }, async (args) => ({
    content: [{ type: 'text', text: String(args.a + args.b) }],
  }))

  server.registerTool('greet', {
    title: 'Greet Tool',
    description: 'Greets a person by name.',
    inputSchema: z.object({ name: z.string().describe('Name to greet') }),
  }, async (args) => ({
    content: [{ type: 'text', text: `Hello, ${args.name}!` }],
  }))

  server.registerTool('fail', {
    title: 'Fail Tool',
    description: 'Always returns an error.',
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: 'text', text: 'Something went wrong' }],
    isError: true,
  }))

  server.registerTool('image', {
    title: 'Image Tool',
    description: 'Returns text + an image block.',
    inputSchema: z.object({}),
  }, async () => ({
    content: [
      { type: 'text', text: 'Here is an image:' },
      { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' },
      { type: 'text', text: 'End of image.' },
    ],
  }))

  server.registerTool('crash', {
    title: 'Crash Tool',
    description: 'Replies, then exits the server process (crash-recovery test).',
    inputSchema: z.object({}),
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
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: 'text', text: 'reset done' }],
  }))

  // Registers a brand-new tool at runtime → the server sends
  // notifications/tools/list_changed → the supervisor re-syncs.
  server.registerTool('dyn_add', {
    title: 'Dynamic Add Tool',
    description: 'Registers a new dynamic tool named by the caller.',
    inputSchema: z.object({ name: z.string().describe('Tool name to register') }),
  }, async (args) => {
    const name = String(args.name)
    server.registerTool(name, {
      title: `Dynamic ${name}`,
      description: `Dynamically registered by dyn_add (${name}).`,
      inputSchema: z.object({}),
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
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: 'text', text: process.env.PROBE_TOKEN ?? '(unset)' }],
  }))

  // A real resource so the host-half resource provider has something to route
  // to; the provider test asserts the BODY, not merely "no error".
  server.registerResource('readme', 'file:///fixture-readme.txt', {
    title: 'Fixture resource',
    mimeType: 'text/plain',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'fixture resource body' }],
  }))

  return server
}

serveStdio(createFixtureServer)
