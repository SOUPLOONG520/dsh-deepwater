// verify-deepwater.mjs - offline proof for the unified package itself.
//
// The two layer suites (verify-polish.mjs, verify-ambient.mjs) prove that the
// stylesheet and the ambience layer are still what they were. This one proves
// the thing that is new: that the two live in ONE package, that one switch
// takes both of them down, and that the package is shaped like something
// another machine can install.
//
//   node verify/verify-deepwater.mjs

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${detail === undefined ? '' : `   [${detail}]`}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : `   [${detail}]`}`)
  }
}

console.log('\n[1] the package shape')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('the package is named after the row it mounts', pkg.name === 'dsh-deepwater', pkg.name)
check('it is published, not private', pkg.private !== true, String(pkg.private))
check('it carries a licence', pkg.license === 'MIT', pkg.license)
check('the browser entry is exported', pkg.exports?.['./client'] === './client.js', pkg.exports?.['./client'])
check('the client platform is declared', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform)
check('the bundle points at its patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', pkg.dsh?.bundle?.patch)
check('the sources are published', Array.isArray(pkg.files) && pkg.files.includes('src'), JSON.stringify(pkg.files))

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check('the patch mounts exactly one row', (patch.match(/- id:/g) || []).length === 1)
check('the row id is the settings namespace', patch.includes('- id: deepwater'))
check('the row names the package', patch.includes('name: dsh-deepwater'))

console.log('\n[2] the Host half')

const mod = await import(new URL('../entry.js', import.meta.url).href)
check('the row name is the package name', mod.name === 'dsh-deepwater', mod.name)
check('it declares the one service it needs', mod.inject.includes('webServer'), JSON.stringify(mod.inject))
check('it publishes the defaults it documents', mod.DEFAULTS && typeof mod.DEFAULTS === 'object')
check('the master switch defaults to on', mod.DEFAULTS.enabled === true)
check('the ambience switch defaults to on', mod.DEFAULTS.ambience === true)
check('the presets are the three the sheet ships', JSON.stringify(mod.PRESETS) === JSON.stringify(['roomy', 'compact', 'minimal']),
  JSON.stringify(mod.PRESETS))

const normalized = mod.normalize({ preset: 'nonsense', particles: 99, glow: 4, keyGlow: false, nonsense: true })
check('an unknown preset falls back to the default', normalized.preset === 'roomy', normalized.preset)
check('particles is clamped', normalized.particles === 40, normalized.particles)
check('glow is clamped', normalized.glow === 1, normalized.glow)
check('an explicit false survives', normalized.keyGlow === false)
check('an unknown field never reaches the page', !('nonsense' in normalized))
check('a missing field takes its default', normalized.transitions === true)

function mountHost(config) {
  const routes = []
  const events = []
  const ctx = {
    webServer: { register: (spec) => { routes.push(spec); return () => {} } },
    effect: (fn) => fn(),
    on: (event, fn) => { events.push({ event, fn }); return () => {} },
    logger: { warn: () => {} },
  }
  mod.apply(ctx, config)
  return { routes, events }
}

const host = mountHost({ preset: 'compact' })
const pick = (rows, prefix) => rows.find((r) => r.text.startsWith(prefix))?.text ?? ''
const table = []
host.events.find((e) => e.event === 'webserver/index-inject').fn(table)

const shared = pick(table, 'globalThis.__DSH_DEEPWATER_CFG__=')
check('the shared config global is injected', shared.startsWith('globalThis.__DSH_DEEPWATER_CFG__='))
const sharedCfg = JSON.parse(shared.slice('globalThis.__DSH_DEEPWATER_CFG__='.length))
check('it carries the preset the profile asked for', sharedCfg.preset === 'compact', sharedCfg.preset)
check('the route is handed to the page', pick(table, 'globalThis.__DSH_DEEPWATER_BASE__=').includes('/plugins/dsh-deepwater'))
check('both layers are configured', !!pick(table, 'globalThis.__DSH_POLISH_CFG__=') && !!pick(table, 'globalThis.__DSH_AMBIENT_FX_CFG__='))
check('the stylesheet is injected', !!pick(table, 'globalThis.__DSH_POLISH_CSS__='))
// Each layer is recognised by a string only its own source carries: the shared
// API mentions both layers' globals, so a global name would not tell the rows
// apart.
check('the surface script is injected', table.some((r) => r.text.includes('dsh-polish-style')))
check('the ambience script is injected', table.some((r) => r.text.includes('afx-behind')))
check('the shared API is injected last', table[table.length - 1].text.includes('__DSH_DEEPWATER__'))

const offTable = []
mountHost({ enabled: false }).events.find((e) => e.event === 'webserver/index-inject').fn(offTable)
check('a disabled row injects nothing at all - this is the one-click restore', offTable.length === 0, offTable.length)

const noAmbienceTable = []
mountHost({ ambience: false }).events.find((e) => e.event === 'webserver/index-inject').fn(noAmbienceTable)
check('the surface layer alone can be installed', !!pick(noAmbienceTable, 'globalThis.__DSH_POLISH_CFG__='))
check('...without the ambience layer', !pick(noAmbienceTable, 'globalThis.__DSH_AMBIENT_FX_CFG__='))
check('...and without its script', !noAmbienceTable.some((r) => r.text.includes('afx-behind')))

for (const [path, label] of [
  ['/plugins/dsh-deepwater/status', 'the status route'],
  ['/plugins/dsh-deepwater/settings', 'the settings route'],
  ['/plugins/dsh-deepwater/client-report', 'the surface report route'],
  ['/plugins/dsh-deepwater/report', 'the ambience report route'],
]) {
  const route = host.routes.find((r) => r.path === path)
  check(`${label} is registered exactly`, !!route && route.kind === 'exact', route?.path)
}

const settingsRes = { writeHead: (code) => { settingsRes.code = code }, end: (body) => { settingsRes.body = body } }
host.routes.find((r) => r.path === '/plugins/dsh-deepwater/settings').handler({}, settingsRes)
check('the settings route answers 200', settingsRes.code === 200, settingsRes.code)
check('...with the effective settings',
  JSON.parse(settingsRes.body).settings.preset === 'compact', settingsRes.body)

console.log('\n[3] the one-click restore')

const apiSource = readFileSync(join(root, 'src', 'deepwater.js'), 'utf8')
const sandbox = {
  console,
  __DSH_DEEPWATER_CFG__: { enabled: true, preset: 'roomy', ambience: true },
  __DSH_DEEPWATER_BASE__: '/plugins/dsh-deepwater',
  __DSH_VISUAL_POLISH__: { active: true, detach() { this.active = false; sandbox.detachedSurface = true } },
  __DSH_AMBIENT_FX__: { active: true, stop() { this.active = false; sandbox.stoppedAmbience = true } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(apiSource, sandbox, { filename: 'deepwater.js' })

check('the page gets one handle for both layers', !!sandbox.__DSH_DEEPWATER__ && sandbox.__DSH_DEEPWATER__.active)
check('it knows where the package serves', sandbox.__DSH_DEEPWATER__.base === '/plugins/dsh-deepwater')
check('it reports what is mounted',
  sandbox.__DSH_DEEPWATER__.state().surface === true && sandbox.__DSH_DEEPWATER__.state().ambienceLayer === true)

const torn = sandbox.__DSH_DEEPWATER__.restore()
check('one call takes the surface layer down', torn.surface === true && sandbox.detachedSurface === true)
check('...and the ambience layer with it', torn.ambience === true && sandbox.stoppedAmbience === true)
check('the layers report themselves inactive',
  sandbox.__DSH_VISUAL_POLISH__.active === false && sandbox.__DSH_AMBIENT_FX__.active === false)
let secondCallThrew = false
try { sandbox.__DSH_DEEPWATER__.restore() } catch (error) { secondCallThrew = true }
check('a second call is harmless', !secondCallThrew
  && sandbox.__DSH_VISUAL_POLISH__.active === false && sandbox.__DSH_AMBIENT_FX__.active === false)

console.log('\n[4] the browser entry')

let clientOk = false
try {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  clientOk = client.includes('__ModuleLoader__')
    && client.includes("id: 'dsh-deepwater'")
    && client.includes('__DSH_VISUAL_POLISH__')
    && client.includes('__DSH_AMBIENT_FX__')
    && client.includes('__DSH_DEEPWATER__')
} catch (error) {
  clientOk = false
}
check('the browser entry is built and carries both layers', clientOk)

if (clientOk) {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const built = statSync(join(root, 'client.js')).mtimeMs
  const sources = ['src/polish.css', 'src/polish.js', 'src/ambient.js', 'src/deepwater.js']
    .map((p) => statSync(join(root, p)).mtimeMs)
  check('the browser entry is not older than its sources', built >= Math.max(...sources),
    new Date(built).toISOString())
  check('it restores both layers when it is torn down',
    client.includes('__DSH_VISUAL_POLISH__') && client.includes('__DSH_AMBIENT_FX__')
    && client.includes('restore()'))
  check('it reads the live settings back for the desktop app',
    client.includes("/settings"))
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed}/${passed + failed} checks`)
process.exit(failed === 0 ? 0 : 1)
