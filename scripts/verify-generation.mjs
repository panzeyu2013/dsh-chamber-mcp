// Per-generation type guard: compile this tree's src and tests against the
// @deepseek-ai/dsh-* generation named on the command line, in a scratch tree
// that shares nothing with the dev install. CI runs it for every declared peer
// line besides the pinned dev tree, so "the peers say we support it" is backed
// by an actual compile on each PR instead of a release-time smoke alone.
//
//   node scripts/verify-generation.mjs 0.1.7-rc.2
//
// The scratch tree is <ROOT>/.scratch/verify-generation/<generation>/: a copy of
// src, tests and the two typecheck tsconfigs plus a package.json derived from
// this one with every @deepseek-ai/dsh-* dependency pinned to <generation>.
// tsc runs with --noEmit against src (tsconfig.json) and tests
// (tsconfig.tests.json); the run costs one npm install plus two tsc passes.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

/** Abort with the one-line reason (this script is a gate, not a library). */
function fail(message) {
  console.error(`verify-generation: ${message}`)
  process.exit(1)
}

const generation = process.argv[2]
if (!generation || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(generation)) {
  fail('usage: node scripts/verify-generation.mjs <dsh generation, e.g. 0.1.7-rc.2>')
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const pinned = []
for (const section of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      manifest[section][name] = generation
      pinned.push(name)
    }
  }
}
if (pinned.length === 0) fail('no @deepseek-ai/dsh-* dependencies found in package.json')
manifest.name = `${manifest.name}-verify-generation`
manifest.version = '0.0.0'
delete manifest.prepack
delete manifest.packageManager

const dir = join(ROOT, '.scratch', 'verify-generation', generation)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
for (const entry of ['src', 'tests', 'tsconfig.json', 'tsconfig.tests.json']) {
  cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
}

console.log(`verify-generation: ${pinned.length} @deepseek-ai/dsh-* dependencies pinned to ${generation}`)
console.log(`verify-generation: npm install in .scratch/verify-generation/${generation}`)
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: dir,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
for (const project of ['tsconfig.json', 'tsconfig.tests.json']) {
  console.log(`verify-generation: tsc -p ${project} --noEmit`)
  execFileSync(process.execPath, [tsc, '--noEmit', '-p', project], { cwd: dir, stdio: 'inherit' })
}
console.log(`verify-generation: PASS — src + tests compile against the ${generation} generation`)
