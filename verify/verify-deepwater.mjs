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
// The flag has to say the package is down. The browser entry reads it before
// it installs anything, so a stale "still active" would turn the next enable
// into a no-op: the theme would stay off and the page would look broken
// rather than plain.
check('the package reports itself unmounted after a restore',
  sandbox.__DSH_DEEPWATER__.active === false, String(sandbox.__DSH_DEEPWATER__.active))

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

console.log('\n[5] the switch, end to end')

// The browser entry is what the desktop app actually runs, and the switch is
// its disposer: the Host drops the row, the client half's effect is disposed,
// and the disposer has to take both layers down. Then the row comes back and
// the entry has to install them again.
//
// This is the whole promise of the package, so it is tested the way it is
// used rather than in pieces: mount, switch off, switch on. The one thing
// that can silently break it is a guard that believes the package is still
// mounted after it was taken down - the second mount would then be a no-op
// and the page would sit there unstyled, which looks like a broken app rather
// than a disabled plugin.

function makeClientSandbox() {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    // The client half asks the Host for the live settings over the plugin's
    // own route. The reply is scripted here so a test can play the part of
    // the Host: 'live' answers with settings, 'gone' answers 404 the way a
    // switched-off row does, and 'unknown' answers nothing at all - which is
    // what a host that cannot be reached looks like.
    host: { state: 'unknown', settings: null },
    fetchLog: [],
    timers: [],
    fetch(url) {
      const target = String(url)
      sandbox.fetchLog.push(target)
      if (target.indexOf('/settings') !== -1) {
        if (sandbox.host.state === 'gone') {
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) })
        }
        if (sandbox.host.state === 'live') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ name: 'dsh-deepwater', settings: sandbox.host.settings }),
          })
        }
        return Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve(null) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) })
    },
    // Timers are collected instead of fired, so a test can decide when the
    // watch ticks.
    setTimeout(fn) {
      sandbox.timers.push(fn)
      return sandbox.timers.length
    },
    clearTimeout(id) {
      if (typeof id === 'number' && id >= 1) sandbox.timers[id - 1] = null
    },
    runTimers() {
      const pending = sandbox.timers.slice()
      sandbox.timers.length = 0
      for (const fn of pending) if (typeof fn === 'function') fn()
    },
    location: { href: 'dsh-app://app/' },
  }
  // The host's plugin stream: the graph says which rows are on. The client
  // half listens to it, so a test can play the part of the host.
  sandbox.EventSource = class {
    constructor(url) {
      this.url = url
      this.closed = false
      this.onmessage = null
      this.onerror = null
      sandbox.graphSource = this
    }
    close() { this.closed = true }
  }
  sandbox.globalThis = sandbox
  sandbox.window = { __ModuleLoader__: { load: (spec) => { sandbox.spec = spec } } }

  const root = {
    attrs: new Map(),
    setAttribute(k, v) { this.attrs.set(k, v) },
    getAttribute(k) { return this.attrs.get(k) ?? null },
    removeAttribute(k) { this.attrs.delete(k) },
  }
  const head = {
    children: [],
    appendChild(node) {
      node.parentNode = this
      this.children.push(node)
      // A <script> in the head runs as soon as it lands there. The injected
      // sources are plain scripts, so the sandbox runs them the same way.
      if (node.tagName === 'SCRIPT') {
        // The ambience layer has a suite of its own and needs a full DOM to
        // mount. Here it only has to answer the switch, so it is stood in for.
        if (node.textContent.includes('__DSH_AMBIENT_FX_CFG__')) {
          sandbox.__DSH_AMBIENT_FX__ = {
            active: true,
            stop() {
              this.active = false
              sandbox.ambienceStops = (sandbox.ambienceStops || 0) + 1
            },
          }
          return node
        }
        vm.runInContext(node.textContent, sandbox, { filename: 'injected.js' })
      }
      return node
    },
    removeChild(node) {
      const i = this.children.indexOf(node)
      if (i >= 0) this.children.splice(i, 1)
      node.parentNode = null
      return node
    },
  }
  const body = {
    attrs: new Map(),
    hasAttribute(k) { return this.attrs.has(k) },
    setAttribute(k, v) { this.attrs.set(k, v) },
    getAttribute(k) { return this.attrs.get(k) ?? null },
  }
  const document = {
    readyState: 'complete',
    documentElement: root,
    body,
    head,
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(), id: '', textContent: '', parentNode: null,
      dataset: {},
      remove() {
        if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
          this.parentNode.removeChild(this)
        }
      },
    }),
    getElementById: (id) => head.children.find((n) => n.id === id) ?? null,
  }
  sandbox.document = document
  sandbox.getComputedStyle = () => ({
    backgroundColor: 'rgb(12, 23, 32)',
    getPropertyValue: () => '',
  })
  vm.createContext(sandbox)
  return sandbox
}

const clientSandbox = makeClientSandbox()
vm.runInContext(readFileSync(join(root, 'client.js'), 'utf8'), clientSandbox, { filename: 'client.js' })
check('the browser entry registers itself with the module loader', !!clientSandbox.spec)

const plugin = clientSandbox.spec.factory()
const makeContext = (disposers) => ({
  effect(fn) {
    const cleanup = fn()
    disposers.push(cleanup)
    return () => { if (typeof cleanup === 'function') cleanup() }
  },
})

const firstRun = []
const firstDispose = plugin.apply(makeContext(firstRun))
check('mounting installs the surface layer', clientSandbox.__DSH_VISUAL_POLISH__?.active === true)
check('...and the stylesheet', clientSandbox.document.getElementById('dsh-polish-style') !== null)
check('...and the shared handle', clientSandbox.__DSH_DEEPWATER__?.active === true)

firstDispose()
check('switching off takes the stylesheet away', clientSandbox.document.getElementById('dsh-polish-style') === null)
check('...and the surface layer with it', clientSandbox.__DSH_VISUAL_POLISH__?.active === false)
check('...and the ambience layer with it', clientSandbox.__DSH_AMBIENT_FX__?.active === false)
check('...and the package says it is down', clientSandbox.__DSH_DEEPWATER__?.active === false,
  String(clientSandbox.__DSH_DEEPWATER__?.active))

// Switch on again. The entry asks the package whether it is still mounted
// before it installs anything, so this is where a stale flag bites.
const secondRun = []
const secondDispose = plugin.apply(makeContext(secondRun))
check('switching on again brings the surface layer back', clientSandbox.__DSH_VISUAL_POLISH__?.active === true)
check('...and the stylesheet with it', clientSandbox.document.getElementById('dsh-polish-style') !== null)
check('...and the ambience layer with it', clientSandbox.__DSH_AMBIENT_FX__?.active === true)
check('...and the package says it is mounted', clientSandbox.__DSH_DEEPWATER__?.active === true)

secondDispose()
check('switching off a second time works just as well',
  clientSandbox.document.getElementById('dsh-polish-style') === null
  && clientSandbox.__DSH_VISUAL_POLISH__?.active === false
  && clientSandbox.__DSH_AMBIENT_FX__?.active === false)

// The nastier version of the same bug: the flag says the package is mounted
// while the layers are gone. That is what a page looks like when it was
// switched off by a build that did not clear the flag. The entry has to look
// at the layers, not only at the flag, or the theme never comes back.
clientSandbox.__DSH_DEEPWATER__.active = true
const thirdRun = []
const thirdDispose = plugin.apply(makeContext(thirdRun))
check('a stale "still mounted" flag does not keep the theme off',
  clientSandbox.__DSH_VISUAL_POLISH__?.active === true
  && clientSandbox.document.getElementById('dsh-polish-style') !== null)
thirdDispose()

// [6] The watch: the client half follows the Host.
//
// Switching the row off takes the Host half down with it, and the desktop
// app renders its own SPA - nothing is pushed down to it. The client half has
// to go and ask instead, and it has to be able to read two answers: the route
// works, and the route stops working. The first one is the row being on, the
// second one is the row being off; the switch is nothing more than the
// difference between them.

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const watchSandbox = makeClientSandbox()
vm.runInContext(readFileSync(join(root, 'client.js'), 'utf8'), watchSandbox, { filename: 'client.js' })
const watchPlugin = watchSandbox.spec.factory()
const watchDisposers = []
watchSandbox.host.state = 'live'
watchSandbox.host.settings = { enabled: true, preset: 'roomy', ambience: true }
watchPlugin.apply(makeContext(watchDisposers))
await flush()
check('the client half asks the host where it stands',
  watchSandbox.fetchLog.some((u) => u.indexOf('/settings') !== -1))
check('...and the layers are up while the host says the row is on',
  watchSandbox.__DSH_VISUAL_POLISH__?.active === true
  && watchSandbox.document.getElementById('dsh-polish-style') !== null)

const askedBefore = watchSandbox.fetchLog.filter((u) => u.indexOf('/settings') !== -1).length
watchSandbox.runTimers()
await flush()
check('...and it keeps asking',
  watchSandbox.fetchLog.filter((u) => u.indexOf('/settings') !== -1).length > askedBefore)

watchSandbox.host.state = 'gone'
watchSandbox.runTimers()
await flush()
check('a row that stopped answering takes the stylesheet away',
  watchSandbox.document.getElementById('dsh-polish-style') === null)
check('...and the surface layer with it', watchSandbox.__DSH_VISUAL_POLISH__?.active === false)
check('...and the ambience layer with it', watchSandbox.__DSH_AMBIENT_FX__?.active === false)
check('...and the package says it is down', watchSandbox.__DSH_DEEPWATER__?.active === false)

watchSandbox.host.state = 'live'
watchSandbox.host.settings = { enabled: true, preset: 'compact', ambience: true }
watchSandbox.runTimers()
await flush()
check('a row that answers again brings the stylesheet back',
  watchSandbox.document.getElementById('dsh-polish-style') !== null)
check('...and the surface layer with it', watchSandbox.__DSH_VISUAL_POLISH__?.active === true)
check('...and the ambience layer with it', watchSandbox.__DSH_AMBIENT_FX__?.active === true)
check('...and the new preset is the one on screen',
  watchSandbox.document.documentElement.getAttribute('data-polish') === 'compact',
  String(watchSandbox.document.documentElement.getAttribute('data-polish')))

// A row that is configured off is the same story told by the config instead
// of by the route: the layers go away and stay away.
watchSandbox.host.settings = { enabled: false, preset: 'compact', ambience: true }
watchSandbox.runTimers()
await flush()
check('a row that is configured off takes the layers down',
  watchSandbox.document.getElementById('dsh-polish-style') === null
  && watchSandbox.__DSH_VISUAL_POLISH__?.active === false)

for (const dispose of watchDisposers) dispose()

// [7] The graph stream.
//
// The row being switched off takes this package's own routes with it, so the
// client half cannot ask itself what happened. The host's plugin stream is
// served by the host and stays readable, and it says which rows are on: the
// row leaving the graph is the switch being turned off, the row coming back
// is the switch being turned on.

const graphSandbox = makeClientSandbox()
vm.runInContext(readFileSync(join(root, 'client.js'), 'utf8'), graphSandbox, { filename: 'client.js' })
const graphPlugin = graphSandbox.spec.factory()
const graphDisposers = []
graphPlugin.apply(makeContext(graphDisposers))
await flush()
check('the client half listens to the host plugin stream',
  graphSandbox.graphSource?.url === '/plugins/events',
  String(graphSandbox.graphSource?.url))

const frame = (ids) => ({
  data: JSON.stringify({ type: 'graph', graph: { rev: 'test', entries: ids.map((id) => ({ id })) } }),
})

graphSandbox.graphSource.onmessage(frame(['some-other-plugin']))
check('a row that left the graph takes the stylesheet away',
  graphSandbox.document.getElementById('dsh-polish-style') === null)
check('...and the surface layer with it', graphSandbox.__DSH_VISUAL_POLISH__?.active === false)
check('...and the ambience layer with it', graphSandbox.__DSH_AMBIENT_FX__?.active === false)

graphSandbox.graphSource.onmessage(frame(['some-other-plugin', 'dsh-deepwater']))
check('a row that came back brings the stylesheet with it',
  graphSandbox.document.getElementById('dsh-polish-style') !== null)
check('...and the surface layer with it', graphSandbox.__DSH_VISUAL_POLISH__?.active === true)
check('...and the ambience layer with it', graphSandbox.__DSH_AMBIENT_FX__?.active === true)

for (const dispose of graphDisposers) dispose()
check('the plugin stream is closed when the entry goes away',
  graphSandbox.graphSource?.closed === true)

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed}/${passed + failed} checks`)
process.exit(failed === 0 ? 0 : 1)
