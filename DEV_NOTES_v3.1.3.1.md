# Throttlr v3.1.3.1 — Developer Notes

Internal/technical notes for the 3.1.3.1 patch. Companion to the user-facing
changelog (in `throttlr.py` `CHANGELOG[]` and the GitHub release body).

**Release theme:** pure bug-fix patch on top of 3.1.3 — profile-import UI
refresh, speed-test "apply %" wiring, hotkey-conflict rebind button, and two
application-picker glitches. No new features, no new dependencies.

---

## Version & build

- `__version__` → `3.1.3.1` (`throttlr.py`)
- `throttlr.iss` `#define AppVersion "3.1.3.1"` (drives Add/Remove Programs entry + installer metadata)
- Auto-updater compares the GitHub release tag vs `__version__` via `_parse_version()`. `_parse_version()` already handles four-part versions — `"3.1.3.1"` parses to `(3, 1, 3, 1)`, which compares greater than `(3, 1, 3)`, so existing 3.1.3 installs will see the update. Tag the release `v3.1.3.1` (or `3.1.3.1`) on `throttlr-releases`.
- No new build steps and no new bundled assets. `build.bat` is unchanged.

---

## Fixes

### 1. Profile import didn't refresh the function controls (+ "NaN" stat flash)

**Files:** `throttlr.py` (new `getConfig` slot), `ui/app.js` (`onStatsChanged`)

**Symptom:** After importing a `.throttlr` profile, the function modifiers were
applied to the live controller config, but the on-screen toggles/fields kept
showing the *old* values until some other event forced a redraw. Separately,
the live "bytes" stat briefly rendered the literal string `NaN` on import.

**Root cause:** Two intended refresh paths were both dead:
- `app.js` called `bridge.getConfig()` after an import, but no `getConfig`
  `@Slot` existed on the Python `Bridge` — the call was guarded
  (`bridge.getConfig && …`), so it silently no-op'd.
- `importProfileJson()` emits `statsChanged({"_force_refresh": true})` to ask
  the UI to re-sync, but `onStatsChanged()` had no handling for that payload.
  It fell straight through to the stat renderer, where
  `(s.bytes / 1024).toFixed(1)` on an undefined `bytes` produced `"NaN"`.

**Fix:**
- Added `@Slot(result=str) def getConfig(self)` returning the live function
  config as JSON, keyed identically to a profile's `function_config`
  (`lag_on`, `throttle_kbps`, …) so `applyProfileData()` consumes it directly.
- Guarded `onStatsChanged()`: if `s._force_refresh` is set, re-pull the config
  via `bridge.getConfig().then(applyProfileData)` and `return` *before* the
  stat-rendering block — kills the NaN flash and re-syncs the controls.

### 2. Speed-test "apply X%" buttons did nothing

**File:** `ui/app.js`

**Symptom:** The buttons that set Throttle to a percentage of the measured line
speed showed the "Throttle set to N KB/s" toast but never changed the field or
enabled the toggle.

**Root cause:** They looked the controls up by id —
`getElementById('throttle-kbps')` / `getElementById('throttle-on')` — but those
elements carry no id; they're addressed by `data-key="throttle_kbps"` /
`data-key="throttle_on"`. Both lookups returned `null` behind `if` guards, so
the writes were skipped silently.

**Fix:** Switched the lookups to
`document.querySelector('.func-mod [data-key="throttle_kbps"]')` and
`…[data-key="throttle_on"]`.

### 3. Hotkey-conflict "rebind" button did nothing

**File:** `ui/app.js`

**Symptom:** When a hotkey conflict popup appeared, its rebind action (open
Settings → Hotkeys) had no effect.

**Root cause:** It tried `getElementById('open-settings-btn')` with a
`[data-open-settings]` fallback — neither exists. The real settings opener is
`#settings-btn`.

**Fix:** Pointed the handler at `document.getElementById('settings-btn')`.

### 4. App picker re-played its entrance animation on every refresh / hover

**File:** `ui/app.js` (`renderAppPicker`, `appsRefreshed` handler, `setupAppChooser`)

**Symptom:** The application list re-ran its staggered entrance animation
roughly once a second (and appeared to do so while hovering), and rows were
rebuilt out from under the cursor.

**Root cause:** `renderAppPicker()` ran `Anim.staggerIn(...)` on every call, and
the periodic `appsRefreshed` signal called it on each tick while the modal was
open — wiping `innerHTML` and re-staggering each time.

**Fix:**
- `renderAppPicker(animate = false)` — the stagger now runs only when `animate`
  is true (picker open + tab switch). Search input and the periodic refresh
  pass `false`.
- The `appsRefreshed` handler now skips the re-render entirely while the pointer
  is over `#ap-list` (`_apListHover` flag, set on `mouseenter`/`mouseleave`),
  and re-renders once on `mouseleave` to catch up. Rows no longer rebuild under
  the cursor.

### 5. Stray horizontal scrollbar on the Background apps list

**File:** `ui/style.css` (`.app-list`, `.ap-body .app-list`)

**Symptom:** Hovering a row in the Background tab spawned a horizontal scrollbar
along the bottom of the list.

**Root cause:** `.app-item:hover { transform: translateX(2px); }` nudges each row
2px right. With `overflow-y: auto` set and `overflow-x` left at its initial
value, the browser computes `overflow-x: auto`, so that 2px overflow triggered a
horizontal scrollbar.

**Fix:** Added `overflow-x: hidden` to `.app-list` and `.ap-body .app-list`.

---

## Testing checklist (Windows)

- Import a `.throttlr` profile → the function toggles/fields update immediately,
  no `NaN` flash on the traffic counter.
- Run the speed test, click an "apply %" button → Throttle turns on and the
  KB/s field reflects the chosen percentage.
- Trigger a hotkey conflict → the popup's rebind button opens Settings → Hotkeys.
- Open the app picker → entrance animation plays once; leave it open and watch a
  refresh tick → no re-stagger; hover the list → no rebuild/flicker.
- Background tab → hover rows → no horizontal scrollbar.
