/**
 * Pure paste/import parser tests (src/client/import.ts). These cover the
 * clipboard→draft mapping the staged form uses: command splitting, .env and
 * header line parsing, ref normalization, and MCP JSON snippets.
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeRef,
  parseHeaderLines,
  parseKeyValueLines,
  parseMcpSnippet,
  refFromHeaderName,
  splitCommandLine,
} from '../../src/client/import.js'

describe('splitCommandLine', () => {
  it('splits plain words', () => {
    expect(splitCommandLine('npx -y @some/mcp --flag')).toEqual(['npx', '-y', '@some/mcp', '--flag'])
  })

  it('keeps quoted segments together and preserves empty quoted arguments', () => {
    expect(splitCommandLine('node "/a b/c.js" --x')).toEqual(['node', '/a b/c.js', '--x'])
    expect(splitCommandLine("cmd 'single quoted' ''")).toEqual(['cmd', 'single quoted', ''])
  })

  it('honours a double-quote backslash escape and collapses whitespace', () => {
    const escapedQuote = ['a', '\\', '"', 'b'].join('') // a\"b
    const escapedInQuotes = ['"', 'c', '\\', '\\', 'd', '"'].join('') // "c\\d"
    expect(splitCommandLine(escapedQuote)).toEqual(['a"b'])
    expect(splitCommandLine(escapedInQuotes)).toEqual(['c\\d'])
    expect(splitCommandLine('  one   two  ')).toEqual(['one', 'two'])
  })
})

describe('parseKeyValueLines', () => {
  it('parses .env lines, skips comments/blanks and strips quotes', () => {
    const rows = parseKeyValueLines([
      '# comment',
      '',
      'TOKEN=abc',
      'export OTHER="a b"',
      "THIRD='x=y'",
      'not-a-pair',
      '=missing-key',
    ].join('\n'))
    expect(rows).toEqual([
      { key: 'TOKEN', value: 'abc' },
      { key: 'OTHER', value: 'a b' },
      { key: 'THIRD', value: 'x=y' },
    ])
  })
})

describe('parseHeaderLines', () => {
  it('parses colon and equals forms, preferring the earlier separator', () => {
    const rows = parseHeaderLines('Authorization: Bearer x\nX-Api-Key=abc\n# note\n\nBad')
    expect(rows).toEqual([
      { name: 'Authorization', value: 'Bearer x' },
      { name: 'X-Api-Key', value: 'abc' },
    ])
  })
})

describe('ref normalization', () => {
  it('uppercases and keeps env-safe characters', () => {
    expect(normalizeRef(' token ')).toBe('TOKEN')
    expect(normalizeRef('my-token.v2')).toBe('MY_TOKEN_V2')
    expect(normalizeRef('1BAD')).toBe('_1BAD')
    expect(normalizeRef('---')).toBe('')
  })

  it('derives header names into env-style refs', () => {
    expect(refFromHeaderName('X-Api-Key')).toBe('X_API_KEY')
    expect(refFromHeaderName('Authorization')).toBe('AUTHORIZATION')
  })
})

describe('parseMcpSnippet', () => {
  it('reads a Claude/Cursor mcpServers remote entry with headers', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      mcpServers: {
        github: { url: 'https://mcp.example.com/x', headers: { Authorization: 'Bearer t' }, timeout: 3000 },
      },
    }))
    expect(outcome).toEqual({
      ok: true,
      others: [],
      server: {
        name: 'github',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/x',
        headers: [{ name: 'Authorization', ref: 'AUTHORIZATION', value: 'Bearer t' }],
        env: [],
        enabled: true,
        timeoutMs: '3000',
      },
    })
  })

  it('reads an opencode local entry: command array, env values and enabled flag', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      mcp: { files: { type: 'local', command: ['node', 'server.js', '--root', '/srv'], env: { FILES_TOKEN: 'secret' }, enabled: false } },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toEqual({
      name: 'files',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--root', '/srv'],
      headers: [],
      env: [{ key: 'FILES_TOKEN', value: 'secret' }],
      enabled: false,
    })
  })

  it('splits a string command and reports additional servers', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      mcpServers: {
        first: { command: 'npx -y @a/mcp' },
        second: { command: 'node other.js' },
      },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server.command).toBe('npx')
    expect(outcome.server.args).toEqual(['-y', '@a/mcp'])
    expect(outcome.others).toEqual(['second'])
  })

  it('accepts a flat single-server object and a lone named entry', () => {
    const flat = parseMcpSnippet('{"command":"node","args":["a.js"],"cwd":"/srv"}')
    expect(flat.ok).toBe(true)
    if (flat.ok) expect(flat.server).toMatchObject({ transport: 'stdio', command: 'node', args: ['a.js'], cwd: '/srv' })
    const named = parseMcpSnippet('{"myserver":{"url":"https://x/mcp"}}')
    expect(named.ok).toBe(true)
    if (named.ok) expect(named.server).toMatchObject({ name: 'myserver', transport: 'streamable-http', url: 'https://x/mcp' })
  })

  it('honours disabled:true as the inverse enable flag', () => {
    const outcome = parseMcpSnippet(JSON.stringify({ mcpServers: { a: { command: 'node a.js', disabled: true } } }))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.server.enabled).toBe(false)
  })

  it('reports empty, invalid and unsupported input without throwing', () => {
    expect(parseMcpSnippet('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(parseMcpSnippet('{nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseMcpSnippet('{"hello":1}')).toEqual({ ok: false, reason: 'unsupported' })
    expect(parseMcpSnippet('[]')).toEqual({ ok: false, reason: 'invalid' })
  })
})
