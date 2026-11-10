// dsh-deepwater - the browser-side API of the unified theme.
//
// The two layers this package ships are independent of each other and each has
// its own teardown: the surface layer (polish) removes its <style> and its
// `data-polish` attribute, the ambience layer (ambient) removes its nodes and
// gives the app's own frame its background back. This file is the one place
// that knows about both, so "put the app back the way it was" is a single
// call rather than two, and the caller does not have to know which layer is
// currently mounted.
//
// It installs nothing. The Host half injects the layers, and the desktop
// browser entry injects the very same sources, so by the time this file runs
// the layers are already up and only the API is missing.
//
// It is deliberately small and dependency-free: it is injected as a head row on
// the web client and embedded in the browser entry for the desktop app, and it
// must not be the reason either of them fails to boot.

;(function () {
  'use strict'

  var G = globalThis

  // The route the package serves under. The Host half injects it, so a page
  // that loaded the sources from somewhere else still knows where to report.
  var BASE = (typeof G.__DSH_DEEPWATER_BASE__ === 'string' && G.__DSH_DEEPWATER_BASE__)
    ? G.__DSH_DEEPWATER_BASE__
    : '/plugins/dsh-deepwater'

  /**
   * The effective settings the layers were installed with.
   *
   * The Host half injects the whole normalised object; the desktop entry bakes
   * the defaults in and then replaces them with the live ones it reads back
   * from the settings route. Either way this is the truth the page is running
   * under, which is what a status read has to report.
   * @returns the settings object, or an empty object when nothing was injected.
   */
  function settings() {
    var cfg = G.__DSH_DEEPWATER_CFG__
    return cfg && typeof cfg === 'object' ? cfg : {}
  }

  /**
   * Whether one layer is mounted right now.
   *
   * Both layers publish an `active` flag that their own teardown clears, so
   * this is a real answer rather than a guess from a global that may never
   * have existed.
   * @param key - the global's name.
   * @returns true when the layer is up.
   */
  function layerActive(key) {
    var layer = G[key]
    return !!(layer && layer.active)
  }

  /**
   * Put the app back the way it was before this package touched it.
   *
   * This is the "restore the default look" half of the one-click switch: the
   * surface layer's stylesheet and attribute go, the ambience layer's nodes go,
   * and the app's own frame background comes back. It is safe to call twice and
   * safe to call when neither layer is up.
   * @returns which layers were actually torn down.
   */
  function restore() {
    var torn = { surface: false, ambience: false }
    try {
      if (G.__DSH_VISUAL_POLISH__ && typeof G.__DSH_VISUAL_POLISH__.detach === 'function') {
        G.__DSH_VISUAL_POLISH__.detach()
        torn.surface = true
      }
    } catch (error) {
      console.warn('[deepwater] the surface layer did not detach cleanly', error)
    }
    try {
      if (G.__DSH_AMBIENT_FX__ && typeof G.__DSH_AMBIENT_FX__.stop === 'function') {
        G.__DSH_AMBIENT_FX__.stop()
        torn.ambience = true
      }
    } catch (error) {
      console.warn('[deepwater] the ambience layer did not stop cleanly', error)
    }
    return torn
  }

  /**
   * What is actually mounted, read from the layers themselves.
   *
   * The status route on the Host side reports what the Host believes; this is
   * what the page believes. When they disagree, the page is running something
   * else, and that is worth knowing.
   * @returns a small plain object describing the live state.
   */
  function state() {
    var cfg = settings()
    return {
      base: BASE,
      enabled: cfg.enabled !== false,
      preset: typeof cfg.preset === 'string' ? cfg.preset : 'roomy',
      ambience: cfg.ambience !== false,
      surface: layerActive('__DSH_VISUAL_POLISH__'),
      ambienceLayer: layerActive('__DSH_AMBIENT_FX__'),
    }
  }

  G.__DSH_DEEPWATER__ = {
    active: true,
    base: BASE,
    settings: settings,
    state: state,
    restore: restore,
  }
})()
