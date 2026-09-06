#!/usr/bin/env node
/**
 * Compose GitHub release notes from the Keep-a-Changelog document.
 *
 * Usage: node scripts/release-notes.mjs <version> [--out <file>]
 *
 * Extracts the `## [<version>] - <date>` section (content until the next
 * `## ` heading) from CHANGELOG.md and prints it — or writes it to `--out`.
 * Fails loudly when the released version has no section, so a tag can never
 * ship without changelog notes. `Unreleased` is ignored.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const version = args[0]
if (version === undefined || /^--/.test(version)) {
  console.error('usage: release-notes.mjs <version> [--out <file>]')
  process.exit(2)
}
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const lines = changelog.split('\n')

/** Heading level + parsed section key; sections are `## [<key>] - <date>` or `## <key>`. */
function headingOf(line) {
  const trimmed = line.trim()
  // A '[' must be closed by ']' — otherwise a hyphen inside a bracketed
  // pre-release key (0.0.1-beta.1) would split at the first '-'.
  const match =
    /^(#{1,6})\s+\[([^\]]+)\](?:\s*-\s*(.+))?$/.exec(trimmed) ??
    /^(#{1,6})\s+([^\s]+?)(?:\s*-\s*(.+))?$/.exec(trimmed)
  if (!match) return undefined
  const [, hashes, key, date] = match
  return { level: hashes.length, key: key.trim(), date: date?.trim() }
}

let capture = false
let collected = []
let sectionDate
for (const line of lines) {
  const heading = headingOf(line)
  if (heading !== undefined && heading.level <= 2) {
    if (capture) break // next top-level section ends the capture
    if (heading.level === 2 && heading.key === version) {
      capture = true
      sectionDate = heading.date
      continue // skip the header line itself
    }
  }
  if (capture) {
    // Trailing HTML comments (e.g. the comparison-link footer) are file
    // scaffolding, not release notes.
    if (line.trimStart().startsWith('<!--')) break
    collected.push(line)
  }
}

if (!capture) {
  console.error(`CHANGELOG.md has no "## [${version}]" section — add one (Keep a Changelog) before tagging.`)
  process.exit(1)
}

let body = collected.join('\n').trim()
if (body.length === 0) {
  console.error(`CHANGELOG section "## [${version}]" is empty — add release notes before tagging.`)
  process.exit(1)
}
if (sectionDate === undefined || sectionDate === '') {
  console.error(`CHANGELOG section "## [${version}]" has no date ("## [${version}] - YYYY-MM-DD").`)
  process.exit(1)
}

body = `## ${version}${sectionDate !== undefined ? ` - ${sectionDate}` : ''}\n\n${body}\n`

if (outFile !== undefined) {
  writeFileSync(outFile, body)
  console.log(`release notes for ${version} written to ${outFile}`)
} else {
  process.stdout.write(body)
}
