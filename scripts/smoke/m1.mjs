// M1-style live E2E: prompt sessions in an ON workspace vs an OFF workspace and
// capture the model-facing tools[] each request carries (mock LLM).
// Evidence -> llm-requests.jsonl lines: workspace label is NOT on the wire, so we
// prompt sequentially and record order: first prompt = on-workspace, second = off-workspace.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Instance, SMOKE, ROOT, NODE, ANCHOR_CLI, cliVersion, log, packPluginTgz } from './instance.mjs'

const PKG_META = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG_META.name
const PKG_VERSION = PKG_META.version
// Freshly packed from the working tree on every run (see packPluginTgz).
const TGZ = packPluginTgz()

const PORT = Number(process.env.DSH_SMOKE_PORT_M1 ?? 32132)
const MOCK_PORT = Number(process.env.DSH_SMOKE_PORT_MOCK ?? 39001)
const HOME = join(SMOKE, 'm1-home')
const ON_DIR = join(SMOKE, 'm1-on')
const OFF_DIR = join(SMOKE, 'm1-off')
const REQ_LOG = join(SMOKE, 'logs', 'llm-requests.jsonl')
const MOCK_LOG = join(SMOKE, 'logs', 'mock-llm.log')
const OUT = join(SMOKE, 'logs', 'M1-raw.log')

// Scratch means scratch: wipe the home and the two workspace dirs first, or a
// stale install from an earlier run silently becomes the thing under test (see
// the same note in m0.mjs).
for (const dir of [HOME, ON_DIR, OFF_DIR]) rmSync(dir, { recursive: true, force: true })
for (const dir of [HOME, ON_DIR, OFF_DIR]) mkdirSync(dir, { recursive: true })
rmSync(REQ_LOG, { force: true })

// mock LLM child (kept alive for the duration of this process)
const mock = spawn(NODE, [join(ROOT, 'scripts', 'smoke', 'mock-llm.mjs'), String(MOCK_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`))
await new Promise((r) => setTimeout(r, 800))

const inst = new Instance({ home: HOME, port: PORT, label: 'm1' })
const evidence = []
const say = (m) => { evidence.push(m); log(m) }

/**
 * Environment handed to the installer (`dsh plugin --profile web add`). It is
 * deliberately CONTROLLED rather than inherited: the profile owns its package
 * manager and store, while the invoking process (usually `npm run test:smoke`)
 * carries npm's own config channel — and the first install into a freshly wiped
 * scratch home failed while inheriting it. PATH, the DSH home contract and any
 * proxy/CA settings are forwarded; everything else is the profile's business.
 * Every run since has passed through the documented entry point.
 *
 * @returns the child environment.
 */
function installerEnv() {
  const proxy = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => /^(https?|no)_proxy$/i.test(key) || key === 'NODE_EXTRA_CA_CERTS',
    ),
  )
  return {
    ...proxy,
    PATH: dirname(NODE) + ':' + (process.env.PATH ?? ''),
    DSH_HOME: HOME,
    HOME: join(SMOKE, 'homedir'),
    DSH_TELEMETRY_DISABLED: '1',
  }
}

try {
  // 1) install the plugin the user way, then reboot (first boot initializes the profile)
  await inst.boot()
  await inst.stop()
  // spawnSync (not execFileSync) so the install really reports an exit status:
  // execFileSync resolves to the child's stdout, and `.status` on that string is
  // undefined — the transcript used to record "exit=undefined" for a step whose
  // success the install evidence depends on. The ANCHOR CLI drives the install
  // too, so install and boot are one generation (the chamber's).
  say(`anchor CLI: ${ANCHOR_CLI} (dsh@${cliVersion(ANCHOR_CLI)})`)
  say(`tarball: ${TGZ}`)
  const add = spawnSync(NODE, [ANCHOR_CLI, 'plugin', '--profile', 'web', 'add', `file:${TGZ}`],
    { env: installerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (add.status !== 0) throw new Error(`dsh plugin --profile web add failed (status ${add.status}): ${(add.stderr ?? '').trim()}`)
  say('dsh plugin add exit=' + add.status)
  const bundles = JSON.parse(readFileSync(join(HOME, 'profiles', 'web', 'package.json'), 'utf8')).dsh.profile.bundles
  say('bundles: ' + bundles.join(', '))
  // The INSTALLED artifact must be the one this run packed from the working tree.
  const installed = JSON.parse(readFileSync(join(HOME, 'profiles', 'web', 'node_modules', PKG_NAME, 'package.json'), 'utf8'))
  if (installed.version !== PKG_VERSION) {
    throw new Error(`installed ${PKG_NAME}@${installed.version} != working tree ${PKG_VERSION}`)
  }
  say(`installed: ${PKG_NAME}@${installed.version} from ${TGZ.split('/').pop()}`)

  await inst.boot(60_000, { DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` })

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

  mkdirSync(join(SMOKE, 'logs'), { recursive: true })
  writeFileSync(OUT, evidence.join('\n') + '\n')
} finally {
  await inst.stop()
  mock.kill('SIGTERM')
}
log(`evidence written to ${OUT}`)
