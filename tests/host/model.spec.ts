/**
 * Document-eval unit tests over the shared model (src/shared/model.ts) and
 * the workspace helper (src/workspace.ts).
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_DOC,
  RESERVED_OVERRIDE_KEYS,
  credentialRefsOf,
  isEnabled,
  removeServerOverrides,
  validateDoc,
  type McpScopeDoc,
  type WorkspaceOverrides,
} from '../../src/shared/model.js'
import { canonicalCwd, workspaceIdOf } from '../../src/workspace.js'

describe('isEnabled', () => {
  it('defaults on when no record exists (new servers and workspaces)', () => {
    expect(isEnabled({}, 'ws-a', 'files')).toBe(true)
    expect(isEnabled({ 'ws-other': { files: true } }, 'ws-a', 'files')).toBe(true)
    expect(isEnabled({ 'ws-a': {} }, 'ws-a', 'files')).toBe(true)
  })

  it('turns off only when overrides[w][s] === true', () => {
    expect(isEnabled({ 'ws-a': { files: true } }, 'ws-a', 'files')).toBe(false)
    // Another server in the same workspace stays on.
    expect(isEnabled({ 'ws-a': { files: true } }, 'ws-a', 'git')).toBe(true)
  })
})

describe('validateDoc', () => {
  it('accepts a valid mixed document', () => {
    const doc: McpScopeDoc = {
      servers: [
        {
          serverName: 'files',
          transport: 'stdio',
          command: '/usr/bin/mcp-files',
          args: ['/srv'],
          envKeys: ['FILES_TOKEN'],
        },
        {
          serverName: 'github',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/github',
          headers: [{ name: 'Authorization', ref: 'GITHUB_TOKEN' }],
        },
      ],
      overrides: { 'ws-b': { files: true } },
    }
    expect(validateDoc(doc)).toEqual([])
  })

  it('flags duplicate serverNames', () => {
    const errors = validateDoc({
      servers: [
        { serverName: 'dup', transport: 'stdio', command: 'a' },
        { serverName: 'dup', transport: 'stdio', command: 'b' },
      ],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/duplicate serverName/)
  })

  it('flags bad serverName patterns', () => {
    const errors = validateDoc({
      servers: [{ serverName: 'has space', transport: 'stdio', command: 'a' }],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/name must match/)
  })

  it('flags empty stdio command and empty http url', () => {
    const errors = validateDoc({
      servers: [
        { serverName: 'a', transport: 'stdio', command: '' },
        { serverName: 'b', transport: 'streamable-http', url: '' },
      ],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/command is required/)
    expect(errors.join('; ')).toMatch(/url is required/)
  })

  it('flags duplicate env keys and invalid env refs', () => {
    const errors = validateDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'x', envKeys: ['TOKEN_A', 'TOKEN_A', '1BAD'] }],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/env key "TOKEN_A" listed twice/)
    expect(errors.join('; ')).toMatch(/env key "1BAD"/)
  })

  it('flags duplicate header names and invalid header refs', () => {
    const errors = validateDoc({
      servers: [{
        serverName: 'a',
        transport: 'streamable-http',
        url: 'https://x',
        headers: [
          { name: 'X-Auth', ref: 'TOKEN' },
          { name: 'X-Auth', ref: 'OTHER' },
          { name: 'Y', ref: 'bad ref!' },
        ],
      }],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/header "X-Auth" listed twice/)
    expect(errors.join('; ')).toMatch(/header ref "bad ref!"/)
  })
})

describe('removeServerOverrides', () => {
  it('removes the server from every row and prunes rows that become empty', () => {
    const overrides: WorkspaceOverrides = {
      'ws-a': { files: true, git: true },
      'ws-b': { files: true },
      'ws-c': { other: true },
    }
    const next = removeServerOverrides(overrides, 'files')
    expect(next).toEqual({
      'ws-a': { git: true },
      'ws-c': { other: true },
    })
    // Never mutates the input; rows for untouched servers survive.
    expect(overrides).toEqual({
      'ws-a': { files: true, git: true },
      'ws-b': { files: true },
      'ws-c': { other: true },
    })
  })

  it('returns the same object when nothing changed', () => {
    const overrides: WorkspaceOverrides = { 'ws-a': { git: true } }
    expect(removeServerOverrides(overrides, 'files')).toBe(overrides)
    const empty: WorkspaceOverrides = {}
    expect(removeServerOverrides(empty, 'files')).toBe(empty)
  })
})

describe('credentialRefsOf', () => {
  it('collects envKeys for stdio and header refs for http', () => {
    expect(credentialRefsOf({ serverName: 'a', transport: 'stdio', command: 'x', envKeys: ['A', 'B'] }))
      .toEqual(['A', 'B'])
    expect(credentialRefsOf({
      serverName: 'a',
      transport: 'streamable-http',
      url: 'https://x',
      headers: [{ name: 'X', ref: 'A' }, { name: 'Y', ref: 'B' }],
    })).toEqual(['A', 'B'])
  })
})

describe('own-property override semantics (pre-release F1)', () => {
  const row = (...names: string[]): Record<string, true> => {
    const out: Record<string, true> = {}
    for (const name of names) out[name] = true
    return out
  }
  it('a serverName colliding with an Object.prototype member stays default-on until its own row exists', () => {
    expect(isEnabled({}, 'ws-a', 'toString')).toBe(true)
    expect(isEnabled({ 'ws-other': row('toString') }, 'ws-a', 'toString')).toBe(true)
    // Own record present => off; another member of the same row is unaffected.
    expect(isEnabled({ 'ws-a': row('toString') }, 'ws-a', 'toString')).toBe(false)
    expect(isEnabled({ 'ws-a': row('toString') }, 'ws-a', 'valueOf')).toBe(true)
    // valueOf must not read the inherited member either.
    expect(isEnabled({ 'ws-a': row('valueOf') }, 'ws-a', 'valueOf')).toBe(false)
    expect(isEnabled({ 'ws-a': row() }, 'ws-a', 'toString')).toBe(true)
  })
})

describe('workspace helpers', () => {
  it('EMPTY_DOC is a frozen empty document', () => {
    expect(EMPTY_DOC.servers).toEqual([])
    expect(EMPTY_DOC.overrides).toEqual({})
    expect(Object.isFrozen(EMPTY_DOC)).toBe(true)
    expect(Object.isFrozen(EMPTY_DOC.servers)).toBe(true)
    expect(Object.isFrozen(EMPTY_DOC.overrides)).toBe(true)
  })

  it('validateDoc refuses reserved override-key serverNames', () => {
    for (const name of RESERVED_OVERRIDE_KEYS) {
      const doc: McpScopeDoc = { servers: [{ serverName: name, transport: 'stdio', command: 'x' }], overrides: {} }
      const errors = validateDoc(doc)
      expect(errors.join('\n')).toContain('reserved')
    }
  })

  it('canonicalCwd tolerates missing/empty cwd and unreadable paths', () => {
    expect(canonicalCwd(undefined)).toBeUndefined()
    expect(canonicalCwd('')).toBeUndefined()
    expect(canonicalCwd('/definitely/not/a/real/path-xyz')).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ws-'))
    try {
      expect(canonicalCwd(dir)).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches a session cwd to its workspace by canonical path', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-ws-'))
    try {
      const wsA = join(root, 'a')
      const wsB = join(root, 'b')
      mkdirSync(wsA)
      mkdirSync(wsB)
      const workspaces = [
        { id: 'ws-b', path: realpathSync(wsB) },
        { id: 'ws-a', path: realpathSync(wsA) },
      ]
      expect(workspaceIdOf(wsA, workspaces)).toBe('ws-a')
      expect(workspaceIdOf(join(wsB, '..', 'b'), workspaces)).toBe('ws-b')
      // Non-member directory.
      expect(workspaceIdOf(root, workspaces)).toBeUndefined()
      // Unknown/missing path.
      expect(workspaceIdOf(join(root, 'missing'), workspaces)).toBeUndefined()
      expect(workspaceIdOf(undefined, workspaces)).toBeUndefined()
      // Symlinked spellings resolve through realpath.
      const link = join(root, 'link-a')
      symlinkSync(wsA, link)
      expect(workspaceIdOf(link, workspaces)).toBe('ws-a')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('workspaceIdOf honors an injected realpath (deterministic error path)', () => {
    const workspaces = [{ id: 'ws-a', path: '/canon/a' }]
    expect(workspaceIdOf('/alias/a', workspaces, () => '/canon/a')).toBe('ws-a')
    expect(workspaceIdOf('/alias/a', workspaces, () => { throw new Error('gone') })).toBeUndefined()
  })
})
