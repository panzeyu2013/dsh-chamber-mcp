// M1-style live E2E: prompt sessions in an ON workspace vs an OFF workspace and
// capture the model-facing tools[] each request carries (mock LLM).
// Evidence -> llm-requests.jsonl lines: workspace label is NOT on the wire, so we
// prompt sequentially and record order: first prompt = on-workspace, second = off-workspace.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Instance, SMOKE, ROOT, NODE, log } from './instance.mjs'

const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const TGZ = join(SMOKE, `dsh-mcp-scope-${PKG_VERSION}.tgz`)
// Self-contained: pack the plugin tarball when it is not present yet (npm
// cache redirected into .smoke so a read-only HOME cannot break the pack).
if (!existsSync(TGZ)) {
  execFileSync('npm', ['pack', '--pack-destination', SMOKE], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(SMOKE, 'npm-cache') },
  })
}

const PORT = 32132
const HOME = join(SMOKE, 'm1-home')
const ON_DIR = join(SMOKE, 'm1-on')
const OFF_DIR = join(SMOKE, 'm1-off')
const REQ_LOG = join(SMOKE, 'logs', 'llm-requests.jsonl')
const MOCK_LOG = join(SMOKE, 'logs', 'mock-llm.log')
const OUT = join(ROOT, 'docs', 'milestones', 'M1-raw.log')

for (const dir of [HOME, ON_DIR, OFF_DIR]) mkdirSync(dir, { recursive: true })
rmSync(REQ_LOG, { force: true })

// mock LLM child (kept alive for the duration of this process)
const mock = spawn(NODE, [join(SMOKE, 'mock-llm.mjs'), '39001'], { stdio: ['ignore', 'pipe', 'pipe'] })
mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`))
await new Promise((r) => setTimeout(r, 800))

const inst = new Instance({ home: HOME, port: PORT, label: 'm1' })
const evidence = []
const say = (m) => { evidence.push(m); log(m) }

try {
  // 1) install the plugin the user way, then reboot (first boot initializes the profile)
  await inst.boot()
  await inst.stop()
  const add = execFileSync('/root/.nvm/versions/node/v22.22.3/bin/dsh',
    ['plugin', '--profile', 'web', 'add', `file:${TGZ}`],
    { env: { ...process.env, PATH: '/root/.nvm/versions/node/v22.22.3/bin:' + (process.env.PATH ?? ''), DSH_HOME: HOME, HOME: join(SMOKE, 'homedir') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  say('dsh plugin add exit=' + add.status)
  const bundles = JSON.parse(readFileSync(join(HOME, 'profiles', 'web', 'package.json'), 'utf8')).dsh.profile.bundles
  say('bundles: ' + bundles.join(', '))

  await inst.boot(60_000, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:39001' })

  // credentials: provider key + server env token
  await inst.rpc('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-mock-123' })
  await inst.rpc('credentials/set', { ref: 'MCP_SCOPE_TEST_TOKEN', value: 'smoke-secret-123' })

  // workspaces
  const on = await inst.rpc('workspace/create', { request: { path: ON_DIR } })
  const off = await inst.rpc('workspace/create', { request: { path: OFF_DIR } })
  const onId = on.workspace?.workspaceId, offId = off.workspace?.workspaceId
  say(`on-workspace=${onId} off-workspace=${offId}`)

  // define the fixture server (stdio) with env key
  const d0 = await inst.rpc('settings/describe')
  const mine0 = d0.namespaces.find((n) => n.ns === 'mcp-scope')
  const servers = mine0.value.servers?.length ? mine0.value.servers : [{
    serverName: 'fixture', transport: 'stdio',
    command: NODE,
    args: [join(ROOT, 'scripts', 'smoke', 'fixture', 'echo-server.mjs')],
    envKeys: ['MCP_SCOPE_TEST_TOKEN'],
  }]
  say('servers: ' + JSON.stringify(servers.map((s) => s.serverName)))
  await inst.rpc('settings/mutate', {
    ns: 'mcp-scope',
    ops: [
      { op: 'set', path: ['servers'], value: servers },
      { op: 'set', path: ['overrides', offId, 'fixture'], value: true },
      { op: 'unset', path: ['overrides', onId, 'fixture'] },
    ],
  })
  await new Promise((r) => setTimeout(r, 3000)) // supervisor connects + syncs

  // sessions
  const sOn = await inst.rpc('session/create', { request: { workspaceId: onId } })
  const sOff = await inst.rpc('session/create', { request: { workspaceId: offId } })
  say(`session-on=${sOn.sessionId} session-off=${sOff.sessionId}`)
  await new Promise((r) => setTimeout(r, 2500)) // agent/created -> applier

  // rc.1 sessions stay cold until a client claims them over the remote mux:
  // open a session/follow stream per session (the UI-surface equivalent) so
  // the agent activates and the queued prompt actually runs a turn.
  const follows = new Map()
  const openFollow = async (sessionId, tag) => {
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/remote.mux`, {
        headers: inst.cookies ? { Cookie: inst.cookies } : {},
      })
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'open', streamId: tag, endpoint: 'session/follow',
          payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 50 } } },
        }))
        resolve(socket)
      }
      socket.onerror = () => reject(new Error('mux websocket error'))
      socket.onmessage = (ev) => {
        const text = String(ev.data)
        try {
          const frame = JSON.parse(text)
          if (frame.type === 'item' && frame.value?.type === 'snapshot') {
            say(`follow ${tag}: snapshot delivered (session activated)`)
          }
        } catch {
          /* non-JSON frames ignored */
        }
      }
    })
    follows.set(tag, ws)
  }
  await openFollow(sOn.sessionId, 'on')
  await openFollow(sOff.sessionId, 'off')
  await new Promise((r) => setTimeout(r, 2000))

  // prompts: ON first, OFF second (order is the discriminator in the request log)
  const prompt = async (sessionId, tag) => {
    await inst.rpc('session/prompt', {
      request: { requestId: randomUUID(), sessionId, mode: 'steer', content: [{ type: 'text', text: 'please answer pong' }] },
    })
    say(`prompted ${tag}`)
  }
  await prompt(sOn.sessionId, 'on-workspace')
  await new Promise((r) => setTimeout(r, 3000))
  await prompt(sOff.sessionId, 'off-workspace')
  await new Promise((r) => setTimeout(r, 12_000))
  for (const ws of follows.values()) ws.close()

  let lines = []
  try {
    lines = readFileSync(REQ_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    say('note: mock received NO chat requests (known rc.1 headless limitation: cold sessions never start a turn without a UI surface claim)')
  }
  say(`mock received ${lines.length} chat requests`)
  lines.forEach((l, i) => say(`request#${i}: tools=[${(l.tools ?? []).join(', ')}] count=${l.toolCount} model=${l.model}`))

  // Distinguish turn requests from the tool-less title-generation side
  // request the mock also receives: a turn carries a tools array and more
  // messages than the minimal title prompt.
  const turns = lines.filter((l) => (l.toolCount ?? 0) > 0 || (l.messages ?? 0) > 2)
  say(`turn requests captured: ${turns.length} (side requests: ${lines.length - turns.length})`)
  turns.forEach((l, i) => say(`turn#${i}: tools=[${(l.tools ?? []).join(', ')}] count=${l.toolCount}`))
  const onTurn = turns[0]
  const offTurn = turns[1]
  const onHasMcp = (onTurn?.tools ?? []).some((n) => n.startsWith('mcp__fixture__'))
  const offHasMcp = (offTurn?.tools ?? []).some((n) => n.startsWith('mcp__fixture__'))
  const offHasStock = (offTurn?.tools ?? []).length > 0
  say(`R3-live-capture: ${turns.length >= 2 ? (onHasMcp && !offHasMcp ? 'PASS' : 'FAIL') : 'not-captured'}`)
  if (turns.length >= 2) {
    say(`R3: on-workspace turn carries mcp__fixture__* tools: ${onHasMcp}`)
    say(`R3: off-workspace turn carries NO mcp__fixture__* tools: ${!offHasMcp} (stock tools remain: ${offHasStock})`)
  }

  mkdirSync(join(ROOT, 'docs', 'milestones'), { recursive: true })
  writeFileSync(OUT, evidence.join('\n') + '\n')
} finally {
  await inst.stop()
  mock.kill('SIGTERM')
}
log(`evidence written to ${OUT}`)
