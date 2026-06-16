# Throttlr — Dev Notes v3.1.3.2

**Release date:** June 2026
**Type:** Feature + bug-fix patch over v3.1.3.1
**Headline:** Multi-Target per-app settings + cleaner single-target exit

---

## What shipped

### 1. Per-app settings in Multi-Target (the big one)
Each targeted app now carries its **own** independent function configuration
(Lag / Drop / Throttle / Freeze / Block / Fun) instead of all targeted apps
sharing one global config.

- A **PER-APP tab bar** (`#mt-tabs`) renders above the Functions section,
  one tab per targeted app. It is only visible while Multi-Target is on.
- Switching tabs saves the outgoing app's control values and loads the
  incoming app's values (value-swap model — the Functions DOM stays single,
  only the values + the per-app engine config change).
- Throttle uses an **independent token bucket per app**, so two throttled
  apps no longer share a single bandwidth cap.
- All six functions are applied per-app because the packet worker is fully
  config-driven (it reads `cfg.lag_on`, `cfg.drop_on`, `cfg.throttle_on`,
  `cfg.freeze_on`, `cfg.block_on`, `cfg.fun_mode` from the *selected* config).

### 2. Turning Multi-Target off now asks which app to keep
Switching back to single-target with 2+ apps targeted opens a chooser modal
(`#mt-collapse-modal`) so the user picks the one app to keep, instead of the
old behavior of silently collapsing to the first app. Leaving Multi-Target
also **resets all functions** to defaults.

### 3. Fixes
- **Target now actually narrows on collapse.** Previously the chosen app
  showed in the UI but the engine kept the full target set (and the overlay
  still listed every app), so the others kept getting throttled.
- **Per-app configs now reach the engine reliably**, so each app is throttled
  with its own settings rather than inheriting whichever tab was last touched.
  (Root cause of both: several bridge calls were guarded with `window.bridge`,
  but `bridge` is a module-scoped `let`, never attached to `window` — so the
  guarded calls silently never fired. All call sites now use the bare
  `bridge`.)

---

## Engine architecture (throttlr.py)

**`FilterConfig`**
- Added `pid_to_app: dict` — maps every targeted PID (root + child processes)
  to its owning app name.

**Controller**
- Added `self.per_app_cfgs: dict[str, FilterConfig]` — per-app configs. When
  empty, the engine behaves exactly as before (single shared config).
- Added `self.throttle_state_by_app: dict` — per-app token buckets.

**`_refresh_target_pids()`**
- Builds `pid_to_app` alongside `target_pids` (roots from the name match,
  children inherit the root's app name).

**Worker loop (per-packet)**
- The per-packet config binding now selects the per-app config:
  `cfg = self.config`; if `per_app_cfgs` is non-empty, look up the packet's
  app via `pid_to_app` and use that app's config. Single-target path is
  byte-identical to v3.1.3.1.

**`_consume_token(pkt, size, kbps, app=None)`**
- Added an `app` parameter + a per-app token-bucket branch. With no app /
  empty `per_app_cfgs` it uses the original controller-level bucket unchanged.

**Bridge slots**
- `_filter_config_from_dict(data, base)` — shared builder used by both the
  global config path and the per-app path (single source of truth for the
  JS-preset → FilterConfig mapping).
- `updateAppConfig(app_name, json_str)` — store one app's FilterConfig.
- `clearAppConfigs()` — drop all per-app configs + per-app throttle buckets
  (called when Multi-Target is turned off).

---

## Front-end (ui/app.js, ui/index.html, ui/style.css)

- State: `mtAppCfg = { app: {data-key: value} }`, `mtActiveApp`.
- Helpers: `readFuncControls()`, `writeFuncControls()`, `funcDefaults()`,
  `resetFuncControls()`, `buildMtTabs()`, `switchMtTab()`,
  `enterMultiTargetUI()`, `pushAllMtConfigs()`.
- `collapseToSingle(name)` / `openMtCollapseChooser()` — the keep-one-app flow.
- `pushConfig()` routes to `updateAppConfig(mtActiveApp, …)` while in
  Multi-Target, else the global `updateConfig(…)`.
- Tab bar markup `#mt-tabs` inserted between the Functions panel header and the
  `.functions` grid. Styles: `.mt-tabs`, `.mt-tab(.active)`, `.mtc-*`.

---

## Known limitation
Freeze and Block apply per-app via each app's config, but they share one
underlying hold-queue in the engine, so unusual freeze/block combinations
across multiple apps use shared queue mechanics rather than fully isolated
per-app queues. Lag, Drop, and Throttle are fully independent per app.

---

## Unchanged invariants
- Inno Setup AppId `{2F502D18-1D8D-414E-953C-7CBDDA8B1BAD}`, installer name
  `Throttlr-Setup.exe` — unchanged.
- Single-target behavior is byte-identical to v3.1.3.1 (the new paths only
  activate when per-app configs exist).
- No account, no telemetry. Windows 10/11 x64, admin/UAC required.
