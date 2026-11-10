// dsh-deepwater - Host half.
//
// One package, two layers:
//
//   * the SURFACE layer (src/polish.css + src/polish.js) repaints the app's
//     own design tokens, so the shell reads as the glacier-blue theme in either
//     colour mode - the deep sea at night, frosted glass over deep water by
//     day;
//   * the AMBIENCE layer (src/ambient.js) paints the water behind that surface
//     and the small light effects on top of it.
//
// The Host half does four things and owns no other state:
//
//   1. pushes the head rows that carry the config, the stylesheet and the three
//      browser scripts into every index the web server renders;
//   2. serves a read-only status route, so a deployment can be checked without
//      a browser;
//   3. serves the two report sinks the browser half writes to - the surface
//      layer's own report and the ambience layer's DOM report;
//   4. serves the settings, because the desktop app renders its own bundled
//      SPA and never sees an index injection, so its browser entry has to read
//      the effective settings back over HTTP.
//
// Every row is re-read from disk on each index render, so a CSS tweak takes
// effect on a plain reload; only this file needs a DSH restart.
//
// There is no schemastery Config here on purpose. The settings surface of DSH
// 0.2.x is a namespace per plugin entry, and a namespace without a browser
// card behind it is a half-finished thing; the values below are read from the
// profile row instead, which every DSH build understands. The one-click switch
// is the plugin row itself: turning the row off takes the client entry out of
// the module graph, the browser half's disposer runs, and both layers tear
// themselves down, leaving the app exactly as it was.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS_PATH = fileURLToPath(new URL('./src/polish.css', import.meta.url))
const SURFACE_SCRIPT_PATH = fileURLToPath(new URL('./src/polish.js', import.meta.url))
const AMBIENCE_SCRIPT_PATH = fileURLToPath(new URL('./src/ambient.js', import.meta.url))
const API_SCRIPT_PATH = fileURLToPath(new URL('./src/deepwater.js', import.meta.url))
const ROUTE = '/plugins/dsh-deepwater'

export const name = 'dsh-deepwater'

// The status route is the only service this half needs. Declaring it here (and
// not in the client half, which does not exist) keeps the fiber from staying
// pending in a profile that lacks a service.
export const inject = ['webServer']

/**
 * The presets the surface layer ships. Anything else in the profile falls back
 * to the first one rather than reaching the page as an unknown value that no
 * rule matches (which would look like "the plugin does nothing").
 */
export const PRESETS = ['roomy', 'compact', 'minimal']
const DEFAULT_PRESET = 'roomy'

/**
 * The documented defaults.
 *
 * A field the profile leaves out - or sends with the wrong type - falls back
 * to the value here rather than to `undefined`, which would reach the page as
 * a broken config global.
 */
export const DEFAULTS = {
  /**
   * The master switch. Off leaves the app exactly as DSH shipped it: no head
   * rows are added, so neither layer ever runs.
   */
  enabled: true,
  /** Which spacing preset the surface layer paints with. */
  preset: DEFAULT_PRESET,
  /**
   * Whether the ambience layer runs at all.
   *
   * The surface layer repaints surfaces; the ambience layer paints light,
   * particles and the water behind them. Some people want the first without
   * the second, so they are separate switches.
   */
  ambience: true,
  /** Whether the water gradient is painted behind the app. */
  background: true,
  /** Whether that gradient is painted deeper. */
  deepBackground: true,
  /** How many drifting motes the ambience layer keeps alive (0..40). */
  particles: 6,
  /** How strong the light is (0..1). */
  glow: 0.45,
  /** Whether the composer answers the keyboard with a glow. */
  keyGlow: true,
  /** Whether the ambience layer animates at all. */
  transitions: true,
  /** Whether the active row in the sidebar is marked. */
  activeRow: true,
  /** Whether the OS "reduce motion" preference is obeyed. */
  respectReducedMotion: true,
  /** Whether the page reports what it measures back to the Host. */
  diagnostics: true,
}

/**
 * Coerce one profile config object into the shape the page expects.
 * @param config - the applied config; may be undefined in a profile that
 *   declares no config for this row.
 * @returns every documented field, typed and ranged.
 */
export function normalize(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const out = {}
  for (const key of Object.keys(DEFAULTS)) {
    const fallback = DEFAULTS[key]
    const value = raw[key]
    out[key] = typeof value === typeof fallback ? value : fallback
  }
  if (!PRESETS.includes(out.preset)) out.preset = DEFAULT_PRESET
  out.particles = Number.isFinite(out.particles) ? Math.max(0, Math.min(40, Math.round(out.particles))) : DEFAULTS.particles
  out.glow = Number.isFinite(out.glow) ? Math.max(0, Math.min(1, out.glow)) : DEFAULTS.glow
  return out
}

/**
 * The config the surface layer runs with.
 *
 * `base` travels with the settings so the page knows where to send its report
 * without carrying its own copy of the route.
 * @param settings - the normalised settings.
 * @returns the surface layer's config.
 */
function surfaceConfig(settings) {
  return { enabled: true, preset: settings.preset, base: ROUTE }
}

/**
 * The config the ambience layer runs with.
 * @param settings - the normalised settings.
 * @returns the ambience layer's config.
 */
function ambienceConfig(settings) {
  return {
    enabled: true,
    background: settings.background,
    deepBackground: settings.deepBackground,
    particles: settings.particles,
    glow: settings.glow,
    keyGlow: settings.keyGlow,
    transitions: settings.transitions,
    activeRow: settings.activeRow,
    respectReducedMotion: settings.respectReducedMotion,
    diagnostics: settings.diagnostics,
    base: ROUTE,
  }
}

// How many times this row has taken part in an index render. Exposed on the
// status route because "the file is in place" and "the injection actually ran"
// are different facts, and only the second one matters.
let injections = 0

// The last report the surface layer sent. A surface layer fails SILENTLY: a
// stylesheet that never reaches the page looks exactly like a stylesheet whose
// rules do not match. So the client half says what it actually did, and this
// route hands that back - one line of truth instead of a guess.
let clientReport = null

// The last beat from the client half. The client half cannot show its own
// state to anyone but this route, so it sends one every few seconds: a beat
// that stops is a client half that is not running, which is a very different
// situation from a client half that is running and says nothing.
let clientHeartbeat = null

// Whatever went wrong with the newest surface report, if anything. It is kept
// apart from the report itself on purpose: a report that was cut off in flight
// (a page unloading mid-fetch, a request that never carried a body) must not
// replace the last good answer with a parse error, because the reader came
// for the state of the page, not for the state of the pipe.
let clientReportError = null

// The last few DOM reports the page sent back, newest first. This exists
// because the key-glow's fit was fixed twice from assumptions and was wrong
// twice: the page reports the ancestor chain it actually sees (tag, class,
// size, computed colour - never any text), and the fix is designed from that.
const reports = []
const REPORT_KEEP = 3
const REPORT_MAX_BYTES = 65536

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Mount the head injection, the status route, the settings route and the two
 * report sinks.
 * @param ctx - Host plugin context.
 * @param config - the applied config for this row.
 */
export function apply(ctx, config) {
  const server = ctx.webServer

  // The config this row is running with, read at request time. A profile row
  // can be edited while the app runs; the loader hands the new values to the
  // fiber, and a route that answered from the values it was mounted with
  // would keep telling the page the old story.
  const current = () => normalize(ctx.fiber?.config ?? config)

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/status`,
    handler: (req, res) => {
      sendJson(res, 200, {
        name,
        applied: true,
        settings: current(),
        presets: PRESETS,
        injections,
        client: clientReport,
        clientError: clientReportError,
        heartbeat: clientHeartbeat,
        reports,
      })
    },
  }), 'deepwater: status route')

  // The desktop app renders its own bundled SPA and never sees an index
  // injection, so its browser entry reads the effective settings back here.
  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/settings`,
    handler: (req, res) => {
      sendJson(res, 200, { name, settings: current() })
    },
  }), 'deepwater: settings route')

  // The last report the page sent, plus whatever went wrong with the newest
  // one.
  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/client-report`,
    handler: (req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim()) {
          try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
              // A heartbeat is its own thing: it says the client half is
              // alive and what it last heard from the host. It must not
              // overwrite the surface layer's own report, and the surface
              // report must not overwrite it.
              const { heartbeat, ...rest } = parsed
              if (heartbeat && typeof heartbeat === 'object') {
                clientHeartbeat = {
                  at: new Date().toISOString(),
                  ...heartbeat,
                }
              }
              if (Object.keys(rest).length > 0) {
                clientReport = {
                  at: new Date().toISOString(),
                  ...rest,
                }
              }
              clientReportError = null
            } else {
              clientReportError = { at: new Date().toISOString(), error: 'the report was not an object' }
            }
          } catch (error) {
            clientReportError = { at: new Date().toISOString(), error: String(error) }
          }
        } else {
          clientReportError = { at: new Date().toISOString(), error: 'the report arrived without a body' }
        }
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
      })
    },
  }), 'deepwater: surface report route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/report`,
    handler: (req, res) => {
      const store = (raw) => {
        let payload = null
        try { payload = JSON.parse(raw) } catch (error) { payload = null }
        if (!payload || typeof payload !== 'object') {
          sendJson(res, 400, { error: 'bad payload' })
          return
        }
        reports.unshift({ at: new Date().toISOString(), ...payload })
        while (reports.length > REPORT_KEEP) reports.pop()
        sendJson(res, 200, { stored: reports.length })
      }

      if (req.method === 'POST') {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > REPORT_MAX_BYTES) { req.destroy(); return }
          chunks.push(chunk)
        })
        req.on('end', () => store(Buffer.concat(chunks).toString('utf8')))
        req.on('error', () => {})
        return
      }
      // GET fallback: the payload rides in the query string, so a page that
      // cannot POST still gets its structure across.
      try {
        store(new URL(req.url ?? '/', 'http://localhost').searchParams.get('payload') ?? '')
      } catch (error) {
        sendJson(res, 400, { error: 'bad query' })
      }
    },
  }), 'deepwater: ambience report route')

  ctx.on('webserver/index-inject', (table) => {
    const settings = normalize(config)
    if (!settings.enabled) return

    const css = readSource(ctx, CSS_PATH)
    const surface = readSource(ctx, SURFACE_SCRIPT_PATH)
    const ambience = readSource(ctx, AMBIENCE_SCRIPT_PATH)
    const api = readSource(ctx, API_SCRIPT_PATH)
    if (!css || !surface || !api) return

    const withAmbience = settings.ambience !== false
    if (withAmbience && !ambience) return

    injections += 1

    // The rows are plain data in front of the scripts that read them, in the
    // order the scripts need them: the config global first, because the script
    // reads it while it evaluates.
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_DEEPWATER_CFG__=${JSON.stringify(settings)}`,
    })
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_DEEPWATER_BASE__=${JSON.stringify(ROUTE)}`,
    })
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_POLISH_CFG__=${JSON.stringify(surfaceConfig(settings))}`,
    })
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_POLISH_CSS__=${JSON.stringify(css)}`,
    })
    if (withAmbience) {
      table.push({
        kind: 'script',
        placement: 'head',
        text: `globalThis.__DSH_AMBIENT_FX_CFG__=${JSON.stringify(ambienceConfig(settings))}`,
      })
    }
    table.push({ kind: 'script', placement: 'head', text: surface })
    if (withAmbience) {
      table.push({ kind: 'script', placement: 'head', text: ambience })
    }
    table.push({ kind: 'script', placement: 'head', text: api })
  })
}

/**
 * Read one asset, warning instead of throwing: a missing file must leave the
 * app exactly as it was, not blank the page.
 * @param ctx - Host plugin context, for the warning.
 * @param path - absolute path to read.
 * @returns the file text, or an empty string.
 */
function readSource(ctx, path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`deepwater: cannot read ${path}: ${String(error)}`)
    return ''
  }
}
