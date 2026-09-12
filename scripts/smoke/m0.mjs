// M0 smoke for dsh-chamber-mcp against a scratch anchor (0.1.2-rc.1) instance.
// Phases: setup (workspaces/creds/baseline), install (dsh plugin add tgz + restart),
// plugin (namespace R/W + revision conflict), gate (server add → spawn → sessions in
// two workspaces with ws-b off → apply/revoke log evidence).
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { Instance, SMOKE, ROOT, NODE, log } from './instance.mjs'

const PORT = 32131
const HOME = join(SMOKE, 'm0-home')
const PKG_META = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG_META.name
const PKG_VERSION = PKG_META.version
const TGZ = join(SMOKE, `${PKG_NAME}-${PKG_VERSION}.tgz`)
// Self-contained: pack the plugin tarball when it is not present yet (npm
// cache redirected into .smoke so a read-only HOME cannot break the pack).
if (!existsSync(TGZ)) {
  execFileSync('npm', ['pack', '--pack-destination', SMOKE], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(SMOKE, 'npm-cache') },
  })
}

const FIXTURE = join(ROOT, 'scripts', 'smoke', 'fixture', 'echo-server.mjs')
const WS_A = join(SMOKE, 'm0-ws-a')
const WS_B = join(SMOKE, 'm0-ws-b')
const OUT = join(ROOT, 'docs', 'milestones', 'M0-raw.log')

const inst = new Instance({ home: HOME, port: PORT, label: 'm0' })
const evidence = []
const say = (m) => { evidence.push(m); log(m) }
const step = (m) => say(`\n=== ${m}`)

for (const dir of [HOME, WS_A, WS_B]) mkdirSync(dir, { recursive: true })

// ── phase: setup ────────────────────────────────────────────────────────────
step('boot scratch instance')
await inst.boot()
inst.cookies && say(`cookie minted (${inst.cookies.length > 0 ? 'yes' : 'no'})`)

step('workspace.create ws-a/ws-b')
const a = await inst.rpc('workspace/create', { request: { path: WS_A } })
const b = await inst.rpc('workspace/create', { request: { path: WS_B } })
const WA = a.workspace?.workspaceId ?? a.workspaceId, WB = b.workspace?.workspaceId ?? b.workspaceId
say(`ws-a ${JSON.stringify(WA)} created=${a.created}`)
say(`ws-b ${JSON.stringify(WB)} created=${b.created}`)

step('baseline: plugin-inventory before install')
const inv0 = await inst.rpc('pluginInventory/list', {})
const hasMine0 = inv0.entries.some((e) => e.moduleName === PKG_NAME)
say(`${PKG_NAME} row present before install: ${hasMine0}`)

step('baseline: settings describe (ns count)')
const s0 = await inst.rpc('settings/describe')
say(`namespaces: ${s0.namespaces.map((n) => n.ns).join(', ')}`)
say(`mcp-scope present before install: ${s0.namespaces.some((n) => n.ns === 'mcp-scope')}`)

step('stop for install')
await inst.stop()

// ── phase: install (user-install command, real) ──────────────────────────────
step('dsh plugin --profile web add file:<tgz>')
const env = {
  ...process.env,
  PATH: '/root/.nvm/versions/node/v22.22.3/bin:' + (process.env.PATH ?? ''),
  DSH_HOME: HOME,
  HOME: join(SMOKE, 'homedir'),
  DSH_TELEMETRY_DISABLED: '1',
}
const add = spawnSync('/root/.nvm/versions/node/v22.22.3/bin/dsh',
  ['plugin', '--profile', 'web', 'add', `file:${TGZ}`], { env, encoding: 'utf8', timeout: 180_000 })
say(`exit=${add.status}`)
say((add.stdout + add.stderr).split('\n').slice(-8).join('\n'))
const pkgJson = JSON.parse(readFileSync(join(HOME, 'profiles', 'web', 'package.json'), 'utf8'))
say(`bundles after add: ${pkgJson.dsh.profile.bundles.join(', ')}`)
say(`bundles includes ${PKG_NAME}: ${pkgJson.dsh.profile.bundles.includes(PKG_NAME)}`)

step('reboot after install')
await inst.boot()

step('plugin-inventory after install')
const inv1 = await inst.rpc('pluginInventory/list', {})
const row = inv1.entries.find((e) => e.moduleName === PKG_NAME)
say(`row: ${JSON.stringify(row)}`)

step('settings describe: mcp-scope namespace')
const s1 = await inst.rpc('settings/describe')
const ns = s1.namespaces.find((n) => n.ns === 'mcp-scope')
say(`mcp-scope ns: revision=${ns?.revision} value=${JSON.stringify(ns?.value)}`)
say(`schema kind: ${JSON.stringify(ns?.schema)?.slice(0, 140)}...`)

// ── phase: credentials + server add ─────────────────────────────────────────
step('credentials.set MCP_SCOPE_TEST_TOKEN')
await inst.rpc('credentials/set', { ref: 'MCP_SCOPE_TEST_TOKEN', value: 'smoke-secret-123' })
const cred = await inst.rpc('credentials/describe', { refs: ['MCP_SCOPE_TEST_TOKEN'] })
say(`describe: ${JSON.stringify(cred)}`)
const leak = JSON.stringify(cred)
say(`value never rides the wire: ${!leak.includes('smoke-secret-123')}`)

step('settings.mutate: add stdio server (fixture)')
const serverDef = {
  serverName: 'fixture',
  transport: 'stdio',
  command: NODE,
  args: [FIXTURE],
  envKeys: ['MCP_SCOPE_TEST_TOKEN'],
}
await inst.rpc('settings/mutate', {
  ns: 'mcp-scope', ops: [{ op: 'set', path: ['servers'], value: [serverDef] }],
  expectedRevision: ns.revision,
})
const s2 = await inst.rpc('settings/describe')
const ns2 = s2.namespaces.find((n) => n.ns === 'mcp-scope')
say(`after mutate: revision=${ns2.revision} servers=${JSON.stringify(ns2.value.servers)}`)

step('stale-revision write refused')
let conflict = null
try {
  await inst.rpc('settings/mutate', { ns: 'mcp-scope', ops: [{ op: 'set', path: ['servers'], value: [] }], expectedRevision: ns.revision })
} catch (e) { conflict = String(e) }
say(`settings-conflict observed: ${conflict?.includes('conflict')}`)

step('wait for supervisor connect + sync (boot-log evidence)')
await new Promise((r) => setTimeout(r, 4000))

// ── phase: workspace gate ────────────────────────────────────────────────────
step('override ws-b OFF for server fixture')
await inst.rpc('settings/mutate', {
  ns: 'mcp-scope', ops: [{ op: 'set', path: ['overrides', WB, 'fixture'], value: true }],
})
say('done')

step('create session in ws-a (expected: tools applied)')
const sa = await inst.rpc('session/create', { request: { workspaceId: WA } })
say(`session-a ${sa.sessionId}`)

step('create session in ws-b (expected: no tools)')
const sb = await inst.rpc('session/create', { request: { workspaceId: WB } })
say(`session-b ${sb.sessionId}`)

step('flip ws-b ON (expected: apply push to live session-b agent)')
await inst.rpc('settings/mutate', { ns: 'mcp-scope', ops: [{ op: 'unset', path: ['overrides', WB, 'fixture'] }] })

step('flip ws-b OFF again (expected: revoke)')
await inst.rpc('settings/mutate', { ns: 'mcp-scope', ops: [{ op: 'set', path: ['overrides', WB, 'fixture'], value: true }] })
await new Promise((r) => setTimeout(r, 3000))

step('sessions/wait evidence; stop instance')
await inst.stop()
mkdirSync(join(ROOT, 'docs', 'milestones'), { recursive: true })
writeFileSync(OUT, evidence.join('\n') + '\n')
log(`evidence written to ${OUT}`)
