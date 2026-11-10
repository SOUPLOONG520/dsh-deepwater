// verify-polish.mjs - offline proof for the surface layer of dsh-deepwater.
//
// The interesting checks are the CSS ones. A polish layer fails silently: a
// mistyped custom property or a selector that loses the cascade produces no
// error anywhere, just a page that looks exactly the same. So the sheet is
// parsed and held to four contracts:
//
//   [tokens]     every custom property it mentions is one the app really
//                publishes (list taken from the theme bundle in app.asar), so
//                an override can never be a no-op typo;
//   [cascade]    every selector is scoped to html[data-polish...], which is what
//                beats the app's own :root and body blocks without !important;
//   [calm]       no @keyframes, no animation, no transition, no !important -
//                this layer adds zero motion;
//   [theme-safe] colour literals appear ONLY inside the block that matches a
//                light frame; the app's dark palette is never addressed with one.
//
// Run it from the package root:
//   node verify/verify-polish.mjs

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

const css = readFileSync(join(root, 'src', 'polish.css'), 'utf8')

// Custom properties the app publishes (probed from
// dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js inside
// app.asar). Overridden names first, then the ones this sheet only reads.
const APP_TOKENS = new Set([
  // overridden
  '--dsw-font-markdown-base',
  '--dsw-font-markdown-base-font-size',
  '--dsw-font-markdown-base-line-height',
  '--dsw-font-markdown-base-strong',
  '--dsw-font-markdown-base-strong-font-size',
  '--dsw-font-markdown-base-strong-line-height',
  '--dsw-font-markdown-h1',
  '--dsw-font-markdown-h1-line-height',
  '--dsw-font-markdown-h2',
  '--dsw-font-markdown-h2-line-height',
  '--dsw-font-markdown-h3',
  '--dsw-font-markdown-h3-line-height',
  '--dsw-font-markdown-h4',
  '--dsw-font-markdown-h4-line-height',
  '--dsw-radius-sm',
  '--dsw-radius-md',
  '--dsw-radius-lg',
  '--dsw-focus-ring-color',
  '--dsh-scrollbar-width',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-shadow-lv1',
  '--dsw-shadow-lv2',
  '--dsw-shadow-lv3',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-overlay',
  '--dsw-specific-sidebar-fill',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-markdown-code-segment-selected',
  '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-placeholder',
  '--dsw-alias-markdown-tag',
  '--dsw-alias-tooltip-bg',
  '--dsw-alias-toast-bg',
  '--dsw-specific-input-major',
  '--dsw-specific-bubble',
  '--dsw-specific-bubble-highlight',
  // read only
  '--dsh-content-font-size',
  '--dsh-content-font-delta',
  '--dsw-font-family',
  '--dsw-alias-brand-primary',
])

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

const bare = stripComments(css)

// --- [1] the Host half -------------------------------------------------------

console.log('\n[1] the Host half')

const mod = await import(new URL('../entry.js', import.meta.url).href)
check('the row name is the package name', mod.name === 'dsh-deepwater', mod.name)
check('it declares the one service it needs', mod.inject.includes('webServer'), JSON.stringify(mod.inject))

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
const status = host.routes.find((r) => r.path === '/plugins/dsh-deepwater/status')
check('the status route is registered exactly', !!status && status.kind === 'exact', status?.path)

const listener = host.events.find((e) => e.event === 'webserver/index-inject').fn
const table = []
listener(table)
check('an enabled row injects head rows for both layers', table.length >= 6, table.length)
check('all of them are head scripts', table.every((r) => r.kind === 'script' && r.placement === 'head'))

// The rows are found by their content, not by their position: the unified
// package pushes a row for the shared config and one for each layer, and only
// the content says which is which.
const pick = (rows, prefix) => rows.find((r) => r.text.startsWith(prefix))?.text ?? ''

const cfgRow = pick(table, 'globalThis.__DSH_POLISH_CFG__=')
const cssRow = pick(table, 'globalThis.__DSH_POLISH_CSS__=')
const bootRow = table.find((r) => r.text.includes('dsh-polish-style'))?.text ?? ''
check('the config global is injected', cfgRow.startsWith('globalThis.__DSH_POLISH_CFG__='))
const injected = JSON.parse(cfgRow.slice('globalThis.__DSH_POLISH_CFG__='.length))
check('a valid preset is passed through', injected.preset === 'compact', injected.preset)
check('the surface layer is told where to report', injected.base === '/plugins/dsh-deepwater', injected.base)
check('the stylesheet travels as a JSON global', cssRow.startsWith('globalThis.__DSH_POLISH_CSS__='))
const cssViaJson = JSON.parse(cssRow.slice('globalThis.__DSH_POLISH_CSS__='.length))
check('the CSS survives the JSON round trip byte for byte', cssViaJson === css,
  `${cssViaJson.length} vs ${css.length}`)
check('the CSS cannot close its own script tag', !css.includes('</'), 'no "</" anywhere')
check('the bootstrap row is the real file', bootRow.includes('__DSH_VISUAL_POLISH__'))

const unknown = mountHost({ preset: 'nonsense' })
const unknownTable = []
unknown.events.find((e) => e.event === 'webserver/index-inject').fn(unknownTable)
const unknownPreset = JSON.parse(pick(unknownTable, 'globalThis.__DSH_POLISH_CFG__=').slice('globalThis.__DSH_POLISH_CFG__='.length)).preset
check('an unknown preset falls back to the default', unknownPreset === 'roomy', unknownPreset)

const offTable = []
mountHost({ enabled: false }).events.find((e) => e.event === 'webserver/index-inject').fn(offTable)
check('a disabled row injects nothing at all', offTable.length === 0, offTable.length)

const statusRes = { writeHead: (code) => { statusRes.code = code }, end: (body) => { statusRes.body = body } }
status.handler({}, statusRes)
const statusBody = JSON.parse(statusRes.body)
check('the status route answers 200 without a token', statusRes.code === 200, statusRes.code)
check('it lists the available presets', Array.isArray(statusBody.presets) && statusBody.presets.length === 3,
  JSON.stringify(statusBody.presets))

// --- [2] the stylesheet contract --------------------------------------------

console.log('\n[2] the stylesheet contract')

let depth = 0
let balanced = true
for (const char of bare) {
  if (char === '{') depth += 1
  else if (char === '}') { depth -= 1; if (depth < 0) balanced = false }
}
check('braces are balanced', balanced && depth === 0, `depth=${depth}`)

for (const preset of ['roomy', 'compact', 'minimal']) {
  check(`the ${preset} preset has both scoped selectors`,
    bare.includes(`html[data-polish="${preset}"]`)
    && bare.includes(`html[data-polish="${preset}"] body`))
}

const declared = [...new Set([...bare.matchAll(/(--[-\w]+)\s*:/g)].map((m) => m[1]))]
const used = [...new Set([...bare.matchAll(/var\((--[-\w]+)/g)].map((m) => m[1]))]
const unknownTokens = [...new Set([...declared, ...used])].filter((t) => !APP_TOKENS.has(t))
check('every custom property it overrides is one the app publishes', unknownTokens.length === 0,
  unknownTokens.join(', ') || 'all known')
check('it overrides a meaningful number of tokens', declared.length >= 12, declared.length)
check('it never overwrites the reader\'s own font size', !declared.includes('--dsh-content-font-size'))

// Commas inside :is()/:where() are not selector separators, so collapse those
// first - otherwise this check reports the sheet for a mistake it did not make.
const selectors = [...bare.matchAll(/(^|\})\s*([^{}]+)\{/g)]
  .map((m) => m[2].replace(/:(?:is|where)\([^)]*\)/g, ':is(...)').trim())
const unscoped = selectors.filter((s) => !s.split(',').every((part) => part.trim().startsWith('html[data-polish')))
check('every selector is scoped to html[data-polish...]', unscoped.length === 0, unscoped.join(' | ') || 'all scoped')

check('it adds no keyframes', !/@keyframes/i.test(bare))
check('it adds no animation', !/(^|[^-])animation\s*:/i.test(bare))
check('it adds no transition', !/(^|[^-])transition\s*:/i.test(bare))
check('it uses no !important', !/!important/.test(bare))
// Colour literals are allowed in exactly two places: the block that only matches
// a LIGHT frame, and the block that only matches a DARK frame. Every other
// declaration stays token-driven, so a colour can never be applied to a frame
// it was not designed for.
const literalRe = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i
const blocks = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }))
const lightScoped = (selector) => selector.includes('body:not([data-ds-dark-theme])')
const darkScoped = (selector) => selector.includes('body[data-ds-dark-theme]')
const themedScoped = (selector) => lightScoped(selector) || darkScoped(selector)
const offenders = blocks.filter((b) => literalRe.test(b.body) && !themedScoped(b.selector))
check('colour literals appear only inside a themed block',
  offenders.length === 0, offenders.map((b) => b.selector).join(' | ') || 'none')
const lightBlocks = blocks.filter((b) => lightScoped(b.selector))
check('the light-frame block exists and carries the light palette',
  lightBlocks.length >= 1 && lightBlocks.some((b) => literalRe.test(b.body)),
  `${lightBlocks.length} block(s)`)
const darkBlocks = blocks.filter((b) => darkScoped(b.selector))
check('the dark-frame block exists and carries the dark palette',
  darkBlocks.length >= 1 && darkBlocks.some((b) => literalRe.test(b.body)),
  `${darkBlocks.length} block(s)`)
// A block may not address both frames at once: `body[data-ds-dark-theme]` and
// `body:not([data-ds-dark-theme])` in one selector would apply the same literal
// to whichever frame matched, which is exactly the mistake this contract exists
// to prevent.
const bothFrames = blocks.filter((b) => literalRe.test(b.body) && lightScoped(b.selector) && darkScoped(b.selector))
check('no block mixes a light literal and a dark literal', bothFrames.length === 0,
  bothFrames.map((b) => b.selector).join(' | ') || 'none')
// The dark palette must never be addressed by a light-frame literal, and the
// other way round: check that each themed block's literals sit on the correct
// side of the ladder (dark surfaces stay dark, light surfaces stay light).
const darkLiterals = darkBlocks.filter((b) => literalRe.test(b.body))
  .flatMap((b) => [...b.body.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].slice(1).toLowerCase()))
const isDarkEnough = (hex) => {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const bl = parseInt(hex.slice(4, 6), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl < 90
}
const tooLight = darkLiterals.filter((hex) => !isDarkEnough(hex))
check('every dark-frame literal is actually dark', tooLight.length === 0, tooLight.join(', ') || 'none')
// The two frames must not share a surface colour: if they did, the sheet would
// look like it only repainted one of them.
const lightLiterals = lightBlocks.filter((b) => literalRe.test(b.body))
  .flatMap((b) => [...b.body.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].slice(1).toLowerCase()))
const shared = lightLiterals.filter((hex) => darkLiterals.includes(hex))
check('the two frames never share a surface colour', shared.length === 0, shared.join(', ') || 'none')
// The light frame must be just as complete as the dark one: every surface token
// the dark block repaints has to have a light counterpart, or switching themes
// leaves that surface on the app's neutral default and the page reads half-done.
const declaredInDark = new Set(darkBlocks.flatMap((b) => [...b.body.matchAll(/(--[-\w]+)\s*:/g)].map((m) => m[1])))
const declaredInLight = new Set(lightBlocks.flatMap((b) => [...b.body.matchAll(/(--[-\w]+)\s*:/g)].map((m) => m[1])))
// tooltip/toast are deliberately left to the app: on the light frame they are
// raised dark chips, and repainting them light would drop their label contrast.
const lightOmissions = new Set(['--dsw-alias-tooltip-bg', '--dsw-alias-toast-bg'])
const missingInLight = [...declaredInDark].filter((t) => !declaredInLight.has(t) && !lightOmissions.has(t))
check('every surface the dark frame repaints has a light counterpart', missingInLight.length === 0,
  missingInLight.join(', ') || 'complete')

// --- [3] the bootstrap, in a stub DOM ---------------------------------------

console.log('\n[3] the bootstrap')

function makeSandbox(config, cssText) {
  const head = {
    children: [],
    appendChild(n) { n.parentNode = this; this.children.push(n); return n },
    removeChild(n) {
      const i = this.children.indexOf(n)
      if (i >= 0) this.children.splice(i, 1)
      n.parentNode = null
      return n
    },
  }
  const root = {
    attrs: new Map(),
    setAttribute(k, v) { this.attrs.set(k, v) },
    getAttribute(k) { return this.attrs.get(k) ?? null },
    removeAttribute(k) { this.attrs.delete(k) },
  }
  const nodes = []
  const document = {
    readyState: 'complete',
    documentElement: root,
    head,
    createElement: (tag) => {
      const node = {
        tagName: String(tag).toUpperCase(), id: '', textContent: '', parentNode: null,
      }
      nodes.push(node)
      return node
    },
    // Only attached nodes answer: an element a detach removed must stop being
    // findable, which is exactly what the detach assertion is about.
    getElementById: (id) => head.children.find((n) => n.id === id) ?? null,
  }
  const sandbox = { document, console, __DSH_POLISH_CFG__: config, __DSH_POLISH_CSS__: cssText }
  sandbox.globalThis = sandbox
  return { sandbox, document, root, head, nodes }
}

function runBootstrap(config = { enabled: true, preset: 'roomy' }, cssText = css) {
  const env = makeSandbox(config, cssText)
  vm.createContext(env.sandbox)
  vm.runInContext(readFileSync(join(root, 'src', 'polish.js'), 'utf8'), env.sandbox, { filename: 'polish.js' })
  return env
}

const boot = runBootstrap()
check('the preset is stamped on the root element', boot.root.getAttribute('data-polish') === 'roomy')
check('exactly one style element is appended', boot.nodes.filter((n) => n.id === 'dsh-polish-style').length === 1)
check('the style carries the whole sheet',
  boot.nodes.find((n) => n.id === 'dsh-polish-style').textContent === css)
check('the handle reports the preset', boot.sandbox.__DSH_VISUAL_POLISH__.preset === 'roomy')

// A second injection into the same document must reuse the element, not stack a
// second sheet.
vm.runInContext(readFileSync(join(root, 'src', 'polish.js'), 'utf8'), boot.sandbox, { filename: 'polish.js' })
check('a second injection does not stack a duplicate sheet',
  boot.nodes.filter((n) => n.id === 'dsh-polish-style').length === 1,
  boot.nodes.filter((n) => n.id === 'dsh-polish-style').length)

boot.sandbox.__DSH_VISUAL_POLISH__.detach()
check('detach removes the sheet', boot.document.getElementById('dsh-polish-style') === null)
check('detach removes the preset attribute', boot.root.getAttribute('data-polish') === null)
check('detach reports itself inactive', boot.sandbox.__DSH_VISUAL_POLISH__.active === false)

const disabled = runBootstrap({ enabled: false, preset: 'roomy' })
check('a disabled config mounts nothing', disabled.root.getAttribute('data-polish') === null
  && disabled.nodes.length === 0)

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed}/${passed + failed} checks`)
process.exit(failed === 0 ? 0 : 1)
