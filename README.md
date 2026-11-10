# dsh-deepwater

A single DSH plugin that repaints the whole DeepSeek Harness window — a deep-sea
frame for the dark theme and a glacier frame for the light one — and takes all of
it back down again with one switch.

It merges two plugins that used to live side by side:

| layer | what it does | where it lives |
|---|---|---|
| **surface** | repaints the app's own design tokens (backgrounds, borders, code blocks, bubbles, shadows, scrollbars) | `src/polish.css`, `src/polish.js` |
| **ambience** | draws the environment behind the app: the sea gradient, the light shafts, the drifting motes, the glow around the composer, and the plate that hides the seam under the native window buttons | `src/ambient.js` |

Both layers are ordinary DOM and CSS. Nothing is patched into the application,
no build step is required to run it, and removing the plugin restores the
stock appearance exactly.

---

## The two palettes

**Dark — the deep sea.** Surfaces run from near-black teal (`#0c1720`) to a
lit slate (`#243b49`), the hairlines borrow the water's hue at the app's own
alpha strength, and the code blocks get their own step of the same ladder. The
composer carries a warm halo, because a cold composer in a cold frame reads as
unfinished.

**Light — glacier.** The old sea-blue ramp was the reason light mode felt flat:
its `bg-layer-1` was *lighter* than its `bg-base*, so the layers had no order.
The glacier ramp is laid out by real depth instead:

```
bg-base        #dce8f4    the page
bg-layer-1     #e8f1fa    cards, composer
bg-layer-2     #eff6fc    raised panels
bg-layer-3     #f6fafd    the lightest plane
sidebar-fill   #cdddf0    the side column and the caption strip
```

`sidebar-fill` is the same value Windows is told to paint the native caption
plate with, so the strip under the minimise / maximise / close buttons is
continuous with the column beside it.

## What the light frame adds

| token | value | why |
|---|---|---|
| `--dsw-alias-border-l4` | `rgba(20,50,80,.22)` | the outer hairline, one step past `l3` |
| `--dsw-shadow-lv1/lv2/lv3` | tinted deep-blue shadows | the app's own shadow tokens, recoloured to the sea instead of neutral black |
| `--dsw-alias-scrollbar-bg-l2` / `-hover-l2` | `#c3d6e9` / `#a8c4de` | a scrollbar that belongs to the frame |
| `--dsw-alias-interactive-bg-hover` / `-active` | `rgba(20,50,80,.07)` / `.13` | hover states that read as water rather than as grey |

The ambience layer was pulled back to match: the tint over the content is
subtler (`* 0.55` instead of `* 1.35`), the skylight is calmer (`.70`), and the
vignette is slightly stronger (`.26`) so the frame has depth instead of glare.

## One switch, and a clean way back

Everything the plugin paints is owned by the plugin. Turning the row off in the
DSH plugin panel tears the client half down, which runs its disposer:

```js
globalThis.__DSH_VISUAL_POLISH__.detach()   // removes the <style>, the attribute
globalThis.__DSH_AMBIENT_FX__.stop()         // removes the layers, restores the frame
```

and the window is exactly as the app shipped it — no orphaned elements, no
leftover background on the frame, no residue in the DOM.

The same thing is available at runtime from the page console:

```js
__DSH_DEEPWATER__.restore()   // take both layers down now
__DSH_DEEPWATER__.state()     // what is mounted right now
```

## Install

### From the repository

```bash
git clone https://github.com/SOUPLOONG520/dsh-deepwater.git
cd dsh-deepwater
node build-client.mjs          # regenerate client.js from src/
node verify/verify-deepwater.mjs
```

then add it to your profile:

```yaml
# <profile>/cordis.patch.yml
- insert:
  - id: deepwater
    name: dsh-deepwater
    config:
      enabled: true
      preset: roomy
      ambience: true
```

and make the package resolvable from the profile
(`<profile>/package.json` → `"dsh-deepwater": "link:/path/to/dsh-deepwater"`,
with `<profile>/node_modules/dsh-deepwater` pointing at the same directory).

`install.ps1` and `install.sh` do exactly that on a local profile.

### Why a build step exists at all

The desktop app loads plugins through a **browser entry** (`client.js`), not
through the Host's index injection — that is a desktop-only path. The Host
half still injects the same sources for the web client. So `src/` has to be
published twice, and `client.js` is generated from it. `client.js` is committed
to the repository so a plain `git clone` is enough to install.

## Configuration

| key | type | default | meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | the master switch. `false` paints nothing at all. |
| `preset` | `roomy` \| `compact` \| `minimal` | `roomy` | type scale, line height, radii, scrollbar width, markdown spacing. |
| `ambience` | boolean | `true` | `false` keeps the surfaces but drops the environment (gradient, motes, glow). |
| `background` | boolean | `true` | the ambient background gradient. |
| `deepBackground` | boolean | `true` | the deeper variant of that gradient. |
| `particles` | 0–40 | `6` | drifting motes in the ambience. |
| `glow` | 0–1 | `0.45` | strength of the ambience tint. |
| `keyGlow` | boolean | `true` | the halo that follows the focused composer. |
| `transitions` | boolean | `true` | the fade used when panels appear. |
| `activeRow` | boolean | `true` | the marker on the active sidebar row. |
| `respectReducedMotion` | boolean | `true` | honour `prefers-reduced-motion`. |
| `diagnostics` | boolean | `true` | the self-reporting channel (structure only, never your content). |

Values are clamped rather than rejected: `particles` is pinned to `0…40` and
`glow` to `0…1`, so a hand-edited profile can never put the frame into a state
it cannot draw.

## Routes

| route | method | purpose |
|---|---|---|
| `/plugins/dsh-deepwater/status` | GET | what the Host half is serving right now |
| `/plugins/dsh-deepwater/settings` | GET | the effective settings (the desktop entry reads this back) |
| `/plugins/dsh-deepwater/client-report` | POST | the surface layer's self report |
| `/plugins/dsh-deepwater/report` | POST | the ambience layer's self report |

The two report routes carry **structure only** — measured boxes, resolved
colours, theme flags. Nothing you type is ever sent.

## Development

```
src/ambient.js            the ambience layer
src/polish.css            the surface tokens
src/polish.js             the surface bootstrap
src/deepwater.js          the shared browser-side handle
entry.js                  the Host half: settings, routes, injection
build-client.mjs          src/ -> client.js
verify/verify-deepwater.mjs   package shape, Host half, one-click restore, browser entry
verify/verify-polish.mjs      the surface layer's four style contracts
verify/verify-ambient.mjs     the ambience layer, 149 checks
```

```bash
node build-client.mjs
node verify/verify-deepwater.mjs   # 51 checks
node verify/verify-polish.mjs      # 44 checks
node verify/verify-ambient.mjs     # 149 checks
```

The four style contracts the surface layer is held to:

1. **tokens** — every custom property it overrides is one the app actually
   publishes, and it never overrides the reader's own font size.
2. **cascade** — every selector is scoped to `html[data-polish]…`, so the app
   wins where the package does not intend to.
3. **calm** — no keyframes, no animations, no transitions, no `!important`.
4. **theme-safe** — colour literals live only inside a themed block, the dark
   frame's literals are all actually dark, and the two frames never share a
   surface colour.

## Notes for anyone changing this

- **The desktop app snapshots its index injection at startup.** Changing
  `src/polish.css` needs a restart of the desktop app; the web client only
  needs a reload. Changing `client.js` needs the host to re-reconcile, which it
  does on its own within about half a second.
- **A stale revision in the boot manifest is fatal.** If you rebuild
  `client.js` while the desktop app is running, the app's captured boot
  manifest can still point at the previous revision, which now answers `404`,
  and the renderer stops at *Loading plugins…*. Restart the desktop app after
  a rebuild — and check that the new revision is being served before you do.
- **The client half has no configuration channel.** The Host hands settings to
  the page through globals injected at index render; the desktop app instead
  falls back to the defaults compiled into `client.js` and reads the live
  settings back from `/plugins/dsh-deepwater/settings`.

## Screenshots

![the light frame](docs/light-frame.png)
![the corner](docs/light-corner.png)

## License

MIT — see [LICENSE](LICENSE).
