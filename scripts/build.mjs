// dsh-mcp-scope build: host half (tsc ESM) + declarations + client half (esbuild CJS
// wrapped in the official window.__ModuleLoader__.load({ id, factory }) shape).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })

// 1. typecheck
run('node', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'])

// 2. declarations for both entries
rmSync(join(root, 'lib', 'types'), { recursive: true, force: true })
mkdirSync(join(root, 'lib', 'types'), { recursive: true })
run('node', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.types.json'])

// 3. host half: ESM JS for the node side (src/index.ts + shared)
run('node', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.host.json'])

// 4. client half: esbuild CJS bundle wrapped for the browser module loader.
// Externals = the official frozen platform table (see dsh packages/client/web/src/platform.ts).
const externals = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [join(root, 'src', 'client', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: externals,
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  write: false,
  outfile: join(root, 'lib', 'client.js'),
})

const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${code}\n\t\treturn module.exports;\n\t}\n});\n`
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), wrapped)
console.log('build ok: lib/index.js lib/client.js lib/types')
