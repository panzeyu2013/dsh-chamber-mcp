// M0 smoke for dsh-chamber-mcp against a scratch instance booted from the
// gateway's current anchor CLI (measured dsh 0.1.5-rc.2 on 2026-09-14; the run
// transcript records the version it actually used).
// Phases: setup (workspaces/creds/baseline), install (dsh plugin add tgz + restart),
// plugin (namespace R/W + revision conflict), gate (server add → spawn → sessions in
// two workspaces with ws-b off → apply/revoke log evidence).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Instance, SMOKE, ROOT, NODE, ANCHOR_CLI, cliVersion, log, packPluginTgz } from './instance.mjs'

const PORT = Number(process.env.DSH_SMOKE_PORT_M0 ?? 32131)
const HOME = join(SMOKE, 'm0-home')
const PKG_META = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG_META.name
const PKG_VERSION = PKG_META.version
// Freshly packed from the working tree on every run (see packPluginTgz).
const TGZ = packPluginTgz()

const FIXTURE = join(ROOT, 'scripts', 'smoke', 'fixture', 'echo-server.mjs')
const WS_A = join(SMOKE, 'm0-ws-a')
const WS_B = join(SMOKE, 'm0-ws-b')
const OUT = join(SMOKE, 'logs', 'M0-raw.log')

const inst = new Instance({ home: HOME, port: PORT, label: 'm0' })
const evidence = []
const say = (m) => { evidence.push(m); log(m) }
const step = (m) => say(`\n=== ${m}`)

// A scratch instance must actually be scratch: a $DSH_HOME left by an earlier
// run still has the plugin installed (often from a since-deleted tarball), so
// the install phase fails on the stale profile dependency while the rest of the
// run carries on against the OLD package — evidence that looks green and proves
// nothing. Wipe the home and the workspace dirs before booting.
for (const dir of [HOME, WS_A, WS_B]) rmSync(dir, { recursive: true, force: true })
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
// The ANCHOR CLI drives the install too, so install and boot are one
// generation (the chamber's) instead of a mixed pair.
say(`anchor CLI: ${ANCHOR_CLI} (dsh@${cliVersion(ANCHOR_CLI)})`)
say(`tarball: ${TGZ}`)
const add = spawnSync(NODE, [ANCHOR_CLI, 'plugin', '--profile', 'web', 'add', `file:${TGZ}`], {
  env: installerEnv(), encoding: 'utf8', timeout: 180_000,
})
say(`exit=${add.status}`)
say((add.stdout + add.stderr).split('\n').slice(-8).join('\n'))
// A failed install must fail the RUN: the phases after it would otherwise
// exercise whatever the profile already carried.
if (add.status !== 0) throw new Error(`dsh plugin --profile web add failed (status ${add.status})`)
const pkgJson = JSON.parse(readFileSync(join(HOME, 'profiles', 'web', 'package.json'), 'utf8'))
say(`bundles after add: ${pkgJson.dsh.profile.bundles.join(', ')}`)
if (!pkgJson.dsh.profile.bundles.includes(PKG_NAME)) {
  throw new Error(`profile bundles do not include ${PKG_NAME} after add: ${pkgJson.dsh.profile.bundles.join(', ')}`)
}
// The INSTALLED artifact must be the one this run packed from the working tree.
const installed = JSON.parse(readFileSync(join(HOME, 'profiles', 'web', 'node_modules', PKG_NAME, 'package.json'), 'utf8'))
if (installed.version !== PKG_VERSION) {
  throw new Error(`installed ${PKG_NAME}@${installed.version} != working tree ${PKG_VERSION}`)
}
say(`installed: ${PKG_NAME}@${installed.version} from ${TGZ.split('/').pop()}`)

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
mkdirSync(join(SMOKE, 'logs'), { recursive: true })
writeFileSync(OUT, evidence.join('\n') + '\n')
log(`evidence written to ${OUT}`)
