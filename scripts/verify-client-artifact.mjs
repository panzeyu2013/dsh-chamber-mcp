#!/usr/bin/env node
/**
 * Shipped-browser-half artifact check (CI gate `verify:package`, step 5).
 *
 * The host half already has a built-artifact probe (execute `lib/index.js`).
 * This is its browser-half counterpart: it evaluates the BUILT `lib/client.js`
 * through the loader wrapper the dsh shell uses, applies it against a fake
 * client context, and asserts the behaviours the bundle — not the sources —
 * must have:
 *
 *  1. `apply` registers ONE keyed `tool.call.toolview` view per MCP tool name
 *     discovered in the staged session's `request/header`, and ignores
 *     non-MCP names;
 *  2. a running row renders the plug glyph, `data-state="running"` and
 *     `aria-busy`, and carries no duration;
 *  3. a settled row renders `data-state="ok"` with a duration and is not busy;
 *  4. the transport tag and the `server · tool` title come from the discovered
 *     identity;
 *  5. a real click expands the row into the token-styled body with the raw
 *     arguments and the result text.
 *
 * Everything here drives the packed artifact, so a bundle regression that the
 * source-level suites cannot see (a type-only import that leaked into the
 * bundle, a dropped registration) fails the release gate.
 *
 * Run: node scripts/verify-client-artifact.mjs   (after `npm run build`)
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Fail loudly with the repo's verify-script prefix. */
function fail(message) {
  console.error(`verify-client-artifact: ${message}`)
  process.exit(1)
}

/** Assert one named expectation and report it. */
function check(label, ok) {
  if (!ok) fail(`FAILED — ${label}`)
  console.log(`  ok  ${label}`)
}

// ---- the loader environment the dsh shell provides -----------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
// React's act() support gate: this is a test environment, so say so.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let factory
dom.window.__ModuleLoader__ = { load: (entry) => { factory = entry.factory; return entry } }
dom.window.eval(readFileSync(join(root, 'lib', 'client.js'), 'utf8'))
if (typeof factory !== 'function') fail('lib/client.js did not call __ModuleLoader__.load({ id, factory })')

const React = require('react')
const { createRoot } = require('react-dom/client')
// React 18.3 exposes act() on the React namespace; the test-utils copy is the
// fallback for an older resolution.
const act = React.act ?? require('react-dom/test-utils').act
const bundle = factory((id) => require(id))
if (typeof bundle.apply !== 'function') fail('the browser half exports no apply()')

// ---- fake client context -------------------------------------------------
/** Dictionary seat: the en half of the plugin namespace, `{name}`-interpolated. */
let dictionary = {}
const t = (key, params) =>
  String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))

const registrations = []
const listeners = new Set()
const entries = [
  {
    type: 'event',
    event: {
      type: 'request/header',
      data: {
        header: {
          tools: [{ name: 'mcp__fixture__greet' }, { name: 'mcp__github__search_issues' }, { name: 'bash' }],
        },
      },
    },
  },
  // A call whose describing header is NOT in this window: the window is a
  // bounded tail page, so the lane must also learn names from `tool/call`.
  { type: 'event', event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c9', name: 'mcp__fixture__late', arguments: '{}' } } },
  { type: 'event', event: { type: 'tool/result', data: { turn: 2, step: 1, message: { callId: 'c9', content: [], isError: false } } } },
]
const source = (get) => ({
  getSnapshot: get,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
})
const rawDoc = {
  servers: [
    { serverName: 'fixture', transport: 'stdio', command: 'node' },
    { serverName: 'github', transport: 'streamable-http', url: 'https://mcp.example.com/x' },
  ],
  overrides: {},
}
const ctx = {
  effect(fn) {
    const off = fn()
    return typeof off === 'function' ? off : () => {}
  },
  locale: {
    register(_ns, dict) {
      dictionary = dict.en
      return () => {}
    },
    bind: () => t,
  },
  settingsScope: {
    bind: (options) => ({
      getSnapshot: () => ({
        status: 'ready',
        value: options.decode === undefined ? rawDoc : options.decode(rawDoc),
        revision: 1,
        writable: true,
      }),
      subscribe: () => () => {},
      mutate: async () => {},
    }),
  },
  remote: {
    $on: () => () => {},
    credentials: {
      describe: async () => ({ ok: true, value: {} }),
      set: async () => ({ ok: true, value: undefined }),
      unset: async () => ({ ok: true, value: undefined }),
    },
  },
  workspaces: source(() => ({ items: [], state: 'idle', phase: 'ready' })),
  sessions: {
    list: source(() => ({ current: 's1' })),
    binding: (id) => (id === 's1' ? { eventSource: source(() => ({ entries })) } : undefined),
  },
  slots: {
    // The settings section is not mounted here: only the tool lane's slot is
    // declared, so the registration path under test is the transcript lane.
    inject(key, callback) {
      if (key !== 'tool.call.toolview') return () => {}
      const off = callback()
      return typeof off === 'function' ? off : () => {}
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {
        const index = registrations.findIndex((entry) => entry.spec.key === spec.key)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  },
}

bundle.apply(ctx)
if (!bundle.inject.includes('sessions')) fail('the browser half no longer injects the sessions service')

const keys = registrations.map((entry) => entry.spec.key).sort()
check('one keyed view per discovered MCP tool', keys.length === 3)
check('the fixture tool is registered', keys.includes('mcp__fixture__greet'))
check('the http tool is registered', keys.includes('mcp__github__search_issues'))
check('a call without a windowed header still registers', keys.includes('mcp__fixture__late'))
check('non-MCP names stay on the shipped row', !keys.includes('bash'))
// Shadowing rank 1: an official row for the same wire name must be able to win,
// and a same-key/same-priority pair (which throws in the slot core) must be
// impossible by construction.
check('rows register at shadowing rank 1', registrations.every((entry) => entry.spec.priority === 1))

const viewOf = (key) => {
  const entry = registrations.find((candidate) => candidate.spec.key === key)
  if (entry === undefined) fail(`no registered view for ${key}`)
  return entry.component
}
const stdio = viewOf('mcp__fixture__greet')
const http = viewOf('mcp__github__search_issues')

const settledBlock = {
  kind: 'tool-result',
  callId: 'c1',
  call: { argsRaw: '{"name":"world"}' },
  content: [{ type: 'text', text: 'hello world' }],
  isError: false,
  time: 1_700_000_001_200,
  callTime: 1_700_000_000_000,
}
const running = React.createElement(stdio, { t, block: { callId: 'c1', argsRaw: '{"name":"world"}' } })
const settled = React.createElement(stdio, { t, block: settledBlock })
const github = React.createElement(http, { t, block: { callId: 'c2', argsRaw: '{"q":"x"}' } })

const host = document.createElement('div')
document.body.appendChild(host)
const reactRoot = createRoot(host)

await act(async () => {
  reactRoot.render(running)
})
const runningMarkup = host.innerHTML
check('running row draws the plug glyph', runningMarkup.includes('M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'))
check('running row marks the running state', runningMarkup.includes('data-state="running"') && runningMarkup.includes('aria-busy="true"'))
check('running row carries no duration', !runningMarkup.includes('mcpScope_toolDuration'))
check(
  'running row carries the shipped hidden state word',
  runningMarkup.includes('mcpScope_toolVisuallyHidden'),
)
check('running row shows the argument summary', runningMarkup.includes('world'))
check('running row shows the transport tag', runningMarkup.includes('stdio'))

await act(async () => {
  reactRoot.render(settled)
})
const settledMarkup = host.innerHTML
check('settled row marks the settled state', settledMarkup.includes('data-state="ok"') && !settledMarkup.includes('aria-busy'))
check('settled row shows its duration', settledMarkup.includes('1.2s') && settledMarkup.includes('mcpScope_toolDuration'))
check('settled row hides the body until expanded', !settledMarkup.includes('hello world'))
// Shipped row order: [leading] [title] [sep] [summary] [suffix].
check(
  'row keeps the shipped title · summary · suffix order',
  settledMarkup.includes('mcpScope_toolSep') &&
    settledMarkup.indexOf('mcpScope_toolTitle') < settledMarkup.indexOf('mcpScope_toolSep') &&
    settledMarkup.indexOf('mcpScope_toolSep') < settledMarkup.indexOf('mcpScope_toolSummary') &&
    settledMarkup.indexOf('mcpScope_toolSummary') < settledMarkup.indexOf('mcpScope_toolDuration'),
)

await act(async () => {
  reactRoot.render(github)
})
check('http row shows the server · tool title', host.innerHTML.includes('github · search_issues'))
check('http row shows the http transport tag', host.innerHTML.includes('Streamable HTTP'))

// Terminal states: the shipped-bundle row must yield its glyph to the state
// mark (error red / interrupted amber), like the shipped tool rows do.
const failed = React.createElement(stdio, {
  t,
  block: { ...settledBlock, isError: true, content: [{ type: 'text', text: 'boom: refused' }] },
})
await act(async () => {
  reactRoot.render(failed)
})
check(
  'failed row keeps the state word for assistive technology',
  host.innerHTML.includes('mcpScope_toolVisuallyHidden'),
)
check(
  'failed row draws the error state mark instead of the glyph',
  host.innerHTML.includes('mcpScope_toolDot') &&
    host.innerHTML.includes('data-state="error"') &&
    !host.innerHTML.includes('M18 8v5a4 4 0 0 1-4 4h-4'),
)
const interrupted = React.createElement(stdio, {
  t,
  block: { ...settledBlock, error: { code: 'interrupted', name: 'Interrupted' }, content: [] },
})
await act(async () => {
  reactRoot.render(interrupted)
})
check(
  'interrupted row draws the warning state mark',
  host.innerHTML.includes('mcpScope_toolDot') && host.innerHTML.includes('data-state="warning"'),
)

// The interaction itself: a click on the shipped component's head.
await act(async () => {
  reactRoot.render(settled)
})
const head = host.querySelector('[role="button"]')
if (head === null) fail('the shipped row renders no role="button" head')
await act(async () => {
  head.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const expanded = host.innerHTML
check('a click expands the shipped row', head.getAttribute('aria-expanded') === 'true')
check('the expanded body carries the token-styled blocks', expanded.includes('mcpScope_toolBody') && expanded.includes('mcpScope_toolCode'))
check('the expanded body shows the raw arguments', expanded.includes('name') && expanded.includes('world'))
check('the expanded body shows the result', expanded.includes('hello world'))

await act(async () => {
  reactRoot.unmount()
})
host.remove()
console.log('verify-client-artifact: PASS')
