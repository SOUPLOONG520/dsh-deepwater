// verify-ambient.mjs - offline proof for the ambience layer of dsh-deepwater, with no DSH process,
// no port and no browser.
//
// It covers the two halves separately, because they fail differently:
//   [1] the Host half: the row reaches the injection table, the config global
//       is normalized, a disabled row injects nothing, and the status route is
//       registered where the page would look for it;
//   [2] the browser half, run for real as text inside a stub DOM: the layers
//       mount, the effects fire on the events they claim, reduced motion is
//       honoured, stop() leaves nothing behind - and, because this plugin runs
//       in the app's own renderer, the mutation path is held to a hard budget
//       of geometry reads. That last group exists because the first version of
//       this plugin measured every added node inside the observer callback,
//       which is a forced layout per record and was felt as a sticky UI.
//
// Run it from the package root:
//   node verify/verify-ambient.mjs

import { readFileSync } from 'node:fs'
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

// --- a stub DOM, sized to exactly what src/ambient.js touches ----------------

class ClassList {
  constructor() { this.set = new Set() }
  add(...names) { names.forEach((n) => this.set.add(n)) }
  remove(...names) { names.forEach((n) => this.set.delete(n)) }
  contains(name) { return this.set.has(name) }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : !!force
    if (want) this.set.add(name); else this.set.delete(name)
    return want
  }
}

class Style {
  constructor() { this.props = new Map() }
  setProperty(name, value) { this.props.set(name, value) }
  removeProperty(name) { this.props.delete(name) }
  getPropertyValue(name) { return this.props.get(name) ?? '' }
}

// Every geometry read goes through here, so the tests can hold the plugin to a
// budget instead of trusting the comments.
let rectCalls = 0

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.childNodes = []
    this.childElementCount = 0
    this.parentNode = null
    this.parentElement = null
    this.style = new Style()
    this.classList = new ClassList()
    this.attributes = new Map()
    this.textContent = ''
    this.id = ''
    this.className = ''
    this.listeners = []
    this.rect = { width: 0, height: 0, right: 0, top: 0, left: 0 }
  }
  // className and classList share one storage, as in the DOM: the plugin sets one
  // and the checks read the other, and a stub where they disagree reports the wrong
  // thing at exactly the moment a test is trying to explain a failure.
  get className() { return [...this.classList.set].join(' ') }
  set className(value) {
    this.classList.set = new Set(String(value ?? '').split(/\s+/).filter(Boolean))
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  appendChild(child) {
    child.parentNode = this
    child.parentElement = this
    this.childNodes.push(child)
    return child
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    child.parentNode = null
    return child
  }
  addEventListener(type, fn, opts) { this.listeners.push({ type, fn, opts }) }
  removeEventListener(type, fn) {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }
  getBoundingClientRect() { rectCalls += 1; return this.rect }
  getElementsByTagName() { return collect(this) }
}

function collect(node, out = []) {
  for (const child of node.childNodes) { out.push(child); collect(child, out) }
  return out
}

function makeDocument({ activeRowCandidate = null, editable = null } = {}) {
  const html = new Node('html')
  const head = new Node('head')
  const body = new Node('body')
  html.appendChild(head)
  html.appendChild(body)
  const document = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    documentElement: html,
    head,
    body,
    createElement: (tag) => new Node(tag),
    getElementById(id) {
      if (html.id === id) return html
      return collect(html).find((n) => n.id === id) ?? null
    },
    querySelectorAll(selector) {
      // Selector-aware, so the selected-row scan and the editable probe never see
      // each other's fixtures.
      if (/textarea|contenteditable|input/.test(String(selector))) return editable ? [editable] : []
      return activeRowCandidate ? [activeRowCandidate] : []
    },
    addEventListener() {},
    removeEventListener() {},
  }
  return { document, html, head, body }
}

function makeSandbox({
  reducedMotion = false,
  activeRowCandidate = null,
  editable = null,
  dark = true,
  frameCandidate = null,
  darkAttribute = false,
  unmeasurable = false,
  windowsTitlebar = false,
  controlsOverlay = null,
  fullscreen = false,
  sidebarFill = null,
} = {}) {
  const { document, html, head, body } = makeDocument({ activeRowCandidate, editable })
  if (frameCandidate) body.appendChild(frameCandidate)
  if (darkAttribute) body.setAttribute('data-ds-dark-theme', '')
  if (windowsTitlebar) html.setAttribute('data-windows-titlebar', '')
  if (fullscreen) document.fullscreenElement = html
  const timers = []
  const intervals = []
  const clearedIntervals = []
  const windowListeners = []
  const observers = []
  const fetchCalls = []
  const sandbox = {
    document,
    innerWidth: 1440,
    innerHeight: 900,
    fetch: (url, options) => { fetchCalls.push({ url, options }); return { ok: true } },
    fetchCalls,
    Math,
    Date,
    String,
    Number,
    parseInt,
    parseFloat,
    isFinite,
    RegExp,
    console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: (id) => { clearedIntervals.push(id) },
    matchMedia: (query) => ({ matches: reducedMotion && query.includes('reduce'), media: query }),
    getSelection: () => null,
    // The theme token is what the plugin reads; the measured background colour
    // stays as the fallback, exactly as in the browser. A node may carry its own
    // `computed`, which is how a test describes a fixed or raised-z-index element
    // - the shape the boot overlay has.
    // `unmeasurable` describes a shell whose theme neither a token nor a painted
    // background colour reveals - the case that must guess in the safe direction.
    getComputedStyle: (node) => node?.computed ?? (unmeasurable ? {
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      position: 'static',
      zIndex: 'auto',
      getPropertyValue: () => '',
    } : {
      backgroundColor: sidebarFill !== null ? sidebarFill : (dark ? 'rgb(8, 16, 24)' : 'rgb(250, 250, 252)'),
      backgroundImage: 'none',
      position: 'static',
      zIndex: 'auto',
      getPropertyValue: (name) => (name === '--dsw-alias-bg-base'
        ? (dark ? '#08101a' : 'rgb(250, 250, 252)')
        : ''),
    }),
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn
        this.disconnected = false
        this.observations = []
        observers.push(this)
      }
      observe(target, options) {
        this.target = target
        this.options = options
        this.observations.push({ target, options })
      }
      disconnect() { this.disconnected = true }
    },
    addEventListener(type, fn, opts) { windowListeners.push({ type, fn, opts }) },
    removeEventListener(type, fn) {
      const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i >= 0) windowListeners.splice(i, 1)
    },
  }
  if (controlsOverlay) sandbox.navigator = { windowControlsOverlay: controlsOverlay }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  return { sandbox, document, html, head, body, timers, intervals, clearedIntervals, windowListeners, observers, fetchCalls }
}

function runAmbient(config, options = {}) {
  const source = readFileSync(join(root, 'src', 'ambient.js'), 'utf8')
  const env = makeSandbox(options)
  env.sandbox.__DSH_AMBIENT_FX_CFG__ = config
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'ambient.js' })
  return env
}

/** Run every queued one-shot callback, but not the ones they queue themselves. */
function flushTimers(env) {
  const queue = env.timers.splice(0)
  for (const timer of queue) {
    try { timer.fn() } catch (error) { console.log(`  (timer threw: ${error.message})`) }
  }
}

/** A node that looks like a panel: deep enough to be a candidate, big enough to count. */
function panelLike(env) {
  const node = new Node('div')
  node.childElementCount = 8
  node.rect = { width: 1200, height: 700, right: 1200, top: 0, left: 0 }
  env.body.appendChild(node)
  return node
}

// --- [1] the Host half -------------------------------------------------------

console.log('\n[1] the Host half')

const mod = await import(new URL('../entry.js', import.meta.url).href)
check('the row name is the package name', mod.name === 'dsh-deepwater', mod.name)
check('it declares the one service it needs', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject))

function mountHost(config) {
  const routes = []
  const events = []
  const ctx = {
    webServer: { register: (spec) => { routes.push(spec); return () => {} } },
    effect: (fn) => fn(),
    on: (event, fn) => { events.push({ event, fn }); return () => {} },
    logger: { warn: (...args) => events.push({ event: 'warn', args }) },
  }
  mod.apply(ctx, config)
  return { routes, events }
}

const host = mountHost({ particles: 99, glow: 4, keyGlow: false })
const status = host.routes.find((r) => r.path === '/plugins/dsh-deepwater/status')
check('the status route is registered exactly', !!status && status.kind === 'exact', status?.path)
check('it subscribes to the index injection', host.events.some((e) => e.event === 'webserver/index-inject'))

const listener = host.events.find((e) => e.event === 'webserver/index-inject').fn
const table = []
listener(table)
// The rows are found by their content, not by their position: the unified
// package pushes a row for the shared config and one for each layer, and only
// the content says which is which.
const pick = (rows, prefix) => rows.find((r) => r.text.startsWith(prefix))?.text ?? ''
check('an enabled row injects head rows for both layers', table.length >= 6, table.length)
check('all of them are head scripts', table.every((r) => r.kind === 'script' && r.placement === 'head'))
const cfgText = pick(table, 'globalThis.__DSH_AMBIENT_FX_CFG__=')
check('the config global is injected', cfgText.startsWith('globalThis.__DSH_AMBIENT_FX_CFG__='), cfgText.slice(0, 44))
const injected = JSON.parse(cfgText.slice('globalThis.__DSH_AMBIENT_FX_CFG__='.length))
check('particles is clamped to the documented range', injected.particles === 40, injected.particles)
check('glow is clamped to 0..1', injected.glow === 1, injected.glow)
check('an explicit false survives normalization', injected.keyGlow === false)
check('a missing field takes its default', injected.transitions === true)
check('the removed ripple knob is gone from the contract', !('ripples' in injected))
check('the layer is told where to report', injected.base === '/plugins/dsh-deepwater', injected.base)
check('the script row is the real file', table.some((r) => r.text.includes('afx-behind')))

const offTable = []
mountHost({ enabled: false }).events.find((e) => e.event === 'webserver/index-inject').fn(offTable)
check('a disabled row injects nothing at all', offTable.length === 0, offTable.length)

const statusRes = { writeHead: (code) => { statusRes.code = code }, end: (body) => { statusRes.body = body } }
status.handler({}, statusRes)
const statusBody = JSON.parse(statusRes.body)
check('the status route answers 200 without a token', statusRes.code === 200, statusRes.code)
check('the status route reports the normalized settings', statusBody.settings.particles === 40)
check('the status route counts real injections', statusBody.injections === 1, statusBody.injections)

// The report sink: how the page tells the Host what it actually sees.
const reportRoute = host.routes.find((r) => r.path === '/plugins/dsh-deepwater/report')
check('the report route is registered exactly', !!reportRoute && reportRoute.kind === 'exact', reportRoute?.path)
const reportRes = { writeHead: (code) => { reportRes.code = code }, end: (body) => { reportRes.body = body } }
const fakeReq = {
  method: 'POST',
  on(type, fn) {
    if (type === 'data') fn(Buffer.from(JSON.stringify({ reason: 'test', chosen: { w: 1, h: 2 }, chain: [{ d: 0, tag: 'textarea' }] })))
    if (type === 'end') fn()
    return fakeReq
  },
  destroy() {},
}
reportRoute.handler(fakeReq, reportRes)
check('a posted report is accepted', reportRes.code === 200 && JSON.parse(reportRes.body).stored === 1, reportRes.body)
const statusAgain = { writeHead: () => {}, end: (body) => { statusAgain.body = body } }
status.handler({}, statusAgain)
const withReport = JSON.parse(statusAgain.body)
check('the status route hands the report back', withReport.reports?.[0]?.reason === 'test', JSON.stringify(withReport.reports?.[0] ?? null))
check('...with its chain intact', withReport.reports?.[0]?.chain?.[0]?.tag === 'textarea')

const badRes = { writeHead: (code) => { badRes.code = code }, end: (body) => { badRes.body = body } }
reportRoute.handler({ method: 'GET', url: '/plugins/dsh-deepwater/report?payload=not-json' }, badRes)
check('a malformed report is refused, not stored', badRes.code === 400, badRes.code)

// --- [2] the browser half, in a stub DOM ------------------------------------

console.log('\n[2] the browser half')

const run1 = runAmbient({ particles: 5, glow: 0.4 })
check('the ambience layer mounts', !!run1.document.getElementById('afx-layer'))
check('the behind layer mounts', !!run1.document.getElementById('afx-behind'))
check('the stylesheet is injected', !!run1.document.getElementById('afx-style'))
check('the glow strength reaches the layer', run1.document.getElementById('afx-layer').style.getPropertyValue('--afx-glow') === '0.4')
const blobs = run1.document.getElementById('afx-layer').childNodes.filter((n) => n.className === 'afx-blob').length
check('the requested number of blobs is built', blobs === 5, blobs)
check('a dark frame gets the dark treatment', run1.html.classList.contains('afx-light') === false)
check('the key listener is armed', run1.windowListeners.some((l) => l.type === 'keydown'))
check('the global handle is exposed', run1.sandbox.__DSH_AMBIENT_FX__.active === true)

// The removed effect must be gone from the artifact, not merely switched off.
const cssText = String(run1.document.getElementById('afx-style').textContent || '')
check('the ripple effect is gone from the stylesheet', !cssText.includes('afx-ripple'))
check('no click listener remains for it', !run1.windowListeners.some((l) => l.type === 'pointerdown'))
check('no blur filter is left in the stylesheet', !cssText.includes('filter:blur'))

// The typing light: a node INSIDE the card, raised fast and lowered slowly.
//
// The history explains the shape of these assertions. v1 lit the inner field, v2 the
// editing row, v3 the largest painted ancestor, v4 the union of compatible ancestors,
// v5 the card's own outline. The structural report settled the targeting (the chosen
// box was already exactly the card: 856x98 at top 634, radius 28px) and the outline
// settled the fit - but a 2px ring is a hard edge, and every keystroke restarted its
// animation at full brightness, which reads as a series of flashes rather than a
// light. So the effect is a child node with an inline opacity and a TRANSITION: a
// value that is only ever raised or lowered cannot jump.
const key = run1.windowListeners.find((l) => l.type === 'keydown').fn
const move = run1.windowListeners.find((l) => l.type === 'pointermove').fn
const halosIn = (node) => (node.childNodes || []).filter((n) => String(n.className).includes('afx-halo'))
const drawnHalos = () => run1.body.childNodes.filter((n) => String(n.className).includes('afx-keyglow'))

// The three timings are read out of the source instead of being hardcoded, so tuning
// the feel cannot produce false failures - while the relationships that make it feel
// right (a fast rise, a slow fall) stay asserted.
const ambientSource = readFileSync(join(root, 'src', 'ambient.js'), 'utf8')
const RISE_MS = Number(/RISE_MS = (\d+)/.exec(ambientSource)?.[1])
const FALL_MS = Number(/FALL_MS = (\d+)/.exec(ambientSource)?.[1])
check('the timings are readable and asymmetric', RISE_MS > 0 && FALL_MS > 0, `${RISE_MS}ms rise / ${FALL_MS}ms fall`)
check('...with a rise crisp enough to feel like the box answered',
  RISE_MS <= 120, `${RISE_MS}ms`)
check('...and a fall still long enough to be a dissolve, not a blink',
  FALL_MS >= 700, `${FALL_MS}ms`)

function composerCard({ cardRect = { width: 620, height: 62, right: 710, top: 490, left: 90 },
  fieldRect = { width: 600, height: 40, right: 700, top: 500, left: 100 },
  cardStyle = { backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none', borderTopWidth: '0px', borderRadius: '20px' },
  cardPosition = 'relative' } = {}) {
  const card = new Node('div')
  card.rect = cardRect
  card.computed = {
    position: cardPosition, zIndex: 'auto', overflow: 'visible', getPropertyValue: () => '', ...cardStyle,
  }
  const field = new Node('textarea')
  field.rect = fieldRect
  field.computed = {
    backgroundColor: 'transparent', backgroundImage: 'none', position: 'static', zIndex: 'auto',
    borderRadius: '0px', getPropertyValue: () => '',
  }
  card.appendChild(field)
  run1.body.appendChild(card)
  return { card, field }
}

const first = composerCard()
run1.document.activeElement = first.field
move({ clientX: 20, clientY: 20 })
key({ key: 'a' })
const halo = halosIn(first.card)[0]
check('a keystroke lights the card through a node inside it', !!halo)
check('...placed over the card\'s BORDER box, so the rim lands on the edge the user sees',
  halo?.style.position === 'absolute'
  && halo?.style.left === '0px' && halo?.style.top === '0px'
  && halo?.style.width === '620px' && halo?.style.height === '62px'
  && halo?.style.borderRadius === 'inherit',
  halo ? `${halo.style.position}, ${halo.style.left},${halo.style.top} ${halo.style.width}x${halo.style.height}, radius:${halo.style.borderRadius}` : 'none')
check('...raised quickly', halo?.style.transitionDuration === `${RISE_MS}ms` && halo?.style.opacity === '0.92',
  `${halo?.style.transitionDuration} @ ${halo?.style.opacity}`)
check('...carrying an inner rim and two diffusion stops',
  String(halo?.style.boxShadow).includes('inset 0 0 0 2px')
  && (String(halo?.style.boxShadow).match(/0 0 \d+px \d+px/g) || []).length === 2,
  String(halo?.style.boxShadow))
check('...in the dark frame\'s cold cyan',
  String(halo?.style.boxShadow).includes('rgba(158,228,255,.60)')
  && String(halo?.style.boxShadow).includes('rgba(104,200,255,.46)'))

// Typing again must HOLD the level rather than restart a flash: that is the whole
// difference between a light and a strobe.
const held = { node: halo, opacity: halo?.style.opacity, duration: halo?.style.transitionDuration }
key({ key: 'b' })
key({ key: 'c' })
check('repeated keystrokes hold one steady light instead of restarting a flash',
  halosIn(first.card).length === 1 && halosIn(first.card)[0] === held.node
  && halosIn(first.card)[0].style.opacity === held.opacity,
  `${halosIn(first.card).length} node(s), opacity ${halosIn(first.card)[0]?.style.opacity}`)
check('...and the rise stays the fast one',
  halosIn(first.card)[0].style.transitionDuration === held.duration)

// The fall: only after the pause, and much slower than the rise.
flushTimers(run1)
const fell = halosIn(first.card)[0]
check('the light falls only after the pause',
  fell?.style.opacity === '0', `opacity ${fell?.style.opacity}`)
check('...on a long, eased curve rather than a linear one',
  fell?.style.transitionDuration === `${FALL_MS}ms`
  && String(fell?.style.transitionTimingFunction).includes('cubic-bezier'),
  `${fell?.style.transitionDuration} ${fell?.style.transitionTimingFunction}`)
check('...and that fall is much slower than the rise, which is what makes it silky',
  parseFloat(fell?.style.transitionDuration) > parseFloat(held.duration) * 5,
  `${held.duration} -> ${fell?.style.transitionDuration}`)

// Once the fall is over, the node leaves: no foreign child is left behind inside the
// application's own card.
flushTimers(run1)
check('...and the node is taken away once the fall has finished',
  halosIn(first.card).length === 0, halosIn(first.card).length)

// The reported bug: the glow covered only the UPPER part of the input box. The
// cause was a painted inner row winning over the taller card that contains it -
// and a card this tall (4.3x the editing row) was rejected outright by the old
// 3.5x height cap, which left only the row lit.
const nested = (() => {
  const mk = (rect, style) => {
    const node = new Node('div')
    node.rect = rect
    node.computed = {
      position: 'static', zIndex: 'auto', backgroundImage: 'none',
      borderTopWidth: '0px', getPropertyValue: () => '', ...style,
    }
    return node
  }
  const card = mk({ width: 620, height: 104, right: 710, top: 470, left: 90 },
    { backgroundColor: 'rgb(255, 255, 255)', borderRadius: '20px', position: 'relative' })
  const row = mk({ width: 600, height: 28, right: 700, top: 486, left: 100 },
    { backgroundColor: 'rgb(250, 250, 250)', borderRadius: '8px' })
  const field = mk({ width: 560, height: 24, right: 680, top: 488, left: 120 },
    { backgroundColor: 'transparent', borderRadius: '0px' })
  card.appendChild(row)
  row.appendChild(field)
  run1.body.appendChild(card)
  return { card, row, field }
})()

run1.document.activeElement = nested.field
key({ key: 'g' })
check('the light node goes on the CARD, not on the row inside it',
  halosIn(nested.card).length === 1 && halosIn(nested.row).length === 0,
  `${halosIn(nested.card).length} on card / ${halosIn(nested.row).length} on row`)
check('...and it moves house, so only one card is ever lit', halosIn(first.card).length === 0)

// The case no single-element rule can win: a TRANSPARENT card whose visible box is
// the editing row plus a toolbar SIBLING. The union of the field's compatible
// ancestors still spans the whole card, because the transparent card's own box does.
const siblingCase = (() => {
  const mk = (rect, style) => {
    const node = new Node('div')
    node.rect = rect
    node.computed = {
      position: 'static', zIndex: 'auto', backgroundImage: 'none',
      borderTopWidth: '0px', getPropertyValue: () => '', ...style,
    }
    return node
  }
  const card = mk({ width: 620, height: 104, right: 710, top: 470, left: 90 },
    { backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '20px', position: 'relative' })
  const row = mk({ width: 600, height: 28, right: 700, top: 486, left: 100 },
    { backgroundColor: 'rgb(250, 250, 250)', borderRadius: '8px' })
  const field = mk({ width: 560, height: 24, right: 680, top: 488, left: 120 },
    { backgroundColor: 'transparent', borderRadius: '0px' })
  const toolbar = mk({ width: 600, height: 44, right: 700, top: 518, left: 100 },
    { backgroundColor: 'rgb(248, 248, 248)', borderRadius: '8px' })
  card.appendChild(row)
  card.appendChild(toolbar)     // a sibling of the row, not an ancestor of the field
  row.appendChild(field)
  run1.body.appendChild(card)
  return { card, row, field, toolbar }
})()

run1.document.activeElement = siblingCase.field
key({ key: 'h' })
check('a transparent card with a sibling toolbar is lit as ONE box',
  halosIn(siblingCase.card).length === 1, halosIn(siblingCase.card).length)
check('...reaching the toolbar by construction: the node is placed on the card\'s measured box',
  siblingCase.card.childNodes.includes(siblingCase.toolbar)
  && halosIn(siblingCase.card)[0].style.width === '620px'
  && halosIn(siblingCase.card)[0].style.height === '104px'
  && halosIn(siblingCase.card)[0].style.left === '0px')
key({ key: 'Enter' })
check('Enter is the stronger case: brighter, with a wider rim',
  halosIn(siblingCase.card)[0].style.opacity === '1'
  && String(halosIn(siblingCase.card)[0].style.boxShadow).includes('inset 0 0 0 3px'),
  `${halosIn(siblingCase.card)[0].style.opacity} / ${halosIn(siblingCase.card)[0].style.boxShadow}`)

// An ancestor that is nothing like the field (the whole page, say) must not be
// adopted as "the composer": the guard keeps the light input-sized.
const wide = composerCard({ cardRect: { width: 1440, height: 900, right: 1440, top: 0, left: 0 } })
run1.document.activeElement = wide.field
key({ key: 'd' })
check('an oversized ancestor is refused: no node goes inside it', halosIn(wide.card).length === 0)
const wideGlow = drawnHalos().pop()
check('...so the fallback halo is drawn at the field, in DOCUMENT coordinates',
  wideGlow?.style.left === '100px' && wideGlow?.style.top === '500px'
  && wideGlow?.style.width === '600px' && wideGlow?.style.height === '40px',
  wideGlow ? `${wideGlow.style.left},${wideGlow.style.top},${wideGlow.style.width},${wideGlow.style.height}` : 'none')
check('...as a guess it carries no rim, only diffusion',
  !!wideGlow && !String(wideGlow.style.boxShadow).includes('inset'),
  String(wideGlow?.style.boxShadow ?? 'none'))
check('...and it is raised and lowered exactly the same way',
  wideGlow?.style.opacity === '0.92' && wideGlow?.style.transitionDuration === `${RISE_MS}ms`
  && String(wideGlow?.style.transitionTimingFunction).includes('cubic-bezier'))

// A card that cannot host the node (static positioning, or an overflow that would
// clip the halo away) still gets a soft light - from the drawn path.
const staticCard = composerCard({ cardPosition: 'static' })
run1.document.activeElement = staticCard.field
key({ key: 'j' })
check('a static card cannot host a node, so it gets the drawn halo instead',
  halosIn(staticCard.card).length === 0 && drawnHalos().length === 1, drawnHalos().length)

// The effect lives in inline styles now, so the stylesheet is asserted for what it
// must no longer carry, plus the two things that must remain.
check('the stylesheet no longer carries the outline or pseudo-halo machinery',
  !cssText.includes('afx-typing-a') && !cssText.includes('afx-halo-after')
  && !cssText.includes('@keyframes afx-outline') && !cssText.includes('@keyframes afx-halo'),
  'the effect is inline: no class-driven animation is left to fight the app')
check('...and no negative px inset anywhere, so the unlit-band bug cannot return',
  !/inset:-\d+px/.test(cssText))
check('the drawn fallback is still absolute, not fixed',
  cssText.includes('.afx-keyglow{position:absolute;pointer-events:none;z-index:1}'))
check('the pointer dot still animates', cssText.includes('@keyframes afx-keyglow'))
check('...and the dot follows the theme too',
  cssText.includes('html.afx-light .afx-keydot{background:radial-gradient(50% 50% at 50% 50%,rgba(224,186,124,.48)'))

// The migration rule, asserted rather than assumed: ONE mechanism, two palettes. The
// light frame's light is pale gold - a warm accent on the cool blue page, and the one
// hue that still reads as light over a near-white card.
const goldRun = runAmbient({ particles: 1 }, { dark: false })
const goldKey = goldRun.windowListeners.find((l) => l.type === 'keydown').fn
const goldCard = new Node('div')
goldCard.rect = { width: 620, height: 62, right: 710, top: 490, left: 90 }
goldCard.computed = {
  position: 'relative', zIndex: 'auto', overflow: 'visible', getPropertyValue: () => '',
  backgroundColor: 'rgb(244, 249, 253)', backgroundImage: 'none', borderTopWidth: '0px', borderRadius: '20px',
}
const goldField = new Node('textarea')
goldField.rect = { width: 600, height: 40, right: 700, top: 500, left: 100 }
goldField.computed = {
  backgroundColor: 'transparent', backgroundImage: 'none', position: 'static', zIndex: 'auto',
  borderRadius: '0px', getPropertyValue: () => '',
}
goldCard.appendChild(goldField)
goldRun.body.appendChild(goldCard)
goldRun.document.activeElement = goldField
goldKey({ key: 'a' })
const goldHalo = halosIn(goldCard)[0]
check('the light frame is detected as light in this sandbox too',
  goldRun.html.classList.contains('afx-light'))
check('a light frame gets honey, not the dark frame\'s cyan',
  !!goldHalo && String(goldHalo.style.boxShadow).includes('rgba(214,170,110,.72)')
  && !String(goldHalo.style.boxShadow).includes('158,228,255'),
  String(goldHalo?.style.boxShadow ?? 'none'))
// "Slightly warmer" is a band here, not a taste: the saturated gold leaf it started as
// was R-B 134 (metal) and the cool champagne it went to was 66 (beige). Asserting the
// warm middle keeps a future edit from quietly sliding back to either end.
const honey = /inset 0 0 0 2px rgba\((\d+),(\d+),(\d+)/.exec(String(goldHalo?.style.boxShadow))
check('...a warm honey: warmer than the champagne, short of gold leaf',
  !!honey && Number(honey[1]) - Number(honey[3]) >= 85 && Number(honey[1]) - Number(honey[3]) <= 125
  && Number(honey[3]) >= 95,
  honey ? `rgb(${honey[1]},${honey[2]},${honey[3]}) R-B=${Number(honey[1]) - Number(honey[3])}` : 'none')
check('...with the identical behaviour: at the card edge, fast rise, same curve',
  goldHalo?.style.left === '0px' && goldHalo?.style.width === '620px'
  && goldHalo?.style.borderRadius === 'inherit'
  && goldHalo?.style.transitionDuration === `${RISE_MS}ms`
  && String(goldHalo?.style.transitionTimingFunction).includes('cubic-bezier'))

run1.document.activeElement = null
key({ key: 'e' })
check('with nothing focused it falls back to the pointer dot',
  run1.body.childNodes.some((n) => String(n.className).includes('afx-keydot')))
key({ key: 'Shift' })
check('a modifier-only key is ignored',
  run1.body.childNodes.filter((n) => String(n.className).includes('afx-keyglow')).length === 1
  && run1.body.childNodes.filter((n) => String(n.className).includes('afx-keydot')).length === 1,
  'one glow, one dot')

// The bug this placement fixes, asserted so it cannot come back. A card with
// padding used to light a ring INSIDE its visible edge, because `inset: 0` fills
// the padding box - twenty pixels in from the border the user can actually see.
// The node is now placed on the measured box, so the rim lands on that border.
const padded = composerCard({
  cardStyle: {
    backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none', borderTopWidth: '0px',
    borderRadius: '20px', paddingLeft: '20px', paddingRight: '20px', paddingTop: '8px', paddingBottom: '8px',
  },
})
run1.document.activeElement = padded.field
key({ key: 'p' })
const paddedHalo = halosIn(padded.card)[0]
check('a padded card is lit on its border box, not on its padding box',
  paddedHalo?.style.width === '620px' && paddedHalo?.style.height === '62px'
  && paddedHalo?.style.left === '0px' && paddedHalo?.style.top === '0px',
  paddedHalo ? `${paddedHalo.style.left},${paddedHalo.style.top} ${paddedHalo.style.width}x${paddedHalo.style.height}` : 'none')

// The composer card is often only a PADDED WRAPPER: the card carries no border
// of its own, and the box inside it - twenty pixels in, with the visible edge -
// is what the user sees. Lighting the card put the glow in the padding ring,
// which is exactly the "the light is not quite on the border" report. The first
// ancestor that draws a border is the visible box, so the glow belongs there.
const wrapped = composerCard({
  cardRect: { width: 620, height: 62, right: 710, top: 490, left: 90 },
  fieldRect: { width: 580, height: 30, right: 670, top: 505, left: 120 },
  cardStyle: {
    backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none', borderTopWidth: '0px',
    borderRadius: '20px', paddingLeft: '20px', paddingRight: '20px', paddingTop: '8px', paddingBottom: '8px',
  },
})
const framedBox = new Node('div')
framedBox.rect = { width: 600, height: 44, right: 710, top: 498, left: 110 }
framedBox.computed = {
  backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none', borderTopWidth: '1px',
  borderLeftWidth: '1px', borderRadius: '14px', position: 'relative', overflow: 'visible',
  zIndex: 'auto', getPropertyValue: () => '',
}
const innerField = new Node('textarea')
innerField.rect = { width: 580, height: 30, right: 670, top: 505, left: 120 }
innerField.computed = {
  backgroundColor: 'transparent', backgroundImage: 'none', position: 'static', zIndex: 'auto',
  borderRadius: '0px', getPropertyValue: () => '',
}
framedBox.appendChild(innerField)
wrapped.card.appendChild(framedBox)
run1.document.activeElement = innerField
key({ key: 'z' })
const framedHalo = halosIn(wrapped.card)[0]
check('the glow lands on the bordered box the user sees, not on the padded card around it',
  framedHalo?.style.left === '20px' && framedHalo?.style.top === '8px'
  && framedHalo?.style.width === '600px' && framedHalo?.style.height === '44px',
  framedHalo ? `${framedHalo.style.left},${framedHalo.style.top} ${framedHalo.style.width}x${framedHalo.style.height}` : 'none')
check('...and it takes the visible box\'s own radius, not the wrapper\'s',
  framedHalo?.style.borderRadius === '14px',
  framedHalo?.style.borderRadius)


// The observer split: mutations for the swap test, attributes only on the root
// and on the body, where the shell declares its dark palette.
const childObs = run1.observers.find((o) => o.options?.childList)
const themeObs = run1.observers.find((o) => o.observations?.some((x) => x.options?.attributes))
check('a childList observer watches the document', !!childObs && childObs.target === run1.body)
check('it does NOT watch attributes', childObs && childObs.options.attributes !== true)
check('a separate observer watches the theme attribute on the root',
  !!themeObs && themeObs.observations.some((x) => x.target === run1.html))
check('and on the body, where body[data-ds-dark-theme] actually lands',
  !!themeObs && themeObs.observations.some((x) => x.target === run1.body
    && (x.options.attributeFilter || []).includes('data-ds-dark-theme')))
check('the theme observer stays off the subtree',
  themeObs && themeObs.observations.every((x) => x.options.subtree !== true))
check('one slow interval drives the document scans', run1.intervals.length === 1 && run1.intervals[0].ms === 1500,
  run1.intervals.map((i) => i.ms).join(','))

// ---- the hot path budget, which is what "跟手" reduced to ----------------

rectCalls = 0
const flood = []
for (let i = 0; i < 60; i += 1) {
  const leaf = new Node('div')
  leaf.rect = { width: 1200, height: 700, right: 1200, top: 0, left: 0 }
  run1.body.appendChild(leaf)
  flood.push({ type: 'childList', addedNodes: [leaf] })
}
childObs.fn(flood)
check('a 60-record mutation flood costs ZERO geometry reads in the callback', rectCalls === 0, rectCalls)
flushTimers(run1)
check('...and the deferred pass measures nothing for leaves', rectCalls === 0, rectCalls)

rectCalls = 0
const panelFlood = []
for (let i = 0; i < 20; i += 1) panelFlood.push({ type: 'childList', addedNodes: [panelLike(run1)] })
childObs.fn(panelFlood)
check('collecting 20 panel candidates still reads no geometry', rectCalls === 0, rectCalls)
check('the candidates are collected AND a deferred pass is scheduled',
  run1.sandbox.__DSH_AMBIENT_FX__.state().panels === 12 && run1.timers.some((t) => t.fn),
  JSON.stringify(run1.sandbox.__DSH_AMBIENT_FX__.state()))
flushTimers(run1)
check('the deferred pass is bounded to 6 probes', rectCalls <= 6, rectCalls)
check('a panel-sized swap still fires the veil', !!run1.document.getElementById('afx-veil'))

// A theme flip is noticed through the attribute observer, not by polling.
run1.html.classList.add('afx-light')
themeObs.fn([{ type: 'attributes' }])
check('the attribute observer re-applies the theme', true)

const before = run1.windowListeners.length
run1.sandbox.__DSH_AMBIENT_FX__.stop()
check('stop() removes the layer', run1.document.getElementById('afx-layer') === null)
check('stop() removes the behind layer', run1.document.getElementById('afx-behind') === null)
check('stop() removes the stylesheet', run1.document.getElementById('afx-style') === null)
check('stop() unarms every listener', run1.windowListeners.length === 0, `${before} -> ${run1.windowListeners.length}`)
check('stop() clears the interval', run1.clearedIntervals.length === 1, run1.clearedIntervals.length)
check('stop() disconnects both observers', run1.observers.every((o) => o.disconnected))
check('stop() clears the theme classes', !run1.html.classList.contains('afx-still') && !run1.html.classList.contains('afx-light'))
check('stop() reports itself inactive', run1.sandbox.__DSH_AMBIENT_FX__.active === false)

// Switching every effect off must leave nothing running.
const bare = runAmbient({
  background: false, deepBackground: false, particles: 0,
  keyGlow: false, transitions: false, activeRow: false,
})
check('an all-off config mounts no behind layer', bare.document.getElementById('afx-behind') === null)
check('...and arms no effect listener (only the one-shot report probe)',
  bare.windowListeners.length === 1 && bare.windowListeners[0].type === 'focusin',
  bare.windowListeners.map((l) => l.type).join(',') || 'none')
check('...and builds no observers', bare.observers.length === 0, bare.observers.length)

// Reduced motion is honoured as a static ambience, not as "nothing".
const still = runAmbient({ particles: 2 }, { reducedMotion: true })
check('reduced motion is detected', still.sandbox.__DSH_AMBIENT_FX__.reducedMotion === true)
check('reduced motion freezes the animations', still.html.classList.contains('afx-still'))
check('reduced motion still draws the ambience', !!still.document.getElementById('afx-layer'))
check('reduced motion skips the swap test entirely',
  still.observers.some((o) => o.options?.childList) === false)

// The active-row marker.
const row = new Node('a')
row.rect = { width: 200, height: 32, right: 240, top: 100, left: 8 }
const rows = runAmbient({}, { activeRowCandidate: row })
check('the selected session row is marked', row.classList.contains('afx-active-row'))
rows.sandbox.__DSH_AMBIENT_FX__.stop()
check('stop() unmarks the row', !row.classList.contains('afx-active-row'))

// The deep layer needs the frame transparent - and ONLY on a dark frame.
function frameCandidate() {
  const node = new Node('div')
  node.rect = { width: 1440, height: 900, right: 1440, top: 0, left: 0 }
  return node
}

const darkFrame = frameCandidate()
const darkRun = runAmbient({ particles: 1 }, { frameCandidate: darkFrame })
check('a dark full-viewport frame is made transparent for the deep layer',
  darkFrame.style.getPropertyValue('background-color') === 'transparent',
  darkFrame.style.getPropertyValue('background-color') || '(unset)')
darkRun.sandbox.__DSH_AMBIENT_FX__.stop()
check('stop() puts the frame background back',
  darkFrame.style.getPropertyValue('background-color') === '')

// A light frame is cleared too - the gradient behind it is the pale one, which
// is what stops a light profile from staying flat white. (It used to be left
// alone, on the theory that only a dark gradient could be unreadable; the real
// fix is a theme-aware gradient, not a refusal.)
const lightFrame = frameCandidate()
const lightRun = runAmbient({ particles: 1 }, { dark: false, frameCandidate: lightFrame })
check('a light full-viewport frame is also made transparent',
  lightFrame.style.getPropertyValue('background-color') === 'transparent',
  lightFrame.style.getPropertyValue('background-color') || '(unset)')
check('the light treatment is marked on the root', lightRun.html.classList.contains('afx-light'))
const lightCss = String(lightRun.document.getElementById('afx-style').textContent || '')
check('a pale sea gradient exists for the light treatment',
  lightCss.includes('html.afx-light #afx-behind{background:linear-gradient'))
lightRun.sandbox.__DSH_AMBIENT_FX__.stop()
check('stop() restores a light frame too',
  lightFrame.style.getPropertyValue('background-color') === '',
  lightFrame.style.getPropertyValue('background-color') || '(restored)')

const noDeepFrame = frameCandidate()
runAmbient({ particles: 1, deepBackground: false }, { frameCandidate: noDeepFrame })
check('deepBackground:false never touches the frame',
  noDeepFrame.style.getPropertyValue('background-color') === '')

// The boot overlay's exact shape: fixed, full viewport, opaque, maximum z-index.
// If the ambience ever repainted that, the boot screen itself would look wrong -
// so this is asserted rather than argued.
function styledFrame(computed) {
  const node = new Node('div')
  node.rect = { width: 1440, height: 900, right: 1440, top: 0, left: 0 }
  node.computed = { backgroundImage: 'none', getPropertyValue: () => '', ...computed }
  return node
}

const fixedFrame = styledFrame({ position: 'fixed', zIndex: '2147483647', backgroundColor: 'rgb(8, 16, 24)' })
runAmbient({ particles: 1 }, { frameCandidate: fixedFrame })
check('a fixed full-viewport layer (the boot overlay) is never repainted',
  fixedFrame.style.getPropertyValue('background-color') === '',
  fixedFrame.style.getPropertyValue('background-color') || '(untouched)')

const raisedFrame = styledFrame({ position: 'static', zIndex: '40', backgroundColor: 'rgb(8, 16, 24)' })
runAmbient({ particles: 1 }, { frameCandidate: raisedFrame })
check('a raised-z-index layer (a modal or scrim) is never repainted',
  raisedFrame.style.getPropertyValue('background-color') === '',
  raisedFrame.style.getPropertyValue('background-color') || '(untouched)')

// --- the light and dark treatments, which must differ from each other --------

const daylight = runAmbient({ particles: 1 })
check('the light treatment has an element of its own',
  daylight.document.getElementById('afx-layer').childNodes.some((n) => n.className === 'afx-daylight'))
check('...with a light-only rule', cssText.includes('html.afx-light #afx-layer .afx-daylight'))
check('the light water starts on the colour the native caption plate carries',
  cssText.includes('html.afx-light #afx-behind{background:linear-gradient(172deg,#cdddf0'))
check('the two themes do not share one background',
  cssText.includes('html.afx-light #afx-behind{background:linear-gradient(172deg')
  && cssText.includes('background:linear-gradient(180deg,#03101d'))
check('the light tint is its own gradient, not the dark one at low opacity',
  cssText.includes('html.afx-light #afx-layer .afx-tint{mix-blend-mode:multiply')
  && cssText.includes('rgba(126,150,208,.34)'))
check('the light layer masks out the titlebar strip so the native plate has no seam',
  cssText.includes('html.afx-light #afx-layer{-webkit-mask-image:linear-gradient(to bottom,transparent 0,transparent var(--dsh-windows-titlebar-height'))
check('the skylight is strong enough to actually read as light',
  cssText.includes('html.afx-light #afx-layer .afx-daylight{opacity:.70}'))
check('...and its warm part stays a pinch at the very top, so the blue survives',
  cssText.includes('radial-gradient(36% 18% at 30% 0%,rgba(255,246,226,.60)')
  && !cssText.includes('rgba(255,252,244'))
check('...with a directional band, not just a flat top wash',
  cssText.includes('linear-gradient(203deg,rgba(255,255,255,.40)'))

// body[data-ds-dark-theme] is the shell's own marker: it must win even when the
// measured colour says light, or a live theme switch would apply the wrong one.
const marked = runAmbient({ particles: 1 }, { dark: false, darkAttribute: true })
check("the shell's dark marker beats a light measurement", !marked.html.classList.contains('afx-light'))

// Nothing measurable: guess light. A pale sea under dark text stays readable; a
// dark one does not, so the guess goes in the safe direction.
const blind = runAmbient({ particles: 1 }, { unmeasurable: true })
check('an unmeasurable theme falls back to the safe (light) treatment',
  blind.html.classList.contains('afx-light'))

// The light frame needs no plate at all: the shell reports the same resolved
// token to Windows as the colour its own title strip paints, so the seam the
// plate exists to hide does not exist here - and the plate's fade band spilling
// below the caption into the toolbar row is the dark smudge that was reported.
const lightNative = runAmbient({ particles: 1 }, { dark: false, windowsTitlebar: true })
check('a light desktop window gets no plate - nothing to hide',
  lightNative.document.getElementById('afx-wco') === null)

// --- the native caption plate, for the window whose buttons Windows paints ---
//
// In the desktop app the three buttons are not page elements: Windows paints them
// and their plate takes --dsw-specific-sidebar-fill. clearFrame() makes the 40px
// title strip transparent, so without a matching plate that solid rectangle sits
// on the ambient gradient as a cut-out with a lit corner - the reported defect.

const srcText = readFileSync(join(root, 'src', 'ambient.js'), 'utf8')

const plainWindow = runAmbient({ particles: 1 })
check('a page without the native titlebar gets no plate',
  plainWindow.document.getElementById('afx-wco') === null)

const overlayStub = { visible: true, getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1290, height: 40 }) }
const native = runAmbient({ particles: 1 }, { windowsTitlebar: true, controlsOverlay: overlayStub })
const plate = native.document.getElementById('afx-wco')
check('the desktop window gets a plate for the caption buttons', !!plate)
check('...sized from the overlay geometry, not from a guess',
  plate?.style.getPropertyValue('--afx-wco-w') === '150px'
  && plate?.style.getPropertyValue('--afx-wco-h') === '40px',
  `${plate?.style.getPropertyValue('--afx-wco-w')} x ${plate?.style.getPropertyValue('--afx-wco-h')}`)
check('...painted in the very colour the shell hands Windows',
  plate?.style.getPropertyValue('--afx-wco-color') === 'rgb(8, 16, 24)',
  plate?.style.getPropertyValue('--afx-wco-color'))
check("...as the root's last child, so it covers the tint instead of being tinted",
  native.body.childNodes[native.body.childNodes.length - 1]?.id === 'afx-wco')
check('...never taking the pointer',
  cssText.includes('#afx-wco{position:fixed;top:0;right:0;pointer-events:none'))
check('...feathered outside the native plate only',
  cssText.includes('var(--afx-wco-f,44px)')
  && cssText.includes('mask-composite:intersect')
  && cssText.includes('#000 0 calc(100% - var(--afx-wco-f,44px))'))
check('...with a wide, cool fade instead of a short neutral one',
  cssText.includes('var(--afx-wco-fade,26px)')
  && cssText.includes('var(--afx-wco-tint,rgba(46,78,92,0))')
  && cssText.includes('var(--afx-wco-color,#1b1b1c) var(--afx-wco-fade-end,44px)'))
check('...and the feather width is a single tunable constant',
  plate?.style.getPropertyValue('--afx-wco-f') === '44px'
  && plate?.style.getPropertyValue('--afx-wco-fade-end') === '44px'
  && plate?.style.getPropertyValue('--afx-wco-fade') === '26px',
  [plate?.style.getPropertyValue('--afx-wco-f'),
   plate?.style.getPropertyValue('--afx-wco-fade'),
   plate?.style.getPropertyValue('--afx-wco-fade-end')].join(' / '))
check('the plate is gated on the shell own windows marker',
  srcText.includes("hasAttribute('data-windows-titlebar')"))
check('the plate yields to the light frame, where there is no seam to hide',
  /var light = isLightTheme\(\)[\s\S]{0,160}if \(!info \|\| light\)/.test(srcText))
check('the fill is read through the shell sidebar token, like the shell probe',
  srcText.includes('--dsw-specific-sidebar-fill'))
// The token resolves through a var() chain that is unset until the theme settles:
// it can read as rgba(0,0,0,0). Painting the plate in that colour makes it vanish,
// so a transparent read must fall back to the shell's own dark caption colour.
const transparentFill = runAmbient({ particles: 1 }, { windowsTitlebar: true, sidebarFill: 'rgba(0, 0, 0, 0)' })
const transparentPlate = transparentFill.document.getElementById('afx-wco')
check('...never painted with a fully transparent read of the token',
  transparentPlate?.style.getPropertyValue('--afx-wco-color') === '#1b1b1c',
  transparentPlate?.style.getPropertyValue('--afx-wco-color'))

const fallbackPlate = runAmbient({ particles: 1 }, { windowsTitlebar: true }).document.getElementById('afx-wco')
check('...and built without the overlay API too, on the Windows caption metric',
  fallbackPlate?.style.getPropertyValue('--afx-wco-w') === '138px'
  && fallbackPlate?.style.getPropertyValue('--afx-wco-h') === '40px',
  `${fallbackPlate?.style.getPropertyValue('--afx-wco-w')} x ${fallbackPlate?.style.getPropertyValue('--afx-wco-h')}`)
check('...gone in fullscreen, where Windows paints no buttons',
  runAmbient({ particles: 1 }, { windowsTitlebar: true, fullscreen: true }).document.getElementById('afx-wco') === null)
native.sandbox.__DSH_AMBIENT_FX__.stop()
check('...gone again on stop()', native.document.getElementById('afx-wco') === null)

// The slow tick must keep re-reading the token: the first paint can happen
// before the theme has settled, and a colour frozen at that moment would sit
// under a plate Windows later repaints in another colour.
const lateToken = runAmbient({ particles: 1 }, { windowsTitlebar: true, sidebarFill: 'rgba(0, 0, 0, 0)' })
const latePlate = lateToken.document.getElementById('afx-wco')
check('a guess is never final - the tick re-reads until the real token lands',
  latePlate?.style.getPropertyValue('--afx-wco-color') === '#1b1b1c'
  && lateToken.intervals.length === 1,
  `${latePlate?.style.getPropertyValue('--afx-wco-color')} / ${lateToken.intervals.length} interval(s)`)
lateToken.body.computed = { backgroundColor: 'rgb(19, 32, 41)', backgroundImage: 'none', position: 'static', zIndex: 'auto', getPropertyValue: () => '' }
// The probe is a fresh span with no `computed` of its own - it must resolve to
// the body's now-settled token, not the sandbox default. The plate node keeps
// its own stub (a real element carries computed styles), so route the probe by
// tag instead: give the default branch a per-node lookup the probe can hit.
lateToken.sandbox.getComputedStyle = (node) => node?.computed ?? {
  backgroundColor: 'rgb(19, 32, 41)', backgroundImage: 'none', position: 'static', zIndex: 'auto', getPropertyValue: () => '',
}
lateToken.intervals[0].fn()
check('...and once it does, the plate follows it',
  latePlate?.style.getPropertyValue('--afx-wco-color') === 'rgb(19, 32, 41)',
  latePlate?.style.getPropertyValue('--afx-wco-color'))

// --- the structural report, which is how a wrong fit gets fixed for real -----

function makeEditor() {
  const field = new Node('textarea')
  field.rect = { width: 560, height: 24, right: 680, top: 488, left: 120 }
  field.computed = {
    backgroundColor: 'transparent', backgroundImage: 'none', borderTopWidth: '0px',
    borderRadius: '0px', position: 'static', zIndex: 'auto', getPropertyValue: () => '',
  }
  return field
}

const reporter = runAmbient({ particles: 1 }, { editable: makeEditor() })
check('nothing is sent before the scan fires', reporter.fetchCalls.length === 0, reporter.fetchCalls.length)
flushTimers(reporter)
const sent = reporter.fetchCalls[0]
check('a load with an editor reports its structure, with no interaction',
  !!sent && String(sent.url).includes('/plugins/dsh-deepwater/report'), sent?.url)
const payload = sent ? JSON.parse(sent.options.body) : null
check('the report starts at the editor itself',
  payload?.chain?.[0]?.tag === 'textarea' && payload.chain.length >= 1,
  JSON.stringify(payload?.chain?.[0] ?? null))
check('...carries the box the plugin chose', !!payload?.chosen, JSON.stringify(payload?.chosen ?? null))
check('...and the coordinate environment, for the next time it is wrong',
  !!payload?.env && typeof payload.env.scrollY === 'number' && typeof payload.env.dpr === 'number',
  JSON.stringify(payload?.env ?? null))
check('...including where the caption plate is, and the colour it was given',
  payload?.env !== undefined && 'wco' in payload.env,
  String(payload?.env?.wco))
check('...and the fit verdict per level', typeof payload?.chain?.[0]?.fits === 'number')
check('...with no user content in it',
  sent ? !/"(value|text|innerText|textContent)"/.test(sent.options.body) : false)
check('the manual trigger works too',
  reporter.sandbox.__DSH_AMBIENT_FX__.report() === true && reporter.fetchCalls.length === 2,
  reporter.fetchCalls.length)

const noEditor = runAmbient({ particles: 1 })
check('no editor on the page means no report at all',
  noEditor.sandbox.__DSH_AMBIENT_FX__.report() === false && noEditor.fetchCalls.length === 0)

const quiet = runAmbient({ particles: 1, diagnostics: false }, { editable: makeEditor() })
flushTimers(quiet)
check('diagnostics:false silences the channel entirely',
  quiet.sandbox.__DSH_AMBIENT_FX__.report() === false && quiet.fetchCalls.length === 0,
  quiet.fetchCalls.length)

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed}/${passed + failed} checks`)
process.exit(failed === 0 ? 0 : 1)
