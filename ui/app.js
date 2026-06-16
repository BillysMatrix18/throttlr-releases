/* ============================================================
   THROTTLR // app.js
   ============================================================ */

/* ============================================================
   v3.1.2 — ANIMATION ENGINE (anime.js v4)
   ------------------------------------------------------------
   A thin wrapper around anime.js that ALL animations route
   through. One central gate (`Anim.enabled`) means the
   "Disable animations" toggle in Settings → Appearance can
   switch off every animation app-wide in one flip — including
   respecting the OS-level prefers-reduced-motion setting.

   Usage anywhere in app.js:
       Anim.fadeIn(el);
       Anim.pop(el);
       Anim.slideIn(el, { from: 'left' });
       Anim.stagger('.preset-card', { y: [12, 0], opacity: [0, 1] });
       Anim.countUp(el, 593);
       Anim.pulse(el);
       Anim.shake(el);

   If animations are disabled, every helper becomes a no-op that
   instantly applies the END state (so the UI still ends up
   looking correct — just without the motion).
   ============================================================ */
const Anim = (function () {
  // anime.js v4 UMD exposes a global `anime` with named methods.
  const A = (typeof anime !== 'undefined') ? anime : null;
  const hasAnime = !!(A && A.animate);

  // OS-level reduced-motion preference. If the user has asked their
  // system to minimise motion, we respect that regardless of the
  // in-app toggle — accessibility first.
  let prefersReduced = false;
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReduced = mq.matches;
    mq.addEventListener?.('change', (e) => { prefersReduced = e.matches; });
  } catch (e) { /* matchMedia not available — assume no preference */ }

  const state = {
    // In-app toggle. Defaults ON; openSettings/applyAppearance set it
    // from the persisted `animations_enabled` setting.
    userEnabled: true,
  };

  // The single source of truth every helper checks.
  Object.defineProperty(state, 'enabled', {
    get() { return hasAnime && this.userEnabled && !prefersReduced; },
  });

  // Reflect state onto <body data-animations="on|off"> so CSS can
  // also disable its own transitions/keyframes in one place.
  function syncBodyAttr() {
    document.body.dataset.animations = state.enabled ? 'on' : 'off';
  }

  function setEnabled(on) {
    state.userEnabled = !!on;
    syncBodyAttr();
  }

  // ---- Helpers ----------------------------------------------------
  // Each returns the anime.js instance (or null when disabled) so
  // callers can chain .then(...) via the WAAPI-like .completed promise
  // if they need to, but never have to.

  function animate(targets, params) {
    if (!state.enabled) {
      // No-op: snap to the declared end-state so layout is still correct.
      _applyEndState(targets, params);
      return null;
    }
    try { return A.animate(targets, params); }
    catch (e) { return null; }
  }

  // When disabled, apply the final value of each animated prop so the
  // element ends up where the animation would've left it.
  function _applyEndState(targets, params) {
    try {
      const els = _resolve(targets);
      const skip = new Set(['duration','delay','easing','ease','loop',
        'direction','autoplay','onComplete','complete','onBegin','begin',
        'onUpdate','update','stagger','composition','onScroll','playbackRate']);
      els.forEach((el) => {
        for (const k in params) {
          if (skip.has(k)) continue;
          let v = params[k];
          if (Array.isArray(v)) v = v[v.length - 1];      // [from, to] → to
          if (v == null || typeof v === 'object') continue;
          if (k === 'opacity') el.style.opacity = v;
          else if (k === 'x' || k === 'translateX') el.style.transform = `translateX(${_px(v)})`;
          else if (k === 'y' || k === 'translateY') el.style.transform = `translateY(${_px(v)})`;
          else if (k === 'scale') el.style.transform = `scale(${v})`;
          else if (k === 'rotate') el.style.transform = `rotate(${_deg(v)})`;
          else { try { el.style[k] = v; } catch (e) {} }
        }
      });
    } catch (e) { /* best-effort */ }
  }
  function _px(v) { return typeof v === 'number' ? v + 'px' : v; }
  function _deg(v) { return typeof v === 'number' ? v + 'deg' : v; }
  function _resolve(t) {
    if (!t) return [];
    if (typeof t === 'string') return Array.from(document.querySelectorAll(t));
    if (t instanceof Element) return [t];
    if (t.length != null) return Array.from(t);
    return [t];
  }

  // Fade + tiny rise. The workhorse entrance animation.
  function fadeIn(targets, opts = {}) {
    return animate(targets, {
      opacity: [0, 1],
      y: [opts.distance ?? 8, 0],
      duration: opts.duration ?? 380,
      delay: opts.delay ?? 0,
      ease: opts.ease ?? 'out(3)',
    });
  }

  // Quick scale-up "pop" — good for buttons, badges, confirmations.
  function pop(targets, opts = {}) {
    return animate(targets, {
      scale: [opts.from ?? 0.8, 1],
      opacity: [0, 1],
      duration: opts.duration ?? 320,
      ease: opts.ease ?? 'outBack(1.7)',
    });
  }

  // Slide in from an edge.
  function slideIn(targets, opts = {}) {
    const from = opts.from ?? 'bottom';
    const dist = opts.distance ?? 20;
    const axis = (from === 'left' || from === 'right') ? 'x' : 'y';
    const sign = (from === 'left' || from === 'top') ? -1 : 1;
    const params = {
      opacity: [0, 1],
      duration: opts.duration ?? 420,
      delay: opts.delay ?? 0,
      ease: opts.ease ?? 'out(3)',
    };
    params[axis] = [sign * dist, 0];
    return animate(targets, params);
  }

  // Staggered entrance across a set of elements (lists, grids).
  function staggerIn(targets, opts = {}) {
    if (!state.enabled) { _applyEndState(targets, { opacity: 1, y: 0 }); return null; }
    return animate(targets, {
      opacity: [0, 1],
      y: [opts.distance ?? 12, 0],
      duration: opts.duration ?? 420,
      delay: A.stagger(opts.each ?? 45, { start: opts.start ?? 0 }),
      ease: opts.ease ?? 'out(3)',
    });
  }

  // Count a number up from 0 (or a given start) to a target value.
  // Respects formatting (commas) and optional decimals.
  function countUp(el, target, opts = {}) {
    if (!el) return null;
    const decimals = opts.decimals ?? 0;
    const fmt = (n) => {
      const fixed = Number(n).toFixed(decimals);
      return opts.commas === false ? fixed
        : Number(fixed).toLocaleString('en-US',
            { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    };
    if (!state.enabled) { el.textContent = (opts.prefix ?? '') + fmt(target) + (opts.suffix ?? ''); return null; }
    const obj = { v: opts.from ?? 0 };
    return A.animate(obj, {
      v: target,
      duration: opts.duration ?? 900,
      ease: opts.ease ?? 'out(3)',
      onUpdate: () => { el.textContent = (opts.prefix ?? '') + fmt(obj.v) + (opts.suffix ?? ''); },
    });
  }

  // Attention pulse — subtle scale breathing once (or N times).
  function pulse(targets, opts = {}) {
    if (!state.enabled) return null;
    return A.animate(targets, {
      scale: [1, opts.peak ?? 1.06, 1],
      duration: opts.duration ?? 520,
      ease: 'inOut(2)',
      loop: opts.loop ?? 1,
    });
  }

  // Error shake — horizontal wobble. Used for invalid input, failures.
  function shake(targets, opts = {}) {
    if (!state.enabled) return null;
    return A.animate(targets, {
      x: [0, -6, 6, -4, 4, -2, 2, 0],
      duration: opts.duration ?? 420,
      ease: 'inOut(2)',
    });
  }

  // Smooth number/length along an SVG path or generic value — exposed
  // for callers that want raw access to anime under the same gate.
  function raw(targets, params) { return animate(targets, params); }

  // Timeline passthrough (gated). Returns null when disabled.
  function timeline(opts) {
    if (!state.enabled) return null;
    try { return A.createTimeline(opts || {}); }
    catch (e) { return null; }
  }

  return {
    get enabled() { return state.enabled; },
    get lib() { return A; },              // raw anime.js for advanced use
    hasAnime,
    setEnabled,
    syncBodyAttr,
    animate, raw, timeline,
    fadeIn, pop, slideIn, staggerIn, countUp, pulse, shake,
  };
})();

let bridge = null;

/* ============================================================
   v3.1.2 — SESSION STOPWATCH
   ------------------------------------------------------------
   Starts when capture starts, stops when it stops. Drives the
   in-app display (#ab-sw-time) and mirrors the elapsed time to
   the floating overlay via bridge.setOverlayStopwatch(ms).

   Uses anime.js's createTimer for the tick loop when animations
   are available; falls back to a plain setInterval otherwise, so
   the clock keeps running even with animations disabled (the
   stopwatch is functional info, not decoration).
   ============================================================ */
const Stopwatch = (function () {
  let startTs = 0;
  let elapsedMs = 0;
  let animTimer = null;   // anime.js Timer instance
  let intervalId = null;  // setInterval fallback
  let running = false;

  function fmt(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // The "ghost" layer shows every segment lit ("8") so the unlit segments
  // of the real digits read like an LCD. It has to match the live time's
  // width/format exactly, so we mirror its shape: 8:88:88 when hours are
  // shown, otherwise 88:88.
  function ghostFor(ms) {
    return ms >= 3600000 ? '8:88:88' : '88:88';
  }

  function tick() {
    elapsedMs = Date.now() - startTs;
    const el = document.getElementById('ab-sw-time');
    const ghost = document.getElementById('ab-sw-ghost');
    const formatted = fmt(elapsedMs);
    if (el) el.textContent = formatted;
    if (ghost) ghost.textContent = ghostFor(elapsedMs);
    // Mirror to the overlay (best-effort — slot may not exist on old builds)
    try {
      if (bridge && bridge.setOverlayStopwatch) bridge.setOverlayStopwatch(elapsedMs);
    } catch (e) { /* ignore */ }
  }

  function start() {
    if (running) return;
    running = true;
    startTs = Date.now();
    elapsedMs = 0;
    const wrap = document.getElementById('ab-stopwatch');
    if (wrap) {
      wrap.hidden = false;
      wrap.style.opacity = '';            // clear any leftover fade from a prior stop
      // v3.1.2 — reset to the running (green) state on every start
      wrap.classList.remove('stopped');
      wrap.classList.add('running');
      // Pop the stopwatch in when it appears
      if (typeof Anim !== 'undefined') Anim.pop(wrap, { from: 0.7, duration: 360 });
    }
    tick();
    // Prefer anime.js timer; fall back to setInterval.
    if (typeof Anim !== 'undefined' && Anim.lib && Anim.lib.createTimer) {
      animTimer = Anim.lib.createTimer({
        duration: Infinity,
        frameRate: 4,           // 4 updates/sec is plenty for seconds display
        onUpdate: tick,
      });
    } else {
      intervalId = setInterval(tick, 250);
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    if (animTimer) { try { animTimer.pause(); animTimer.revert?.(); } catch(e){} animTimer = null; }
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    // v3.1.2 — Freeze on the stopped time and turn RED. We do NOT hide it;
    // it stays frozen until Start is pressed again (which resets it).
    const wrap = document.getElementById('ab-stopwatch');
    if (wrap) {
      wrap.classList.remove('running');
      wrap.classList.add('stopped');
      // A quick red "lock-in" pulse so the freeze reads as deliberate
      if (typeof Anim !== 'undefined' && Anim.enabled && Anim.lib) {
        Anim.lib.animate(wrap, { scale: [1, 1.08, 1], duration: 420, ease: 'outBack(2)' });
      }
    }
    // Tell the overlay to freeze on the final time in its stopped (red)
    // state. We send the negative of (ms+1) as a sentinel meaning
    // "stopped at this time" — the overlay decodes it. (Plain -1 still
    // means fully hide, used on app exit / reset.)
    try {
      if (bridge && bridge.setOverlayStopwatch) {
        bridge.setOverlayStopwatch(-(elapsedMs + 1));
      }
    } catch (e) { /* ignore */ }
  }

  return { start, stop, get running() { return running; }, get elapsedMs() { return elapsedMs; } };
})();
let isRunning = false;
let currentApp = "";
let appsCache = [];
let bwIn = [], bwOut = [];
// v3.1.0 — Per-app session stats. Snapshot taken when capture starts;
// delta computed when capture stops to drive the summary toast.
// (Named _captureStart_v31 to avoid collision with the existing
// _sessionStart variable used by the achievements system.)
let _captureStart_v31 = null;
// v3.1.0 — Auto-pause-on-idle state.
// _idleLastSeen tracks the last "packets seen" count; _idleSince marks
// when that count last changed. After _idleThresholdMs of no activity
// while running, a single warning toast fires (no auto-stop — too
// destructive; just a heads-up).
let _idleLastSeen = -1;
let _idleSince = 0;
let _idleToastShown = false;
let _autoPauseIdleOn = false;          // user toggle (Settings → Behavior)
let _idleThresholdMs = 30 * 1000;      // 30s default; configurable later
// v3.1.0 (network-visibility batch) — Latency probe state.
// `latencyMs` is the rolling window (last 60 samples) drawn as an
// optional overlay line on the traffic graph. -1 marks a failed ping.
let latencyMs = [];
let latencyLast = 0;
let latencyOn = false;
let _latencyPollTimer = null;
let apFilter = "open";
let _apListHover = false;   // v3.1.3 — true while pointer is over #ap-list;
                            // pauses the periodic refresh so rows aren't
                            // rebuilt out from under the cursor.
let _hotkeyNotifications = true;
let _toastDurationMs = 3500;

// ============================================================================
// Icon registry — v3.0.1 redesign.
// Bolder, more distinctive monochrome SVGs. All paths use currentColor so
// they pick up theme colour from CSS — never hard-coded fills/strokes.
// Stroke-width 2.4 for chunkier presence than typical line icons (Throttlr
// has a stencil/industrial aesthetic, not Material-thin). Round caps + joins
// for a slightly friendly feel that contrasts the harsh hazard stripes.
// All icons drawn fresh on a 24x24 viewBox.
// Markup: <span class="icon" data-icon="search"></span>
// renderIcons() walks the DOM and inlines the SVG.
// ============================================================================
const ICONS = {
  // ---------- Tool rail / tools ----------
  // Search — magnifier with thick body + visible handle angle
  search:   '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.3" y1="15.3" x2="20.5" y2="20.5"/>',
  // Activity — pulse waveform with a steeper crest for visibility at small sizes
  activity: '<polyline points="2 12 6 12 9 4 15 20 18 12 22 12"/>',
  // Record — concentric ring + dot, hazard-style "armed" indicator
  record:   '<circle cx="12" cy="12" r="9.5" fill="none"/><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  // Film — film reel with sprocket holes (more recognizable than a strip)
  film:     '<rect x="2.5" y="3" width="19" height="18" rx="2.5"/><line x1="2.5" y1="9" x2="21.5" y2="9"/><line x1="2.5" y1="15" x2="21.5" y2="15"/><circle cx="6" cy="6" r="0.9" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="0.9" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="0.9" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="0.9" fill="currentColor" stroke="none"/>',
  // Network — central hub with 4 outer nodes, lines connecting (cleaner than Lucide)
  network:  '<circle cx="12" cy="12" r="2.5"/><circle cx="4.5" cy="4.5" r="2"/><circle cx="19.5" cy="4.5" r="2"/><circle cx="4.5" cy="19.5" r="2"/><circle cx="19.5" cy="19.5" r="2"/><line x1="6.2" y1="6.2" x2="10.2" y2="10.2"/><line x1="13.8" y1="10.2" x2="17.8" y2="6.2"/><line x1="10.2" y1="13.8" x2="6.2" y2="17.8"/><line x1="13.8" y1="13.8" x2="17.8" y2="17.8"/>',
  // Package — 3D box, isometric feel
  package:  '<path d="M21 7.5L12 3 3 7.5"/><path d="M3 7.5v9L12 21l9-4.5v-9"/><line x1="12" y1="12" x2="12" y2="21"/><line x1="12" y1="12" x2="3" y2="7.5"/><line x1="12" y1="12" x2="21" y2="7.5"/>',
  // Zap — lightning bolt, slightly more aggressive angle
  zap:      '<path d="M13 2 4 13.5h7L11 22l9-11.5h-7L13 2z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/>',
  // Ban — circle with cross-out diagonal, thicker
  ban:      '<circle cx="12" cy="12" r="9.5"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>',
  // Globe — equator + meridian + tilted curve
  globe:    '<circle cx="12" cy="12" r="9.5"/><ellipse cx="12" cy="12" rx="4" ry="9.5"/><line x1="2.5" y1="12" x2="21.5" y2="12"/>',
  // Rotate — arrow curving back to start
  rotate:   '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/>',
  // Trophy — cup with handles + base
  trophy:   '<path d="M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M7 6.5H4.5a2 2 0 0 0 0 4H7"/><path d="M17 6.5h2.5a2 2 0 0 1 0 4H17"/><line x1="12" y1="15" x2="12" y2="18"/><line x1="8" y1="20.5" x2="16" y2="20.5"/><line x1="9" y1="18" x2="15" y2="18"/>',
  // Folder — angled tab folder, more defined corners
  folder:   '<path d="M3 6.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // Play — rounded triangle (less sharp)
  play:     '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke-linejoin="round"/>',
  // Pause — two thick bars
  pause:    '<rect x="6" y="4.5" width="4" height="15" rx="0.5" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="0.5" fill="currentColor" stroke="none"/>',
  // Settings — gear with 8 teeth, cleaner than Lucide's 16-point monstrosity
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/>',

  // ---------- Function panel headers ----------
  // Skull — Throttlr's signature horror icon, slightly more menacing
  skull:    '<path d="M12 2.5c-4.7 0-8.5 3.5-8.5 8 0 2.5 1.2 4.7 3 6v3.5c0 .8.7 1.5 1.5 1.5h8c.8 0 1.5-.7 1.5-1.5V16.5c1.8-1.3 3-3.5 3-6 0-4.5-3.8-8-8.5-8z"/><circle cx="9" cy="11" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.4" fill="currentColor" stroke="none"/><path d="M11 16h2"/>',
  // Snowflake — 6-arm with tick marks (more snowflake-y)
  snowflake:'<line x1="12" y1="2.5" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="21.5" y2="12"/><line x1="5.2" y1="5.2" x2="18.8" y2="18.8"/><line x1="18.8" y1="5.2" x2="5.2" y2="18.8"/><polyline points="9 4 12 7 15 4"/><polyline points="9 20 12 17 15 20"/><polyline points="4 9 7 12 4 15"/><polyline points="20 9 17 12 20 15"/>',
  // Snail — shell spiral + body, friendlier
  snail:    '<circle cx="14" cy="13" r="6"/><circle cx="14" cy="13" r="2.8"/><path d="M8 19a6 6 0 0 1-6-6"/><line x1="2" y1="13" x2="2" y2="19.5"/><line x1="2" y1="19.5" x2="14" y2="19.5"/><line x1="3" y1="9" x2="3" y2="6"/><line x1="3" y1="6" x2="2" y2="5"/>',
  // Phone — handset receiver, tilted
  phone:    '<path d="M21 16.5v3.5a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 4.2 2 2 0 0 1 3 2h3.5a2 2 0 0 1 2 1.7c.2 1.2.5 2.3.9 3.4a2 2 0 0 1-.5 2.1L7.5 10.5a16 16 0 0 0 6 6l1.3-1.4a2 2 0 0 1 2.1-.5c1.1.4 2.2.7 3.4.9A2 2 0 0 1 21 16.5z"/>',

  // ---------- Signal bars (3-bar style) ----------
  signalLow:    '<rect x="3"  y="17" width="3.5" height="5"  rx="0.4" fill="currentColor" stroke="none"/><rect x="9"  y="13" width="3.5" height="9"  rx="0.4" opacity="0.25" fill="currentColor" stroke="none"/><rect x="15" y="7"  width="3.5" height="15" rx="0.4" opacity="0.25" fill="currentColor" stroke="none"/>',
  signalMid:    '<rect x="3"  y="17" width="3.5" height="5"  rx="0.4" fill="currentColor" stroke="none"/><rect x="9"  y="13" width="3.5" height="9"  rx="0.4" fill="currentColor" stroke="none"/><rect x="15" y="7"  width="3.5" height="15" rx="0.4" opacity="0.25" fill="currentColor" stroke="none"/>',
  signalHigh:   '<rect x="3"  y="17" width="3.5" height="5"  rx="0.4" fill="currentColor" stroke="none"/><rect x="9"  y="13" width="3.5" height="9"  rx="0.4" fill="currentColor" stroke="none"/><rect x="15" y="7"  width="3.5" height="15" rx="0.4" fill="currentColor" stroke="none"/>',

  // ---------- Misc ----------
  // Satellite — dish with signal waves (much cleaner than Lucide)
  satellite:'<path d="M5 14.5c-1.5-1.5-1.5-4 0-5.5l4-4c1.5-1.5 4-1.5 5.5 0l4 4c1.5 1.5 1.5 4 0 5.5l-2 2"/><path d="M11 11l5 5"/><path d="M3 21a8 8 0 0 1 8-8"/><path d="M3 21a4 4 0 0 1 4-4"/>',
  // Undo / Redo — curved arrow returning, mirror pair
  undo:     '<polyline points="3 8 8 8 8 3"/><path d="M3 8a9 9 0 1 1 3 6.7"/>',
  redo:     '<polyline points="21 8 16 8 16 3"/><path d="M21 8a9 9 0 1 0-3 6.7"/>',
};

function iconSvg(name) {
  const body = ICONS[name];
  if (!body) return '';
  // CSS (.icon svg in style.css) sets fill:none, stroke:currentColor,
  // stroke-width:2.4, round caps + joins. Per-element overrides like
  // fill="currentColor" stroke="none" still work for solid icons like
  // record/play/pause/zap because attribute inheritance is per-child.
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}

function renderIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-icon]:empty, [data-icon][data-icon-needs-render]').forEach(el => {
    const name = el.getAttribute('data-icon');
    el.innerHTML = iconSvg(name);
    el.removeAttribute('data-icon-needs-render');
  });
}

// Snapshot of settings taken when Settings modal opens. Used to revert
// any live-applied previews on Cancel.
let _origSettings = null;

// Customize tab — user-edited layout for the overlay (custom mode)
let _draftLayout = [];

const ROW_LABELS = {
  status_row:      'Status row',
  status_row_kbps: 'Status row + KB/s',
  app_row:         'App name row',
  stats3:          'Stats (3 cells)',
  stats4:          'Stats (4 cells)',
  kbps_row:        'KB/s rate row',
  volume_row:      'Volume row',
  funcs_row:       'Functions chip row',
};

// ============== LOADER ==============
const LOADER_STAGES = [
  { label: "Initializing…",        pct: 22, delay: 350 },
  { label: "Mounting driver…",     pct: 48, delay: 380 },
  { label: "Connecting bridge…",   pct: 72, delay: 360 },
  { label: "Loading interface…",   pct: 94, delay: 320 },
  { label: "Ready",                pct:100, delay: 280 },
];

function runLoader(onComplete) {
  const stage = document.getElementById('loader-stage');
  const pctEl = document.getElementById('loader-pct');
  const fill  = document.getElementById('loader-fill');
  const hexEl = document.getElementById('loader-hex');
  const checks = Array.from(document.querySelectorAll('.ldr-check'));

  // v3.1.2 — Entrance choreography via anime.js. The loader always
  // animates (it's a one-time brand moment before settings even load),
  // so we use Anim.lib directly rather than the gated helpers.
  if (typeof Anim !== 'undefined' && Anim.lib) {
    const A = Anim.lib;
    // Logo: scale up with a spring, rings spin out
    const logo = document.querySelector('.ldr-logo');
    const bolt = document.querySelector('.ldr-bolt');
    if (logo) {
      A.animate(logo, { scale: [0.3, 1], opacity: [0, 1], rotate: [-30, 0],
        duration: 900, ease: 'outElastic(1, .5)' });
    }
    if (bolt) {
      A.animate(bolt, { scale: [0.6, 1], opacity: [0, 1], duration: 700, delay: 200, ease: 'out(3)' });
    }
    // Rings draw outward
    A.animate(document.querySelectorAll('.ldr-ring'), {
      scale: [0.4, 1], opacity: [0, 1],
      duration: 800, delay: A.stagger(120, { start: 150 }), ease: 'out(4)',
    });
    // Brand name + byline slide up
    A.animate(document.querySelectorAll('.ldr-name, .ldr-by'), {
      y: [18, 0], opacity: [0, 1],
      duration: 600, delay: A.stagger(120, { start: 400 }), ease: 'out(3)',
    });
    // Check rows cascade in
    A.animate(checks, {
      x: [-16, 0], opacity: [0, 1],
      duration: 460, delay: A.stagger(90, { start: 600 }), ease: 'out(3)',
    });
    // Progress bar wrapper fades in last
    const barWrap = document.querySelector('.ldr-bar-wrap');
    if (barWrap) A.animate(barWrap, { opacity: [0, 1], y: [10, 0], duration: 500, delay: 900, ease: 'out(3)' });
  }

  // Cycle the corner-readout hex value to feel like the boot is churning data
  const hexChars = '0123456789ABCDEF';
  const randHex = () => Array.from({length:4}, () =>
    hexChars[Math.floor(Math.random() * 16)]).join('');
  let hexInterval = null;
  if (hexEl) {
    hexInterval = setInterval(() => { hexEl.textContent = randHex(); }, 110);
  }

  let i = 0;
  function step() {
    if (i >= LOADER_STAGES.length) {
      // Final flush: ensure all checks done + small hold before fading out
      checks.forEach(c => c.classList.add('done'));
      if (hexInterval) {
        // Lock in a final-looking hex
        clearInterval(hexInterval);
        if (hexEl) hexEl.textContent = 'C400';
      }
      setTimeout(onComplete, 380);
      return;
    }
    const s = LOADER_STAGES[i++];
    stage.textContent = s.label;
    pctEl.textContent = s.pct + "%";
    fill.style.width = s.pct + "%";
    // Light up any check whose threshold this percentage now crosses
    for (const c of checks) {
      const threshold = parseInt(c.dataset.checkPct, 10) || 0;
      if (s.pct >= threshold) c.classList.add('done');
    }
    setTimeout(step, s.delay);
  }
  step();
}

function fadeOutLoader() {
  const el = document.getElementById('loader');
  if (!el) return;
  // v3.1.2 — Richer exit: content lifts + blurs while the whole overlay
  // fades. anime.js drives it when present; CSS class is the fallback.
  if (typeof Anim !== 'undefined' && Anim.lib) {
    const A = Anim.lib;
    const content = el.querySelector('.ldr-content');
    if (content) {
      A.animate(content, {
        scale: [1, 1.08],
        opacity: [1, 0],
        filter: ['blur(0px)', 'blur(8px)'],
        duration: 520,
        ease: 'in(2)',
      });
    }
    A.animate(el, {
      opacity: [1, 0],
      duration: 600,
      delay: 120,
      ease: 'in(2)',
      onComplete: () => el.remove(),
    });
    // Safety net
    setTimeout(() => { if (el.parentNode) el.remove(); }, 900);
  } else {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 700);
  }
}

// ============== Bridge init ==============
// v3.1.1 — Splash timeout fallback. If QWebChannel doesn't connect within
// 8 seconds, log loudly and force the loader to proceed anyway. The app
// will run in a degraded "no bridge" state for that session but the user
// won't be stuck staring at a 0% progress bar forever.
let _bridgeConnected = false;
const _bridgeTimeout = setTimeout(() => {
  if (_bridgeConnected) return;
  console.error('[startup] QWebChannel did not connect within 8s — running in degraded mode');
  // Render an obvious diagnostic on the splash so the user knows something
  // went wrong, instead of just silently advancing.
  try {
    const stage = document.getElementById('loader-stage');
    if (stage) stage.textContent = 'Bridge connection failed — check %USERPROFILE%\\.throttlr\\startup.log';
    const pct = document.getElementById('loader-pct');
    if (pct) pct.textContent = 'ERR';
  } catch (e) {}
  // Don't auto-advance — the user needs to send us the startup.log.
  // If we proceeded into the main UI we'd just crash a second later
  // when JS tries to call bridge.foo() and `bridge` is undefined.
}, 8000);

new QWebChannel(qt.webChannelTransport, (channel) => {
  _bridgeConnected = true;
  clearTimeout(_bridgeTimeout);
  bridge = channel.objects.bridge;
  runLoader(() => { init(); fadeOutLoader(); });
});

function init() {
  bridge.statsChanged.connect(onStatsChanged);
  bridge.statusChanged.connect(onStatusChanged);
  bridge.hotkeyFired.connect(onHotkeyFired);
  // v3.1.1 — Hotkey conflict notification. Shown once per session, persists
  // until the user dismisses it so they can't miss it.
  if (bridge.hotkeyConflict && bridge.hotkeyConflict.connect) {
    bridge.hotkeyConflict.connect(onHotkeyConflict);
  }
  bridge.errorMessage.connect((msg) => toast(msg, 'error'));
  bridge.appsRefreshed.connect((json) => {
    appsCache = JSON.parse(json);
    const apModal = document.getElementById('app-picker-modal');
    if (apModal && !apModal.hidden && !_apListHover) renderAppPicker(false);
  });

  bridge.getApps().then((json) => { appsCache = JSON.parse(json); });

  bridge.getSettings().then((json) => {
    const s = JSON.parse(json);
    appSettings = s || {};
    window._currentSettings = s || {};   // v3.0.5 — used by theme customization
    applyTheme(s.theme || "lethal");
    populateHotkeys(s);
    updateHotkeyChips(s);
    applyAppearance(s);
    _hotkeyNotifications = s.hotkey_notifications !== false;
    _toastDurationMs = s.toast_duration_ms || 3500;
    // Apply Phase 1 settings
    if (s.midnight_custom_color) applyMidnightCustomCss(s.midnight_custom_color);
    refreshAchievementsCache();
    refreshRecentApps();
  });

  bridge.isAdmin().then((admin) => {
    const badge = document.getElementById('admin-badge');
    const text = document.getElementById('admin-text');
    if (!admin) {
      badge.classList.add('no-admin');
      text.textContent = "No admin (restricted)";
    }
  });

  setupTitlebar();
  setupResizeEdges();
  setupAppChooser();
  setupFunctions();
  setupStartButton();
  setupModals();
  setupFreezeClear();
  setupCustomThemes();   // v3.0.5 — load installed custom themes + wire up buttons

  // Phase 1 module setups
  setupQuickPresets();
  setupSoundEffects();
  setupCustomAccent();
  setupOverlayPhase1Toggles();
  setupPerAppPrompt();
  setupAchievementsModal();
  setupMultiTarget();
  setupProcessTree();
  setupDragDrop();

  // Phase 2 module setups
  setupInspector();
  setupPracticePing();
  setupRecording();
  setupDomainBlock();
  setupGeoBlock();
  // Initial summaries (so UI reflects backend state on first load)
  updateDomainBlockSummary();
  updateGeoBlockSummary();

  // Phase 3 module setups
  setupTopology();
  setupPcap();
  setupFilterScript();

  // v3.1.0 (network-visibility batch)
  setupPktDump();
  // v3.1.1 — Test my Speed tool
  setupSpeedTest();

  // Onboarding — first-launch tutorial, update log on version change
  setupTutorial();
  setupChangelog();
  setupUpdateModal();

  // Render all SVG icons declared via data-icon throughout the markup
  renderIcons();

  pushConfig();

  // Run onboarding flow last — after all setups complete, after icons
  // render, after splash transition. Decides between tutorial / changelog
  // / nothing based on what the backend reports.
  runOnboarding();

  // Auto-update — check GitHub release status and prompt if needed.
  // Runs in parallel with onboarding; the modal shows itself only AFTER
  // any tutorial/changelog has been dismissed (via re-checking 1.5s later).
  setTimeout(checkForUpdatePrompt, 1500);

  // v3.1.2 — Staggered entrance for the main UI once everything's wired.
  // Each top-level panel rises and fades in sequence so the app
  // assembles itself rather than snapping in. Skipped when animations
  // are off (Anim.staggerIn becomes a no-op that just shows them).
  requestAnimationFrame(() => {
    // Top-level panels: header, target/application, presets, functions.
    // These are <section class="panel ..."> plus the presets/functions
    // sections. We grab them in document order so the stagger cascades
    // top-to-bottom.
    const sections = document.querySelectorAll(
      '.panel, .presets-section, .functions-section'
    );
    if (sections.length) {
      Anim.staggerIn(sections, { each: 65, distance: 16, duration: 520, start: 40 });
    }
    // Tool rail buttons get their own finer stagger for a cascade effect
    const toolBtns = document.querySelectorAll('.tool-rail-btn');
    if (toolBtns.length && toolBtns.length <= 30) {
      Anim.staggerIn(toolBtns, { each: 34, distance: 12, duration: 400, start: 280 });
    }
    // Function rows (lag/drop/throttle/freeze/block/fun/domainblock/geoblock)
    // lost their old Animate.css entrance — give them a cascade too.
    const funcMods = document.querySelectorAll('.func-mod');
    if (funcMods.length) {
      Anim.staggerIn(funcMods, { each: 40, distance: 14, duration: 440, start: 180 });
    }
  });
}

// ============== TITLE BAR ==============
function setupTitlebar() {
  const drag = document.getElementById('titlebar-drag');
  drag.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.titlebar-controls')) return;
    bridge.startDragWindow();
  });
  drag.addEventListener('dblclick', () => bridge.toggleMaximizeWindow());
  document.getElementById('tbtn-min').addEventListener('click', () => bridge.minimizeWindow());
  document.getElementById('tbtn-max').addEventListener('click', () => bridge.toggleMaximizeWindow());
  document.getElementById('tbtn-close').addEventListener('click', () => bridge.closeWindow());
}

function setupResizeEdges() {
  document.querySelectorAll('.resize-edge').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      bridge.startResizeWindow(el.dataset.edges);
    });
  });
}

// ============== STATS ==============
const _lastStats = {};
// v3.0.7 — animated tick-up state. Each stat ID can have an in-flight
// animation that smoothly interpolates the displayed number from the
// previous value to the new one over ~280ms with easeOutCubic. Numbers
// that decrease, large jumps (resets), and non-numeric values bypass
// the animation and snap directly.
const _statAnims = Object.create(null);
const _statCurrent = Object.create(null);   // last DISPLAYED value (animation aware)
const _STAT_ANIM_DURATION_MS = 280;

function _easeOutCubicStat(t) { return 1 - Math.pow(1 - t, 3); }

function _animateStatTo(el, id, fromVal, toVal) {
  // Cancel any in-flight animation for this id
  if (_statAnims[id]) {
    cancelAnimationFrame(_statAnims[id]);
    _statAnims[id] = null;
  }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / _STAT_ANIM_DURATION_MS);
    const e = _easeOutCubicStat(t);
    const cur = Math.round(fromVal + (toVal - fromVal) * e);
    el.textContent = cur.toLocaleString();
    _statCurrent[id] = cur;
    if (t < 1) {
      _statAnims[id] = requestAnimationFrame(step);
    } else {
      _statAnims[id] = null;
      _statCurrent[id] = toVal;
      el.textContent = toVal.toLocaleString();
    }
  }
  _statAnims[id] = requestAnimationFrame(step);
}

function setStat(id, value) {
  const el = document.getElementById(id);
  if (!el) return;

  if (typeof value !== 'number') {
    // Non-numeric: just set the text
    const newText = String(value);
    if (el.textContent !== newText) el.textContent = newText;
    _lastStats[id] = value;
    return;
  }

  const prev = _lastStats[id];
  const prevDisplayed = _statCurrent[id];

  // Decide whether to animate
  const startFrom = (typeof prevDisplayed === 'number') ? prevDisplayed :
                    (typeof prev === 'number') ? prev : value;
  const delta = value - startFrom;
  const shouldAnimate =
       typeof prev === 'number'
    && delta !== 0
    && delta > 0                       // only animate count-ups
    && Math.abs(delta) < 100000        // huge jumps (resets) snap instantly
    && Math.abs(delta) >= 1;

  if (shouldAnimate) {
    _animateStatTo(el, id, startFrom, value);
  } else {
    // Snap, no animation
    if (_statAnims[id]) {
      cancelAnimationFrame(_statAnims[id]);
      _statAnims[id] = null;
    }
    const newText = value.toLocaleString();
    if (el.textContent !== newText) {
      el.textContent = newText;
      if (typeof prev === 'number' && value > prev) {
        el.classList.remove('stat-pop');
        void el.offsetWidth;
        el.classList.add('stat-pop');
      }
    }
    _statCurrent[id] = value;
  }

  _lastStats[id] = value;
}

// v3.0.7 — per-stat rate tracker. Stores the previous absolute value +
// the timestamp at which it was sampled, then computes packets/second on
// each new sample. Smoothed with a single-step exponential moving average
// so it doesn't twitch on every tick.
const _statRateState = Object.create(null);
const _RATE_EMA_ALPHA = 0.45;   // higher = more responsive, lower = smoother
let _showDropPct = false;       // toggled via Settings → Behavior

function _updateRate(elId, currentValue, nowMs) {
  const rateEl = document.getElementById(elId + '-rate');
  if (!rateEl) return;
  const prev = _statRateState[elId];
  if (prev === undefined) {
    _statRateState[elId] = { v: currentValue, t: nowMs, rate: 0 };
    rateEl.textContent = '';
    rateEl.classList.remove('is-active');
    return;
  }
  const dt = (nowMs - prev.t) / 1000;
  if (dt < 0.1) return;  // too soon, wait for next sample
  const dv = currentValue - prev.v;
  if (dv < 0) {
    // Counter reset (e.g. user clicked reset stats). Re-seed.
    _statRateState[elId] = { v: currentValue, t: nowMs, rate: 0 };
    rateEl.textContent = '';
    rateEl.classList.remove('is-active');
    return;
  }
  const rawRate = dv / dt;
  const smoothed = prev.rate * (1 - _RATE_EMA_ALPHA) + rawRate * _RATE_EMA_ALPHA;
  _statRateState[elId] = { v: currentValue, t: nowMs, rate: smoothed };
  if (smoothed >= 0.5) {
    // Format: small numbers exact, larger numbers shortened (K)
    let txt;
    if (smoothed >= 10000)      txt = (smoothed / 1000).toFixed(1) + 'K/s';
    else if (smoothed >= 1000)  txt = (smoothed / 1000).toFixed(2) + 'K/s';
    else if (smoothed >= 100)   txt = Math.round(smoothed) + '/s';
    else if (smoothed >= 10)    txt = smoothed.toFixed(1) + '/s';
    else                        txt = smoothed.toFixed(1) + '/s';
    rateEl.textContent = '+' + txt;
    rateEl.classList.add('is-active');
  } else {
    rateEl.textContent = '0/s';
    rateEl.classList.remove('is-active');
  }
}

function onStatsChanged(jsonStr) {
  let s; try { s = JSON.parse(jsonStr); } catch { return; }
  // v3.1.3 — a profile import emits {_force_refresh:true} on this channel to
  // tell the UI to re-sync the function-mod controls. It carries no stats, so
  // bail before the rendering below (which would otherwise compute NaN bytes).
  if (s && s._force_refresh) {
    try { bridge.getConfig && bridge.getConfig().then((c) => applyProfileData(JSON.parse(c))); } catch {}
    return;
  }
  setStat('stat-seen', s.seen);
  setStat('stat-dropped', s.dropped);
  setStat('stat-delayed', s.delayed);
  setStat('stat-held', s.held);
  document.getElementById('stat-bytes').textContent = (s.bytes / 1024).toFixed(1);

  // v3.0.7 — split Sent (outbound) from Recv (inbound). Fall back to the
  // legacy "seen" total if the backend doesn't yet emit them (older builds).
  const sentVal = (s.sent !== undefined && s.sent !== null) ? s.sent : s.seen;
  const recvVal = (s.received !== undefined && s.received !== null) ? s.received : 0;
  setStat('mini-sent', sentVal);
  setStat('mini-received', recvVal);
  setStat('mini-dropped', s.dropped);
  setStat('mini-delayed', s.delayed);
  setStat('mini-held', s.held);

  // v3.0.7 — per-second rates beneath each counter
  const now = performance.now();
  _updateRate('mini-sent',     sentVal,    now);
  _updateRate('mini-received', recvVal,    now);
  _updateRate('mini-dropped',  s.dropped,  now);
  _updateRate('mini-delayed',  s.delayed,  now);
  _updateRate('mini-held',     s.held,     now);

  // v3.0.7 — drop rate % badge (toggleable in Settings → Behavior)
  if (_showDropPct) {
    const pctEl = document.getElementById('mini-drop-pct');
    if (pctEl) {
      const total = sentVal + recvVal;
      if (total > 0 && s.dropped >= 0) {
        const pct = (s.dropped / (total + s.dropped)) * 100;
        let txt;
        if (pct >= 10)   txt = pct.toFixed(0) + '%';
        else if (pct >= 1) txt = pct.toFixed(1) + '%';
        else              txt = pct.toFixed(2) + '%';
        pctEl.textContent = txt;
        pctEl.hidden = false;
      } else {
        pctEl.hidden = true;
      }
    }
  }

  // Replay state: freeze off, queue still draining. Make it visible —
  // this is the moment the user wants to see (packets flowing back out).
  const replaying = !!s.replaying;
  document.body.classList.toggle('is-replaying', replaying);
  const replayBadge = document.getElementById('replay-badge');
  const replayCount = document.getElementById('replay-count');
  if (replayBadge && replayCount) {
    if (replaying) {
      replayBadge.hidden = false;
      replayCount.textContent = (s.held || 0).toLocaleString();
    } else {
      replayBadge.hidden = true;
    }
  }
  // Dedicated freeze module subtitle when replay is in progress
  const freezeSub = document.getElementById('freeze-replay-sub');
  if (freezeSub) {
    if (replaying) {
      freezeSub.hidden = false;
      freezeSub.textContent = `▶ Replaying — ${(s.held || 0).toLocaleString()} packets remaining`;
    } else {
      freezeSub.hidden = true;
    }
  }

  bwIn = s.bw_in || [];
  bwOut = s.bw_out || [];
  const lastIn = bwIn.length ? bwIn[bwIn.length-1] : 0;
  const lastOut = bwOut.length ? bwOut[bwOut.length-1] : 0;
  document.getElementById('rate-display').textContent = `${((lastIn+lastOut)/1024).toFixed(1)} KB/s`;

  // v3.1.0 — Auto-pause on idle detection (running only).
  // Watch packet activity — if seen count is unchanged for N seconds
  // while engine is running, surface a toast suggesting pause.
  if (isRunning && s.seen !== undefined) {
    if (s.seen !== _idleLastSeen) {
      _idleLastSeen = s.seen;
      _idleSince = performance.now();
      _idleToastShown = false;
    } else if (_autoPauseIdleOn && _idleSince &&
               !_idleToastShown &&
               (performance.now() - _idleSince) > _idleThresholdMs) {
      _idleToastShown = true;
      toast(
        `${currentApp || 'Target app'} has been idle for ${Math.round(_idleThresholdMs / 1000)}s — throttling on a quiet target. Stop the engine if you're done.`,
        'warning'
      );
    }
  }

  if (s.running !== isRunning) {
    isRunning = s.running;
    updateStartButtonUI();
    // v3.1.0 — Per-app session stats summary toast.
    if (isRunning) {
      _captureStart_v31 = {
        seen: s.seen || 0, dropped: s.dropped || 0,
        delayed: s.delayed || 0, bytes: s.bytes || 0,
        ts: performance.now(), app: currentApp || '(unknown)',
      };
    } else if (_captureStart_v31) {
      const dt = (performance.now() - _captureStart_v31.ts) / 1000;
      const seen    = (s.seen    || 0) - _captureStart_v31.seen;
      const dropped = (s.dropped || 0) - _captureStart_v31.dropped;
      const delayed = (s.delayed || 0) - _captureStart_v31.delayed;
      const bytes   = (s.bytes   || 0) - _captureStart_v31.bytes;
      // Only show the summary if the session was actually meaningful —
      // skips false positives from accidental stop-immediately clicks.
      if (seen > 5 && dt > 1) {
        const fmt = n => n.toLocaleString('en-US');
        const mb  = (bytes / (1024 * 1024)).toFixed(1);
        const dropPct = seen > 0 ? ((dropped / seen) * 100).toFixed(1) : '0';
        const mins = Math.floor(dt / 60);
        const secs = Math.round(dt % 60);
        const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        toast(
          `Session on ${_captureStart_v31.app}: ${fmt(seen)} pkts (${mb} MB) over ${durStr} · ${fmt(dropped)} dropped (${dropPct}%) · ${fmt(delayed)} lagged`,
          'info'
        );
      }
      _captureStart_v31 = null;
    }
  }
  drawTrafficGraph();

  // Phase 1: check achievements every stats tick
  try { checkAchievementsFromStats(s); } catch (e) { /* swallow */ }
}

function onStatusChanged(status) {
  const dot = document.getElementById('ab-status-dot');
  const tdot = document.getElementById('tb-status-dot');
  const ttext = document.getElementById('tb-status-text');
  const line = document.getElementById('ab-status-line');
  const sub = document.getElementById('ab-status-sub');
  if (status === 'running') {
    dot.classList.add('running');
    tdot.classList.add('running');
    ttext.textContent = "Running";
    line.textContent = "Running";
    sub.textContent = `Throttling ${currentApp || "selected app"}`;
    // v3.1.2 — start the session stopwatch
    Stopwatch.start();
    // v3.1.2 — celebratory pop on the status line + dots when starting
    Anim.pop(line, { from: 0.85, duration: 380 });
    if (Anim.enabled && Anim.lib) {
      Anim.lib.animate([dot, tdot].filter(Boolean), {
        scale: [1, 1.4, 1], duration: 520, ease: 'outElastic(1, .6)',
      });
    }
  } else {
    dot.classList.remove('running');
    tdot.classList.remove('running');
    ttext.textContent = "Idle";
    line.textContent = "Stopped";
    sub.textContent = "Pick an app and enable a function";
    // v3.1.2 — stop the session stopwatch
    Stopwatch.stop();
    // When capture stops, remember the config for this app — so next time
    // the user picks it, they can be offered the chance to restore it.
    autoSaveCurrentAppPreset();
  }
}

// v3.1.1 — Hotkey conflict popup handler. Fires once per session when
// one or more bound hotkeys couldn't be registered globally because
// another app (Discord, OBS, Steam) already owns them. Shown as a
// dismissable warning that persists until clicked, so the user can't
// miss it the way they might miss a regular toast.
let _hotkeyConflictShown = false;
function onHotkeyConflict(msg) {
  if (_hotkeyConflictShown) return;
  _hotkeyConflictShown = true;
  showHotkeyConflictModal(msg);
}

function showHotkeyConflictModal(msg) {
  // Build the modal element if it doesn't exist yet
  let modal = document.getElementById('hotkey-conflict-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'hotkey-conflict-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal modal-anim" style="max-width:520px;">
        <div class="modal-corners"></div>
        <div class="modal-head">
          <span class="m-num icon" data-icon="alert-triangle"></span>
          <h2>Hotkey conflict</h2>
          <button class="modal-close" id="hotkey-conflict-close">×</button>
        </div>
        <div class="modal-body">
          <p id="hotkey-conflict-msg" style="line-height:1.55;"></p>
          <div style="margin-top:14px; padding:10px 14px; background:rgba(255,184,0,0.08); border-left:3px solid var(--accent, #ffb800); border-radius:4px; font-size:13px;">
            <b>Why this happens:</b> When another app (Discord, OBS, Steam, etc.) globally registers a key, Windows hands keypresses to that app first — Throttlr never sees them. The fix is to either unbind the key in the other app, or rebind Throttlr's key to something less common (Settings → Hotkeys).
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn-stencil" id="hotkey-conflict-rebind">Open hotkey settings</button>
          <button class="btn-stencil" id="hotkey-conflict-ok">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // Wire close buttons
    const closeFn = () => {
      modal.classList.add('closing');
      setTimeout(() => { modal.hidden = true; modal.classList.remove('closing'); }, 180);
    };
    modal.querySelector('#hotkey-conflict-close')?.addEventListener('click', closeFn);
    modal.querySelector('#hotkey-conflict-ok')?.addEventListener('click', closeFn);
    modal.querySelector('#hotkey-conflict-rebind')?.addEventListener('click', () => {
      closeFn();
      // Open Settings → Hotkeys tab
      const settingsBtn = document.getElementById('settings-btn');
      if (settingsBtn) settingsBtn.click();
      setTimeout(() => {
        const tab = document.querySelector('[data-tab="hotkeys"]');
        if (tab) tab.click();
      }, 250);
    });
  }
  // Set message + show
  const msgEl = modal.querySelector('#hotkey-conflict-msg');
  if (msgEl) msgEl.textContent = msg;
  modal.hidden = false;
  if (typeof renderIcons === 'function') renderIcons();
}

function onHotkeyFired(which) {
  const labels = {
    startstop: 'Start / Stop',
    freeze: 'Freeze',
    block: 'Block',
    fun: 'Fun',
    killswitch: 'Killswitch',
  };
  if (which === 'startstop') {
    if (isRunning) bridge.stopCapture(); else handleStartClick();
  } else if (which === 'freeze' || which === 'block' || which === 'fun') {
    const cb = document.querySelector(`[data-key="${which}_on"]`);
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
  } else if (which === 'killswitch') {
    // Disable ALL six function toggles instantly
    ['lag_on', 'drop_on', 'throttle_on', 'freeze_on', 'block_on', 'fun_on'].forEach(key => {
      const cb = document.querySelector(`[data-key="${key}"]`);
      if (cb && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
      }
    });
    toast('Killswitch — all functions disabled', 'success');
    return;   // skip the generic "hotkey fired" toast below
  }
  if (_hotkeyNotifications && labels[which]) toast(`${labels[which]} hotkey fired`, 'success');
}

// ============== APP CHOOSER ==============
function setupAppChooser() {
  document.getElementById('app-chooser-btn').addEventListener('click', openAppPicker);
  document.querySelectorAll('[data-ap-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      apFilter = btn.dataset.apFilter;
      document.querySelectorAll('[data-ap-filter]').forEach(b =>
        b.classList.toggle('active', b === btn));
      renderAppPicker(true);
    });
  });
  document.getElementById('ap-search').addEventListener('input', () => renderAppPicker(false));

  // v3.1.3 — pause the background refresh while the cursor is over the list
  // so hovered rows don't get rebuilt mid-hover; catch up on mouse-leave.
  const apList = document.getElementById('ap-list');
  if (apList) {
    apList.addEventListener('mouseenter', () => { _apListHover = true; });
    apList.addEventListener('mouseleave', () => {
      _apListHover = false;
      const m = document.getElementById('app-picker-modal');
      if (m && !m.hidden) renderAppPicker(false);
    });
  }
}

function openAppPicker() {
  bridge.getApps().then((json) => {
    appsCache = JSON.parse(json);
    const hasOpen = appsCache.some(a => a.has_window);
    if (!hasOpen && apFilter === "open") {
      apFilter = "all";
      document.querySelectorAll('[data-ap-filter]').forEach(b =>
        b.classList.toggle('active', b.dataset.apFilter === apFilter));
    }
    document.getElementById('ap-search').value = '';
    showModal('app-picker-modal');
    setTimeout(() => document.getElementById('ap-search').focus(), 80);
    renderAppPicker(true);
  });
}

function renderAppPicker(animate = false) {
  const filter = document.getElementById('ap-search').value.toLowerCase();
  const list = document.getElementById('ap-list');
  let apps = appsCache.slice();
  if (apFilter === "open")        apps = apps.filter(a => a.has_window);
  else if (apFilter === "background") apps = apps.filter(a => !a.has_window);
  if (filter) apps = apps.filter(a => a.name.toLowerCase().includes(filter));

  document.getElementById('ap-count').textContent =
    `${apps.length} ${apps.length === 1 ? 'process' : 'processes'}`;

  list.innerHTML = '';
  if (apps.length === 0) {
    let msg = "No matching processes";
    if (apFilter === "open" && !filter) msg = "No open apps detected — try the Background or All tab";
    list.innerHTML = `<div class="loading">${msg}</div>`;
    return;
  }

  for (const app of apps) {
    const div = document.createElement('div');
    div.className = 'app-item';
    if (app.name === currentApp) div.classList.add('selected');
    const tag = app.has_window
      ? '<span class="app-tag">OPEN</span>'
      : '<span class="app-tag bg">BG</span>';
    div.innerHTML = `
      <div class="app-name-wrap">
        <span class="app-name">${tag}${escapeHTML(app.name)}</span>
      </div>
      <span class="app-meta">
        <span>${app.instances} inst</span>
        <span>${app.conns} conn</span>
      </span>`;
    div.addEventListener('click', () => { selectApp(app.name); hideModal('app-picker-modal'); });
    list.appendChild(div);
  }
  // v3.1.2 — stagger the list items in (capped so huge process lists
  // don't animate hundreds of rows). v3.1.3 — only on a user-initiated
  // render (open / tab switch), never on the periodic refresh, so the
  // list doesn't replay its entrance animation every refresh tick.
  const items = list.querySelectorAll('.app-item');
  if (animate && items.length && items.length <= 40) {
    Anim.staggerIn(items, { each: 18, distance: 8, duration: 260 });
  }
}

// ============== APP TARGETING ==============
let currentApps = [];           // multi-target: list of app names (1+ apps)
let multiTargetMode = false;
let appSettings = {};           // cached settings (loaded once on startup)
let mtAppCfg = {};              // v3.1.3.2 multi-target: per-app function settings { app: {data-key: value} }
let mtActiveApp = null;         // v3.1.3.2 multi-target: which app's tab is being edited

function selectApp(name) {
  if (!name) return;
  if (multiTargetMode) {
    // Add to the list if not already present
    if (!currentApps.includes(name)) {
      currentApps.push(name);
      // v3.1.3.2 — give the new app its own per-app config + tab
      if (!mtAppCfg[name]) mtAppCfg[name] = readFuncControls();
      if (!mtActiveApp) mtActiveApp = name;
      if (bridge && bridge.updateAppConfig) { try { bridge.updateAppConfig(name, JSON.stringify(mtAppCfg[name])); } catch (e) {} }
    }
    currentApp = currentApps[0] || "";
    pushTargetApps();
    renderMultiTargetChips();
    buildMtTabs();
    bridge.addRecentApp(name);
    refreshRecentApps();
    // v3.0.7 — reveal/refresh the Connected Processes inline panel
    if (typeof _showConnectedProcsForApp === 'function') _showConnectedProcsForApp();
    return;
  }

  // Auto-save the OUTGOING app's config before switching, so when you
  // come back to it later, the popup can offer to restore exactly what
  // you were doing. This is the whole point of per-app memory — it has
  // to happen automatically, not via a manual button.
  if (currentApp && currentApp !== name) {
    autoSaveCurrentAppPreset();
  }

  // Single target mode
  currentApp = name;
  currentApps = [name];
  bridge.setTargetApp(name);
  bridge.addRecentApp(name);
  refreshRecentApps();
  const btn = document.getElementById('app-chooser-btn');
  btn.classList.add('has-app');
  document.getElementById('acb-label').textContent = "Selected app";
  document.getElementById('acb-value').textContent = name;
  const ts = document.getElementById('target-status');
  if (ts) ts.textContent = `Selected: ${name}`;
  // Achievement: targeting Discord
  if (name.toLowerCase() === 'discord.exe') {
    bridge.unlockAchievement('discord_disrupter');
    showAchievementToast('discord_disrupter');
  }
  // Per-app preset prompt
  maybePromptPerAppPreset(name);
  // v3.0.7 — reveal/refresh the Connected Processes inline panel
  if (typeof _showConnectedProcsForApp === 'function') _showConnectedProcsForApp();
}

function pushTargetApps() {
  // For multi-target mode, push the full list to the bridge
  bridge.setTargetApps(JSON.stringify(currentApps));
  // Update the chooser display
  const btn = document.getElementById('app-chooser-btn');
  btn.classList.add('has-app');
  if (currentApps.length === 0) {
    btn.classList.remove('has-app');
    document.getElementById('acb-label').textContent = "No apps selected";
    document.getElementById('acb-value').textContent = "Click + Add app to add more";
  } else if (currentApps.length === 1) {
    document.getElementById('acb-label').textContent = "Selected app";
    document.getElementById('acb-value').textContent = currentApps[0];
  } else {
    document.getElementById('acb-label').textContent = `Selected (${currentApps.length} apps)`;
    document.getElementById('acb-value').textContent = currentApps.slice(0, 3).join(' + ') +
      (currentApps.length > 3 ? ` + ${currentApps.length - 3} more` : '');
  }
  const ts = document.getElementById('target-status');
  if (ts) ts.textContent = currentApps.length > 1
    ? `${currentApps.length} apps targeted`
    : (currentApps[0] ? `Selected: ${currentApps[0]}` : '');
}

function renderMultiTargetChips() {
  const container = document.getElementById('mtl-chips');
  if (!container) return;
  container.innerHTML = '';
  currentApps.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'mtl-chip';
    chip.innerHTML = `<span>${escapeHtml(name)}</span><span class="x" title="Remove">×</span>`;
    chip.querySelector('.x').addEventListener('click', () => {
      currentApps = currentApps.filter(a => a !== name);
      currentApp = currentApps[0] || "";
      delete mtAppCfg[name];
      if (mtActiveApp === name) {
        mtActiveApp = currentApps[0] || null;
        if (mtActiveApp) writeFuncControls(mtAppCfg[mtActiveApp] || funcDefaults());
      }
      pushTargetApps();
      renderMultiTargetChips();
      buildMtTabs();
      if (bridge && bridge.clearAppConfigs) { try { bridge.clearAppConfigs(); } catch (e) {} }
      pushAllMtConfigs();
    });
    container.appendChild(chip);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function readFuncControls() {
  // Snapshot the Functions panel controls into a { data-key: value } object.
  const o = {};
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') o[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') o[k] = parseInt(el.value, 10) || 0;
    else if (el.tagName === 'SELECT') o[k] = el.value;
    else o[k] = el.value;
  });
  return o;
}

function writeFuncControls(vals) {
  if (!vals) return;
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (!(k in vals)) return;
    if (el.type === 'checkbox') el.checked = !!vals[k];
    else el.value = vals[k];
  });
  // Re-sync the .active card styling that the toggle 'change' handler sets.
  document.querySelectorAll('.func-mod .toggle-input').forEach(input => {
    const card = input.closest('.func-mod');
    if (card) card.classList.toggle('active', input.checked);
  });
}

function funcDefaults() {
  // Default function values straight from the HTML-declared defaults.
  const o = {};
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') o[k] = el.defaultChecked;
    else if (el.type === 'number' || el.type === 'range') o[k] = parseInt(el.defaultValue, 10) || 0;
    else if (el.tagName === 'SELECT') {
      const def = el.querySelector('option[selected]');
      o[k] = def ? def.value : (el.options[0] ? el.options[0].value : el.value);
    } else o[k] = el.defaultValue;
  });
  return o;
}

function resetFuncControls() { writeFuncControls(funcDefaults()); }

function buildMtTabs() {
  const bar = document.getElementById('mt-tabs');
  if (!bar) return;
  if (!multiTargetMode || currentApps.length === 0) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  const lead = document.createElement('span');
  lead.className = 'mt-tabs-label';
  lead.textContent = 'PER-APP';
  bar.appendChild(lead);
  currentApps.forEach(app => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'mt-tab' + (app === mtActiveApp ? ' active' : '');
    t.textContent = app;
    t.title = app;
    t.addEventListener('click', () => switchMtTab(app));
    bar.appendChild(t);
  });
}

function switchMtTab(app) {
  if (!multiTargetMode || app === mtActiveApp) return;
  if (mtActiveApp) mtAppCfg[mtActiveApp] = readFuncControls();   // save outgoing
  mtActiveApp = app;
  writeFuncControls(mtAppCfg[app] || funcDefaults());            // load incoming
  buildMtTabs();
  pushConfig();                                                  // push active app's config
}

function pushAllMtConfigs() {
  if (!bridge || !bridge.updateAppConfig) return;
  currentApps.forEach(app => {
    const vals = mtAppCfg[app] || funcDefaults();
    try { bridge.updateAppConfig(app, JSON.stringify(vals)); } catch (e) {}
  });
}

function enterMultiTargetUI() {
  // Seed each targeted app with the current control values, then show tabs.
  const cur = readFuncControls();
  currentApps.forEach(app => { if (!mtAppCfg[app]) mtAppCfg[app] = Object.assign({}, cur); });
  mtActiveApp = currentApps[0] || null;
  if (mtActiveApp) writeFuncControls(mtAppCfg[mtActiveApp]);
  buildMtTabs();
  pushAllMtConfigs();
}

function collapseToSingle(name) {
  // Switch back to single-target mode, keeping exactly one app.
  multiTargetMode = false;
  // v3.1.3.2 — leaving multi-target resets all per-app settings (engine + UI),
  // so no app keeps getting throttled after you collapse to one.
  mtAppCfg = {};
  mtActiveApp = null;
  if (bridge && bridge.clearAppConfigs) { try { bridge.clearAppConfigs(); } catch (e) {} }
  const _mtTabs = document.getElementById('mt-tabs');
  if (_mtTabs) { _mtTabs.hidden = true; _mtTabs.innerHTML = ''; }
  resetFuncControls();
  const btn = document.getElementById('multi-target-btn');
  const list = document.getElementById('multi-target-list');
  if (btn) btn.classList.remove('active');
  if (list) list.hidden = true;
  currentApps = name ? [name] : [];
  currentApp = name || "";
  if (name && bridge && bridge.setTargetApp) bridge.setTargetApp(name);
  const cb = document.getElementById('app-chooser-btn');
  const lbl = document.getElementById('acb-label');
  const val = document.getElementById('acb-value');
  if (name) {
    if (cb) cb.classList.add('has-app');
    if (lbl) lbl.textContent = 'Selected app';
    if (val) val.textContent = name;
  } else {
    if (cb) cb.classList.remove('has-app');
    if (lbl) lbl.textContent = 'No app selected';
    if (val) val.textContent = 'Click to choose an application';
  }
  const ts = document.getElementById('target-status');
  if (ts) ts.textContent = name ? `Selected: ${name}` : '';
  renderMultiTargetChips();
  if (typeof _showConnectedProcsForApp === 'function') _showConnectedProcsForApp();
  if (typeof pushConfig === 'function') pushConfig();   // push the reset (all-off) config
}

function openMtCollapseChooser() {
  const apps = currentApps.slice();
  if (apps.length <= 1) { collapseToSingle(apps[0] || ''); return; }
  const existing = document.getElementById('mt-collapse-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'mt-collapse-modal';
  modal.innerHTML = `
    <div class="modal modal-anim mtc-modal">
      <div class="modal-corners"></div>
      <div class="modal-head">
        <span class="m-num">\u25BC</span>
        <h2>Keep one app</h2>
        <button class="modal-close" id="mtc-x">\u00D7</button>
      </div>
      <div class="modal-body">
        <p class="mtc-intro">Single-target mode throttles <b>one</b> app at a time. You're targeting ${apps.length} \u2014 choose the one to keep:</p>
        <div class="mtc-list" id="mtc-list">
          ${apps.map((n, i) => `<label class="mtc-item"><input type="radio" name="mtc-pick" value="${escapeHtml(n)}"${i === 0 ? ' checked' : ''}><span class="mtc-radio"></span><span class="mtc-name">${escapeHtml(n)}</span></label>`).join('')}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn-stencil" id="mtc-cancel">Stay in multi-target</button>
        <button class="btn-stencil mtc-keep" id="mtc-confirm">Keep this app</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const closeOnly = () => { modal.classList.add('closing'); setTimeout(() => modal.remove(), 180); };
  modal.querySelector('#mtc-x').addEventListener('click', closeOnly);
  modal.querySelector('#mtc-cancel').addEventListener('click', closeOnly);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeOnly(); });
  modal.querySelector('#mtc-confirm').addEventListener('click', () => {
    const sel = modal.querySelector('input[name="mtc-pick"]:checked');
    const name = sel ? sel.value : (apps[0] || '');
    closeOnly();
    collapseToSingle(name);
  });
}

function setupMultiTarget() {
  const btn = document.getElementById('multi-target-btn');
  const list = document.getElementById('multi-target-list');
  const addBtn = document.getElementById('mtl-add-btn');
  if (!btn || !list || !addBtn) return;

  btn.addEventListener('click', () => {
    if (multiTargetMode) {
      // Turning OFF. Single-target only holds one app — if several are
      // targeted, ask which one to keep rather than silently dropping the rest.
      if (currentApps.length > 1) {
        openMtCollapseChooser();   // chooser resolves the switch (or cancels)
        return;
      }
      multiTargetMode = false;
      btn.classList.remove('active');
      list.hidden = true;
      collapseToSingle(currentApps[0] || currentApp || "");
    } else {
      multiTargetMode = true;
      btn.classList.add('active');
      list.hidden = false;
      // If we already have a single app selected, seed the multi-list with it
      if (currentApp && currentApps.length === 0) currentApps = [currentApp];
      pushTargetApps();
      renderMultiTargetChips();
      bridge.unlockAchievement('multi_tasker');
      showAchievementToast('multi_tasker');
      enterMultiTargetUI();   // v3.1.3.2 — build per-app tabs + seed per-app configs
    }
  });

  addBtn.addEventListener('click', () => {
    document.getElementById('app-picker-modal').hidden = false;
  });
}

// ============== v3.0.7 — Connected Processes inline panel ==============
// Toggle-gated panel below the app picker. When the toggle is OFF (default),
// Throttlr targets every related process automatically and the picker body
// is hidden — only the toggle header is visible so the user can opt in.
// When the toggle is ON, the body becomes interactive and the user can
// tick/untick individual PIDs. The picker also polls every 2s while
// expanded to keep up with Chrome spawning/killing renderers.

let _cpPollTimer = null;
let _cpIsOpen = false;
let _cpEnabled = false;

function setupProcessTree() {
  // Toggle checkbox — flips the feature on/off
  const cbEnable = document.getElementById('cp-enable-checkbox');
  if (cbEnable) {
    cbEnable.addEventListener('change', _onConnectedProcsToggle);
    cbEnable.addEventListener('click', (e) => e.stopPropagation());
  }

  // Clicking the head expands/collapses the body — but ONLY when feature on
  const head = document.querySelector('#connected-procs .cp-head');
  if (head) head.addEventListener('click', _toggleConnectedProcsPanel);

  const tickAll = document.getElementById('cp-tick-all');
  if (tickAll) tickAll.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('#cp-list .cp-row input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
    });
    document.querySelectorAll('#cp-list .cp-row').forEach(r => r.classList.remove('is-excluded'));
    _commitConnectedProcsExcludes();
  });

  const untickAll = document.getElementById('cp-untick-all');
  if (untickAll) untickAll.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('#cp-list .cp-row input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
    document.querySelectorAll('#cp-list .cp-row').forEach(r => r.classList.add('is-excluded'));
    _commitConnectedProcsExcludes();
  });

  // Fetch initial enabled state from settings so it persists across launches
  if (bridge && bridge.getConnectedProcsEnabled) {
    bridge.getConnectedProcsEnabled().then((on) => {
      _cpEnabled = !!on;
      if (cbEnable) cbEnable.checked = _cpEnabled;
      _applyConnectedProcsEnabledStyles();
    }).catch(() => {});
  }
}

function _onConnectedProcsToggle(e) {
  if (e) e.stopPropagation();
  const cb = document.getElementById('cp-enable-checkbox');
  _cpEnabled = !!(cb && cb.checked);
  // Persist to backend — also re-resolves target_pids on the controller
  if (bridge && bridge.setConnectedProcsEnabled) {
    bridge.setConnectedProcsEnabled(_cpEnabled).catch(() => {});
  }
  _applyConnectedProcsEnabledStyles();
  if (_cpEnabled) {
    // First time enabling — fetch summary so the count is accurate
    _refreshConnectedProcsSummary();
    toast('Connected Processes enabled — click the panel to manage individual subprocesses', 'success');
  } else {
    // Force-collapse the body when feature is disabled
    _cpIsOpen = false;
    const wrap = document.getElementById('connected-procs');
    const body = document.getElementById('cp-body');
    if (wrap) wrap.classList.remove('is-open');
    if (body) body.hidden = true;
    _stopConnectedProcsPolling();
  }
}

function _applyConnectedProcsEnabledStyles() {
  const wrap = document.getElementById('connected-procs');
  const summary = document.getElementById('cp-summary');
  const expandIcon = document.getElementById('cp-toggle-icon');
  if (!wrap) return;
  wrap.classList.toggle('is-enabled', _cpEnabled);
  wrap.classList.toggle('is-disabled', !_cpEnabled);
  if (expandIcon) expandIcon.hidden = !_cpEnabled;
  if (summary) {
    if (!_cpEnabled) {
      summary.textContent = 'off — targeting all related processes';
    }
    // If enabled, _refreshConnectedProcsSummary fills in the X of Y count
  }
}

function _toggleConnectedProcsPanel(e) {
  // Ignore clicks on the toggle switch or its label, the tick-all/untick-all
  // buttons, or anything inside the body
  if (!e) return;
  if (e.target.closest('.cp-enable-toggle')) return;
  if (e.target.closest('.cp-toolbar')) return;
  if (e.target.closest('.cp-body')) return;
  // Don't expand if the feature is off — toggle the enable checkbox instead
  if (!_cpEnabled) return;

  const wrap = document.getElementById('connected-procs');
  const body = document.getElementById('cp-body');
  if (!wrap || !body) return;
  _cpIsOpen = !_cpIsOpen;
  wrap.classList.toggle('is-open', _cpIsOpen);
  body.hidden = !_cpIsOpen;
  if (_cpIsOpen) {
    _refreshConnectedProcs();
    if (_cpPollTimer) clearInterval(_cpPollTimer);
    _cpPollTimer = setInterval(_refreshConnectedProcs, 2000);
  } else {
    _stopConnectedProcsPolling();
  }
}

function _stopConnectedProcsPolling() {
  if (_cpPollTimer) {
    clearInterval(_cpPollTimer);
    _cpPollTimer = null;
  }
}

// Called whenever the user picks an app — show the panel if hidden, refresh count
function _showConnectedProcsForApp() {
  const wrap = document.getElementById('connected-procs');
  if (!wrap) return;
  if (currentApp || (currentApps && currentApps.length > 0)) {
    wrap.hidden = false;
    _applyConnectedProcsEnabledStyles();
    if (_cpEnabled) _refreshConnectedProcsSummary();
  } else {
    wrap.hidden = true;
    _stopConnectedProcsPolling();
  }
}

function _refreshConnectedProcsSummary() {
  if (!_cpEnabled) return;
  if (!bridge || !bridge.getProcessTree) return;
  bridge.getProcessTree().then((raw) => {
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch { return; }
    const procs = Array.isArray(data.processes) ? data.processes : [];
    const summary = document.getElementById('cp-summary');
    if (!summary) return;
    const included = procs.filter(p => !p.excluded).length;
    summary.textContent = `${included} of ${procs.length} included`;
  }).catch(() => {});
}

function _refreshConnectedProcs() {
  if (!bridge || !bridge.getProcessTree) return;
  bridge.getProcessTree().then((raw) => {
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch { return; }
    const list = document.getElementById('cp-list');
    const summary = document.getElementById('cp-summary');
    if (!list) return;
    const procs = Array.isArray(data.processes) ? data.processes : [];

    if (procs.length === 0) {
      list.innerHTML = `<div class="cp-empty">
        Targeted app isn't running, or no processes match the name yet.
        Try launching it then click <strong>Connected Processes</strong> again to refresh.
      </div>`;
      if (summary) summary.textContent = '0 of 0 included';
      return;
    }

    list.innerHTML = '';
    procs.forEach(p => {
      const row = document.createElement('label');
      row.className = 'cp-row' + (p.is_main ? ' is-main' : '');
      if (p.excluded) row.classList.add('is-excluded');
      // Heuristic — highlight Chrome's network service since that's where
      // the actual network IO happens. Other apps don't have this pattern.
      const cmdline = (p.cmdline || '').toLowerCase();
      if (cmdline.includes('network.mojom.networkservice') ||
          cmdline.includes('--type=network')) {
        row.classList.add('network-service');
      }

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !p.excluded;
      cb.dataset.pid = String(p.pid);
      cb.addEventListener('change', () => {
        row.classList.toggle('is-excluded', !cb.checked);
        _commitConnectedProcsExcludes();
      });
      // Stop checkbox clicks from bubbling to the header (which toggles panel)
      cb.addEventListener('click', (e) => e.stopPropagation());

      const pidSpan = document.createElement('span');
      pidSpan.className = 'cp-pid';
      pidSpan.textContent = p.pid;

      const info = document.createElement('div');
      info.className = 'cp-info';
      const name = document.createElement('div');
      name.className = 'cp-name';
      name.textContent = p.name || '(unknown)';
      info.appendChild(name);
      if (p.cmdline) {
        const cl = document.createElement('div');
        cl.className = 'cp-cmdline';
        cl.textContent = p.cmdline;
        info.appendChild(cl);
      }

      const tag = document.createElement('span');
      tag.className = 'cp-tag' + (p.is_main ? '' : ' cp-tag-child');
      if (row.classList.contains('network-service')) {
        tag.textContent = 'Network';
      } else {
        tag.textContent = p.is_main ? 'Main' : 'Child';
      }

      row.appendChild(cb);
      row.appendChild(pidSpan);
      row.appendChild(info);
      row.appendChild(tag);
      list.appendChild(row);
    });

    const included = procs.filter(p => !p.excluded).length;
    if (summary) summary.textContent = `${included} of ${procs.length} included`;
  }).catch(() => {});
}

// Auto-commit on every checkbox change — no separate "Apply" button needed
function _commitConnectedProcsExcludes() {
  const excludes = [];
  document.querySelectorAll('#cp-list .cp-row input[type="checkbox"]').forEach(cb => {
    if (!cb.checked) excludes.push(parseInt(cb.dataset.pid, 10));
  });
  bridge.setProcessTreeExcludes(JSON.stringify(excludes)).then(ok => {
    // Update summary right away
    const summary = document.getElementById('cp-summary');
    if (summary) {
      const all = document.querySelectorAll('#cp-list .cp-row').length;
      const included = all - excludes.length;
      summary.textContent = `${included} of ${all} included`;
    }
  }).catch(() => {});
}

// ============== RECENT APPS ==============
function refreshRecentApps() {
  try {
    bridge.getRecentApps().then((raw) => {
      try {
        const list = JSON.parse(raw || '[]');
        const bar = document.getElementById('recent-apps-bar');
        const chips = document.getElementById('rab-chips');
        if (!bar || !chips) return;
        chips.innerHTML = '';
        if (!list.length) {
          bar.hidden = true;
          return;
        }
        bar.hidden = false;
        list.slice(0, 8).forEach(name => {
          const chip = document.createElement('button');
          chip.className = 'rab-chip';
          chip.textContent = name;
          chip.addEventListener('click', () => selectApp(name));
          chips.appendChild(chip);
        });
      } catch (e) { /* swallow */ }
    });
  } catch (e) { /* swallow */ }
}

// ============== DRAG-AND-DROP .EXE TARGETING ==============
function setupDragDrop() {
  const target = document.body;
  let dragging = false;
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragging) {
      dragging = true;
      target.classList.add('dnd-active');
    }
  });
  target.addEventListener('dragleave', (e) => {
    if (e.target === target || !target.contains(e.relatedTarget)) {
      dragging = false;
      target.classList.remove('dnd-active');
    }
  });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    dragging = false;
    target.classList.remove('dnd-active');
    if (!e.dataTransfer || !e.dataTransfer.files) return;
    for (const f of e.dataTransfer.files) {
      if (f.name && f.name.toLowerCase().endsWith('.exe')) {
        selectApp(f.name);
        toast(`Targeted ${f.name}`, 'success');
        return;
      }
    }
    toast('Drop an .exe to target it', 'error');
  });
}

// ============== FUNCTIONS ==============
function setupFunctions() {
  document.querySelectorAll('.toggle-input').forEach(input => {
    input.addEventListener('change', () => {
      const card = input.closest('.func-mod');
      card.classList.toggle('active', input.checked);
      // v3.1.2 — tactile feedback: pulse the card when a function turns ON
      if (input.checked) Anim.pulse(card, { peak: 1.025, duration: 420 });
      pushConfig();
      const k = input.dataset.key;
      if (k === 'freeze_on') bridge.toggleFreeze(input.checked);
      else if (k === 'block_on') bridge.toggleBlock(input.checked);
      else if (k === 'fun_on') bridge.toggleFun(input.checked);
    });
  });
  document.querySelectorAll('.func-mod .dir-check input').forEach(i =>
    i.addEventListener('change', pushConfig));
  document.querySelectorAll('.func-mod .param-input').forEach(i => {
    i.addEventListener('change', pushConfig);
    i.addEventListener('blur', pushConfig);
  });
  document.querySelectorAll('.func-mod .slider-input').forEach(i => {
    if (i.dataset.key !== 'fun_intensity') return;
    const display = document.getElementById('fun-intensity-display');
    i.addEventListener('input', () => {
      if (display) display.textContent = `${i.value}%`;
      pushConfig();
    });
  });
}

function pushConfig() {
  const cfg = {};
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') cfg[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') cfg[k] = parseInt(el.value, 10) || 0;
    else if (el.tagName === 'SELECT') cfg[k] = parseInt(el.value, 10) || 0;
    else cfg[k] = el.value;
  });

  // v3.1.0 (real-networks batch) — include fields from Settings → Network
  // that aren't inside .func-mod containers. Each is optional — if the
  // element isn't present (older HTML), the field just doesn't get set.
  const _gv = (id, type) => {
    const e = document.getElementById(id);
    if (!e) return undefined;
    if (type === 'bool')  return !!e.checked;
    if (type === 'int')   return parseInt(e.value, 10) || 0;
    return e.value;
  };
  // Bursty drop pattern
  const pat = _gv('drop-pattern');
  if (pat !== undefined) cfg.drop_pattern = pat;
  const bl = _gv('drop-burst-len', 'int');  if (bl !== undefined) cfg.drop_burst_len = bl;
  const gl = _gv('drop-gap-len',   'int');  if (gl !== undefined) cfg.drop_gap_len   = gl;
  // Bandwidth quota
  const qOn  = _gv('quota-on-toggle', 'bool');     if (qOn  !== undefined) cfg.bandwidth_quota_on   = qOn;
  const qMb  = _gv('quota-mb', 'int');             if (qMb  !== undefined) cfg.quota_mb             = qMb;
  const qAct = _gv('quota-action');                if (qAct !== undefined) cfg.quota_action         = qAct;
  const qKb  = _gv('quota-throttle-kbps', 'int');  if (qKb  !== undefined) cfg.quota_throttle_kbps  = qKb;
  // DNS chaos
  const dnsOn = _gv('dns-chaos-toggle', 'bool');
  if (dnsOn !== undefined) cfg.dns_chaos_on = dnsOn;

  // v3.1.3.2 — in multi-target, push THIS app's config to its own slot so each
  // targeted app throttles independently. Single-target uses the global path.
  if (multiTargetMode && mtActiveApp) {
    mtAppCfg[mtActiveApp] = readFuncControls();
    if (bridge && bridge.updateAppConfig) bridge.updateAppConfig(mtActiveApp, JSON.stringify(cfg));
  } else {
    bridge.updateConfig(JSON.stringify(cfg));
  }
}

// ============== START BUTTON ==============
function setupStartButton() {
  const btn = document.getElementById('start-btn');
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleStartClick(); });
}

function handleStartClick() {
  // v3.1.2 — Clearer pre-flight checks before starting capture. Each
  // failure surfaces three ways: an inline message next to the Start
  // button, an in-app toast, AND a screen-level overlay notification at
  // the top-right of the screen (visible even over a game). Notifications
  // fire FIRST so a later animation error can never suppress them.
  if (isRunning) { bridge.stopCapture(); return; }

  // 1) Must have an app selected
  if (!currentApp) {
    const msg = "Cannot start — no application selected";
    notifyStartError(msg);
    try {
      const tp = document.querySelector('.target-panel');
      if (tp) {
        Anim.shake(tp);
        tp.style.borderColor = 'var(--blood)';
        tp.style.boxShadow = '0 0 24px rgba(196,30,58,0.5)';
        setTimeout(() => { tp.style.borderColor = ''; tp.style.boxShadow = ''; }, 1500);
      }
    } catch (e) { /* visual flourish only */ }
    return;
  }

  // 2) Must have at least one function enabled
  const anyFunctionOn = Array.from(
    document.querySelectorAll('.func-mod .toggle-input')
  ).some(cb => cb.checked);
  if (!anyFunctionOn) {
    const msg = "Cannot start — no function enabled (Lag, Drop, Throttle…)";
    notifyStartError(msg);
    try {
      const fnSection = document.querySelector('.functions-section');
      if (fnSection) Anim.shake(fnSection);
      if (Anim.enabled && Anim.lib) {
        Anim.lib.animate(document.querySelectorAll('.func-mod .lt-track'), {
          boxShadow: ['0 0 0 0 rgba(196,30,58,0)', '0 0 0 3px rgba(196,30,58,0.6)', '0 0 0 0 rgba(196,30,58,0)'],
          duration: 900,
          delay: Anim.lib.stagger(50),
          ease: 'inOut(2)',
        });
      }
    } catch (e) { /* visual flourish only */ }
    return;
  }

  // All good — start. Clear any lingering error message.
  hideStartMsg();
  bridge.startCapture();
}

// v3.1.2 — Fire all three failure notifications. Each wrapped so one
// failing can't stop the others.
function notifyStartError(msg) {
  try { showStartMsg(msg); } catch (e) {}
  try { toast(msg, 'error'); } catch (e) {}
  try { if (bridge && bridge.showScreenNotification) bridge.showScreenNotification(msg, 'error'); } catch (e) {}
}

// v3.1.2 — Inline "cannot start" message shown right next to the Start
// button. Slides in, holds, then fades out. Complements the toast.
let _startMsgTimer = null;
function showStartMsg(text) {
  const el = document.getElementById('start-msg');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (_startMsgTimer) clearTimeout(_startMsgTimer);
  if (Anim.enabled && Anim.lib) {
    Anim.lib.animate(el, { opacity: [0, 1], x: [16, 0], duration: 320, ease: 'out(3)' });
  }
  _startMsgTimer = setTimeout(hideStartMsg, 4200);
}
function hideStartMsg() {
  const el = document.getElementById('start-msg');
  if (!el || el.hidden) return;
  if (Anim.enabled && Anim.lib) {
    Anim.lib.animate(el, {
      opacity: [1, 0], x: [0, 12], duration: 280, ease: 'in(2)',
      onComplete: () => { el.hidden = true; el.style.opacity = ''; },
    });
  } else {
    el.hidden = true;
  }
}

function updateStartButtonUI() {
  const btn = document.getElementById('start-btn');
  const arr = btn.querySelector('.sb-arrow');
  const txt = btn.querySelector('.sb-text');
  if (isRunning) { btn.classList.add('running'); arr.textContent = '■'; txt.textContent = 'Stop'; }
  else           { btn.classList.remove('running'); arr.textContent = '▶'; txt.textContent = 'Start'; }
}

// ============== HOTKEY CHIPS ==============
function updateHotkeyChips(s) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('fm-key-freeze', s.hotkey_freeze || 'F8');
  set('fm-key-block',  s.hotkey_block  || 'F9');
  set('fm-key-fun',    s.hotkey_fun    || 'F10');
  set('hk-hint-startstop', s.hotkey_startstop || 'F5');
  set('hk-hint-freeze',    s.hotkey_freeze    || 'F8');
  set('hk-hint-block',     s.hotkey_block     || 'F9');
  set('hk-hint-fun',       s.hotkey_fun       || 'F10');
  set('sb-key-display',    s.hotkey_startstop || 'F5');
}

// ============== APPEARANCE / LIVE PREVIEW ==============
function applyAppearance(s) {
  document.body.dataset.compact = s.compact_mode ? "true" : "false";
  document.body.dataset.crt = (s.crt_effects === false) ? "off" : "on";
  Anim.setEnabled(s.animations_enabled !== false);  // v3.1.2
  // v3.0.5 fix — if a custom theme is currently active, don't overwrite
  // dataset.design (the custom theme manages it). This prevents a flash
  // back to "industrial" briefly when this fn runs from settings save.
  if (!window._activeCustomThemeId) {
    document.body.dataset.design = s.ui_design || "industrial";
  }
  document.body.dataset.midnightAccent = s.midnight_accent || "aurora";
  document.querySelectorAll('.design-tile').forEach(t =>
    t.classList.toggle('active',
      !t.classList.contains('custom-theme')
      && !window._activeCustomThemeId
      && t.dataset.design === (s.ui_design || "industrial")));
  document.querySelectorAll('.midnight-tile').forEach(t =>
    t.classList.toggle('active', t.dataset.midnightAccent === (s.midnight_accent || "aurora")));
}

function applyDesign(name) {
  // v3.0.5 — picking a built-in design clears any active custom theme +
  // removes the injected CSS. Custom-theme tiles call applyCustomTheme()
  // which routes through this function for the base, then layers custom on top.
  document.body.dataset.design = name;
  document.body.dataset.customTheme = "";
  _removeCustomThemeCss();
  _removeThemeCustomizeOverrides();
  _hideThemeCustomizeUI();
  document.querySelectorAll('.design-tile').forEach(t =>
    t.classList.toggle('active', !t.classList.contains('custom-theme')
                              && t.dataset.design === name));
  document.querySelectorAll('.design-tile.custom-theme').forEach(t =>
    t.classList.remove('active'));
  if (window._activeCustomThemeId !== null) {
    window._activeCustomThemeId = null;
  }
  // v3.1.1 — Re-detect bg tone after design change. Otherwise switching
  // from a light custom theme back to a dark built-in leaves
  // data-bg-tone="light" stuck on body, keeping all the dark-text
  // overrides applied over a dark background → invisible text.
  // requestAnimationFrame so the new CSS variables resolve before we sample.
  if (typeof detectAndApplyBgTone === 'function') {
    requestAnimationFrame(detectAndApplyBgTone);
  }
}

// ============== CUSTOM THEMES (v3.0.5) ==============
// Manifest pairs (.json + .css) live in %USERPROFILE%/.throttlr/themes/.
// On boot we fetch the list, render tiles next to the built-in designs,
// and apply whichever one was previously active.

window._installedCustomThemes = [];     // array of manifests from the bridge
window._activeCustomThemeId = null;     // id of the currently-applied custom theme

const CUSTOM_THEME_STYLE_ID = "custom-theme-css";

function _removeCustomThemeCss() {
  const existing = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (existing) existing.remove();
}

function _injectCustomThemeCss(cssText) {
  _removeCustomThemeCss();
  const el = document.createElement('style');
  el.id = CUSTOM_THEME_STYLE_ID;
  el.textContent = cssText;
  // Append to the END of <head> so its rules win the cascade against the
  // base theme's rules (same-specificity selectors, later wins).
  document.head.appendChild(el);
}

async function loadInstalledCustomThemes() {
  // Pull from bridge, populate the in-memory list, render the tiles
  try {
    const raw = await bridge.listInstalledThemes();
    window._installedCustomThemes = JSON.parse(raw) || [];
  } catch (e) {
    window._installedCustomThemes = [];
  }
  renderCustomThemeTiles();
}

function renderCustomThemeTiles() {
  const grid = document.getElementById('custom-themes-grid');
  const empty = document.getElementById('custom-themes-empty');
  if (!grid) return;

  const themes = window._installedCustomThemes;
  // Clear all existing custom-theme tiles (but keep the empty-state element)
  grid.querySelectorAll('.design-tile.custom-theme').forEach(el => el.remove());

  if (!themes.length) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  for (const t of themes) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'design-tile custom-theme';
    tile.dataset.customThemeId = t.id || '';
    tile.dataset.customThemeBase = t.base || 'industrial';
    tile.dataset.customThemeCss = t._css_filename || '';

    const preview = t.preview || {};
    const bg     = preview.bg     || '#14140e';
    const accent = preview.accent || '#ffb800';
    const accent2 = preview.accent2 || accent;
    const font   = preview.font   || 'Big Shoulders Stencil Display';

    // Mark missing CSS so user knows to also drop the .css file in
    const isBroken = !t._css_exists;

    tile.innerHTML = `
      <div class="design-preview design-preview-custom"
           data-name="${escapeHtml(t.name || 'Untitled')}"
           style="--ct-bg:${escapeHtml(bg)};
                  --ct-accent:${escapeHtml(accent)};
                  --ct-accent2:${escapeHtml(accent2)};
                  --ct-font:'${escapeHtml(font)}',sans-serif;"></div>
      <div class="design-label">
        <span class="design-name">${escapeHtml(t.name || 'Untitled')}${isBroken ? ' ⚠' : ''}</span>
        <span class="design-sub">${escapeHtml(t.author || 'unknown')}${
          isBroken ? ' · missing .css' : (t.description ? ' · ' + escapeHtml(t.description.slice(0, 50)) : '')
        }</span>
      </div>
    `;
    tile.addEventListener('click', () => {
      if (isBroken) {
        toast(`Theme "${t.name}" is missing its .css file — drop it in the themes folder and click Rescan`, 'error');
        return;
      }
      applyCustomTheme(t.id);
    });
    grid.appendChild(tile);
  }
}

async function applyCustomTheme(themeId) {
  const t = (window._installedCustomThemes || []).find(x => x.id === themeId);
  if (!t) {
    toast(`Theme "${themeId}" not found — try Rescan`, 'error');
    return;
  }
  if (!t._css_exists) {
    toast(`Theme "${t.name}" is missing its .css file`, 'error');
    return;
  }

  // Fetch the CSS content from disk via the bridge
  let cssText = '';
  try {
    cssText = await bridge.loadThemeCss(t._css_filename);
  } catch (e) {
    toast(`Couldn't load theme CSS: ${e}`, 'error');
    return;
  }
  if (!cssText) {
    toast(`Theme CSS file is empty or unreadable`, 'error');
    return;
  }

  // Set the base design first (foundation), then layer custom on top
  document.body.dataset.design = t.base || 'industrial';
  document.body.dataset.customTheme = t.id;
  _injectCustomThemeCss(cssText);

  // v3.0.5 — render the per-theme customization UI + apply any saved
  // user color overrides as a second injected <style> tag.
  renderThemeCustomization(t);
  _applyThemeCustomizationOverrides(t.id);

  // Update tile-active state — clear built-ins, set this custom one
  document.querySelectorAll('.design-tile').forEach(el =>
    el.classList.remove('active'));
  document.querySelectorAll('.design-tile.custom-theme').forEach(el =>
    el.classList.toggle('active', el.dataset.customThemeId === t.id));

  window._activeCustomThemeId = t.id;

  // v3.0.7 — show both the Customize tab in Settings AND the standalone
  // header button. Tab is the primary nav while in Settings; header button
  // is a shortcut from the main UI that opens Settings → Customize tab.
  try {
    const hasCustomizables = Array.isArray(t.customizable) && t.customizable.length > 0;
    const cTabBtn = document.getElementById('customize-tab-btn');
    if (cTabBtn) {
      cTabBtn.hidden = !hasCustomizables;
      cTabBtn.innerHTML = hasCustomizables
        ? `<span>🎨</span> <span class="mhc-label">Customize ${t.name}</span>`
        : `<span>🎨</span> <span class="mhc-label">Customize</span>`;
    }
    const openCustomizeBtn = document.getElementById('open-customize-btn');
    if (openCustomizeBtn) {
      openCustomizeBtn.hidden = !hasCustomizables;
      openCustomizeBtn.innerHTML = hasCustomizables
        ? `<span>🎨</span> Customize ${t.name}`
        : `<span>🎨</span> Customize Theme`;
    }
  } catch (e) {}

  // v3.0.6 — also live-preview the floating overlay so it updates the
  // moment a theme tile is clicked, not only after Save. The overlay is
  // a Qt widget on the Python side, so we hop over the bridge.
  try {
    if (typeof bridge !== 'undefined' && bridge.previewOverlayTheme) {
      const customs = (window._currentSettings && window._currentSettings.theme_customizations &&
                       window._currentSettings.theme_customizations[t.id]) || {};
      bridge.previewOverlayTheme(t.id, JSON.stringify(customs));
    }
  } catch (e) { /* preview is best-effort, never fatal */ }

  // v3.1.1 — Trigger bg-tone re-detection now that the custom theme's
  // CSS is injected. Custom themes can be either light (Retro) or dark
  // (Cyberpunk) so we need to re-sample --bg-2 from the new CSS variables.
  // requestAnimationFrame so the injected CSS takes effect first.
  if (typeof detectAndApplyBgTone === 'function') {
    requestAnimationFrame(detectAndApplyBgTone);
  }
}

// ============== THEME CUSTOMIZATION (v3.0.5) ==============
// Custom themes can declare a `customizable` array in their manifest:
//   [{ key, label, type: "color"|"gradient", default, ...}]
// Users get color pickers in Settings → Appearance to override these.
// Overrides are injected as CSS variables in a separate <style> tag so
// the theme's own CSS can pick them up via `var(--theme-u-<key>, default)`.
// Persists across sessions via the `theme_customizations` setting.

const CUSTOM_THEME_OVERRIDE_STYLE_ID = "custom-theme-overrides";
let _themeCustomizeSaveTimer = null;

function _removeThemeCustomizeOverrides() {
  const el = document.getElementById(CUSTOM_THEME_OVERRIDE_STYLE_ID);
  if (el) el.remove();
}

function _hideThemeCustomizeUI() {
  const rows = document.getElementById('theme-customize-rows');
  if (rows) rows.innerHTML = '';
  // v3.0.7 — hide both the Customize tab AND the header shortcut button
  // when no custom theme is active. If user is currently on the Customize
  // tab, bounce them back to Appearance so they're not stranded.
  try {
    const cTabBtn = document.getElementById('customize-tab-btn');
    if (cTabBtn) {
      cTabBtn.hidden = true;
      if (cTabBtn.classList.contains('active')) {
        const appearanceBtn = document.querySelector('[data-tab="appearance"]');
        if (appearanceBtn) appearanceBtn.click();
      }
    }
    const openBtn = document.getElementById('open-customize-btn');
    if (openBtn) openBtn.hidden = true;
  } catch (e) {}
}

// Get the user's saved customizations for a theme (or {} if none)
function _getThemeCustomizations(themeId) {
  const all = (window._currentSettings && window._currentSettings.theme_customizations) || {};
  return (all && all[themeId]) || {};
}

// Save (debounced) — updates window._currentSettings + persists via bridge
function _saveThemeCustomization(themeId, key, value) {
  if (!window._currentSettings) window._currentSettings = {};
  if (!window._currentSettings.theme_customizations) window._currentSettings.theme_customizations = {};
  if (!window._currentSettings.theme_customizations[themeId]) window._currentSettings.theme_customizations[themeId] = {};
  window._currentSettings.theme_customizations[themeId][key] = value;

  // v3.0.6 — also live-preview the overlay so e.g. dragging the pink
  // picker in Retro updates the floating overlay's accent in real time.
  try {
    if (typeof bridge !== 'undefined' && bridge.previewOverlayTheme && window._activeCustomThemeId === themeId) {
      bridge.previewOverlayTheme(themeId, JSON.stringify(window._currentSettings.theme_customizations[themeId] || {}));
    }
  } catch (e) { /* preview is best-effort */ }

  // Debounce the save — drag events can fire many times per second
  if (_themeCustomizeSaveTimer) clearTimeout(_themeCustomizeSaveTimer);
  _themeCustomizeSaveTimer = setTimeout(() => {
    try {
      bridge.saveSettings(JSON.stringify({
        theme_customizations: window._currentSettings.theme_customizations
      }));
    } catch (e) {
      console.warn('Failed to save theme customization:', e);
    }
  }, 350);
}

// Build the CSS for the override <style> tag from the saved customizations.
// One `body[data-custom-theme="<id>"]` rule with all the override variables.
function _applyThemeCustomizationOverrides(themeId) {
  _removeThemeCustomizeOverrides();
  const t = (window._installedCustomThemes || []).find(x => x.id === themeId);
  if (!t || !Array.isArray(t.customizable) || !t.customizable.length) return;

  const saved = _getThemeCustomizations(themeId);
  const decls = [];

  for (const item of t.customizable) {
    if (!item || !item.key || !item.type) continue;
    const value = (saved[item.key] !== undefined) ? saved[item.key] : item.default;
    if (item.type === 'color') {
      decls.push(`  --theme-u-${item.key}: ${value};`);
    } else if (item.type === 'gradient' && Array.isArray(value)) {
      value.forEach((stop, i) => {
        decls.push(`  --theme-u-${item.key}-${i}: ${stop};`);
      });
    }
  }
  if (!decls.length) return;

  const css = `body[data-custom-theme="${themeId}"] {\n${decls.join('\n')}\n}`;
  const el = document.createElement('style');
  el.id = CUSTOM_THEME_OVERRIDE_STYLE_ID;
  el.textContent = css;
  // Append AFTER the theme's own CSS so the variables actually override
  // any defaults the theme set on the same selector.
  document.head.appendChild(el);
  // v3.1.1 — Re-check bg tone after custom overrides applied so text
  // colors swap if the user picked a light --bg via the customizer.
  // requestAnimationFrame so the new CSS takes effect before we measure.
  if (typeof detectAndApplyBgTone === 'function') {
    requestAnimationFrame(detectAndApplyBgTone);
  }
}

// Render the customize panel for a theme (called when applying a theme)
function renderThemeCustomization(theme) {
  const sec = document.getElementById('theme-customize-section');
  const rows = document.getElementById('theme-customize-rows');
  const title = document.getElementById('theme-customize-title');
  const cTabBtn = document.getElementById('customize-tab-btn');
  const openBtn = document.getElementById('open-customize-btn');
  if (!sec || !rows) return;

  const hasCustomizables = Array.isArray(theme.customizable) && theme.customizable.length > 0;

  if (!hasCustomizables) {
    rows.innerHTML = '';
    if (cTabBtn) cTabBtn.hidden = true;
    if (openBtn) openBtn.hidden = true;
    return;
  }

  if (title) title.textContent = `Customize ${theme.name || 'theme'}`;
  if (cTabBtn) {
    cTabBtn.hidden = false;
    cTabBtn.innerHTML = `<span>🎨</span> <span class="mhc-label">Customize ${theme.name || 'theme'}</span>`;
  }
  if (openBtn) {
    openBtn.hidden = false;
    openBtn.innerHTML = `<span>🎨</span> Customize ${theme.name || 'Theme'}`;
  }
  rows.innerHTML = '';

  const saved = _getThemeCustomizations(theme.id);

  for (const item of theme.customizable) {
    if (!item || !item.key || !item.type) continue;
    const row = document.createElement('div');
    row.className = `theme-customize-row ${item.type}`;
    row.dataset.key = item.key;

    const label = document.createElement('div');
    label.className = 'theme-customize-row-label';
    label.textContent = item.label || item.key;
    row.appendChild(label);

    const controls = document.createElement('div');
    controls.className = 'theme-customize-row-controls';
    row.appendChild(controls);

    if (item.type === 'color') {
      const current = (saved[item.key] !== undefined) ? saved[item.key] : item.default;
      const ctrl = _makeColorControl(current, '', (newVal) => {
        _saveThemeCustomization(theme.id, item.key, newVal);
        _applyThemeCustomizationOverrides(theme.id);
      });
      controls.appendChild(ctrl);

    } else if (item.type === 'gradient') {
      const defaults = Array.isArray(item.default) ? item.default : [];
      const currentArr = Array.isArray(saved[item.key]) ? saved[item.key].slice() : defaults.slice();
      // Make sure the saved array is at least as long as defaults
      while (currentArr.length < defaults.length) currentArr.push(defaults[currentArr.length] || '#ffffff');
      const stopLabels = Array.isArray(item.stop_labels) ? item.stop_labels : [];

      const stopsWrap = document.createElement('div');
      stopsWrap.className = 'gradient-stops';
      controls.appendChild(stopsWrap);

      const preview = document.createElement('div');
      preview.className = 'gradient-preview';
      controls.appendChild(preview);

      const updatePreview = () => {
        if (currentArr.length === 1) {
          preview.style.background = currentArr[0];
        } else {
          const stops = currentArr.map((c, i) =>
            `${c} ${Math.round(100 * i / Math.max(1, currentArr.length - 1))}%`
          ).join(', ');
          preview.style.background = `linear-gradient(90deg, ${stops})`;
        }
      };
      updatePreview();

      currentArr.forEach((stopVal, idx) => {
        const stopBox = document.createElement('div');
        stopBox.className = 'gradient-stop';
        const stopLabel = stopLabels[idx] || `Stop ${idx + 1}`;
        const ctrl = _makeColorControl(stopVal, stopLabel, (newVal) => {
          currentArr[idx] = newVal;
          updatePreview();
          _saveThemeCustomization(theme.id, item.key, currentArr.slice());
          _applyThemeCustomizationOverrides(theme.id);
        });
        stopBox.appendChild(ctrl);
        stopsWrap.appendChild(stopBox);
      });
    }

    rows.appendChild(row);
  }

  // Reset button — clears all customizations for this theme
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (!window._currentSettings) window._currentSettings = {};
      if (!window._currentSettings.theme_customizations) window._currentSettings.theme_customizations = {};
      delete window._currentSettings.theme_customizations[theme.id];
      try {
        bridge.saveSettings(JSON.stringify({
          theme_customizations: window._currentSettings.theme_customizations
        }));
      } catch (e) {}
      // Re-render with defaults + re-apply overrides
      renderThemeCustomization(theme);
      _applyThemeCustomizationOverrides(theme.id);
      try { toast(`Reset ${theme.name} colors to defaults`, 'success'); } catch (e) {}
    };
  }
}

// Helper: build a color picker + hex input pair, wired to onChange
function _makeColorControl(initialValue, stopLabel, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'theme-color-control';

  if (stopLabel) {
    const lbl = document.createElement('span');
    lbl.className = 'stop-label';
    lbl.textContent = stopLabel;
    wrap.appendChild(lbl);
  }

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = _toHex6(initialValue);
  wrap.appendChild(colorInput);

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = _toHex6(initialValue);
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  wrap.appendChild(hexInput);

  // Color picker drag → update hex input + fire onChange
  colorInput.addEventListener('input', () => {
    hexInput.value = colorInput.value;
    onChange(colorInput.value);
  });

  // Hex text typing → validate, sync color input, fire onChange
  hexInput.addEventListener('input', () => {
    let v = hexInput.value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      colorInput.value = v.toLowerCase();
      onChange(v.toLowerCase());
    } else if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      // Expand 3-char shorthand
      const expanded = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      colorInput.value = expanded.toLowerCase();
      onChange(expanded.toLowerCase());
    }
  });
  hexInput.addEventListener('blur', () => {
    // On blur, normalize the displayed hex value
    hexInput.value = colorInput.value;
  });

  return wrap;
}

// Coerce any color string to #rrggbb (for the native color input)
function _toHex6(str) {
  if (!str) return '#ffffff';
  const s = String(str).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1]+s[1] + s[2]+s[2] + s[3]+s[3];
  // Try parsing rgb()/rgba() — strip alpha and convert
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    return '#' + [m[1], m[2], m[3]].map(n => {
      const x = parseInt(n, 10).toString(16);
      return x.length === 1 ? '0' + x : x;
    }).join('');
  }
  return '#ffffff';
}

// Wire up the More themes / Open folder / Rescan buttons + lazy-load themes
function setupCustomThemes() {
  const galleryBtn = document.getElementById('open-themes-gallery-btn');
  const folderBtn  = document.getElementById('open-themes-folder-btn');
  const rescanBtn  = document.getElementById('rescan-themes-btn');

  if (galleryBtn) galleryBtn.addEventListener('click', () => {
    bridge.openThemesGallery();
  });
  if (folderBtn) folderBtn.addEventListener('click', () => {
    bridge.openThemesFolder();
  });
  if (rescanBtn) rescanBtn.addEventListener('click', async () => {
    await loadInstalledCustomThemes();
    // Re-apply the active custom theme if it still exists, or fall back
    // to the base design if it was deleted
    const settings = await bridge.getSettings().then(s => JSON.parse(s));
    const active = settings.active_custom_theme || '';
    if (active) {
      const stillExists = (window._installedCustomThemes || []).some(t => t.id === active);
      if (!stillExists) {
        applyDesign(settings.ui_design || 'industrial');
        toast(`Active custom theme "${active}" was removed — reverted to ${settings.ui_design || 'industrial'}`, 'warning');
      } else if (window._activeCustomThemeId !== active) {
        applyCustomTheme(active);
      }
    }
    toast(`Found ${window._installedCustomThemes.length} custom theme${window._installedCustomThemes.length === 1 ? '' : 's'}`, 'info');
  });

  // v3.0.7 — "Customize Theme" header button is a shortcut: open Settings
  // and auto-switch to the Customize tab so the user lands directly on the
  // controls. Tab itself lives on the right side of the modal-tabs row.
  const openCustomizeBtn = document.getElementById('open-customize-btn');
  if (openCustomizeBtn) {
    openCustomizeBtn.addEventListener('click', () => {
      openSettings();
      // Wait one frame for Settings to populate, then click the Customize tab
      setTimeout(() => {
        const cTabBtn = document.getElementById('customize-tab-btn');
        if (cTabBtn && !cTabBtn.hidden) cTabBtn.click();
      }, 50);
    });
  }

  // Initial load
  loadInstalledCustomThemes();
}

function applyMidnightAccent(name) {
  document.body.dataset.midnightAccent = name;
  document.querySelectorAll('.midnight-tile').forEach(t =>
    t.classList.toggle('active', t.dataset.midnightAccent === name));
}

function applyTheme(name) {
  document.body.dataset.theme = name;
  document.querySelectorAll('.theme-tile').forEach(t =>
    t.classList.toggle('active', t.dataset.theme === name));
  // v3.1.1 — Detect whether this theme is light- or dark-toned and tag
  // the body. CSS rules keyed on [data-bg-tone="light"] swap bright text
  // and accent colors to dark equivalents for readability.
  detectAndApplyBgTone();
}

// v3.1.1 — Compute background luminance and set data-bg-tone on body.
// Some themes (the pink/cream/light variants the user added) use bright
// backgrounds where the default yellow accent text becomes nearly
// invisible. This function inspects the computed --bg-2 variable, runs
// the W3C relative-luminance formula, and tags the body so CSS can
// swap colors for light themes. Runs after every applyTheme call AND
// after every accent customization update.
//
// We sample --bg-2 (the modal / card / panel background) rather than
// --bg (the body background) because: (a) most readable text content
// lives on cards and modals, not the body, and (b) some themes set
// a dark --bg for atmosphere but a light --bg-2 for content surfaces
// — those need the light-theme overrides. If --bg-2 isn't set, we
// fall back to --bg as a sanity check.
function detectAndApplyBgTone() {
  try {
    const cs = getComputedStyle(document.body);
    let raw = cs.getPropertyValue('--bg-2').trim();
    if (!raw) raw = cs.getPropertyValue('--bg').trim();
    if (!raw) return;
    const rgb = parseColorToRgb(raw);
    if (!rgb) return;
    // W3C relative luminance formula (sRGB → linear → weighted sum)
    const linearize = (c) => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
    document.body.dataset.bgTone = (L > 0.5) ? 'light' : 'dark';
  } catch (e) {
    // If anything goes wrong (very rare), default to dark — that's
    // the historical Throttlr aesthetic and matches the most themes.
    document.body.dataset.bgTone = 'dark';
  }
}

// Parse hex / rgb() / rgba() to {r,g,b}. Handles short hex (#abc),
// long hex (#aabbcc), and CSS rgb(...)/rgba(...). Returns null on
// unparseable input rather than throwing — the caller falls back to
// the default dark theme.
function parseColorToRgb(str) {
  str = str.trim();
  // hex
  if (str.startsWith('#')) {
    let h = str.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r, g, b };
  }
  // rgb() / rgba()
  const m = str.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3] };
  }
  return null;
}

// ============== FREEZE PURGE ==============
function setupFreezeClear() {
  document.getElementById('freeze-clear').addEventListener('click', () => {
    bridge.clearFreezeQueue().then((n) => {
      toast(`Cleared ${n} held packet${n === 1 ? '' : 's'}`, 'success');
    });
  });
}

// ============== TRAFFIC GRAPH ==============
function drawTrafficGraph() {
  const canvas = document.getElementById('traffic-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,184,0,0.06)';
  ctx.lineWidth = 1 * dpr;
  for (let i = 0; i < 5; i++) { const y = (h/4)*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  for (let i = 0; i < 12; i++) { const x = (w/11)*i; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }

  if (bwIn.length === 0 && bwOut.length === 0) return;
  const all = [...bwIn, ...bwOut];
  const maxVal = Math.max(1024, ...all);
  if (bwOut.length > 0) drawSeries(ctx, bwOut, w, h, maxVal, '#ffb800', dpr);
  if (bwIn.length > 0)  drawSeries(ctx, bwIn,  w, h, maxVal, '#7fff6a', dpr);

  // v3.1.0 (network-visibility) — Latency overlay line.
  // Scaled independently from bandwidth: max(latency) → top of plot.
  // Failed pings (-1) are gaps in the line.
  if (latencyOn && latencyMs.length > 0) {
    drawLatencyLine(ctx, latencyMs, w, h, dpr);
  }
}

// v3.1.0 — latency line. Cyan, no fill (so it doesn't fight the bandwidth
// fills). Auto-scales to the local max ping. Failed pings break the line.
function drawLatencyLine(ctx, data, w, h, dpr) {
  const N = 60;
  const valid = data.filter(v => v > 0);
  if (valid.length === 0) return;
  // Auto-scale — leave a little headroom above the highest ping
  const maxMs = Math.max(50, Math.max(...valid) * 1.15);
  const padded = [];
  for (let i = 0; i < N - data.length; i++) padded.push(-1);
  for (const v of data) padded.push(v);

  ctx.beginPath();
  ctx.strokeStyle = '#5fd9ff';
  ctx.lineWidth = 2 * dpr;
  ctx.shadowColor = '#5fd9ff';
  ctx.shadowBlur = 6 * dpr;
  let drawing = false;
  for (let i = 0; i < padded.length; i++) {
    const v = padded[i];
    if (v <= 0) { drawing = false; continue; }
    const x = (i / (N - 1)) * w;
    const y = h - (v / maxMs) * h * 0.85;
    if (!drawing) { ctx.moveTo(x, y); drawing = true; }
    else          { ctx.lineTo(x, y); }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Small "Xms" label at the latest sample so the line is interpretable
  const latest = data[data.length - 1];
  if (latest > 0) {
    const x = w - 4 * dpr;
    const y = h - (latest / maxMs) * h * 0.85;
    ctx.fillStyle = '#5fd9ff';
    ctx.font = `${11 * dpr}px 'JetBrains Mono', Consolas, monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(latest)}ms`, x, Math.max(12 * dpr, y - 4 * dpr));
  }
}

function drawSeries(ctx, data, w, h, maxVal, color, dpr) {
  const N = 60;
  const padded = [];
  for (let i = 0; i < N - data.length; i++) padded.push(0);
  for (const v of data) padded.push(v);

  ctx.beginPath();
  for (let i = 0; i < padded.length; i++) {
    const x = (i / (N - 1)) * w;
    const y = h - (padded[i] / maxVal) * h * 0.9;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hexA(color, 0.35)); grad.addColorStop(1, hexA(color, 0.0));
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < padded.length; i++) {
    const x = (i / (N - 1)) * w;
    const y = h - (padded[i] / maxVal) * h * 0.9;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6 * dpr;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function hexA(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// v3.1.0 (network-visibility) — Latency probe poller.
// Polls bridge.getLatencyState() every 1.2s while the probe is on. The
// backend pings once per second, so we sample slightly slower to avoid
// hitting the same sample twice.
function startLatencyPolling() {
  if (_latencyPollTimer) return;
  const tick = () => {
    if (!bridge.getLatencyState) return;
    bridge.getLatencyState().then((json) => {
      let s = {};
      try { s = JSON.parse(json || '{}'); } catch {}
      latencyOn = !!s.on;
      latencyLast = s.last || 0;
      latencyMs = s.samples || [];
      // Update the readout if it's visible
      const lastEl = document.getElementById('lat-last');
      const avgEl  = document.getElementById('lat-avg');
      const minEl  = document.getElementById('lat-min');
      const maxEl  = document.getElementById('lat-max');
      if (lastEl) lastEl.textContent = s.last ? `${Math.round(s.last)} ms` : '—';
      if (avgEl)  avgEl.textContent  = s.avg  ? `${s.avg} ms` : '—';
      if (minEl)  minEl.textContent  = s.min  ? `${s.min} ms` : '—';
      if (maxEl)  maxEl.textContent  = s.max  ? `${s.max} ms` : '—';
      // v3.1.0 — render the dedicated chart
      drawLatencyChart();
      // If the user turned it off remotely, stop polling
      if (!s.on) stopLatencyPolling();
    }).catch(() => {});
  };
  tick();
  _latencyPollTimer = setInterval(tick, 1200);
}

function stopLatencyPolling() {
  if (_latencyPollTimer) {
    clearInterval(_latencyPollTimer);
    _latencyPollTimer = null;
  }
  // Clear the line — but keep latencyOn synced from the next poll
  latencyMs = [];
}

// v3.1.0 — Dedicated latency chart inside Settings → Network.
// Separate from the main traffic-graph overlay; this one fills its own
// canvas so the user can see the full RTT history clearly.
function drawLatencyChart() {
  const canvas = document.getElementById('latency-chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(95,217,255,0.06)';
  ctx.lineWidth = 1 * dpr;
  for (let i = 0; i < 5; i++) {
    const y = (h/4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const valid = latencyMs.filter(v => v > 0);
  if (valid.length === 0) {
    ctx.fillStyle = 'rgba(180,180,180,0.4)';
    ctx.font = `${12 * dpr}px 'JetBrains Mono', Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(latencyOn ? 'waiting for samples…' : 'probe off',
                 w / 2, h / 2);
    return;
  }
  const maxMs = Math.max(50, Math.max(...valid) * 1.15);

  // Y-axis label (top)
  ctx.fillStyle = 'rgba(95,217,255,0.55)';
  ctx.font = `${10 * dpr}px 'JetBrains Mono', Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(maxMs)}ms`, 4 * dpr, 12 * dpr);
  ctx.fillText(`0ms`, 4 * dpr, h - 4 * dpr);

  // Line
  const N = 60;
  const padded = [];
  for (let i = 0; i < N - latencyMs.length; i++) padded.push(-1);
  for (const v of latencyMs) padded.push(v);

  ctx.beginPath();
  ctx.strokeStyle = '#5fd9ff';
  ctx.lineWidth = 2 * dpr;
  ctx.shadowColor = '#5fd9ff';
  ctx.shadowBlur = 8 * dpr;
  let drawing = false;
  for (let i = 0; i < padded.length; i++) {
    const v = padded[i];
    if (v <= 0) { drawing = false; continue; }
    const x = (i / (N - 1)) * w;
    const y = h - (v / maxMs) * h * 0.88 - 4 * dpr;
    if (!drawing) { ctx.moveTo(x, y); drawing = true; }
    else { ctx.lineTo(x, y); }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ============== MODALS ==============
function showModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  // v3.1.2 — Cancel any pending close-timeout. Without this, if showModal
  // is called within 180ms of a previous hideModal (e.g. user rapidly
  // closes then reopens Settings, or the close animation hasn't finished
  // yet), the OLD setTimeout will still fire and set hidden=true,
  // causing the visible flicker where the modal flashes open then
  // disappears. Now: clear the stale timer, take a fresh open.
  if (m._closeTimer) {
    clearTimeout(m._closeTimer);
    m._closeTimer = null;
  }
  m.classList.remove('closing');
  m.hidden = false;
  const inner = m.querySelector('.modal-anim');
  // v3.1.2 — Richer entrance via anime.js when enabled. The CSS keyframe
  // (modal-in) still exists as the disabled-animations fallback, so we
  // only take over when Anim is on. We clear the CSS animation first so
  // the two don't fight.
  if (inner && Anim.enabled && Anim.lib) {
    inner.style.animation = 'none';
    Anim.lib.animate(inner, {
      opacity: [0, 1],
      scale: [0.94, 1],
      y: [18, 0],
      filter: ['blur(6px)', 'blur(0px)'],
      duration: 440,
      ease: 'outBack(1.4)',
    });
    // Backdrop fade
    Anim.lib.animate(m, { opacity: [0, 1], duration: 260, ease: 'out(2)' });
  } else if (inner) {
    // Disabled-animations path: replay the CSS animation reset trick
    inner.style.animation = 'none'; void inner.offsetWidth; inner.style.animation = '';
  }
}

function hideModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  // v3.0.7 — stop poll on modal close so we're not making bridge calls
  // in the background forever.
  if (id === 'script-modal' && typeof _stopScriptDiagPolling === 'function') {
    _stopScriptDiagPolling();
  }
  // v3.1.0 (network-visibility) — same pattern for the live packet dump
  if (id === 'pktdump-modal' && typeof closePktDump === 'function') {
    closePktDump();
  }
  // v3.1.2 — Cancel any earlier pending close. Stacking multiple
  // setTimeouts from rapid hide-show-hide sequences would leave
  // orphaned timers that could fire after a later showModal.
  if (m._closeTimer) {
    clearTimeout(m._closeTimer);
    m._closeTimer = null;
  }
  m.classList.add('closing');
  m._closeTimer = setTimeout(() => {
    m.hidden = true;
    m.classList.remove('closing');
    m._closeTimer = null;
  }, 180);
}

// v3.1.0 — Settings search bar.
// Scans labels, keys, and hint text across every settings tab pane.
// Highlights matches, dims siblings, badges tabs with match counts.
function setupSettingsSearch() {
  const input = document.getElementById('settings-search');
  const clearBtn = document.getElementById('settings-search-clear');
  if (!input) return;

  // Selectors:
  //   SEARCH_SELECTOR — elements whose textContent we check for matches
  //   ROW_SELECTOR    — elements that get dimmed in non-matching contexts
  // Kept separate so dim affects whole rows even when a sub-label matches.
  const SEARCH_SELECTOR = '.field-label, label, .info-key, .hint-text';
  const ROW_SELECTOR    = '.field-label, label, .info-row, .hint-text';

  function clearSearchState(modal) {
    modal.querySelectorAll('.search-row-match').forEach(el => el.classList.remove('search-row-match'));
    modal.querySelectorAll('.search-row-dim').forEach(el => el.classList.remove('search-row-dim'));
    modal.querySelectorAll('.tab-search-count').forEach(el => el.remove());
    modal.querySelectorAll('.tab-no-search-match').forEach(el => el.classList.remove('tab-no-search-match'));
    modal.querySelectorAll('.tab-pane.has-search').forEach(el => el.classList.remove('has-search'));
  }

  function runSearch() {
    const raw = input.value || '';
    const q = raw.trim().toLowerCase();
    if (clearBtn) clearBtn.hidden = !raw;

    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    clearSearchState(modal);
    if (!q) return;

    // Walk each tab-pane separately so we can count matches per pane.
    modal.querySelectorAll('.tab-pane[data-pane]').forEach(pane => {
      const paneName = pane.dataset.pane;
      let matchCount = 0;

      pane.querySelectorAll(SEARCH_SELECTOR).forEach(el => {
        // textContent is the full visible text; covers nested spans/strong
        const text = (el.textContent || '').toLowerCase();
        if (text.includes(q)) {
          el.classList.add('search-row-match');
          matchCount++;
        }
      });

      if (matchCount > 0) {
        pane.classList.add('has-search');
        // Dim siblings that didn't match — makes hits pop visually
        pane.querySelectorAll(ROW_SELECTOR).forEach(el => {
          if (!el.classList.contains('search-row-match')) {
            el.classList.add('search-row-dim');
          }
        });
      }

      // Update tab button — badge with count, or fade if zero matches
      const tabBtn = modal.querySelector(`.tab-btn[data-tab="${paneName}"]`);
      if (tabBtn) {
        if (matchCount === 0) {
          tabBtn.classList.add('tab-no-search-match');
        } else {
          const badge = document.createElement('span');
          badge.className = 'tab-search-count';
          badge.textContent = String(matchCount);
          tabBtn.appendChild(badge);
        }
      }
    });
  }

  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      runSearch();
      input.blur();
    }
  });
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      runSearch();
      input.focus();
    });
  }
}

// v3.1.0 (network-visibility) — Latency probe wiring.
// Toggle, host input, and a one-shot state seed when settings opens.
function hookLatencyProbe() {
  const toggle = document.getElementById('lat-probe-toggle');
  const hostIn = document.getElementById('lat-probe-host');
  if (!toggle || !hostIn || !bridge.setLatencyProbe) return;

  const apply = () => {
    bridge.setLatencyProbe(toggle.checked, hostIn.value.trim() || '1.1.1.1');
    if (toggle.checked) startLatencyPolling();
    else stopLatencyPolling();
  };

  toggle.addEventListener('change', apply);
  hostIn.addEventListener('change', () => {
    // Only push host change if probe is on — otherwise just remember locally
    if (toggle.checked) apply();
  });
  hostIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); hostIn.blur(); }
  });

  // Seed UI from the backend's current state when the settings modal
  // opens — handles the "user already had it running" case.
  if (bridge.getLatencyState) {
    bridge.getLatencyState().then((json) => {
      let s = {};
      try { s = JSON.parse(json || '{}'); } catch {}
      toggle.checked = !!s.on;
      if (s.host) hostIn.value = s.host;
      if (s.on) startLatencyPolling();
    }).catch(() => {});
  }
}

// v3.1.0 (real-networks batch) — Test-my-internet speedtest.
// Click Run → backend downloads from Cloudflare, emits progress on
// the speedtestProgress signal. We render mbps live and offer
// throttle-suggestion buttons once it's done.
let _speedtestLastResult = null;   // {mbps, kbps} after a completed run
function hookSpeedtest() {
  const runBtn = document.getElementById('speedtest-run-btn');
  if (!runBtn || !bridge.runSpeedtest) return;

  // Connect the streaming progress signal once
  if (bridge.speedtestProgress && bridge.speedtestProgress.connect) {
    bridge.speedtestProgress.connect((json) => {
      let s = {};
      try { s = JSON.parse(json || '{}'); } catch { return; }
      const status = document.getElementById('speedtest-status');
      const result = document.getElementById('speedtest-result');
      const mbpsEl = document.getElementById('speedtest-mbps');
      const kbpsEl = document.getElementById('speedtest-kbps');
      if (s.phase === 'starting') {
        if (status) status.textContent = `Starting…`;
        if (result) result.hidden = true;
      } else if (s.phase === 'downloading') {
        const mb = (s.bytes / (1024 * 1024)).toFixed(1);
        if (status) status.textContent = `${mb} MB · ${s.mbps} Mbps`;
      } else if (s.phase === 'done') {
        if (status) status.textContent = `Done`;
        if (result) result.hidden = false;
        if (mbpsEl) mbpsEl.textContent = `${s.mbps} Mbps`;
        if (kbpsEl) kbpsEl.textContent = `${s.kbps} KB/s`;
        _speedtestLastResult = { mbps: s.mbps, kbps: s.kbps };
        runBtn.disabled = false;
      } else if (s.phase === 'error') {
        if (status) status.textContent = `Failed: ${s.error}`;
        runBtn.disabled = false;
      }
    });
  }

  runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    _speedtestLastResult = null;
    bridge.runSpeedtest(25);  // 25 MB sample
  });

  // Wire the "apply X%" buttons
  document.querySelectorAll('[data-speedtest-apply]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_speedtestLastResult) { toast('Run a speedtest first', 'warning'); return; }
      const pct = parseInt(btn.dataset.speedtestApply, 10);
      const targetKbps = Math.round(_speedtestLastResult.kbps * (pct / 100));
      // Set the throttle KB/s field and trigger live preview
      const throttleField = document.querySelector('.func-mod [data-key="throttle_kbps"]');
      if (throttleField) {
        throttleField.value = String(targetKbps);
        throttleField.dispatchEvent(new Event('change'));
      }
      const throttleOn = document.querySelector('.func-mod [data-key="throttle_on"]');
      if (throttleOn && !throttleOn.checked) {
        throttleOn.checked = true;
        throttleOn.dispatchEvent(new Event('change'));
      }
      toast(`Throttle set to ${targetKbps} KB/s (${pct}% of your line)`, 'info');
    });
  });
}

// v3.1.0 (real-networks batch) — Bandwidth quota.
// Reads/writes the config fields directly via pushConfig flow.
function hookQuota() {
  const toggle = document.getElementById('quota-on-toggle');
  const mb = document.getElementById('quota-mb');
  const action = document.getElementById('quota-action');
  const kbps = document.getElementById('quota-throttle-kbps');
  if (!toggle || !mb || !action || !kbps) return;

  // Live-preview pattern (matches the rest of the app): on change, push
  // the full config payload to the backend.
  const pushQuota = () => {
    if (typeof pushConfig === 'function') pushConfig();
  };
  toggle.addEventListener('change', pushQuota);
  mb.addEventListener('change', pushQuota);
  action.addEventListener('change', pushQuota);
  kbps.addEventListener('change', pushQuota);
}

// v3.1.0 (real-networks batch) — DNS chaos.
function hookDnsChaos() {
  const toggle = document.getElementById('dns-chaos-toggle');
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    if (typeof pushConfig === 'function') pushConfig();
  });
}

// v3.1.0 (real-networks batch) — Bursty drop pattern.
function hookBurstyDrop() {
  const pattern = document.getElementById('drop-pattern');
  const burstLen = document.getElementById('drop-burst-len');
  const gapLen = document.getElementById('drop-gap-len');
  if (!pattern) return;
  const push = () => { if (typeof pushConfig === 'function') pushConfig(); };
  pattern.addEventListener('change', push);
  if (burstLen) burstLen.addEventListener('change', push);
  if (gapLen) gapLen.addEventListener('change', push);
}

function setupModals() {
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('profiles-btn').addEventListener('click', openProfiles);

  // Close buttons & overlay click-outside
  document.querySelectorAll('[data-close-modal]').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.closeModal;
      if (id === 'settings-modal') cancelSettings();
      else hideModal(id);
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => {
      if (e.target !== ov) return;
      if (ov.id === 'settings-modal') cancelSettings();
      else hideModal(ov.id);
    });
  });
  // Escape key closes top modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = ['settings-modal','profiles-modal','app-picker-modal']
      .map(id => document.getElementById(id))
      .filter(m => m && !m.hidden);
    if (open.length === 0) return;
    const top = open[open.length-1];
    if (top.id === 'settings-modal') cancelSettings();
    else hideModal(top.id);
  });

  // Tabs
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      const modal = btn.closest('.modal');
      modal.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
      modal.querySelectorAll('.tab-pane').forEach(p =>
        p.classList.toggle('active', p.dataset.pane === target));
      // v3.1.2 — animate the newly-shown pane's content in
      const activePane = modal.querySelector(`.tab-pane[data-pane="${target}"]`);
      if (activePane) {
        Anim.fadeIn(activePane, { distance: 10, duration: 340 });
        // Stagger direct children rows for a richer feel on dense panes
        const rows = activePane.querySelectorAll(':scope > .check-row, :scope > .field-row, :scope > .setting-row, :scope > label, :scope > .design-grid, :scope > .row-actions');
        if (rows.length > 1 && rows.length <= 24) {
          Anim.staggerIn(rows, { each: 22, distance: 8, duration: 300 });
        }
      }
    });
  });

  // v3.1.0 — Settings search bar.
  // Scans all settings tab panes for matching labels/keys/hint text and:
  //   * highlights matching rows
  //   * dims sibling rows in panes that have matches
  //   * appends a match-count badge to each tab button
  //   * dims tab buttons whose panes have zero matches
  // ESC or the × button clears.
  setupSettingsSearch();

  // Theme tile click — visual only (saved on Save)
  document.querySelectorAll('.theme-tile').forEach(tile =>
    tile.addEventListener('click', () => applyTheme(tile.dataset.theme)));

  // Design tile click — also visual only, saved on Save
  document.querySelectorAll('.design-tile').forEach(tile =>
    tile.addEventListener('click', () => applyDesign(tile.dataset.design)));

  // Midnight accent tile click
  document.querySelectorAll('.midnight-tile').forEach(tile =>
    tile.addEventListener('click', () => applyMidnightAccent(tile.dataset.midnightAccent)));

  document.getElementById('test-sound').addEventListener('click', () => {
    bridge.playTone(523, 60);
    setTimeout(() => bridge.playTone(659, 60), 80);
    setTimeout(() => bridge.playTone(784, 80), 160);
  });

  // ----- Live-preview wiring (no save until Save) -----
  hookLivePreview();

  // ----- Action buttons in Customize / Advanced tabs -----
  hookCustomizeTab();
  hookAdvancedTab();

  // v3.1.0 (network-visibility) — Latency probe wiring
  hookLatencyProbe();
  // v3.1.0 (real-networks batch) — speedtest, quota, DNS chaos, bursty
  hookSpeedtest();
  hookQuota();
  hookDnsChaos();
  hookBurstyDrop();

  // Save / Cancel
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('save-profile').addEventListener('click', saveCurrentProfile);

  // Border preview buttons
  document.getElementById('preview-border-running').addEventListener('click', () => {
    bridge.previewScreenBorderRunning();
  });
  document.getElementById('preview-border-stopped').addEventListener('click', () => {
    bridge.previewScreenBorderStopped();
  });
}

function hookLivePreview() {
  // Overlay
  document.getElementById('show-overlay').addEventListener('change', (e) => {
    bridge.setOverlayVisible(e.target.checked);
  });
  document.getElementById('overlay-mode').addEventListener('change', (e) => {
    bridge.setOverlayMode(e.target.value);
  });
  document.getElementById('overlay-locked').addEventListener('change', (e) => {
    bridge.setOverlayLocked(e.target.checked);
  });
  const opSlider = document.getElementById('overlay-opacity');
  opSlider.addEventListener('input', () => {
    document.getElementById('overlay-opacity-display').textContent = `${opSlider.value}%`;
    bridge.setOverlayOpacity(parseInt(opSlider.value, 10));
  });

  // Screen border
  document.getElementById('screen-border-enabled').addEventListener('change', (e) => {
    bridge.setScreenBorderEnabled(e.target.checked);
  });
  const borderDur = document.getElementById('border-duration');
  borderDur.addEventListener('input', () => {
    const ms = parseInt(borderDur.value, 10);
    document.getElementById('border-duration-display').textContent = `${(ms/1000).toFixed(1)}s`;
    bridge.setScreenBorderDuration(ms);
  });
  const borderFeather = document.getElementById('border-feather');
  borderFeather.addEventListener('input', () => {
    document.getElementById('border-feather-display').textContent = `${borderFeather.value} px`;
    bridge.setScreenBorderFeather(parseInt(borderFeather.value, 10));
  });

  // Compact + CRT
  document.getElementById('compact-mode').addEventListener('change', (e) => {
    document.body.dataset.compact = e.target.checked ? "true" : "false";
  });
  document.getElementById('crt-effects').addEventListener('change', (e) => {
    document.body.dataset.crt = e.target.checked ? "on" : "off";
  });
  // v3.1.2 — Animations master toggle. Live-applies so the user sees
  // the effect immediately without saving. When turning ON, give a
  // little confirmation pop on the row so the change feels tangible.
  const animToggle = document.getElementById('animations-enabled');
  if (animToggle) animToggle.addEventListener('change', (e) => {
    Anim.setEnabled(e.target.checked);
    if (e.target.checked) {
      Anim.pop(e.target.closest('.check-row'), { from: 0.96, duration: 280 });
    }
  });

  // Sound vol display
  const volSlider = document.getElementById('sound-volume');
  volSlider.addEventListener('input', () => {
    document.getElementById('sound-volume-display').textContent = `${volSlider.value}%`;
  });

  // Phase 1: sound effects volume display
  const sfxVol = document.getElementById('sound-effects-volume');
  if (sfxVol) {
    sfxVol.addEventListener('input', () => {
      const disp = document.getElementById('sound-effects-volume-display');
      if (disp) disp.textContent = `${sfxVol.value}%`;
    });
  }

  // Advanced — live preview where it makes sense
  document.getElementById('main-always-on-top').addEventListener('change', (e) => {
    bridge.setMainAlwaysOnTop(e.target.checked);
  });
  const statsInt = document.getElementById('stats-interval');
  statsInt.addEventListener('input', () => {
    document.getElementById('stats-interval-display').textContent = `${statsInt.value} ms`;
    bridge.setStatsInterval(parseInt(statsInt.value, 10));
  });
  const appsRef = document.getElementById('apps-refresh');
  appsRef.addEventListener('input', () => {
    document.getElementById('apps-refresh-display').textContent = `${(parseInt(appsRef.value,10)/1000).toFixed(1)}s`;
    bridge.setAppsRefreshInterval(parseInt(appsRef.value, 10));
  });
  const animSpd = document.getElementById('anim-speed');
  animSpd.addEventListener('input', () => {
    document.getElementById('anim-speed-display').textContent = `${parseFloat(animSpd.value).toFixed(1)}×`;
    document.documentElement.style.setProperty('--anim-speed', animSpd.value);
  });
  const toastDur = document.getElementById('toast-duration');
  toastDur.addEventListener('input', () => {
    document.getElementById('toast-duration-display').textContent =
      `${(parseInt(toastDur.value,10)/1000).toFixed(1)}s`;
    _toastDurationMs = parseInt(toastDur.value, 10);
  });

  // Reset stats now (live action, no save needed)
  document.getElementById('reset-stats-btn').addEventListener('click', () => {
    bridge.resetStats(); toast('Stats reset', 'success');
  });
}

// ============== CUSTOMIZE TAB ==============
function hookCustomizeTab() {
  document.getElementById('add-row-btn').addEventListener('click', () => {
    const t = document.getElementById('add-row-type').value;
    _draftLayout.push({ type: t, visible: true });
    renderLayoutList();
    pushDraftLayoutLive();
  });
  document.getElementById('reset-layout-btn').addEventListener('click', () => {
    _draftLayout = [
      { type:'status_row',      visible:true },
      { type:'app_row',         visible:true },
      { type:'stats3',          visible:true },
    ];
    renderLayoutList();
    pushDraftLayoutLive();
    toast('Layout reset to default', 'success');
  });
  document.getElementById('save-preset-btn').addEventListener('click', saveOverlayPreset);
}

function renderLayoutList() {
  const ul = document.getElementById('layout-list');
  ul.innerHTML = '';
  if (_draftLayout.length === 0) {
    ul.innerHTML = '<li style="cursor:default;justify-content:center;color:var(--bone-dim);font-style:italic">Empty layout — add rows below</li>';
    return;
  }
  _draftLayout.forEach((row, idx) => {
    const li = document.createElement('li');
    li.className = (row.visible ? 'visible' : 'hidden-row');
    li.draggable = true;
    li.dataset.idx = String(idx);
    li.innerHTML = `
      <span class="ll-handle" title="Drag to reorder">≡</span>
      <span class="ll-name">${escapeHTML(ROW_LABELS[row.type] || row.type)}</span>
      <span class="ll-toggle" data-action="toggle" title="Show/hide"></span>
      <div class="ll-actions">
        <button class="ll-btn" data-action="up"   title="Move up">▲</button>
        <button class="ll-btn" data-action="down" title="Move down">▼</button>
        <button class="ll-btn del" data-action="del" title="Remove">×</button>
      </div>
    `;
    li.querySelector('[data-action="toggle"]').addEventListener('click', () => {
      row.visible = !row.visible;
      renderLayoutList();
      pushDraftLayoutLive();
    });
    li.querySelector('[data-action="up"]').addEventListener('click', () => {
      if (idx === 0) return;
      [_draftLayout[idx-1], _draftLayout[idx]] = [_draftLayout[idx], _draftLayout[idx-1]];
      renderLayoutList();
      pushDraftLayoutLive();
    });
    li.querySelector('[data-action="down"]').addEventListener('click', () => {
      if (idx === _draftLayout.length - 1) return;
      [_draftLayout[idx+1], _draftLayout[idx]] = [_draftLayout[idx], _draftLayout[idx+1]];
      renderLayoutList();
      pushDraftLayoutLive();
    });
    li.querySelector('[data-action="del"]').addEventListener('click', () => {
      _draftLayout.splice(idx, 1);
      renderLayoutList();
      pushDraftLayoutLive();
    });

    // Native drag & drop reorder
    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      ul.querySelectorAll('li').forEach(l => l.classList.remove('drop-target-above','drop-target-below'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const above = (e.clientY - r.top) < r.height / 2;
      ul.querySelectorAll('li').forEach(l => l.classList.remove('drop-target-above','drop-target-below'));
      li.classList.add(above ? 'drop-target-above' : 'drop-target-below');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (Number.isNaN(fromIdx) || fromIdx === idx) return;
      const r = li.getBoundingClientRect();
      const above = (e.clientY - r.top) < r.height / 2;
      let toIdx = above ? idx : idx + 1;
      if (fromIdx < toIdx) toIdx -= 1;
      const [moved] = _draftLayout.splice(fromIdx, 1);
      _draftLayout.splice(toIdx, 0, moved);
      renderLayoutList();
      pushDraftLayoutLive();
    });
    ul.appendChild(li);
  });
}

function pushDraftLayoutLive() {
  // Apply as live preview AND auto-switch the Mode dropdown to Custom so
  // the user immediately sees the result. Without this the overlay flips
  // to custom mode internally but the dropdown still says Compact, which
  // is confusing — and on Save would persist mode=compact, ignoring the
  // custom layout.
  const modeSelect = document.getElementById('overlay-mode');
  if (modeSelect && modeSelect.value !== 'custom') {
    modeSelect.value = 'custom';
    bridge.setOverlayMode('custom');
  }
  bridge.setOverlayLayout(JSON.stringify(_draftLayout));
}

function saveOverlayPreset() {
  const nameEl = document.getElementById('preset-name');
  const name = nameEl.value.trim();
  if (!name) { toast('Enter a preset name', 'error'); return; }
  bridge.getSettings().then(json => {
    const s = JSON.parse(json);
    const presets = s.overlay_presets || {};
    presets[name] = JSON.parse(JSON.stringify(_draftLayout));
    bridge.saveSettings(JSON.stringify({ overlay_presets: presets })).then(ok => {
      if (ok) {
        toast(`Saved preset: ${name}`, 'success');
        nameEl.value = '';
        refreshPresetList(presets);
      } else toast('Save failed', 'error');
    });
  });
}

function refreshPresetList(presets) {
  const list = document.getElementById('preset-list');
  list.innerHTML = '';
  const names = Object.keys(presets || {});
  if (names.length === 0) {
    list.innerHTML = '<div class="loading">No saved presets yet</div>';
    return;
  }
  for (const name of names) {
    const div = document.createElement('div');
    div.className = 'profile-item';
    div.innerHTML = `
      <span class="name">${escapeHTML(name)}</span>
      <button class="load">Load</button>
      <button class="delete">Delete</button>
    `;
    div.querySelector('.load').addEventListener('click', () => {
      _draftLayout = JSON.parse(JSON.stringify(presets[name]));
      renderLayoutList();
      pushDraftLayoutLive();
      toast(`Loaded preset: ${name}`, 'success');
    });
    div.querySelector('.delete').addEventListener('click', () => {
      delete presets[name];
      bridge.saveSettings(JSON.stringify({ overlay_presets: presets })).then(() => {
        refreshPresetList(presets);
        toast(`Deleted: ${name}`, 'success');
      });
    });
    list.appendChild(div);
  }
}

// ============== ADVANCED TAB ==============
function hookAdvancedTab() {
  document.getElementById('export-settings-btn').addEventListener('click', () => {
    bridge.exportSettingsJson().then(json => {
      // Trigger a download via blob
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `throttlr-settings-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('Settings exported', 'success');
    });
  });
  document.getElementById('import-settings-btn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', () => {
      const file = inp.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        bridge.importSettingsJson(reader.result).then(ok => {
          if (ok) {
            toast('Settings imported — reopen Settings to refresh', 'success');
            // Re-fetch fresh settings on next open
            _origSettings = null;
          } else {
            toast('Import failed — invalid JSON', 'error');
          }
        });
      };
      reader.readAsText(file);
    });
    inp.click();
  });
  document.getElementById('reset-settings-btn').addEventListener('click', () => {
    if (!confirm('Reset ALL settings to factory defaults? This cannot be undone.')) return;
    bridge.resetSettingsToDefaults().then(ok => {
      if (ok) {
        toast('Settings reset to defaults', 'success');
        // Re-load settings into UI immediately
        bridge.getSettings().then(json => {
          const s = JSON.parse(json);
          _origSettings = JSON.parse(JSON.stringify(s));
          populateSettingsUI(s);
        });
      } else toast('Reset failed', 'error');
    });
  });

  // Diagnostics — surfaces the current capture state so user can verify
  document.getElementById('show-diag-btn').addEventListener('click', () => {
    bridge.getDiagnostics().then(json => {
      try {
        const d = JSON.parse(json);
        if (d.error) { toast(`Diagnostics error: ${d.error}`, 'error'); return; }
        const onOff = (b) => b ? 'ON' : 'off';
        const lines = [
          `Target: ${d.target_name || '(none)'} — ${d.target_pid_count} PID${d.target_pid_count === 1 ? '' : 's'}`,
          `Capture: ${onOff(d.running)} | FLOW listener: ${d.flow_listener ? 'ACTIVE' : 'inactive (psutil only)'} | Conn map: ${d.conn_map_size} entries`,
          `Seen ${d.packets_seen.toLocaleString()} | Dropped ${d.packets_dropped.toLocaleString()} | Delayed ${d.packets_delayed.toLocaleString()} | Held ${d.packets_held.toLocaleString()}`,
          `Lag ${onOff(d.lag_on)} (${d.lag_ms}ms) · Drop ${onOff(d.drop_on)} (${d.drop_chance}%) · Throttle ${onOff(d.throttle_on)} (${d.throttle_kbps} KB/s)`,
          `Freeze ${onOff(d.freeze_on)} — ${d.freeze_queue_len} queued · Block ${onOff(d.block_on)} · Fun ${onOff(d.fun_mode)}`,
          `Delay queue: ${d.delay_queue_len} pending`,
        ];
        // Show as a long success toast; Billy can screenshot it
        toast(lines.join('\n'), 'success', 12000);
      } catch (e) {
        toast(`Could not parse diagnostics: ${e}`, 'error');
      }
    });
  });
}

// ============== SETTINGS OPEN / SAVE / CANCEL ==============
function openSettings() {
  bridge.getSettings().then((json) => {
    const s = JSON.parse(json);
    _origSettings = JSON.parse(JSON.stringify(s));   // snapshot for revert
    populateSettingsUI(s);
    refreshAutoLoadProfileDropdown(s.auto_load_profile || '');
    refreshPresetList(s.overlay_presets || {});
    // v3.0.7 — wire the drop-pct toggle for live preview. Only once.
    const dropPctCb = document.getElementById('show-drop-pct');
    if (dropPctCb && !dropPctCb.dataset.wired) {
      dropPctCb.dataset.wired = '1';
      dropPctCb.addEventListener('change', () => {
        _showDropPct = !!dropPctCb.checked;
        const pctEl = document.getElementById('mini-drop-pct');
        if (pctEl && !_showDropPct) {
          pctEl.hidden = true;
        }
        // If switching on, it'll populate on the next onStatsChanged tick
      });
    }
    showModal('settings-modal');
    // v3.1.0 — reset search state every open so the modal looks clean
    const _searchInput = document.getElementById('settings-search');
    if (_searchInput && _searchInput.value) {
      _searchInput.value = '';
      _searchInput.dispatchEvent(new Event('input'));
    }
  });
}

function populateSettingsUI(s) {
  // v3.1.1 — Compute hasActiveCustom BEFORE applying anything. If a
  // custom theme is active, applyTheme(s.theme) would clobber its
  // body.dataset.theme attribute and tear down the custom CSS overrides
  // — causing the visible "theme flickers back to base" bug when the
  // user just clicked Settings or Customize. The custom theme is
  // already correctly applied via applyCustomTheme, so we leave it
  // alone in that branch.
  //
  // Check THREE sources, in priority order:
  //   1. body.dataset.customTheme — the DOM-truth: what's actually being
  //      displayed right now. Set by applyCustomTheme. Most authoritative.
  //   2. window._activeCustomThemeId — in-memory: tracks the active
  //      custom theme even before settings are saved.
  //   3. s.active_custom_theme — what was last persisted to disk.
  // Any of these being set means a custom theme should be preserved.
  // Previous version only checked #3, which broke when the user applied
  // a custom theme but hadn't clicked Save before reopening Settings.
  const domCustomTheme = document.body.dataset.customTheme || '';
  const memoryCustomTheme = window._activeCustomThemeId || '';
  const savedCustomTheme = s.active_custom_theme || '';
  const currentCustomThemeId = domCustomTheme || memoryCustomTheme || savedCustomTheme;
  const hasActiveCustom = !!currentCustomThemeId &&
    (window._installedCustomThemes || []).some(t => t.id === currentCustomThemeId);

  if (!hasActiveCustom) {
    // No custom theme — safe to apply the base theme normally
    applyTheme(s.theme || 'lethal');
    applyDesign(s.ui_design || 'industrial');
  } else {
    // Custom theme is active — don't touch body data, just update
    // the design-tile selection state to reflect the right tile.
    const baseDesign = (window._installedCustomThemes || [])
      .find(t => t.id === currentCustomThemeId)?.base || 'industrial';
    document.querySelectorAll('.design-tile').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.design-tile.custom-theme').forEach(el =>
      el.classList.toggle('active', el.dataset.customThemeId === currentCustomThemeId));
    void baseDesign; // body.dataset.design was set on apply
    // Also make sure the base-theme tile selection reflects what's
    // saved (so the user can see which built-in theme they'd revert
    // to if they switched away from the custom theme).
    document.querySelectorAll('.theme-tile').forEach(t =>
      t.classList.toggle('active', t.dataset.theme === (s.theme || 'lethal')));
  }
  applyMidnightAccent(s.midnight_accent || 'aurora');
  // If active_custom_theme is set but the manifest list hasn't loaded yet,
  // re-apply once it has — covers the race where settings opens before
  // setupCustomThemes finishes loading the themes.
  if (currentCustomThemeId && !hasActiveCustom) {
    setTimeout(() => {
      const exists = (window._installedCustomThemes || []).some(t => t.id === currentCustomThemeId);
      if (exists) applyCustomTheme(currentCustomThemeId);
    }, 250);
  }
  populateHotkeys(s);
  const setBool = (id, v) => { const e = document.getElementById(id); if (e) e.checked = !!v; };
  const setVal  = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };

  // Appearance
  setBool('compact-mode', s.compact_mode);
  setBool('crt-effects',  s.crt_effects !== false);
  setBool('animations-enabled', s.animations_enabled !== false);  // v3.1.2 — default ON
  document.body.dataset.compact = s.compact_mode ? "true" : "false";
  document.body.dataset.crt = (s.crt_effects === false) ? "off" : "on";
  Anim.setEnabled(s.animations_enabled !== false);

  // Hotkeys
  setBool('hotkey-notifications', s.hotkey_notifications !== false);

  // Overlay
  setBool('show-overlay', s.show_overlay !== false);
  setVal('overlay-mode', s.overlay_mode || (s.overlay_advanced ? 'advanced' : 'compact'));
  setBool('overlay-locked', s.overlay_locked);
  setVal('overlay-opacity', s.overlay_opacity ?? 95);
  document.getElementById('overlay-opacity-display').textContent = `${s.overlay_opacity ?? 95}%`;
  setBool('screen-border-enabled', s.screen_border_enabled);
  setVal('border-duration', s.screen_border_duration_ms ?? 2000);
  document.getElementById('border-duration-display').textContent =
    `${((s.screen_border_duration_ms ?? 2000)/1000).toFixed(1)}s`;
  setVal('border-feather', s.screen_border_feather ?? 90);
  document.getElementById('border-feather-display').textContent = `${s.screen_border_feather ?? 90} px`;

  // Customize
  _draftLayout = Array.isArray(s.overlay_layout) && s.overlay_layout.length
    ? JSON.parse(JSON.stringify(s.overlay_layout))
    : [
        { type:'status_row', visible:true },
        { type:'app_row',    visible:true },
        { type:'stats3',     visible:true },
      ];
  renderLayoutList();

  // Sound
  setBool('sound-enabled', s.sound_enabled);
  setVal('sound-volume', s.sound_volume ?? 100);
  document.getElementById('sound-volume-display').textContent = `${s.sound_volume ?? 100}%`;

  // Behavior
  setBool('auto-start', s.auto_start_on_launch);
  setBool('auto-clear', s.auto_clear_freeze_queue);
  setBool('reset-stats-start', s.reset_stats_on_start);
  setBool('confirm-quit', s.confirm_before_quit !== false);
  // v3.1.0 — Auto-pause on idle
  setBool('auto-pause-idle', s.auto_pause_on_idle === true);
  const apiSec = document.getElementById('auto-pause-idle-seconds');
  if (apiSec) apiSec.value = String(s.auto_pause_idle_seconds || 30);
  _autoPauseIdleOn = (s.auto_pause_on_idle === true);
  _idleThresholdMs = Math.max(5, parseInt(s.auto_pause_idle_seconds || 30, 10)) * 1000;
  setVal('auto-stop-minutes', s.auto_stop_minutes ?? 0);

  // Advanced
  setVal('stats-interval', s.stats_interval_ms ?? 200);
  document.getElementById('stats-interval-display').textContent = `${s.stats_interval_ms ?? 200} ms`;
  setVal('apps-refresh', s.apps_refresh_ms ?? 2000);
  document.getElementById('apps-refresh-display').textContent =
    `${((s.apps_refresh_ms ?? 2000)/1000).toFixed(1)}s`;
  setBool('skip-localhost', s.skip_localhost !== false);
  setBool('verbose-logging', s.verbose_logging);
  setBool('main-always-on-top', s.main_always_on_top);
  setVal('anim-speed', s.anim_speed ?? 1);
  document.getElementById('anim-speed-display').textContent = `${parseFloat(s.anim_speed ?? 1).toFixed(1)}×`;
  document.documentElement.style.setProperty('--anim-speed', s.anim_speed ?? 1);
  setVal('toast-duration', s.toast_duration_ms ?? 3500);
  document.getElementById('toast-duration-display').textContent =
    `${((s.toast_duration_ms ?? 3500)/1000).toFixed(1)}s`;
  setVal('number-format', s.number_format || 'raw');
  setBool('tooltips-enabled', s.tooltips_enabled !== false);

  // Phase 1 settings
  setBool('sound-effects-enabled',  s.sound_effects_enabled !== false);
  setVal('sound-effects-volume',    s.sound_effects_volume ?? 80);
  const sfxDisp = document.getElementById('sound-effects-volume-display');
  if (sfxDisp) sfxDisp.textContent = `${s.sound_effects_volume ?? 80}%`;
  setBool('overlay-stream-safe',    !!s.overlay_stream_safe);
  setBool('overlay-ghost-mode',     !!s.overlay_ghost_mode);
  setBool('auto-load-preset',       s.auto_load_per_app_preset !== false);
  setBool('animated-icon',          s.animated_icon !== false);
  // v3.0.7 — drop rate % badge toggle (default off)
  setBool('show-drop-pct',          !!s.show_drop_pct);
  _showDropPct = !!s.show_drop_pct;
  // Hide the badge immediately if the toggle is off, in case it was visible
  const pctEl0 = document.getElementById('mini-drop-pct');
  if (pctEl0 && !_showDropPct) pctEl0.hidden = true;
  setVal('midnight-custom-hex',     s.midnight_custom_color || '');
  const cp = document.getElementById('midnight-custom-color');
  if (cp && /^#[0-9a-fA-F]{6}$/.test(s.midnight_custom_color || '')) {
    cp.value = s.midnight_custom_color;
  }

  // Refresh the per-app-presets list (Behavior tab)
  appSettings.per_app_presets = s.per_app_presets || {};
  refreshPerAppPresetsList();
}

function refreshAutoLoadProfileDropdown(currentValue) {
  bridge.listProfiles().then(json => {
    try {
      const names = JSON.parse(json) || [];
      const sel = document.getElementById('auto-load-profile');
      if (!sel) return;
      sel.innerHTML = '<option value="">(none)</option>' +
        names.map(n => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join('');
      sel.value = currentValue || '';
    } catch {}
  });
}

function cancelSettings() {
  // Revert any live-applied state to the snapshot we took on open
  if (_origSettings) {
    const s = _origSettings;
    // v3.1.1 — Check DOM and in-memory state too, not just saved
    // settings. Same priority as populateSettingsUI: DOM truth >
    // in-memory > persisted. This prevents the cancel-flicker bug
    // when a custom theme is applied but not yet saved.
    const domCustomTheme = document.body.dataset.customTheme || '';
    const memoryCustomTheme = window._activeCustomThemeId || '';
    const savedCustomTheme = s.active_custom_theme || '';
    const currentCustomThemeId = domCustomTheme || memoryCustomTheme || savedCustomTheme;
    const hasActiveCustom = !!currentCustomThemeId &&
      (window._installedCustomThemes || []).some(t => t.id === currentCustomThemeId);
    if (hasActiveCustom) {
      // Re-apply the custom theme directly — it'll set body.dataset.theme
      // and inject any custom CSS overrides. No need to bounce through
      // applyTheme first.
      applyCustomTheme(currentCustomThemeId);
      // Update base-theme tile selection so the UI reflects the saved
      // base (in case the user clicked around different themes during
      // the now-cancelled session).
      document.querySelectorAll('.theme-tile').forEach(t =>
        t.classList.toggle('active', t.dataset.theme === (s.theme || 'lethal')));
    } else {
      applyTheme(s.theme || 'lethal');
      applyDesign(s.ui_design || 'industrial');
      // v3.0.6 — clear any overlay theme preview that the user kicked off
      // by hovering theme tiles before cancelling. Empty theme_id tells the
      // overlay to rebuild its palette from settings (i.e. the snapshot).
      try {
        if (typeof bridge !== 'undefined' && bridge.previewOverlayTheme) {
          bridge.previewOverlayTheme('', '');
        }
      } catch (e) { /* preview is best-effort */ }
    }
    applyMidnightAccent(s.midnight_accent || 'aurora');
    document.body.dataset.compact = s.compact_mode ? "true" : "false";
    document.body.dataset.crt = (s.crt_effects === false) ? "off" : "on";
    Anim.setEnabled(s.animations_enabled !== false);  // v3.1.2 — restore on cancel

    bridge.setOverlayVisible(s.show_overlay !== false);
    bridge.setOverlayMode(s.overlay_mode || (s.overlay_advanced ? 'advanced' : 'compact'));
    bridge.setOverlayLocked(!!s.overlay_locked);
    bridge.setOverlayOpacity(s.overlay_opacity ?? 95);

    bridge.setScreenBorderEnabled(!!s.screen_border_enabled);
    bridge.setScreenBorderDuration(s.screen_border_duration_ms ?? 2000);
    bridge.setScreenBorderFeather(s.screen_border_feather ?? 90);

    bridge.setMainAlwaysOnTop(!!s.main_always_on_top);
    bridge.setStatsInterval(s.stats_interval_ms ?? 200);
    bridge.setAppsRefreshInterval(s.apps_refresh_ms ?? 2000);

    bridge.setOverlayLayout(JSON.stringify(
      Array.isArray(s.overlay_layout) ? s.overlay_layout : []
    ));

    document.documentElement.style.setProperty('--anim-speed', s.anim_speed ?? 1);
    _toastDurationMs = s.toast_duration_ms ?? 3500;
  }
  hideModal('settings-modal');
}

function saveSettings() {
  const newSettings = {
    theme: document.body.dataset.theme,
    ui_design: document.body.dataset.design || 'industrial',
    midnight_accent: document.body.dataset.midnightAccent || 'aurora',
    active_custom_theme: window._activeCustomThemeId || '',

    hotkey_startstop:  document.getElementById('hk-startstop').dataset.value || '',
    hotkey_freeze:     document.getElementById('hk-freeze').dataset.value || '',
    hotkey_block:      document.getElementById('hk-block').dataset.value || '',
    hotkey_fun:        document.getElementById('hk-fun').dataset.value || '',
    hotkey_killswitch: document.getElementById('hk-killswitch').dataset.value || '',
    hotkey_notifications: document.getElementById('hotkey-notifications').checked,

    sound_enabled: document.getElementById('sound-enabled').checked,
    sound_volume:  parseInt(document.getElementById('sound-volume').value, 10),

    auto_start_on_launch:      document.getElementById('auto-start').checked,
    auto_clear_freeze_queue:   document.getElementById('auto-clear').checked,
    reset_stats_on_start:      document.getElementById('reset-stats-start').checked,
    confirm_before_quit:       document.getElementById('confirm-quit').checked,
    // v3.1.0 — Auto-pause on idle
    auto_pause_on_idle:        document.getElementById('auto-pause-idle')?.checked || false,
    auto_pause_idle_seconds:   Math.max(5, parseInt(document.getElementById('auto-pause-idle-seconds')?.value || 30, 10)),
    auto_stop_minutes:         parseInt(document.getElementById('auto-stop-minutes').value, 10) || 0,

    show_overlay:        document.getElementById('show-overlay').checked,
    overlay_mode:        document.getElementById('overlay-mode').value,
    overlay_advanced:    document.getElementById('overlay-mode').value === 'advanced',
    overlay_locked:      document.getElementById('overlay-locked').checked,
    overlay_opacity:     parseInt(document.getElementById('overlay-opacity').value, 10),
    overlay_layout:      _draftLayout,

    screen_border_enabled:     document.getElementById('screen-border-enabled').checked,
    screen_border_duration_ms: parseInt(document.getElementById('border-duration').value, 10),
    screen_border_feather:     parseInt(document.getElementById('border-feather').value, 10),

    compact_mode: document.getElementById('compact-mode').checked,
    crt_effects:  document.getElementById('crt-effects').checked,
    animations_enabled: document.getElementById('animations-enabled').checked,

    stats_interval_ms:   parseInt(document.getElementById('stats-interval').value, 10),
    apps_refresh_ms:     parseInt(document.getElementById('apps-refresh').value, 10),
    skip_localhost:      document.getElementById('skip-localhost').checked,
    verbose_logging:     document.getElementById('verbose-logging').checked,
    main_always_on_top:  document.getElementById('main-always-on-top').checked,
    anim_speed:          parseFloat(document.getElementById('anim-speed').value),
    toast_duration_ms:   parseInt(document.getElementById('toast-duration').value, 10),
    number_format:       document.getElementById('number-format').value,
    tooltips_enabled:    document.getElementById('tooltips-enabled').checked,
    auto_load_profile:   document.getElementById('auto-load-profile').value,

    // Phase 1 settings
    sound_effects_enabled:    (document.getElementById('sound-effects-enabled') || {}).checked || false,
    sound_effects_volume:     parseInt((document.getElementById('sound-effects-volume') || {}).value, 10) || 80,
    overlay_stream_safe:      (document.getElementById('overlay-stream-safe') || {}).checked || false,
    overlay_ghost_mode:       (document.getElementById('overlay-ghost-mode') || {}).checked || false,
    auto_load_per_app_preset: (document.getElementById('auto-load-preset') || {}).checked !== false,
    animated_icon:            (document.getElementById('animated-icon') || {}).checked !== false,
    midnight_custom_color:    (document.getElementById('midnight-custom-hex') || {}).value || '',
    // v3.0.7 — drop rate % badge toggle
    show_drop_pct:            (document.getElementById('show-drop-pct') || {}).checked || false,
  };
  const hk = [newSettings.hotkey_startstop, newSettings.hotkey_freeze,
              newSettings.hotkey_block, newSettings.hotkey_fun];
  if (new Set(hk).size !== hk.length) {
    toast("Hotkey collision — each one must be unique", 'error');
    return;
  }
  bridge.saveSettings(JSON.stringify(newSettings)).then((ok) => {
    if (ok) {
      toast('Settings saved', 'success');
      updateHotkeyChips(newSettings);
      applyAppearance(newSettings);
      _hotkeyNotifications = newSettings.hotkey_notifications;
      _toastDurationMs = newSettings.toast_duration_ms;
      _origSettings = JSON.parse(JSON.stringify(newSettings));   // refresh snapshot
      hideModal('settings-modal');
    } else toast('Save failed', 'error');
  });
}

// ============== PROFILES MODAL ==============
function openProfiles() {
  showModal('profiles-modal');
  refreshProfiles();
}

function saveCurrentProfile() {
  const name = document.getElementById('profile-name').value.trim();
  if (!name) { toast('Enter a profile name', 'error'); return; }
  const cfg = collectProfileData();
  bridge.saveProfile(name, JSON.stringify(cfg)).then((ok) => {
    if (ok) {
      toast(`Saved profile: ${name}`, 'success');
      document.getElementById('profile-name').value = '';
      refreshProfiles();
    } else toast('Save failed', 'error');
  });
}

function refreshProfiles() {
  bridge.listProfiles().then((json) => {
    const list = document.getElementById('profile-list');
    const profiles = JSON.parse(json);
    list.innerHTML = '';
    if (profiles.length === 0) {
      list.innerHTML = '<div class="loading">No saved profiles yet</div>';
      return;
    }
    for (const name of profiles) {
      const div = document.createElement('div');
      div.className = 'profile-item';
      div.innerHTML = `
        <span class="name">${escapeHTML(name)}</span>
        <button class="load">Load</button>
        <button class="delete">Delete</button>`;
      div.querySelector('.load').addEventListener('click', () => {
        bridge.loadProfile(name).then((data) => {
          if (data) {
            applyProfileData(JSON.parse(data));
            toast(`Loaded: ${name}`, 'success');
            hideModal('profiles-modal');
          }
        });
      });
      div.querySelector('.delete').addEventListener('click', () => {
        bridge.deleteProfile(name).then((ok) => { if (ok) refreshProfiles(); });
      });
      list.appendChild(div);
    }
  });
}

function collectProfileData() {
  const cfg = {};
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') cfg[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') cfg[k] = parseInt(el.value, 10) || 0;
    else if (el.tagName === 'SELECT') cfg[k] = parseInt(el.value, 10) || 0;
    else cfg[k] = el.value;
  });
  return cfg;
}

function applyProfileData(data) {
  for (const [k, v] of Object.entries(data)) {
    const el = document.querySelector(`.func-mod [data-key="${k}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') { el.checked = !!v; el.dispatchEvent(new Event('change')); }
    else                        { el.value = v;     el.dispatchEvent(new Event('change')); }
  }
  pushConfig();
}

function populateHotkeys(s) {
  // v3.0.4 — click-to-capture buttons instead of dropdowns. User clicks
  // the button, presses a key, and that key is bound. Esc cancels,
  // Backspace unbinds. Way faster than scrolling a dropdown.
  const ids = {
    'hk-startstop':  s.hotkey_startstop  || 'F5',
    'hk-freeze':     s.hotkey_freeze     || 'F8',
    'hk-block':      s.hotkey_block      || 'F9',
    'hk-fun':        s.hotkey_fun        || 'F10',
    'hk-killswitch': s.hotkey_killswitch || '',
  };
  for (const [id, current] of Object.entries(ids)) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    _setHotkeyButton(btn, current);
    if (!btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => _startHotkeyCapture(btn));
    }
  }
}

function _setHotkeyButton(btn, value) {
  btn.dataset.value = value || '';
  btn.classList.remove('listening');
  btn.textContent = value && value.length ? value : '— None —';
}

let _hkCapturingBtn = null;
let _hkCaptureKeyHandler = null;
let _hkCaptureMouseHandler = null;

function _startHotkeyCapture(btn) {
  // Cancel any other in-flight capture first
  if (_hkCapturingBtn && _hkCapturingBtn !== btn) {
    _setHotkeyButton(_hkCapturingBtn, _hkCapturingBtn.dataset.value || '');
  }
  _hkCapturingBtn = btn;
  btn.classList.add('listening');
  btn.textContent = 'press a key or side mouse btn…';

  _hkCaptureKeyHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      // Cancel — restore previous value
      _setHotkeyButton(btn, btn.dataset.value || '');
      _stopHotkeyCapture();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      // Unbind
      _setHotkeyButton(btn, '');
      _stopHotkeyCapture();
      return;
    }
    // Modifier-only presses don't count — wait for an actual key
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

    const name = _eventToKeyName(e);
    if (!name) {
      // Couldn't translate — keep listening
      return;
    }
    _setHotkeyButton(btn, name);
    _stopHotkeyCapture();
  };

  // v3.0.7 — also accept mouse side buttons (Mouse4/Mouse5) and middle
  // click (Mouse3). Left + right click are deliberately NOT captured —
  // they'd swallow normal UI clicks and people would lose the ability to
  // interact with the app. So we only react to button >= 1 (excluding
  // primary=0 left, and secondary=2 right).
  _hkCaptureMouseHandler = (e) => {
    // button: 0=left, 1=middle, 2=right, 3=back/X1, 4=forward/X2
    let name = null;
    if (e.button === 1) name = 'Mouse3';
    else if (e.button === 3) name = 'Mouse4';
    else if (e.button === 4) name = 'Mouse5';
    if (!name) return;  // left/right click — ignore + let it bubble normally
    e.preventDefault();
    e.stopPropagation();
    _setHotkeyButton(btn, name);
    _stopHotkeyCapture();
  };

  // Capture phase + true so we beat any other listeners (incl. global shortcuts)
  document.addEventListener('keydown', _hkCaptureKeyHandler, true);
  document.addEventListener('mousedown', _hkCaptureMouseHandler, true);
}

function _stopHotkeyCapture() {
  if (_hkCaptureKeyHandler) {
    document.removeEventListener('keydown', _hkCaptureKeyHandler, true);
    _hkCaptureKeyHandler = null;
  }
  if (_hkCaptureMouseHandler) {
    document.removeEventListener('mousedown', _hkCaptureMouseHandler, true);
    _hkCaptureMouseHandler = null;
  }
  if (_hkCapturingBtn) {
    _hkCapturingBtn.classList.remove('listening');
  }
  _hkCapturingBtn = null;
}

function _eventToKeyName(e) {
  // Translate a KeyboardEvent into the canonical key name we store in
  // settings (and that the Python side understands via KEY_NAMES).
  const code = e.code || '';
  const key  = e.key  || '';

  // F1..F24
  if (/^F\d{1,2}$/.test(key)) return key;

  // Letters → uppercase single char
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);

  // Digits — top row + numpad
  if (code.startsWith('Digit'))   return code.slice(5);
  if (code.startsWith('Numpad') && /^\d$/.test(code.slice(6)))
    return 'Num' + code.slice(6);

  // Named keys
  const map = {
    'Space':       'Space',
    'Enter':       'Enter',
    'Tab':         'Tab',
    'Insert':      'Insert',
    'Home':        'Home',
    'End':         'End',
    'PageUp':      'Page Up',
    'PageDown':    'Page Down',
    'Pause':       'Pause',
    'ScrollLock':  'Scroll Lock',
    'PrintScreen': 'Print Screen',
    'ArrowUp':     'Up',
    'ArrowDown':   'Down',
    'ArrowLeft':   'Left',
    'ArrowRight':  'Right',
    'NumpadAdd':         'Num +',
    'NumpadSubtract':    'Num -',
    'NumpadMultiply':    'Num *',
    'NumpadDivide':      'Num /',
    'NumpadDecimal':     'Num .',
    'Minus':       '-',
    'Equal':       '=',
    'BracketLeft': '[',
    'BracketRight':']',
    'Backslash':   '\\',
    'Semicolon':   ';',
    'Quote':       "'",
    'Comma':       ',',
    'Period':      '.',
    'Slash':       '/',
    'Backquote':   '`',
  };
  return map[code] || null;
}

// ============== TOAST ==============
function toast(message, kind = 'info', durationMs = null) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  c.appendChild(t);
  // v3.1.2 — entrance via Anim engine (was hardcoded Animate.css classes).
  // When animations are disabled this is a no-op and the toast just appears.
  if (Anim.enabled) {
    Anim.raw(t, {
      opacity: [0, 1],
      x: [24, 0],
      duration: 360,
      ease: 'outBack(1.6)',
    });
  }
  const dur = durationMs != null ? durationMs : _toastDurationMs;
  setTimeout(() => {
    if (Anim.enabled) {
      Anim.raw(t, {
        opacity: [1, 0],
        x: [0, 20],
        duration: 280,
        ease: 'in(2)',
        onComplete: () => t.remove(),
      });
      // Safety net in case onComplete doesn't fire (element detached etc.)
      setTimeout(() => { if (t.parentNode) t.remove(); }, 600);
    } else {
      t.remove();
    }
  }, dur);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============================================================================
// PHASE 1 — Quick Presets, Sound effects, Theme custom accent, Ghost mode,
//            Per-app preset prompt, Achievements engine
// ============================================================================

// ---- Built-in Quick Preset definitions ---------------------------------
const QUICK_PRESETS = {
  // "Vibes" — subjective, fun, experimental
  vibes: [
    { id:'slow', name:'Slow Connection', icon:'🐌', desc:'250ms lag · 50 KB/s',
      cfg:{ lag_on:true, lag_in:true, lag_out:true, lag_ms:250, lag_jitter_ms:30,
            throttle_on:true, throttle_in:true, throttle_out:true, throttle_kbps:50 } },
    { id:'gamekiller', name:'Connection Killer', icon:'💀', desc:'30% drop · 800ms lag',
      cfg:{ drop_on:true, drop_chance:30, drop_in:true, drop_out:true,
            lag_on:true, lag_ms:800, lag_jitter_ms:200 } },
    { id:'freezeburst', name:'Freeze Burst', icon:'❄️', desc:'Hold & release fast',
      cfg:{ freeze_on:true, freeze_in:true, freeze_out:true, freeze_replay_ms:5 } },
    { id:'spike', name:'Spike', icon:'⚡', desc:'Block all traffic',
      cfg:{ block_on:true, block_in:true, block_out:true } },
    { id:'dnsblock', name:'DNS Block', icon:'🚫', desc:'Drop DNS only',
      cfg:{ drop_on:true, drop_chance:100, drop_dns_only:true,
            drop_in:true, drop_out:true } },
  ],
  // "Real-world" — calibrated to actual measured network conditions
  realworld: [
    { id:'56k', name:'56k Modem', icon:'📞', desc:'7 KB/s · 200±50ms',
      cfg:{ throttle_on:true, throttle_kbps:7, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:200, lag_jitter_ms:50 } },
    { id:'3gslow', name:'3G Slow', icon:'📶', desc:'50 KB/s · 400±100ms',
      cfg:{ throttle_on:true, throttle_kbps:50, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:400, lag_jitter_ms:100 } },
    { id:'3gfast', name:'3G Fast', icon:'📶', desc:'200 KB/s · 150±50ms',
      cfg:{ throttle_on:true, throttle_kbps:200, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:150, lag_jitter_ms:50 } },
    { id:'4glte', name:'4G LTE', icon:'📡', desc:'1.5 MB/s · 50±20ms',
      cfg:{ throttle_on:true, throttle_kbps:1500, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:50, lag_jitter_ms:20 } },
    { id:'cable', name:'Cable', icon:'🌐', desc:'5 MB/s · 20ms',
      cfg:{ throttle_on:true, throttle_kbps:5000, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:20, lag_jitter_ms:5 } },
    { id:'fiber', name:'Fiber', icon:'⚡', desc:'25 MB/s · 5ms',
      cfg:{ throttle_on:true, throttle_kbps:25000, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:5, lag_jitter_ms:1 } },
    { id:'satellite', name:'Satellite', icon:'🛰️', desc:'1 MB/s · 600±100ms',
      cfg:{ throttle_on:true, throttle_kbps:1000, throttle_in:true, throttle_out:true,
            lag_on:true, lag_ms:600, lag_jitter_ms:100 } },
  ],
};


/* ============================================================================
 * SCENARIO LIBRARY (v3.1.4) — a large set of named, realistic network
 * conditions. Plain text only (no emojis/symbols). Each reuses the same cfg
 * shape as QUICK_PRESETS and is applied through applyPreset().
 * ==========================================================================*/
const SCENARIOS = [
  // --- Cellular / mobile ---
  { id:'sc_2g_gprs',   name:'2G GPRS',            group:'Cellular', desc:'5 KB/s down, 500ms latency, heavy jitter',
    cfg:{ throttle_on:true, throttle_kbps:5,    lag_on:true, lag_ms:500, lag_jitter_ms:150 } },
  { id:'sc_2g_edge',   name:'2G EDGE',            group:'Cellular', desc:'15 KB/s, 350ms latency',
    cfg:{ throttle_on:true, throttle_kbps:15,   lag_on:true, lag_ms:350, lag_jitter_ms:100 } },
  { id:'sc_3g_slow',   name:'3G Weak Signal',     group:'Cellular', desc:'40 KB/s, 400ms, 2 percent loss',
    cfg:{ throttle_on:true, throttle_kbps:40,   lag_on:true, lag_ms:400, lag_jitter_ms:120, drop_on:true, drop_chance:2 } },
  { id:'sc_3g_hspa',   name:'3G HSPA Plus',       group:'Cellular', desc:'350 KB/s, 120ms latency',
    cfg:{ throttle_on:true, throttle_kbps:350,  lag_on:true, lag_ms:120, lag_jitter_ms:40 } },
  { id:'sc_4g_good',   name:'4G LTE Strong',      group:'Cellular', desc:'1.5 MB/s, 45ms latency',
    cfg:{ throttle_on:true, throttle_kbps:1500, lag_on:true, lag_ms:45,  lag_jitter_ms:15 } },
  { id:'sc_4g_busy',   name:'4G LTE Congested',   group:'Cellular', desc:'300 KB/s, 180ms, light loss',
    cfg:{ throttle_on:true, throttle_kbps:300,  lag_on:true, lag_ms:180, lag_jitter_ms:80, drop_on:true, drop_chance:1 } },
  { id:'sc_5g',        name:'5G Sub Six',         group:'Cellular', desc:'12 MB/s, 20ms latency',
    cfg:{ throttle_on:true, throttle_kbps:12000,lag_on:true, lag_ms:20,  lag_jitter_ms:5 } },
  { id:'sc_5g_edge',   name:'5G Cell Edge',       group:'Cellular', desc:'2 MB/s, 60ms with jitter',
    cfg:{ throttle_on:true, throttle_kbps:2000, lag_on:true, lag_ms:60,  lag_jitter_ms:40 } },
  { id:'sc_roaming',   name:'Mobile Roaming',     group:'Cellular', desc:'80 KB/s, 300ms, intermittent loss',
    cfg:{ throttle_on:true, throttle_kbps:80,   lag_on:true, lag_ms:300, lag_jitter_ms:120, drop_on:true, drop_chance:3 } },

  // --- Broadband / wired ---
  { id:'sc_dialup',    name:'Dial Up Modem',      group:'Broadband', desc:'7 KB/s, 200ms latency',
    cfg:{ throttle_on:true, throttle_kbps:7,    lag_on:true, lag_ms:200, lag_jitter_ms:50 } },
  { id:'sc_dsl',       name:'DSL Basic',          group:'Broadband', desc:'1 MB/s, 40ms latency',
    cfg:{ throttle_on:true, throttle_kbps:1000, lag_on:true, lag_ms:40,  lag_jitter_ms:10 } },
  { id:'sc_cable',     name:'Cable Broadband',    group:'Broadband', desc:'6 MB/s, 25ms latency',
    cfg:{ throttle_on:true, throttle_kbps:6000, lag_on:true, lag_ms:25,  lag_jitter_ms:6 } },
  { id:'sc_cable_peak',name:'Cable Peak Hours',   group:'Broadband', desc:'2.5 MB/s, 70ms, mild loss',
    cfg:{ throttle_on:true, throttle_kbps:2500, lag_on:true, lag_ms:70,  lag_jitter_ms:30, drop_on:true, drop_chance:1 } },
  { id:'sc_fiber',     name:'Fiber Optic',        group:'Broadband', desc:'30 MB/s, 5ms latency',
    cfg:{ throttle_on:true, throttle_kbps:30000,lag_on:true, lag_ms:5,   lag_jitter_ms:1 } },
  { id:'sc_fiber_busy',name:'Fiber Saturated',    group:'Broadband', desc:'4 MB/s, 40ms under load',
    cfg:{ throttle_on:true, throttle_kbps:4000, lag_on:true, lag_ms:40,  lag_jitter_ms:20 } },
  { id:'sc_isp_throt', name:'ISP Throttled',      group:'Broadband', desc:'500 KB/s cap, 30ms',
    cfg:{ throttle_on:true, throttle_kbps:500,  lag_on:true, lag_ms:30,  lag_jitter_ms:8 } },
  { id:'sc_asym_up',   name:'Slow Upload Only',   group:'Broadband', desc:'Upload capped 60 KB/s, download normal',
    cfg:{ throttle_on:true, throttle_in:false, throttle_out:true, throttle_kbps:60 } },

  // --- Wifi / local ---
  { id:'sc_wifi_weak', name:'Weak Wifi',          group:'Wifi', desc:'400 KB/s, 90ms, 2 percent loss',
    cfg:{ throttle_on:true, throttle_kbps:400,  lag_on:true, lag_ms:90,  lag_jitter_ms:50, drop_on:true, drop_chance:2 } },
  { id:'sc_wifi_cafe', name:'Crowded Cafe Wifi',  group:'Wifi', desc:'250 KB/s, 150ms, bursty loss',
    cfg:{ throttle_on:true, throttle_kbps:250,  lag_on:true, lag_ms:150, lag_jitter_ms:90, drop_on:true, drop_chance:4 } },
  { id:'sc_wifi_far',  name:'Far From Router',    group:'Wifi', desc:'600 KB/s, 70ms, occasional loss',
    cfg:{ throttle_on:true, throttle_kbps:600,  lag_on:true, lag_ms:70,  lag_jitter_ms:60, drop_on:true, drop_chance:2 } },
  { id:'sc_wifi_microw',name:'Microwave Interference', group:'Wifi', desc:'Spiky latency, 5 percent loss',
    cfg:{ lag_on:true, lag_ms:60, lag_jitter_ms:140, drop_on:true, drop_chance:5 } },
  { id:'sc_lan',       name:'Local LAN',          group:'Wifi', desc:'Fast link, 2ms latency',
    cfg:{ lag_on:true, lag_ms:2, lag_jitter_ms:1 } },

  // --- Satellite ---
  { id:'sc_geo_sat',   name:'Geostationary Satellite', group:'Satellite', desc:'800 KB/s, 600ms latency',
    cfg:{ throttle_on:true, throttle_kbps:800,  lag_on:true, lag_ms:600, lag_jitter_ms:80 } },
  { id:'sc_leo_sat',   name:'Low Orbit Satellite', group:'Satellite', desc:'5 MB/s, 45ms, periodic loss',
    cfg:{ throttle_on:true, throttle_kbps:5000, lag_on:true, lag_ms:45,  lag_jitter_ms:30, drop_on:true, drop_chance:1 } },

  // --- Gaming / geographic latency ---
  { id:'sc_local_srv', name:'Local Game Server',  group:'Gaming', desc:'15ms ping',
    cfg:{ lag_on:true, lag_ms:15, lag_jitter_ms:4 } },
  { id:'sc_regional',  name:'Regional Server',    group:'Gaming', desc:'45ms ping',
    cfg:{ lag_on:true, lag_ms:45, lag_jitter_ms:10 } },
  { id:'sc_crosscountry',name:'Cross Country',    group:'Gaming', desc:'80ms ping with jitter',
    cfg:{ lag_on:true, lag_ms:80, lag_jitter_ms:20 } },
  { id:'sc_transatl',  name:'Transatlantic',      group:'Gaming', desc:'120ms ping',
    cfg:{ lag_on:true, lag_ms:120, lag_jitter_ms:25 } },
  { id:'sc_transpac',  name:'Transpacific',       group:'Gaming', desc:'180ms ping',
    cfg:{ lag_on:true, lag_ms:180, lag_jitter_ms:30 } },
  { id:'sc_highping',  name:'High Ping Match',     group:'Gaming', desc:'250ms ping, light loss',
    cfg:{ lag_on:true, lag_ms:250, lag_jitter_ms:60, drop_on:true, drop_chance:2 } },
  { id:'sc_laggy_host',name:'Laggy Host',         group:'Gaming', desc:'350ms spikes, packet loss',
    cfg:{ lag_on:true, lag_ms:350, lag_jitter_ms:150, drop_on:true, drop_chance:4 } },

  // --- Packet loss patterns ---
  { id:'sc_loss_light',name:'Light Packet Loss',  group:'Loss', desc:'1 percent random loss',
    cfg:{ drop_on:true, drop_chance:1 } },
  { id:'sc_loss_mod',  name:'Moderate Packet Loss',group:'Loss', desc:'5 percent random loss',
    cfg:{ drop_on:true, drop_chance:5 } },
  { id:'sc_loss_heavy',name:'Heavy Packet Loss',  group:'Loss', desc:'15 percent random loss',
    cfg:{ drop_on:true, drop_chance:15 } },
  { id:'sc_loss_severe',name:'Severe Packet Loss',group:'Loss', desc:'30 percent loss, 200ms lag',
    cfg:{ drop_on:true, drop_chance:30, lag_on:true, lag_ms:200, lag_jitter_ms:80 } },
  { id:'sc_dns_fail',  name:'DNS Failure',        group:'Loss', desc:'Drops DNS lookups only',
    cfg:{ drop_on:true, drop_chance:100, drop_dns_only:true } },

  // --- Jitter / instability ---
  { id:'sc_jitter_mild',name:'Mild Jitter',       group:'Jitter', desc:'40ms base, 60ms jitter',
    cfg:{ lag_on:true, lag_ms:40, lag_jitter_ms:60 } },
  { id:'sc_jitter_bad',name:'Severe Jitter',      group:'Jitter', desc:'60ms base, 200ms jitter',
    cfg:{ lag_on:true, lag_ms:60, lag_jitter_ms:200 } },
  { id:'sc_unstable',  name:'Unstable Link',      group:'Jitter', desc:'Wild latency, 6 percent loss',
    cfg:{ lag_on:true, lag_ms:100, lag_jitter_ms:250, drop_on:true, drop_chance:6 } },

  // --- Extreme / test ---
  { id:'sc_blackout',  name:'Total Blackout',     group:'Extreme', desc:'All traffic blocked',
    cfg:{ block_on:true } },
  { id:'sc_dropout',   name:'Intermittent Dropout',group:'Extreme', desc:'Freeze and release bursts',
    cfg:{ freeze_on:true, freeze_replay_ms:8 } },
  { id:'sc_congested',  name:'Bufferbloat',       group:'Extreme', desc:'Heavy buffering, 450ms, slow',
    cfg:{ throttle_on:true, throttle_kbps:200, lag_on:true, lag_ms:450, lag_jitter_ms:120 } },
  { id:'sc_packetstorm',name:'Packet Storm',      group:'Extreme', desc:'40 percent loss, jitter, slow',
    cfg:{ drop_on:true, drop_chance:40, lag_on:true, lag_ms:120, lag_jitter_ms:200, throttle_on:true, throttle_kbps:120 } },
];

// Render the scenario cards into the Scenarios tab grid (grouped, scrollable).
function renderScenarios() {
  const grid = document.getElementById('preset-grid-scenarios');
  if (!grid) return;
  if (grid.dataset.rendered === '1') return;  // build once
  grid.innerHTML = '';
  // Group headers + cards
  let lastGroup = null;
  SCENARIOS.forEach(sc => {
    if (sc.group && sc.group !== lastGroup) {
      lastGroup = sc.group;
      const h = document.createElement('div');
      h.className = 'scenario-group-label';
      h.textContent = sc.group;
      grid.appendChild(h);
    }
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'preset-card scenario-card';
    card.dataset.presetId = sc.id;
    card.innerHTML =
      '<span class="pc-name">' + escapeHtml(sc.name) + '</span>' +
      '<span class="pc-desc">' + escapeHtml(sc.desc || '') + '</span>';
    card.addEventListener('click', () => applyPreset(sc));
    grid.appendChild(card);
  });
  grid.dataset.rendered = '1';
}

// --- Preset export / import (native file dialog via bridge) ---
function exportPresetsToFile() {
  if (!bridge || !bridge.exportPresetsToFile) { toast('Export not available', 'error'); return; }
  bridge.exportPresetsToFile().then(raw => {
    let r = {}; try { r = JSON.parse(raw || '{}'); } catch (e) {}
    if (r.cancelled) return;
    if (r.ok) toast('Presets exported', 'success');
    else toast('Export failed' + (r.error ? ': ' + r.error : ''), 'error');
  });
}
function importPresetsFromFile() {
  if (!bridge || !bridge.importPresetsFromFile) { toast('Import not available', 'error'); return; }
  bridge.importPresetsFromFile().then(raw => {
    let r = {}; try { r = JSON.parse(raw || '{}'); } catch (e) {}
    if (r.cancelled) return;
    if (r.ok) {
      toast('Imported ' + (r.count || 0) + ' preset' + ((r.count === 1) ? '' : 's'), 'success');
      refreshUserPresets();
      // jump to My presets so the user sees them
      const customTab = document.querySelector('.preset-tab[data-preset-tab="custom"]');
      if (customTab) customTab.click();
    } else {
      toast('Import failed' + (r.error ? ': ' + r.error : ''), 'error');
    }
  });
}

// All filterable cfg keys — used to clear & reset the form
const ALL_CFG_KEYS = [
  'lag_on','lag_in','lag_out','lag_ms','lag_jitter_ms',
  'drop_on','drop_in','drop_out','drop_chance','drop_dns_only',
  'throttle_on','throttle_in','throttle_out','throttle_kbps',
  'freeze_on','freeze_in','freeze_out','freeze_replay_ms',
  'block_on','block_in','block_out',
  'fun_on','fun_intensity',
];

function clearAllFunctions() {
  const cfg = {
    lag_on:false, drop_on:false, throttle_on:false,
    freeze_on:false, block_on:false, fun_on:false,
    drop_dns_only:false,
  };
  applyConfigToUI(cfg);
  pushConfig();
}

function applyConfigToUI(cfg) {
  // Update every form input in the function modules to match the supplied cfg
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (!(k in cfg)) return;
    const v = cfg[k];
    if (el.type === 'checkbox') {
      el.checked = !!v;
      const card = el.closest('.func-mod');
      if (card && el.classList.contains('toggle-input')) {
        card.classList.toggle('active', !!v);
      }
    } else if (el.type === 'number' || el.type === 'range') {
      el.value = (v === undefined || v === null) ? el.value : v;
      const evt = new Event('input', { bubbles: true });
      el.dispatchEvent(evt);
    } else if (el.tagName === 'SELECT') {
      el.value = String(v);
    } else {
      el.value = v;
    }
  });
}

function applyPreset(preset) {
  if (!preset || !preset.cfg) return;
  // Reset everything first so the preset's intended state is exact
  const baseline = {};
  ALL_CFG_KEYS.forEach(k => {
    if (k.endsWith('_on') || k.endsWith('_in') || k.endsWith('_out') || k === 'drop_dns_only') {
      baseline[k] = false;
    }
  });
  // Direction defaults — when a preset enables a function, default both directions on
  // unless the preset overrides them
  const merged = { ...baseline, ...preset.cfg };
  if (preset.cfg.lag_on)      { if (!('lag_in' in preset.cfg))      merged.lag_in = true;
                                 if (!('lag_out' in preset.cfg))     merged.lag_out = true; }
  if (preset.cfg.drop_on)     { if (!('drop_in' in preset.cfg))     merged.drop_in = true;
                                 if (!('drop_out' in preset.cfg))    merged.drop_out = true; }
  if (preset.cfg.throttle_on) { if (!('throttle_in' in preset.cfg)) merged.throttle_in = true;
                                 if (!('throttle_out' in preset.cfg))merged.throttle_out = true; }
  if (preset.cfg.freeze_on)   { if (!('freeze_in' in preset.cfg))   merged.freeze_in = true;
                                 if (!('freeze_out' in preset.cfg))  merged.freeze_out = true; }
  if (preset.cfg.block_on)    { if (!('block_in' in preset.cfg))    merged.block_in = true;
                                 if (!('block_out' in preset.cfg))   merged.block_out = true; }

  applyConfigToUI(merged);
  pushConfig();

  bridge.playSoundEffect('preset');
  toast(`Applied: ${preset.icon || ''} ${preset.name}`, 'success');

  // Visual flash on the applied card
  const id = preset.id || preset.name;
  document.querySelectorAll('.preset-card').forEach(c =>
    c.classList.toggle('applied', c.dataset.presetId === id));
  // v3.1.2 — pop the applied card, then ripple-pulse the function cards
  // that the preset just switched on so the user sees what changed.
  const appliedCard = document.querySelector(`.preset-card[data-preset-id="${CSS.escape(id)}"]`);
  if (appliedCard) Anim.pop(appliedCard, { from: 0.92, duration: 360 });
  if (Anim.enabled && Anim.lib) {
    const activeFns = document.querySelectorAll('.func-mod.active');
    if (activeFns.length) {
      Anim.lib.animate(activeFns, {
        scale: [1, 1.03, 1],
        duration: 460,
        delay: Anim.lib.stagger(60),
        ease: 'inOut(2)',
      });
    }
  }
  setTimeout(() => {
    document.querySelectorAll('.preset-card.applied').forEach(c => c.classList.remove('applied'));
  }, 1400);
}

function setupQuickPresets() {
  // Tab switching
  document.querySelectorAll('.preset-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.presetTab;
      document.querySelectorAll('.preset-tab').forEach(t => t.classList.toggle('active', t === tab));
      ['vibes','realworld','scenarios','custom'].forEach(t => {
        const grid = document.getElementById('preset-grid-' + t);
        if (grid) grid.hidden = (t !== target);
      });
      if (target === 'custom') refreshUserPresets();
      if (target === 'scenarios') renderScenarios();
      // v3.1.2 — stagger the now-visible preset cards in
      const grid = document.getElementById('preset-grid-' + target);
      if (grid) {
        const cards = grid.querySelectorAll('.preset-card');
        if (cards.length) Anim.staggerIn(cards, { each: 40, distance: 12, duration: 360 });
      }
    });
  });

  // Built-in Vibes presets
  document.querySelectorAll('#preset-grid-vibes .preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.presetId;
      const p = QUICK_PRESETS.vibes.find(x => x.id === id);
      if (p) applyPreset(p);
    });
  });
  // Built-in Real-world presets
  document.querySelectorAll('#preset-grid-realworld .preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.presetId;
      const p = QUICK_PRESETS.realworld.find(x => x.id === id);
      if (p) applyPreset(p);
    });
  });

  // "Save current as preset" button
  const saveBtn = document.getElementById('preset-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    document.getElementById('save-preset-modal').hidden = false;
    document.getElementById('save-preset-name').focus();
  });

  // "Clear all functions" button
  const clearBtn = document.getElementById('preset-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearAllFunctions);

  // v3.1.4 — export / import user presets to a file
  const exportBtn = document.getElementById('preset-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportPresetsToFile);
  const importBtn = document.getElementById('preset-import-btn');
  if (importBtn) importBtn.addEventListener('click', importPresetsFromFile);

  // Save preset modal — icon picker
  let chosenIcon = '⚡';
  document.querySelectorAll('.preset-icon-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      chosenIcon = opt.dataset.pi;
      document.querySelectorAll('.preset-icon-opt').forEach(o =>
        o.classList.toggle('selected', o === opt));
    });
  });
  const confirm = document.getElementById('save-preset-confirm');
  if (confirm) confirm.addEventListener('click', () => {
    const name = (document.getElementById('save-preset-name').value || '').trim();
    if (!name) { toast('Give it a name first', 'error'); return; }
    const cfg = readCurrentConfig();
    const preset = { id: 'user_' + name.toLowerCase().replace(/[^a-z0-9]/g,'_'),
                     name, icon: chosenIcon,
                     desc: summarizeConfig(cfg), cfg };
    bridge.addUserPreset(JSON.stringify(preset));
    document.getElementById('save-preset-modal').hidden = true;
    document.getElementById('save-preset-name').value = '';
    refreshUserPresets();
    toast(`Saved preset "${name}"`, 'success');
  });
}

function readCurrentConfig() {
  const cfg = {};
  document.querySelectorAll('.func-mod [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') cfg[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') cfg[k] = parseInt(el.value, 10) || 0;
    else if (el.tagName === 'SELECT') cfg[k] = parseInt(el.value, 10) || 0;
    else cfg[k] = el.value;
  });
  return cfg;
}

function summarizeConfig(cfg) {
  const parts = [];
  if (cfg.lag_on)      parts.push(`lag ${cfg.lag_ms}ms`);
  if (cfg.drop_on)     parts.push(`drop ${cfg.drop_chance}%${cfg.drop_dns_only?' DNS':''}`);
  if (cfg.throttle_on) parts.push(`${cfg.throttle_kbps} KB/s`);
  if (cfg.freeze_on)   parts.push('freeze');
  if (cfg.block_on)    parts.push('block');
  if (cfg.fun_on)      parts.push('fun');
  return parts.join(' · ') || 'no functions';
}

function refreshUserPresets() {
  try {
    bridge.getUserPresets().then((raw) => {
      try {
        const list = JSON.parse(raw || '[]');
        const grid = document.getElementById('preset-grid-custom');
        if (!grid) return;
        grid.innerHTML = '';
        if (!list.length) {
          grid.innerHTML = `<div class="preset-empty" id="preset-custom-empty">
            No saved presets yet — tweak settings then click <b>Save current</b> to make one.
          </div>`;
          return;
        }
        list.forEach(p => {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'preset-card';
          card.dataset.presetId = p.id || p.name;
          card.innerHTML = `
            <span class="pc-icon-custom" title="Delete this preset">×</span>
            <span class="pc-icon">${p.icon || '⚡'}</span>
            <span class="pc-name">${escapeHtml(p.name || 'Untitled')}</span>
            <span class="pc-desc">${escapeHtml(p.desc || '')}</span>`;
          card.addEventListener('click', (e) => {
            if (e.target.classList.contains('pc-icon-custom')) {
              e.stopPropagation();
              if (confirm(`Delete preset "${p.name}"?`)) {
                bridge.deleteUserPreset(p.name);
                refreshUserPresets();
              }
              return;
            }
            applyPreset(p);
          });
          grid.appendChild(card);
        });
      } catch (e) { /* swallow */ }
    });
  } catch (e) { /* swallow */ }
}

// ---- Sound effects per function -----------------------------------------
function setupSoundEffects() {
  // Hook into the existing toggle-input handlers — when a function is
  // toggled ON, fire the matching effect.
  const fxMap = { lag_on:'lag', drop_on:'drop', throttle_on:'throttle',
                  freeze_on:'freeze', block_on:'block', fun_on:'fun' };
  document.querySelectorAll('.toggle-input').forEach(input => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const fx = fxMap[input.dataset.key];
      if (fx) bridge.playSoundEffect(fx);
    });
  });

  // Sound-tab test buttons
  document.querySelectorAll('[data-test-fx]').forEach(b => {
    b.addEventListener('click', () => bridge.playSoundEffect(b.dataset.testFx));
  });
}

// ---- Theme: custom Midnight accent --------------------------------------
function applyMidnightCustomCss(hex) {
  // Inject a style override that swaps the Midnight accent variables.
  let style = document.getElementById('midnight-custom-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'midnight-custom-style';
    document.head.appendChild(style);
  }
  if (!hex) {
    style.textContent = '';
    return;
  }
  // Build a complementary gradient — accent → lightened version
  const lighter = lightenHex(hex, 0.25);
  style.textContent = `
    body[data-design="midnight"] {
      --accent-primary: ${hex};
      --accent-secondary: ${lighter};
      --accent-glow: ${hex}55;
    }
    body[data-design="midnight"] .accent-grad,
    body[data-design="midnight"] .grad-text {
      background: linear-gradient(135deg, ${hex}, ${lighter}) !important;
      -webkit-background-clip: text !important;
      background-clip: text !important;
      -webkit-text-fill-color: transparent !important;
    }
  `;
}

function lightenHex(hex, amt) {
  try {
    const m = /^#?([a-f0-9]{6})$/i.exec(hex);
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    let r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
    r = Math.min(255, r + Math.round((255 - r) * amt));
    g = Math.min(255, g + Math.round((255 - g) * amt));
    b = Math.min(255, b + Math.round((255 - b) * amt));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  } catch { return hex; }
}

function setupCustomAccent() {
  const picker = document.getElementById('midnight-custom-color');
  const hexInput = document.getElementById('midnight-custom-hex');
  const apply = document.getElementById('midnight-custom-apply');
  const clearBtn = document.getElementById('midnight-custom-clear');
  if (!picker || !hexInput || !apply || !clearBtn) return;

  // Sync picker ↔ hex input
  picker.addEventListener('input', () => { hexInput.value = picker.value.toUpperCase(); });
  hexInput.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) picker.value = hexInput.value;
  });

  apply.addEventListener('click', () => {
    const hex = hexInput.value.trim() || picker.value;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) { toast('Use #RRGGBB hex format', 'error'); return; }
    applyMidnightCustomCss(hex);
    bridge.applyMidnightCustomColor(hex);
    bridge.unlockAchievement('theme_painter');
    showAchievementToast('theme_painter');
    toast(`Custom accent applied: ${hex}`, 'success');
  });

  clearBtn.addEventListener('click', () => {
    applyMidnightCustomCss('');
    bridge.applyMidnightCustomColor('');
    hexInput.value = '';
    toast('Custom accent reset', 'info');
  });
}

// ---- Stream-safe + Ghost mode wiring (Overlay tab) ---------------------
function setupOverlayPhase1Toggles() {
  const ghost = document.getElementById('overlay-ghost-mode');
  const stream = document.getElementById('overlay-stream-safe');
  if (ghost) {
    ghost.addEventListener('change', () => bridge.setOverlayGhostMode(ghost.checked));
  }
  if (stream) {
    stream.addEventListener('change', () => bridge.setOverlayStreamSafe(stream.checked));
  }
}

// ---- Per-app preset prompt ---------------------------------------------
let _pendingPerAppCfg = null;
const _promptedThisSession = new Set();   // don't re-pop per session

function maybePromptPerAppPreset(name) {
  try {
    if (_promptedThisSession.has(name)) return;
    // Honor the auto_load_per_app_preset setting
    const enabled = (appSettings.auto_load_per_app_preset !== false);
    if (!enabled) return;
    bridge.getPerAppPreset(name).then((raw) => {
      if (!raw) return;
      let cfg;
      try { cfg = JSON.parse(raw); } catch { return; }
      if (!cfg || typeof cfg !== 'object') return;
      // Only prompt if the saved preset has at least one function enabled —
      // otherwise restoring "everything off" is pointless noise
      const hasAny = !!(cfg.lag_on || cfg.drop_on || cfg.throttle_on
                       || cfg.freeze_on || cfg.block_on || cfg.fun_on);
      if (!hasAny) return;
      _pendingPerAppCfg = cfg;
      _promptedThisSession.add(name);
      document.getElementById('per-app-prompt-name').textContent = name;
      // v3.1.1 — Populate the summary so the user can SEE what will be
      // restored before clicking. Otherwise they're flying blind.
      renderPerAppSummary(cfg);
      document.getElementById('per-app-prompt').hidden = false;
    });
  } catch (e) { /* swallow */ }
}

// v3.1.1 — Render a readable summary of the saved per-app config so
// the user can decide whether to restore it. Each active function gets
// its own row with the key settings (intensity, KB/s, etc.) in plain
// English. Inactive functions are omitted to keep the prompt clean.
function renderPerAppSummary(cfg) {
  const el = document.getElementById('per-app-summary');
  if (!el) return;
  const rows = [];

  const dirStr = (inb, out) => {
    if (inb && out) return 'both directions';
    if (inb) return 'inbound only';
    if (out) return 'outbound only';
    return '(no direction set)';
  };

  if (cfg.lag_on) {
    const jitter = cfg.lag_jitter_ms ? ` ±${cfg.lag_jitter_ms}ms jitter` : '';
    rows.push({
      icon: '⏱',
      name: 'Lag',
      detail: `${cfg.lag_ms || 0}ms${jitter}, ${dirStr(cfg.lag_in, cfg.lag_out)}`,
    });
  }
  if (cfg.drop_on) {
    const pattern = cfg.drop_pattern === 'bursty'
      ? `bursty (${cfg.drop_burst_len || 4} in a row / ${cfg.drop_gap_len || 20} clean)`
      : 'uniform random';
    const dnsOnly = cfg.drop_dns_only ? ' · DNS only' : '';
    rows.push({
      icon: '✕',
      name: 'Drop',
      detail: `${cfg.drop_chance || 0}% chance · ${pattern}${dnsOnly} · ${dirStr(cfg.drop_in, cfg.drop_out)}`,
    });
  }
  if (cfg.throttle_on) {
    rows.push({
      icon: '⤓',
      name: 'Throttle',
      detail: `${cfg.throttle_kbps || 0} KB/s · ${dirStr(cfg.throttle_in, cfg.throttle_out)}`,
    });
  }
  if (cfg.freeze_on) {
    const replay = cfg.freeze_replay_ms ? ` · ${cfg.freeze_replay_ms}ms replay window` : '';
    rows.push({
      icon: '❄',
      name: 'Freeze',
      detail: `${dirStr(cfg.freeze_in, cfg.freeze_out)}${replay}`,
    });
  }
  if (cfg.block_on) {
    rows.push({
      icon: '⛔',
      name: 'Block',
      detail: `${dirStr(cfg.block_in, cfg.block_out)} — all traffic cut`,
    });
  }
  if (cfg.fun_on || cfg.fun_mode) {
    rows.push({
      icon: '🎲',
      name: 'Fun mode',
      detail: `intensity ${cfg.fun_intensity || 50}%`,
    });
  }
  // Extras (network-visibility batch additions) — only if non-default
  if (cfg.bandwidth_quota_on) {
    rows.push({
      icon: '📊',
      name: 'Bandwidth quota',
      detail: `${cfg.quota_mb || 1000} MB/day → ${cfg.quota_action || 'throttle'}`,
    });
  }
  if (cfg.dns_chaos_on) {
    rows.push({
      icon: '🌐',
      name: 'DNS chaos',
      detail: 'drops all outbound DNS queries',
    });
  }

  if (rows.length === 0) {
    el.innerHTML = '<div class="per-app-summary-empty">No active functions in saved config</div>';
    return;
  }

  el.innerHTML = rows.map(r =>
    `<div class="per-app-summary-row">
      <span class="pas-icon">${r.icon}</span>
      <div class="pas-text">
        <div class="pas-name">${r.name}</div>
        <div class="pas-detail">${r.detail}</div>
      </div>
    </div>`
  ).join('');
}

function setupPerAppPrompt() {
  const accept = document.getElementById('per-app-prompt-accept');
  const decline = document.getElementById('per-app-prompt-decline');
  const modal = document.getElementById('per-app-prompt');
  if (!accept || !decline || !modal) return;
  accept.addEventListener('click', () => {
    if (_pendingPerAppCfg) {
      applyConfigToUI(_pendingPerAppCfg);
      pushConfig();
      toast('Loaded saved configuration', 'success');
    }
    _pendingPerAppCfg = null;
    modal.hidden = true;
  });
  decline.addEventListener('click', () => {
    _pendingPerAppCfg = null;
    modal.hidden = true;
  });
}

// ---- Achievements -------------------------------------------------------
const ACHIEVEMENTS = {
  first_drop:        { name:'First Drop',        icon:'💧', desc:'Drop your first packet' },
  first_freeze:      { name:'First Freeze',      icon:'❄️', desc:'Hold your first packet' },
  frozen_solid:      { name:'Frozen Solid',      icon:'🧊', desc:'Hold 100 packets in one session' },
  net_slayer:        { name:'Net Slayer',        icon:'🗡️', desc:'Affect 10,000 packets total' },
  big_freeze:        { name:'Big Freeze',        icon:'🥶', desc:'Held 1,000 packets in one session' },
  discord_disrupter: { name:'Discord Disrupter', icon:'🎯', desc:'Targeted Discord.exe' },
  multi_tasker:      { name:'Multi-Tasker',      icon:'⊕',  desc:'Enabled multi-target mode' },
  theme_painter:     { name:'Theme Painter',     icon:'🎨', desc:'Used the custom accent picker' },
  patience:          { name:'Patience',          icon:'⏳', desc:'Replayed 1,000+ packets' },
  long_run:          { name:'Long Run',          icon:'🏃', desc:'Ran a session for 1 hour' },
};

let _achUnlockedCache = {};
let _sessionStart = 0;
let _replayedTotal = 0;
let _lastHeld = 0;

function refreshAchievementsCache() {
  try {
    bridge.getAchievements().then((raw) => {
      try { _achUnlockedCache = JSON.parse(raw || '{}'); }
      catch { _achUnlockedCache = {}; }
    });
  } catch { _achUnlockedCache = {}; }
}

function isAchUnlocked(id) { return !!_achUnlockedCache[id]; }

function unlockAch(id) {
  if (isAchUnlocked(id)) return;
  _achUnlockedCache[id] = new Date().toISOString();
  bridge.unlockAchievement(id);
  showAchievementToast(id);
}

function showAchievementToast(id) {
  const def = ACHIEVEMENTS[id];
  if (!def) return;
  // Don't fire if it was already in the cache before this call
  // (prevents duplicate toasts when repeatedly calling unlock for same id)
  const c = document.getElementById('achievement-toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'ach-toast';
  t.innerHTML = `
    <div class="at-icon">${def.icon}</div>
    <div class="at-text">
      <div class="at-label">Achievement unlocked</div>
      <div class="at-name">${escapeHtml(def.name)}</div>
      <div class="at-desc">${escapeHtml(def.desc)}</div>
    </div>`;
  c.appendChild(t);
  setTimeout(() => t.classList.add('fading'), 4000);
  setTimeout(() => t.remove(), 4500);
}

function checkAchievementsFromStats(s) {
  // s = stats payload from onStatsChanged
  if (!s) return;
  if (s.dropped > 0 && !isAchUnlocked('first_drop'))   unlockAch('first_drop');
  if (s.held    > 0 && !isAchUnlocked('first_freeze')) unlockAch('first_freeze');
  if (s.held    >= 100 && !isAchUnlocked('frozen_solid')) unlockAch('frozen_solid');
  if (s.held    >= 1000 && !isAchUnlocked('big_freeze'))  unlockAch('big_freeze');
  const total = (s.dropped || 0) + (s.delayed || 0) + (s.held || 0);
  if (total >= 10000 && !isAchUnlocked('net_slayer'))     unlockAch('net_slayer');

  // Track replayed: count packets that decreased from held queue
  if (_lastHeld > s.held) {
    _replayedTotal += (_lastHeld - s.held);
    if (_replayedTotal >= 1000 && !isAchUnlocked('patience')) unlockAch('patience');
  }
  _lastHeld = s.held;

  // Long-run — track session time
  if (s.running && _sessionStart === 0) _sessionStart = Date.now();
  if (!s.running) _sessionStart = 0;
  if (_sessionStart > 0 && (Date.now() - _sessionStart) >= 3600 * 1000
      && !isAchUnlocked('long_run')) {
    unlockAch('long_run');
  }
}

function setupAchievementsModal() {
  const btn = document.getElementById('show-achievements-btn');
  const modal = document.getElementById('achievements-modal');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => {
    // Refresh cache, then render. .then() chain prevents race.
    bridge.getAchievements().then((raw) => {
      try { _achUnlockedCache = JSON.parse(raw || '{}'); }
      catch { _achUnlockedCache = {}; }
      renderAchievementsList();
      modal.hidden = false;
    });
  });
}

function renderAchievementsList() {
  const list = document.getElementById('ach-list');
  const fill = document.getElementById('ach-progress-fill');
  const txt = document.getElementById('ach-progress-text');
  if (!list) return;
  list.innerHTML = '';
  const ids = Object.keys(ACHIEVEMENTS);
  let unlocked = 0;
  ids.forEach(id => {
    const def = ACHIEVEMENTS[id];
    const stamp = _achUnlockedCache[id];
    const isUnlocked = !!stamp;
    if (isUnlocked) unlocked++;
    const stampText = isUnlocked ? new Date(stamp).toLocaleDateString() : '';
    const row = document.createElement('div');
    row.className = 'ach-row' + (isUnlocked ? ' unlocked' : '');
    row.innerHTML = `
      <div class="ach-icon">${def.icon}</div>
      <div class="ach-text">
        <div class="ach-name">${escapeHtml(def.name)}</div>
        <div class="ach-desc">${escapeHtml(def.desc)}</div>
        ${isUnlocked ? `<div class="ach-stamp">Unlocked ${stampText}</div>` : ''}
      </div>`;
    list.appendChild(row);
  });
  if (txt) txt.textContent = `${unlocked} / ${ids.length} unlocked`;
  if (fill) fill.style.width = `${Math.round(unlocked / ids.length * 100)}%`;
}

// ---- Per-app presets list (Behavior tab) -------------------------------
function setupPerAppPresetsList() {
  // Re-rendered every time settings modal opens — see hookSettingsModalOpen
}

function refreshPerAppPresetsList() {
  const container = document.getElementById('per-app-presets-list');
  if (!container) return;
  let entries = [];
  try {
    // appSettings.per_app_presets is the source of truth; loaded fresh from bridge
    // when settings modal opens — for now we use the cached version
    const presets = appSettings.per_app_presets || {};
    entries = Object.keys(presets).sort();
  } catch { entries = []; }
  container.innerHTML = '';
  if (!entries.length) {
    container.innerHTML = '<div class="loading">No saved per-app presets</div>';
    return;
  }
  entries.forEach(name => {
    const row = document.createElement('div');
    row.className = 'papp-row';
    row.innerHTML = `
      <span class="papp-name">${escapeHtml(name)}</span>
      <div class="papp-actions">
        <button class="papp-btn">Apply</button>
        <button class="papp-btn">Update</button>
        <button class="papp-btn danger">Delete</button>
      </div>`;
    const [applyB, updateB, delB] = row.querySelectorAll('.papp-btn');
    applyB.addEventListener('click', () => {
      const raw = bridge.getPerAppPreset(name);
      if (raw) {
        try { applyConfigToUI(JSON.parse(raw)); pushConfig();
              toast(`Applied saved preset for ${name}`, 'success'); } catch {}
      }
    });
    updateB.addEventListener('click', () => {
      const cfg = readCurrentConfig();
      bridge.setPerAppPreset(name, JSON.stringify(cfg));
      // Update the local cache so the list re-renders
      appSettings.per_app_presets = appSettings.per_app_presets || {};
      appSettings.per_app_presets[name] = cfg;
      toast(`Updated preset for ${name}`, 'success');
    });
    delB.addEventListener('click', () => {
      if (!confirm(`Delete saved preset for ${name}?`)) return;
      bridge.deletePerAppPreset(name);
      if (appSettings.per_app_presets) delete appSettings.per_app_presets[name];
      refreshPerAppPresetsList();
    });
    container.appendChild(row);
  });
}

// ---- Auto-save current config as per-app preset ------------------------
// Triggered when:
//   1. User switches apps (saves OUTGOING app's config)
//   2. User stops capture (saves current app's config)
// Only persists if at least one function is on — empty configs would just
// produce useless popups.
function autoSaveCurrentAppPreset() {
  if (!currentApp) return;
  const cfg = readCurrentConfig();
  const hasAny = !!(cfg.lag_on || cfg.drop_on || cfg.throttle_on
                   || cfg.freeze_on || cfg.block_on || cfg.fun_on);
  if (!hasAny) return;
  bridge.setPerAppPreset(currentApp, JSON.stringify(cfg));
  // Cache locally for the per-app list in Settings
  appSettings.per_app_presets = appSettings.per_app_presets || {};
  appSettings.per_app_presets[currentApp] = cfg;
}


// ============================================================================
// PHASE 2 — Connection Inspector, Practice Ping, Recording/Replay,
//            Domain Blocklist, Geo Blocking
// ============================================================================

// ---- Connection Inspector ----------------------------------------------
let _inspectorTimer = null;
let _inspectorPaused = false;
let _inspectorFilter = '';

function openInspector() {
  document.getElementById('inspector-modal').hidden = false;
  refreshInspector();
  // Poll every 600ms while modal is open. The bridge call is cheap —
  // it just reads the in-memory connection_table snapshot.
  if (_inspectorTimer) clearInterval(_inspectorTimer);
  _inspectorTimer = setInterval(() => {
    if (_inspectorPaused) return;
    if (document.getElementById('inspector-modal').hidden) {
      clearInterval(_inspectorTimer);
      _inspectorTimer = null;
      return;
    }
    refreshInspector();
  }, 600);
}

function refreshInspector() {
  bridge.getConnections().then((raw) => {
    let rows = [];
    try { rows = JSON.parse(raw || '[]'); } catch { rows = []; }
    if (_inspectorFilter) {
      const f = _inspectorFilter.toLowerCase();
      rows = rows.filter(r => (r.hostname || '').toLowerCase().includes(f)
                          || (r.remote_addr || '').includes(f)
                          || (r.country || '').toLowerCase().includes(f));
    }
    renderInspectorTable(rows);
  });
}

function renderInspectorTable(rows) {
  const tbody = document.getElementById('insp-tbody');
  const counter = document.getElementById('insp-count');
  if (!tbody) return;
  if (counter) counter.textContent = `${rows.length} connection${rows.length === 1 ? '' : 's'}`;
  // v2.5.2 — keep last rows around so the detail modal can pull rich data
  // when a row is clicked (the click only knows the addr, not the full row).
  _lastInspectorRows = rows;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="insp-empty"><td colspan="8">
      No connections from the targeted app yet — start capture and they'll appear here.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const host = r.hostname
      ? `<span class="insp-host has-tls" title="${escapeHtml(r.hostname)}">${escapeHtml(r.hostname)}</span>`
      : `<span class="insp-host insp-host-fallback">${escapeHtml(r.remote_addr || '(resolving…)')}</span>`;
    // v2.5.2 — data-addr enables row-click-for-detail. Use remote_addr as
    // the stable key (matches what the geo map uses for stable jitter).
    const addr = r.remote_addr || '';
    return `<tr data-addr="${escapeHtml(addr)}">
      <td>${host}</td>
      <td>${escapeHtml(r.remote || '—')}</td>
      <td><span class="insp-cc">${escapeHtml(r.country || 'XX')}</span></td>
      <td>${escapeHtml(r.proto || '—')}</td>
      <td class="insp-bytes up">${formatBytes(r.bytes_out)}</td>
      <td class="insp-bytes down">${formatBytes(r.bytes_in)}</td>
      <td>${formatDuration(r.age_s)}</td>
      <td>${formatDuration(r.idle_s)}</td>
    </tr>`;
  }).join('');

  // v2.5.2 — if the detail modal is open and showing a row that's still in
  // the data, refresh its contents with the latest values (live updates).
  if (_inspDetailOpen && _inspDetailAddr) {
    const fresh = rows.find(r => (r.remote_addr || '') === _inspDetailAddr);
    if (fresh) _populateInspDetail(fresh);
  }
}

// v2.5.2 — Cache + state for click-row-for-detail
let _lastInspectorRows = [];
let _inspDetailOpen = false;
let _inspDetailAddr = null;

function _populateInspDetail(r) {
  const $ = id => document.getElementById(id);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  set('insp-detail-host',
    r.hostname || r.remote_addr || '(unknown)');
  set('insp-detail-addr',
    `${r.remote_addr || '?'}:${r.remote_port || '?'}`);
  set('insp-detail-country',  r.country || 'XX');
  set('insp-detail-proto',    r.proto || '—');
  set('insp-detail-pid',      r.pid != null ? String(r.pid) : '—');
  set('insp-detail-localport',
    r.local_addr
      ? `${r.local_addr}:${r.local_port || '?'}`
      : (r.local_port ? `:${r.local_port}` : '—'));

  set('insp-detail-bytes-out', formatBytes(r.bytes_out || 0));
  set('insp-detail-bytes-in',  formatBytes(r.bytes_in  || 0));
  set('insp-detail-pkts-out',  (r.packets_out || 0).toLocaleString());
  set('insp-detail-pkts-in',   (r.packets_in  || 0).toLocaleString());
  const total = (r.bytes_in || 0) + (r.bytes_out || 0);
  set('insp-detail-total', formatBytes(total));

  set('insp-detail-age',  formatDuration(r.age_s || 0));
  set('insp-detail-idle', formatDuration(r.idle_s || 0));
}

function _openInspDetail(addr) {
  if (!addr) return;
  const r = _lastInspectorRows.find(x => (x.remote_addr || '') === addr);
  if (!r) return;
  _inspDetailAddr = addr;
  _inspDetailOpen = true;
  _populateInspDetail(r);
  const modal = document.getElementById('insp-detail-modal');
  if (modal) modal.hidden = false;
  // Visually mark the active row
  document.querySelectorAll('#insp-tbody tr.insp-row-selected')
    .forEach(el => el.classList.remove('insp-row-selected'));
  const sel = document.querySelector(`#insp-tbody tr[data-addr="${CSS.escape(addr)}"]`);
  if (sel) sel.classList.add('insp-row-selected');
}

function _closeInspDetail() {
  _inspDetailOpen = false;
  _inspDetailAddr = null;
  const modal = document.getElementById('insp-detail-modal');
  if (modal) modal.hidden = true;
  document.querySelectorAll('#insp-tbody tr.insp-row-selected')
    .forEach(el => el.classList.remove('insp-row-selected'));
}

function formatBytes(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/(1024*1024)).toFixed(2)} MB`;
}
function formatDuration(s) {
  if (s < 1) return `<1s`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s/60)}m${Math.round(s%60)}s`;
  return `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m`;
}

function setupInspector() {
  const btn = document.getElementById('open-inspector-btn');
  if (btn) btn.addEventListener('click', openInspector);
  const pause = document.getElementById('insp-pause');
  if (pause) pause.addEventListener('change', (e) => { _inspectorPaused = e.target.checked; });
  const search = document.getElementById('insp-search');
  if (search) search.addEventListener('input', (e) => {
    _inspectorFilter = e.target.value || '';
    refreshInspector();
  });

  // v2.5.2 — Click any row for detail modal (delegated handler on tbody)
  const tbody = document.getElementById('insp-tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-addr]');
      if (!tr) return;
      const addr = tr.getAttribute('data-addr');
      if (addr) _openInspDetail(addr);
    });
  }
  // Detail-modal close button
  const detailClose = document.querySelector(
    '#insp-detail-modal [data-close-modal="insp-detail-modal"]');
  if (detailClose) detailClose.addEventListener('click', _closeInspDetail);
  // Click on overlay (outside modal body) → close
  const detailOverlay = document.getElementById('insp-detail-modal');
  if (detailOverlay) detailOverlay.addEventListener('click', (e) => {
    if (e.target === detailOverlay) _closeInspDetail();
  });
  // Copy buttons
  const copyHost = document.getElementById('insp-detail-copy-host');
  if (copyHost) copyHost.addEventListener('click', () => {
    const txt = document.getElementById('insp-detail-host')?.textContent || '';
    if (txt && navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(
        () => toast('Hostname copied', 'success'),
        () => toast('Copy failed', 'error'));
    }
  });
  const copyAddr = document.getElementById('insp-detail-copy-addr');
  if (copyAddr) copyAddr.addEventListener('click', () => {
    const txt = document.getElementById('insp-detail-addr')?.textContent || '';
    if (txt && navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(
        () => toast('Address copied', 'success'),
        () => toast('Copy failed', 'error'));
    }
  });

  // v2.5.2 — Export current connections as CSV (calls backend QFileDialog slot)
  const exportBtn = document.getElementById('insp-export-csv');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (!bridge || !bridge.exportConnectionsCSV) {
      toast('Export unavailable in this build', 'error');
      return;
    }
    exportBtn.disabled = true;
    const oldText = exportBtn.textContent;
    exportBtn.textContent = 'Exporting…';
    bridge.exportConnectionsCSV().then((raw) => {
      let res = {};
      try { res = JSON.parse(raw || '{}'); } catch {}
      if (res.cancelled) {
        // User clicked Cancel in the save dialog — silent, no toast
      } else if (res.ok) {
        toast(`Exported ${res.count || 0} connection${res.count === 1 ? '' : 's'}`, 'success');
      } else {
        toast('Export failed: ' + (res.error || 'unknown error'), 'error');
      }
    }).catch((e) => {
      toast('Export error: ' + e, 'error');
    }).finally(() => {
      exportBtn.disabled = false;
      exportBtn.textContent = oldText;
    });
  });
}

// ---- Practice Ping ------------------------------------------------------
let _selectedPingTarget = 0;

function openPracticePing() {
  document.getElementById('pingmode-modal').hidden = false;
  // Reflect current state if practice ping is already active
  const cfg = readCurrentConfig();
  if (cfg.lag_on && cfg.lag_ms) {
    _selectedPingTarget = cfg.lag_ms;
    document.getElementById('ping-custom').value = cfg.lag_ms;
    document.getElementById('ping-custom-display').textContent = `${cfg.lag_ms} ms`;
    updatePingPresetSelection(cfg.lag_ms);
    document.getElementById('ping-status').textContent = `Active: ${cfg.lag_ms}ms target`;
    document.getElementById('ping-status').classList.remove('off');
  } else {
    _selectedPingTarget = 0;
    document.getElementById('ping-custom').value = 0;
    document.getElementById('ping-custom-display').textContent = `0 ms`;
    updatePingPresetSelection(0);
    document.getElementById('ping-status').textContent = 'No practice-ping target active.';
    document.getElementById('ping-status').classList.add('off');
  }
}

function updatePingPresetSelection(ms) {
  document.querySelectorAll('.ping-preset').forEach(p => {
    p.classList.toggle('selected', parseInt(p.dataset.ping, 10) === ms);
  });
}

function setupPracticePing() {
  const btn = document.getElementById('open-pingmode-btn');
  if (btn) btn.addEventListener('click', openPracticePing);

  document.querySelectorAll('.ping-preset').forEach(p => {
    p.addEventListener('click', () => {
      _selectedPingTarget = parseInt(p.dataset.ping, 10) || 0;
      updatePingPresetSelection(_selectedPingTarget);
      document.getElementById('ping-custom').value = _selectedPingTarget;
      document.getElementById('ping-custom-display').textContent = `${_selectedPingTarget} ms`;
    });
  });

  const slider = document.getElementById('ping-custom');
  if (slider) slider.addEventListener('input', () => {
    _selectedPingTarget = parseInt(slider.value, 10) || 0;
    document.getElementById('ping-custom-display').textContent = `${_selectedPingTarget} ms`;
    updatePingPresetSelection(_selectedPingTarget);
  });

  const apply = document.getElementById('ping-apply-btn');
  if (apply) apply.addEventListener('click', () => {
    bridge.applyPracticePing(_selectedPingTarget);
    // Reflect in the lag function module — so the user sees it actually applied
    const cfg = { lag_on: _selectedPingTarget > 0,
                  lag_in: true, lag_out: true,
                  lag_ms: _selectedPingTarget,
                  lag_jitter_ms: Math.min(30, Math.floor(_selectedPingTarget / 10)) };
    applyConfigToUI(cfg);
    pushConfig();
    if (_selectedPingTarget > 0) {
      toast(`Practice ping: ${_selectedPingTarget}ms target applied`, 'success');
      document.getElementById('ping-status').textContent = `Active: ${_selectedPingTarget}ms target`;
      document.getElementById('ping-status').classList.remove('off');
    } else {
      toast('Practice ping cleared', 'info');
      document.getElementById('ping-status').textContent = 'No practice-ping target active.';
      document.getElementById('ping-status').classList.add('off');
    }
    bridge.playSoundEffect('preset');
  });

  const clearBtn = document.getElementById('ping-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    _selectedPingTarget = 0;
    bridge.applyPracticePing(0);
    applyConfigToUI({ lag_on: false, lag_ms: 0, lag_jitter_ms: 0 });
    pushConfig();
    document.getElementById('ping-custom').value = 0;
    document.getElementById('ping-custom-display').textContent = `0 ms`;
    updatePingPresetSelection(0);
    document.getElementById('ping-status').textContent = 'No practice-ping target active.';
    document.getElementById('ping-status').classList.add('off');
    toast('Practice ping cleared', 'info');
  });
}

// ---- Recording / Replay -------------------------------------------------
let _recording = false;

function setupRecording() {
  const btn = document.getElementById('record-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (_recording) {
      bridge.stopRecording().then((path) => {
        _recording = false;
        btn.classList.remove('active');
        if (path) {
          toast(`Recording saved — open View recordings to play it back`, 'success');
        } else {
          toast('Recording stopped (nothing to save)', 'info');
        }
      });
    } else {
      bridge.startRecording().then((ok) => {
        if (ok) {
          _recording = true;
          btn.classList.add('active');
          toast('Recording started — hit Record again to stop & save', 'success');
        } else {
          toast('Could not start recording', 'error');
        }
      });
    }
  });

  const replayBtn = document.getElementById('open-replay-btn');
  if (replayBtn) replayBtn.addEventListener('click', openRecordings);

  const back = document.getElementById('rv-back');
  if (back) back.addEventListener('click', () => {
    stopReplayPlayback();
    document.getElementById('replay-viewer').hidden = true;
    document.getElementById('recordings-list').hidden = false;
  });

  const scrub = document.getElementById('rv-scrub');
  if (scrub) {
    scrub.addEventListener('input', () => {
      stopReplayPlayback();
      renderReplayFrame(parseInt(scrub.value, 10));
    });
  }

  const playBtn = document.getElementById('rv-play-btn');
  if (playBtn) playBtn.addEventListener('click', toggleReplayPlayback);

  const folderBtn = document.getElementById('open-recordings-folder');
  if (folderBtn) folderBtn.addEventListener('click', () => {
    bridge.openRecordingsFolder().then((ok) => {
      if (!ok) toast('Could not open folder', 'error');
    });
  });
}

let _replayPlayTimer = null;

function toggleReplayPlayback() {
  if (_replayPlayTimer) {
    stopReplayPlayback();
  } else {
    startReplayPlayback();
  }
}

function startReplayPlayback() {
  if (!_currentReplay || !_currentReplay.frames) return;
  const scrub = document.getElementById('rv-scrub');
  const playBtn = document.getElementById('rv-play-btn');
  const playIcon = document.getElementById('rv-play-icon');
  const speedSel = document.getElementById('rv-speed');
  const frames = _currentReplay.frames;
  // If we're at the end, restart from frame 0
  if (parseInt(scrub.value, 10) >= frames.length - 1) {
    scrub.value = 0;
    renderReplayFrame(0);
  }
  playBtn.classList.add('playing');
  playIcon.setAttribute('data-icon', 'pause');
  playIcon.setAttribute('data-icon-needs-render', '1');
  renderIcons(playIcon.parentElement);

  let lastTickWall = performance.now();
  _replayPlayTimer = setInterval(() => {
    const speed = parseFloat(speedSel.value) || 1;
    const idx = parseInt(scrub.value, 10);
    if (idx >= frames.length - 1) {
      stopReplayPlayback();
      return;
    }
    const cur = frames[idx];
    const next = frames[idx + 1];
    const realDelta = (next.t - cur.t);              // ms in recorded time
    const wallNow = performance.now();
    const wallDelta = wallNow - lastTickWall;        // ms wall-clock since last tick
    if (wallDelta * speed >= realDelta) {
      scrub.value = idx + 1;
      renderReplayFrame(idx + 1);
      lastTickWall = wallNow;
    }
  }, 30);
}

function stopReplayPlayback() {
  if (_replayPlayTimer) clearInterval(_replayPlayTimer);
  _replayPlayTimer = null;
  const playBtn = document.getElementById('rv-play-btn');
  const playIcon = document.getElementById('rv-play-icon');
  if (playBtn) playBtn.classList.remove('playing');
  if (playIcon) {
    playIcon.setAttribute('data-icon', 'play');
    playIcon.setAttribute('data-icon-needs-render', '1');
    renderIcons(playIcon.parentElement);
  }
}

function openRecordings() {
  document.getElementById('replay-modal').hidden = false;
  document.getElementById('replay-viewer').hidden = true;
  document.getElementById('recordings-list').hidden = false;
  refreshRecordings();
}

function refreshRecordings() {
  bridge.listRecordings().then((raw) => {
    let list = [];
    try { list = JSON.parse(raw || '[]'); } catch { list = []; }
    const container = document.getElementById('recordings-list');
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="loading">No recordings yet — hit Record to capture a session.</div>';
      return;
    }
    container.innerHTML = '';
    list.forEach(rec => {
      const row = document.createElement('div');
      row.className = 'rec-row';
      const date = new Date(rec.mtime * 1000).toLocaleString();
      const sizeKB = (rec.size / 1024).toFixed(1);
      row.innerHTML = `
        <div class="rec-name">${escapeHtml(rec.name)}</div>
        <div class="rec-meta">${date} · ${sizeKB} KB</div>
        <button type="button" class="rec-edit" title="Open in Throttlr Studio">Edit</button>
        <button type="button" class="rec-del">Delete</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('rec-del')) {
          e.stopPropagation();
          if (confirm(`Delete recording "${rec.name}"?`)) {
            bridge.deleteRecording(rec.path).then(() => refreshRecordings());
          }
          return;
        }
        if (e.target.classList.contains('rec-edit')) {
          // Phase 4 — open in Throttlr Studio
          e.stopPropagation();
          // Close the recordings modal first so Studio gets focus
          const replayModal = document.getElementById('replay-modal');
          if (replayModal) replayModal.hidden = true;
          if (typeof window._studioOpen === 'function') {
            window._studioOpen(rec.path);
          } else {
            toast('Studio not available', 'error');
          }
          return;
        }
        loadAndShowReplay(rec.path);
      });
      container.appendChild(row);
    });
  });
}

let _currentReplay = null;

function loadAndShowReplay(path) {
  bridge.loadRecording(path).then((raw) => {
    let data = null;
    try { data = JSON.parse(raw || '{}'); } catch { data = null; }
    if (!data || !data.frames || !data.frames.length) {
      toast('Recording is empty or corrupted', 'error');
      return;
    }
    _currentReplay = data;
    document.getElementById('recordings-list').hidden = true;
    document.getElementById('replay-viewer').hidden = false;
    document.getElementById('rv-title').textContent =
      `${data.target || 'Session'} — ${data.frames.length} frames`;
    const scrub = document.getElementById('rv-scrub');
    scrub.min = 0;
    scrub.max = data.frames.length - 1;
    scrub.value = 0;
    renderReplayFrame(0);
  });
}

function renderReplayFrame(idx) {
  if (!_currentReplay) return;
  const f = _currentReplay.frames[idx];
  if (!f) return;
  const s = f.stats || {};
  document.getElementById('rv-seen').textContent     = (s.seen || 0).toLocaleString();
  document.getElementById('rv-dropped').textContent  = (s.dropped || 0).toLocaleString();
  document.getElementById('rv-delayed').textContent  = (s.delayed || 0).toLocaleString();
  document.getElementById('rv-held').textContent     = (s.held || 0).toLocaleString();
  const t = (f.t || 0) / 1000;
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = Math.floor(t % 60).toString().padStart(2, '0');
  document.getElementById('rv-time').textContent = `${mm}:${ss}`;
  // Drive the slider's gradient fill
  const scrub = document.getElementById('rv-scrub');
  const total = _currentReplay.frames.length - 1;
  const pct = total > 0 ? Math.round((idx / total) * 100) : 0;
  if (scrub) scrub.style.setProperty('--rv-progress', pct + '%');
  // Walk back to find the most recent config snapshot
  let cfg = null;
  for (let i = idx; i >= 0; i--) {
    if (_currentReplay.frames[i].config) { cfg = _currentReplay.frames[i].config; break; }
  }
  const cfgEl = document.getElementById('rv-config');
  if (cfg) {
    const parts = [];
    if (cfg.lag_on)          parts.push(`<span class="rvc-on">Lag</span> ${cfg.lag_ms || 0}ms`);
    if (cfg.drop_on)         parts.push(`<span class="rvc-on">Drop</span> ${cfg.drop_chance || 0}%${cfg.drop_dns_only?' DNS':''}`);
    if (cfg.throttle_on)     parts.push(`<span class="rvc-on">Throttle</span> ${cfg.throttle_kbps || 0} KB/s`);
    if (cfg.freeze_on)       parts.push(`<span class="rvc-on">Freeze</span>`);
    if (cfg.block_on)        parts.push(`<span class="rvc-on">Block</span>`);
    if (cfg.fun_on)          parts.push(`<span class="rvc-on">Fun</span>`);
    if (cfg.domain_block_on) parts.push(`<span class="rvc-on">Domain block</span>`);
    if (cfg.geo_block_on)    parts.push(`<span class="rvc-on">Geo block</span>`);
    cfgEl.innerHTML = parts.length ? parts.join(' · ') : '(no functions active)';
  } else {
    cfgEl.innerHTML = '(no config snapshot at this frame)';
  }
}

// ---- Domain Blocklist ---------------------------------------------------
function setupDomainBlock() {
  const btn = document.getElementById('domain-block-config-btn');
  const toggle = document.getElementById('domain-block-toggle');
  if (btn) btn.addEventListener('click', openDomainBlockModal);
  if (toggle) toggle.addEventListener('change', () => {
    bridge.setDomainBlockOn(toggle.checked);
    const card = toggle.closest('.func-mod');
    if (card) card.classList.toggle('active', toggle.checked);
    updateDomainBlockSummary();
    if (toggle.checked) bridge.playSoundEffect('drop');
  });
  const save = document.getElementById('domain-block-save-btn');
  if (save) save.addEventListener('click', saveDomainBlockConfig);
}

function openDomainBlockModal() {
  bridge.getDomainBlocklistInfo().then((raw) => {
    let info = {};
    try { info = JSON.parse(raw || '{}'); } catch { info = {}; }
    const lists = info.available || {};
    const active = new Set(info.active_lists || []);
    const container = document.getElementById('block-lists');
    container.innerHTML = '';
    Object.keys(lists).forEach(name => {
      const meta = lists[name];
      const row = document.createElement('label');
      row.className = 'bl-row';
      row.innerHTML = `
        <input type="checkbox" data-list="${name}" ${active.has(name) ? 'checked' : ''}>
        <span class="bl-name">${name}</span>
        <span class="bl-meta">${(meta.sample || []).slice(0, 4).join(', ')}…</span>
        <span class="bl-count">${meta.count}</span>`;
      container.appendChild(row);
    });
    document.getElementById('block-custom-text').value =
      (info.custom || []).join('\n');
    document.getElementById('domain-block-modal').hidden = false;
  });
}

function saveDomainBlockConfig() {
  const lists = [];
  document.querySelectorAll('#block-lists input[type="checkbox"]').forEach(cb => {
    if (cb.checked) lists.push(cb.dataset.list);
  });
  const customText = document.getElementById('block-custom-text').value || '';
  const custom = customText.split('\n').map(s => s.trim()).filter(Boolean);
  bridge.setDomainBlockLists(JSON.stringify(lists));
  bridge.setDomainBlockCustom(JSON.stringify(custom));
  document.getElementById('domain-block-modal').hidden = true;
  updateDomainBlockSummary();
  toast(`Blocklist saved — ${lists.length} list${lists.length===1?'':'s'} + ${custom.length} custom`, 'success');
}

function updateDomainBlockSummary() {
  bridge.getDomainBlocklistInfo().then((raw) => {
    let info = {};
    try { info = JSON.parse(raw || '{}'); } catch { info = {}; }
    const sub = document.getElementById('domain-block-summary');
    if (!sub) return;
    const lists = info.active_lists || [];
    const custom = info.custom || [];
    const toggle = document.getElementById('domain-block-toggle');
    if (toggle) {
      toggle.checked = !!info.on;
      const card = toggle.closest('.func-mod');
      if (card) card.classList.toggle('active', !!info.on);
    }
    if (!lists.length && !custom.length) {
      sub.textContent = 'No lists active — click Configure to choose';
    } else {
      const parts = [];
      if (lists.length) parts.push(lists.join(' + '));
      if (custom.length) parts.push(`${custom.length} custom`);
      sub.textContent = `Active: ${parts.join(' · ')}`;
    }
  });
}

// ---- Geo Blocking -------------------------------------------------------
const GEO_REGIONS = [
  { cc:'US', name:'United States', flag:'🇺🇸' },
  { cc:'EU', name:'Europe',        flag:'🇪🇺' },
  { cc:'GB', name:'UK',            flag:'🇬🇧' },
  { cc:'DE', name:'Germany',       flag:'🇩🇪' },
  { cc:'CA', name:'Canada',        flag:'🇨🇦' },
  { cc:'JP', name:'Japan',         flag:'🇯🇵' },
  { cc:'CN', name:'China',         flag:'🇨🇳' },
  { cc:'AP', name:'Asia/Pacific',  flag:'🌏' },
  { cc:'AF', name:'Africa',        flag:'🌍' },
  { cc:'BR', name:'Brazil',        flag:'🇧🇷' },
  { cc:'LATAM', name:'Latin Am.',  flag:'🌎' },
  { cc:'XX', name:'Unknown',       flag:'❓' },
];

let _selectedCountries = new Set();

function setupGeoBlock() {
  const btn = document.getElementById('geo-block-config-btn');
  const toggle = document.getElementById('geo-block-toggle');
  if (btn) btn.addEventListener('click', openGeoBlockModal);
  if (toggle) toggle.addEventListener('change', () => {
    bridge.setGeoBlockOn(toggle.checked);
    const card = toggle.closest('.func-mod');
    if (card) card.classList.toggle('active', toggle.checked);
    updateGeoBlockSummary();
    if (toggle.checked) bridge.playSoundEffect('block');
  });
  const save = document.getElementById('geo-block-save-btn');
  if (save) save.addEventListener('click', saveGeoBlockConfig);
}

function openGeoBlockModal() {
  bridge.getGeoBlockState().then((raw) => {
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch { state = {}; }
    _selectedCountries = new Set(state.countries || []);
    const grid = document.getElementById('country-grid');
    grid.innerHTML = '';
    GEO_REGIONS.forEach(c => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'country-tile' + (_selectedCountries.has(c.cc) ? ' selected' : '');
      tile.dataset.cc = c.cc;
      tile.innerHTML = `
        <div class="ct-flag">${c.flag}</div>
        <div class="ct-name">${c.name}</div>
        <div class="ct-cc">${c.cc}</div>`;
      tile.addEventListener('click', () => {
        if (_selectedCountries.has(c.cc)) _selectedCountries.delete(c.cc);
        else _selectedCountries.add(c.cc);
        tile.classList.toggle('selected', _selectedCountries.has(c.cc));
      });
      grid.appendChild(tile);
    });
    document.getElementById('geo-block-modal').hidden = false;
  });
}

function saveGeoBlockConfig() {
  const arr = Array.from(_selectedCountries);
  bridge.setGeoBlockCountries(JSON.stringify(arr));
  document.getElementById('geo-block-modal').hidden = true;
  updateGeoBlockSummary();
  toast(`Geo block: ${arr.length} region${arr.length === 1 ? '' : 's'} selected`, 'success');
}

function updateGeoBlockSummary() {
  bridge.getGeoBlockState().then((raw) => {
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch { state = {}; }
    const sub = document.getElementById('geo-block-summary');
    if (!sub) return;
    const list = state.countries || [];
    const toggle = document.getElementById('geo-block-toggle');
    if (toggle) {
      toggle.checked = !!state.on;
      const card = toggle.closest('.func-mod');
      if (card) card.classList.toggle('active', !!state.on);
    }
    if (!list.length) {
      sub.textContent = 'No regions selected — click Pick countries';
    } else {
      sub.textContent = `Blocking: ${list.join(', ')}`;
    }
  });
}


// ============================================================================
// PHASE 3 — Network Topology, PCAP capture, Filter Scripting
// ============================================================================

// ---- Topology (canvas-based force graph) -------------------------------
let _topoTimer = null;
let _topoNodes = [];
let _topoCenter = { x: 0, y: 0 };
let _topoHover = null;
let _topoData = null;
let _topoFrame = 0;
// v2.5.2 — track previous bytes per addr so we can detect "active vs idle"
// (a node whose byte counts didn't change between refreshes is idle)
const _topoPrevBytes = new Map();   // addr → { in, out, lastChangedAt (frame) }

function setupTopology() {
  const btn = document.getElementById('open-topology-btn');
  if (btn) btn.addEventListener('click', openTopology);
  const canvas = document.getElementById('topo-canvas');
  if (!canvas) return;
  canvas.addEventListener('mousemove', onTopoMouseMove);
  canvas.addEventListener('mouseleave', () => {
    _topoHover = null;
    document.getElementById('topo-info').innerHTML =
      '<div class="topo-info-empty">Hover a node for details</div>';
  });
  // v2.5.2 — click any node to open the same connection-detail modal as the Inspector
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit = null;
    for (const n of _topoNodes) {
      const r = 8 + Math.min(8, n.weight * 1.2);
      const dx = n.x - mx, dy = n.y - my;
      if (dx * dx + dy * dy <= (r + 2) * (r + 2)) { hit = n; break; }
    }
    if (!hit) return;
    // Reuse the Inspector detail modal by injecting the topology row shape
    // into the row cache and calling the existing populator.
    const row = {
      remote_addr: hit.addr,
      remote_port: (hit.ports && hit.ports[0]) || 0,
      hostname:    hit.host || '',
      country:     hit.country || '',
      proto:       hit.proto || '',
      pid:         null,
      local_addr:  '',
      local_port:  0,
      bytes_in:    hit.bytes_in || 0,
      bytes_out:   hit.bytes_out || 0,
      packets_in:  0,
      packets_out: 0,
      age_s:       0,
      idle_s:      0,
    };
    if (Array.isArray(_lastInspectorRows)) {
      // Replace any existing entry with same addr, otherwise prepend
      const idx = _lastInspectorRows.findIndex(x => (x.remote_addr || '') === row.remote_addr);
      if (idx >= 0) _lastInspectorRows[idx] = row;
      else _lastInspectorRows = [row, ..._lastInspectorRows];
    }
    if (typeof _openInspDetail === 'function') {
      _openInspDetail(row.remote_addr);
    }
  });
}

function openTopology() {
  document.getElementById('topology-modal').hidden = false;
  // Size canvas to its container after layout settles
  setTimeout(() => {
    const canvas = document.getElementById('topo-canvas');
    const cont = canvas.parentElement;
    canvas.width  = cont.clientWidth;
    canvas.height = cont.clientHeight;
    _topoCenter = { x: canvas.width / 2, y: canvas.height / 2 };
    refreshTopology();
  }, 50);
  if (_topoTimer) clearInterval(_topoTimer);
  _topoTimer = setInterval(() => {
    if (document.getElementById('topology-modal').hidden) {
      clearInterval(_topoTimer); _topoTimer = null;
      cancelAnimationFrame(_topoRafId);
      return;
    }
    refreshTopology();
  }, 1000);
  _topoRafId = requestAnimationFrame(animateTopo);
}

function refreshTopology() {
  bridge.getTopology().then((raw) => {
    let data = { target: '', nodes: [] };
    try { data = JSON.parse(raw || '{}'); } catch {}
    _topoData = data;
    layoutTopology(data.nodes || []);
  });
}

function layoutTopology(nodes) {
  // v2.5.2 — Cluster nodes by country so connections to the same country
  // appear near each other (prior version placed every node at a hash-derived
  // angle around the center, which scattered countries randomly).
  // Strategy:
  //   1. Group nodes by country code
  //   2. Each country gets a "wedge" of the circle proportional to its share
  //   3. Within a wedge, individual nodes spread out by their addr hash
  // Nodes without a country code (private IPs, lookup failures) get their own
  // wedge labelled "—".
  const canvas = document.getElementById('topo-canvas');
  if (!canvas) return;
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  _topoCenter = { x: cx, y: cy };

  const radius = Math.min(w, h) * 0.36;
  const previous = new Map(_topoNodes.map(n => [n.addr, n]));

  // Bucket by country
  const buckets = new Map();   // cc → array of nodes
  nodes.forEach(n => {
    const cc = (n.country || '—').toUpperCase();
    if (!buckets.has(cc)) buckets.set(cc, []);
    buckets.get(cc).push(n);
  });
  // Sort buckets by country code so wedge order is stable across refreshes
  const bucketEntries = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const total = nodes.length || 1;
  let cursorAngle = -Math.PI / 2;   // start at top

  const newNodes = [];
  bucketEntries.forEach(([cc, group]) => {
    const wedgeSpan = (group.length / total) * Math.PI * 2;
    // Sort within bucket by addr for stable order
    group.sort((a, b) => (a.addr || '').localeCompare(b.addr || ''));

    group.forEach((n, i) => {
      const addr = n.addr || `${cc}-${i}`;
      // Position within the wedge: spread evenly with a small addr-hash offset
      // for visual variety. Single-element wedges go in the wedge center.
      const localFrac = group.length === 1 ? 0.5 : (i + 0.5) / group.length;
      // Hash addr → small radial variation so nodes don't all sit on the same ring
      let h2 = 5381;
      for (let c = 0; c < addr.length; c++) h2 = ((h2 << 5) + h2 + addr.charCodeAt(c)) | 0;
      const radialJitter = ((Math.abs(h2) % 100) / 100 - 0.5) * 30;  // ±15px
      const r = radius + radialJitter;

      const angle = cursorAngle + wedgeSpan * localFrac;
      const tx = cx + Math.cos(angle) * r;
      const ty = cy + Math.sin(angle) * r;
      const prev = previous.get(addr);

      // v2.5.2 — track byte changes for idle detection
      const prevBytes = _topoPrevBytes.get(addr);
      const totalBytes = (n.bytes_in || 0) + (n.bytes_out || 0);
      const prevTotal = prevBytes ? (prevBytes.in + prevBytes.out) : 0;
      let lastChangedFrame = prevBytes ? prevBytes.lastChangedFrame : _topoFrame;
      if (totalBytes !== prevTotal) lastChangedFrame = _topoFrame;
      _topoPrevBytes.set(addr, {
        in: n.bytes_in || 0, out: n.bytes_out || 0, lastChangedFrame,
      });

      newNodes.push({
        ...n,
        x: prev ? prev.x : tx + (Math.random() - 0.5) * 40,
        y: prev ? prev.y : ty + (Math.random() - 0.5) * 40,
        tx, ty,
        weight: Math.log10(totalBytes || 1),
        // Wedge-center info for cluster labels
        wedgeCenterAngle: cursorAngle + wedgeSpan / 2,
        wedgeCC: cc,
        lastChangedFrame,
      });
    });
    cursorAngle += wedgeSpan;
  });

  _topoNodes = newNodes;

  // Garbage-collect _topoPrevBytes for addresses that are no longer present
  const liveAddrs = new Set(newNodes.map(n => n.addr));
  for (const k of [..._topoPrevBytes.keys()]) {
    if (!liveAddrs.has(k)) _topoPrevBytes.delete(k);
  }
}

let _topoRafId = null;
function animateTopo() {
  const canvas = document.getElementById('topo-canvas');
  if (!canvas) return;
  if (document.getElementById('topology-modal').hidden) {
    cancelAnimationFrame(_topoRafId);
    return;
  }
  const ctx = canvas.getContext('2d');
  _topoFrame++;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Animated background grid — very subtle
  ctx.strokeStyle = 'rgba(255,184,0,0.04)';
  ctx.lineWidth = 1;
  const gridSpacing = 40;
  for (let x = 0; x < w; x += gridSpacing) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += gridSpacing) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Smooth node positions toward target
  for (const n of _topoNodes) {
    n.x += (n.tx - n.x) * 0.10;
    n.y += (n.ty - n.y) * 0.10;
  }

  // Draw edges with bidirectional flow indicators (v2.5.2)
  // Outbound dots travel from center → node (yellow), inbound from node → center (cyan).
  // Idle nodes (byte counts unchanged for >5 frames ≈ 5 seconds at 1Hz refresh)
  // get faded edges + dimmed dots so the eye can pick out active connections.
  for (const n of _topoNodes) {
    const idleFrames = _topoFrame - (n.lastChangedFrame || _topoFrame);
    const isIdle = idleFrames > 5;
    const fade = isIdle ? 0.35 : 1.0;

    const thickness = Math.max(1, Math.min(4, n.weight - 1));
    const grad = ctx.createLinearGradient(_topoCenter.x, _topoCenter.y, n.x, n.y);
    grad.addColorStop(0, `rgba(255,184,0,${0.45 * fade})`);
    grad.addColorStop(1, `rgba(102,221,255,${0.25 * fade})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(_topoCenter.x, _topoCenter.y);
    ctx.lineTo(n.x, n.y);
    ctx.stroke();

    // Skip animated dots entirely for idle edges — keeps the eye on active ones
    if (isIdle) continue;

    // Outbound flow (center → node): yellow
    const outPhase = ((_topoFrame * 0.012) + (Math.abs(n.x - _topoCenter.x) * 0.001)) % 1;
    const ox = _topoCenter.x + (n.x - _topoCenter.x) * outPhase;
    const oy = _topoCenter.y + (n.y - _topoCenter.y) * outPhase;
    if (n.bytes_out > 0) {
      ctx.fillStyle = 'rgba(255,184,0,0.95)';
      ctx.beginPath(); ctx.arc(ox, oy, 2.8, 0, Math.PI * 2); ctx.fill();
    }

    // Inbound flow (node → center): cyan, offset phase so they don't sync
    const inPhase = ((_topoFrame * 0.012 + 0.5) + (Math.abs(n.x - _topoCenter.x) * 0.001)) % 1;
    const ix = n.x + (_topoCenter.x - n.x) * inPhase;
    const iy = n.y + (_topoCenter.y - n.y) * inPhase;
    if (n.bytes_in > 0) {
      ctx.fillStyle = 'rgba(102,221,255,0.95)';
      ctx.beginPath(); ctx.arc(ix, iy, 2.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Draw remote nodes (with idle fade applied)
  for (const n of _topoNodes) {
    const idleFrames = _topoFrame - (n.lastChangedFrame || _topoFrame);
    const isIdle = idleFrames > 5;
    const fade = isIdle ? 0.45 : 1.0;

    const r = 8 + Math.min(8, n.weight * 1.2);
    const isHover = _topoHover && _topoHover.addr === n.addr;
    // Glow
    ctx.shadowColor = isHover ? '#ffb800' : `rgba(102,221,255,${0.55 * fade})`;
    ctx.shadowBlur = isHover ? 18 : 8 * fade;
    ctx.fillStyle = isHover
      ? '#ffb800'
      : (isIdle ? 'rgba(102,221,255,0.45)' : '#66ddff');
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Country code badge
    if (n.country) {
      ctx.font = "bold 9px 'JetBrains Mono', 'Consolas', monospace";
      ctx.fillStyle = isIdle ? 'rgba(7,9,10,0.6)' : '#07090a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.country, n.x, n.y);
    }
    // Hostname/IP label below
    const label = n.host || n.addr;
    ctx.font = "11px 'Consolas', monospace";
    ctx.fillStyle = isHover ? '#fff'
                            : `rgba(232,230,216,${0.75 * fade})`;
    ctx.textAlign = 'center';
    ctx.fillText(label.length > 28 ? label.slice(0, 27) + '…' : label,
                 n.x, n.y + r + 14);
  }

  // Draw center node (your machine)
  const centerR = 22;
  ctx.shadowColor = '#ffb800';
  ctx.shadowBlur = 20 + Math.sin(_topoFrame * 0.05) * 4;
  ctx.fillStyle = '#ffb800';
  ctx.beginPath();
  ctx.arc(_topoCenter.x, _topoCenter.y, centerR, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // Inner ring
  ctx.strokeStyle = '#07090a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(_topoCenter.x, _topoCenter.y, centerR - 5, 0, Math.PI * 2);
  ctx.stroke();
  // Target name
  ctx.font = "bold 11px 'JetBrains Mono', monospace";
  ctx.fillStyle = '#07090a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('YOU', _topoCenter.x, _topoCenter.y);
  // Target app label
  if (_topoData && _topoData.target) {
    ctx.font = "11px 'Consolas', monospace";
    ctx.fillStyle = 'rgba(232,230,216,0.85)';
    ctx.fillText(_topoData.target, _topoCenter.x, _topoCenter.y + centerR + 16);
  }

  // Empty state
  if (!_topoNodes.length) {
    ctx.font = "italic 13px 'Consolas', monospace";
    ctx.fillStyle = 'rgba(232,230,216,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('No active connections — start capture to see the graph populate.',
                 w / 2, h - 30);
  }

  _topoRafId = requestAnimationFrame(animateTopo);
}

function onTopoMouseMove(e) {
  const canvas = document.getElementById('topo-canvas');
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  let hit = null;
  for (const n of _topoNodes) {
    const r = 8 + Math.min(8, n.weight * 1.2) + 4;
    const dx = mx - n.x, dy = my - n.y;
    if (dx*dx + dy*dy <= r*r) { hit = n; break; }
  }
  _topoHover = hit;
  const info = document.getElementById('topo-info');
  if (!info) return;
  if (!hit) {
    info.innerHTML = '<div class="topo-info-empty">Hover a node for details</div>';
    return;
  }
  info.innerHTML = `
    <div class="ti-host">${escapeHtml(hit.host || hit.addr)}</div>
    <div class="ti-row"><span>IP</span><span>${escapeHtml(hit.addr)}</span></div>
    <div class="ti-row"><span>Country</span><span>${escapeHtml(hit.country || '—')}</span></div>
    <div class="ti-row"><span>Protocol</span><span>${escapeHtml(hit.proto || '—')}</span></div>
    <div class="ti-row"><span>Connections</span><span>${hit.conns}</span></div>
    <div class="ti-row"><span>Ports</span><span>${(hit.ports || []).join(', ') || '—'}</span></div>
    <div class="ti-row"><span>↑ Out</span><span>${formatBytes(hit.bytes_out)}</span></div>
    <div class="ti-row"><span>↓ In</span><span>${formatBytes(hit.bytes_in)}</span></div>`;
}

// ---- PCAP capture ------------------------------------------------------
let _pcapTimer = null;

function setupPcap() {
  const btn = document.getElementById('open-pcap-btn');
  if (btn) btn.addEventListener('click', openPcap);
  const toggle = document.getElementById('pcap-toggle-btn');
  if (toggle) toggle.addEventListener('click', togglePcap);
  const folder = document.getElementById('open-pcap-folder');
  if (folder) folder.addEventListener('click', () => {
    bridge.openPcapFolder().then((ok) => {
      if (!ok) toast('Could not open folder', 'error');
    });
  });
}

// ---- Live packet dump (v3.1.0 network-visibility batch) ----------------
// Poll-based live tail. When the modal opens, we tell the backend to start
// tapping packets into a ring buffer; we poll for new entries 5x/sec and
// append them to a fixed-height pre block. Closing the modal stops the
// tap (so the capture loop stays cheap when nobody's watching).
let _pktDumpTimer = null;
let _pktDumpPaused = false;
let _pktDumpLastSeq = 0;
let _pktDumpStartMs = 0;
const PKTDUMP_MAX_LINES = 500;  // safety cap on rendered rows

function setupPktDump() {
  const btn = document.getElementById('open-pktdump-btn');
  if (btn) btn.addEventListener('click', openPktDump);

  const pause = document.getElementById('pktdump-pause-btn');
  if (pause) pause.addEventListener('click', () => {
    _pktDumpPaused = !_pktDumpPaused;
    pause.innerHTML = _pktDumpPaused ? '▶ Resume' : '⏸ Pause';
  });

  const clear = document.getElementById('pktdump-clear-btn');
  if (clear) clear.addEventListener('click', () => {
    if (bridge.clearPacketDump) bridge.clearPacketDump();
    const out = document.getElementById('pktdump-output');
    if (out) out.textContent = '';
    _pktDumpLastSeq = 0;
  });
}

function openPktDump() {
  // Reset state for a clean session every open
  _pktDumpPaused = false;
  _pktDumpLastSeq = 0;
  _pktDumpStartMs = performance.now();
  const pauseBtn = document.getElementById('pktdump-pause-btn');
  if (pauseBtn) pauseBtn.innerHTML = '⏸ Pause';
  const out = document.getElementById('pktdump-output');
  if (out) out.textContent = '';
  const status = document.getElementById('pktdump-status');
  if (status) status.textContent = 'Live · 0 pkts';

  if (bridge.setPacketDump) bridge.setPacketDump(true);
  document.getElementById('pktdump-modal').hidden = false;
  startPktDumpPolling();
}

function closePktDump() {
  stopPktDumpPolling();
  if (bridge.setPacketDump) bridge.setPacketDump(false);
}

function startPktDumpPolling() {
  if (_pktDumpTimer) return;
  let totalShown = 0;
  _pktDumpTimer = setInterval(() => {
    if (_pktDumpPaused || !bridge.getPacketDump) return;
    bridge.getPacketDump(_pktDumpLastSeq).then((json) => {
      let arr = [];
      try { arr = JSON.parse(json || '[]'); } catch { return; }
      if (!Array.isArray(arr) || arr.length === 0) return;

      // Apply user filter — simple case-insensitive substring across
      // proto/src/dst. Empty filter = pass-all.
      const filterEl = document.getElementById('pktdump-filter');
      const filter = (filterEl?.value || '').trim().toLowerCase();

      const out = document.getElementById('pktdump-output');
      if (!out) return;

      const frag = document.createDocumentFragment();
      for (const p of arr) {
        _pktDumpLastSeq = Math.max(_pktDumpLastSeq, p.seq);
        if (filter) {
          const blob = `${p.proto} ${p.src} ${p.dst}`.toLowerCase();
          if (!blob.includes(filter)) continue;
        }
        // Format: "  +1.234s  TCP  out  192.168.1.5:54321 → 1.1.1.1:443  1234B"
        const dt = ((p.ts * 1000) - _pktDumpStartMs) / 1000;
        const tsStr = dt < 0 ? '   --   ' : `+${dt.toFixed(3)}s`.padStart(8);
        const arrow = p.dir === 'out' ? '→' : '←';
        const line = `  ${tsStr}  ${p.proto.padEnd(4)} ${p.dir.padEnd(3)} ${p.src} ${arrow} ${p.dst}  ${p.size}B\n`;
        const span = document.createElement('span');
        span.className = p.dir === 'out' ? 'pkt-out' : 'pkt-in';
        span.textContent = line;
        frag.appendChild(span);
        totalShown++;
      }
      out.appendChild(frag);

      // Trim if over PKTDUMP_MAX_LINES — protects render performance
      while (out.childNodes.length > PKTDUMP_MAX_LINES) {
        out.removeChild(out.firstChild);
      }
      // Auto-scroll to bottom unless user scrolled up to read
      const nearBottom = (out.scrollTop + out.clientHeight) >= (out.scrollHeight - 40);
      if (nearBottom) out.scrollTop = out.scrollHeight;

      const status = document.getElementById('pktdump-status');
      if (status) status.textContent = `Live · ${totalShown} pkts`;
    }).catch(() => {});
  }, 200);
}

function stopPktDumpPolling() {
  if (_pktDumpTimer) {
    clearInterval(_pktDumpTimer);
    _pktDumpTimer = null;
  }
}

// =====================================================================
// v3.1.1 — Test my Speed tool
// =====================================================================
function setupSpeedTest() {
  const openBtn = document.getElementById('open-speedtest-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      // Reset to idle state every time it opens
      document.getElementById('st-idle').hidden    = false;
      document.getElementById('st-running').hidden = true;
      document.getElementById('st-results').hidden = true;
      // v3.1.1 — Also reset the error pane
      const errPane = document.getElementById('st-error');
      if (errPane) errPane.hidden = true;
      document.getElementById('speedtest-modal').hidden = false;
    });
  }

  const startBtn = document.getElementById('st-start-btn');
  if (startBtn) startBtn.addEventListener('click', runSpeedTest);

  const rerunBtn = document.getElementById('st-rerun-btn');
  if (rerunBtn) rerunBtn.addEventListener('click', runSpeedTest);

  // v3.1.1 — Retry button on the error pane
  const retryBtn = document.getElementById('st-error-retry');
  if (retryBtn) retryBtn.addEventListener('click', runSpeedTest);

  // Connect the progress signal once
  if (bridge.fullSpeedtestProgress && bridge.fullSpeedtestProgress.connect) {
    bridge.fullSpeedtestProgress.connect(onSpeedTestProgress);
  }
}

function runSpeedTest() {
  if (!bridge.runFullSpeedtest) {
    toast('Speed test not available in this build', 'error');
    return;
  }
  // Reset UI
  document.getElementById('st-idle').hidden    = true;
  document.getElementById('st-results').hidden = true;
  // v3.1.1 — also hide error pane so it doesn't stick around on retry
  const errPane = document.getElementById('st-error');
  if (errPane) errPane.hidden = true;
  document.getElementById('st-running').hidden = false;
  // Clear phase states
  document.querySelectorAll('.st-phase').forEach(el => {
    el.classList.remove('active', 'done');
  });
  document.getElementById('st-phase-latency-val').textContent = '—';
  document.getElementById('st-phase-download-val').textContent = '—';
  document.getElementById('st-phase-upload-val').textContent = '—';
  document.getElementById('st-gauge-label').textContent = 'Initializing…';
  document.getElementById('st-gauge-value').textContent = '—';
  document.getElementById('st-gauge-unit').textContent = '';
  document.getElementById('st-gauge-fill').style.width = '0%';
  document.getElementById('st-gauge-sub').textContent = 'Connecting to speed.cloudflare.com…';

  bridge.runFullSpeedtest();
}

function onSpeedTestProgress(json) {
  let s = {};
  try { s = JSON.parse(json || '{}'); } catch { return; }

  const phase = s.phase || '';
  const setActive = (which) => {
    document.querySelectorAll('.st-phase').forEach(el => {
      const p = el.dataset.phase;
      if (p === which) {
        el.classList.add('active');
        el.classList.remove('done');
      } else if (el.classList.contains('active')) {
        // Was active, now something else is — mark this one done
        el.classList.remove('active');
        el.classList.add('done');
      }
    });
  };

  if (phase === 'starting') {
    document.getElementById('st-gauge-label').textContent = 'Measuring latency…';
    document.getElementById('st-gauge-sub').textContent = `Connecting to ${s.host || 'server'}…`;
  } else if (phase === 'latency') {
    setActive('latency');
    document.getElementById('st-gauge-label').textContent = 'Measuring latency';
    document.getElementById('st-gauge-unit').textContent = 'ms';
    if (s.current != null) {
      document.getElementById('st-gauge-value').textContent = Math.round(s.current);
      document.getElementById('st-phase-latency-val').textContent = `${Math.round(s.current)} ms`;
    }
    document.getElementById('st-gauge-fill').style.width = `${(s.progress || 0) * 100}%`;
    document.getElementById('st-gauge-sub').textContent = `Pinging… (${Math.round((s.progress || 0) * 6)}/6)`;
  } else if (phase === 'downloading') {
    setActive('downloading');
    document.getElementById('st-gauge-label').textContent = 'Downloading';
    document.getElementById('st-gauge-unit').textContent = 'Mbps';
    document.getElementById('st-gauge-value').textContent = (s.current_mbps || 0).toFixed(1);
    document.getElementById('st-phase-download-val').textContent = `${(s.current_mbps || 0).toFixed(1)} Mbps`;
    document.getElementById('st-gauge-fill').style.width = `${(s.progress || 0) * 100}%`;
    const mb = ((s.bytes || 0) / (1024 * 1024)).toFixed(1);
    const totalMb = ((s.target_bytes || 0) / (1024 * 1024)).toFixed(0);
    document.getElementById('st-gauge-sub').textContent = `${mb} MB / ${totalMb} MB`;
  } else if (phase === 'uploading') {
    setActive('uploading');
    document.getElementById('st-gauge-label').textContent = 'Uploading';
    document.getElementById('st-gauge-unit').textContent = 'Mbps';
    document.getElementById('st-gauge-value').textContent = (s.current_mbps || 0).toFixed(1);
    document.getElementById('st-phase-upload-val').textContent = `${(s.current_mbps || 0).toFixed(1)} Mbps`;
    document.getElementById('st-gauge-fill').style.width = `${(s.progress || 0) * 100}%`;
    const mb = ((s.bytes || 0) / (1024 * 1024)).toFixed(1);
    const totalMb = ((s.target_bytes || 0) / (1024 * 1024)).toFixed(0);
    document.getElementById('st-gauge-sub').textContent = `${mb} MB / ${totalMb} MB`;
  } else if (phase === 'upload_failed') {
    // Note in results but don't bail — download results still valid
    document.getElementById('st-phase-upload-val').textContent = 'failed';
  } else if (phase === 'blocked') {
    // v3.1.1 — Show in-modal error pane (don't reset to idle — that was
    // happening too fast for the user to read the toast).
    showSpeedTestError(
      'Cannot run while Throttlr is active',
      s.error || 'Stop any active capture or function toggles before running the speed test.'
    );
  } else if (phase === 'done') {
    showSpeedTestResults(s);
  } else if (phase === 'error') {
    showSpeedTestError(
      'Speed test failed',
      s.error || 'Unknown error — check %USERPROFILE%\\.throttlr\\startup.log for details.'
    );
  }
}

function showSpeedTestError(title, msg) {
  document.getElementById('st-idle').hidden     = true;
  document.getElementById('st-running').hidden  = true;
  document.getElementById('st-results').hidden  = true;
  document.getElementById('st-error').hidden    = false;
  document.getElementById('st-error-title').textContent = title;
  document.getElementById('st-error-msg').textContent   = msg;
}

function showSpeedTestResults(s) {
  document.getElementById('st-running').hidden = true;
  document.getElementById('st-results').hidden = false;

  // Speed cards
  document.getElementById('st-r-download').textContent = (s.download_mbps != null ? s.download_mbps.toFixed(1) : '—');
  document.getElementById('st-r-upload').textContent   = (s.upload_mbps   != null ? s.upload_mbps.toFixed(1)   : '—');
  document.getElementById('st-r-latency').textContent  = (s.latency_ms    != null ? s.latency_ms.toFixed(0)    : '—');
  document.getElementById('st-r-jitter').textContent   = (s.jitter_ms     != null ? s.jitter_ms.toFixed(0)     : '—');

  // Verdict block
  const v = s.verdict || {};
  document.getElementById('st-verdict-tier').textContent     = v.tier_name || '';
  document.getElementById('st-verdict-headline').textContent = v.headline  || '';
  document.getElementById('st-verdict-desc').textContent     = v.description || '';

  // Capability list
  const capUl = document.getElementById('st-capabilities');
  capUl.innerHTML = '';
  (v.capabilities || []).forEach(c => {
    const li = document.createElement('li');
    li.textContent = c;
    capUl.appendChild(li);
  });

  // v3.1.1 — Fun facts
  const ffUl = document.getElementById('st-fun-facts');
  if (ffUl) {
    ffUl.innerHTML = '';
    (v.fun_facts || []).forEach(f => {
      const li = document.createElement('li');
      li.textContent = f;
      ffUl.appendChild(li);
    });
  }

  // v3.1.1 — Use case ratings table
  const ucEl = document.getElementById('st-use-cases');
  if (ucEl) {
    ucEl.innerHTML = '';
    (v.use_cases || []).forEach(([label, stars]) => {
      const row = document.createElement('div');
      row.className = 'st-uc-row';
      row.innerHTML = `<span class="st-uc-label">${label}</span><span class="st-uc-stars">${stars}</span>`;
      ucEl.appendChild(row);
    });
  }

  // Quality grades with color coding
  const latEl = document.getElementById('st-q-latency');
  latEl.textContent = v.latency_grade || '—';
  latEl.className = `st-q-value q-${(v.latency_grade || 'unknown').replace(/\s+/g, '\\ ')}`;
  const latDetailEl = document.getElementById('st-q-latency-detail');
  if (latDetailEl) latDetailEl.textContent = v.latency_detail || '';

  const jitEl = document.getElementById('st-q-jitter');
  jitEl.textContent = v.jitter_grade || '—';
  jitEl.className = `st-q-value q-${(v.jitter_grade || 'unknown').replace(/\s+/g, '\\ ')}`;
  const jitDetailEl = document.getElementById('st-q-jitter-detail');
  if (jitDetailEl) jitDetailEl.textContent = v.jitter_detail || '';

  document.getElementById('st-ratio-note').textContent = v.ratio_note || '';

  // v3.1.1 — Throttlr simulation preset suggestions
  const simEl = document.getElementById('st-sim-presets');
  if (simEl) {
    simEl.innerHTML = '';
    const presets = v.simulation_presets || [];
    if (presets.length === 0) {
      simEl.innerHTML = '<div class="st-sim-empty">Your speed is too low to meaningfully simulate worse ones.</div>';
    } else {
      presets.forEach(p => {
        const card = document.createElement('div');
        card.className = 'st-sim-card';
        card.innerHTML = `
          <div class="st-sim-name">${p.name}</div>
          <div class="st-sim-feels">${p.feels_like}</div>
          <div class="st-sim-settings">${p.settings}</div>
        `;
        simEl.appendChild(card);
      });
    }
  }

  // v3.1.1 — Network details
  const net = s.network || {};
  const setNet = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val && val !== 'Unknown' ? val : '—';
  };
  setNet('st-n-isp',          net.isp);
  setNet('st-n-asn',          net.isp_org);
  setNet('st-n-ip',           net.public_ip);
  setNet('st-n-adapter',      net.primary_adapter);
  setNet('st-n-adapter-type', net.primary_adapter_type);
  setNet('st-n-local-ip',     net.local_ip);
  setNet('st-n-gateway',      net.gateway);
  // Build location string from city + region + country
  const locParts = [net.city, net.region, net.country].filter(p => p && p !== 'Unknown');
  setNet('st-n-location', locParts.length > 0 ? locParts.join(', ') : null);
  // DNS list — comma-separated
  const dnsList = (net.dns_servers || []).filter(d => d);
  setNet('st-n-dns', dnsList.length > 0 ? dnsList.join(', ') : null);
}

function openPcap() {
  document.getElementById('pcap-modal').hidden = false;
  refreshPcapStatus();
  refreshPcapList();
  if (_pcapTimer) clearInterval(_pcapTimer);
  _pcapTimer = setInterval(() => {
    if (document.getElementById('pcap-modal').hidden) {
      clearInterval(_pcapTimer); _pcapTimer = null; return;
    }
    refreshPcapStatus();
  }, 500);
}

function togglePcap() {
  bridge.isPcapRecording().then((isRec) => {
    if (isRec) {
      bridge.stopPcap().then((path) => {
        toast(path ? 'PCAP saved' : 'PCAP stopped', 'success');
        refreshPcapStatus();
        refreshPcapList();
      });
    } else {
      bridge.startPcap().then((ok) => {
        if (ok) {
          toast('PCAP capture started — every targeted packet will be recorded', 'success');
        } else {
          toast('Could not start PCAP — start capture first', 'error');
        }
        refreshPcapStatus();
      });
    }
  });
}

function refreshPcapStatus() {
  bridge.getPcapStats().then((raw) => {
    let s = {};
    try { s = JSON.parse(raw || '{}'); } catch {}
    const status = document.getElementById('pcap-status');
    const btn = document.getElementById('pcap-toggle-btn');
    if (s.recording) {
      const sizeKB = (s.bytes / 1024).toFixed(1);
      status.textContent = `● Recording — ${(s.packets || 0).toLocaleString()} packets · ${sizeKB} KB`;
      status.classList.add('recording');
      btn.textContent = '■ Stop PCAP';
      btn.classList.add('recording');
    } else {
      status.textContent = 'Idle';
      status.classList.remove('recording');
      btn.textContent = '● Start PCAP';
      btn.classList.remove('recording');
    }
  });
}

function refreshPcapList() {
  bridge.listPcaps().then((raw) => {
    let list = [];
    try { list = JSON.parse(raw || '[]'); } catch {}
    const container = document.getElementById('pcap-list');
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="loading">No captures yet.</div>';
      return;
    }
    container.innerHTML = '';
    list.forEach(rec => {
      const row = document.createElement('div');
      row.className = 'rec-row';
      const date = new Date(rec.mtime * 1000).toLocaleString();
      const sizeKB = (rec.size / 1024).toFixed(1);
      row.innerHTML = `
        <div class="rec-name">${escapeHtml(rec.name)}.pcap</div>
        <div class="rec-meta">${date} · ${sizeKB} KB</div>
        <button type="button" class="rec-del">Delete</button>`;
      row.querySelector('.rec-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete capture "${rec.name}.pcap"?`)) {
          bridge.deletePcap(rec.path).then(() => refreshPcapList());
        }
      });
      container.appendChild(row);
    });
  });
}

// ---- Filter Script -----------------------------------------------------
function setupFilterScript() {
  const btn = document.getElementById('open-script-btn');
  if (btn) btn.addEventListener('click', openScriptModal);
  const compile = document.getElementById('script-compile-btn');
  if (compile) compile.addEventListener('click', compileScript);
  const save = document.getElementById('script-save-btn');
  if (save) save.addEventListener('click', saveScript);
  const enabled = document.getElementById('script-enabled');
  if (enabled) enabled.addEventListener('change', () => {
    bridge.setFilterScriptOn(enabled.checked);
    _updateScriptDiagPanelVisibility();
  });
  const action = document.getElementById('script-action');
  if (action) action.addEventListener('change', () => {
    bridge.setFilterScriptAction(action.value);
    _refreshDiagActionLabel();
  });
}

// v3.0.9 — Live diagnostics polling. Runs only while the modal is open
// to avoid pointless bridge round-trips. Updates every 750ms.
let _scriptDiagTimer = null;

function _updateScriptDiagPanelVisibility() {
  const panel = document.getElementById('script-diagnostics');
  const enabled = document.getElementById('script-enabled');
  if (!panel) return;
  // Show diagnostics whenever the script checkbox is ticked. If it's
  // off, no packets are being evaluated so counters are misleading.
  panel.hidden = !(enabled && enabled.checked);
}

function _refreshDiagActionLabel() {
  const action = document.getElementById('script-action');
  const sub = document.getElementById('diag-action-sub');
  if (!action || !sub) return;
  sub.textContent = action.value === 'keep_only' ? '(everything else dropped)' : '(dropped)';
}

function _startScriptDiagPolling() {
  if (_scriptDiagTimer) clearInterval(_scriptDiagTimer);
  const pull = () => {
    if (!bridge || !bridge.getFilterScriptStats) return;
    bridge.getFilterScriptStats().then((raw) => {
      let s = {};
      try { s = JSON.parse(raw || '{}'); } catch { return; }
      const evalCount  = s.eval_count  || 0;
      const matchCount = s.match_count || 0;
      const errCount   = s.error_count || 0;
      const evalEl     = document.getElementById('diag-eval');
      const matchEl    = document.getElementById('diag-matched');
      const rateEl     = document.getElementById('diag-rate');
      const errEl      = document.getElementById('diag-errors');
      const lastErrEl  = document.getElementById('diag-last-error');
      const hintEl     = document.getElementById('diag-hint');
      if (evalEl)  evalEl.textContent  = _fmtBigNum(evalCount);
      if (matchEl) matchEl.textContent = _fmtBigNum(matchCount);
      if (errEl)   errEl.textContent   = _fmtBigNum(errCount);
      // Match rate as a percentage
      if (rateEl) {
        if (evalCount > 0) {
          const pct = (matchCount / evalCount) * 100;
          rateEl.textContent = pct < 0.01 && matchCount > 0
            ? '<0.01%'
            : pct.toFixed(pct < 1 ? 2 : (pct < 10 ? 1 : 0)) + '%';
        } else {
          rateEl.textContent = '—';
        }
      }
      // Last error
      if (lastErrEl) {
        if (s.last_error && errCount > 0) {
          lastErrEl.textContent = '⚠ Last error: ' + s.last_error;
          lastErrEl.hidden = false;
        } else {
          lastErrEl.hidden = true;
        }
      }
      // Smart hints that guide users to the actual cause when counters
      // suggest the script isn't doing what they expected.
      if (hintEl) {
        let hint = '';
        if (!s.on) {
          hint = 'Tick "Enable script" and click "Save & apply" to activate.';
        } else if (!s.compiled) {
          hint = 'Script not compiled. Click "Compile" first, then "Save & apply".';
        } else if (evalCount === 0) {
          hint = 'No packets evaluated yet. Make sure Throttlr is running (press F5 or click Start) and the target app is sending traffic.';
        } else if (evalCount > 1000 && matchCount === 0 && errCount === 0) {
          hint = 'Script is running but matched zero packets out of ' + _fmtBigNum(evalCount) + '. Likely causes: (1) condition is too narrow, (2) using pkt.host on non-TLS traffic (host is empty for most packets), (3) using pkt.country without GeoIP loaded.';
        } else if (errCount > 0 && evalCount > 0 && errCount / evalCount > 0.5) {
          hint = 'Most evaluations are erroring out. Check the script for typos or unsupported syntax. See last error above.';
        }
        if (hint) {
          hintEl.textContent = hint;
          hintEl.hidden = false;
        } else {
          hintEl.hidden = true;
        }
      }
    }).catch(() => {});
  };
  pull();
  _scriptDiagTimer = setInterval(pull, 750);
}

function _stopScriptDiagPolling() {
  if (_scriptDiagTimer) {
    clearInterval(_scriptDiagTimer);
    _scriptDiagTimer = null;
  }
}

function _fmtBigNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function openScriptModal() {
  bridge.getFilterScriptState().then((raw) => {
    let s = {};
    try { s = JSON.parse(raw || '{}'); } catch {}
    document.getElementById('script-source').value = s.source || '';
    document.getElementById('script-action').value = s.action || 'drop';
    document.getElementById('script-enabled').checked = !!s.on;
    const status = document.getElementById('script-status');
    if (s.compiled) {
      status.textContent = '✓ Compiled and ready';
      status.classList.add('ok');
      status.classList.remove('err');
    } else if (s.error) {
      status.textContent = '✗ ' + s.error;
      status.classList.add('err');
      status.classList.remove('ok');
    } else {
      status.textContent = 'Not compiled';
      status.classList.remove('ok', 'err');
    }
    _refreshDiagActionLabel();
    _updateScriptDiagPanelVisibility();
    document.getElementById('script-modal').hidden = false;
    _startScriptDiagPolling();
  });
}

function compileScript() {
  const src = document.getElementById('script-source').value || '';
  bridge.compileFilterScript(src).then((raw) => {
    let r = {};
    try { r = JSON.parse(raw || '{}'); } catch {}
    const status = document.getElementById('script-status');
    if (r.ok) {
      status.textContent = src.trim() ? '✓ Compiled successfully' : 'Empty script — disabled';
      status.classList.add('ok');
      status.classList.remove('err');
    } else {
      status.textContent = '✗ ' + (r.error || 'Compile failed');
      status.classList.add('err');
      status.classList.remove('ok');
    }
  });
}

function saveScript() {
  const src = document.getElementById('script-source').value || '';
  const action = document.getElementById('script-action').value || 'drop';
  const enabled = document.getElementById('script-enabled').checked;
  // Compile, then save source + action + on
  bridge.compileFilterScript(src).then((raw) => {
    let r = {};
    try { r = JSON.parse(raw || '{}'); } catch {}
    if (!r.ok) {
      const status = document.getElementById('script-status');
      status.textContent = '✗ ' + (r.error || 'Compile failed — fix errors first');
      status.classList.add('err');
      status.classList.remove('ok');
      toast('Cannot save — script has errors', 'error');
      return;
    }
    bridge.setFilterScriptSource(src);
    bridge.setFilterScriptAction(action);
    bridge.setFilterScriptOn(enabled);
    _stopScriptDiagPolling();
    document.getElementById('script-modal').hidden = true;
    toast(`Filter script ${enabled ? 'active' : 'saved'}`, 'success');
  });
}


// ============================================================================
// ONBOARDING — first-launch tutorial + update log
// ============================================================================

// v3.1.0 — Tutorial now branches by user intent. The first page is a
// path picker; once the user chooses Gamer / Dev / Explorer, the rest of
// the carousel is rebuilt from that path's array.
//
// Each page object can optionally include:
//   spotlight: { target: '#css-selector', placement: 'bottom'|'top'|'left'|'right' }
//     If present, advancing to this page hides the tour modal and shows
//     a dimmed overlay with a glow ring on the target element.
//   action: { key: 'identifier', label: 'Button text' }
//     If present, a "Try it now" button appears. Clicking runs the named
//     action then advances to the next page.

const TUTORIAL_PATH_PICKER = {
  icon: 'zap',
  title: 'Welcome to Throttlr',
  subtitle: '// per-application network throttler',
  isPicker: true,
  body: `
    <p>Throttlr lets you intercept the traffic of any single Windows app
    and tinker with it. Before we start — what brings you here?</p>
    <div class="tut-path-grid">
      <button type="button" class="tut-path-card" data-path="gamer">
        <span class="tpc-icon" data-icon="zap"></span>
        <span class="tpc-title">Gamer</span>
        <span class="tpc-sub">Lag switch, practice ping, block</span>
      </button>
      <button type="button" class="tut-path-card" data-path="dev">
        <span class="tpc-icon" data-icon="package"></span>
        <span class="tpc-title">Dev / Tester</span>
        <span class="tpc-sub">Throttle, real-world presets, scripts</span>
      </button>
      <button type="button" class="tut-path-card" data-path="explorer">
        <span class="tpc-icon" data-icon="search"></span>
        <span class="tpc-title">Just exploring</span>
        <span class="tpc-sub">Show me everything</span>
      </button>
    </div>
    <p class="tut-path-hint">Pick one — takes 30 seconds. You can replay
    this anytime from <strong>Settings → Info</strong>.</p>`,
};

const TUTORIAL_PATHS = {
  gamer: [
    {
      icon: 'search',
      title: 'Pick your game',
      subtitle: '// step 01 — target',
      body: `
        <p>Click the big <strong>"Click here to choose application"</strong>
        slot to pick the game's running .exe. You can also drag any
        executable onto the window.</p>
        <p>Recent picks turn into one-tap chips so you don't hunt every time.</p>`,
      spotlight: { target: '#app-picker-trigger, .app-picker-slot', placement: 'bottom' },
      action: { key: 'open-picker', label: 'Open app picker now →' },
    },
    {
      icon: 'activity',
      title: 'Practice Ping',
      subtitle: '// step 02 — feel real lag',
      body: `
        <p>Throttlr's <strong>Practice Ping</strong> mode adds a fixed
        round-trip delay so you can train against the exact ping you'd
        get on a worse connection. Used by FPS players to play "as if
        I had 150ms" so jumping back to 30ms feels surgical.</p>`,
      spotlight: { target: '[data-tool="practice-ping"], #tool-practice-ping', placement: 'left' },
      action: { key: 'open-practice-ping', label: 'Open Practice Ping →' },
    },
    {
      icon: 'zap',
      title: 'Block hotkey',
      subtitle: '// step 03 — the kill switch',
      body: `
        <p><strong>F9</strong> is your panic button. One tap kills all
        traffic for the targeted app — instant disconnect feel.
        Tap again to restore.</p>
        <p>Other hotkeys:
        <br><strong>F5</strong> — Start / stop capture
        <br><strong>F8</strong> — Toggle Freeze
        <br><strong>F10</strong> — Toggle Fun mode</p>`,
    },
    {
      icon: 'play',
      title: "Time to play",
      subtitle: '// you\'re ready',
      body: `
        <p>That's the essentials. Pick your game, hit <strong>F5</strong>
        to start, flip whatever switch you want.</p>
        <p>Re-watch this tour anytime from
        <strong>Settings → Info → Replay tour</strong>.</p>`,
    },
  ],
  dev: [
    {
      icon: 'search',
      title: 'Pick the app under test',
      subtitle: '// step 01 — target',
      body: `
        <p>Click the big <strong>"Click here to choose application"</strong>
        slot to pick the .exe you're testing. Drag-drop works too.</p>
        <p>Need to target a launcher and its child processes?
        Hit <strong>Multi-target</strong>.</p>`,
      spotlight: { target: '#app-picker-trigger, .app-picker-slot', placement: 'bottom' },
      action: { key: 'open-picker', label: 'Open app picker now →' },
    },
    {
      icon: 'package',
      title: 'Throttle + Lag',
      subtitle: '// step 02 — reproduce bad networks',
      body: `
        <p>The two functions you'll use most for testing:</p>
        <p><strong>Throttle</strong> — caps bandwidth in KB/s (per-direction).
        Great for "what does my app do on 3G?"
        <br><strong>Lag</strong> — adds RTT in ms with optional jitter.
        Great for "what does my app do at 300ms?"</p>
        <p>Both work In, Out, or both — independently.</p>`,
    },
    {
      icon: 'folder',
      title: 'Real-world presets',
      subtitle: '// step 03 — one-tap conditions',
      body: `
        <p>Don't want to dial values? The <strong>Real-world</strong>
        preset tab has 56k modem, 3G, 4G, satellite link, and more —
        based on measured numbers, not vibes.</p>
        <p>Save your own with <strong>Save current as preset</strong>
        once you've nailed a scenario your team needs to repro.</p>`,
    },
    {
      icon: 'zap',
      title: 'Filter Script',
      subtitle: '// step 04 — surgical drops',
      body: `
        <p>When per-app isn't precise enough, the <strong>Filter Script</strong>
        tool lets you write a tiny expression that runs against every packet:</p>
        <p><code>pkt.dport == 443 and pkt.host == 'api.example.com'</code></p>
        <p>Sandboxed AST evaluator. Live stats show match rate so you know
        it's firing.</p>`,
      spotlight: { target: '[data-tool="script"], #tool-script', placement: 'left' },
      action: { key: 'open-script', label: 'Open Filter Script →' },
    },
    {
      icon: 'play',
      title: "You're set",
      subtitle: '// go test some bugs',
      body: `
        <p>That's the pro tour. Other tools worth checking when you have
        a minute: <strong>Recordings</strong> (capture & replay), 
        <strong>PCAP</strong> (Wireshark export), 
        <strong>Connection Inspector</strong> (live per-flow view).</p>
        <p>Re-watch this from <strong>Settings → Info → Replay tour</strong>.</p>`,
    },
  ],
  explorer: [
    {
      icon: 'search',
      title: 'Pick an app',
      subtitle: '// step 01 — target',
      body: `
        <p>Click the big <strong>"Click here to choose application"</strong>
        slot to pick a running .exe. You can also drag any executable
        onto the window.</p>
        <p>Recently-used apps appear as one-tap chips. Hit
        <strong>Multi-target</strong> if you want to throttle several apps
        together — handy for game launchers that spawn helper processes.</p>`,
      spotlight: { target: '#app-picker-trigger, .app-picker-slot', placement: 'bottom' },
      action: { key: 'open-picker', label: 'Open app picker now →' },
    },
    {
      icon: 'activity',
      title: 'The 6 functions',
      subtitle: '// step 02 — make trouble',
      body: `
        <p>Toggle any of these to start affecting the targeted app's
        traffic. Each works inbound, outbound, or both.</p>
        <div class="tut-pills">
          <span class="tut-pill"><span class="icon" data-icon="activity"></span>Lag</span>
          <span class="tut-pill"><span class="icon" data-icon="ban"></span>Drop</span>
          <span class="tut-pill"><span class="icon" data-icon="package"></span>Throttle</span>
          <span class="tut-pill"><span class="icon" data-icon="snowflake"></span>Freeze</span>
          <span class="tut-pill"><span class="icon" data-icon="zap"></span>Block</span>
          <span class="tut-pill"><span class="icon" data-icon="record"></span>Fun</span>
        </div>
        <p>Hit <strong>F5</strong> (or the big yellow Start button) to
        begin capture, then flip switches to feel the impact in real time.</p>`,
    },
    {
      icon: 'folder',
      title: 'Quick Presets',
      subtitle: '// step 03 — one-tap configs',
      body: `
        <p>Don't want to fiddle with sliders? Pick a preset.
        <strong>Chaos</strong> are creative scenarios (Connection Killer,
        Freeze Burst, DNS Block).
        <strong>Real-world</strong> simulates network conditions like
        56k modem, 3G, satellite link.</p>
        <p>Build your own and hit <strong>Save current as preset</strong>
        to drop it in the <strong>My Presets</strong> tab.</p>`,
    },
    {
      icon: 'network',
      title: 'The Tools rail',
      subtitle: '// step 04 — advanced',
      body: `
        <p>The strip on the right edge unlocks the deep stuff —</p>
        <div class="tut-pills">
          <span class="tut-pill"><span class="icon" data-icon="search"></span>Inspector</span>
          <span class="tut-pill"><span class="icon" data-icon="activity"></span>Practice Ping</span>
          <span class="tut-pill"><span class="icon" data-icon="record"></span>Record</span>
          <span class="tut-pill"><span class="icon" data-icon="film"></span>Recordings</span>
          <span class="tut-pill"><span class="icon" data-icon="network"></span>Topology</span>
          <span class="tut-pill"><span class="icon" data-icon="package"></span>PCAP</span>
          <span class="tut-pill"><span class="icon" data-icon="zap"></span>Script</span>
        </div>
        <p>See live connections, watch a force-graph of who your app talks
        to, dump packets to Wireshark, or write your own filter expressions.</p>`,
    },
    {
      icon: 'play',
      title: "You're ready",
      subtitle: '// go go go',
      body: `
        <p>Hotkeys to remember:</p>
        <p><strong>F5</strong> — Start / stop capture
        <br><strong>F8</strong> — Toggle Freeze
        <br><strong>F9</strong> — Toggle Block
        <br><strong>F10</strong> — Toggle Fun mode</p>
        <p>Re-watch this from <strong>Settings → Info → Replay tour</strong>.
        Have fun.</p>`,
    },
  ],
};

// Active pages — points at TUTORIAL_PATHS[chosen] once picked, or the
// path-picker page until then. Mutated by chooseTutorialPath().
let _currentPages = [TUTORIAL_PATH_PICKER];
let _chosenPath = null;

let _tutorialPage = 0;
let _tutorialMaxReached = 0;

// v3.1.0 — Renders _currentPages into the carousel. Called once on initial
// setupTutorial(), then again whenever the path changes.
function _renderTutorialPages() {
  const stage = document.getElementById('tutorial-stage');
  const dots  = document.getElementById('tp-dots');
  const total = document.getElementById('tut-total');
  if (!stage || !dots) return;
  // Wipe previous content
  stage.innerHTML = '';
  dots.innerHTML = '';

  _currentPages.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'tut-page' + (i === 0 ? ' active' : '');
    div.dataset.idx = i;
    // Action button (Try it now) — only rendered if the page has an action
    const actionHtml = p.action
      ? `<button type="button" class="btn-stencil tut-action-btn"
                 data-action="${p.action.key}">${p.action.label}</button>`
      : '';
    div.innerHTML = `
      <span class="icon tut-icon" data-icon="${p.icon}"></span>
      <div class="tut-subtitle">${p.subtitle}</div>
      <h2>${p.title}</h2>
      <div class="tut-body">${p.body}</div>
      ${actionHtml}`;
    stage.appendChild(div);

    const d = document.createElement('span');
    d.className = 'tp-dot' + (i === 0 ? ' active' : '');
    d.dataset.idx = i;
    dots.appendChild(d);
  });

  if (total) total.textContent = _currentPages.length;
  renderIcons(stage);

  // Wire path-picker cards if the current page set is the picker
  stage.querySelectorAll('.tut-path-card').forEach(card => {
    card.addEventListener('click', () => {
      chooseTutorialPath(card.dataset.path);
    });
  });

  // Wire "Try it now" buttons
  stage.querySelectorAll('.tut-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      runTutorialAction(btn.dataset.action);
    });
  });
}

function setupTutorial() {
  const stage = document.getElementById('tutorial-stage');
  if (!stage) return;
  _renderTutorialPages();

  document.getElementById('tut-prev').addEventListener('click', () => {
    if (_tutorialPage > 0) goTutorialPage(_tutorialPage - 1);
  });
  document.getElementById('tut-next').addEventListener('click', () => {
    if (_tutorialPage < _currentPages.length - 1) {
      goTutorialPage(_tutorialPage + 1);
    } else {
      finishTutorial();
    }
  });
  document.getElementById('tut-skip').addEventListener('click', finishTutorial);
}

// v3.1.0 — User picked a path from the welcome page. Swap in that path's
// pages and advance to its first content page.
function chooseTutorialPath(path) {
  if (!TUTORIAL_PATHS[path]) return;
  _chosenPath = path;
  _currentPages = TUTORIAL_PATHS[path];
  _tutorialPage = 0;
  _tutorialMaxReached = 0;
  _renderTutorialPages();
  goTutorialPage(0);
}

function goTutorialPage(idx) {
  if (idx < 0 || idx >= _currentPages.length) return;
  _tutorialPage = idx;
  if (idx > _tutorialMaxReached) _tutorialMaxReached = idx;

  document.querySelectorAll('#tutorial-stage .tut-page').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });
  document.querySelectorAll('#tp-dots .tp-dot').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });

  const totalPages = _currentPages.length;
  const pct = totalPages > 1 ? (idx / (totalPages - 1)) * 100 : 100;
  const fill = document.getElementById('tp-fill');
  if (fill) fill.style.width = pct + '%';
  const cur = document.getElementById('tut-cur');
  if (cur) cur.textContent = idx + 1;

  // Hide prev on path-picker (no going back from welcome)
  const prevBtn = document.getElementById('tut-prev');
  if (prevBtn) prevBtn.disabled = (idx === 0);

  // Hide next on path-picker (user must choose a path card to advance)
  const nextBtn = document.getElementById('tut-next');
  if (nextBtn) {
    const page = _currentPages[idx];
    if (page && page.isPicker) {
      nextBtn.style.visibility = 'hidden';
    } else {
      nextBtn.style.visibility = '';
      nextBtn.innerHTML = (idx === totalPages - 1) ? "Get Started ▶" : "Next →";
    }
  }

  // Spotlight: if this page has a spotlight target, hide the tour modal
  // and show the overlay pointing at that element.
  const page = _currentPages[idx];
  if (page && page.spotlight) {
    showSpotlightForPage(idx);
  }
}

// v3.1.0 — Spotlight overlay. Dims the screen and points at a real UI
// element, with a caption box + "Continue tour" button to advance.
function showSpotlightForPage(pageIdx) {
  const page = _currentPages[pageIdx];
  if (!page || !page.spotlight) return;

  // Find the target — accept comma-separated fallback selectors
  let target = null;
  for (const sel of page.spotlight.target.split(',').map(s => s.trim())) {
    if (!sel) continue;
    target = document.querySelector(sel);
    if (target) break;
  }
  if (!target) {
    // No target found in DOM — just stay in the carousel
    return;
  }

  // Hide the tour modal so the user can see what's behind it
  const tourModal = document.getElementById('tutorial-modal');
  if (tourModal) tourModal.hidden = true;

  // Build/show the spotlight overlay
  let overlay = document.getElementById('spotlight-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'spotlight-overlay';
    overlay.className = 'spotlight-overlay';
    overlay.innerHTML = `
      <div class="spotlight-caption" id="spotlight-caption">
        <h3 id="spotlight-title"></h3>
        <p id="spotlight-body"></p>
        <div class="spotlight-actions">
          <button type="button" class="btn-stencil" id="spotlight-action"></button>
          <button type="button" class="btn-stencil" id="spotlight-continue">Continue tour →</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  // Lift the target above the dim layer with a glow ring
  document.querySelectorAll('.spotlight-target').forEach(el =>
    el.classList.remove('spotlight-target'));
  target.classList.add('spotlight-target');

  // Position the caption near the target — kept simple, just below by default
  const rect = target.getBoundingClientRect();
  const cap = document.getElementById('spotlight-caption');
  const placement = page.spotlight.placement || 'bottom';
  cap.dataset.placement = placement;
  cap.style.position = 'fixed';
  if (placement === 'left') {
    cap.style.left = Math.max(20, rect.left - 360) + 'px';
    cap.style.top  = Math.max(20, rect.top) + 'px';
  } else if (placement === 'right') {
    cap.style.left = Math.min(window.innerWidth - 360, rect.right + 24) + 'px';
    cap.style.top  = Math.max(20, rect.top) + 'px';
  } else if (placement === 'top') {
    cap.style.left = Math.max(20, rect.left) + 'px';
    cap.style.top  = Math.max(20, rect.top - 180) + 'px';
  } else {
    cap.style.left = Math.max(20, rect.left) + 'px';
    cap.style.top  = Math.min(window.innerHeight - 200, rect.bottom + 24) + 'px';
  }

  // Strip HTML from the body for the caption — keep it short
  const bodyText = (page.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  document.getElementById('spotlight-title').textContent = page.title;
  document.getElementById('spotlight-body').textContent =
      bodyText.length > 180 ? bodyText.slice(0, 180) + '…' : bodyText;

  // Wire the action button — only shown if the page has an action
  const actionBtn = document.getElementById('spotlight-action');
  if (page.action) {
    actionBtn.textContent = page.action.label;
    actionBtn.hidden = false;
    actionBtn.onclick = () => {
      hideSpotlight();
      runTutorialAction(page.action.key);
    };
  } else {
    actionBtn.hidden = true;
    actionBtn.onclick = null;
  }

  // Continue → hide spotlight, advance, reopen tour modal
  document.getElementById('spotlight-continue').onclick = () => {
    hideSpotlight();
    if (_tutorialPage < _currentPages.length - 1) {
      goTutorialPage(_tutorialPage + 1);
      if (tourModal) tourModal.hidden = false;
    } else {
      finishTutorial();
    }
  };

  overlay.hidden = false;
  // Force a reflow so the transition runs
  void overlay.offsetWidth;
  overlay.classList.add('visible');
}

function hideSpotlight() {
  const overlay = document.getElementById('spotlight-overlay');
  if (overlay) {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.hidden = true; }, 200);
  }
  document.querySelectorAll('.spotlight-target').forEach(el =>
    el.classList.remove('spotlight-target'));
}

// v3.1.0 — Try-it-now action runner. Each key maps to a real app behavior.
// Adding a new key: just add a case here and reference it from a page's
// `action: { key: '...', label: '...' }`.
function runTutorialAction(key) {
  // Close the tour first so the user can interact with the app
  const tourModal = document.getElementById('tutorial-modal');
  if (tourModal) tourModal.hidden = true;
  hideSpotlight();

  try {
    switch (key) {
      case 'open-picker': {
        const btn = document.querySelector('#app-picker-trigger, .app-picker-slot');
        if (btn) {
          btn.click();
          // v3.1.0 — Tour polish: nudge the user to actually pick something,
          // and celebrate the moment when they do. Watches currentApp for
          // a change over the next 60s; if they select an app we acknowledge.
          setTimeout(() => {
            toast('Pick any running app from the list — type a name to filter', 'info');
          }, 600);
          const tourPickWatcher = setInterval(() => {
            if (currentApp) {
              clearInterval(tourPickWatcher);
              toast(`Targeting ${currentApp} — now hit F5 (or the Start button) when you're ready`, 'success');
            }
          }, 500);
          // Stop watching after 60s if they never picked anything
          setTimeout(() => clearInterval(tourPickWatcher), 60_000);
        }
        else toast('Could not find the app picker — it might be hidden', 'warning');
        break;
      }
      case 'open-practice-ping': {
        const btn = document.querySelector('[data-tool="practice-ping"], #tool-practice-ping');
        if (btn) btn.click();
        else toast('Practice Ping tool not found in this build', 'warning');
        break;
      }
      case 'open-script': {
        const btn = document.querySelector('[data-tool="script"], #tool-script');
        if (btn) btn.click();
        else toast('Filter Script tool not found in this build', 'warning');
        break;
      }
      default:
        // Unknown action — just bail quietly
        break;
    }
  } catch (e) {
    // Don't let a broken action take the app down
    console.warn('Tutorial action failed:', key, e);
  }

  // Mark tutorial as seen so we don't relaunch it on next open
  if (bridge && bridge.markTutorialSeen) bridge.markTutorialSeen();
}

function showTutorial() {
  // Reset state for a fresh run
  _currentPages = [TUTORIAL_PATH_PICKER];
  _chosenPath = null;
  _tutorialPage = 0;
  _tutorialMaxReached = 0;
  _renderTutorialPages();
  goTutorialPage(0);
  document.getElementById('tutorial-modal').hidden = false;
}

function finishTutorial() {
  document.getElementById('tutorial-modal').hidden = true;
  hideSpotlight();
  bridge.markTutorialSeen();
  bridge.playSoundEffect('preset');
  // After a tiny delay (so the close animation reads), show the
  // changelog next — first-time users get the full intro: tutorial
  // first, then "here's everything in the app" update log second.
  setTimeout(() => {
    bridge.getOnboardingState().then((raw) => {
      let s = {};
      try { s = JSON.parse(raw || '{}'); } catch {}
      if (s.mode === 'changelog') {
        showChangelog(s.current_version, s.last_seen_version);
      }
    });
  }, 280);
}

// ---- Changelog modal --------------------------------------------------
function setupChangelog() {
  const dismiss = document.getElementById('changelog-dismiss');
  const closeBtn = document.getElementById('changelog-close');
  const onClose = () => {
    document.getElementById('changelog-modal').hidden = true;
    bridge.markVersionSeen();
  };
  if (dismiss) dismiss.addEventListener('click', onClose);
  if (closeBtn) closeBtn.addEventListener('click', onClose);
}

function _parseVersionTuple(v) {
  // "2.6.0" → [2, 6, 0]. Returns [0,0,0] for empty/invalid.
  if (!v || typeof v !== 'string') return [0, 0, 0];
  const parts = v.replace(/^v/i, '').split('.').slice(0, 3);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = parseInt(parts[i], 10);
    out.push(isFinite(n) ? n : 0);
  }
  return out;
}
function _compareVersions(a, b) {
  // Returns negative if a < b, 0 if equal, positive if a > b
  const ta = _parseVersionTuple(a), tb = _parseVersionTuple(b);
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return 0;
}

function showChangelog(currentVersion, lastSeenVersion) {
  bridge.getChangelog().then((raw) => {
    let entries = [];
    try { entries = JSON.parse(raw || '[]'); } catch {}
    // Header line — clearer wording, sanity-check the version state so weird
    // settings (downgrade, stale last_seen, partial install) don't produce
    // nonsensical "you were on a newer version" text.
    const lineEl = document.getElementById('changelog-version-line');
    if (lineEl) {
      const cmp = _compareVersions(lastSeenVersion, currentVersion);
      const cur = escapeHtml(currentVersion);
      const last = escapeHtml(lastSeenVersion || '');
      if (!lastSeenVersion) {
        // First-time user — just finished the tutorial
        lineEl.innerHTML = `Welcome to <strong>v${cur}</strong>. Here's everything that's in this version:`;
      } else if (cmp < 0) {
        // Normal case: upgraded from older to newer
        lineEl.innerHTML = `Updated from <strong>v${last}</strong> to <strong>v${cur}</strong>. Here's what's new:`;
      } else if (cmp > 0) {
        // Downgrade (or stale settings from a future build) — don't pretend
        // we know what they were on, just confirm the current version
        lineEl.innerHTML = `You're now on <strong>v${cur}</strong>. Here's the changelog for this version:`;
      } else {
        // Equal — shouldn't happen since the modal only fires on mismatch,
        // but handle it gracefully just in case
        lineEl.innerHTML = `You're on <strong>v${cur}</strong>.`;
      }
    }
    // Build version blocks
    const list = document.getElementById('changelog-list');
    list.innerHTML = '';
    // v3.0.4 — older versions collapse by default. Only the current version
    // (and the previously-seen-on version, if any) start expanded. Cuts the
    // visual overwhelm — users see what's NEW without 142 lines of history.
    entries.forEach((entry, idx) => {
      const isCurrent = entry.version === currentVersion;
      const isPrevSeen = lastSeenVersion && entry.version === lastSeenVersion;
      const block = document.createElement('div');
      const expanded = isCurrent || isPrevSeen || idx === 0;
      block.className = 'cl-version'
                      + (isCurrent ? ' is-current' : '')
                      + (expanded ? ' is-expanded' : ' is-collapsed');
      const items = (entry.changes || []).map(line => {
        // Detect leading tag prefix like "NEW · ..." → tag + label
        const m = line.match(/^(NEW|FIXED|REMOVED|RENAMED|POLISH)\s*·\s*(.+)$/i);
        const tag = m ? m[1].toUpperCase() : 'OTHER';
        const text = m ? m[2] : line;
        return `<li data-tag="${tag}">${escapeHtml(text)}</li>`;
      }).join('');
      const itemCount = (entry.changes || []).length;
      block.innerHTML = `
        <div class="cl-head" role="button" tabindex="0">
          <div class="cl-ver">
            <span class="cl-chevron">▾</span>
            <span class="cl-vchip">v${escapeHtml(entry.version)}</span>
            <span class="cl-title">${escapeHtml(entry.title || '')}</span>
          </div>
          <span class="cl-date">${escapeHtml(entry.date || '')} · ${itemCount} change${itemCount === 1 ? '' : 's'}</span>
        </div>
        <ul class="cl-changes">${items}</ul>`;
      // Click header toggles expanded state
      const head = block.querySelector('.cl-head');
      head.addEventListener('click', () => {
        block.classList.toggle('is-expanded');
        block.classList.toggle('is-collapsed');
      });
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          head.click();
        }
      });
      list.appendChild(block);
    });
    document.getElementById('changelog-modal').hidden = false;
  });
}

// Decide which (if any) onboarding modal to show, after init
function runOnboarding() {
  bridge.getOnboardingState().then((raw) => {
    let s = {};
    try { s = JSON.parse(raw || '{}'); } catch {}
    if (s.mode === 'tutorial') {
      // Slight delay so the splash transition finishes first
      setTimeout(showTutorial, 350);
    } else if (s.mode === 'changelog') {
      setTimeout(() => showChangelog(s.current_version, s.last_seen_version), 350);
    }
  });
}



// ============================================================
// AUTO-UPDATE — GitHub release check, modal prompt, Info tab
// ============================================================
//
// Flow:
//  1. App startup → backend kicks off background GitHub /releases/latest fetch
//  2. After main UI init + 1.5s delay → checkForUpdatePrompt() runs
//  3. If a newer version is available AND the user hasn't dismissed THIS
//     specific version → show the update modal
//  4. User clicks Yes → applyUpdate() → backend downloads + spawns helper
//     batch → app exits → batch swaps files → relaunches new version
//  5. New version sees last_seen_version != __version__ and shows the
//     existing changelog modal automatically — that's the "what's new"
//     post-update screen
//  6. User clicks Not now → backend records dismissed_update_version →
//     modal closes → Info tab gets a "!" badge until they update or a
//     newer release arrives

let _lastUpdateState = null;   // cached so the Info tab can render without
                               // re-hitting the bridge every time

// ============================================================
// v2.5.1 — Update progress bar driver
// ============================================================
// Translates the rich updateStatus payload (bytes_done, bytes_total,
// speed_bps, eta_seconds) into the visible bar + meta line.
// ============================================================
function _fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  if (b < 1024) return Math.round(b) + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function _fmtSpeed(bps) {
  if (!bps || bps < 0) return '0 KB/s';
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
}
function _fmtEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '—';
  if (seconds < 60) return '~' + Math.ceil(seconds) + 's remaining';
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds - m * 60);
  return `~${m}m ${s}s remaining`;
}

function _setProgress(s) {
  const phaseEl = document.getElementById('update-progress-phase');
  const pctEl   = document.getElementById('update-progress-pct');
  const fillEl  = document.getElementById('update-progress-fill');
  const metaEl  = document.getElementById('update-progress-meta');
  if (!phaseEl || !fillEl) return;

  // Phase label
  const phaseLabels = {
    starting:    'Starting',
    downloading: 'Downloading',
    extracting:  'Extracting',
    preparing:   'Preparing',
    ready:       'Restarting',
  };
  phaseEl.textContent = (phaseLabels[s.phase] || s.phase || 'Working').toUpperCase();

  // Determinate vs indeterminate based on whether we have byte totals
  const hasBytes = s.phase === 'downloading' && s.bytes_total > 0;

  if (hasBytes) {
    const pct = Math.max(0, Math.min(100, (s.bytes_done / s.bytes_total) * 100));
    fillEl.classList.remove('is-indeterminate');
    fillEl.style.width = pct.toFixed(1) + '%';
    if (pctEl) pctEl.textContent = pct.toFixed(0) + '%';
    if (metaEl) {
      metaEl.textContent =
        `${_fmtBytes(s.bytes_done)} / ${_fmtBytes(s.bytes_total)}` +
        `  ·  ${_fmtSpeed(s.speed_bps)}` +
        `  ·  ${_fmtEta(s.eta_seconds)}`;
    }
  } else if (s.phase === 'ready') {
    fillEl.classList.remove('is-indeterminate');
    fillEl.style.width = '100%';
    if (pctEl) pctEl.textContent = '✓';
    if (metaEl) metaEl.textContent = 'Files installed — restarting Throttlr…';
  } else {
    // No byte info → show indeterminate animation (extracting, preparing, etc.)
    fillEl.classList.add('is-indeterminate');
    if (pctEl) pctEl.textContent = '';
    if (metaEl) metaEl.textContent = s.message || 'Working…';
  }
}

function setupUpdateModal() {
  const dismiss = document.getElementById('update-dismiss');
  const closeBtn = document.getElementById('update-close');
  const apply = document.getElementById('update-apply');

  const closeModal = () => {
    document.getElementById('update-modal').hidden = true;
  };

  const onDismiss = () => {
    if (_lastUpdateState && _lastUpdateState.latest) {
      bridge.dismissUpdate(_lastUpdateState.latest);
    }
    closeModal();
    refreshInfoTab();   // updates the "!" badge state
  };

  if (dismiss) dismiss.addEventListener('click', onDismiss);
  if (closeBtn) closeBtn.addEventListener('click', onDismiss);

  if (apply) apply.addEventListener('click', () => {
    // Fire-and-forget — applyUpdate returns immediately, work happens in
    // a background thread. Progress comes via the updateStatus signal.
    apply.disabled = true;
    apply.textContent = 'Starting…';
    if (dismiss) dismiss.disabled = true;
    // v2.5.1 — lock the modal so close/dismiss can't interrupt the install
    const modal = document.getElementById('update-modal');
    if (modal) modal.dataset.updateLocked = '1';
    // Show the progress UI
    const progWrap = document.getElementById('update-progress-wrap');
    if (progWrap) progWrap.hidden = false;
    _setProgress({ phase: 'starting', message: 'Starting…' });
    try {
      bridge.applyUpdate();
    } catch (e) {
      apply.disabled = false;
      apply.textContent = 'Yes, update now';
      if (dismiss) dismiss.disabled = false;
      if (modal) modal.dataset.updateLocked = '';
      if (progWrap) progWrap.hidden = true;
      toast('Update error: ' + e, 'error');
    }
  });

  // Listen for backend progress/result of the update operation
  if (bridge.updateStatus && bridge.updateStatus.connect) {
    bridge.updateStatus.connect((raw) => {
      let s = {};
      try { s = JSON.parse(raw || '{}'); } catch {}

      if (s.phase === 'ready' && s.ok) {
        // Files are downloaded, helper batch is running. Quit so it can swap.
        if (apply) apply.textContent = s.message || 'Restarting…';
        _setProgress({ phase: 'ready', message: s.message || 'Restarting…' });
        setTimeout(() => { bridge.quitForUpdate(); }, 600);
      } else if (s.phase === 'error') {
        if (apply) {
          apply.disabled = false;
          apply.textContent = 'Yes, update now';
        }
        if (dismiss) dismiss.disabled = false;
        const modal = document.getElementById('update-modal');
        if (modal) modal.dataset.updateLocked = '';
        const progWrap = document.getElementById('update-progress-wrap');
        if (progWrap) progWrap.hidden = true;
        toast('Update failed: ' + (s.error || 'unknown error'), 'error');
      } else {
        // starting / downloading / extracting / preparing — drive the UI
        if (apply) apply.textContent = 'Working…';
        _setProgress(s);
      }
    });
  }

  // Settings → Info tab buttons
  const recheck = document.getElementById('info-recheck-btn');
  if (recheck) recheck.addEventListener('click', () => {
    bridge.recheckUpdate();
    recheck.classList.add('is-checking');
    recheck.disabled = true;
    const labelEl = recheck.querySelector('.btn-check-label');
    const oldLabel = labelEl ? labelEl.textContent : '';
    if (labelEl) labelEl.textContent = 'Checking GitHub…';

    // Poll a few times — the result lands when the background thread finishes
    let tries = 0;
    const poll = () => {
      tries++;
      refreshInfoTab().then((s) => {
        if (s && s.checked) {
          // Done — reset the button
          recheck.classList.remove('is-checking');
          recheck.disabled = false;
          if (labelEl) labelEl.textContent = oldLabel || 'Check for updates';
          return;
        }
        if (tries < 12) {
          setTimeout(poll, 500);
        } else {
          // Gave up
          recheck.classList.remove('is-checking');
          recheck.disabled = false;
          if (labelEl) labelEl.textContent = oldLabel || 'Check for updates';
        }
      });
    };
    setTimeout(poll, 600);
  });

  const updateNowFromInfo = document.getElementById('info-update-now-btn');
  if (updateNowFromInfo) updateNowFromInfo.addEventListener('click', () => {
    document.getElementById('settings-modal').hidden = true;
    showUpdateModal();
  });

  // v3.1.1 — Update banner Install button uses the same handler
  const bannerInstall = document.getElementById('iub-install-btn');
  if (bannerInstall) bannerInstall.addEventListener('click', () => {
    document.getElementById('settings-modal').hidden = true;
    showUpdateModal();
  });

  const showCl = document.getElementById('info-show-changelog-btn');
  if (showCl) showCl.addEventListener('click', () => {
    document.getElementById('settings-modal').hidden = true;
    bridge.getCurrentVersion().then((v) => {
      showChangelog(v, '');
    });
  });

  // v3.1.0 — Replay first-run tour from Settings → Info
  const replayTour = document.getElementById('info-replay-tour-btn');
  if (replayTour) replayTour.addEventListener('click', () => {
    document.getElementById('settings-modal').hidden = true;
    // Tiny delay so the settings-close animation reads before the tour opens
    setTimeout(() => { showTutorial(); }, 200);
  });

  // v3.1.1 — Donation button. Opens Billy's Ko-fi page in the default
  // browser. Routed through bridge.openExternalUrl which allowlists
  // the destination so this can't be hijacked to open arbitrary URLs.
  // v3.1.1 — Shared donate handler. Both the Info-tab donate button AND
  // the header "Buy me a coffee" button delegate to this so behaviour
  // stays in sync if it ever changes.
  function _openDonatePage() {
    if (bridge.openExternalUrl) {
      bridge.openExternalUrl('https://ko-fi.com/billysmatrix').then((ok) => {
        if (!ok) {
          toast("Couldn't open the donation page — check your default browser settings", 'error');
        }
      });
    } else {
      // Fallback for old bridge versions — shouldn't happen since both
      // shipped together, but defensive code costs nothing.
      toast('Donation feature requires Throttlr 3.1.1 or later', 'error');
    }
  }

  const donateBtn = document.getElementById('info-donate-btn');
  if (donateBtn) donateBtn.addEventListener('click', _openDonatePage);

  // v3.1.1 — Header donate button (next to Settings). Same destination,
  // same allowlist, same fallback handling — just a second entry point
  // for users who don't think to look in Settings → Info.
  const headerDonateBtn = document.getElementById('header-donate-btn');
  if (headerDonateBtn) headerDonateBtn.addEventListener('click', _openDonatePage);

  // v3.1.3 — Feedback button. Opens the feedback form on the public site
  // in the user's default browser. Routed through the same allowlisted
  // bridge slot the donate button uses; the feedback URL is allowlisted
  // in throttlr.py so this can't be hijacked to open arbitrary URLs.
  function _openFeedbackPage() {
    if (bridge.openExternalUrl) {
      bridge.openExternalUrl('https://throttlr.netlify.app/feedback.html').then((ok) => {
        if (!ok) {
          toast("Couldn't open the feedback page — check your default browser settings", 'error');
        }
      });
    } else {
      toast('Feedback feature requires Throttlr 3.1.3 or later', 'error');
    }
  }
  const infoFeedbackBtn = document.getElementById('info-feedback-btn');
  if (infoFeedbackBtn) infoFeedbackBtn.addEventListener('click', _openFeedbackPage);
  const headerFeedbackBtn = document.getElementById('header-feedback-btn');
  if (headerFeedbackBtn) headerFeedbackBtn.addEventListener('click', _openFeedbackPage);

  // When the user opens the settings modal, refresh the Info tab data so
  // it always reflects the current state of the GitHub check
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => setTimeout(refreshInfoTab, 100));
  }
}

function checkForUpdatePrompt() {
  // Don't double-show on top of the tutorial/changelog modal — wait until
  // they're closed, then show ours
  const tut = document.getElementById('tutorial-modal');
  const cl = document.getElementById('changelog-modal');
  if ((tut && !tut.hidden) || (cl && !cl.hidden)) {
    setTimeout(checkForUpdatePrompt, 800);
    return;
  }

  bridge.getUpdateInfo().then((raw) => {
    let s = {};
    try { s = JSON.parse(raw || '{}'); } catch {}
    _lastUpdateState = s;
    if (s.should_prompt) {
      showUpdateModal();
    }
    refreshInfoTab();
  });
}

function showUpdateModal() {
  if (!_lastUpdateState) return;
  const s = _lastUpdateState;

  const cur = document.getElementById('update-current-version');
  const latest = document.getElementById('update-latest-version');
  if (cur) cur.textContent = 'v' + (s.current || '').replace(/^v/i, '');
  if (latest) latest.textContent = (s.latest || '').match(/^v/i)
                                    ? s.latest
                                    : 'v' + (s.latest || '');

  const notesWrap = document.getElementById('update-notes-wrap');
  const notes = document.getElementById('update-notes');
  if (notesWrap && notes) {
    if (s.body && s.body.trim()) {
      notes.textContent = s.body.trim();
      notesWrap.hidden = false;
    } else {
      notesWrap.hidden = true;
    }
  }

  // Reset button states (in case modal was previously opened during a failed apply)
  const apply = document.getElementById('update-apply');
  const dismiss = document.getElementById('update-dismiss');
  if (apply) { apply.disabled = false; apply.textContent = 'Yes, update now'; }
  if (dismiss) dismiss.disabled = false;

  // v2.5.1 — reset progress UI + unlock modal in case prior session left it locked
  const modal = document.getElementById('update-modal');
  if (modal) modal.dataset.updateLocked = '';
  const progWrap = document.getElementById('update-progress-wrap');
  if (progWrap) progWrap.hidden = true;
  const fillEl = document.getElementById('update-progress-fill');
  if (fillEl) { fillEl.classList.remove('is-indeterminate'); fillEl.style.width = '0%'; }
  const pctEl = document.getElementById('update-progress-pct');
  if (pctEl) pctEl.textContent = '0%';

  document.getElementById('update-modal').hidden = false;
}

function refreshInfoTab() {
  // Populate version pill + status pill (top hero block)
  return bridge.getUpdateInfo().then((raw) => {
    let s = {};
    try { s = JSON.parse(raw || '{}'); } catch {}
    _lastUpdateState = s;

    // Hero — current version
    const curEl = document.getElementById('info-current-version');
    if (curEl) curEl.textContent = 'v' + (s.current || '').replace(/^v/i, '');

    // Hero — status pill (color-coded)
    const pill = document.getElementById('info-status-pill');
    const pillText = document.getElementById('info-status-text');
    if (pill && pillText) {
      let state = 'ok';
      let text = 'up to date';
      if (s.error) {
        state = 'error';
        text = 'check failed';
        pill.title = s.error;
      } else if (!s.checked) {
        state = 'unknown';
        text = 'checking…';
        pill.removeAttribute('title');
      } else if (s.available) {
        state = 'update';
        text = (s.dismissed_version === s.latest) ? 'update dismissed' : 'update available';
        pill.removeAttribute('title');
      } else {
        pill.removeAttribute('title');
      }
      pill.setAttribute('data-state', state);
      pillText.textContent = text;
    }

    // v3.1.1 — Prominent update banner above the hero. Only visible
    // when an update is genuinely available and the user hasn't
    // dismissed THIS specific version. Loud, unmissable, contrasts
    // hard with the "up to date" green state.
    const banner = document.getElementById('info-update-banner');
    if (banner) {
      const shouldShow = !!s.available
                      && !s.error
                      && s.checked
                      && s.dismissed_version !== s.latest;
      banner.hidden = !shouldShow;
      if (shouldShow) {
        const vEl = document.getElementById('iub-version');
        if (vEl && s.latest) {
          vEl.textContent = (s.latest.match(/^v/i) ? s.latest : 'v' + s.latest);
        }
      }
    }

    // Latest version row
    const latestEl = document.getElementById('info-latest-version');
    if (latestEl) {
      if (s.error) {
        latestEl.textContent = 'check failed';
        latestEl.className = 'info-val is-error';
        latestEl.title = s.error;
      } else if (!s.checked) {
        latestEl.textContent = 'checking…';
        latestEl.className = 'info-val';
        latestEl.removeAttribute('title');
      } else if (s.latest) {
        const tag = (s.latest.match(/^v/i) ? s.latest : 'v' + s.latest);
        latestEl.textContent = tag;
        latestEl.className = 'info-val' + (s.available ? ' is-new' : '');
        latestEl.removeAttribute('title');
      } else {
        latestEl.textContent = '—';
        latestEl.className = 'info-val';
        latestEl.removeAttribute('title');
      }
    }

    // Last-checked timestamp ("just now", "2 minutes ago", etc.)
    const lastEl = document.getElementById('info-last-checked');
    if (lastEl) {
      if (!s.checked_at) {
        lastEl.textContent = 'never';
      } else {
        lastEl.textContent = formatRelativeTime(s.checked_at);
      }
    }

    // Show "Install update" button + tab badge only if an update is available
    const badge = document.getElementById('info-tab-badge');
    const installBtn = document.getElementById('info-update-now-btn');
    const showBadge = !!s.available;
    if (badge) badge.hidden = !showBadge;
    if (installBtn) installBtn.hidden = !showBadge;

    // Refresh system info too (independent — won't change often)
    refreshSystemInfo();

    return s;
  });
}

function refreshSystemInfo() {
  if (!bridge.getSystemInfo) return;   // older backend without the slot
  bridge.getSystemInfo().then((raw) => {
    let sys = {};
    try { sys = JSON.parse(raw || '{}'); } catch {}

    // Platform — Windows version string
    const platEl = document.getElementById('info-sys-platform');
    if (platEl) platEl.textContent = sys.windows || 'unknown';

    // CPU — architecture · cores · GHz (v3.0.9)
    const cpuEl = document.getElementById('info-sys-cpu');
    if (cpuEl) cpuEl.textContent = sys.cpu || 'unknown';

    // Memory — total RAM in GB (v3.0.9)
    const ramEl = document.getElementById('info-sys-ram');
    if (ramEl) ramEl.textContent = sys.ram || 'unknown';

    // Hostname — local machine name (v3.0.9)
    const hostEl = document.getElementById('info-sys-hostname');
    if (hostEl) hostEl.textContent = sys.hostname || 'unknown';

    // Network adapter count — interfaces currently up, loopback excluded (v3.0.9)
    const adapterEl = document.getElementById('info-sys-adapters');
    if (adapterEl) {
      const n = typeof sys.adapters === 'number' ? sys.adapters : null;
      adapterEl.textContent = (n === null) ? 'unknown' :
                              (n === 1) ? '1 active' : (n + ' active');
    }

    // Privileges — admin status with colored dot
    const adminText = document.getElementById('info-sys-admin-text');
    const adminDot = document.querySelector('#info-sys-admin .info-status-dot');
    if (adminText && adminDot) {
      if (sys.admin) {
        adminText.textContent = 'Administrator';
        adminDot.setAttribute('data-status', 'ok');
      } else {
        adminText.textContent = 'Limited (no admin)';
        adminDot.setAttribute('data-status', 'error');
      }
    }

    // WinDivert — driver status
    const pdText = document.getElementById('info-sys-pydivert-text');
    const pdDot = document.querySelector('#info-sys-pydivert .info-status-dot');
    if (pdText && pdDot) {
      if (sys.pydivert) {
        pdText.textContent = 'Loaded';
        pdDot.setAttribute('data-status', 'ok');
      } else {
        pdText.textContent = 'Missing';
        pdDot.setAttribute('data-status', 'error');
        if (sys.pydivert_err) pdText.title = sys.pydivert_err;
      }
    }

    // Engine state
    const engText = document.getElementById('info-sys-engine-text');
    const engDot = document.querySelector('#info-sys-engine .info-status-dot');
    if (engText && engDot) {
      if (sys.engine === 'running') {
        engText.textContent = 'Running';
        engDot.setAttribute('data-status', 'active');
      } else {
        engText.textContent = 'Idle';
        engDot.setAttribute('data-status', 'ok');
      }
    }

    // Throttlr build — compiled .exe vs python script (v3.0.9)
    const buildEl = document.getElementById('info-sys-build');
    if (buildEl) buildEl.textContent = sys.build || 'unknown';

    // Python runtime — version string (v3.0.9)
    const pyEl = document.getElementById('info-sys-python');
    if (pyEl) pyEl.textContent = sys.python || 'unknown';
  });

  // v3.1.0 — WinDivert filter preview (read-only)
  // Fired alongside the system info refresh; uses its own slot since the
  // payload is plain text not JSON. Older backends won't have it — graceful.
  const filterEl = document.getElementById('info-sys-filter');
  if (filterEl && bridge.getFilterPreview) {
    bridge.getFilterPreview().then((txt) => {
      filterEl.textContent = txt || '(empty)';
    }).catch(() => {
      filterEl.textContent = '(unavailable)';
    });
  }
}

// "23 seconds ago" / "5 minutes ago" / "2 hours ago" — used for last-checked
function formatRelativeTime(unixSeconds) {
  if (!unixSeconds) return 'never';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 5)     return 'just now';
  if (diff < 60)    return diff + ' seconds ago';
  if (diff < 3600)  { const m = Math.floor(diff / 60); return m + (m === 1 ? ' minute ago' : ' minutes ago'); }
  if (diff < 86400) { const h = Math.floor(diff / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
  const d = Math.floor(diff / 86400);
  return d + (d === 1 ? ' day ago' : ' days ago');
}


// ============================================================
// PHASE 1 (v2.4.0) — Profile import/export + drag-drop
// ============================================================

function setupProfileTab() {
  const exportBtn = document.getElementById('profile-export-btn');
  const importBtn = document.getElementById('profile-import-btn');

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      bridge.saveProfileToFile().then((raw) => {
        let r = {};
        try { r = JSON.parse(raw || '{}'); } catch {}
        if (r.cancelled) return;   // user clicked Cancel — silent
        if (r.ok) {
          // Show only the filename, not the full path (cleaner toast)
          const filename = (r.path || '').split(/[\\/]/).pop() || 'profile';
          toast(`Profile exported → ${filename}`, 'success');
        } else {
          toast('Export failed: ' + (r.error || 'unknown error'), 'error');
        }
      });
    });
  }

  if (importBtn) {
    importBtn.addEventListener('click', () => {
      bridge.loadProfileFromFile().then((raw) => {
        let r = {};
        try { r = JSON.parse(raw || '{}'); } catch {}
        if (r.cancelled) return;
        handleProfileImportResult(r);
      });
    });
  }
}

function handleProfileImportResult(r) {
  if (!r) return;
  if (r.ok) {
    const name = r.name || 'Throttlr Profile';
    toast(`Imported profile: ${name}`, 'success');
    // Reload settings + config so everything reflects the new state
    setTimeout(() => {
      try { bridge.getSettings && bridge.getSettings().then((s) => applySettings(JSON.parse(s))); } catch {}
      try { bridge.getConfig && bridge.getConfig().then((c) => applyProfileData(JSON.parse(c))); } catch {}
    }, 50);
  } else {
    toast('Import failed: ' + (r.error || 'unknown error'), 'error');
  }
}

// ============================================================
// Drag-drop .throttlr files onto the window
// ============================================================
function setupProfileDragDrop() {
  const overlay = document.getElementById('profile-drop-overlay');
  let dragDepth = 0;   // tracks nested dragenter/dragleave so overlay
                       // doesn't flicker when dragging over child elements

  function isThrottlrFile(items) {
    if (!items) return false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // During dragenter we only have item.kind ('file') and item.type
      // (might be empty for unknown extensions). Always allow files —
      // we'll filter properly on drop.
      if (item.kind === 'file') return true;
    }
    return false;
  }

  window.addEventListener('dragenter', (e) => {
    if (!isThrottlrFile(e.dataTransfer && e.dataTransfer.items)) return;
    e.preventDefault();
    dragDepth++;
    if (overlay) overlay.classList.add('is-active');
  });

  window.addEventListener('dragover', (e) => {
    if (!isThrottlrFile(e.dataTransfer && e.dataTransfer.items)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isThrottlrFile(e.dataTransfer && e.dataTransfer.items)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.classList.remove('is-active');
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.classList.remove('is-active');

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;

    const file = files[0];
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.throttlr') && !name.endsWith('.json')) {
      toast(`Not a Throttlr profile: ${file.name}`, 'error');
      return;
    }

    // Read the file via FileReader (HTML5 API), pass content directly to backend
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const content = ev.target.result;
        bridge.importProfileJson(content).then((raw) => {
          let r = {};
          try { r = JSON.parse(raw || '{}'); } catch {}
          handleProfileImportResult(r);
        });
      } catch (err) {
        toast('Failed to read file: ' + err, 'error');
      }
    };
    reader.onerror = () => toast('Could not read file', 'error');
    reader.readAsText(file);
  });
}


// ============================================================
// PHASE 1 (v2.4.0) — Bandwidth readouts (peak / average / current)
// ============================================================
//
// Tracks per-session peak and rolling average for inbound and outbound
// bandwidth. Updated each time onStatsChanged fires (~5x per second).
// User can reset peak/average via the ↻ button.

let _bwPeakIn = 0;
let _bwPeakOut = 0;
let _bwSumIn = 0;
let _bwSumOut = 0;
let _bwSamples = 0;

function updateBandwidthReadouts(bwIn, bwOut) {
  const lastIn = bwIn.length ? bwIn[bwIn.length - 1] : 0;
  const lastOut = bwOut.length ? bwOut[bwOut.length - 1] : 0;

  if (lastIn > _bwPeakIn) _bwPeakIn = lastIn;
  if (lastOut > _bwPeakOut) _bwPeakOut = lastOut;

  // Only count toward average if there's actually traffic (avoids huge
  // sample counts of zero diluting the real average)
  if (lastIn > 0 || lastOut > 0) {
    _bwSumIn += lastIn;
    _bwSumOut += lastOut;
    _bwSamples++;
  }

  const avgIn = _bwSamples > 0 ? _bwSumIn / _bwSamples : 0;
  const avgOut = _bwSamples > 0 ? _bwSumOut / _bwSamples : 0;

  setBwReadout('bw-readout-in-cur',   lastIn);
  setBwReadout('bw-readout-out-cur',  lastOut);
  setBwReadout('bw-readout-in-peak',  _bwPeakIn);
  setBwReadout('bw-readout-out-peak', _bwPeakOut);
  setBwReadout('bw-readout-in-avg',   avgIn);
  setBwReadout('bw-readout-out-avg',  avgOut);

  // Y-axis label — max value seen across both series in the live graph
  const all = [...bwIn, ...bwOut];
  const graphMax = all.length ? Math.max(1024, ...all) : 1024;
  const axisEl = document.getElementById('bw-axis-max');
  if (axisEl) axisEl.textContent = formatBytesPerSec(graphMax) + ' max';
}

function setBwReadout(elId, value) {
  const el = document.getElementById(elId);
  if (el) el.textContent = formatBytesPerSec(value);
}

function formatBytesPerSec(bytes) {
  if (!bytes || bytes < 1) return '0 KB/s';
  if (bytes < 1024) return bytes + ' B/s';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB/s';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB/s';
}

function setupBandwidthReadouts() {
  const resetBtn = document.getElementById('bw-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      _bwPeakIn = 0;
      _bwPeakOut = 0;
      _bwSumIn = 0;
      _bwSumOut = 0;
      _bwSamples = 0;
      // Clear displayed values
      ['bw-readout-in-cur','bw-readout-out-cur',
       'bw-readout-in-peak','bw-readout-out-peak',
       'bw-readout-in-avg','bw-readout-out-avg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '0 KB/s';
      });
      toast('Peak / average reset', 'success');
    });
  }
}

// Hook into the existing onStatsChanged flow — patch in our readouts
// without breaking the existing drawTrafficGraph call. We do this by
// calling updateBandwidthReadouts each time stats arrive.
const _origOnStatsChanged_v240 = typeof onStatsChanged === 'function' ? onStatsChanged : null;
if (_origOnStatsChanged_v240) {
  // Wrap: call original, then update readouts using the global bwIn/bwOut
  window.onStatsChanged = function (json) {
    _origOnStatsChanged_v240(json);
    try {
      // bwIn / bwOut are global vars set inside the original handler
      updateBandwidthReadouts(bwIn || [], bwOut || []);
    } catch (e) { /* swallow */ }
  };
  // Re-bind the bridge signal to the wrapped function
  try {
    if (bridge && bridge.statsChanged && bridge.statsChanged.disconnect) {
      bridge.statsChanged.disconnect(_origOnStatsChanged_v240);
      bridge.statsChanged.connect(window.onStatsChanged);
    }
  } catch (e) { /* swallow — fallback below handles it */ }
}

// Initialize the new Phase 1 UI on DOM ready
(function initPhase1() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupProfileTab();
      setupProfileDragDrop();
      setupBandwidthReadouts();
    });
  } else {
    setupProfileTab();
    setupProfileDragDrop();
    setupBandwidthReadouts();
  }
})();


// ============================================================
// v2.5.0 — Phase 2 — Connection Geo Map
// ============================================================
//
// Embeds a simplified world map (continent outlines as SVG paths) and
// plots the targeted app's connections at the country center coordinates
// using equirectangular projection. Updates live as connections come and
// go, with hover tooltips showing per-connection details.

// Map projection: equirectangular. ViewBox is 1000x500 so:
//   x = (lon + 180) / 360 * 1000
//   y = (90 - lat) / 180 * 500
function geoProject(lat, lon) {
  const x = ((lon + 180) / 360) * 1000;
  const y = ((90 - lat) / 180) * 500;
  return { x, y };
}

// ============================================================
// Country code → approximate center [lat, lon].
// 250 entries covering effectively all geo-IP results we'll see.
// Format: 2-letter ISO code → [lat, lon].
// ============================================================
const COUNTRY_COORDS = {
  AD: [42.5, 1.5], AE: [24.0, 54.0], AF: [33.0, 65.0], AG: [17.05, -61.8], AI: [18.25, -63.17],
  AL: [41.0, 20.0], AM: [40.0, 45.0], AO: [-12.5, 18.5], AR: [-34.0, -64.0], AS: [-14.33, -170.0],
  AT: [47.33, 13.33], AU: [-27.0, 133.0], AW: [12.5, -69.97], AX: [60.12, 19.92], AZ: [40.5, 47.5],
  BA: [44.0, 18.0], BB: [13.17, -59.53], BD: [24.0, 90.0], BE: [50.83, 4.0], BF: [13.0, -2.0],
  BG: [43.0, 25.0], BH: [26.0, 50.55], BI: [-3.5, 30.0], BJ: [9.5, 2.25], BL: [17.9, -62.83],
  BM: [32.33, -64.75], BN: [4.5, 114.67], BO: [-17.0, -65.0], BQ: [12.18, -68.23], BR: [-10.0, -55.0],
  BS: [24.25, -76.0], BT: [27.5, 90.5], BV: [-54.43, 3.4], BW: [-22.0, 24.0], BY: [53.0, 28.0],
  BZ: [17.25, -88.75], CA: [60.0, -95.0], CC: [-12.5, 96.83], CD: [0.0, 25.0], CF: [7.0, 21.0],
  CG: [-1.0, 15.0], CH: [47.0, 8.0], CI: [8.0, -5.0], CK: [-21.23, -159.77], CL: [-30.0, -71.0],
  CM: [6.0, 12.0], CN: [35.0, 105.0], CO: [4.0, -72.0], CR: [10.0, -84.0], CU: [21.5, -80.0],
  CV: [16.0, -24.0], CW: [12.17, -69.0], CX: [-10.5, 105.67], CY: [35.0, 33.0], CZ: [49.75, 15.5],
  DE: [51.0, 9.0], DJ: [11.5, 43.0], DK: [56.0, 10.0], DM: [15.42, -61.33], DO: [19.0, -70.67],
  DZ: [28.0, 3.0], EC: [-2.0, -77.5], EE: [59.0, 26.0], EG: [27.0, 30.0], EH: [24.5, -13.0],
  ER: [15.0, 39.0], ES: [40.0, -4.0], ET: [8.0, 38.0], FI: [64.0, 26.0], FJ: [-18.0, 175.0],
  FK: [-51.75, -59.0], FM: [6.92, 158.25], FO: [62.0, -7.0], FR: [46.0, 2.0], GA: [-1.0, 11.75],
  GB: [54.0, -2.0], GD: [12.12, -61.67], GE: [42.0, 43.5], GF: [4.0, -53.0], GG: [49.47, -2.58],
  GH: [8.0, -2.0], GI: [36.13, -5.35], GL: [72.0, -40.0], GM: [13.47, -16.57], GN: [11.0, -10.0],
  GP: [16.25, -61.58], GQ: [2.0, 10.0], GR: [39.0, 22.0], GS: [-54.5, -37.0], GT: [15.5, -90.25],
  GU: [13.47, 144.78], GW: [12.0, -15.0], GY: [5.0, -59.0], HK: [22.25, 114.17], HM: [-53.1, 72.52],
  HN: [15.0, -86.5], HR: [45.17, 15.5], HT: [19.0, -72.42], HU: [47.0, 20.0], ID: [-5.0, 120.0],
  IE: [53.0, -8.0], IL: [31.5, 34.75], IM: [54.23, -4.55], IN: [20.0, 77.0], IO: [-6.0, 71.5],
  IQ: [33.0, 44.0], IR: [32.0, 53.0], IS: [65.0, -18.0], IT: [42.83, 12.83], JE: [49.21, -2.13],
  JM: [18.25, -77.5], JO: [31.0, 36.0], JP: [36.0, 138.0], KE: [1.0, 38.0], KG: [41.0, 75.0],
  KH: [13.0, 105.0], KI: [1.42, 173.0], KM: [-12.17, 44.25], KN: [17.33, -62.75], KP: [40.0, 127.0],
  KR: [37.0, 127.5], KW: [29.34, 47.66], KY: [19.5, -80.5], KZ: [48.0, 68.0], LA: [18.0, 105.0],
  LB: [33.83, 35.83], LC: [13.88, -60.97], LI: [47.27, 9.53], LK: [7.0, 81.0], LR: [6.5, -9.5],
  LS: [-29.5, 28.5], LT: [56.0, 24.0], LU: [49.75, 6.17], LV: [57.0, 25.0], LY: [25.0, 17.0],
  MA: [32.0, -5.0], MC: [43.73, 7.4], MD: [47.0, 29.0], ME: [42.5, 19.3], MF: [18.07, -63.07],
  MG: [-20.0, 47.0], MH: [9.0, 168.0], MK: [41.83, 22.0], ML: [17.0, -4.0], MM: [22.0, 98.0],
  MN: [46.0, 105.0], MO: [22.17, 113.55], MP: [15.2, 145.75], MQ: [14.67, -61.0], MR: [20.0, -12.0],
  MS: [16.75, -62.2], MT: [35.83, 14.58], MU: [-20.28, 57.55], MV: [3.25, 73.0], MW: [-13.5, 34.0],
  MX: [23.0, -102.0], MY: [2.5, 112.5], MZ: [-18.25, 35.0], NA: [-22.0, 17.0], NC: [-21.5, 165.5],
  NE: [16.0, 8.0], NF: [-29.03, 167.95], NG: [10.0, 8.0], NI: [13.0, -85.0], NL: [52.5, 5.75],
  NO: [62.0, 10.0], NP: [28.0, 84.0], NR: [-0.53, 166.92], NU: [-19.03, -169.87], NZ: [-41.0, 174.0],
  OM: [21.0, 57.0], PA: [9.0, -80.0], PE: [-10.0, -76.0], PF: [-15.0, -140.0], PG: [-6.0, 147.0],
  PH: [13.0, 122.0], PK: [30.0, 70.0], PL: [52.0, 20.0], PM: [46.83, -56.33], PN: [-24.7, -127.4],
  PR: [18.25, -66.5], PS: [32.0, 35.25], PT: [39.5, -8.0], PW: [7.5, 134.5], PY: [-23.0, -58.0],
  QA: [25.5, 51.25], RE: [-21.1, 55.6], RO: [46.0, 25.0], RS: [44.0, 21.0], RU: [60.0, 100.0],
  RW: [-2.0, 30.0], SA: [25.0, 45.0], SB: [-8.0, 159.0], SC: [-4.58, 55.67], SD: [15.0, 30.0],
  SE: [62.0, 15.0], SG: [1.37, 103.8], SH: [-15.93, -5.7], SI: [46.0, 15.0], SJ: [78.0, 20.0],
  SK: [48.67, 19.5], SL: [8.5, -11.5], SM: [43.93, 12.42], SN: [14.0, -14.0], SO: [10.0, 49.0],
  SR: [4.0, -56.0], SS: [8.0, 30.0], ST: [1.0, 7.0], SV: [13.83, -88.92], SX: [18.03, -63.05],
  SY: [35.0, 38.0], SZ: [-26.5, 31.5], TC: [21.75, -71.58], TD: [15.0, 19.0], TF: [-49.25, 69.17],
  TG: [8.0, 1.17], TH: [15.0, 100.0], TJ: [39.0, 71.0], TK: [-9.0, -172.0], TL: [-8.55, 125.52],
  TM: [40.0, 60.0], TN: [34.0, 9.0], TO: [-20.0, -175.0], TR: [39.0, 35.0], TT: [11.0, -61.0],
  TV: [-8.0, 178.0], TW: [23.5, 121.0], TZ: [-6.0, 35.0], UA: [49.0, 32.0], UG: [1.0, 32.0],
  UM: [19.28, 166.6], US: [38.0, -97.0], UY: [-33.0, -56.0], UZ: [41.0, 64.0], VA: [41.9, 12.45],
  VC: [13.25, -61.2], VE: [8.0, -66.0], VG: [18.43, -64.62], VI: [18.33, -64.83], VN: [16.17, 107.83],
  VU: [-16.0, 167.0], WF: [-13.3, -176.2], WS: [-13.58, -172.33], YE: [15.0, 48.0], YT: [-12.83, 45.17],
  ZA: [-29.0, 24.0], ZM: [-15.0, 30.0], ZW: [-19.0, 29.5],
};

// ============================================================
// Simplified world map. Continent outlines as SVG path data,
// projected with equirectangular onto the 1000x500 viewBox.
// 24 paths, ~5 KB total. Stylized — recognisable continents,
// no copyrighted source data, just hand-chosen control points.
// ============================================================
const WORLD_MAP_PATHS = [
  // North America
  "M33.3,66.7L66.7,52.8L111.1,55.6L144.4,55.6L194.4,44.4L238.9,44.4L283.3,50.0L311.1,66.7L322.2,83.3L341.7,97.2L347.2,108.3L355.6,119.4L319.4,127.8L305.6,136.1L294.4,138.9L288.9,152.8L277.8,161.1L277.8,177.8L272.2,180.6L252.8,169.4L238.9,169.4L230.6,177.8L230.6,191.7L238.9,200.0L255.6,200.0L258.3,191.7L250.0,191.7L252.8,205.6L266.7,208.3L269.4,216.7L269.4,222.2L286.1,225.0L283.3,227.8L277.8,225.0L258.3,216.7L238.9,208.3L222.2,202.8L205.6,191.7L194.4,186.1L183.3,169.4L175.0,161.1L166.7,155.6L158.3,144.4L155.6,130.6L155.6,119.4L144.4,111.1L133.3,100.0L122.2,88.9L97.2,83.3L83.3,83.3L61.1,88.9L50.0,97.2L44.4,100.0L47.2,83.3L41.7,72.2Z",
  // Greenland
  "M408.3,19.4L438.9,22.2L450.0,33.3L444.4,44.4L438.9,55.6L400.0,69.4L375.0,80.6L355.6,66.7L347.2,50.0L338.9,38.9L319.4,30.6L347.2,22.2L375.0,19.4Z",
  // Cuba
  "M272.2,186.1L283.3,186.1L288.9,191.7L291.7,194.4L286.1,194.4L269.4,188.9Z",
  // Hispaniola
  "M297.2,194.4L311.1,197.2L311.1,200.0L297.2,200.0L297.2,197.2Z",
  // South America
  "M300.0,216.7L308.3,216.7L319.4,222.2L327.8,219.4L333.3,227.8L355.6,236.1L361.1,247.2L400.0,263.9L394.4,283.3L388.9,311.1L366.7,319.4L355.6,338.9L338.9,344.4L327.8,361.1L313.9,377.8L308.3,388.9L311.1,400.0L305.6,402.8L291.7,394.4L291.7,377.8L297.2,366.7L297.2,352.8L302.8,333.3L305.6,313.9L302.8,300.0L286.1,283.3L275.0,263.9L275.0,255.6L277.8,247.2L283.3,233.3L286.1,227.8L288.9,225.0Z",
  // Africa
  "M483.3,147.2L525.0,147.2L530.6,158.3L569.4,163.9L588.9,163.9L588.9,166.7L591.7,169.4L594.4,175.0L600.0,188.9L605.6,200.0L611.1,208.3L619.4,216.7L638.9,222.2L630.6,236.1L613.9,255.6L608.3,269.4L611.1,288.9L591.7,322.2L586.1,333.3L569.4,344.4L550.0,344.4L547.2,330.6L538.9,313.9L533.3,291.7L533.3,266.7L525.0,252.8L525.0,238.9L516.7,238.9L508.3,233.3L500.0,236.1L480.6,238.9L463.9,236.1L455.6,222.2L452.8,208.3L452.8,191.7L463.9,175.0L472.2,166.7L477.8,158.3L483.3,152.8Z",
  // Madagascar
  "M636.1,283.3L638.9,291.7L633.3,311.1L630.6,319.4L622.2,319.4L619.4,308.3L627.8,291.7L633.3,286.1Z",
  // Eurasia
  "M569.4,52.8L583.3,55.6L613.9,63.9L638.9,61.1L666.7,55.6L708.3,47.2L777.8,44.4L791.7,38.9L861.1,47.2L894.4,47.2L922.2,52.8L994.4,55.6L977.8,66.7L986.1,77.8L950.0,83.3L930.6,86.1L894.4,100.0L894.4,119.4L872.2,130.6L861.1,141.7L847.2,141.7L836.1,152.8L836.1,169.4L813.9,186.1L800.0,191.7L802.8,211.1L791.7,222.2L786.1,247.2L775.0,227.8L763.9,205.6L752.8,188.9L738.9,194.4L722.2,216.7L713.9,227.8L702.8,208.3L694.4,188.9L686.1,183.3L666.7,180.6L655.6,177.8L655.6,183.3L663.9,188.9L652.8,202.8L652.8,213.9L625.0,216.7L619.4,211.1L616.7,205.6L608.3,191.7L597.2,172.2L597.2,169.4L591.7,166.7L594.4,163.9L597.2,158.3L600.0,152.8L600.0,150.0L600.0,147.2L613.9,138.9L613.9,133.3L600.0,125.0L583.3,125.0L577.8,127.8L577.8,133.3L577.8,136.1L572.2,138.9L563.9,141.7L561.1,147.2L555.6,141.7L552.8,138.9L544.4,130.6L536.1,125.0L527.8,127.8L519.4,130.6L511.1,130.6L508.3,136.1L500.0,141.7L494.4,147.2L486.1,150.0L475.0,147.2L475.0,130.6L494.4,125.0L486.1,116.7L502.8,111.1L511.1,102.8L522.2,100.0L522.2,91.7L513.9,88.9L513.9,77.8L536.1,66.7L538.9,61.1L555.6,55.6Z",
  // Iceland
  "M438.9,66.7L455.6,66.7L461.1,72.2L447.2,75.0L436.1,72.2Z",
  // Great Britain
  "M491.7,88.9L494.4,88.9L494.4,91.7L497.2,100.0L505.6,105.6L502.8,108.3L497.2,111.1L486.1,111.1L486.1,105.6L491.7,100.0L486.1,97.2L483.3,94.4L483.3,88.9Z",
  // Ireland
  "M477.8,97.2L483.3,100.0L483.3,105.6L472.2,108.3L472.2,102.8Z",
  // Japan
  "M894.4,125.0L905.6,130.6L891.7,136.1L894.4,144.4L888.9,152.8L866.7,158.3L861.1,163.9L861.1,158.3L866.7,152.8L883.3,144.4L888.9,136.1L888.9,133.3L891.7,125.0Z",
  // Taiwan
  "M836.1,180.6L838.9,183.3L836.1,188.9L833.3,188.9L833.3,183.3Z",
  // Philippines
  "M836.1,200.0L838.9,205.6L844.4,216.7L847.2,227.8L847.2,233.3L838.9,222.2L836.1,213.9L833.3,208.3Z",
  // Sri Lanka
  "M722.2,222.2L727.8,227.8L725.0,233.3L722.2,230.6Z",
  // Sumatra
  "M763.9,236.1L772.2,236.1L783.3,252.8L791.7,266.7L777.8,258.3L766.7,244.4Z",
  // Java
  "M791.7,266.7L802.8,269.4L813.9,272.2L819.4,272.2L813.9,269.4L805.6,266.7Z",
  // Borneo
  "M825.0,230.6L830.6,238.9L825.0,252.8L813.9,258.3L805.6,258.3L802.8,247.2L805.6,236.1Z",
  // Sulawesi
  "M833.3,247.2L844.4,244.4L838.9,255.6L830.6,263.9L838.9,263.9L833.3,255.6Z",
  // New Guinea
  "M866.7,252.8L891.7,258.3L902.8,266.7L894.4,275.0L916.7,277.8L908.3,275.0L883.3,269.4L872.2,258.3Z",
  // Australia
  "M866.7,280.6L891.7,283.3L902.8,291.7L908.3,302.8L925.0,319.4L919.4,344.4L916.7,352.8L908.3,358.3L900.0,355.6L888.9,352.8L883.3,347.2L872.2,338.9L855.6,336.1L836.1,341.7L825.0,347.2L819.4,338.9L813.9,322.2L816.7,311.1L830.6,305.6L844.4,297.2L855.6,288.9L863.9,283.3Z",
  // Tasmania
  "M902.8,363.9L911.1,363.9L911.1,369.4L905.6,372.2L900.0,369.4Z",
  // New Zealand North
  "M980.6,344.4L986.1,352.8L994.4,358.3L986.1,363.9L983.3,358.3L983.3,350.0Z",
  // New Zealand South
  "M977.8,363.9L983.3,366.7L969.4,377.8L963.9,377.8L966.7,372.2Z",
];

// State for the geo map — keyed by remote_addr so we can update existing
// dots smoothly rather than redrawing from scratch every refresh.
const _geoState = {
  initialized: false,
  dotsLayer: null,
  tooltip: null,
  emptyEl: null,
  // remote_addr → { dot SVG element, last data, last seen timestamp }
  dots: new Map(),
};

function setupGeoMap() {
  if (_geoState.initialized) return;

  // 1. Inject the world map paths into the <g id="geo-map-land">.
  // v3.0.7 — uses the new WORLD_COUNTRIES dataset (216 countries with proper
  // borders, Natural Earth 50m simplified to ~0.5 viewBox units). Falls back
  // to the legacy WORLD_MAP_PATHS if the data file isn't loaded for some
  // reason. Also draws US state borders as a top layer.
  const landLayer = document.getElementById('geo-map-land');
  const statesLayer = document.getElementById('geo-map-states');
  if (landLayer && !landLayer.children.length) {
    const svgNS = 'http://www.w3.org/2000/svg';
    if (typeof WORLD_COUNTRIES !== 'undefined' && Array.isArray(WORLD_COUNTRIES)) {
      WORLD_COUNTRIES.forEach(c => {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', c.d);
        path.setAttribute('data-name', c.n);
        landLayer.appendChild(path);
      });
    } else if (typeof WORLD_MAP_PATHS !== 'undefined') {
      // Legacy fallback
      WORLD_MAP_PATHS.forEach(d => {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', d);
        landLayer.appendChild(path);
      });
    }
  }
  if (statesLayer && !statesLayer.children.length
      && typeof US_STATES !== 'undefined' && Array.isArray(US_STATES)) {
    const svgNS = 'http://www.w3.org/2000/svg';
    US_STATES.forEach(s => {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', s.d);
      path.setAttribute('data-name', s.n);
      statesLayer.appendChild(path);
    });
  }

  // 2. Inject latitude/longitude reference grid + special parallels +
  // continent/region labels + decorative scanlines. v3.0.7 adds way more
  // visual richness — equator, prime meridian, tropics, polar circles,
  // 15° gridlines, and big italic continent/ocean labels for context.
  const svgNS_grid = 'http://www.w3.org/2000/svg';
  const gridLayer = document.getElementById('geo-map-grid');
  if (gridLayer && !gridLayer.children.length) {
    // Equirectangular: y = ((90 - lat) / 180) * 500
    // Major lat lines every 30° (excluding equator which gets special styling)
    [-60, -30, 30, 60].forEach(lat => {
      const y = ((90 - lat) / 180) * 500;
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', y);
      line.setAttribute('x2', '1000'); line.setAttribute('y2', y);
      gridLayer.appendChild(line);
    });
    // Equator
    {
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', '250');
      line.setAttribute('x2', '1000'); line.setAttribute('y2', '250');
      line.setAttribute('class', 'equator');
      gridLayer.appendChild(line);
    }
    // Tropic of Cancer (~23.5°N) and Capricorn (~23.5°S)
    [23.5, -23.5].forEach(lat => {
      const y = ((90 - lat) / 180) * 500;
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', y);
      line.setAttribute('x2', '1000'); line.setAttribute('y2', y);
      line.setAttribute('class', 'tropic');
      gridLayer.appendChild(line);
    });
    // Arctic / Antarctic circles (~66.5°)
    [66.5, -66.5].forEach(lat => {
      const y = ((90 - lat) / 180) * 500;
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', y);
      line.setAttribute('x2', '1000'); line.setAttribute('y2', y);
      line.setAttribute('class', 'polar-circle');
      gridLayer.appendChild(line);
    });
    // Minor lat lines every 15° (excluding ones we already drew)
    const alreadyDrawn = new Set([0, 30, -30, 60, -60, 23.5, -23.5, 66.5, -66.5]);
    for (let lat = -75; lat <= 75; lat += 15) {
      if (alreadyDrawn.has(lat)) continue;
      const y = ((90 - lat) / 180) * 500;
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', y);
      line.setAttribute('x2', '1000'); line.setAttribute('y2', y);
      line.setAttribute('class', 'minor');
      gridLayer.appendChild(line);
    }
    // Major longitude lines every 30°
    for (let lon = -150; lon <= 150; lon += 30) {
      if (lon === 0) continue;  // prime meridian gets special styling below
      const x = ((lon + 180) / 360) * 1000;
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', x); line.setAttribute('y1', '0');
      line.setAttribute('x2', x); line.setAttribute('y2', '500');
      gridLayer.appendChild(line);
    }
    // Prime meridian
    {
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', '500'); line.setAttribute('y1', '0');
      line.setAttribute('x2', '500'); line.setAttribute('y2', '500');
      line.setAttribute('class', 'prime-meridian');
      gridLayer.appendChild(line);
    }
    // Minor longitude lines every 15° (excluding majors)
    for (let lon = -165; lon <= 165; lon += 15) {
      if (lon % 30 === 0) continue;
      const x = ((lon + 180) / 360) * 1000;
      const line = document.createElementNS(svgNS_grid, 'line');
      line.setAttribute('x1', x); line.setAttribute('y1', '0');
      line.setAttribute('x2', x); line.setAttribute('y2', '500');
      line.setAttribute('class', 'minor');
      gridLayer.appendChild(line);
    }
  }

  // Continent + ocean labels — positioned manually using equirectangular
  // projection (lon, lat → x, y). These give the map context without
  // cluttering it with country labels.
  const labelLayer = document.getElementById('geo-map-labels');
  if (labelLayer && !labelLayer.children.length) {
    const labels = [
      // Continents
      { text: 'NORTH AMERICA',  lat: 45,   lon: -100, cls: 'continent-major' },
      { text: 'SOUTH AMERICA',  lat: -15,  lon:  -60, cls: 'continent-major' },
      { text: 'EUROPE',         lat: 54,   lon:   18, cls: 'continent-major' },
      { text: 'AFRICA',         lat: 5,    lon:   20, cls: 'continent-major' },
      { text: 'ASIA',           lat: 50,   lon:   95, cls: 'continent-major' },
      { text: 'OCEANIA',        lat: -25,  lon:  140, cls: 'continent-major' },
      { text: 'ANTARCTICA',     lat: -80,  lon:    0, cls: 'continent-major' },
      // Oceans (italic, subtler)
      { text: 'PACIFIC OCEAN',  lat: 0,    lon: -150, cls: 'ocean-label' },
      { text: 'ATLANTIC OCEAN', lat: 5,    lon:  -30, cls: 'ocean-label' },
      { text: 'INDIAN OCEAN',   lat: -25,  lon:   75, cls: 'ocean-label' },
      { text: 'ARCTIC OCEAN',   lat: 82,   lon:    0, cls: 'ocean-label' },
    ];
    labels.forEach(l => {
      const t = document.createElementNS(svgNS_grid, 'text');
      const x = ((l.lon + 180) / 360) * 1000;
      const y = ((90 - l.lat) / 180) * 500;
      t.setAttribute('x', x);
      t.setAttribute('y', y);
      t.setAttribute('class', l.cls);
      t.textContent = l.text;
      labelLayer.appendChild(t);
    });
  }

  // v3.0.7 — country-name labels. Hidden by default; CSS rules under
  // .show-country-labels make them visible when the map is zoomed in
  // enough (handled by _applyGeoView which toggles the body class).
  const countryLabelLayer = document.getElementById('geo-map-country-labels');
  if (countryLabelLayer && !countryLabelLayer.children.length
      && typeof WORLD_COUNTRIES !== 'undefined') {
    WORLD_COUNTRIES.forEach(c => {
      if (c.cx === undefined || c.cy === undefined) return;
      const t = document.createElementNS(svgNS_grid, 'text');
      t.setAttribute('x', c.cx);
      t.setAttribute('y', c.cy);
      t.setAttribute('class', 'country-label');
      t.textContent = c.n;
      countryLabelLayer.appendChild(t);
    });
  }

  // v3.0.7 — US state-name labels. Hidden at low zoom, visible past ~4x.
  const stateLabelLayer = document.getElementById('geo-map-state-labels');
  if (stateLabelLayer && !stateLabelLayer.children.length
      && typeof US_STATES !== 'undefined') {
    US_STATES.forEach(s => {
      if (s.cx === undefined || s.cy === undefined) return;
      const t = document.createElementNS(svgNS_grid, 'text');
      t.setAttribute('x', s.cx);
      t.setAttribute('y', s.cy);
      t.setAttribute('class', 'state-label');
      t.textContent = s.n;
      stateLabelLayer.appendChild(t);
    });
  }

  _geoState.dotsLayer = document.getElementById('geo-map-dots');
  _geoState.tooltip = document.getElementById('geo-map-tooltip');
  _geoState.emptyEl = document.getElementById('geo-map-empty');

  // View toggle buttons (Table / Map)
  document.querySelectorAll('[data-insp-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.inspView;
      // Toggle button active state
      document.querySelectorAll('[data-insp-view]').forEach(b =>
        b.classList.toggle('active', b === btn));
      // Show/hide panes
      document.querySelectorAll('[data-insp-pane]').forEach(pane => {
        pane.hidden = pane.dataset.inspPane !== view;
      });
      const body = document.querySelector('.insp-body');
      if (body) body.dataset.inspActiveView = view;
      // Force a refresh when switching to map so dots are current
      if (view === 'map' && typeof refreshInspector === 'function') refreshInspector();
    });
  });

  // v3.0.7 — pan/zoom interactivity. Drag to pan, scroll to zoom toward
  // cursor, +/- buttons, and a reset button. State is held in _geoView
  // and applied via the SVG viewBox attribute (no transforms needed —
  // dot hit-testing keeps working unchanged since SVG coords don't move).
  _setupGeoPanZoom();

  _geoState.initialized = true;
}

// === v3.0.7 — pan/zoom state + handlers ===
// _geoView holds the current viewBox. Base is (0, 0, 1000, 500) which
// represents the full Equirectangular world map. Smaller w/h = zoomed in.
const _geoView = { x: 0, y: 0, w: 1000, h: 500 };
const _GEO_BASE = { x: 0, y: 0, w: 1000, h: 500 };
const _GEO_MIN_W = 80;   // ~12.5x zoom max — enough to see a single country closely
const _GEO_MAX_W = 1000; // can't zoom out past the fitted world

const _geoDrag = {
  active: false,
  startClientX: 0,
  startClientY: 0,
  vbStartX: 0,
  vbStartY: 0,
  moved: false,    // suppress click-thru if user actually dragged
};

function _applyGeoView() {
  const svg = document.getElementById('geo-map');
  if (!svg) return;
  svg.setAttribute('viewBox',
    `${_geoView.x} ${_geoView.y} ${_geoView.w} ${_geoView.h}`);
  // Update the zoom % label — w shrinks as we zoom in, so % grows
  const lbl = document.getElementById('geo-zoom-label');
  if (lbl) {
    const pct = Math.round((_GEO_BASE.w / _geoView.w) * 100);
    lbl.textContent = pct + '%';
  }
  // v3.0.7 — toggle zoom-level classes on the SVG so CSS rules can show
  // country / state labels at appropriate zooms. Continent labels stay
  // visible at all zooms.
  //   < 1.7x  → no labels beyond continents
  //   1.7x+   → country labels appear
  //   3.5x+   → state labels appear, continent labels fade
  const zoom = _GEO_BASE.w / _geoView.w;
  svg.classList.toggle('show-country-labels', zoom >= 1.7);
  svg.classList.toggle('show-state-labels',   zoom >= 3.5);
  svg.classList.toggle('hide-continent-labels', zoom >= 3.5);
}

function _clampGeoView() {
  // Don't let user pan so far that the map disappears off-screen. We
  // allow up to 25% overscroll past the edge so users can center on
  // border countries comfortably.
  const slackX = _geoView.w * 0.25;
  const slackY = _geoView.h * 0.25;
  const minX = _GEO_BASE.x - slackX;
  const maxX = _GEO_BASE.x + _GEO_BASE.w - _geoView.w + slackX;
  const minY = _GEO_BASE.y - slackY;
  const maxY = _GEO_BASE.y + _GEO_BASE.h - _geoView.h + slackY;
  if (_geoView.x < minX) _geoView.x = minX;
  if (_geoView.x > maxX) _geoView.x = maxX;
  if (_geoView.y < minY) _geoView.y = minY;
  if (_geoView.y > maxY) _geoView.y = maxY;
}

function _setupGeoPanZoom() {
  const svg = document.getElementById('geo-map');
  if (!svg) return;

  // Pan — pointer events handle mouse + touch + pen uniformly
  svg.addEventListener('pointerdown', (e) => {
    // Don't start a pan if user clicks on a connection dot (let the dot
    // handle the click for tooltips/details)
    if (e.target && e.target.tagName === 'circle') return;
    if (e.button !== undefined && e.button !== 0) return; // left button only
    _geoDrag.active = true;
    _geoDrag.moved = false;
    _geoDrag.startClientX = e.clientX;
    _geoDrag.startClientY = e.clientY;
    _geoDrag.vbStartX = _geoView.x;
    _geoDrag.vbStartY = _geoView.y;
    svg.classList.add('is-dragging');
    try { svg.setPointerCapture(e.pointerId); } catch {}
  });

  svg.addEventListener('pointermove', (e) => {
    if (!_geoDrag.active) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Convert pixel delta to viewBox-unit delta
    const ratioX = _geoView.w / rect.width;
    const ratioY = _geoView.h / rect.height;
    const dx = (e.clientX - _geoDrag.startClientX) * ratioX;
    const dy = (e.clientY - _geoDrag.startClientY) * ratioY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) _geoDrag.moved = true;
    _geoView.x = _geoDrag.vbStartX - dx;
    _geoView.y = _geoDrag.vbStartY - dy;
    _clampGeoView();
    _applyGeoView();
  });

  const _endDrag = (e) => {
    if (!_geoDrag.active) return;
    _geoDrag.active = false;
    svg.classList.remove('is-dragging');
    try { if (e && e.pointerId !== undefined) svg.releasePointerCapture(e.pointerId); } catch {}
  };
  svg.addEventListener('pointerup', _endDrag);
  svg.addEventListener('pointercancel', _endDrag);
  svg.addEventListener('pointerleave', _endDrag);

  // Zoom on scroll wheel, anchored to cursor position
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // Mouse position in SVG (viewBox) coordinates BEFORE zoom
    const mxFrac = (e.clientX - rect.left) / rect.width;
    const myFrac = (e.clientY - rect.top) / rect.height;
    const svgMouseX = _geoView.x + mxFrac * _geoView.w;
    const svgMouseY = _geoView.y + myFrac * _geoView.h;

    // Scale factor — invert: scroll up zooms in (smaller viewBox)
    const scale = e.deltaY < 0 ? 0.82 : 1.22;
    let newW = _geoView.w * scale;
    let newH = _geoView.h * scale;
    // Clamp zoom range
    if (newW < _GEO_MIN_W) {
      const r = _GEO_MIN_W / _geoView.w;
      newW = _geoView.w * r; newH = _geoView.h * r;
    } else if (newW > _GEO_MAX_W) {
      const r = _GEO_MAX_W / _geoView.w;
      newW = _geoView.w * r; newH = _geoView.h * r;
    }

    // Keep the cursor-anchored SVG point fixed in screen space
    _geoView.w = newW;
    _geoView.h = newH;
    _geoView.x = svgMouseX - mxFrac * newW;
    _geoView.y = svgMouseY - myFrac * newH;
    _clampGeoView();
    _applyGeoView();
  }, { passive: false });

  // Button-based zoom — animated smoothly over ~250ms with easeOutCubic.
  // Wheel zoom stays snappy (instant) since it's gesture-driven.
  let _geoZoomAnim = null;
  function _easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function _animateGeoViewTo(targetX, targetY, targetW, targetH, duration) {
    if (_geoZoomAnim) cancelAnimationFrame(_geoZoomAnim);
    const startX = _geoView.x, startY = _geoView.y;
    const startW = _geoView.w, startH = _geoView.h;
    const dx = targetX - startX, dy = targetY - startY;
    const dw = targetW - startW, dh = targetH - startH;
    const startTime = performance.now();
    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const e = _easeOutCubic(t);
      _geoView.x = startX + dx * e;
      _geoView.y = startY + dy * e;
      _geoView.w = startW + dw * e;
      _geoView.h = startH + dh * e;
      _clampGeoView();
      _applyGeoView();
      if (t < 1) {
        _geoZoomAnim = requestAnimationFrame(step);
      } else {
        _geoZoomAnim = null;
      }
    }
    _geoZoomAnim = requestAnimationFrame(step);
  }

  function _zoomFromCenter(scale) {
    const cx = _geoView.x + _geoView.w * 0.5;
    const cy = _geoView.y + _geoView.h * 0.5;
    let newW = _geoView.w * scale;
    let newH = _geoView.h * scale;
    if (newW < _GEO_MIN_W) {
      const r = _GEO_MIN_W / _geoView.w;
      newW = _geoView.w * r; newH = _geoView.h * r;
    } else if (newW > _GEO_MAX_W) {
      const r = _GEO_MAX_W / _geoView.w;
      newW = _geoView.w * r; newH = _geoView.h * r;
    }
    const newX = cx - newW * 0.5;
    const newY = cy - newH * 0.5;
    _animateGeoViewTo(newX, newY, newW, newH, 260);
  }

  const zoomIn  = document.getElementById('geo-zoom-in');
  const zoomOut = document.getElementById('geo-zoom-out');
  const reset   = document.getElementById('geo-reset-view');
  if (zoomIn)  zoomIn.addEventListener('click',  () => _zoomFromCenter(0.7));
  if (zoomOut) zoomOut.addEventListener('click', () => _zoomFromCenter(1.43));
  if (reset)   reset.addEventListener('click',   () => {
    _animateGeoViewTo(_GEO_BASE.x, _GEO_BASE.y, _GEO_BASE.w, _GEO_BASE.h, 360);
  });
}

// Compute dot radius from total bytes — sqrt scaling so a 100x byte
// difference shows as a 10x area difference, not a 100x one.
function _geoDotRadius(totalBytes) {
  if (!totalBytes || totalBytes < 100) return 3;
  const r = 3 + Math.min(12, Math.sqrt(totalBytes / 1024) * 0.7);
  return Math.min(15, r);
}

function _formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// v2.5.2 — Update the geo map stats bar with aggregate values.
// `rows` is the full inspector row list (incl. unplottable like localhost),
// `byCountry` is the already-bucketed map of plottable countries.
function _updateGeoStats(rows, byCountry) {
  const ccountEl = document.getElementById('geo-stat-countries');
  const conncEl  = document.getElementById('geo-stat-conns');
  const inEl     = document.getElementById('geo-stat-in');
  const outEl    = document.getElementById('geo-stat-out');
  const topEl    = document.getElementById('geo-stat-top');

  const countries = Object.keys(byCountry || {});
  if (ccountEl) ccountEl.textContent = countries.length;
  if (conncEl)  conncEl.textContent = (rows || []).length;

  let totalIn = 0, totalOut = 0;
  let topCC = null, topBytes = 0;
  for (const [cc, conns] of Object.entries(byCountry || {})) {
    let countryBytes = 0;
    for (const c of conns) {
      totalIn  += (c.bytes_in  || 0);
      totalOut += (c.bytes_out || 0);
      countryBytes += (c.bytes_in || 0) + (c.bytes_out || 0);
    }
    if (countryBytes > topBytes) { topBytes = countryBytes; topCC = cc; }
  }
  if (inEl)  inEl.textContent  = _formatBytes(totalIn);
  if (outEl) outEl.textContent = _formatBytes(totalOut);
  if (topEl) topEl.textContent = topCC || '—';
}

// Called from the existing inspector refresh flow with the same row data
function renderGeoMap(rows) {
  if (!_geoState.initialized) return;
  if (!_geoState.dotsLayer) return;

  // Group connections by country first — we need this to decide which
  // empty-state message to show (no rows at all vs rows-but-none-plottable).
  const svgNS = 'http://www.w3.org/2000/svg';
  const now = Date.now() / 1000;
  const seenAddrs = new Set();
  const byCountry = {};
  if (rows && rows.length) {
    rows.forEach(r => {
      const cc = (r.country || '').toUpperCase();
      if (!cc || !COUNTRY_COORDS[cc]) return;
      if (!byCountry[cc]) byCountry[cc] = [];
      byCountry[cc].push(r);
    });
  }
  const plottableCount = Object.values(byCountry).reduce((n, arr) => n + arr.length, 0);

  // v2.5.2 — Update the stats bar (countries / connections / total bytes)
  _updateGeoStats(rows || [], byCountry);

  // Empty-state visibility + message
  if (_geoState.emptyEl) {
    if (plottableCount > 0) {
      _geoState.emptyEl.hidden = true;
    } else {
      _geoState.emptyEl.hidden = false;
      const txt = _geoState.emptyEl.querySelector('.geo-empty-text');
      const sub = _geoState.emptyEl.querySelector('.geo-empty-sub');
      if (rows && rows.length) {
        if (txt) txt.textContent = 'No mappable connections';
        if (sub) sub.textContent = `${rows.length} connection${rows.length === 1 ? '' : 's'} active — but they're local or private addresses with no geo data. The Table view shows them all.`;
      } else {
        if (txt) txt.textContent = 'No connections yet';
        if (sub) sub.textContent = "Start capture on a target app — connections will plot here as they're made";
      }
    }
  }

  if (plottableCount === 0) {
    // Clear all dots and bail
    _geoState.dotsLayer.innerHTML = '';
    _geoState.dots.clear();
    return;
  }

  // v2.5.2 — fully stable hash → 2D offset. The earlier version still depended
  // on `idx` for distance, so when a connection appeared/disappeared in the
  // same country, every other dot's idx (and therefore distance) shifted —
  // that's the glitch the user reported. This version derives both angle AND
  // distance from the address hash directly, so each connection has a fixed
  // position regardless of how many other connections exist in that country.
  // Trade-off: a single connection won't sit at the exact country center,
  // but it'll still be within ~12px so it visually reads as "at" the country.
  function _stableJitterFor(addr) {
    if (!addr) return { dx: 0, dy: 0 };
    // Two independent hashes for two stable dimensions
    let h1 = 0, h2 = 5381;
    for (let c = 0; c < addr.length; c++) {
      h1 = (h1 * 31 + addr.charCodeAt(c)) | 0;
      h2 = ((h2 << 5) + h2 + addr.charCodeAt(c)) | 0;  // djb2
    }
    const angle = ((Math.abs(h1) % 10000) / 10000) * Math.PI * 2;
    // Distance: 0 to 12px from country center, derived from second hash.
    const dist = (Math.abs(h2) % 1200) / 100;
    return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist };
  }

  Object.entries(byCountry).forEach(([cc, conns]) => {
    const [lat, lon] = COUNTRY_COORDS[cc];
    const center = geoProject(lat, lon);

    conns.forEach((r, idx) => {
      const addr = r.remote_addr || `${cc}-${idx}`;
      seenAddrs.add(addr);

      const jitter = _stableJitterFor(addr);

      const x = center.x + jitter.dx;
      const y = center.y + jitter.dy;
      const totalBytes = (r.bytes_in || 0) + (r.bytes_out || 0);
      const radius = _geoDotRadius(totalBytes);

      // Determine active/idle: active if seen in last 5 seconds
      const isActive = (r.last_seen && (now - r.last_seen) < 5);

      let entry = _geoState.dots.get(addr);
      if (!entry) {
        // Create new dot SVG group
        const group = document.createElementNS(svgNS, 'g');
        group.setAttribute('class', 'geo-dot');
        group.style.setProperty('--dot-r', radius);

        // Pulse circle (only animates when active)
        const pulse = document.createElementNS(svgNS, 'circle');
        pulse.setAttribute('cx', x);
        pulse.setAttribute('cy', y);
        pulse.setAttribute('r', radius);
        pulse.setAttribute('class', 'geo-dot-pulse');
        group.appendChild(pulse);

        // Core circle (the actual dot)
        const core = document.createElementNS(svgNS, 'circle');
        core.setAttribute('cx', x);
        core.setAttribute('cy', y);
        core.setAttribute('r', radius);
        core.setAttribute('class', 'geo-dot-core');
        group.appendChild(core);

        // Hover for tooltip
        group.addEventListener('mouseenter', e => _geoShowTooltip(e, r));
        group.addEventListener('mousemove', e => _geoMoveTooltip(e));
        group.addEventListener('mouseleave', () => _geoHideTooltip());

        _geoState.dotsLayer.appendChild(group);
        entry = { group, pulse, core, data: r };
        _geoState.dots.set(addr, entry);
      } else {
        // Update existing dot's position and size
        entry.pulse.setAttribute('cx', x);
        entry.pulse.setAttribute('cy', y);
        entry.pulse.setAttribute('r', radius);
        entry.core.setAttribute('cx', x);
        entry.core.setAttribute('cy', y);
        entry.core.setAttribute('r', radius);
        entry.group.style.setProperty('--dot-r', radius);
        entry.data = r;
      }

      entry.group.classList.toggle('is-active', isActive);
      entry.group.classList.toggle('is-idle', !isActive);
    });
  });

  // Remove dots for connections that are no longer present
  for (const [addr, entry] of _geoState.dots.entries()) {
    if (!seenAddrs.has(addr)) {
      entry.group.remove();
      _geoState.dots.delete(addr);
    }
  }
}

function _geoShowTooltip(e, conn) {
  if (!_geoState.tooltip) return;
  const host = document.getElementById('geo-tt-host');
  const meta = document.getElementById('geo-tt-meta');
  const stats = document.getElementById('geo-tt-stats');
  if (host) host.textContent = conn.hostname || conn.remote_addr || '—';
  if (meta) meta.textContent =
    `${conn.country || '??'} · ${conn.proto || '?'} · port ${conn.remote_port || 0}`;
  if (stats) stats.innerHTML =
    `↑ ${_formatBytes(conn.bytes_out || 0)}    ↓ ${_formatBytes(conn.bytes_in || 0)}`;
  _geoState.tooltip.hidden = false;
  _geoMoveTooltip(e);
}

function _geoMoveTooltip(e) {
  if (!_geoState.tooltip || _geoState.tooltip.hidden) return;
  const wrap = document.querySelector('.insp-map-wrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const tx = e.clientX - rect.left + 14;
  const ty = e.clientY - rect.top + 14;
  // Keep tooltip inside the map bounds
  const ttRect = _geoState.tooltip.getBoundingClientRect();
  const maxX = rect.width - ttRect.width - 8;
  const maxY = rect.height - ttRect.height - 8;
  _geoState.tooltip.style.left = Math.min(tx, maxX) + 'px';
  _geoState.tooltip.style.top = Math.min(ty, maxY) + 'px';
}

function _geoHideTooltip() {
  if (_geoState.tooltip) _geoState.tooltip.hidden = true;
}

// Hook into the existing renderInspectorTable to also populate the map.
// The original function still does its job for the table view; we just
// piggy-back so map data stays in sync with table data.
const _origRenderInspector_v250 = typeof renderInspectorTable === 'function'
  ? renderInspectorTable : null;
if (_origRenderInspector_v250) {
  window.renderInspectorTable = function (rows) {
    _origRenderInspector_v250(rows);
    try { renderGeoMap(rows); } catch (e) { console.error('[geo-map]', e); }
  };
}

// Initialize on DOM ready
(function initGeoMap() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupGeoMap);
  } else {
    setupGeoMap();
  }
})();


// ============================================================
// Phase 3 (v2.6.0) — Automation rules tab + editor
// ============================================================
// Renders the rules list, opens the editor modal, talks to the bridge for
// save/delete/test/master-toggle, and animates rule cards when they fire.
// ============================================================

let _automationRules = [];           // local cache, refreshed from bridge
let _editingRuleId = null;            // rule id being edited (null = new)
let _automationEngineOn = true;

function _autoFmtRuleSummary(rule) {
  const c = rule.condition || {};
  const a = rule.action || {};
  let when = '';
  switch (c.type) {
    case 'schedule': {
      const days = (c.weekdays || []).map(d => ['Mo','Tu','We','Th','Fr','Sa','Su'][d]).join('');
      when = `⏰ ${c.start || '?'}–${c.end || '?'} · ${days || 'no days'}`;
      break;
    }
    case 'app_running':
      when = `🎯 ${c.process_name || '?'} running`;
      break;
    case 'bandwidth':
      when = `📊 BW > ${c.threshold_kbps || 0} KB/s`;
      break;
    case 'conn_count':
      when = `🔢 conns > ${c.threshold || 0}`;
      break;
    default:
      when = '?';
  }
  let then = '';
  switch (a.type) {
    case 'preset':
      then = `📦 apply "${a.preset_name || '?'}"`;
      break;
    case 'function':
      then = `🎚 ${a.function || '?'} ${a.on ? 'ON' : 'OFF'}`;
      break;
    case 'toast':
      then = `💬 toast`;
      break;
    case 'capture':
      then = a.command === 'stop' ? '◼ stop capture' : '▶︎ start capture';
      break;
    default:
      then = '?';
  }
  return { when, then };
}

function _autoRenderRules() {
  const list = document.getElementById('auto-rules-list');
  const empty = document.getElementById('auto-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!_automationRules || _automationRules.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  for (const rule of _automationRules) {
    const card = document.createElement('div');
    card.className = 'auto-rule-card';
    card.dataset.ruleId = rule.id;
    card.dataset.disabled = rule.enabled === false ? '1' : '0';

    const summary = _autoFmtRuleSummary(rule);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'rule-toggle';
    toggle.checked = rule.enabled !== false;
    toggle.title = rule.enabled === false ? 'Enable this rule' : 'Disable this rule';
    toggle.addEventListener('change', () => {
      const on = toggle.checked;
      bridge.setAutomationRuleEnabled(rule.id, on).then((ok) => {
        if (ok) {
          rule.enabled = on;
          card.dataset.disabled = on ? '0' : '1';
          toggle.title = on ? 'Disable this rule' : 'Enable this rule';
        } else {
          // Revert
          toggle.checked = rule.enabled !== false;
          toast('Failed to toggle rule', 'error');
        }
      });
    });
    card.appendChild(toggle);

    const info = document.createElement('div');
    info.className = 'rule-info';
    const name = document.createElement('span');
    name.className = 'rule-name';
    name.textContent = rule.name || '(unnamed)';
    info.appendChild(name);
    const sumEl = document.createElement('span');
    sumEl.className = 'rule-summary';
    sumEl.innerHTML =
      `<span class="when">${summary.when}</span> ⟶ <span class="then">${summary.then}</span>`;
    info.appendChild(sumEl);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'rule-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'rule-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => _autoOpenEditor(rule));
    const delBtn = document.createElement('button');
    delBtn.className = 'rule-btn danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => _autoDeleteRule(rule));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    list.appendChild(card);
  }
}

function _autoLoadRules() {
  if (!bridge || !bridge.getAutomationRules) return;
  bridge.getAutomationRules().then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    _automationRules = Array.isArray(res.rules) ? res.rules : [];
    _automationEngineOn = !!res.engine_enabled;
    const eng = document.getElementById('auto-engine-enabled');
    if (eng) eng.checked = _automationEngineOn;
    _autoRenderRules();
  });
}

function _autoDeleteRule(rule) {
  if (!confirm(`Delete rule "${rule.name}"? This can't be undone.`)) return;
  bridge.deleteAutomationRule(rule.id).then((ok) => {
    if (!ok) { toast('Failed to delete rule', 'error'); return; }
    _automationRules = _automationRules.filter(r => r.id !== rule.id);
    _autoRenderRules();
    toast('Rule deleted', 'success');
  });
}

function _autoSwitchCondPane(type) {
  document.querySelectorAll('[data-cond-pane]').forEach(p => {
    p.hidden = p.dataset.condPane !== type;
  });
  const sel = document.getElementById('auto-cond-type');
  if (sel) sel.value = type;
}

function _autoSwitchActionPane(type) {
  document.querySelectorAll('[data-action-pane]').forEach(p => {
    p.hidden = p.dataset.actionPane !== type;
  });
  const sel = document.getElementById('auto-action-type');
  if (sel) sel.value = type;
}

function _autoPopulatePresetDropdown() {
  // Fetch user presets and populate the action's preset selector
  const sel = document.getElementById('auto-action-preset');
  if (!sel || !bridge || !bridge.getUserPresets) return;
  bridge.getUserPresets().then((raw) => {
    let presets = [];
    try { presets = JSON.parse(raw || '[]'); } catch {}
    const cur = sel.value;
    sel.innerHTML = '<option value="">— select a preset —</option>';
    for (const p of presets) {
      if (!p || !p.name) continue;
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    // Restore selection if it still exists
    if (cur && presets.some(p => p && p.name === cur)) sel.value = cur;
  });
}

function _autoPopulateProcessDatalist() {
  const list = document.getElementById('auto-cond-app-list');
  if (!list || !bridge || !bridge.listRunningProcesses) return;
  bridge.listRunningProcesses().then((raw) => {
    let names = [];
    try { names = JSON.parse(raw || '[]'); } catch {}
    list.innerHTML = '';
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = n;
      list.appendChild(opt);
    }
  });
}

function _autoOpenEditor(rule) {
  // rule = null/undefined for new, otherwise existing rule object to edit
  const modal = document.getElementById('auto-edit-modal');
  const titleEl = document.getElementById('auto-edit-title');
  if (!modal) return;

  _editingRuleId = rule ? rule.id : null;
  if (titleEl) titleEl.textContent = rule ? 'Edit automation rule' : 'New automation rule';

  // Refresh dropdowns each time so newly-saved presets / freshly-running processes show up
  _autoPopulatePresetDropdown();
  _autoPopulateProcessDatalist();

  // Fill name
  document.getElementById('auto-rule-name').value = rule ? (rule.name || '') : '';

  // Condition
  const c = (rule && rule.condition) ? rule.condition : { type: 'schedule' };
  _autoSwitchCondPane(c.type || 'schedule');
  if (c.type === 'schedule' || !rule) {
    document.getElementById('auto-cond-start').value = c.start || '09:00';
    document.getElementById('auto-cond-end').value = c.end || '17:00';
    const wds = c.weekdays || [0, 1, 2, 3, 4];
    document.querySelectorAll('#auto-weekday-row input[type="checkbox"]').forEach(cb => {
      cb.checked = wds.includes(parseInt(cb.dataset.wd, 10));
    });
  }
  if (c.type === 'app_running') {
    document.getElementById('auto-cond-app').value = c.process_name || '';
  } else if (!rule) {
    document.getElementById('auto-cond-app').value = '';
  }
  if (c.type === 'bandwidth') {
    document.getElementById('auto-cond-bw').value = c.threshold_kbps || 500;
  } else if (!rule) {
    document.getElementById('auto-cond-bw').value = 500;
  }
  if (c.type === 'conn_count') {
    document.getElementById('auto-cond-cc').value = c.threshold || 50;
  } else if (!rule) {
    document.getElementById('auto-cond-cc').value = 50;
  }

  // Action
  const a = (rule && rule.action) ? rule.action : { type: 'preset' };
  _autoSwitchActionPane(a.type || 'preset');
  if (a.type === 'preset') {
    setTimeout(() => {  // wait for dropdown populate
      const sel = document.getElementById('auto-action-preset');
      if (sel && a.preset_name) sel.value = a.preset_name;
    }, 100);
  }
  if (a.type === 'function') {
    document.getElementById('auto-action-func').value = a.function || 'lag';
    document.getElementById('auto-action-on').value = (a.on === false ? 'false' : 'true');
  } else if (!rule) {
    document.getElementById('auto-action-func').value = 'lag';
    document.getElementById('auto-action-on').value = 'true';
  }
  if (a.type === 'toast') {
    document.getElementById('auto-action-toast').value = a.message || '';
  } else if (!rule) {
    document.getElementById('auto-action-toast').value = '';
  }
  if (a.type === 'capture') {
    document.getElementById('auto-action-cap').value = a.command || 'start';
  } else if (!rule) {
    document.getElementById('auto-action-cap').value = 'start';
  }

  // Clear test result
  const tr = document.getElementById('auto-test-result');
  if (tr) { tr.textContent = ''; tr.className = 'auto-test-result'; }

  modal.hidden = false;
}

function _autoCloseEditor() {
  const modal = document.getElementById('auto-edit-modal');
  if (modal) modal.hidden = true;
  _editingRuleId = null;
}

function _autoBuildConditionFromForm() {
  const type = document.getElementById('auto-cond-type').value;
  if (type === 'schedule') {
    const wds = [];
    document.querySelectorAll('#auto-weekday-row input[type="checkbox"]').forEach(cb => {
      if (cb.checked) wds.push(parseInt(cb.dataset.wd, 10));
    });
    return {
      type: 'schedule',
      start: document.getElementById('auto-cond-start').value || '09:00',
      end:   document.getElementById('auto-cond-end').value   || '17:00',
      weekdays: wds,
    };
  }
  if (type === 'app_running') {
    return {
      type: 'app_running',
      process_name: (document.getElementById('auto-cond-app').value || '').trim(),
    };
  }
  if (type === 'bandwidth') {
    return {
      type: 'bandwidth',
      threshold_kbps: parseFloat(document.getElementById('auto-cond-bw').value) || 0,
    };
  }
  if (type === 'conn_count') {
    return {
      type: 'conn_count',
      threshold: parseInt(document.getElementById('auto-cond-cc').value, 10) || 0,
    };
  }
  return { type: 'schedule' };
}

function _autoBuildActionFromForm() {
  const type = document.getElementById('auto-action-type').value;
  if (type === 'preset') {
    return {
      type: 'preset',
      preset_name: document.getElementById('auto-action-preset').value || '',
    };
  }
  if (type === 'function') {
    return {
      type: 'function',
      function: document.getElementById('auto-action-func').value || 'lag',
      on: document.getElementById('auto-action-on').value === 'true',
    };
  }
  if (type === 'toast') {
    return {
      type: 'toast',
      message: (document.getElementById('auto-action-toast').value || '').trim(),
    };
  }
  if (type === 'capture') {
    return {
      type: 'capture',
      command: document.getElementById('auto-action-cap').value || 'start',
    };
  }
  return { type: 'preset' };
}

function _autoValidateForm(rule) {
  if (!rule.name) return 'Rule needs a name.';
  const c = rule.condition;
  if (c.type === 'schedule' && (!c.weekdays || c.weekdays.length === 0)) {
    return 'Pick at least one weekday for the schedule.';
  }
  if (c.type === 'app_running' && !c.process_name) {
    return 'Pick a process name for the app-running condition.';
  }
  if (c.type === 'bandwidth' && (!c.threshold_kbps || c.threshold_kbps <= 0)) {
    return 'Bandwidth threshold must be a positive number.';
  }
  if (c.type === 'conn_count' && (!c.threshold || c.threshold <= 0)) {
    return 'Connection count threshold must be a positive number.';
  }
  const a = rule.action;
  if (a.type === 'preset' && !a.preset_name) {
    return 'Pick a preset for the action (or save one first in Quick Presets).';
  }
  if (a.type === 'toast' && !a.message) {
    return 'Toast notification needs a message.';
  }
  return null;
}

function _autoSaveFromForm() {
  const name = document.getElementById('auto-rule-name').value.trim();
  const rule = {
    id: _editingRuleId || '',   // empty → backend generates
    name,
    enabled: true,
    condition: _autoBuildConditionFromForm(),
    action:    _autoBuildActionFromForm(),
  };
  // Preserve existing enabled state when editing
  if (_editingRuleId) {
    const existing = _automationRules.find(r => r.id === _editingRuleId);
    if (existing) rule.enabled = existing.enabled !== false;
  }
  const err = _autoValidateForm(rule);
  if (err) { toast(err, 'error'); return; }

  bridge.saveAutomationRule(JSON.stringify(rule)).then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (!res.ok) { toast('Save failed: ' + (res.error || 'unknown'), 'error'); return; }
    rule.id = res.rule_id;
    // Update local cache
    const idx = _automationRules.findIndex(r => r.id === rule.id);
    if (idx >= 0) _automationRules[idx] = rule;
    else _automationRules.push(rule);
    _autoRenderRules();
    _autoCloseEditor();
    toast(_editingRuleId ? 'Rule updated' : 'Rule created', 'success');
  });
}

function _autoTestCondition() {
  const cond = _autoBuildConditionFromForm();
  const tr = document.getElementById('auto-test-result');
  if (!tr) return;
  tr.textContent = 'Testing…';
  tr.className = 'auto-test-result';
  bridge.testAutomationCondition(JSON.stringify(cond)).then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (res.error) {
      tr.textContent = '✗ ' + res.error;
      tr.className = 'auto-test-result is-error';
      return;
    }
    if (res.active) {
      tr.textContent = '✓ Active right now';
      tr.className = 'auto-test-result is-true';
    } else {
      tr.textContent = '○ Not active right now';
      tr.className = 'auto-test-result is-false';
    }
  });
}

function setupAutomationTab() {
  // Master engine toggle
  const eng = document.getElementById('auto-engine-enabled');
  if (eng) eng.addEventListener('change', () => {
    const on = eng.checked;
    bridge.setAutomationEngineEnabled(on).then((ok) => {
      if (!ok) { eng.checked = !on; toast('Failed to toggle engine', 'error'); return; }
      _automationEngineOn = on;
      toast(on ? 'Automation engine enabled' : 'Automation engine paused', on ? 'success' : 'info');
    });
  });

  // New rule button
  const newBtn = document.getElementById('auto-add-rule');
  if (newBtn) newBtn.addEventListener('click', () => _autoOpenEditor(null));

  // Editor controls
  const condTypeSel = document.getElementById('auto-cond-type');
  if (condTypeSel) condTypeSel.addEventListener('change', () => _autoSwitchCondPane(condTypeSel.value));
  const actionTypeSel = document.getElementById('auto-action-type');
  if (actionTypeSel) actionTypeSel.addEventListener('change', () => _autoSwitchActionPane(actionTypeSel.value));

  const saveBtn = document.getElementById('auto-edit-save');
  if (saveBtn) saveBtn.addEventListener('click', _autoSaveFromForm);
  const cancelBtn = document.getElementById('auto-edit-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', _autoCloseEditor);
  const closeBtn = document.getElementById('auto-edit-close');
  if (closeBtn) closeBtn.addEventListener('click', _autoCloseEditor);

  const testBtn = document.getElementById('auto-test-cond');
  if (testBtn) testBtn.addEventListener('click', _autoTestCondition);

  // Subscribe to fire events for visual flash + recent indicator
  if (bridge && bridge.automationRuleFired && bridge.automationRuleFired.connect) {
    bridge.automationRuleFired.connect((raw) => {
      let evt = {};
      try { evt = JSON.parse(raw || '{}'); } catch {}
      // Flash the card if visible
      const card = document.querySelector(`.auto-rule-card[data-rule-id="${evt.rule_id}"]`);
      if (card) {
        card.classList.remove('is-firing');
        // Force reflow so the animation restarts even if it was already running
        void card.offsetWidth;
        card.classList.add('is-firing');
      }
      // Update "last fired" indicator
      const recent = document.getElementById('auto-recent-fire');
      const nameEl = document.getElementById('auto-recent-name');
      const whenEl = document.getElementById('auto-recent-when');
      if (recent && nameEl && whenEl) {
        recent.hidden = false;
        nameEl.textContent = evt.rule_name || '(unnamed)';
        whenEl.textContent = 'just now';
        // Show a toast too
        toast(`Rule fired: ${evt.rule_name} → ${evt.action_summary}`, 'info');
      }
    });
  }

  // Initial load — bridge is guaranteed ready by the init IIFE
  _autoLoadRules();
}

// Initialise once DOM + bridge are both ready
(function initAutomation() {
  let _autoInitRetries = 0;
  const MAX_RETRIES = 50;   // ~10 seconds at 200ms — enough for any normal startup
  function tryInit() {
    if (typeof bridge !== 'undefined' && bridge && bridge.getAutomationRules) {
      setupAutomationTab();
      return;
    }
    _autoInitRetries++;
    if (_autoInitRetries < MAX_RETRIES) {
      setTimeout(tryInit, 200);
    }
    // After MAX_RETRIES we silently give up — bridge isn't coming. This
    // happens in test/non-Throttlr environments and is harmless.
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }
})();


// ============================================================
// Phase 4 (v2.7.0) — Throttlr Studio: visual timeline editor
// ============================================================
// Canvas-based multi-lane editor for .thrtlrec recordings. Each function
// (lag/drop/throttle/freeze/block/fun) gets a horizontal lane. Function
// on-periods render as colored blocks. Drag to move, drag edges to resize,
// click empty space to add, click+Delete to remove. Undo/redo via stack.
// ============================================================

const STUDIO_LANES = [
  { key: 'lag',      label: 'Lag',      color: '#ffb800' },
  { key: 'drop',     label: 'Drop',     color: '#ff5b5b' },
  { key: 'throttle', label: 'Throttle', color: '#66ddff' },
  { key: 'freeze',   label: 'Freeze',   color: '#7fbfff' },
  { key: 'block',    label: 'Block',    color: '#888888' },
  { key: 'fun',      label: 'Fun',      color: '#c66bff' },
];
const STUDIO_LANE_HEIGHT  = 44;
const STUDIO_RULER_HEIGHT = 28;
const STUDIO_HANDLE_PX    = 6;     // edge resize zone width

// Studio state
let _studio = {
  open: false,
  src_path: '',
  events: [],            // [{lane, start_ms, end_ms, params}, ...]
  duration_ms: 0,
  zoom: 1.0,             // 1.0 = fit-to-width baseline
  base_pixels_per_ms: 0,
  scrub_ms: 0,
  selected_idx: -1,
  hover_idx: -1,
  drag_state: null,      // {mode: 'move'|'resize-left'|'resize-right'|'scrub'|'create', ...}
  history: [],           // undo stack of {events, duration}
  future: [],            // redo stack
  snap_ms: 1000,
  meta: {},
};

function setupStudio() {
  // Wire up close button and keyboard shortcuts
  const modal = document.getElementById('studio-modal');
  if (!modal) return;

  document.getElementById('studio-close-btn')?.addEventListener('click', _studioClose);

  // Toolbar
  document.getElementById('studio-undo')?.addEventListener('click', _studioUndo);
  document.getElementById('studio-redo')?.addEventListener('click', _studioRedo);
  document.getElementById('studio-snap')?.addEventListener('change', (e) => {
    _studio.snap_ms = parseInt(e.target.value, 10) || 0;
  });
  document.getElementById('studio-zoom-in')?.addEventListener('click', () => _studioZoom(1.5));
  document.getElementById('studio-zoom-out')?.addEventListener('click', () => _studioZoom(1 / 1.5));
  document.getElementById('studio-zoom-fit')?.addEventListener('click', () => { _studio.zoom = 1.0; _studioRender(); });
  document.getElementById('studio-save-btn')?.addEventListener('click', () => _studioSave(false));
  document.getElementById('studio-saveas-btn')?.addEventListener('click', () => _studioSave(true));

  // Canvas events
  const canvas = document.getElementById('studio-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', _studioMouseDown);
    canvas.addEventListener('mousemove', _studioMouseMove);
    canvas.addEventListener('mouseup',   _studioMouseUp);
    canvas.addEventListener('mouseleave', _studioMouseUp);
    canvas.addEventListener('wheel',     _studioWheel, { passive: false });
  }

  // Keyboard
  document.addEventListener('keydown', _studioKeyDown);
}

function _studioOpen(src_path) {
  if (!bridge || !bridge.getStudioTimeline) return;
  bridge.getStudioTimeline(src_path).then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (!res.ok) {
      toast('Could not open recording: ' + (res.error || 'unknown error'), 'error');
      return;
    }
    _studio.open = true;
    _studio.src_path = src_path;
    _studio.events = (res.events || []).map(e => ({...e}));
    _studio.duration_ms = res.duration_ms || 0;
    _studio.scrub_ms = 0;
    _studio.selected_idx = -1;
    _studio.hover_idx = -1;
    _studio.history = [];
    _studio.future = [];
    _studio.zoom = 1.0;
    _studio.meta = {
      target: res.target || '',
      started: res.started || '',
      ended: res.ended || '',
      edited: res.edited || '',
    };

    // Subtitle showing source path
    const sub = document.getElementById('studio-subtitle');
    if (sub) {
      const fname = (src_path || '').split(/[/\\]/).pop() || '';
      sub.textContent = `editing ${fname}${res.target ? ` (${res.target})` : ''}`;
    }

    document.getElementById('studio-modal').hidden = false;
    _studioRenderLaneLabels();
    setTimeout(_studioRender, 50);  // wait one frame for layout
  });
}

function _studioClose() {
  _studio.open = false;
  document.getElementById('studio-modal').hidden = true;
}

function _studioRenderLaneLabels() {
  const container = document.getElementById('studio-lanes-labels');
  if (!container) return;
  container.innerHTML = '';
  for (const lane of STUDIO_LANES) {
    const div = document.createElement('div');
    div.className = 'studio-lane-label';
    div.innerHTML = `<span class="swatch" style="background:${lane.color}"></span>${lane.label}`;
    container.appendChild(div);
  }
}

function _studioRecordSnapshot() {
  // Push current state onto undo stack, clear redo
  _studio.history.push({
    events: _studio.events.map(e => ({...e, params: e.params ? {...e.params} : {}})),
    duration_ms: _studio.duration_ms,
  });
  if (_studio.history.length > 100) _studio.history.shift();
  _studio.future = [];
  _studioUpdateUndoButtons();
}

function _studioUpdateUndoButtons() {
  document.getElementById('studio-undo').disabled = _studio.history.length === 0;
  document.getElementById('studio-redo').disabled = _studio.future.length === 0;
}

function _studioUndo() {
  if (_studio.history.length === 0) return;
  _studio.future.push({
    events: _studio.events.map(e => ({...e, params: e.params ? {...e.params} : {}})),
    duration_ms: _studio.duration_ms,
  });
  const prev = _studio.history.pop();
  _studio.events = prev.events;
  _studio.duration_ms = prev.duration_ms;
  _studio.selected_idx = -1;
  _studioUpdateUndoButtons();
  _studioRender();
}

function _studioRedo() {
  if (_studio.future.length === 0) return;
  _studio.history.push({
    events: _studio.events.map(e => ({...e, params: e.params ? {...e.params} : {}})),
    duration_ms: _studio.duration_ms,
  });
  const next = _studio.future.pop();
  _studio.events = next.events;
  _studio.duration_ms = next.duration_ms;
  _studio.selected_idx = -1;
  _studioUpdateUndoButtons();
  _studioRender();
}

function _studioZoom(factor) {
  _studio.zoom = Math.max(0.1, Math.min(20, _studio.zoom * factor));
  _studioRender();
}

function _studioWheel(e) {
  e.preventDefault();
  if (e.deltaY < 0) _studioZoom(1.1);
  else _studioZoom(1 / 1.1);
}

function _studioKeyDown(e) {
  if (!_studio.open) return;
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for undo/redo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); _studioUndo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault(); _studioRedo(); return;
  }
  // Delete to remove selected event
  if ((e.key === 'Delete' || e.key === 'Backspace') && _studio.selected_idx >= 0) {
    e.preventDefault();
    _studioRecordSnapshot();
    _studio.events.splice(_studio.selected_idx, 1);
    _studio.selected_idx = -1;
    _studioRender();
    return;
  }
  // +/- for zoom
  if (e.key === '+' || e.key === '=') { e.preventDefault(); _studioZoom(1.5); return; }
  if (e.key === '-') { e.preventDefault(); _studioZoom(1/1.5); return; }
}

function _studioPxPerMs() {
  const canvas = document.getElementById('studio-canvas');
  const wrap = canvas?.parentElement;
  if (!canvas || !wrap || _studio.duration_ms <= 0) return 0.01;
  // Base = fit visible duration into wrap width
  const visible_w = Math.max(400, wrap.clientWidth);
  _studio.base_pixels_per_ms = visible_w / Math.max(1000, _studio.duration_ms);
  return _studio.base_pixels_per_ms * _studio.zoom;
}

function _studioCanvasWidthForData() {
  return Math.max(400, _studio.duration_ms * _studioPxPerMs() + 40);
}

function _studioRender() {
  const canvas = document.getElementById('studio-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Resize canvas based on zoom / data
  const total_h = STUDIO_RULER_HEIGHT + STUDIO_LANE_HEIGHT * STUDIO_LANES.length;
  const target_w = _studioCanvasWidthForData();
  if (canvas.width !== Math.floor(target_w)) canvas.width = Math.floor(target_w);
  if (canvas.height !== total_h) canvas.height = total_h;

  const w = canvas.width, h = canvas.height;
  const ppms = _studioPxPerMs();

  // --- Background ---
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, w, h);

  // --- Time ruler ---
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, STUDIO_RULER_HEIGHT);
  // Tick marks every 1s, labels every 5s (or smarter at high zoom)
  const tick_interval = ppms < 0.05 ? 5000 : (ppms < 0.2 ? 2000 : 1000);
  const label_every = ppms < 0.1 ? 5 : (ppms < 0.5 ? 2 : 1);
  ctx.fillStyle = 'rgba(232,230,216,0.4)';
  ctx.font = "10px 'JetBrains Mono', 'Consolas', monospace";
  ctx.textBaseline = 'top';
  for (let t = 0, i = 0; t <= _studio.duration_ms + 100; t += tick_interval, i++) {
    const x = t * ppms;
    if (x > w) break;
    ctx.fillRect(x, STUDIO_RULER_HEIGHT - 6, 1, 6);
    if (i % label_every === 0) {
      ctx.fillText(_fmtMs(t), x + 3, 4);
    }
  }
  // Bottom border of ruler
  ctx.fillStyle = 'rgba(255,184,0,0.25)';
  ctx.fillRect(0, STUDIO_RULER_HEIGHT - 1, w, 1);

  // --- Lane backgrounds + dividers ---
  for (let li = 0; li < STUDIO_LANES.length; li++) {
    const y = STUDIO_RULER_HEIGHT + li * STUDIO_LANE_HEIGHT;
    if (li % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(0, y, w, STUDIO_LANE_HEIGHT);
    }
    // Divider
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, y + STUDIO_LANE_HEIGHT - 1, w, 1);
  }

  // --- Event blocks ---
  for (let i = 0; i < _studio.events.length; i++) {
    const ev = _studio.events[i];
    const lane_idx = STUDIO_LANES.findIndex(l => l.key === ev.lane);
    if (lane_idx < 0) continue;
    const lane = STUDIO_LANES[lane_idx];
    const x = ev.start_ms * ppms;
    const w_block = Math.max(2, (ev.end_ms - ev.start_ms) * ppms);
    const y = STUDIO_RULER_HEIGHT + lane_idx * STUDIO_LANE_HEIGHT + 6;
    const h_block = STUDIO_LANE_HEIGHT - 12;
    const isSelected = i === _studio.selected_idx;
    const isHover    = i === _studio.hover_idx;

    // Body
    ctx.fillStyle = lane.color;
    ctx.globalAlpha = isSelected ? 1.0 : (isHover ? 0.85 : 0.7);
    ctx.fillRect(x, y, w_block, h_block);
    ctx.globalAlpha = 1.0;
    // Outline (thicker if selected)
    ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0,0,0,0.4)';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w_block - 1, h_block - 1);
    // Label (if there's room)
    if (w_block > 50) {
      ctx.fillStyle = '#000';
      ctx.font = "bold 10px 'JetBrains Mono', 'Consolas', monospace";
      ctx.textBaseline = 'middle';
      const dur = _fmtMs(ev.end_ms - ev.start_ms);
      ctx.fillText(`${lane.label} · ${dur}`, x + 5, y + h_block / 2);
    }
  }

  // --- Scrub head ---
  const scrub_x = _studio.scrub_ms * ppms;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(scrub_x, 0);
  ctx.lineTo(scrub_x, h);
  ctx.stroke();
  // Scrub handle (top triangle)
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(scrub_x - 6, 0);
  ctx.lineTo(scrub_x + 6, 0);
  ctx.lineTo(scrub_x, 8);
  ctx.fill();

  // --- Time / event info readouts ---
  document.getElementById('studio-time').textContent =
    `${_fmtMs(_studio.scrub_ms)} / ${_fmtMs(_studio.duration_ms)}`;
  document.getElementById('studio-zoom-display').textContent =
    `${Math.round(_studio.zoom * 100)}%`;

  const info = document.getElementById('studio-event-info');
  if (info) {
    if (_studio.selected_idx >= 0 && _studio.events[_studio.selected_idx]) {
      const ev = _studio.events[_studio.selected_idx];
      info.textContent = `${ev.lane.toUpperCase()} · ${_fmtMs(ev.start_ms)} → ${_fmtMs(ev.end_ms)} · duration ${_fmtMs(ev.end_ms - ev.start_ms)}`;
    } else {
      info.textContent = `${_studio.events.length} event${_studio.events.length === 1 ? '' : 's'}`;
    }
  }
}

function _fmtMs(ms) {
  ms = Math.max(0, Math.round(ms));
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function _studioHitTest(mx, my) {
  // Returns {kind: 'event-body'|'event-left'|'event-right'|'scrub'|'lane'|'ruler', idx, lane_idx}
  const ppms = _studioPxPerMs();

  // Scrub head detection (top of canvas)
  const scrub_x = _studio.scrub_ms * ppms;
  if (my < STUDIO_RULER_HEIGHT && Math.abs(mx - scrub_x) <= 6) {
    return { kind: 'scrub' };
  }
  if (my < STUDIO_RULER_HEIGHT) return { kind: 'ruler' };

  const lane_idx = Math.floor((my - STUDIO_RULER_HEIGHT) / STUDIO_LANE_HEIGHT);
  if (lane_idx < 0 || lane_idx >= STUDIO_LANES.length) return { kind: 'none' };

  // Test event blocks on this lane
  for (let i = 0; i < _studio.events.length; i++) {
    const ev = _studio.events[i];
    if (ev.lane !== STUDIO_LANES[lane_idx].key) continue;
    const x = ev.start_ms * ppms;
    const w_block = Math.max(2, (ev.end_ms - ev.start_ms) * ppms);
    const y = STUDIO_RULER_HEIGHT + lane_idx * STUDIO_LANE_HEIGHT + 6;
    const h_block = STUDIO_LANE_HEIGHT - 12;
    if (mx >= x && mx <= x + w_block && my >= y && my <= y + h_block) {
      // Inside block — determine left edge / right edge / body
      if (mx < x + STUDIO_HANDLE_PX) return { kind: 'event-left',  idx: i, lane_idx };
      if (mx > x + w_block - STUDIO_HANDLE_PX) return { kind: 'event-right', idx: i, lane_idx };
      return { kind: 'event-body', idx: i, lane_idx };
    }
  }
  return { kind: 'lane', lane_idx };
}

function _studioSnap(ms) {
  if (_studio.snap_ms <= 0) return ms;
  return Math.round(ms / _studio.snap_ms) * _studio.snap_ms;
}

function _studioMouseDown(e) {
  const canvas = document.getElementById('studio-canvas');
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const ppms = _studioPxPerMs();
  const ms = mx / ppms;

  const hit = _studioHitTest(mx, my);

  if (hit.kind === 'scrub' || hit.kind === 'ruler') {
    _studio.drag_state = { mode: 'scrub' };
    _studio.scrub_ms = Math.max(0, Math.min(_studio.duration_ms, ms));
    canvas.classList.add('is-scrubbing');
    _studioRender();
    return;
  }
  if (hit.kind === 'event-body') {
    _studio.selected_idx = hit.idx;
    _studio.drag_state = {
      mode: 'move', idx: hit.idx,
      grab_offset_ms: ms - _studio.events[hit.idx].start_ms,
      orig_start: _studio.events[hit.idx].start_ms,
      orig_end:   _studio.events[hit.idx].end_ms,
      moved: false,
    };
    canvas.classList.add('is-dragging');
    _studioRecordSnapshot();
    _studioRender();
    return;
  }
  if (hit.kind === 'event-left') {
    _studio.selected_idx = hit.idx;
    _studio.drag_state = {
      mode: 'resize-left', idx: hit.idx,
      orig_start: _studio.events[hit.idx].start_ms,
      orig_end:   _studio.events[hit.idx].end_ms,
    };
    canvas.classList.add('is-resizing-left');
    _studioRecordSnapshot();
    _studioRender();
    return;
  }
  if (hit.kind === 'event-right') {
    _studio.selected_idx = hit.idx;
    _studio.drag_state = {
      mode: 'resize-right', idx: hit.idx,
      orig_start: _studio.events[hit.idx].start_ms,
      orig_end:   _studio.events[hit.idx].end_ms,
    };
    canvas.classList.add('is-resizing-right');
    _studioRecordSnapshot();
    _studioRender();
    return;
  }
  if (hit.kind === 'lane') {
    // Click empty space → create new event with default 2-second duration on this lane
    const lane = STUDIO_LANES[hit.lane_idx];
    const start_ms = _studioSnap(Math.max(0, ms - 1000));
    const end_ms   = Math.min(_studio.duration_ms || start_ms + 2000, start_ms + 2000);
    if (end_ms - start_ms < 100) return;  // too small, don't create
    _studioRecordSnapshot();
    const new_event = {
      lane: lane.key,
      start_ms,
      end_ms,
      params: {},  // empty params — backend uses defaults
    };
    _studio.events.push(new_event);
    _studio.selected_idx = _studio.events.length - 1;
    _studio.duration_ms = Math.max(_studio.duration_ms, end_ms);
    _studioRender();
    return;
  }
  // Click background → deselect
  _studio.selected_idx = -1;
  _studioRender();
}

function _studioMouseMove(e) {
  const canvas = document.getElementById('studio-canvas');
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const ppms = _studioPxPerMs();
  const ms = mx / ppms;

  if (_studio.drag_state) {
    const ds = _studio.drag_state;
    if (ds.mode === 'scrub') {
      _studio.scrub_ms = Math.max(0, Math.min(_studio.duration_ms, ms));
      _studioRender();
      return;
    }
    const ev = _studio.events[ds.idx];
    if (!ev) return;
    if (ds.mode === 'move') {
      const dur = ds.orig_end - ds.orig_start;
      let new_start = _studioSnap(Math.max(0, ms - ds.grab_offset_ms));
      let new_end   = new_start + dur;
      if (new_end > _studio.duration_ms) {
        new_end = _studio.duration_ms;
        new_start = new_end - dur;
      }
      ev.start_ms = new_start;
      ev.end_ms   = new_end;
      ds.moved = true;
    } else if (ds.mode === 'resize-left') {
      const new_start = _studioSnap(Math.max(0, Math.min(ev.end_ms - 100, ms)));
      ev.start_ms = new_start;
    } else if (ds.mode === 'resize-right') {
      const new_end = _studioSnap(Math.max(ev.start_ms + 100, Math.min(_studio.duration_ms, ms)));
      ev.end_ms = new_end;
    }
    _studioRender();
    return;
  }

  // Hover detection
  const hit = _studioHitTest(mx, my);
  let new_hover = -1;
  let cursor = 'crosshair';
  if (hit.kind === 'event-body') { new_hover = hit.idx; cursor = 'grab'; }
  else if (hit.kind === 'event-left' || hit.kind === 'event-right') { new_hover = hit.idx; cursor = 'ew-resize'; }
  else if (hit.kind === 'scrub')  { cursor = 'col-resize'; }
  else if (hit.kind === 'ruler')  { cursor = 'col-resize'; }
  else if (hit.kind === 'lane')   { cursor = 'crosshair'; }
  canvas.style.cursor = cursor;
  if (new_hover !== _studio.hover_idx) {
    _studio.hover_idx = new_hover;
    _studioRender();
  }
}

function _studioMouseUp(e) {
  const canvas = document.getElementById('studio-canvas');
  if (!canvas) return;
  canvas.classList.remove('is-dragging', 'is-resizing-left', 'is-resizing-right', 'is-scrubbing');
  if (_studio.drag_state) {
    // If a move-drag happened but the position is identical to original, pop the snapshot
    if (_studio.drag_state.mode === 'move' && !_studio.drag_state.moved) {
      _studio.history.pop();
      _studioUpdateUndoButtons();
    }
  }
  _studio.drag_state = null;
}

function _studioSave(saveAs) {
  if (!_studio.open || !_studio.src_path) return;
  const events_json = JSON.stringify(_studio.events);
  if (saveAs) {
    bridge.cloneRecordingForEdit(_studio.src_path).then((raw) => {
      let res = {};
      try { res = JSON.parse(raw || '{}'); } catch {}
      if (!res.ok) { toast('Save as failed: ' + (res.error || ''), 'error'); return; }
      _studioWriteSave(res.new_path, events_json);
    });
  } else {
    _studioWriteSave(_studio.src_path, events_json);
  }
}

function _studioWriteSave(dest_path, events_json) {
  bridge.saveStudioTimeline(_studio.src_path, dest_path, events_json, _studio.duration_ms).then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (res.ok) {
      toast(`Saved ${res.count} event${res.count === 1 ? '' : 's'}`, 'success');
      // If saved as new, switch to editing the new file
      if (dest_path !== _studio.src_path) {
        _studio.src_path = dest_path;
        const sub = document.getElementById('studio-subtitle');
        if (sub) {
          const fname = dest_path.split(/[/\\]/).pop() || '';
          sub.textContent = `editing ${fname}`;
        }
      }
    } else {
      toast('Save failed: ' + (res.error || 'unknown'), 'error');
    }
  });
}

// Wire studio init at DOM ready (idempotent)
(function initStudio() {
  function tryInit() {
    if (typeof bridge !== 'undefined' && bridge && bridge.getStudioTimeline) {
      setupStudio();
      return;
    }
    if ((initStudio._tries || 0) < 50) {
      initStudio._tries = (initStudio._tries || 0) + 1;
      setTimeout(tryInit, 200);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }
})();

// Expose _studioOpen so the recordings list can hook it up
window._studioOpen = _studioOpen;


// ============================================================
// Phase 5 (v3.0.0) — Network tab (LAN coordination)
// ============================================================

let _lanState = null;
let _lanRefreshTimer = null;
let _lanPairExpiresTs = 0;

function _lanFmtSecondsAgo(s) {
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function _lanRenderPeers() {
  if (!_lanState) return;
  const list = document.getElementById('lan-peer-list');
  if (!list) return;
  const peers = _lanState.peers || [];
  if (peers.length === 0) {
    list.innerHTML = `<div class="auto-empty">
      <span class="auto-empty-icon">🌐</span>
      <p>No peers discovered yet.</p>
      <p class="hint-text">Make sure LAN sync is on, both PCs are on the same network, and Windows Firewall isn't blocking Throttlr's UDP/TCP ports.</p>
    </div>`;
    return;
  }
  list.innerHTML = '';
  peers.forEach(peer => {
    const card = document.createElement('div');
    card.className = 'lan-peer-card';
    card.dataset.paired = peer.paired ? '1' : '0';
    card.dataset.running = peer.status === 'running' ? '1' : '0';

    card.appendChild(Object.assign(document.createElement('span'), { className: 'peer-status-dot' }));

    const info = document.createElement('div');
    info.className = 'peer-info';
    const nameRow = document.createElement('div');
    nameRow.className = 'peer-name';
    nameRow.textContent = peer.name || '?';
    if (peer.paired) {
      const badge = document.createElement('span');
      badge.className = 'peer-paired-badge';
      badge.textContent = 'PAIRED';
      nameRow.appendChild(badge);
    }
    info.appendChild(nameRow);
    const metaRow = document.createElement('div');
    metaRow.className = 'peer-meta';
    const statusTxt = peer.status === 'running'
      ? `running · ${peer.target || '(no target)'}` + (peer.kbps_in || peer.kbps_out ? ` · ↓${peer.kbps_in} ↑${peer.kbps_out} KB/s` : '')
      : 'idle';
    metaRow.textContent = `${peer.ip}:${peer.port} · v${peer.version} · ${statusTxt} · seen ${_lanFmtSecondsAgo(peer.last_seen_ago_s)}`;
    info.appendChild(metaRow);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'peer-actions';
    if (peer.paired) {
      const btnStart = document.createElement('button');
      btnStart.className = 'peer-btn'; btnStart.textContent = 'Start';
      btnStart.title = 'Tell this peer to start capturing';
      btnStart.addEventListener('click', () => _lanSendCmd(peer, 'start_capture'));
      const btnStop = document.createElement('button');
      btnStop.className = 'peer-btn'; btnStop.textContent = 'Stop';
      btnStop.addEventListener('click', () => _lanSendCmd(peer, 'stop_capture'));
      const btnPing = document.createElement('button');
      btnPing.className = 'peer-btn'; btnPing.textContent = 'Ping';
      btnPing.addEventListener('click', () => _lanSendCmd(peer, 'ping'));
      const btnUnpair = document.createElement('button');
      btnUnpair.className = 'peer-btn danger'; btnUnpair.textContent = 'Unpair';
      btnUnpair.addEventListener('click', () => {
        if (confirm(`Unpair from ${peer.name}? You'll need to re-pair to control it again.`)) {
          bridge.lanUnpair(peer.peer_id).then(() => _lanRefresh());
        }
      });
      actions.appendChild(btnStart);
      actions.appendChild(btnStop);
      actions.appendChild(btnPing);
      actions.appendChild(btnUnpair);
    } else {
      const btnPair = document.createElement('button');
      btnPair.className = 'peer-btn'; btnPair.textContent = 'Pair';
      btnPair.addEventListener('click', () => _lanInitiatePair(peer));
      actions.appendChild(btnPair);
    }
    card.appendChild(actions);
    list.appendChild(card);
  });
}

function _lanRenderPending() {
  const wrap = document.getElementById('lan-pending-list');
  if (!wrap) return;
  const pending = (_lanState && _lanState.pending) || [];
  if (pending.length === 0) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = '<div class="field-label">Pending pairing requests</div>';
  pending.forEach(req => {
    const card = document.createElement('div');
    card.className = 'lan-pending-card';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'pp-name'; name.textContent = req.name || '?';
    const meta = document.createElement('div');
    meta.className = 'pp-meta'; meta.textContent = `${req.ip} · expires in ${req.remaining_s}s`;
    info.appendChild(name); info.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'pp-actions';
    const accept = document.createElement('button');
    accept.className = 'peer-btn'; accept.textContent = 'Accept';
    accept.addEventListener('click', () => {
      bridge.lanAcceptPairing(req.peer_id).then(() => {
        toast(`Paired with ${req.name}`, 'success');
        _lanRefresh();
      });
    });
    const reject = document.createElement('button');
    reject.className = 'peer-btn danger'; reject.textContent = 'Reject';
    reject.addEventListener('click', () => {
      bridge.lanRejectPairing(req.peer_id).then(() => _lanRefresh());
    });
    actions.appendChild(accept); actions.appendChild(reject);
    card.appendChild(info); card.appendChild(actions);
    wrap.appendChild(card);
  });
}

function _lanRefresh() {
  if (!bridge || !bridge.lanGetState) return;
  bridge.lanGetState().then((raw) => {
    let s = {};
    try { s = JSON.parse(raw || '{}'); } catch {}
    _lanState = s;
    const tog = document.getElementById('lan-enabled-toggle');
    if (tog) tog.checked = !!s.enabled;
    const nameInput = document.getElementById('lan-display-name');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = s.my_name || '';
    _lanRenderPeers();
    _lanRenderPending();
  });
}

function _lanInitiatePair(peer) {
  const code = prompt(`Enter the 6-digit pairing code shown on ${peer.name}:\n\n(Have someone open Throttlr on ${peer.name}, go to Settings → Network, and click "Open pairing window".)`);
  if (!code) return;
  bridge.lanRequestPair(peer.peer_id, code.trim()).then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (res.ok) {
      toast(`Pairing request sent to ${peer.name}. Waiting for them to approve.`, 'success');
    } else {
      toast(`Pair failed: ${res.error || 'unknown'}`, 'error');
    }
    _lanRefresh();
  });
}

function _lanSendCmd(peer, method, params) {
  bridge.lanSendCommand(peer.peer_id, method, JSON.stringify(params || {})).then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (res.ok && res.result && res.result.ok !== false) {
      toast(`${peer.name} · ${method} · ✓`, 'success');
    } else {
      toast(`${peer.name} · ${method} · failed: ${(res.result && res.result.error) || res.error || ''}`, 'error');
    }
  });
}

function _lanOpenPairWindow() {
  bridge.lanOpenPairingWindow().then((raw) => {
    let res = {};
    try { res = JSON.parse(raw || '{}'); } catch {}
    if (!res.ok) { toast('Could not open pairing window', 'error'); return; }
    const box = document.getElementById('lan-pair-code-box');
    document.getElementById('lan-pair-code').textContent = res.code;
    _lanPairExpiresTs = Date.now() + (res.expires_s * 1000);
    if (box) box.hidden = false;
    _lanUpdatePairCountdown();
  });
}

function _lanUpdatePairCountdown() {
  const meta = document.getElementById('lan-pair-code-expires');
  const box = document.getElementById('lan-pair-code-box');
  if (!meta || !box || box.hidden) return;
  const remaining = Math.max(0, Math.floor((_lanPairExpiresTs - Date.now()) / 1000));
  meta.textContent = remaining > 0 ? `Valid for ${remaining}s` : 'Expired';
  if (remaining > 0) setTimeout(_lanUpdatePairCountdown, 1000);
  else box.hidden = true;
}

function _lanClosePairWindow() {
  bridge.lanClosePairingWindow();
  document.getElementById('lan-pair-code-box').hidden = true;
}

function setupNetworkTab() {
  document.getElementById('lan-enabled-toggle')?.addEventListener('change', (e) => {
    bridge.lanSetEnabled(e.target.checked).then(() => {
      toast(e.target.checked ? 'LAN sync enabled' : 'LAN sync paused', 'info');
      _lanRefresh();
    });
  });
  document.getElementById('lan-display-name')?.addEventListener('change', (e) => {
    bridge.lanSetDisplayName(e.target.value).then(() => _lanRefresh());
  });
  document.getElementById('lan-refresh-btn')?.addEventListener('click', _lanRefresh);
  document.getElementById('lan-pair-open-btn')?.addEventListener('click', _lanOpenPairWindow);
  document.getElementById('lan-pair-cancel-btn')?.addEventListener('click', _lanClosePairWindow);

  // Subscribe to peer-list changes
  if (bridge.lanPeerListChanged && bridge.lanPeerListChanged.connect) {
    bridge.lanPeerListChanged.connect((raw) => {
      try { _lanState = JSON.parse(raw || '{}'); } catch {}
      _lanRenderPeers();
      _lanRenderPending();
    });
  }
  // Subscribe to remote command notifications
  if (bridge.lanCommandReceived && bridge.lanCommandReceived.connect) {
    bridge.lanCommandReceived.connect((raw) => {
      let evt = {};
      try { evt = JSON.parse(raw || '{}'); } catch {}
      const sym = evt.ok ? '✓' : '✗';
      toast(`${evt.from_name || 'remote'} sent: ${evt.method} ${sym}`, evt.ok ? 'info' : 'error');
    });
  }

  _lanRefresh();
  // Auto-refresh peer list while tab is visible
  if (_lanRefreshTimer) clearInterval(_lanRefreshTimer);
  _lanRefreshTimer = setInterval(() => {
    if (!document.getElementById('studio-modal') || document.getElementById('studio-modal').hidden) {
      _lanRefresh();
    }
  }, 5000);
}

// ============================================================
// v3.0.7 — Plugins feature was removed entirely. The Plugin tab, the
// PluginManager, the PluginAPI, and all related bridge methods have
// been stripped from the build. Network tab init still needs the LAN
// bridge so keep that wire-up.
// ============================================================

(function initPhase5() {
  let tries = 0;
  function tryInit() {
    if (typeof bridge !== 'undefined' && bridge && bridge.lanGetState) {
      setupNetworkTab();
      return;
    }
    if (++tries < 50) setTimeout(tryInit, 200);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }
})();
