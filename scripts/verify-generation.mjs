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
//
// A generation newer than the dev pin may peer on newer framework packages than
// this tree pins (0.2.2 does), so the exact install fails ERESOLVE. Audit such
// a line BEFORE moving the pin by passing those packages explicitly:
//
//   node scripts/verify-generation.mjs 0.2.2-alpha.2 \
//     --pin @deepseek-ai/cordis@4.0.6-alpha.1 \
//     --pin @deepseek-ai/cordis-plugin-loader@1.0.7-alpha.1 \
//     --pin @deepseek-ai/schemastery@~3.18.6-alpha.1
//
// The install stays EXACT (no --legacy-peer-deps): the closure is complete, so
// the framework types are exercised too. CI passes no pins and remains strict —
// a future pin that reopens a peer conflict still fails there loudly.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

/** Abort with the one-line reason (this script is a gate, not a library). */
function fail(message) {
  console.error(`verify-generation: ${message}`)
  process.exit(1)
}

/**
 * Parse repeated `--pin <name>@<range>` arguments.
 * @param argv - arguments after the generation.
 * @returns package name → range.
 */
function parsePins(argv) {
  const pins = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--pin') fail(`unknown argument "${argv[index]}" (expected --pin <name>@<range>)`)
    const spec = argv[index + 1]
    if (spec === undefined) fail('--pin needs a value, e.g. --pin @deepseek-ai/cordis@4.0.6-alpha.1')
    const at = spec.lastIndexOf('@')
    if (at <= 0) fail(`--pin "${spec}" must be <name>@<range>`)
    const name = spec.slice(0, at)
    // The generation's own packages are the thing under test: a --pin must not
    // silently downgrade one of them while PASS still names the generation.
    if (name.startsWith('@deepseek-ai/dsh-')) {
      fail(`--pin may not repin the generation's own package "${name}"`)
    }
    pins.set(name, spec.slice(at + 1))
    index += 1
  }
  return pins
}

const generation = process.argv[2]
if (!generation || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(generation)) {
  fail('usage: node scripts/verify-generation.mjs <dsh generation> [--pin <name>@<range> …]')
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
const extraPins = parsePins(process.argv.slice(3))
for (const [name, range] of extraPins) {
  const section = manifest.dependencies?.[name] !== undefined
    ? 'dependencies'
    : 'devDependencies'
  manifest[section] = { ...(manifest[section] ?? {}), [name]: range }
}
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

/**
 * Install the scratch tree's dependency set.
 * @param extraArgs - flags appended to the npm command line.
 * @param label - how the attempt is announced.
 */
function install(extraArgs = [], label = 'exact') {
  console.log(`verify-generation: npm install (${label}) in .scratch/verify-generation/${generation}`)
  // Captured, then replayed: the failure classifier below needs npm's text to
  // tell a PEER conflict from a registry/network failure, and the success path
  // still has to show what was installed.
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...extraArgs], {
    cwd: dir,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    const failure = new Error(`npm install exited ${String(result.status)}`)
    failure.stdout = result.stdout
    failure.stderr = result.stderr
    throw failure
  }
}

/**
 * The scratch tree's own `semver` (the manifest carries it as a devDependency).
 * Loaded lazily from the INSTALLED tree: the CI compat job runs this script
 * without installing this checkout's node_modules, so a top-level import of a
 * non-builtin would fail before the first line of work.
 * @returns a prerelease-inclusive range test, or undefined when unavailable.
 */
function peerRangeTest() {
  try {
    const scratchRequire = createRequire(join(dir, 'package.json'))
    const semver = scratchRequire('semver')
    return (version, range) => semver.satisfies(version, range, { includePrerelease: true })
  } catch {
    return undefined
  }
}

/**
 * Declared (non-optional) peers the installed tree fails to satisfy: absent, or
 * present at a version outside the declared range (npm 11 flags both).
 *
 * Scope: the TOP-LEVEL `@deepseek-ai/*` installs only — a peer that npm nested
 * under a dependent is not scanned. This is a diagnostic warning, not a gate:
 * the guard's verdict is the two tsc passes, and an exact install of a derived
 * manifest leaves nothing to report.
 * @returns readable `peer@installed (needs range)` lines.
 */
function unsatisfiedPeers() {
  const base = join(dir, 'node_modules', '@deepseek-ai')
  if (!existsSync(base)) return []
  const inRange = peerRangeTest()
  if (inRange === undefined) {
    console.warn('verify-generation: semver is unavailable in the scratch tree — peer RANGES unchecked (absence still checked)')
  }
  const problems = new Set()
  for (const name of readdirSync(base)) {
    const manifestPath = join(base, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[peer]?.optional === true) continue
      const installedPath = join(dir, 'node_modules', peer, 'package.json')
      if (!existsSync(installedPath)) {
        problems.add(`${peer}@absent (needs ${range})`)
        continue
      }
      if (inRange === undefined) continue
      const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version
      if (!inRange(installed, range)) {
        problems.add(`${peer}@${installed} (needs ${range})`)
      }
    }
  }
  return [...problems].sort()
}

console.log(`verify-generation: ${pinned.length} @deepseek-ai/dsh-* dependencies pinned to ${generation}`)
if (extraPins.size > 0) {
  console.log(`verify-generation: extra pins: ${[...extraPins].map(([name, range]) => `${name}@${range}`).join(', ')}`)
}
try {
  install()
} catch (error) {
  const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  if (output.trim() !== '') process.stderr.write(output.endsWith('\n') ? output : `${output}\n`)
  if (/ERESOLVE|Could not resolve dependency/.test(output)) {
    fail('peer conflict: this generation peers on packages newer than this tree pins. '
      + 'Pass them explicitly with --pin <name>@<range>; the ranges npm just named are in the '
      + 'output above. For 0.2.2 that is cordis 4.0.6-alpha.1, cordis-plugin-loader '
      + '1.0.7-alpha.1 and schemastery ~3.18.6-alpha.1 (docs/RELEASE.md §Auditing a new '
      + 'upstream line (6)).')
  }
  fail('npm install failed for a reason other than peer resolution — see the output above')
}
const unsatisfied = unsatisfiedPeers()
if (unsatisfied.length > 0) {
  console.warn(
    `verify-generation: WARNING — ${unsatisfied.length} declared peer(s) are not satisfied by the installed tree: `
    + unsatisfied.join(', '),
  )
}

const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
for (const project of ['tsconfig.json', 'tsconfig.tests.json']) {
  console.log(`verify-generation: tsc -p ${project} --noEmit`)
  execFileSync(process.execPath, [tsc, '--noEmit', '-p', project], { cwd: dir, stdio: 'inherit' })
}
const mode = extraPins.size > 0 ? ` [extra pins: ${[...extraPins.keys()].join(', ')}]` : ''
console.log(`verify-generation: PASS — src + tests compile against the ${generation} generation${mode}`)
