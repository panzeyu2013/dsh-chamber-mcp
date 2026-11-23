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
  parseMcpSnippetCandidates,
  refFromHeaderName,
  splitCommandLine,
  stripJsonComments,
  stripTrailingCommas,
} from '../../src/client/import.js'

describe('splitCommandLine', () => {
  it('splits plain words', () => {
    expect(splitCommandLine('npx -y @some/mcp --flag')).toEqual(['npx', '-y', '@some/mcp', '--flag'])
  })

  it('keeps quoted segments together and preserves empty quoted arguments', () => {
    expect(splitCommandLine('node "/a b/c.js" --x')).toEqual(['node', '/a b/c.js', '--x'])
    expect(splitCommandLine("cmd 'single quoted' ''")).toEqual(['cmd', 'single quoted', ''])
  })

  it('keeps path separators inside a quoted Windows command', () => {
    expect(splitCommandLine('"C:\\Program Files\\node.exe" -v')).toEqual(['C:\\Program Files\\node.exe', '-v'])
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

  it('cuts an unquoted inline comment but keeps a quoted hash', () => {
    expect(parseKeyValueLines('KEY=abc # note\nQUOTED="a # b"\nBARE=#hash\nHASH=a#b')).toEqual([
      { key: 'KEY', value: 'abc' },
      { key: 'QUOTED', value: 'a # b' },
      { key: 'BARE', value: '#hash' },
      { key: 'HASH', value: 'a#b' },
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
        toolCallTimeoutMs: '3000',
        warnings: [],
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
      env: [{ key: 'FILES_TOKEN', ref: '', value: 'secret' }],
      enabled: false,
      warnings: [],
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
    expect(parseMcpSnippet('[]')).toEqual({ ok: false, reason: 'unsupported' })
    // YAML is not JSON: it stays a business failure instead of a half-import.
    expect(parseMcpSnippet('mcp:\n  files:\n    command: node')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('parseMcpSnippet tolerance', () => {
  /** The reported paste: an opencode `mcp` section with no enclosing braces. */
  const section = [
    '"mcp": {',
    '  "zotero": { "type": "local", "command": ["/Users/me/.local/bin/zotero-mcp"], "enabled": true },',
    '  "iMCP": { "type": "local", "command": ["/Applications/iMCP.app/Contents/MacOS/imcp-server"], "enabled": true },',
    '  "email": { "type": "local", "command": ["uvx", "mcp-email-server", "stdio"], "enabled": true },',
    '  "sharelatex": { "type": "local", "command": ["sharelatex-mcp"], "enabled": true }',
    '}',
  ].join('\n')

  it('reads a brace-less pasted config section and reports the other servers', () => {
    const outcome = parseMcpSnippet(section)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toEqual({
      name: 'zotero',
      transport: 'stdio',
      command: '/Users/me/.local/bin/zotero-mcp',
      args: [],
      headers: [],
      env: [],
      enabled: true,
      warnings: [],
    })
    expect(outcome.others).toEqual(['iMCP', 'email', 'sharelatex'])
  })

  it('reads a bare server map with no "mcp" wrapper, and drops stray separators', () => {
    const bare = [
      '"zotero": { "type": "local", "command": ["/Users/me/.local/bin/zotero-mcp"], "enabled": true },',
      '"iMCP": { "type": "local", "command": ["/Applications/iMCP.app/Contents/MacOS/imcp-server"], "enabled": true },',
      '"email": { "type": "local", "command": ["uvx", "mcp-email-server", "stdio"], "enabled": true }',
    ].join('\n')
    const outcome = parseMcpSnippet(bare)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toMatchObject({ name: 'zotero', transport: 'stdio', command: '/Users/me/.local/bin/zotero-mcp', args: [] })
    expect(outcome.others).toEqual(['iMCP', 'email'])

    // The same section keeps working when the paste keeps the separator or the
    // parent map's closing brace.
    for (const suffix of [',', '\n  }', ',\n  }']) {
      const variant = parseMcpSnippet(bare + suffix)
      expect(variant.ok).toBe(true)
      if (!variant.ok) continue
      expect(variant.server.name).toBe('zotero')
      expect(variant.others).toEqual(['iMCP', 'email'])
    }
  })

  it('drops a trailing comma inside a single named entry', () => {
    const outcome = parseMcpSnippet('"a": { "command": "node a.js", }')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.server).toMatchObject({ name: 'a', command: 'node', args: ['a.js'] })
  })

  it('reads the section behind braces, behind a wrapper key, and as a top-level array', () => {
    const wrapped = parseMcpSnippet('{\n  ' + section + '\n}')
    expect(wrapped.ok).toBe(true)
    if (wrapped.ok) expect(wrapped.server.name).toBe('zotero')
    const nested = parseMcpSnippet('{"settings": {' + section + '}}')
    expect(nested.ok).toBe(true)
    if (nested.ok) expect(nested.server.name).toBe('zotero')
    const listed = parseMcpSnippet('[{"name":"a","command":"node a.js"},{"name":"b","command":"node b.js"}]')
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.server).toMatchObject({ name: 'a', command: 'node' })
      expect(listed.others).toEqual(['b'])
    }
  })

  it('tolerates JSONC comments and trailing commas, URL strings included', () => {
    const outcome = parseMcpSnippet([
      '{',
      '  // my servers',
      '  "mcp": {',
      '    "files": {',
      '      "type": "local",',
      '      "command": ["node", "server.js"],',
      '      "env": { "BASE": "https://host//x", "RAW": "a/*b*/c" },',
      '    },',
      '  }, /* one map */',
      '}',
    ].join('\n'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toMatchObject({ name: 'files', transport: 'stdio', command: 'node', args: ['server.js'] })
    expect(outcome.server.env).toEqual([
      { key: 'BASE', ref: '', value: 'https://host//x' },
      { key: 'RAW', ref: '', value: 'a/*b*/c' },
    ])
  })

  it('reads a fenced block, surrounding prose and the VS Code servers shape', () => {
    const fenced = parseMcpSnippet('here you go:\n```json\n{"mcp":{"a":{"command":"node a.js"}}}\n```\nthanks')
    expect(fenced.ok).toBe(true)
    if (fenced.ok) expect(fenced.server).toMatchObject({ name: 'a', command: 'node', args: ['a.js'] })
    const prose = parseMcpSnippet('see [the docs] then {"mcp":{"b":{"command":"node b.js"}}}')
    expect(prose.ok).toBe(true)
    if (prose.ok) expect(prose.server.name).toBe('b')
    const vscode = parseMcpSnippet('{"servers":{"c":{"type":"stdio","command":"node","args":["c.js"]}}}')
    expect(vscode.ok).toBe(true)
    if (vscode.ok) expect(vscode.server).toMatchObject({ name: 'c', command: 'node', args: ['c.js'] })
  })

  it('keeps the transport honest when type and fields disagree', () => {
    const remote = parseMcpSnippet('{"mcp":{"r":{"type":"remote","url":"https://x/mcp"}}}')
    expect(remote.ok).toBe(true)
    if (remote.ok) expect(remote.server).toMatchObject({ transport: 'streamable-http', url: 'https://x/mcp' })
    // `type` says remote but a command is all that exists: import it as stdio.
    const commandWins = parseMcpSnippet('{"mcp":{"r":{"type":"remote","command":"node r.js"}}}')
    expect(commandWins.ok).toBe(true)
    if (commandWins.ok) expect(commandWins.server).toMatchObject({ transport: 'stdio', command: 'node' })
  })

  it('reads string flags and coerces scalar command entries', () => {
    const outcome = parseMcpSnippet('{"mcp":{"s":{"command":["node",1],"enabled":"false"}}}')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.server).toMatchObject({ command: 'node', args: ['1'], enabled: false })
  })
})

describe('parseMcpSnippet: pasted transcripts and torn sections', () => {
  it('prefers a later named config over an example snippet pasted above it', () => {
    const config = '{"mcpServers":{"a":{"command":"node a.js"}}}'
    for (const text of [
      'Example response: {"ok":true}. Now the config: ' + config,
      'Rows: [1,2,3]. Config: ' + config,
      'First:\n```json\n{"command":"node first.js"}\n```\nThen:\n```json\n' + config + '\n```',
    ]) {
      const outcome = parseMcpSnippet(text)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.server).toMatchObject({ name: 'a', command: 'node', args: ['a.js'] })
    }
  })

  it('falls back to a flat server when the paste has no named map at all', () => {
    const outcome = parseMcpSnippet('first {"a":1} second {"command":"node a.js"}')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.server).toMatchObject({ command: 'node', args: ['a.js'] })
  })

  it('finds the config after an unbalanced opener or a stray brace', () => {
    const config = '{"mcpServers":{"a":{"command":"node a.js"}}}'
    for (const text of ['Use {"placeholder then add ' + config, 'List [1,2 and config ' + config]) {
      const outcome = parseMcpSnippet(text)
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.server.name).toBe('a')
    }
  })

  it('reads a torn section whose separators were left behind', () => {
    const missingComma = parseMcpSnippet('"a": {"command":"node a.js"}\n"b": {"command":"node b.js"}')
    expect(missingComma.ok).toBe(true)
    if (missingComma.ok) {
      expect(missingComma.server).toMatchObject({ name: 'a', command: 'node', args: ['a.js'] })
      expect(missingComma.others).toEqual(['b'])
    }
    const leadingComma = parseMcpSnippet(',\n"a": {"command":"node a.js"},\n"b": {"command":"node b.js"}')
    expect(leadingComma.ok).toBe(true)
    if (leadingComma.ok) expect(leadingComma.others).toEqual(['b'])
    const remotes = parseMcpSnippet('"a": {"url":"https://x/mcp"}\n"b": {"url":"https://y/mcp"}')
    expect(remotes.ok).toBe(true)
    if (remotes.ok) {
      expect(remotes.server).toMatchObject({ name: 'a', transport: 'streamable-http', url: 'https://x/mcp' })
      expect(remotes.others).toEqual(['b'])
    }
  })

  it('reads the remaining field shapes the audit called out', () => {
    const envList = parseMcpSnippet('{"mcpServers":{"a":{"command":"node","env":["A=1","B=2"]}}}')
    expect(envList.ok).toBe(true)
    if (envList.ok) {
      expect(envList.server.env).toEqual([
        { key: 'A', ref: '', value: '1' },
        { key: 'B', ref: '', value: '2' },
      ])
    }
    const nestedArgs = parseMcpSnippet('{"mcpServers":{"a":{"command":"node","args":["a.js",["nested"]]}}}')
    expect(nestedArgs.ok).toBe(true)
    if (nestedArgs.ok) expect(nestedArgs.server.args).toEqual(['a.js'])
    const flatName = parseMcpSnippet('{"name":"flatname","command":"node a.js"}')
    expect(flatName.ok).toBe(true)
    if (flatName.ok) expect(flatName.server.name).toBe('flatname')
    const arrayMap = parseMcpSnippet('{"w":{"mcpServers":[{"name":"a","command":"node a.js"},{"name":"b","command":"node b.js"}]}}')
    expect(arrayMap.ok).toBe(true)
    if (arrayMap.ok) {
      expect(arrayMap.server).toMatchObject({ name: 'a', command: 'node' })
      expect(arrayMap.others).toEqual(['b'])
    }
    const fallbackTimeout = parseMcpSnippet('{"mcpServers":{"a":{"command":"node","timeoutMs":"bad","timeout":7000}}}')
    expect(fallbackTimeout.ok).toBe(true)
    if (fallbackTimeout.ok) expect(fallbackTimeout.server.toolCallTimeoutMs).toBe('7000')
    const stringHeaders = parseMcpSnippet('{"mcpServers":{"a":{"url":"https://x","headers":["Authorization: Bearer x"]}}}')
    expect(stringHeaders.ok).toBe(true)
    if (stringHeaders.ok) {
      expect(stringHeaders.server.headers).toEqual([{ name: 'Authorization', ref: 'AUTHORIZATION', value: 'Bearer x' }])
    }
    const deepWrapper = parseMcpSnippet(
      '{"a":{"b":{"c":{"d":{"e":{"mcpServers":{"s1":{"command":"node 1"},"s2":{"command":"node 2"}}}}}}}}',
    )
    expect(deepWrapper.ok).toBe(true)
    if (deepWrapper.ok) expect(deepWrapper.others).toEqual(['s2'])
  })

  it('never throws on non-string input and survives long fence runs', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const outcome = parseMcpSnippet(bad as unknown as string)
      expect(outcome).toEqual({ ok: false, reason: 'empty' })
    }
    const fenceRun = '`'.repeat(16000) + '\nbody'
    const outcome = parseMcpSnippet(fenceRun)
    expect(outcome.ok).toBe(false)
  })
})

describe('stripJsonComments / stripTrailingCommas', () => {
  it('never rewrites comment-like text inside strings', () => {
    expect(stripJsonComments('{"u":"https://x//y","v":"/*k*/"} // tail')).toBe('{"u":"https://x//y","v":"/*k*/"} \n')
    expect(stripTrailingCommas('{"a":[1,2,],"b":"x,",}')).toBe('{"a":[1,2],"b":"x,"}')
  })
})

describe('parseMcpSnippet hardening', () => {
  it('keeps a quoted server name holding spaces, colons or braces', () => {
    const spaced = parseMcpSnippet('"my server": { "command": "node a.js" }')
    expect(spaced.ok).toBe(true)
    if (spaced.ok) expect(spaced.server.name).toBe('my server')
    const odd = parseMcpSnippet('{"mcpServers":{"weird: {x}":{"command":"node a.js"}}}')
    expect(odd.ok).toBe(true)
    if (odd.ok) expect(odd.server.name).toBe('weird: {x}')
  })

  it('trims the imported name', () => {
    const outcome = parseMcpSnippet('{"mcpServers":{"  a  ":{"command":"node"}}}')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.server.name).toBe('a')
  })

  it('prefers a usable entry over an empty one in the same map', () => {
    const outcome = parseMcpSnippet('{"mcp":{"empty":{},"real":{"command":"node real.js"}}}')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toMatchObject({ name: 'real', command: 'node', args: ['real.js'] })
    expect(outcome.others).toEqual([])
  })

  it('keeps every server of a map that sits behind a wrapper key', () => {
    const nested = parseMcpSnippet('{"settings":{"mcp":{"a":{"command":"node a.js"},"b":{"command":"node b.js"}}}}')
    expect(nested.ok).toBe(true)
    if (!nested.ok) return
    expect(nested.server).toMatchObject({ name: 'a', command: 'node', args: ['a.js'] })
    expect(nested.others).toEqual(['b'])
    const vscode = parseMcpSnippet('{"w1":{"servers":{"a":{"url":"https://x/mcp"},"b":{"command":"node b.js"}}}}')
    expect(vscode.ok).toBe(true)
    if (!vscode.ok) return
    expect(vscode.server).toMatchObject({ name: 'a', transport: 'streamable-http' })
    expect(vscode.others).toEqual(['b'])
  })

  it('merges every server map it finds, de-duplicates names and reports the rest', () => {
    const outcome = parseMcpSnippet('{"mcpServers":{"s1":{"command":"node s1"}},"mcp":{"m1":{"command":"node m1"}}}')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toMatchObject({ name: 's1', command: 'node', args: ['s1'] })
    expect(outcome.others).toEqual(['m1'])
    const deduped = parseMcpSnippet(
      '{"mcpServers":{"a":{"command":"node a"}},"mcp":{"a":{"command":"node a2"},"b":{"command":"node b"}}}',
    )
    expect(deduped.ok).toBe(true)
    if (deduped.ok) {
      expect(deduped.server).toMatchObject({ name: 'a', command: 'node', args: ['a'] })
      expect(deduped.others).toEqual(['b'])
    }
  })

  it('reads env as a {name,value} list and serializes structural values', () => {
    const list = parseMcpSnippet('{"mcp":{"a":{"command":"node","env":[{"name":"K","value":"v"},{"key":"K2","value":7}]}}}')
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(list.server.env).toEqual([
        { key: 'K', ref: '', value: 'v' },
        { key: 'K2', ref: '', value: '7' },
      ])
    }
    const nested = parseMcpSnippet('{"mcp":{"a":{"command":"node","env":{"K":{"mode":"x"},"N":null}}}}')
    expect(nested.ok).toBe(true)
    if (nested.ok) {
      expect(nested.server.env).toEqual([
        { key: 'K', ref: '', value: '{"mode":"x"}' },
        { key: 'N', ref: '', value: '' },
      ])
    }
  })

  it('splits a string args field and reads numeric timeouts and flags', () => {
    const outcome = parseMcpSnippet('{"mcp":{"a":{"command":"npx","args":"-y @a/mcp","timeout":"3000","enabled":0}}}')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const timeout = (outcome.server as { toolCallTimeoutMs?: string }).toolCallTimeoutMs
    expect(timeout).toBe('3000')
    expect(outcome.server).toMatchObject({ command: 'npx', args: ['-y', '@a/mcp'], enabled: false })
    const disabled = parseMcpSnippet('{"mcp":{"a":{"command":"node","disabled":1}}}')
    expect(disabled.ok).toBe(true)
    if (disabled.ok) expect(disabled.server.enabled).toBe(false)
    const unparsable = parseMcpSnippet('{"mcp":{"a":{"command":"node","timeoutMs":"abc"}}}')
    expect(unparsable.ok).toBe(true)
    if (unparsable.ok) expect(unparsable.server.toolCallTimeoutMs).toBeUndefined()
  })

  it('skips null-ish command tokens instead of discarding the whole list', () => {
    const outcome = parseMcpSnippet('{"mcp":{"a":{"command":["node",null,"a.js"]}}}')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.server).toMatchObject({ command: 'node', args: ['a.js'] })
  })

  it('never overflows the stack on deeply nested JSON', () => {
    const deepObject = '{"a":'.repeat(6000) + '{"command":"node"}' + '}'.repeat(6000)
    const deepArray = '['.repeat(6000) + '{"command":"node"}' + ']'.repeat(6000)
    for (const text of [deepObject, deepArray]) {
      const outcome = parseMcpSnippet(text)
      expect(typeof outcome.ok).toBe('boolean')
    }
  })
})

describe('parseMcpSnippetCandidates', () => {
  it('lists every named server of a multi-server config', () => {
    const outcome = parseMcpSnippetCandidates(
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'node', args: ['a.js'] },
          beta: { url: 'https://example.test/mcp', headers: { Authorization: 'tok' } },
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.candidates.map((candidate) => candidate.name)).toEqual(['alpha', 'beta'])
    expect(outcome.candidates[0]!.server.transport).toBe('stdio')
    expect(outcome.candidates[1]!.server.transport).toBe('streamable-http')
    expect(outcome.candidates[1]!.server.headers).toEqual([
      { name: 'Authorization', ref: 'AUTHORIZATION', value: 'tok' },
    ])
  })

  it('reads the plugin copy-JSON envKeys list as reference-only env rows', () => {
    const outcome = parseMcpSnippetCandidates(
      JSON.stringify({ mcpServers: { alpha: { command: 'node', envKeys: ['TOKEN', 'REGION'] } } }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.candidates[0]!.server.env).toEqual([
      { key: 'TOKEN', ref: 'TOKEN', value: '' },
      { key: 'REGION', ref: 'REGION', value: '' },
    ])
  })

  it('falls back to a single unnamed server object', () => {
    const outcome = parseMcpSnippetCandidates('{"command":"node","args":["server.js"]}')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.candidates).toHaveLength(1)
    expect(outcome.candidates[0]!.server.command).toBe('node')
  })

  it('reports empty, invalid and unsupported snippets without throwing', () => {
    expect(parseMcpSnippetCandidates('')).toEqual({ ok: false, reason: 'empty' })
    expect(parseMcpSnippetCandidates('not json at all')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseMcpSnippetCandidates('{"hello":"world"}')).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('official manager config map (alpha.2 Config shape)', () => {
  it('reads servers{name:{transport,enabled,knobs,toolLoading,oauth}}', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      servers: {
        docs: {
          transport: 'streamable-http',
          url: 'https://mcp.example.test/x',
          enabled: true,
          toolCallTimeoutMs: 120_000,
          startupTimeoutMs: 45_000,
          closeTimeoutMs: 7_000,
          reconnect: { enabled: false, initialDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 3 },
          toolLoading: 'on-demand',
          oauth: {
            credentialKey: 'mcp-client/docs',
            clientId: 'client-1',
            scope: 'read write',
            requestTimeoutMs: 15_000,
            authorizationTimeoutMs: 600_000,
          },
        },
      },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toMatchObject({
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/x',
      enabled: true,
      startupTimeoutMs: '45000',
      closeTimeoutMs: '7000',
      toolCallTimeoutMs: '120000',
      reconnect: { enabled: false, initialDelayMs: '1000', maxDelayMs: '60000', maxAttempts: '3' },
      toolLoading: 'on-demand',
      oauth: { clientId: 'client-1', scope: 'read write' },
    })
    // The grant address (credentialKey) and the authorization budgets do not
    // transfer: the record key is host-derived from the server name.
    expect(outcome.server.warnings).toEqual([
      { code: 'dropped-field', field: 'oauth.credentialKey' },
      { code: 'dropped-field', field: 'oauth.requestTimeoutMs' },
      { code: 'dropped-field', field: 'oauth.authorizationTimeoutMs' },
    ])
  })

  it('maps the timeout names and their legacy aliases', () => {
    const official = parseMcpSnippet(JSON.stringify({
      servers: { a: { transport: 'stdio', command: 'node', toolCallTimeoutMs: 5000 } },
    }))
    expect(official.ok && official.server.toolCallTimeoutMs).toBe('5000')
    const legacyMs = parseMcpSnippet(JSON.stringify({ mcpServers: { a: { command: 'node', timeoutMs: 3000 } } }))
    expect(legacyMs.ok && legacyMs.server.toolCallTimeoutMs).toBe('3000')
    const legacySeconds = parseMcpSnippet(JSON.stringify({ mcpServers: { a: { command: 'node', timeout: '7000' } } }))
    expect(legacySeconds.ok && legacySeconds.server.toolCallTimeoutMs).toBe('7000')
    // The new upstream name wins over both aliases.
    const precedence = parseMcpSnippet(
      JSON.stringify({ mcpServers: { a: { command: 'node', toolCallTimeoutMs: 9000, timeoutMs: 3000, timeout: 1000 } } }),
    )
    expect(precedence.ok && precedence.server.toolCallTimeoutMs).toBe('9000')
  })

  it('reads exact template tokens as ref rows and rejects mixed expressions with a warning', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      servers: {
        a: {
          transport: 'stdio',
          command: 'node',
          env: {
            REF_ONLY: '${credential:ENV_TOKEN}',
            LITERAL: 'plain-value',
            MIXED: 'Bearer ${credential:OTHER}',
          },
        },
      },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server.env).toEqual([
      { key: 'REF_ONLY', ref: 'ENV_TOKEN', value: '' },
      { key: 'LITERAL', ref: '', value: 'plain-value' },
    ])
    expect(outcome.server.warnings).toEqual([{ code: 'mixed-template', field: 'env[MIXED]' }])
    // Document values are only ever credential TEMPLATES: the literal is
    // staged as a write-only draft value, never stored in the document.
    for (const row of outcome.server.env) {
      expect(row.value === '' || row.ref === '').toBe(true)
    }
  })

  it('reads header template tokens as ref rows and mixed headers as warnings', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      servers: {
        h: {
          transport: 'streamable-http',
          url: 'https://mcp.example.test/x',
          headers: {
            Authorization: '${credential:AUTH}',
            'X-Api-Key': 'literal-key',
            'X-Broken': 'prefix-${credential:X}',
          },
        },
      },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server.headers).toEqual([
      { name: 'Authorization', ref: 'AUTH', value: '' },
      { name: 'X-Api-Key', ref: 'X_API_KEY', value: 'literal-key' },
    ])
    expect(outcome.server.warnings).toEqual([{ code: 'mixed-template', field: 'headers[X-Broken]' }])
  })

  it('prefers the explicit transport over type heuristics and drops cross-transport fields', () => {
    const stdio = parseMcpSnippet(JSON.stringify({
      servers: { a: { transport: 'stdio', type: 'remote', command: 'node', url: 'https://mcp.example.test/x' } },
    }))
    expect(stdio.ok).toBe(true)
    if (!stdio.ok) return
    expect(stdio.server.transport).toBe('stdio')
    expect(stdio.server.warnings).toContainEqual({ code: 'dropped-field', field: 'url' })
    const http = parseMcpSnippet(JSON.stringify({
      servers: { b: { transport: 'streamable-http', url: 'https://mcp.example.test/x', command: 'node' } },
    }))
    expect(http.ok).toBe(true)
    if (!http.ok) return
    expect(http.server.transport).toBe('streamable-http')
    expect(http.server.warnings).toContainEqual({ code: 'dropped-field', field: 'command' })
  })

  it('strips unsupported fields with a warning instead of silently dropping them', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      servers: {
        a: {
          transport: 'stdio',
          command: 'node',
          maxInstructionBytes: 1024,
          catalogDescriptionMaxLength: 80,
          failOnStartupError: true,
          expandTemplates: true,
        },
      },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server.warnings.map((warning) => warning.field).sort()).toEqual([
      'catalogDescriptionMaxLength',
      'expandTemplates',
      'failOnStartupError',
      'maxInstructionBytes',
    ])
  })

  it('warns on unsupported values instead of coercing them', () => {
    const outcome = parseMcpSnippet(JSON.stringify({
      servers: {
        a: {
          transport: 'stdio',
          command: 'node',
          toolCallTimeoutMs: 'soon',
          toolLoading: 'sometimes',
          reconnect: { enabled: true, maxAttempts: 1.5 },
        },
      },
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server.toolCallTimeoutMs).toBeUndefined()
    expect(outcome.server.toolLoading).toBeUndefined()
    expect(outcome.server.reconnect).toBeUndefined()
    const fields = outcome.server.warnings.filter((warning) => warning.code === 'invalid-value').map((warning) => warning.field)
    expect(fields).toEqual(['toolCallTimeoutMs', 'reconnect.maxAttempts', 'toolLoading'])
  })

  it('maps the official enabled flag to the global-allowed flag only (default OFF stays OFF)', () => {
    // Import never writes a workspace enable row: our default is OFF, so the
    // server is allowed but enabled in NO workspace until the user turns it on.
    const enabled = parseMcpSnippet(JSON.stringify({ servers: { a: { transport: 'stdio', command: 'node', enabled: true } } }))
    expect(enabled.ok && enabled.server.enabled).toBe(true)
    const disabled = parseMcpSnippet(JSON.stringify({ servers: { a: { transport: 'stdio', command: 'node', enabled: false } } }))
    expect(disabled.ok && disabled.server.enabled).toBe(false)
  })

  it('re-imports this plugin own Copy JSON round trip (serverName, templates, knobs, oauth)', () => {
    const copy = {
      mcpServers: {
        remote: {
          serverName: 'remote',
          transport: 'streamable-http',
          url: 'https://mcp.example.test/x',
          toolCallTimeoutMs: 45_000,
          startupTimeoutMs: 20_000,
          toolLoading: 'on-demand',
          headers: { Authorization: '${credential:AUTH}' },
          oauth: { clientId: 'client-1', scope: 'read' },
        },
      },
    }
    const outcome = parseMcpSnippet(JSON.stringify(copy))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.server).toMatchObject({
      name: 'remote',
      toolCallTimeoutMs: '45000',
      startupTimeoutMs: '20000',
      toolLoading: 'on-demand',
      headers: [{ name: 'Authorization', ref: 'AUTH', value: '' }],
      oauth: { clientId: 'client-1', scope: 'read' },
    })
  })
})

describe('cross-transport stray fields', () => {
  it('warns when oauth/envKeys cannot belong to the chosen transport', () => {
    const stdio = parseMcpSnippet(
      JSON.stringify({ servers: { a: { transport: 'stdio', command: 'node', oauth: { clientId: 'c' } } } }),
    )
    expect(stdio.ok).toBe(true)
    if (!stdio.ok) return
    expect(stdio.server.oauth).toBeUndefined()
    expect(stdio.server.warnings).toContainEqual({ code: 'dropped-field', field: 'oauth' })
    const http = parseMcpSnippet(
      JSON.stringify({ servers: { h: { transport: 'streamable-http', url: 'https://x.test/mcp', envKeys: ['TOKEN'] } } }),
    )
    expect(http.ok).toBe(true)
    if (!http.ok) return
    expect(http.server.env).toEqual([])
    expect(http.server.warnings).toContainEqual({ code: 'dropped-field', field: 'envKeys' })
  })
})
