# Throttlr v3.1.3 — Developer Notes

Internal/technical notes for the 3.1.3 release. Companion to the user-facing
changelog (in `throttlr.py` `CHANGELOG[]` and the GitHub release body).

**Release theme:** visual overhaul (anime.js), session stopwatch, start-time
validation + screen-level notifications, speed-test false-block fix.

---

## Version & build

- `__version__` → `3.1.3` (`throttlr.py`)
- `throttlr.iss` `#define AppVersion "3.1.3"` (drives Add/Remove Programs entry + auto-updater compare)
- Auto-updater compares GitHub release tag vs `__version__` via `_parse_version()`. Tag the release `v3.1.3` (or `3.1.3`) on `throttlr-releases`.
- No new build steps. `build.bat` still bundles the whole `ui/` folder via PyInstaller `--add-data "ui;ui"`, so all new UI assets ship automatically (see asset list below).

### New bundled UI assets (all under `ui/`, auto-included)
| File | Size | Purpose |
|------|------|---------|
| `anime.min.js` | ~113 KB | anime.js v4.4.1 UMD build (exposes global `anime`) |
| `dseg7.woff2` | ~5 KB | DSEG7 Classic Bold seven-segment font (SIL OFL), from npm `dseg@0.46.0` |
| `buy-coffee.png` | ~5.5 KB | Coffee-cup donate icon (white silhouette, alpha = shape, used as CSS mask) |
| `save-icon.png` | ~3.3 KB | Floppy-disk save icon (same mask technique) |

---

## Architecture additions

### 1. Animation engine — `Anim` (ui/app.js, top of file)

Single wrapper around anime.js that **every** animation routes through. Central
gate so the disable toggle is universal.

- `Anim.enabled` getter = `hasAnime && userEnabled && !prefersReducedMotion`.
  - `hasAnime`: anime.js global present.
  - `userEnabled`: from the `animations_enabled` setting.
  - `prefersReducedMotion`: live `matchMedia('(prefers-reduced-motion: reduce)')`.
- Helpers: `fadeIn, pop, slideIn, staggerIn, countUp, pulse, shake, raw, timeline`.
- When disabled, helpers no-op but **apply the end-state** (`_applyEndState`) so
  layout still settles correctly (opacity/transform left at final values).
- `Anim.setEnabled(bool)` flips `userEnabled` and syncs `body[data-animations]`.
- Raw access: `Anim.lib` (the anime global) for advanced one-off calls.

**CSS half of the toggle:** `body[data-animations="off"] *` zeroes
`transition-duration`/`animation-duration` (0.001ms). Status indicators
(running pulse dot, start-msg dot) are explicitly kept alive with overrides.
Body ships with `data-animations="on"` so first paint is correct before JS runs.

**Settings wiring (`animations_enabled`, default `True`):** serialized
generically (getSettings dumps the whole dict, saveSettings accepts any
DEFAULT_SETTINGS key), so no bridge changes. Wired in 6 places: default,
populate-on-open, live change handler, save, applyAppearance, cancelSettings.

**Removed:** all legacy Animate.css classes (`animate__animated` etc.) from
panels and func-mods (11 occurrences) — they wouldn't respect the toggle and
double-animated. Entrance now handled by the `Anim.staggerIn` block in `init()`.

### 2. Session stopwatch — `Stopwatch` (ui/app.js) + overlay (throttlr.py)

- JS module uses `anime.lib.createTimer({ frameRate: 4 })` for the tick loop
  (falls back to `setInterval(250)` if anime unavailable — clock is functional
  info, not decoration, so it must run even with animations off).
- Started/stopped from `onStatusChanged`.
- **Seven-segment display:** `#ab-sw-time` (live) layered over `#ab-sw-ghost`
  (dim "88:88" all-segments-lit) using the DSEG7 font. Ghost width auto-matches
  format (`88:88` vs `8:88:88` past 1h).
- **State machine:** `start()` → reset to `00:00`, `.running` (green), remove
  `.stopped`. `stop()` → freeze on final time, `.stopped` (red), stays visible
  (does NOT hide). Next `start()` resets.
- **Overlay mirror via `setOverlayStopwatch(float ms)` bridge slot:**
  - `ms >= 0` → running, green.
  - `ms == -1` → hide (reset / exit).
  - `ms <= -2` → stopped/frozen; real ms = `-(ms) - 1`, painted red.
  - Encoding lets a single float channel carry value + stopped flag.
  - Overlay side: `_stopwatch_ms`, `_stopwatch_stopped`, `set_stopwatch()`,
    `_fmt_stopwatch()`; painted in `_row_status` right slot (green=running,
    red=stopped, falls back to KB/s / brand when inactive). Uses `\u23f1` glyph.

### 3. Start validation + notifications (ui/app.js `handleStartClick`)

- Two checks: no app (`!currentApp`), no function (`!any .toggle-input:checked`).
- `notifyStartError(msg)` fires **three** channels, each try/caught so one
  failing can't suppress the others, and **before** any decorative anim:
  1. `showStartMsg()` — inline pill `#start-msg` next to Start (slide in, hold
     4.2s, fade out). Restyled as a dark pill with pulsing red dot.
  2. `toast(msg, 'error')` — in-app toast (top-right of app window).
  3. `bridge.showScreenNotification(msg, 'error')` — see below.

### 4. Screen-level notification — `ScreenNotification` (throttlr.py)

- New `QWidget`: frameless, `WindowStaysOnTopHint | Tool | WindowDoesNotAcceptFocus`,
  translucent, `WA_ShowWithoutActivating`.
- Positions at top-right of `primaryScreen().availableGeometry()` — i.e. the
  actual **screen** corner, independent of the app window (the prior in-app
  toast sat at the app-window corner, which is what the user was missing).
- Fade via `QPropertyAnimation` on `windowOpacity` (240ms in, ~3.2s hold, 420ms
  out → hide). Single reused instance; re-call restarts the timer.
- Bridge slot `showScreenNotification(str message, str kind)` lazily constructs
  `self._screen_notif`. `kind` ∈ {error, success, info} → accent color.
- New imports: `QPropertyAnimation, QEasingCurve, QAbstractAnimation` (QtCore);
  `QLabel, QVBoxLayout` (QtWidgets).

---

## Bug fixes (technical)

### Speed-test false block — the headline fix
`runFullSpeedtest()` had two guards. The second blocked when *any* function
toggle (`cfg.lag_on/drop_on/throttle_on/freeze_on/block_on`) was set — **even
with capture stopped** — emitting `phase: "blocked"` ("Throttlr is still
running"). But functions only affect traffic inside `_capture_loop`, which runs
only while `controller.running`. So a checked-but-idle toggle was a false
positive. **Removed the `active_funcs` block entirely**; `controller.running`
(set True only when WinDivert opens, False on stop) is now the sole guard.

### Modal flicker race
`hideModal` scheduled `setTimeout(()=>hidden=true, 180)` without cancelling a
prior pending timer; reopening within 180ms let the stale timer hide the fresh
modal. Fix: track `m._closeTimer` on the element, clear it in both `showModal`
and `hideModal`.

### Action-bar layout shift
`.ab-status` was `flex-shrink:0` but variable width — the Stopped↔Running label,
sub-text changes, and stopwatch appearing all changed its width, shifting the
`flex:1` centered mini-stats. Fix: `.ab-status` locked to `width:360px;
overflow:hidden`; `.ab-status-text` fixed `168px` with ellipsis truncation.

### Theme-preserve + light-tone detection (carried from earlier in cycle)
- `populateSettingsUI`/`cancelSettings` check DOM (`body.dataset.customTheme`),
  memory (`window._activeCustomThemeId`), and saved (`s.active_custom_theme`)
  before re-applying, so an unsaved custom theme isn't clobbered.
- `detectAndApplyBgTone()` samples `--bg-2` (card/modal bg) not `--bg` (body);
  runs on all four theme paths (applyTheme/applyDesign/applyCustomTheme/
  customization overrides) via rAF.

### Lag drain precision (carried)
Drain loop sleeps to the next packet's release deadline instead of 1ms polling.

---

## Risk / QA notes (couldn't be verified in CI — needs on-device check)

These all depend on QtWebEngine / Windows runtime behavior that static checks
(`ast.parse`, `node --check`, grep) can't cover:

1. **DSEG7 font load** — if `@font-face url(dseg7.woff2)` fails, stopwatch falls
   back to Consolas (still a digital readout, not segmented). Confirm digits are
   segmented and the colon renders; confirm ghost layer aligns behind live time.
2. **ScreenNotification** — confirm it appears at the *screen* top-right (not app
   corner) and fades. `windowOpacity` fade is reliable on Windows; if it pops
   without fading on some compositor, switch to a widget-level opacity effect.
3. **Overlay stopwatch glyph** — `\u23f1` (⏱) painted in Consolas/Impact may
   render as tofu; drop the glyph if so.
4. **Entrance flash** — panels paint, then `Anim.staggerIn` sets opacity:0 →
   animates in; watch for a one-frame flash on slower machines.
5. **Animation perf** — anime.js is light, but the launch stagger + per-interaction
   anims run in QtWebEngine; trim if janky on Billy's hardware.
6. **Speed-test fix is the priority test:** toggle Lag on, leave capture stopped,
   run Test My Speed → must run (not block). Then start capture → must block.

## Static validation run pre-bundle
- `python3 -c "import ast; ast.parse(open('throttlr.py').read())"` → OK
- `node --check ui/app.js` → OK
- anime.umd integrity (header + export tail) → OK

## Distribution
- Private source: `github.com/BillysMatrix18/throttlr`
- Public binaries: `github.com/BillysMatrix18/throttlr-releases` (tag `v3.1.3`)
- Site: `throttlr.netlify.app` (download buttons auto-resolve latest .exe via
  GitHub API + `data-auto-version`, so no site edit needed for the version label)
