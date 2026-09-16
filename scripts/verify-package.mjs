#!/usr/bin/env node
/**
 * Package-content and consumer verification (CI gate `verify:package`):
 *  1. explicit build, then npm pack into a scratch dir;
 *  2. assert the tarball carries exactly the publish surface (no src/tests/
 *     .smoke/node_modules leakage; lib + cordis.patch.yml + LICENSE + README);
 *  3. extract the tarball and typecheck a small consumer against BOTH
 *     entry points (`dsh-chamber-mcp` host types and `dsh-chamber-mcp/client`)
 *     with peer types resolved from the repo tree;
 *  4. assert the shipped browser half requires ONLY the React platform
 *     modules (the client-bundle purity invariant — every `@deepseek-ai/*`
 *     import must be type-only and erased);
 *  5. drive the built browser half through the loader wrapper in jsdom and
 *     assert its MCP tool-row registrations, states and interaction
 *     (`scripts/verify-client-artifact.mjs`);
 *  6. determinism spot check: a second build must produce identical
 *     lib/index.js and lib/client.js.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pkgName = pkg.name
// Version identity (AGENTS.md): package.json == package-lock \`packages[""]\`.
// No other gate compares the lock's root version, so a hand bump that forgot
// \`npm install --package-lock-only\` would ship a mismatched pair silently.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const lockRoot = lock.packages?.['']
if (lockRoot?.version !== pkg.version || lockRoot?.name !== pkg.name) {
  throw new Error(
    'package.json ' + pkg.name + '@' + pkg.version + ' != package-lock root '
    + String(lockRoot?.name) + '@' + String(lockRoot?.version) + ' — regenerate the lockfile',
  )
}
// The lock's root block must describe the SAME surface as the manifest. Name and
// version were the only comparison, so widening a peer range (or adding
// peerDependenciesMeta) without regenerating the lock stayed invisible — the
// lock then records a contract the published tarball does not have.
const surface = ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta']
const drifted = surface.filter((field) => (
  JSON.stringify(lockRoot?.[field] ?? null) !== JSON.stringify(pkg[field] ?? null)
))
if (drifted.length > 0) {
  throw new Error(
    'package-lock root ' + drifted.join(' / ') + ' drifted from package.json — regenerate the lockfile',
  )
}
// Every entry that records a tarball URL must also pin its bytes: a lock can be
// regenerated from a partial hidden lockfile with resolved-but-unpinned entries,
// which would install unverified content.
const unpinned = Object.entries(lock.packages ?? {}).filter(([key, entry]) => (
  key !== '' && typeof entry.resolved === 'string' && entry.integrity === undefined
))
if (unpinned.length > 0) {
  throw new Error(
    String(unpinned.length) + ' package-lock entries have a resolved URL but no integrity (e.g. '
    + unpinned[0][0] + ') — regenerate the lockfile from a clean tree',
  )
}
const scratch = join(root, '.smoke', 'verify')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
// npm must never write to the (possibly read-only) user HOME: redirect its
// cache/logs into the scratch dir.
const npmEnv = { ...process.env, npm_config_cache: join(scratch, 'npm-cache') }
const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env })

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'dist'), { recursive: true })
mkdirSync(join(scratch, 'consumer', 'node_modules'), { recursive: true })

// 1. build, then pack. `npm pack` normally runs the `prepack` hook, but a pack
// that runs without it (npm configuration, or the packed file list being
// gathered before the hook) ships whatever `lib/` happens to hold — and the
// determinism check at the end would then compare that STALE build against a
// fresh one and report a false "not deterministic". Building here keeps the
// whole gate self-sufficient and makes the packed artifact provably current.
run(process.execPath, [join(root, 'scripts', 'build.mjs')], root)
run('npm', ['pack', '--pack-destination', join(scratch, 'dist'), '--loglevel=error'], root, npmEnv)
const tgzName = readdirSync(join(scratch, 'dist')).filter((f) => f.endsWith('.tgz')).sort().at(-1)
if (!tgzName) throw new Error('pack produced no tarball')
console.log(`packed: ${tgzName}`)

// 2. contents whitelist
const listing = execFileSync('tar', ['-tzf', join(scratch, 'dist', tgzName)], { encoding: 'utf8' })
  .split('\n').filter(Boolean).map((l) => l.replace(/^package\//, ''))
const banned = listing.filter((l) => /^(src|tests|\.smoke|node_modules|scripts|docs|\.github)\//.test(l))
if (banned.length > 0) throw new Error(`tarball leaks non-publish paths: ${banned.join(', ')}`)
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'LICENSE', 'README.md', 'package.json']) {
  if (!listing.includes(required)) throw new Error(`tarball missing required entry: ${required}`)
}
if (!listing.some((l) => l.startsWith('lib/types/'))) throw new Error('tarball missing lib/types declarations')
// Every compiled module/declaration must map to a CURRENT src file: tsc only
// adds files, so without this a removed source keeps shipping its last build
// (which is exactly how a deleted module stayed in the tarball). The client
// bundle has no 1:1 source and is checked separately.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
const sources = new Set(walk(join(root, 'src')).map((file) =>
  file.slice(join(root, 'src').length + 1).replace(/\.tsx?$/, '')))
const orphans = listing.flatMap((entry) => {
  if (entry === 'lib/client.js' || !entry.startsWith('lib/')) return []
  const relative = entry.slice('lib/'.length)
  const key = relative.startsWith('types/')
    ? relative.slice('types/'.length).replace(/\.d\.ts$/, '')
    : relative.replace(/\.js$/, '')
  return sources.has(key) ? [] : [entry]
})
if (orphans.length > 0) throw new Error(`tarball carries artifacts with no current source: ${orphans.join(', ')}`)
console.log(`tarball contents OK (${listing.length} entries)`)

// 3. consumer typecheck against the extracted package
const extractDir = join(scratch, 'consumer', 'node_modules', pkgName)
mkdirSync(extractDir, { recursive: true })
// npm tarballs root everything under `package/`; strip it so the consumer
// resolves the module from the directory named after the package.
run('tar', ['-xzf', join(scratch, 'dist', tgzName), '-C', extractDir, '--strip-components=1'], root)
const consumerDir = join(scratch, 'consumer')
const consumer = join(consumerDir, 'consumer.ts')
writeFileSync(consumer, `// Consumer-surface typecheck against the packed artifact.
import type {} from '${pkgName}'
import type {} from '${pkgName}/client'
import type { McpScopeSectionProps, McpScopeFace, McpStoreSnapshot, SaveOutcome, AddDraft } from '${pkgName}/client'
import type { McpScopeDoc, ServerDef } from '${pkgName}'

// Compile-time shape probes (never executed).
declare const face: McpScopeFace
declare const doc: McpScopeDoc
declare const server: ServerDef
declare const snapshot: McpStoreSnapshot
declare const props: McpScopeSectionProps
declare const outcome: SaveOutcome
export type Probe = [typeof face, typeof doc, typeof server, typeof snapshot, typeof props, typeof outcome, AddDraft]
`)
// NodeNext resolution: the consumer sits under .smoke/, so @deepseek-ai peer
// types resolve from the repo's own node_modules on the upward walk.
const consumerTsc = join(scratch, 'consumer', 'tsconfig.json')
writeFileSync(consumerTsc, JSON.stringify({
  compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, skipLibCheck: true, noEmit: true,
    types: ['node'],
  },
  include: ['consumer.ts'],
}, null, 2))
run(process.execPath, [tsc, '-p', consumerTsc], consumerDir)
console.log('consumer typecheck OK (host + ./client entry types)')

// Execute the BUILT host entry against repo node_modules (runtime analog of
// chamber's installed-binary smoke): import failure or a missing export here
// is a packaging defect the typecheck cannot see.
const probe = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
for (const key of ['name', 'inject', 'Config', 'apply']) {
  if (!(key in probe)) throw new Error(`built lib/index.js is missing the ${key} export`)
}
console.log('built lib/index.js imports OK (exports: ' + Object.keys(probe).join(', ') + ')')

// Client-bundle purity (repo invariant): the shipped browser half is served
// from the loader's frozen platform table, so the ONLY specifiers it may
// require are the React modules. Every `@deepseek-ai/*` import in the client
// sources must be type-only and erased by the bundle step; a runtime import
// that slipped through would resolve nowhere in the browser.
const clientBundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const allowed = new Set(['react', 'react/jsx-runtime'])
const required = new Set(Array.from(clientBundle.matchAll(/require\("([^"]+)"\)/g), (match) => match[1]))
const impure = [...required].filter((name) => !allowed.has(name))
if (impure.length > 0) {
  throw new Error(`client bundle requires non-platform module(s): ${impure.join(', ')}`)
}
if (!required.has('react')) {
  throw new Error('client bundle does not require react — not a real plugin bundle?')
}
console.log(`client bundle purity OK (requires: ${[...required].sort().join(', ')})`)

// 5. shipped browser half, driven for real: the built bundle is evaluated
// through the loader wrapper against a fake client context, and its MCP tool
// row registrations/rendering/interaction are asserted.
run(process.execPath, [join(root, 'scripts', 'verify-client-artifact.mjs')], root)

// 6. determinism: rebuild once more and compare the WHOLE built tree (a missing
// or extra emitted file is a defect too — hashing only the two entry bundles
// would miss it).
// `walk` (declared with the contents check above) returns absolute paths.
const listLib = () => walk(join(root, 'lib')).map((file) => file.slice(root.length + 1)).sort()
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const snapshot = () => new Map(listLib().map((file) => [file, hash(join(root, file))]))
const before = snapshot()
run(process.execPath, [join(root, 'scripts', 'build.mjs')], root)
const after = snapshot()
for (const [file, digest] of before) {
  if (!after.has(file)) throw new Error(`build is not deterministic (${file} disappeared on rebuild)`)
  if (after.get(file) !== digest) throw new Error(`build is not deterministic (${file} changed on rebuild)`)
}
for (const file of after.keys()) {
  if (!before.has(file)) throw new Error(`build is not deterministic (${file} appeared on rebuild)`)
}
console.log('determinism OK (' + String(after.size) + ' files)')

console.log('verify:package PASS')
