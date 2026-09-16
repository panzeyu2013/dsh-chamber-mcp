#!/usr/bin/env node
/**
 * Low-generation fallback check (\`npm run verify:low-generation\`).
 *
 * The fallback definition builder is the ONLY thing that runs in production on a
 * host without \`createMcpToolDefinition\`, so the vitest suite — pinned to the
 * newer devDependency generation — can never exercise the REAL low-generation
 * packages. This check resolves the BUILT host half against the low-generation
 * anchor's \`dsh-mcp-client\` and \`dsh-attachment\` and asserts:
 *
 *  1. the production selection resolves the fallback (the adapter export is
 *     genuinely absent in the low generation, not merely mocked away);
 *  2. \`lib/\`'s own module resolution reaches the low-generation packages;
 *  3. an image result is admitted through the attachment store and finalized as
 *     image content, with the raw block kept in the canonical value;
 *  4. a correctable refusal reports the upstream admission-rejection wording.
 *
 * Point \`DSH_LOW_GENERATION_ROOT\` at the low-generation install when the default
 * chamber path does not exist. Run \`npm run build\` first: this checks \`lib/\`.
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const lowRoot = process.env.DSH_LOW_GENERATION_ROOT
  ?? '/Applications/dsh-chamber.app/Contents/Resources/vendor/dsh'
const lowPackages = join(lowRoot, 'node_modules', '@deepseek-ai')
const hostPackages = join(root, 'node_modules', '@deepseek-ai')
const scratch = join(root, '.smoke', 'low-generation')

const fail = (message) => {
  console.error('verify-low-generation: FAIL — ' + message)
  process.exit(1)
}

if (!exists(join(lowPackages, 'dsh-mcp-client'))) {
  fail('no low-generation packages under ' + lowPackages + ' (set DSH_LOW_GENERATION_ROOT)')
}
if (!exists(join(root, 'lib', 'tools.js'))) fail('lib/tools.js is missing — run npm run build first')

function exists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    try {
      readdirSync(path)
      return true
    } catch {
      return false
    }
  }
}

// A SYMLINKED lib would resolve its imports from the worktree (Node resolves a
// module specifier against the realpath), silently testing the NEW generation —
// so the built host half is copied, and only the dependency farm is linked.
rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
cpSync(join(root, 'lib'), join(scratch, 'lib'), { recursive: true })
for (const entry of readdirSync(join(root, 'node_modules'))) {
  if (entry === '@deepseek-ai') continue
  symlinkSync(join(root, 'node_modules', entry), join(scratch, 'node_modules', entry), 'dir')
}
const swapped = ['dsh-mcp-client', 'dsh-attachment']
for (const name of readdirSync(hostPackages)) {
  const source = swapped.includes(name) ? join(lowPackages, name) : join(hostPackages, name)
  symlinkSync(source, join(scratch, 'node_modules', '@deepseek-ai', name), 'dir')
}

// 2. What does the built half actually resolve?
const resolved = execFileSync(process.execPath, ['-e',
  "console.log(import.meta.resolve('@deepseek-ai/dsh-mcp-client'))\n"
  + "console.log(import.meta.resolve('@deepseek-ai/dsh-attachment'))",
], { cwd: scratch, encoding: 'utf8' }).trim().split('\n')
// Compare DECODED paths: a workspace path with spaces comes back percent-encoded.
const resolvedPaths = resolved.map((url) => fileURLToPath(url))
for (const resolvedPath of resolvedPaths) {
  if (!resolvedPath.startsWith(lowRoot)) {
    fail('lib/ resolved outside the low-generation install: ' + resolvedPath)
  }
}
console.log('resolved against the low generation:\n  ' + resolvedPaths.join('\n  '))

const tools = await import(pathToFileURL(join(scratch, 'lib', 'tools.js')).href)

// 1. Production selection.
const selection = await tools.definitionBuilder()
if (selection.official !== false) fail('the low generation selected the official adapter — the fallback path was not exercised')
if (selection.build !== tools.buildLocalToolDefinition) fail('selection did not resolve to buildLocalToolDefinition')
console.log('selection: fallback (official export absent in the low generation)')

const canonicalBase64 = Buffer.from('hi').toString('base64')
const client = { callTool: async () => ({ content: [{ type: 'image', data: canonicalBase64, mimeType: 'image/png' }] }) }
const tool = { name: 'shot', inputSchema: { type: 'object' } }
const composition = (saveImages) => ({
  get: (name) => name === 'attachments'
    ? { saveImages }
    : name === 'llm'
      ? { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
      : undefined,
})
const run = async (ctx) => {
  const definition = selection.build({
    ctx,
    client,
    publicName: 'mcp__srv__shot',
    tool,
    opts: { serverName: 'srv', toolCallTimeoutMs: 60_000 },
  })
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: { provider: 'p', model: 'm' } },
  }
  const value = await definition.execute({}, exec)
  const rendered = definition.output.render({}, value)
  const finalized = definition.finalizeContent(exec, { value, content: rendered, isError: false })
  return { value, finalized }
}

// 3. Admission success through the low-generation services.
const saved = []
const admitted = await run(composition(async (inputs) => {
  saved.push(...inputs)
  return inputs.map((input, index) => ({ id: 'ref-' + index, mediaType: input.mediaType }))
}))
if (saved.length !== 1) fail('the attachment store was not called exactly once')
if (saved[0].data.toString('utf8') !== 'hi' || saved[0].mediaType !== 'image/png') fail('the decoded image handed to the store is wrong')
const imageBlock = (admitted.finalized ?? [])[0]
if (imageBlock?.type !== 'image' || imageBlock?.attachment?.id !== 'ref-0') {
  fail('finalizeContent did not return the admitted image content: ' + JSON.stringify(admitted.finalized))
}
if (!JSON.stringify(admitted.value).includes(canonicalBase64)) {
  fail('the canonical value lost the raw block')
}
console.log('admission: image stored and finalized as image content; canonical value keeps the raw block')

// 4. A correctable refusal uses the deployed predicate's wording.
const refusal = Object.assign(new Error('too large'), { code: 'IMAGE_TOO_LARGE' })
const refused = await run(composition(async () => { throw refusal }))
const text = (refused.finalized ?? [])[0]?.text ?? ''
if (!text.includes('image admission rejected the result: too large')) {
  fail('a correctable refusal did not use the admission-rejection wording: ' + text)
}
console.log('refusal: routed through the deployed admission predicate')

console.log('verify-low-generation: PASS (' + lowRoot + ')')
