#!/usr/bin/env node
/**
 * Package-content and consumer verification (CI gate `verify:package`):
 *  1. npm pack (prepack runs the build) into a scratch dir;
 *  2. assert the tarball carries exactly the publish surface (no src/tests/
 *     .smoke/node_modules leakage; lib + cordis.patch.yml + LICENSE + README);
 *  3. extract the tarball and typecheck a small consumer against BOTH
 *     entry points (`dsh-chamber-mcp` host types and `dsh-chamber-mcp/client`)
 *     with peer types resolved from the repo tree;
 *  4. determinism spot check: a second build must produce identical
 *     lib/index.js and lib/client.js.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const scratch = join(root, '.smoke', 'verify')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
// npm must never write to the (possibly read-only) user HOME: redirect its
// cache/logs into the scratch dir.
const npmEnv = { ...process.env, npm_config_cache: join(scratch, 'npm-cache') }
const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env })

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'dist'), { recursive: true })
mkdirSync(join(scratch, 'consumer', 'node_modules'), { recursive: true })

// 1. pack
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

// 4. determinism: rebuild once more and compare host + client bundles
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const before = [hash(join(root, 'lib', 'index.js')), hash(join(root, 'lib', 'client.js'))]
run(process.execPath, [join(root, 'scripts', 'build.mjs')], root)
const after = [hash(join(root, 'lib', 'index.js')), hash(join(root, 'lib', 'client.js'))]
if (before[0] !== after[0] || before[1] !== after[1]) {
  throw new Error('build is not deterministic (lib/index.js or lib/client.js changed on rebuild)')
}
console.log('determinism OK')

console.log('verify:package PASS')
