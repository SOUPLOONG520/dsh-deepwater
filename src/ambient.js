/*
 * dsh-ambient-fx - the in-app ambience, as framework-free text.
 *
 * Injected into <head> ahead of the shell, so it runs before the app exists and
 * may never touch the app's own tree: everything it draws lives under two fixed
 * layers of its own, both pointer-events:none, so the shell stays fully
 * clickable. The one-shot effects are single detached elements that remove
 * themselves.
 *
 * Stacking, which is the one thing that has to be right:
 *   #afx-behind  z-index -1   the deep-sea gradient, visible only where the
 *                             frame's own background has been made transparent
 *   #afx-layer   z-index  1   the tint, the drifting blobs and the vignette
 *   #afx-veil    z-index  2   the one-shot dissolve on a panel swap
 * The kernel boot page and the boot-animation overlay (z-index 2147483647) both
 * paint above all of that, so the boot screen is never disturbed; modals and
 * popovers in the app carry z-index >= 10 and stay above the tint as well.
 *
 * NOTHING IN AN INPUT PATH MAY FORCE LAYOUT.
 *
 * This runs inside the same renderer as the app, so a synchronous layout read in
 * a hot path is felt as typing and clicking that stick to the page. Two rules
 * follow, and both are load-bearing:
 *   - no geometry is read per mutation record: candidates are COLLECTED there
 *     (an element that owns enough children to plausibly be a panel) and
 *     measured once, later, in one bounded pass - never a leaf that a streaming
 *     answer appended;
 *   - the only timers are two slow intervals, which is where the frame scan and
 *     the selected-row scan live.
 * verify/verify-ambient.mjs asserts the first rule by counting the geometry
 * reads a 60-record mutation flood is allowed to cause.
 *
 * Cost is spent on compositing instead: the tint is static, the blobs animate
 * only `transform` and carry no blur and no blend mode, and blending is left to
 * the two static full-window layers that can be composited once.
 *
 * Theme: the tint blends `screen` over a dark frame and `multiply` over a light
 * one, decided from the shell's own `--dsw-alias-bg-base` token, so a light
 * profile gets a wash instead of a wash-out.
 *
 * Every effect is gated by one field of __DSH_AMBIENT_FX_CFG__ and every
 * listener, timer and node is removable. globalThis.__DSH_AMBIENT_FX__.stop()
 * puts the document back the way it was found, which is also how a misbehaving
 * effect is killed from the console without editing any file.
 */
;(function () {
  'use strict'

  var CFG = (globalThis && globalThis.__DSH_AMBIENT_FX_CFG__) || {}
  if (CFG.enabled === false) return
  if (globalThis.__DSH_AMBIENT_FX__ && globalThis.__DSH_AMBIENT_FX__.active) return

  var LAYER_ID = 'afx-layer'
  var BEHIND_ID = 'afx-behind'
  var STYLE_ID = 'afx-style'
  var VEIL_ID = 'afx-veil'
  var WCO_ID = 'afx-wco'

  // A node must own at least this many children before it is even a candidate
  // for the panel-swap test: a leaf the transcript appended can never be one,
  // and this is what keeps a streaming answer from costing a measurement.
  var PANEL_MIN_CHILDREN = 6
  // Hard ceiling on geometry reads in one deferred pass.
  var MAX_PANEL_PROBES = 6
  // How many candidates may pile up between two passes.
  var MAX_PANEL_CANDIDATES = 12
  // Hard ceiling on geometry reads in one selected-row scan.
  var MAX_ROW_PROBES = 8
  // The slow tick: selected row, then the frame scan, both bounded.
  var TICK_MS = 1500
  var MAX_FRAME_SCANS = 40

  function clamp(value, fallback, lo, hi) {
    return typeof value === 'number' && isFinite(value) ? Math.max(lo, Math.min(hi, value)) : fallback
  }

  var F = {
    background: CFG.background !== false,
    deepBackground: CFG.deepBackground !== false,
    particles: Math.round(clamp(CFG.particles, 6, 0, 40)),
    glow: clamp(CFG.glow, 0.45, 0, 1),
    keyGlow: CFG.keyGlow !== false,
    transitions: CFG.transitions !== false,
    activeRow: CFG.activeRow !== false,
    diagnostics: CFG.diagnostics !== false,
  }

  // Where the Host half listens for the structural report.
  var ROUTE = typeof CFG.base === 'string' && CFG.base ? CFG.base : '/plugins/dsh-deepwater'

  // Honour the OS switch unless the profile explicitly opts out: a static
  // ambience is the whole point of respecting it.
  var reduce = false
  try {
    reduce = CFG.respectReducedMotion !== false
      && !!globalThis.matchMedia
      && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (error) {
    reduce = false
  }

  var layer = null
  var behind = null
  var veil = null
  var childObserver = null
  var themeObserver = null
  var tickTimer = null
  var listeners = []
  var cleared = []
  var activeRowEl = null
  var lastPointer = null
  // The two decorative nodes that are allowed to exist at once: the glow on the
  // focused box, and the pointer dot used when nothing is focused.
  var activeGlow = null
  var activeDot = null
  var pendingPanels = []
  var measureScheduled = false
  var lastVeil = 0
  var frameScans = 0
  var stopped = false
  var wcoMat = null
  var wcoFill = ''
  // True once the app's own token has been read. Until then the plate colour is
  // a guess, and a guess must not be frozen into the plate: the token can land
  // after the first paint.
  var wcoFillResolved = false
  // Width of the fade that carries the native plate colour into the ambient
  // gradient. Bigger = softer; the solid core still hides under the plate.
  var WCO_FEATHER = 44

  function now() { return Date.now() }

  function schedule(fn) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      try { return globalThis.requestAnimationFrame(fn) } catch (error) { /* fall through */ }
    }
    return globalThis.setTimeout(fn, 16)
  }

  function el(tag, id, cls) {
    var node = document.createElement(tag)
    if (id) node.id = id
    if (cls) node.className = cls
    return node
  }

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts || false)
    listeners.push([target, type, fn, opts || false])
  }

  function root() { return document.body || document.documentElement }

  // Our own nodes must never be mistaken for app content: they are the only
  // elements the effects are allowed to measure, and any of them turning up in
  // a mutation record means the record is ours, not a panel swap.
  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false
    try {
      if (String(node.id || '').indexOf('afx-') === 0) return true
      return typeof node.className === 'string' && node.className.indexOf('afx-') >= 0
    } catch (error) {
      return false
    }
  }

  function css() {
    return [
      '#afx-behind{position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden;',
      'background:linear-gradient(180deg,#03101d 0%,#06243a 46%,#020d18 100%)}',
      '#afx-behind .afx-beam{position:absolute;left:-20%;right:-20%;top:6%;height:64%;',
      'background:radial-gradient(60% 60% at 30% 40%,rgba(64,168,224,.22),transparent 70%),',
      'radial-gradient(50% 50% at 76% 56%,rgba(70,214,206,.16),transparent 72%);',
      'animation:afx-beam 54s ease-in-out infinite alternate}',
      'html.afx-light #afx-behind{background:linear-gradient(172deg,#cdddf0 0%,#c4d9ee 34%,#bed5ec 62%,#d2e3f3 100%)}',
      'html.afx-light #afx-behind .afx-beam{opacity:.62;',
      'background:radial-gradient(58% 58% at 28% 32%,rgba(96,196,232,.20),transparent 70%),',
      'radial-gradient(52% 52% at 78% 60%,rgba(112,216,196,.18),transparent 72%)}',
      '#afx-layer{position:fixed;inset:0;pointer-events:none;z-index:1;overflow:hidden}',
      '#afx-layer .afx-tint{position:absolute;inset:-15%;opacity:var(--afx-glow,.45);',
      'background:radial-gradient(58% 46% at 22% 12%,rgba(60,170,220,.50),transparent 70%),',
      'radial-gradient(44% 38% at 82% 18%,rgba(86,216,208,.36),transparent 72%),',
      'radial-gradient(70% 58% at 50% 112%,rgba(26,92,148,.50),transparent 72%);',
      'mix-blend-mode:screen}',
      'html.afx-light #afx-layer .afx-tint{mix-blend-mode:multiply;opacity:calc(var(--afx-glow,.45) * 0.55);',
      'background:radial-gradient(62% 50% at 18% 6%,rgba(86,158,220,.46),transparent 74%),',
      'radial-gradient(48% 42% at 86% 20%,rgba(78,190,200,.34),transparent 76%),',
      'radial-gradient(74% 62% at 50% 118%,rgba(126,150,208,.34),transparent 76%)}',
      // In light mode the titlebar strip must stay free of the multiply tint: the
      // native caption plate (OS-painted, untouchable) carries the polish sidebar
      // fill, and any tint on the layer behind it darkens that strip below the
      // plate's colour, producing a visible seam. The mask carves out the top
      // var(--dsh-windows-titlebar-height, 40px) so the titlebar shows raw polish
      // surfaces while the rest of the page still gets the ambient wash.
      'html.afx-light #afx-layer{-webkit-mask-image:linear-gradient(to bottom,transparent 0,transparent var(--dsh-windows-titlebar-height,40px),#000 calc(var(--dsh-windows-titlebar-height,40px) + 60px));mask-image:linear-gradient(to bottom,transparent 0,transparent var(--dsh-windows-titlebar-height,40px),#000 calc(var(--dsh-windows-titlebar-height,40px) + 60px))}',
      '#afx-layer .afx-vignette{position:absolute;inset:0;opacity:.7;mix-blend-mode:multiply;',
      'background:radial-gradient(120% 100% at 50% 45%,transparent 55%,rgba(2,10,18,.40) 100%)}',
      'html.afx-light #afx-layer .afx-vignette{opacity:.26}',
      // The light treatment's signature: a skylight from above, where the dark
      // treatment has a bottom-heavy deep glow.
      //
      // It has to be STRONG to exist at all: a pale-blue page plus a 0.34 wash of
      // near-white is a difference the eye discards - which is exactly what the
      // first version was, and what got reported as "not noticeable". What reads as
      // light is a bright core at the top edge plus one directional band; the warm
      // part stays a small pinch at the very top, because an opaque warm sweep up
      // here is what washed the blue out of the upper half before.
      '#afx-layer .afx-daylight{position:absolute;left:-14%;right:-14%;top:-22%;height:74%;opacity:0;background:radial-gradient(72% 44% at 38% 0%,rgba(255,255,255,.88),rgba(255,255,255,0) 70%),radial-gradient(92% 60% at 47% 0%,rgba(212,238,255,.72),rgba(212,238,255,0) 76%),radial-gradient(36% 18% at 30% 0%,rgba(255,246,226,.60),rgba(255,246,226,0) 78%),linear-gradient(203deg,rgba(255,255,255,.40) 0%,rgba(255,255,255,0) 32%)}',
      'html.afx-light #afx-layer .afx-daylight{opacity:.70}',
      '#afx-layer .afx-blob{position:absolute;border-radius:50%;opacity:.22;will-change:transform;',
      'animation:afx-float var(--d,64s) ease-in-out infinite alternate;animation-delay:var(--dl,0s)}',
      'html.afx-light #afx-layer .afx-blob{opacity:.14}',
      // The typing light needs almost no CSS: the node inside the card is styled
      // inline (position, radius, shadow, opacity, transition) because the theme and
      // the strength are decided per keystroke in JS. What is left here is the base
      // for the drawn fallback, and the pointer dot.
      //
      // `absolute`, not `fixed`: a transformed ancestor rewrites what a fixed box is
      // positioned against, and that mismatch is a candidate for a glow landing
      // somewhere other than where getBoundingClientRect said it should.
      '.afx-keyglow{position:absolute;pointer-events:none;z-index:1}',
      '.afx-keydot{position:fixed;pointer-events:none;z-index:1;border-radius:50%;',
      'background:radial-gradient(50% 50% at 50% 50%,rgba(120,214,255,.40),transparent 70%);',
      'animation:afx-keyglow .50s ease-out forwards}',
      // The dot is the only part of the light that lives in CSS, so its colour needs
      // the same theme split the inline shadows get in JS.
      'html.afx-light .afx-keydot{background:radial-gradient(50% 50% at 50% 50%,rgba(238,196,150,.46),transparent 70%)}',
      // The caption buttons are painted by Windows, not by the page: their plate
      // takes the shell's sidebar fill, and once clearFrame() makes the 40px title
      // strip transparent that plate lands on the ambient gradient and reads as a
      // cut-out rectangle with a lit corner. This plate carries the same fill,
      // feathered only on the left and the bottom, so the seam becomes a short fade
      // instead of a cut. Its solid core sits exactly under the native plate; the
      // mask keeps the fade outside it.
      '#afx-wco{position:fixed;top:0;right:0;pointer-events:none;z-index:1;',
      'width:calc(var(--afx-wco-w,138px) + var(--afx-wco-f,44px));',
      'height:calc(var(--afx-wco-h,40px) + var(--afx-wco-f,44px));',
      'background:var(--afx-wco-color,transparent);',
      'background-image:linear-gradient(to left,var(--afx-wco-tint,rgba(46,78,92,0)) 0,var(--afx-wco-tint-mid,rgba(40,72,88,.55)) var(--afx-wco-fade,26px),var(--afx-wco-color,#1b1b1c) var(--afx-wco-fade-end,44px));',
      '-webkit-mask-image:linear-gradient(to right,transparent 0,#000 var(--afx-wco-f,44px)),',
      'linear-gradient(to bottom,#000 0 calc(100% - var(--afx-wco-f,44px)),transparent 100%);',
      '-webkit-mask-composite:source-in;mask-composite:intersect;',
      'mask-image:linear-gradient(to right,transparent 0,#000 var(--afx-wco-f,44px)),',
      'linear-gradient(to bottom,#000 0 calc(100% - var(--afx-wco-f,44px)),transparent 100%)}',
      '#afx-veil{position:fixed;inset:0;pointer-events:none;z-index:2;',
      'background:radial-gradient(120% 100% at 50% 40%,rgba(7,26,42,.28),rgba(4,16,28,.44));',
      'animation:afx-veil .30s ease-out forwards}',
      '.afx-active-row{position:relative}',
      '.afx-active-row::before{content:"";position:absolute;left:-2px;top:50%;width:3px;height:56%;',
      'transform:translateY(-50%);border-radius:3px;',
      'background:var(--dsw-alias-brand-primary,#57b0ff);',
      'box-shadow:0 0 8px 1px rgba(87,176,255,.55);',
      'animation:afx-breathe 3.4s ease-in-out infinite}',
      // In light mode the brand glow reads as a heavy dark smudge against the pale
      // surface; soften it to a gentle tint so the indicator stays legible without
      // looking like an ink blot. The breathing animation is kept (it is calm),
      // only the colour and shadow are dialed down.
      'html.afx-light .afx-active-row::before{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#57b0ff) 42%,transparent);box-shadow:0 0 6px 0 color-mix(in srgb,var(--dsw-alias-brand-primary,#57b0ff) 22%,transparent)}',
      '@keyframes afx-beam{from{transform:translate3d(-3%,0,0)}to{transform:translate3d(4%,3%,0)}}',
      '@keyframes afx-float{from{transform:translate3d(0,0,0) scale(1)}',
      'to{transform:translate3d(var(--dx,0%),var(--dy,0%),0) scale(1.18)}}',
      '@keyframes afx-keyglow{from{opacity:.9}to{opacity:0}}',
      '@keyframes afx-veil{from{opacity:1}to{opacity:0}}',
      '@keyframes afx-breathe{0%,100%{opacity:.45;transform:translateY(-50%) scaleY(.86)}',
      '50%{opacity:1;transform:translateY(-50%) scaleY(1.06)}}',
      'html.afx-still #afx-layer *,html.afx-still #afx-behind *{animation:none !important}',
    ].join('')
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    var node = el('style', STYLE_ID)
    node.textContent = css()
    ;(document.head || document.documentElement).appendChild(node)
  }

  function blob() {
    var node = el('div', null, 'afx-blob')
    var size = 180 + Math.random() * 340
    var hue = Math.random() < 0.5 ? '86,196,236' : '74,212,204'
    node.style.width = size + 'px'
    node.style.height = size + 'px'
    node.style.left = (Math.random() * 110 - 10).toFixed(1) + '%'
    node.style.top = (Math.random() * 110 - 10).toFixed(1) + '%'
    // A soft radial falloff instead of filter:blur(). Blur on a 400px layer is
    // re-rasterised as it scales, which is exactly the kind of per-frame work
    // that makes an app feel sticky.
    node.style.background = 'radial-gradient(50% 50% at 50% 50%,rgba(' + hue + ',.45),transparent 70%)'
    node.style.setProperty('--d', (44 + Math.random() * 46).toFixed(1) + 's')
    node.style.setProperty('--dl', (-Math.random() * 40).toFixed(1) + 's')
    node.style.setProperty('--dx', (Math.random() * 14 - 7).toFixed(1) + '%')
    node.style.setProperty('--dy', (Math.random() * 12 - 6).toFixed(1) + '%')
    return node
  }

  function build() {
    if (document.getElementById(LAYER_ID)) return
    layer = el('div', LAYER_ID)
    layer.setAttribute('aria-hidden', 'true')
    layer.style.setProperty('--afx-glow', String(F.glow))
    if (F.background) {
      layer.appendChild(el('div', null, 'afx-tint'))
      layer.appendChild(el('div', null, 'afx-vignette'))
      layer.appendChild(el('div', null, 'afx-daylight'))
    }
    for (var i = 0; i < F.particles; i++) layer.appendChild(blob())
    root().appendChild(layer)

    if (F.deepBackground) {
      behind = el('div', BEHIND_ID)
      behind.setAttribute('aria-hidden', 'true')
      behind.appendChild(el('div', null, 'afx-beam'))
      root().appendChild(behind)
    }

    // The root's last child: the plate has to paint above the tint and the blobs.
    paintWco()
  }

  /**
   * The theme, read from the shell's own token first.
   *
   * `--dsw-alias-bg-base` is the colour the app actually paints, so it beats
   * sampling a background the plugin may itself have made transparent. The
   * measured body colour stays as the fallback for a shell that does not
   * publish the token.
   * @returns {boolean} true when the frame is light.
   */
  function isLightTheme() {
    // The shell's own marker first, because it is the one fact that cannot be
    // misread: the app declares its dark palette on `body[data-ds-dark-theme]`.
    // Reading the colour first meant a live theme switch could be missed.
    try {
      if (document.body && document.body.hasAttribute && document.body.hasAttribute('data-ds-dark-theme')) return false
    } catch (error) { /* no attribute support: fall through to the colour */ }

    var tokens = []
    try { tokens.push(globalThis.getComputedStyle(document.body || document.documentElement)) } catch (error) { /* skip */ }
    try { tokens.push(globalThis.getComputedStyle(document.documentElement)) } catch (error) { /* skip */ }
    for (var i = 0; i < tokens.length; i++) {
      var style = tokens[i]
      if (!style) continue
      var value = ''
      try {
        if (style.getPropertyValue) value = String(style.getPropertyValue('--dsw-alias-bg-base') || '').trim()
      } catch (error) { value = '' }
      // The token can itself be a var() reference the computed style has not
      // resolved for us; only a parseable colour is usable here.
      var fromToken = parseColor(value)
      if (fromToken) return luminanceOf(fromToken) > 0.5
      var measured = parseColor(style.backgroundColor)
      if (measured) return luminanceOf(measured) > 0.5
    }

    // Nothing measurable: assume light. A pale sea under dark text stays
    // readable; a dark one does not, so the guess is made in the safe direction.
    return true
  }

  function luminanceOf(rgb) {
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  }

  function parseColor(text) {
    var value = String(text || '').trim()
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
    if (hex) {
      var body = hex[1]
      if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
      return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)]
    }
    if (/^transparent$/i.test(value)) return null
    var fn = /rgba?\(([^)]+)\)/i.exec(value)
    if (fn) {
      var parts = fn[1].split(/[,\s/]+/)
      var out = []
      for (var i = 0; i < 3; i++) {
        var n = parseFloat(parts[i])
        if (!isFinite(n)) return null
        out.push(n)
      }
      // A fully transparent value is not a colour to paint with: the sidebar token
      // can resolve to rgba(0,0,0,0) while the theme is still settling, and a plate
      // painted in it would vanish. Reject it so the caller falls back.
      var alpha = parts.length > 3 ? parseFloat(parts[3]) : 1
      if (isFinite(alpha) && alpha < 0.02) return null
      return out
    }
    return null
  }

  /**
   * Put the frame backgrounds back. Only stop() and a theme flip to light call
   * this now: the gradient behind is theme-aware (`html.afx-light #afx-behind`
   * is a pale sea, not the dark one), so a light frame is cleared like any
   * other and dark text stays readable on it.
   */
  function restoreFrame() {
    for (var i = 0; i < cleared.length; i++) {
      try {
        cleared[i].style.removeProperty('background-color')
        cleared[i].style.removeProperty('background-image')
      } catch (error) { /* detached node */ }
    }
    cleared = []
  }

  function applyTheme() {
    var light = isLightTheme()
    try {
      document.documentElement.classList.toggle('afx-light', light)
    } catch (error) { /* nothing to set the class on */ }
    // The palette switches through CSS; the frame handling does not change with
    // it. Clearing a light frame used to be refused, which is exactly why a
    // light profile stayed flat white.
    clearFrame()
    // The plate is painted from a token, so it has to be re-read with the palette.
    if (layer) paintWco()
  }

  function isCleared(node) {

    for (var i = 0; i < cleared.length; i++) if (cleared[i] === node) return true
    return false
  }

  /**
   * Make the app frame transparent so the deep-sea gradient behind it shows.
   *
   * Conservative on purpose, because this is the only effect that writes to an
   * element the plugin does not own. It only ever touches an element that
   * covers essentially the whole viewport, is not fixed, and does not carry a
   * raised z-index - which is what keeps modals, scrims, tooltips and the boot
   * overlay out of reach. Anything it does touch is restored by stop().
   */
  function clearFrame() {
    if (!F.deepBackground || stopped || !document.body) return
    if (frameScans >= MAX_FRAME_SCANS) return
    frameScans += 1
    var vw = globalThis.innerWidth || 0
    var vh = globalThis.innerHeight || 0
    if (!vw || !vh) return
    var all = document.body.getElementsByTagName('*')
    var limit = Math.min(all.length, 500)
    for (var i = 0; i < limit; i++) {
      var node = all[i]
      if (isOurs(node) || node === layer || node === behind || isCleared(node)) continue
      var rect
      try { rect = node.getBoundingClientRect() } catch (error) { continue }
      if (!rect || rect.width < vw * 0.96 || rect.height < vh * 0.96) continue
      var computed
      try { computed = globalThis.getComputedStyle(node) } catch (error) { continue }
      if (!computed) continue
      if (computed.position === 'fixed') continue
      var z = parseInt(computed.zIndex, 10)
      if (!isNaN(z) && z >= 10) continue
      var bg = String(computed.backgroundColor || '')
      if (!bg || bg === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) continue
      try {
        node.style.setProperty('background-color', 'transparent', 'important')
        if (computed.backgroundImage && computed.backgroundImage !== 'none') {
          node.style.setProperty('background-image', 'none', 'important')
        }
      } catch (error) { continue }
      cleared.push(node)
    }
  }

  /**
   * Where Windows put the caption buttons, in CSS pixels, or null when this
   * window has no native overlay (a browser tab, a fullscreen window, the boot
   * screen).
   *
   * `data-windows-titlebar` is set by the desktop shell's own preload on the
   * windows build only, so it is the one signal a page cannot fake. The overlay
   * API refines the geometry where Chromium exposes it; 3 x 46 x 40 is the
   * Windows caption metric and stays as the fallback.
   */
  function wcoInfo() {
    var html = document.documentElement
    if (!html || typeof html.hasAttribute !== 'function' || !html.hasAttribute('data-windows-titlebar')) return null
    if (document.fullscreenElement) return null
    var vw = globalThis.innerWidth || 0
    if (!vw) return null
    var left = 0
    var width = 0
    var height = 0
    try {
      var overlay = globalThis.navigator && globalThis.navigator.windowControlsOverlay
      if (overlay && typeof overlay.getTitlebarAreaRect === 'function') {
        var area = overlay.getTitlebarAreaRect()
        if (area && area.width > 0 && area.height > 0) {
          left = area.x + area.width
          width = vw - left
          height = area.height
        }
      }
    } catch (error) { /* no overlay API: keep the caption metric */ }
    if (!(width > 0) || !(height > 0)) {
      width = 138
      height = 40
      left = vw - width
    }
    if (width > vw) width = vw
    return { x: left, width: width, height: height }
  }

  /**
   * The colour the shell hands Windows for that plate: its sidebar fill,
   * resolved through a probe on the body so inherited custom properties resolve
   * exactly as they do for the shell's own probe.
   */
  function sidebarFill() {
    var probe = el('span', null, 'afx-probe')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;background-color:var(--dsw-specific-sidebar-fill)'
    var color = ''
    try {
      root().appendChild(probe)
      var style = styleOf(probe)
      color = style ? String(style.backgroundColor || '') : ''
    } catch (error) { color = '' }
    removeNode(probe)
    return parseColor(color) ? color : ''
  }

  /**
   * Paint (or take away) the caption plate. Nothing is drawn unless the window
   * really has the native overlay, so a browser tab or a fullscreen window keeps
   * exactly the look it had.
   */
  function paintWco() {
    if (stopped) return
    var info = (F.background || F.deepBackground) ? wcoInfo() : null
    // The light frame has no seam to hide: the shell reports the same resolved
    // token to Windows as the colour the title strip paints, so a plate here
    // would only be an extra rectangle - and its fade band, spilling below the
    // caption into the toolbar row, is exactly the dark smudge that was reported.
    var light = isLightTheme()
    if (!info || light) {
      removeNode(wcoMat)
      wcoMat = null
      return
    }
    var fill = sidebarFill()
    if (fill) {
      wcoFill = fill
      wcoFillResolved = true
    } else if (!wcoFillResolved) {
      // A guess, not the app's own value: keep it fresh so a later read of the
      // real token can replace it, and pick it per theme like the shell does.
      wcoFill = light ? '#f9fafb' : '#1b1b1c'
    }
    if (!wcoMat || !wcoMat.parentNode) {
      wcoMat = el('div', WCO_ID)
      wcoMat.setAttribute('aria-hidden', 'true')
      root().appendChild(wcoMat)
    }
    wcoMat.style.setProperty('--afx-wco-w', Math.round(info.width) + 'px')
    wcoMat.style.setProperty('--afx-wco-h', Math.round(info.height) + 'px')
    wcoMat.style.setProperty('--afx-wco-color', wcoFill)
    // Feather geometry: a wider, cooler fade so the native plate reads as part of
    // the ambient field instead of a hard dark cut-out.
    wcoMat.style.setProperty('--afx-wco-f', WCO_FEATHER + 'px')
    wcoMat.style.setProperty('--afx-wco-fade', Math.round(WCO_FEATHER * 0.59) + 'px')
    wcoMat.style.setProperty('--afx-wco-fade-end', WCO_FEATHER + 'px')
  }

  /** Remove one decorative node if it is still attached. */
  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node)
  }

  function styleOf(node) {
    try { return node && globalThis.getComputedStyle ? globalThis.getComputedStyle(node) : null } catch (error) { return null }
  }

  function rectOf(node) {
    try { return node && node.getBoundingClientRect ? node.getBoundingClientRect() : null } catch (error) { return null }
  }

  /** Does this element paint a surface - a background, a gradient or a border? */
  function isPainted(style) {
    if (!style) return false
    var bg = String(style.backgroundColor || '')
    if (bg && bg !== 'transparent' && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) return true
    if (style.backgroundImage && style.backgroundImage !== 'none') return true
    if (style.borderTopWidth && parseFloat(style.borderTopWidth) > 0) return true
    return false
  }

  /**
   * Does this element draw a border of its own?
   *
   * The rounded rectangle the user sees around a composer is the element that
   * carries the border. The composer CARD around it often has none: it is a
   * padded wrapper whose inner box is the one with the visible edge. Lighting
   * the card instead puts the glow in the padding ring, a couple of dozen
   * pixels off the edge the eye follows - "the glow is not quite on the border".
   */
  function hasBorder(style) {
    if (!style) return false
    var top = parseFloat(style.borderTopWidth) || 0
    var left = parseFloat(style.borderLeftWidth) || 0
    return top > 0 || left > 0
  }

  // Does this element draw an edge the user can see? A border is the obvious
  // way, but the shell often draws the visible line with an inset shadow
  // instead - the composer box in the new-conversation page does - and a
  // compositor that only knows about borders would light the wrong box.
  function paintsEdge(style) {
    if (hasBorder(style)) return true
    var shadow = style && style.boxShadow
    if (!shadow || shadow === 'none') return false
    return /inset/.test(String(shadow))
  }

  /**
   * A single px corner radius, or an empty string to keep the default.
   *
   * A compound radius would need the four-corner syntax to stay honest, and
   * getting that wrong is worse than the default, so it is refused rather than
   * half-applied.
   */
  function radiusFrom(style) {
    try {
      var radius = style && style.borderRadius
      // A single, meaningful value only: '0px' would square off a rounded card, and
      // a compound radius would need the four-corner syntax to stay honest.
      if (typeof radius === 'string' && /^[\d.]+px$/.test(radius)) {
        var px = parseFloat(radius)
        if (px >= 2 && px <= 48) return radius
      }
    } catch (error) { /* keep the default */ }
    return ''
  }

  /** The caret's own rectangle, for an editor that exposes no focused element. */
  function caretRect() {
    try {
      var selection = globalThis.getSelection && globalThis.getSelection()
      if (selection && selection.rangeCount) {
        var caret = selection.getRangeAt(0).getBoundingClientRect()
        if (caret && (caret.width || caret.height)) return caret
      }
    } catch (error) { return null }
    return null
  }

  /**
   * Is this ancestor plausibly the whole input card the user sees?
   *
   * The bounds are deliberately generous in HEIGHT: the visible card is the editing
   * row PLUS its toolbar, which is routinely ~4x the row. The first version capped
   * that at 3.5x, so a real card was rejected and the glow fell back to the editing
   * row - which lit only the top strip of the box the user was looking at.
   */
  function fitsField(fieldRect, rect, viewportHeight) {
    if (rect.width < fieldRect.width * 0.98) return false
    if (rect.width > fieldRect.width * 2.4 + 24) return false
    if (rect.height < fieldRect.height) return false
    var maxHeight = Math.max(fieldRect.height * 5, fieldRect.height + 140)
    if (rect.height > maxHeight) return false
    // The last guard, and the one that keeps a whole column or the page itself out
    // of reach: whatever this is, it must stay input-sized on screen.
    if (viewportHeight && rect.height > viewportHeight * 0.45) return false
    return true
  }

  /**
   * The rectangle to light up.
   *
   * The focused control is usually an INNER field - a textarea or a contenteditable
   * that occupies one row of the visible composer - and the visible box around it is
   * often not one element at all: a transparent card can hold the editing row and
   * its toolbar as siblings. Picking any single ancestor therefore lights the wrong
   * shape (twice: first the inner field, then the editing row, both reported as a
   * glow covering only the upper part).
   *
   * So the box is built as the UNION of the field and every ancestor whose width is
   * compatible with it - walking outward while the shape stays composer-sized, and
   * stopping at the first ancestor that is wider (the column) or does not fit the
   * input-sized caps. The union covers row + toolbar by construction, painted or
   * not, and the corner radius is taken from the outermost contributor that has one.
   *
   * One exception comes first. A composer card is often a PADDED WRAPPER around the
   * box the user sees: the card has no border of its own, its inner box has the
   * visible edge, and the two are a card's padding apart. The union would then be
   * the wrapper - the glow would sit in the padding ring, twenty pixels off the
   * border the eye follows. So the first ancestor that draws a border wins: its
   * border box IS the visible box, and the light belongs there.
   *
   * @returns `{ box, radius, exact }`, or null when there is nothing to light.
   */
  function glowTarget(field) {
    if (field === undefined) field = document.activeElement
    if (field === document.body) field = null
    if (!field) {
      var caret = caretRect()
      return caret ? { box: caret, radius: '', exact: false } : null
    }
    var fieldRect = rectOf(field)
    if (!fieldRect || fieldRect.width <= 40 || fieldRect.height <= 12) {
      var caretOnly = caretRect()
      return caretOnly ? { box: caretOnly, radius: '', exact: false } : null
    }
    var viewportHeight = globalThis.innerHeight || 0
    var fieldStyle = styleOf(field)
    var tolerance = Math.max(40, fieldRect.width * 0.12)

    var left = fieldRect.left
    var top = fieldRect.top
    var right = fieldRect.left + fieldRect.width
    var bottom = fieldRect.top + fieldRect.height
    var radius = radiusFrom(fieldStyle)
    var painted = isPainted(fieldStyle)
    var included = 0
    var outermost = null
    var framed = null

    var node = field.parentElement || null
    for (var i = 0; i < 6 && node && node !== document.body; i++) {
      var rect = rectOf(node)
      var style = styleOf(node)
      // Wider than the field by more than the tolerance means this is not the
      // composer box any more - it is the column, or the page.
      if (!rect || Math.abs(rect.width - fieldRect.width) > tolerance) break
      if (!fitsField(fieldRect, rect, viewportHeight)) break
      // The first ancestor that draws a visible edge IS the visible box: the
      // composer card around it is a padded wrapper, and the glow belongs on
      // the border the user can see, not on the wrapper's outer edge. The edge
      // may be a border or an inset shadow - the shell uses both - but it has
      // to be an INSIDE edge: an outside shadow is a glow, not a border.
      if (!framed && paintsEdge(style)) {
        framed = { rect: rect, style: style }
      }
      left = Math.min(left, rect.left)
      top = Math.min(top, rect.top)
      right = Math.max(right, rect.left + rect.width)
      bottom = Math.max(bottom, rect.top + rect.height)
      // Later contributors are further out, so their radius describes the box the
      // user actually sees.
      var candidate = radiusFrom(style)
      if (candidate) radius = candidate
      if (isPainted(style)) painted = true
      outermost = node
      included += 1
      node = node.parentElement || null
    }

    if (framed) {
      // The bordered box wins over the union: it is the edge the user sees, and
      // the union would include the wrapper's padding around it.
      return {
        box: {
          left: framed.rect.left,
          top: framed.rect.top,
          width: framed.rect.width,
          height: framed.rect.height,
          // The visible box has its own corner radius; the host's is usually
          // rounder, and a rim drawn with the wrong radius does not sit on the
          // edge it is meant to trace.
          radius: radiusFrom(framed.style),
        },
        radius: radiusFrom(framed.style) || radius,
        exact: true,
        // The host stays the outermost card, so the node inside it is positioned
        // against a stable ancestor while the light lands on the visible edge.
        node: outermost,
      }
    }
    return {
      box: { left: left, top: top, width: right - left, height: bottom - top },
      radius: radius,
      // A union built from real ancestor boxes is a known shape; only the bare
      // field with no compatible ancestor is a guess.
      exact: included > 0 || painted,
      // The element to put the outline on, when one was identified.
      node: outermost,
    }
  }

  /** Is this node something the user types into? */
  function isEditable(node) {
    try {
      var tag = String((node && node.tagName) || '').toLowerCase()
      if (tag === 'textarea') return true
      if (tag === 'input') return String(node.type || 'text') !== 'hidden'
      var attr = node && node.getAttribute ? node.getAttribute('contenteditable') : null
      return attr === '' || attr === 'true'
    } catch (error) {
      return false
    }
  }

  /** The focused editor, or the first one on the page when nothing is focused. */
  function editableCandidate() {
    try {
      var active = document.activeElement
      if (active && active !== document.body && isEditable(active)) return active
      var list = document.querySelectorAll('textarea,[contenteditable=""],[contenteditable="true"],input[type="text"]')
      for (var i = 0; i < list.length; i++) if (isEditable(list[i])) return list[i]
    } catch (error) {
      return null
    }
    return null
  }

  var reported = false
  // The keystroke report is the one that names which path drew the halo, so it
  // gets its own flag: sharing `reported` with focusin/scan meant the first
  // focus event ate it and the real drawing path was never observed.
  var reportedKeystroke = false

  /**
   * Send the ancestor chain this plugin actually sees to the Host.
   *
   * The key-glow's fit was fixed twice from assumptions and was wrong twice, so the
   * page now reports the facts instead: for the editor and each ancestor up to
   * eight levels, its tag, class list, size, computed background/border/radius and
   * whether it passed the fit test - plus which box the plugin ended up choosing.
   * Structure only: no text content, no input value, nothing the user typed.
   *
   * @param reason - what triggered the report, for the Host's log.
   * @returns true when a report was sent.
   */
  function reportChain(reason) {
    try {
      if (!F.diagnostics) return false
      if (typeof globalThis.fetch !== 'function') return false
      var field = editableCandidate()
      if (!field) return false
      var fieldRect = rectOf(field) || { width: 0, height: 0 }
      var vh = globalThis.innerHeight || 0
      var chain = []
      var node = field
      for (var i = 0; i < 8 && node && node !== document.documentElement; i++) {
        var rect = rectOf(node)
        var style = styleOf(node)
        chain.push({
          d: i,
          tag: String(node.tagName || '').toLowerCase(),
          cls: String(node.className || '').slice(0, 90),
          role: node.getAttribute ? String(node.getAttribute('role') || '') : '',
          w: rect ? Math.round(rect.width) : -1,
          h: rect ? Math.round(rect.height) : -1,
          top: rect ? Math.round(rect.top) : -1,
          bg: style ? String(style.backgroundColor || '').slice(0, 40) : '',
          bw: style ? String(style.borderTopWidth || '') : '',
          rad: style ? String(style.borderRadius || '').slice(0, 24) : '',
          pos: style ? String(style.position || '') : '',
          z: style ? String(style.zIndex || '') : '',
          painted: style && isPainted(style) ? 1 : 0,
          // Does this level draw the edge the user sees? The shell sometimes
          // uses a border, sometimes an inset shadow, and the two are not the
          // same answer.
          edge: style && paintsEdge(style) ? 1 : 0,
          shadow: style ? String(style.boxShadow || '').slice(0, 60) : '',
          // A card that clips its own overflow cannot host the halo node, so
          // the layer has to paint the light from the outside instead.
          ov: style ? String(style.overflow || '') : '',
          fits: rect && fitsField(fieldRect, rect, vh) ? 1 : 0,
        })
        node = node.parentElement || null
      }
      var target = glowTarget(field)
      var payload = JSON.stringify({
        reason: reason,
        vh: vh,
        env: {
          scrollX: globalThis.scrollX || 0,
          scrollY: globalThis.scrollY || 0,
          dpr: globalThis.devicePixelRatio || 1,
          bodyZoom: (function () {
            try { return String(styleOf(document.body).zoom || '') } catch (error) { return '' }
          })(),
          bodyTransform: (function () {
            try { return String(styleOf(document.body).transform || '') } catch (error) { return '' }
          })(),
            v: '0.6.8-diag',
            tokenRaw: (function () {
              try { return String(globalThis.getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill') || '').slice(0, 80) } catch (error) { return '' }
            })(),
            bodyBg: (function () {
              try { return String(styleOf(document.body).backgroundColor || '').slice(0, 40) } catch (error) { return '' }
            })(),
            probe: sidebarFill(),
          // Where the native caption plate is and the colour it was given: the one
          // pair of facts that explains a seam in a screenshot.
          wco: (function () {
            var info = wcoInfo()
            return info ? {
              x: Math.round(info.x),
              w: Math.round(info.width),
              h: Math.round(info.height),
              fill: wcoFill,
            } : null
          })(),
        },
        field: {
          w: Math.round(fieldRect.width),
          h: Math.round(fieldRect.height),
          top: Math.round(fieldRect.top),
        },
        chosen: target ? {
          w: Math.round(target.box.width),
          h: Math.round(target.box.height),
          top: Math.round(target.box.top),
          rad: target.radius,
          exact: target.exact,
          card: target.node ? {
            tag: String(target.node.tagName || '').toLowerCase(),
            cls: String(target.node.className || '').slice(0, 60),
          } : null,
        } : null,
        // Where the light actually landed, next to where it was asked to land.
        // The two boxes have to agree: the rim is only on the visible border when
        // the node covers the same rectangle the target measured.
        halo: (function () {
          try {
            var host = haloHost
            var node = haloNode
            var hostRect = host ? rectOf(host) : null
            var nodeRect = node ? rectOf(node) : null
            var hostStyle = host ? styleOf(host) : null
            return {
              hosted: !!(host && node),
              // Which of the two paths drew the light, and why. The hosted path
              // puts a node inside the card and lights the edge from the inside;
              // the drawn path paints a node over the card and lights it from
              // the outside. A card that clips its own overflow cannot host the
              // node, so it always takes the second path.
              path: (host && node) ? 'hosted' : 'drawn',
              why: (host && node) ? 'the card hosts the node'
                : (target && target.node ? 'the card clips its overflow: ' + String((styleOf(target.node) || {}).overflow || '?')
                  : 'no host box'),
              box: target ? {
                l: Math.round(target.box.left),
                t: Math.round(target.box.top),
                w: Math.round(target.box.width),
                h: Math.round(target.box.height),
              } : null,
              hostBox: hostRect ? {
                l: Math.round(hostRect.left),
                t: Math.round(hostRect.top),
                w: Math.round(hostRect.width),
                h: Math.round(hostRect.height),
              } : null,
              nodeBox: nodeRect ? {
                l: Math.round(nodeRect.left),
                t: Math.round(nodeRect.top),
                w: Math.round(nodeRect.width),
                h: Math.round(nodeRect.height),
              } : null,
              pad: hostStyle ? {
                l: Math.round(parseFloat(hostStyle.paddingLeft) || 0),
                t: Math.round(parseFloat(hostStyle.paddingTop) || 0),
                r: Math.round(parseFloat(hostStyle.paddingRight) || 0),
                b: Math.round(parseFloat(hostStyle.paddingBottom) || 0),
              } : null,
            }
          } catch (error) { return null }
        })(),
        chain: chain,
      })
      try {
        globalThis.fetch(ROUTE + '/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        })
      } catch (error) {
        globalThis.fetch(ROUTE + '/report?payload=' + encodeURIComponent(payload))
      }
      return true
    } catch (error) {
      return false
    }
  }

  // The glow replaces itself rather than stacking: a new keystroke restarts the
  // same node's fade, so continuous typing reads as one sustained light instead of
  // a pile of half-transparent rectangles.
  function spawnTracked(cls, ms, place, track) {
    var previous = track === 'box' ? activeGlow : activeDot
    removeNode(previous)
    var node = null
    try {
      node = el('span', null, cls)
      place(node)
      root().appendChild(node)
    } catch (error) {
      return
    }
    if (track === 'box') activeGlow = node
    else activeDot = node
    globalThis.setTimeout(function () {
      removeNode(node)
      if (track === 'box' && activeGlow === node) activeGlow = null
      if (track === 'dot' && activeDot === node) activeDot = null
    }, ms)
  }

  // The typing light: smooth by construction.
  //
  // Two things made the earlier versions feel harsh, and neither was the colour:
  // a 2px outline is a hard edge, and re-adding an ANIMATION on every keystroke
  // snapped the light back to full brightness, so typing looked like a series of
  // flashes. So there is no animation and no outline here. The light is a node with
  // an inline opacity: raised quickly by a keystroke, then lowered by one long eased
  // transition after the last one. A value that is only ever raised or lowered is
  // continuous - nothing restarts, so nothing jumps.
  // The three numbers are the feel, and they are deliberately asymmetric: a rise
  // short enough to read as "the box answered" (90ms is about five frames), a hold
  // short enough that the light lets go promptly once typing stops, and a fall long
  // enough to still be a dissolve rather than a blink.
  var RISE_MS = 90
  var HOLD_MS = 130
  var FALL_MS = 900
  var FALL_CURVE = 'cubic-bezier(.22,.61,.36,1)'
  var LIT_OPACITY = 0.92
  var LIT_OPACITY_STRONG = 1

  var haloNode = null
  var haloHost = null
  var holdTimer = null
  var cleanupTimer = null

  /**
   * The rim plus the two diffusion stops for the theme in force right now.
   *
   * One mechanism, two palettes - the behaviour is identical in both themes, only the
   * colour is not. The dark frame keeps the cold cyan it was tuned with.
   *
   * The light frame is a WARM HONEY: the gold hue leaning towards orange, sitting
   * between the two extremes this palette has already been through. The saturated gold
   * leaf it started as had R-B 134 and read as metal; the cool champagne it went to had
   * R-B 66 and read as beige. This is 104 with the hue at ~34 degrees instead of ~42,
   * which is the "slightly more yellow, a little orange" the eye asked for without
   * returning to either end.
   *
   * A warm tone is the right family at all here because the light page is already blue:
   * a pale blue glow disappears into a near-white card, and a second blue has nothing
   * to say against a blue page.
   *
   * @param strong - Enter gets a wider, brighter version.
   * @param rimMode - 'inset' for the node inside the card, 'outer' for the
   *   body level fallback (its node is painted over the card and must not
   *   cover its text), false for a target that is only a guess.
   * @param spread - true (default) lets the near/far bloom push OUTSIDE the box
   *   with a positive spread; the welcome composer's drawn halo passes false so
   *   the glow stays an aura hugging the border instead of bleeding sideways
   *   onto the page beside it - the "it spills out left and right" complaint.
   *
   * The fallback used to run without any edge at all, so the light read as a
   * soft cloud floating around the composer instead of a line ON its border -
   * which is exactly the "the glow does not sit on the edge" complaint.
   */
  function haloShadow(strong, rimMode, spread) {
    if (spread === undefined) spread = true
    var light = false
    try { light = document.documentElement.classList.contains('afx-light') } catch (error) { light = false }
    var rim = light ? 'rgba(236,188,140,.66)' : 'rgba(158,228,255,.60)'
    var near = light ? 'rgba(246,214,170,.48)' : 'rgba(104,200,255,.46)'
    var far = light ? 'rgba(226,180,130,.26)' : 'rgba(70,166,235,.26)'
    var width = strong ? 3 : 2
    var scale = strong ? 1.25 : 1
    var edge = ''
    if (rimMode === 'inset') edge = 'inset 0 0 0 ' + width + 'px ' + rim + ','
    else if (rimMode === 'outer') edge = '0 0 0 ' + width + 'px ' + rim + ','
    // Zero spread keeps each blur ring from reaching past the element's own box:
    // same colour, same falloff, but nothing bleeds into the white margin beside
    // the card. The blur radius still grows with scale, so the softness survives.
    var nearSpread = spread ? Math.round(14 * scale) : 0
    var farSpread = spread ? Math.round(30 * scale) : 0
    return edge
      + '0 0 ' + Math.round(40 * scale) + 'px ' + nearSpread + 'px ' + near
      + ',0 0 ' + Math.round(130 * scale) + 'px ' + farSpread + 'px ' + far
  }

  /**
   * Put the halo node exactly over the box we measured.
   *
   * `inset: 0` fills the host's PADDING box, and that is NOT the box the user sees:
   * a composer card with twenty pixels of side padding would light a rim twenty
   * pixels inside the visible edge - a ring floating in the middle of the card
   * instead of tracing its border. The measured box is a viewport rectangle taken
   * from real border boxes, and the containing block of an absolutely positioned
   * child is the host's padding box, so the two are related by the host's border
   * widths.
   *
   * Placing the node by hand also keeps the hosted path and the drawn fallback
   * talking about the same rectangle: `drawHalo` paints at `target.box`, so the
   * node inside the card has to sit at `target.box` too.
   */
  function placeHaloNode(card, node, box) {
    if (!node || !box) return
    var rect = rectOf(card)
    if (!rect) return
    var style = styleOf(card)
    var borderLeft = style ? parseFloat(style.borderLeftWidth) || 0 : 0
    var borderTop = style ? parseFloat(style.borderTopWidth) || 0 : 0
    // The containing block starts at the host's border box plus its borders.
    var originX = rect.left + borderLeft
    var originY = rect.top + borderTop
    var nodeStyle = node.style
    nodeStyle.left = (Math.round((box.left - originX) * 100) / 100) + 'px'
    nodeStyle.top = (Math.round((box.top - originY) * 100) / 100) + 'px'
    nodeStyle.width = (Math.max(0, Math.round(box.width * 100) / 100)) + 'px'
    nodeStyle.height = (Math.max(0, Math.round(box.height * 100) / 100)) + 'px'
    // A visible box with its own radius gets it; a plain card keeps inheriting
    // the host's.
    if (box.radius) nodeStyle.borderRadius = box.radius
    nodeStyle.right = 'auto'
    nodeStyle.bottom = 'auto'
  }

  /**
   * The halo node INSIDE the card.
   *
   * The node is a child of the card, so it follows the card as it grows, and -
   * being a transition rather than an animation - raising and lowering it is one
   * continuous value. Its box is set by `placeHaloNode` to the measured rectangle,
   * not by `inset: 0`, so the rim lands on the visible border.
   */
  function ensureHaloNode(card, box) {
    if (haloHost === card && haloNode && haloNode.parentNode) {
      placeHaloNode(card, haloNode, box)
      return haloNode
    }
    removeHalo()
    try {
      var node = el('span', null, 'afx-halo')
      var style = node.style
      style.position = 'absolute'
      style.left = '0px'
      style.top = '0px'
      style.width = '0px'
      style.height = '0px'
      style.right = 'auto'
      style.bottom = 'auto'
      style.borderRadius = 'inherit'
      style.pointerEvents = 'none'
      style.zIndex = '1'
      style.opacity = '0'
      style.transitionProperty = 'opacity'
      style.transitionTimingFunction = FALL_CURVE
      style.transitionDuration = RISE_MS + 'ms'
      card.appendChild(node)
      haloNode = node
      haloHost = card
      placeHaloNode(card, node, box)
      return node
    } catch (error) {
      haloNode = null
      haloHost = null
      return null
    }
  }

  /** Can the card host the node, or would its own overflow clip the halo away? */
  function canHostHalo(card) {
    try {
      var style = styleOf(card)
      if (!style || style.position === 'static') return false
      var overflow = String(style.overflow || '')
      return !overflow || overflow === 'visible'
    } catch (error) {
      return false
    }
  }

  /** Drop every trace of the light. */
  function removeHalo() {
    if (holdTimer !== null) {
      try { globalThis.clearTimeout(holdTimer) } catch (error) { /* already gone */ }
      holdTimer = null
    }
    if (cleanupTimer !== null) {
      try { globalThis.clearTimeout(cleanupTimer) } catch (error) { /* already gone */ }
      cleanupTimer = null
    }
    removeNode(haloNode)
    removeNode(activeGlow)
    haloNode = null
    haloHost = null
    activeGlow = null
  }

  /**
   * Raise the light now, and let it down only after typing stops.
   *
   * The hold is the point: a keystroke inside the hold simply keeps the level up, so
   * fast typing holds one steady glow instead of restarting a flash, and the long
   * eased fall starts only once the typing actually pauses.
   */
  function raiseHalo(node, strong, rimMode, spread) {
    if (!node) return false
    try {
      node.style.transitionDuration = RISE_MS + 'ms'
      node.style.boxShadow = haloShadow(strong, rimMode, spread)
      node.style.opacity = String(strong ? LIT_OPACITY_STRONG : LIT_OPACITY)
    } catch (error) {
      return false
    }
    if (holdTimer !== null) {
      try { globalThis.clearTimeout(holdTimer) } catch (error) { /* already gone */ }
    }
    if (cleanupTimer !== null) {
      // A fresh keystroke cancels the tidy-up, so the node cannot be removed while it
      // is still fading.
      try { globalThis.clearTimeout(cleanupTimer) } catch (error) { /* already gone */ }
      cleanupTimer = null
    }
    holdTimer = globalThis.setTimeout(function () {
      holdTimer = null
      try {
        node.style.transitionDuration = FALL_MS + 'ms'
        node.style.opacity = '0'
      } catch (error) { /* detached */ }
      // Once the fall has finished there is no reason to keep a foreign child inside
      // the application's own card; it goes away with the light.
      cleanupTimer = globalThis.setTimeout(function () {
        cleanupTimer = null
        if (haloNode === node) {
          removeNode(node)
          haloNode = null
          haloHost = null
        }
        if (activeGlow === node) {
          removeNode(node)
          activeGlow = null
        }
      }, FALL_MS + 150)
    }, HOLD_MS)
    return true
  }

  /** The drawn halo: the fallback for a card that cannot host the node. */
  function drawHalo(target, strong) {
    var box = target.box
    // The box came from getBoundingClientRect, so the scroll offset is what turns a
    // viewport rectangle into a document one.
    var offsetX = globalThis.scrollX || 0
    var offsetY = globalThis.scrollY || 0
    removeHalo()
    var node = null
    try {
      node = el('span', null, 'afx-keyglow')
      node.style.left = (box.left + offsetX) + 'px'
      node.style.top = (box.top + offsetY) + 'px'
      node.style.width = box.width + 'px'
      node.style.height = box.height + 'px'
      if (target.radius) node.style.borderRadius = target.radius
      node.style.opacity = '0'
      node.style.transitionProperty = 'opacity'
      node.style.transitionTimingFunction = FALL_CURVE
      root().appendChild(node)
      activeGlow = node
    } catch (error) {
      return false
    }
    // The fallback node is painted over the card, so its edge cannot be inset
    // without covering the text. It is drawn as a ring just outside the box
    // instead, which traces the same border the hosted node would light from
    // the inside. A target that is only a guess (a bare field, with no
    // composer box around it) keeps the plain diffusion.
    //
    // And when the box IS exact - the welcome composer, whose card clips its
    // own overflow so the node could not live inside it - the bloom runs with
    // zero spread: an outer ring plus a 130px/30px halo on a body-level node
    // bleeds warm light into the white page margin beside the card, and that
    // side-bleed is what read as "the glow spills out left and right".
    return raiseHalo(node, strong, target.exact ? 'outer' : false, target.exact ? false : true)
  }

  function onPointerMove(event) {
    if (event && typeof event.clientX === 'number') lastPointer = { x: event.clientX, y: event.clientY }
  }

  function onKeyDown(event) {
    if (!F.keyGlow) return
    if (event && (event.isComposing || event.keyCode === 229)) return // IME mid-composition
    if (!reportedKeystroke) { reportedKeystroke = true; reportChain('keystroke') }
    var key = event && event.key
    if (!key) return
    var strong = key === 'Enter'
    if (!strong && key.length > 1 && key !== 'Backspace' && key !== 'Delete') return
    var target = glowTarget()
    if (target) {
      // The node inside the card is the good path: exact by construction and smooth
      // by transition. The drawn halo only runs for a card that cannot host it.
      if (target.node && canHostHalo(target.node)) {
        var hosted = ensureHaloNode(target.node, target.box)
        if (hosted && raiseHalo(hosted, strong, 'inset')) return
      }
      if (drawHalo(target, strong)) return
    }
    // Nothing focused (or an exotic editor): a small dot at the pointer is the
    // honest fallback, and only when the pointer is actually known.
    if (!lastPointer) return
    spawnTracked(strong ? 'afx-keydot afx-keyglow-strong' : 'afx-keydot', 480, function (node) {
      var size = strong ? 200 : 150
      node.style.left = (lastPointer.x - size / 2) + 'px'
      node.style.top = (lastPointer.y - size / 2) + 'px'
      node.style.width = size + 'px'
      node.style.height = size + 'px'
    }, 'dot')
  }

  /**
   * Collect panel-swap candidates. Deliberately geometry-free: measuring here
   * would run a forced layout inside the observer callback for every batch a
   * streaming answer produces.
   */
  function collectPanels(records) {
    if (!F.transitions || reduce || stopped) return
    // `full` rather than an early `return`: hitting the candidate cap must still
    // fall through to the scheduling block below. Returning here is a real bug -
    // it leaves the collected candidates stranded and the veil simply stops
    // firing under a flood of panel-sized swaps.
    var full = false
    for (var i = 0; i < records.length && !full; i++) {
      var record = records[i]
      if (record.type !== 'childList' || !record.addedNodes) continue
      var added = record.addedNodes
      for (var j = 0; j < added.length; j++) {
        var node = added[j]
        if (node.nodeType !== 1 || isOurs(node)) continue
        if (node.childElementCount < PANEL_MIN_CHILDREN) continue
        if (pendingPanels.length >= MAX_PANEL_CANDIDATES) { full = true; break }
        pendingPanels.push(node)
      }
    }
    if (pendingPanels.length && !measureScheduled) {
      measureScheduled = true
      schedule(measurePanels)
    }
  }

  /** The single bounded measuring pass, off the observer's stack. */
  function measurePanels() {
    measureScheduled = false
    var list = pendingPanels
    pendingPanels = []
    if (stopped || !F.transitions || reduce) return
    var vw = globalThis.innerWidth || 1
    var vh = globalThis.innerHeight || 1
    var probes = Math.min(list.length, MAX_PANEL_PROBES)
    for (var i = 0; i < probes; i++) {
      var node = list[i]
      if (!node.parentNode) continue // already gone: a swap that came and went
      var rect = null
      try { rect = node.getBoundingClientRect() } catch (error) { rect = null }
      if (rect && rect.width * rect.height >= vw * vh * 0.22 && rect.height >= vh * 0.3) {
        flashVeil()
        return
      }
    }
  }

  function flashVeil() {
    if (!F.transitions || reduce || stopped) return
    var stamp = now()
    if (stamp - lastVeil < 800) return
    lastVeil = stamp
    try {
      if (veil && veil.parentNode) veil.parentNode.removeChild(veil)
      veil = el('div', VEIL_ID)
      veil.setAttribute('aria-hidden', 'true')
      root().appendChild(veil)
      globalThis.setTimeout(function () {
        if (veil && veil.parentNode) veil.parentNode.removeChild(veil)
        veil = null
      }, 340)
    } catch (error) {
      veil = null
    }
  }

  function onThemeMutation() {
    if (stopped) return
    applyTheme()
  }

  /**
   * Mark the session row the sidebar currently shows as selected.
   *
   * The row is found by what the shell already says about it (`aria-current`,
   * `aria-selected`, `data-active` ...) inside the left column, taking the
   * smallest match so a row wins over the list that contains it. If the shell
   * renames those attributes the effect simply does nothing - it never guesses
   * by text or position, which is what would make it paint the wrong row.
   *
   * Runs on the slow tick, never from a mutation record, and measures at most
   * MAX_ROW_PROBES candidates.
   */
  function scanActiveRow() {
    if (!F.activeRow || stopped) return
    var found = null
    try {
      var candidates = document.querySelectorAll(
        '[aria-current="true"],[aria-current="page"],[aria-selected="true"],[data-active="true"],[data-state="active"]',
      )
      var bestArea = Infinity
      var probes = Math.min(candidates.length, MAX_ROW_PROBES)
      for (var i = 0; i < probes; i++) {
        var node = candidates[i]
        if (isOurs(node)) continue
        var rect = node.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) continue
        if (rect.right > 420) continue                      // not the sidebar column
        if (rect.height < 16 || rect.height > 64) continue  // not a row
        var area = rect.width * rect.height
        if (area < bestArea) { bestArea = area; found = node }
      }
    } catch (error) {
      return
    }
    if (found === activeRowEl) return
    try {
      if (activeRowEl && activeRowEl.classList) activeRowEl.classList.remove('afx-active-row')
      if (found && found.classList) found.classList.add('afx-active-row')
    } catch (error) {
      /* an SVG or exotic element without classList is skipped, not forced */
    }
    activeRowEl = found
  }

  /** The slow tick: everything that has to look at the document, in one place. */
  function tick() {
    if (stopped) return
    if (document.hidden) return // a background window costs nothing
    scanActiveRow()
    clearFrame()
    // Re-check every tick: nothing is created in a window without the overlay,
    // a shell that grows the attribute late still gets its plate, and the
    // colour must keep following the token - the shell re-reports it to Windows
    // whenever the theme changes, and so must we.
    paintWco()
  }

  function mount() {
    if (stopped) return
    try { injectStyle() } catch (error) { /* without the style nothing shows, and nothing breaks */ }
    try {
      if (reduce) document.documentElement.classList.add('afx-still')
      applyTheme()
      build()
    } catch (error) {
      /* a page that cannot host the layer keeps its own appearance */
    }

    // Neither observer is created for an effect that is switched off, and the
    // swap test is not even watched under reduced motion: an observer that can
    // only return early is pure overhead in the app's own renderer.
    if (F.transitions && !reduce) {
      try {
        childObserver = new MutationObserver(collectPanels)
        // childList only: `attributes` on a whole subtree fires for every style
        // tweak the transcript makes, and none of them are ours to act on.
        childObserver.observe(root(), { childList: true, subtree: true })
      } catch (error) {
        childObserver = null
      }
    }
    if (F.background || F.deepBackground) {
      try {
        themeObserver = new MutationObserver(onThemeMutation)
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
        // The dark palette is declared on `body[data-ds-dark-theme]`, so the
        // switch that matters lands HERE, not on <html>. Watching only the root
        // meant an in-app theme change kept the old treatment until a reload.
        if (document.body) {
          themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme'] })
        }
      } catch (error) {
        themeObserver = null
      }
    }

    if (F.keyGlow) on(globalThis, 'keydown', onKeyDown, true)
    // The pointer position is only ever recorded, never acted on per move, and
    // only the key glow's fallback has any use for it.
    if (F.keyGlow) on(globalThis, 'pointermove', onPointerMove, { passive: true, capture: true })

    // One structural report per page load, so a fit that is still wrong can be
    // fixed from the real DOM instead of from another assumption. It needs no
    // interaction: if the shell has an editor, the scan finds it.
    if (F.diagnostics) {
      globalThis.setTimeout(function () {
        if (!reported) reported = reportChain('scan')
      }, 4000)
      // A focus is cheap and rare, and a report is how a fit that is still
      // wrong gets fixed from the real DOM instead of from another assumption.
      // The automatic report of a page load is the first one; after that every
      // focus refreshes it, so the structure of any page can be read without
      // reloading the app.
      var lastFocusReport = 0
      on(globalThis, 'focusin', function () {
        var now = Date.now()
        if (now - lastFocusReport < 1500) return
        lastFocusReport = now
        reported = reportChain('focusin')
      }, true)
    }

    // A window with the native overlay gets its plate, and only that window needs
    // to re-read the overlay geometry when it is resized. The delayed pass covers
    // a shell that settles its theme tokens after the first frame.
    if (wcoInfo()) {
      on(globalThis, 'resize', paintWco, { passive: true })
      globalThis.setTimeout(function () { if (!stopped) paintWco() }, 600)
    }

    scanActiveRow()
    clearFrame()
    if (typeof globalThis.setInterval === 'function') {
      tickTimer = globalThis.setInterval(tick, TICK_MS)
    }
  }

  function stop() {
    if (stopped) return
    stopped = true
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]) } catch (error) { /* already gone */ }
    }
    listeners = []
    if (tickTimer !== null && typeof globalThis.clearInterval === 'function') {
      try { globalThis.clearInterval(tickTimer) } catch (error) { /* already gone */ }
    }
    tickTimer = null
    if (childObserver) {
      try { childObserver.disconnect() } catch (error) { /* already gone */ }
      childObserver = null
    }
    if (themeObserver) {
      try { themeObserver.disconnect() } catch (error) { /* already gone */ }
      themeObserver = null
    }
    pendingPanels = []
    try {
      if (activeRowEl && activeRowEl.classList) activeRowEl.classList.remove('afx-active-row')
    } catch (error) { /* nothing to undo */ }
    activeRowEl = null
    restoreFrame()
    removeHalo()
    var ids = [LAYER_ID, BEHIND_ID, STYLE_ID, VEIL_ID, WCO_ID]
    for (var q = 0; q < ids.length; q++) {
      var node = document.getElementById(ids[q])
      if (node && node.parentNode) node.parentNode.removeChild(node)
    }
    try { document.documentElement.classList.remove('afx-still', 'afx-light') } catch (error) { /* nothing to undo */ }
    layer = null
    behind = null
    veil = null
    wcoMat = null
    if (globalThis.__DSH_AMBIENT_FX__) globalThis.__DSH_AMBIENT_FX__.active = false
  }

  globalThis.__DSH_AMBIENT_FX__ = {
    active: true,
    settings: F,
    reducedMotion: reduce,
    stop: stop,
    rescan: function () { clearFrame(); scanActiveRow() },
    // Manual trigger for the structural report (see reportChain).
    report: function () { return reportChain('manual') },
    // Small, read-only window onto the hot path: how many swap candidates are
    // waiting, and how many frame scans have run. Costs nothing and is the
    // first thing to look at when the veil stops firing.
    state: function () {
      return {
        panels: pendingPanels.length,
        measuring: measureScheduled,
        lastVeil: lastVeil,
        frameScans: frameScans,
      }
    },
  }

  if (document.readyState === 'loading') on(document, 'DOMContentLoaded', mount, { once: true })
  else mount()
})()
