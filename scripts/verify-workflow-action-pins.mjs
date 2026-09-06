#!/usr/bin/env node
/**
 * Workflow action-pin & structural verification (chamber norm, ported).
 *
 * - Every external action `uses:` must be EITHER a full 40-hex commit SHA
 *   (with a `# vX.Y.Z` comment) OR listed in the checked-in allowlist below.
 *   The allowlist exists only because this repository is still developed
 *   without network access to GitHub (SHA resolution needs `git ls-remote`);
 *   replace it with full SHAs the moment the repo is public — the file header
 *   comment in each workflow must then be updated too. Upstream dsh itself
 *   pins moving majors; chamber pins SHAs — this script enforces chamber's
 *   rule once SHAs are resolvable and keeps drift visible until then.
 * - Structural release invariants (chamber release.yml postmortems):
 *   release.yml carries concurrency.group release-publish with
 *   cancel-in-progress:false; every GitHub-Release mutation step appears
 *   AFTER the full gate; a refuse-published-release guard exists.
 * - ci.yml runs the same chain on push main/master, tags v*, and PRs, and is
 *   also dispatchable (self-hosted smoke lane).
 * - Installs use `npm ci` (frozen) — never bare `npm install`.
 *
 * Run: node scripts/verify-workflow-action-pins.mjs  (npm run verify:workflows)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflowsDir = join(root, '.github', 'workflows')

/** Moving-major exceptions until SHA resolution is possible (see header). */
const ALLOWED_MAJORS = new Map([
  ['actions/checkout@v5', { sha: null, note: 'TODO: pin 40-hex SHA once the repo is public' }],
  ['actions/setup-node@v5', { sha: null, note: 'TODO: pin 40-hex SHA once the repo is public' }],
  ['actions/upload-artifact@v6', { sha: null, note: 'TODO: pin 40-hex SHA once the repo is public' }],
  ['softprops/action-gh-release@v3', { sha: null, note: 'TODO: pin 40-hex SHA once the repo is public' }],
])

const shaPattern = /^[0-9a-f]{40}$/
const usesPattern = /uses:\s*(.+?)(\s+#.*)?$/

function fail(message) {
  console.error(`verify-workflow-action-pins: ${message}`)
  process.exitCode = 1
}

const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))
if (workflowFiles.length === 0) fail(`no workflows found in ${workflowsDir}`)

const seenActions = new Map()
let releaseYaml = ''
let ciYaml = ''
for (const file of workflowFiles) {
  const text = readFileSync(join(workflowsDir, file), 'utf8')
  if (file === 'release.yml') releaseYaml = text
  if (file === 'ci.yml') ciYaml = text
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('uses:') && !line.startsWith('- uses:')) continue
    const match = line.match(/uses:\s*(\S+)/)
    if (!match) continue
    const ref = match[1]
    const [action, version] = ref.split('@')
    if (!action || !version) {
      fail(`${file}: malformed uses ref "${ref}"`)
      continue
    }
    if (shaPattern.test(version)) {
      const prev = seenActions.get(action)
      if (prev !== undefined && prev !== version) {
        fail(`${file}: action ${action} pinned at multiple SHAs (${prev} vs ${version})`)
      }
      seenActions.set(action, version)
      continue
    }
    if (ALLOWED_MAJORS.has(ref)) continue
    fail(`${file}: action "${ref}" is neither a 40-hex SHA nor allowlisted (${[...ALLOWED_MAJORS.keys()].join(', ')})`)
  }
}

// Structural release invariants
if (!/concurrency:\s*\n\s*group:\s*release-publish/.test(releaseYaml)) {
  fail('release.yml: missing concurrency.group: release-publish')
}
if (!/cancel-in-progress:\s*false/.test(releaseYaml)) {
  fail('release.yml: concurrency.cancel-in-progress must be false')
}
const mutationStep = /name:\s*Create GitHub Release/.exec(releaseYaml)
const gateStep = /name:\s*Full gate/.exec(releaseYaml)
if (mutationStep && gateStep && mutationStep.index < gateStep.index) {
  fail('release.yml: the GitHub-Release mutation step must come AFTER the full gate')
}
if (!/refuse|already published|stale draft/i.test(releaseYaml)) {
  fail('release.yml: missing refuse-published-release guard (softprops silently updates existing releases)')
}

// ci.yml trigger parity
if (!/tags:\s*\n\s*- 'v\*'|tags:\s*\[['\"]v\*['\"]\]/.test(ciYaml)) {
  fail('ci.yml: push tags [v*] must run the same validation chain as main/PR (chamber norm)')
}
if (!/workflow_dispatch/.test(ciYaml)) {
  fail('ci.yml: workflow_dispatch missing (self-hosted smoke job is dead config without it)')
}

// Frozen installs only
for (const [name, text] of [['ci.yml', ciYaml], ['release.yml', releaseYaml]]) {
  if (/run:\s*[^\n]*\bnpm install\b(?!\s*--)/.test(text)) {
    fail(`${name}: bare npm install would silently rewrite the lockfile — use npm ci`)
  }
}

if (process.exitCode === undefined) console.log('verify-workflow-action-pins: PASS')
