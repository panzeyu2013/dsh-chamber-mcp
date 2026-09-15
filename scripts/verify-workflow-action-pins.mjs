#!/usr/bin/env node
/**
 * Workflow action-pin & structural verification (chamber norm, ported).
 *
 * - Every external action `uses:` must be EITHER a full 40-hex commit SHA
 *   (with a `# vX.Y.Z` comment) OR listed in the allowlist below. All actions
 *   are SHA-pinned as of 2026-09-12 (`actions/checkout@v5.1.0`,
 *   `actions/setup-node@v5.0.0`, `actions/upload-artifact@v6.0.0`,
 *   `softprops/action-gh-release@v3.0.3`), so the allowlist is empty and exists
 *   only as the mechanism for a temporary, explicitly justified exception.
 *   Pins are bumped by hand (Dependabot is disabled by maintainer choice):
 *   resolve the tag with `git ls-remote <repo> refs/tags/<tag>^{}` or the GitHub
 *   API, then update BOTH workflows in one commit and re-run this script. Upstream
 *   dsh pivots moving majors; chamber pins SHAs — this script enforces chamber's
 *   rule and keeps drift visible.
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

/** Moving-major exceptions. EMPTY since 2026-09-12: every action is pinned to a
 * 40-hex commit SHA now that the repository (and GitHub API) is reachable. Keep
 * the mechanism for a temporary, explicitly justified exception. */
const ALLOWED_MAJORS = new Map()

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
      // A bare SHA hides which release it is: every pin carries its tag comment
      // so a bump can be reviewed (and re-resolved) without the GitHub API.
      if (!/#\s*v?\d+\.\d+\.\d+/.test(rawLine)) {
        fail(file + ': ' + action + ' is SHA-pinned without a "# vX.Y.Z" comment')
      }
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
/** One step block, from its "- name:" line to the next step. */
function stepBlock(text, name) {
  const start = new RegExp('- name:\\s*' + name + '\\b').exec(text)
  if (start === null) return undefined
  const rest = text.slice(start.index)
  const next = /\n[ \t]*- name:/.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 1)
}
const mutationStep = /name:\s*Create GitHub Release/.exec(releaseYaml)
const gateStep = /name:\s*Full gate/.exec(releaseYaml)
if (mutationStep === null || gateStep === null) {
  // Both names are required: a rename used to silently disable this ordering check.
  fail('release.yml: expected a "Full gate" step and a "Create GitHub Release" step (rename detected)')
} else if (mutationStep.index < gateStep.index) {
  fail('release.yml: the GitHub-Release mutation step must come AFTER the full gate')
}
const refuseStep = stepBlock(releaseYaml, 'Refuse re-publishing an existing release')
if (refuseStep === undefined) {
  fail('release.yml: missing the "Refuse re-publishing an existing release" step (softprops silently updates existing releases)')
} else {
  // The guard must INSPECT the release and fail closed — prose in a comment or a
  // step name does not count.
  if (!/gh release view/.test(refuseStep) || !/gh release delete/.test(refuseStep) || !/exit 1/.test(refuseStep)) {
    fail('release.yml: the refuse step no longer inspects the release and fails closed (expected gh release view / gh release delete / exit 1)')
  }
  if (!/if:.*inputs\.dry_run/.test(refuseStep)) {
    fail('release.yml: the refuse step must be skipped on a dry run (expected "if: !inputs.dry_run")')
  }
}
const publishStep = stepBlock(releaseYaml, 'Create GitHub Release with tgz asset')
if (publishStep === undefined) {
  fail('release.yml: missing the "Create GitHub Release with tgz asset" step')
} else if (!/if:.*inputs\.dry_run/.test(publishStep)) {
  fail('release.yml: the release mutation step must be skipped on a dry run (expected "if: !inputs.dry_run")')
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
