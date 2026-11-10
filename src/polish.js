/*
 * dsh-visual-polish - the bootstrap, as framework-free text.
 *
 * It stamps the preset on <html> and appends the stylesheet. That is the whole
 * job: the visuals live in polish.css, so this file only has to be
 * deterministic about WHEN the style exists (before the shell paints, hence a
 * head script) and about how it is undone.
 *
 * If this script runs twice (a second injection, a re-render), the second run
 * reuses the same element instead of stacking a duplicate sheet.
 */
;(function () {
  'use strict'

  var CFG = (globalThis && globalThis.__DSH_POLISH_CFG__) || {}
  var CSS = globalThis.__DSH_POLISH_CSS__ || ''
  var STYLE_ID = 'dsh-polish-style'
  var ATTR = 'data-polish'
  // Where the report goes. The base is injected by the Host half, so the same
  // bootstrap works inside a single package and inside a plugin of its own.
  var BASE = (typeof CFG.base === 'string' && CFG.base) ? CFG.base : '/plugins/dsh-visual-polish'

  if (CFG.enabled === false || !CSS) return

  function apply() {
    var root = document.documentElement
    if (CFG.preset) root.setAttribute(ATTR, String(CFG.preset))
    else root.removeAttribute(ATTR)

    if (document.getElementById(STYLE_ID)) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    ;(document.head || root).appendChild(style)
  }

  function detach() {
    var node = document.getElementById(STYLE_ID)
    if (node && node.parentNode) node.parentNode.removeChild(node)
    document.documentElement.removeAttribute(ATTR)
    if (globalThis.__DSH_VISUAL_POLISH__) globalThis.__DSH_VISUAL_POLISH__.active = false
  }

  globalThis.__DSH_VISUAL_POLISH__ = {
    active: true,
    preset: CFG.preset || '',
    cssBytes: CSS.length,
    detach: detach,
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true })
  else apply()

  // Say what actually happened. A stylesheet that never reaches the page looks
  // exactly like one whose rules do not match, and the difference is invisible
  // from the Host side - so the client half reports what it sees.
  function report() {
    try {
      var root = document.documentElement
      var body = document.body
      var style = document.getElementById(STYLE_ID)
      var cs = body ? getComputedStyle(body) : null
      var payload = {
        preset: root.getAttribute(ATTR),
        stylePresent: !!style,
        styleBytes: style ? String(style.textContent || '').length : 0,
        styleParent: style && style.parentNode ? style.parentNode.nodeName : '',
        darkTheme: !!(body && body.hasAttribute && body.hasAttribute('data-ds-dark-theme')),
        bodyBackground: cs ? String(cs.backgroundColor || '') : '',
        sidebarFill: cs ? String(cs.getPropertyValue('--dsw-specific-sidebar-fill') || '').trim() : '',
        bgBase: cs ? String(cs.getPropertyValue('--dsw-alias-bg-base') || '').trim() : '',
        url: String(location.href || '').slice(0, 120),
      }
      if (typeof globalThis.fetch === 'function') {
        globalThis.fetch(BASE + '/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () {})
      }
    } catch (error) {
      /* reporting must never break the page */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); report() }, { once: true })
  } else {
    report()
  }
  if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(report, 1200)
})()