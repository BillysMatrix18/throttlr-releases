# Throttlr — Copyright (c) 2026 Billy Papastavros.
# All rights reserved. Proprietary and confidential.
# Unauthorized copying, modification, distribution, or
# reverse engineering is strictly prohibited.

"""
Throttlr - per-application network throttler for Windows.

Web UI version: backend logic runs in Python, UI is HTML/CSS/JS in an embedded
Chromium webview (QWebEngineView). Same features as before, gorgeous frontend.

Requires Windows 7+, Administrator, pydivert, psutil, PySide6 (with WebEngine).
"""

import sys
import os
import io
import json
import time
import random
import threading
import heapq
import ctypes
import urllib.request
import urllib.error
import subprocess
import shutil
import zipfile
import tempfile
import uuid
import socket
import hmac
import hashlib
from ctypes import wintypes
from collections import deque, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import psutil

try:
    import winsound
    HAS_WINSOUND = True
except Exception:
    HAS_WINSOUND = False

try:
    import pydivert
    HAS_PYDIVERT = True
    PYDIVERT_ERROR = None
except Exception as _e:
    HAS_PYDIVERT = False
    PYDIVERT_ERROR = str(_e)

from PySide6.QtCore import (
    Qt, QObject, QTimer, Signal, Slot, QUrl, QPoint, QRect, QFile, QIODevice,
    QPropertyAnimation, QEasingCurve, QAbstractAnimation
)
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QMessageBox, QSplashScreen, QWidget, QMenu,
    QSystemTrayIcon, QLabel, QVBoxLayout
)
from PySide6.QtGui import (
    QPixmap, QPainter, QColor, QPen, QBrush, QLinearGradient, QFont, QPolygon,
    QGuiApplication, QAction, QIcon
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEngineSettings, QWebEngineProfile
from PySide6.QtWebChannel import QWebChannel


# ============================================================
# Constants
# ============================================================

# App version. Bumped when releasing notable new features so the
# update-log modal can fire on the next launch after upgrade.
__version__ = "3.1.4"

# ============================================================
# GitHub auto-update
# ============================================================
# On launch, Throttlr asks the GitHub Releases API for the latest tag.
# If newer than __version__, the user is prompted with a yes/no modal.
# - YES → download the release zip, write a helper batch that swaps the
#         files after Throttlr exits, then relaunch the new version.
#         The new version sees last_seen_version differs from __version__
#         and automatically shows the changelog modal — that's how the
#         "what's new" detail panel appears post-update.
# - NO  → the dismissed_update_version setting is set so we don't nag
#         again for THIS version. Settings → Info still shows a badge
#         until they update or a newer version comes out.

GITHUB_OWNER = "BillysMatrix18"
GITHUB_REPO  = "throttlr-releases"
GITHUB_RELEASES_API = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
GITHUB_RELEASES_URL = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"


def _parse_version(s: str):
    """Parse 'v2.1.0' or '2.1.0-beta' into a tuple of ints for comparison.
    Non-numeric trailing chunks are stripped. Returns (0,0,0) on parse error."""
    if not s:
        return (0, 0, 0)
    s = str(s).strip().lstrip('vV')
    s = s.split('-')[0].split('+')[0]      # drop pre-release / build metadata
    parts = s.split('.')
    out = []
    for p in parts:
        digits = ''.join(c for c in p if c.isdigit())
        out.append(int(digits) if digits else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out[:3])


class UpdateChecker:
    """Background-threaded GitHub release checker. Cached per session.

    Runs once shortly after app launch so startup isn't blocked. Result is
    accessed via .get_state() which is what the bridge slot returns to JS.
    """

    def __init__(self):
        self._state = {
            "checked":   False,           # has the check completed at all
            "available": False,           # is a newer release available
            "latest":    "",              # tag name of latest, e.g. "v2.1.0"
            "current":   __version__,
            "body":      "",              # release notes from GitHub
            "html_url":  GITHUB_RELEASES_URL,
            "zip_url":   "",              # release asset download URL (if any)
            "error":     "",              # populated on failure (network, rate limit, etc.)
            "checked_at": 0,              # unix timestamp of last completed check
        }
        self._lock = threading.Lock()
        self._thread = None

    def kick_off(self):
        """Start the background check. Safe to call multiple times — only
        the first call spawns; later calls are no-ops while in flight."""
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._state["error"] = ""
            self._state["checked"] = False
        t = threading.Thread(target=self._do_check, daemon=True)
        self._thread = t
        t.start()

    def _do_check(self):
        try:
            req = urllib.request.Request(
                GITHUB_RELEASES_API,
                headers={
                    "Accept": "application/vnd.github+json",
                    "User-Agent": f"Throttlr/{__version__}",
                },
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            tag = (data.get("tag_name") or "").strip()
            body = data.get("body") or ""
            html_url = data.get("html_url") or GITHUB_RELEASES_URL
            # Find a downloadable .zip asset (preferred) or fall back to source
            zip_url = ""
            for asset in (data.get("assets") or []):
                name = (asset.get("name") or "").lower()
                if name.endswith(".zip"):
                    zip_url = asset.get("browser_download_url") or ""
                    break
            if not zip_url:
                # Fall back to the source code zipball that GitHub auto-generates
                zip_url = data.get("zipball_url") or ""

            available = _parse_version(tag) > _parse_version(__version__) and bool(tag)

            with self._lock:
                self._state.update({
                    "checked":   True,
                    "available": available,
                    "latest":    tag,
                    "body":      body,
                    "html_url":  html_url,
                    "zip_url":   zip_url,
                    "error":     "",
                    "checked_at": int(time.time()),
                })
        except urllib.error.HTTPError as e:
            with self._lock:
                self._state.update({
                    "checked": True,
                    "error":   f"HTTP {e.code}: {e.reason}",
                    "checked_at": int(time.time()),
                })
        except Exception as e:
            with self._lock:
                self._state.update({
                    "checked": True,
                    "error":   f"{type(e).__name__}: {e}",
                    "checked_at": int(time.time()),
                })

    def get_state(self):
        with self._lock:
            return dict(self._state)


# Module-level singleton — instantiated in main()
update_checker: 'UpdateChecker | None' = None


def install_update_and_relaunch(zip_url: str, latest_tag: str, progress_cb=None) -> tuple[bool, str]:
    """Download the release zip, write a Windows batch that swaps the files
    in place via retry-based xcopy, spawn it hidden, and return. Caller is
    expected to QApplication.quit() after this returns True.

    progress_cb(phase, message, extras=None) is called at major milestones.
    Phases: 'downloading' (with extras dict containing bytes_done/bytes_total/
    speed_bps/eta_seconds), 'extracting', 'preparing'. May be None.

    The helper batch logs every step to %TEMP%\\throttlr_update.log so we
    can diagnose any failures.

    v2.5.1 changes vs v2.4.1:
      - Chunked download with byte-level progress callbacks
      - Retry-based file copy instead of brittle tasklist|find process-wait
        (the old approach hung on some systems because tasklist|find pipe
         could stall when the parent process was in a UAC-elevated state)
      - STARTUPINFO with SW_HIDE to reliably hide the helper window
        (CREATE_NO_WINDOW alone wasn't enough — pipeline subprocesses inside
         the batch could still allocate their own consoles)

    Returns (ok, error_message). On success error_message is empty."""

    def _emit(phase, message, extras=None):
        if progress_cb:
            try:
                progress_cb(phase, message, extras)
            except TypeError:
                # Backward-compat: old progress_cb only accepts (phase, message)
                try:
                    progress_cb(phase, message)
                except Exception:
                    pass
            except Exception:
                pass

    if not zip_url:
        return (False, "No download URL available for the latest release.")

    try:
        # 1. Resolve install dir — the directory containing this .exe (or .py in dev mode)
        if getattr(sys, 'frozen', False):
            install_dir = os.path.dirname(sys.executable)
            exe_name = os.path.basename(sys.executable)   # e.g. Throttlr.exe
        else:
            install_dir = os.path.dirname(os.path.abspath(__file__))
            exe_name = "throttlr.py"

        # 2. Download zip to temp — chunked with progress reporting
        _emit("downloading", "Starting download…", {
            "bytes_done": 0, "bytes_total": 0, "speed_bps": 0, "eta_seconds": 0,
        })
        tmp_dir = tempfile.mkdtemp(prefix="throttlr_upd_")
        zip_path = os.path.join(tmp_dir, f"throttlr_{latest_tag or 'latest'}.zip")
        req = urllib.request.Request(zip_url, headers={"User-Agent": f"Throttlr/{__version__}"})

        chunk_size = 64 * 1024  # 64 KB
        bytes_done = 0
        # Throttle progress emits — at most every ~150ms or every ~512KB —
        # otherwise we flood the Qt signal queue with thousands of events
        last_emit_time = 0.0
        emit_interval_s = 0.15
        emit_byte_step = 512 * 1024
        last_emit_bytes = 0
        # Rolling speed: track recent (time, bytes) pairs to compute speed
        # over the last ~2 seconds. Smoother than instantaneous, less laggy
        # than total-elapsed average.
        speed_window = deque()  # (timestamp, bytes_done) tuples
        speed_window_seconds = 2.0
        start_time = time.time()

        with urllib.request.urlopen(req, timeout=60) as resp, open(zip_path, "wb") as f:
            try:
                bytes_total = int(resp.headers.get('Content-Length', 0) or 0)
            except (TypeError, ValueError):
                bytes_total = 0

            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                bytes_done += len(chunk)

                now = time.time()
                # Update rolling speed window
                speed_window.append((now, bytes_done))
                while speed_window and speed_window[0][0] < now - speed_window_seconds:
                    speed_window.popleft()

                # Decide whether to emit a progress event
                should_emit = (
                    (now - last_emit_time) >= emit_interval_s
                    or (bytes_done - last_emit_bytes) >= emit_byte_step
                )
                if should_emit:
                    if len(speed_window) >= 2:
                        t0, b0 = speed_window[0]
                        t1, b1 = speed_window[-1]
                        dt = max(t1 - t0, 0.001)
                        speed_bps = (b1 - b0) / dt
                    else:
                        elapsed = max(now - start_time, 0.001)
                        speed_bps = bytes_done / elapsed
                    if speed_bps > 0 and bytes_total > bytes_done:
                        eta_seconds = (bytes_total - bytes_done) / speed_bps
                    else:
                        eta_seconds = 0
                    _emit("downloading", "Downloading update…", {
                        "bytes_done": bytes_done,
                        "bytes_total": bytes_total,
                        "speed_bps": speed_bps,
                        "eta_seconds": eta_seconds,
                    })
                    last_emit_time = now
                    last_emit_bytes = bytes_done

        # Final 100% emit so the UI can land on a clean "complete" state
        _emit("downloading", "Download complete", {
            "bytes_done": bytes_done,
            "bytes_total": bytes_total or bytes_done,
            "speed_bps": 0,
            "eta_seconds": 0,
        })

        # 3. Extract zip to staging folder
        _emit("extracting", "Extracting files…")
        stage_dir = os.path.join(tmp_dir, "stage")
        os.makedirs(stage_dir, exist_ok=True)
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(stage_dir)

        # GitHub source zipballs nest content inside a single top-level folder
        entries = [e for e in os.listdir(stage_dir) if not e.startswith('.')]
        if len(entries) == 1 and os.path.isdir(os.path.join(stage_dir, entries[0])):
            stage_dir = os.path.join(stage_dir, entries[0])

        # 4. Write a Windows batch that:
        #    - logs every step to %TEMP%\throttlr_update.log
        #    - sleeps 3s for Throttlr to release file locks
        #    - tries xcopy; if it fails (file lock, etc.) waits 2s and retries
        #      up to 10 times. This replaces the fragile tasklist|find loop
        #      that hung on some systems in v2.4.1/v2.5.0.
        #    - relaunches Throttlr via EXPLORER.EXE — this breaks the UAC
        #      elevation chain and lets Windows trigger UAC properly.
        _emit("preparing", "Preparing installer…")
        bat_path = os.path.join(tmp_dir, "apply_update.bat")
        log_path = os.path.join(os.environ.get("TEMP", tmp_dir), "throttlr_update.log")

        install_dir_w = install_dir.replace('/', '\\')
        stage_dir_w   = stage_dir.replace('/', '\\')
        tmp_dir_w     = tmp_dir.replace('/', '\\')
        log_path_w    = log_path.replace('/', '\\')

        bat_content = f"""@echo off
setlocal enabledelayedexpansion

set LOGFILE={log_path_w}
echo. > "%LOGFILE%"
echo [%date% %time%] === Throttlr update applier started === >> "%LOGFILE%"
echo Install dir: {install_dir_w} >> "%LOGFILE%"
echo Stage dir:   {stage_dir_w} >> "%LOGFILE%"
echo Exe name:    {exe_name} >> "%LOGFILE%"
echo Strategy:    retry-based file swap (v2.5.1+) >> "%LOGFILE%"

rem 1. Brief settle delay so Throttlr can quit and Windows can release locks.
echo [%date% %time%] Sleeping 3s for file-lock release >> "%LOGFILE%"
timeout /t 3 /nobreak >nul

rem 2. Try xcopy with retries — if Throttlr.exe is still locked by a stale
rem    process, xcopy will fail and we wait 2s + retry. Max 10 attempts =
rem    ~23 seconds total before giving up.
rem    /Y = no overwrite prompt, /E = include subdirs (even empty),
rem    /I = treat dest as dir if multiple files, /Q = quiet,
rem    /R = overwrite read-only, /H = include hidden
set RETRY_COUNT=0
:trycopy
set /a ATTEMPT=!RETRY_COUNT!+1
echo [%date% %time%] Copy attempt !ATTEMPT!/10... >> "%LOGFILE%"
xcopy /Y /E /I /Q /R /H "{stage_dir_w}\\*" "{install_dir_w}\\" >> "%LOGFILE%" 2>&1
set XCOPY_EXIT=!errorlevel!
echo [%date% %time%] xcopy attempt !ATTEMPT! returned !XCOPY_EXIT! >> "%LOGFILE%"
if !XCOPY_EXIT! equ 0 goto :copydone

set /a RETRY_COUNT+=1
if !RETRY_COUNT! geq 10 (
    echo [%date% %time%] ERROR: xcopy failed after 10 attempts, aborting relaunch >> "%LOGFILE%"
    goto :cleanup
)
echo [%date% %time%] Waiting 2s before retry !RETRY_COUNT!... >> "%LOGFILE%"
timeout /t 2 /nobreak >nul
goto :trycopy

:copydone
echo [%date% %time%] Copy succeeded (took !ATTEMPT! attempt(s)) >> "%LOGFILE%"

rem 3. Brief pause so the file system settles
timeout /t 1 /nobreak >nul

rem 4. Relaunch Throttlr via EXPLORER.EXE
rem    This breaks the elevation chain — Windows treats it as a normal
rem    user-initiated launch, UAC prompts correctly, Throttlr starts with
rem    the right elevation token.
echo [%date% %time%] Relaunching via explorer.exe: {install_dir_w}\\{exe_name} >> "%LOGFILE%"
start "" explorer.exe "{install_dir_w}\\{exe_name}"
echo [%date% %time%] Relaunch command issued >> "%LOGFILE%"

:cleanup
rem 5. Wait, then clean up temp dir + this script
timeout /t 4 /nobreak >nul
echo [%date% %time%] Cleaning up temp dir >> "%LOGFILE%"
rmdir /s /q "{tmp_dir_w}" 2>nul
echo [%date% %time%] === Update applier finished === >> "%LOGFILE%"
(goto) 2>nul & del "%~f0"
"""
        with open(bat_path, "w", encoding="utf-8") as f:
            f.write(bat_content)

        # 5. v2.6.1 — VBScript wrapper for TRULY invisible updates.
        #    Even with STARTUPINFO + SW_HIDE on the cmd parent, some children
        #    (xcopy, timeout /t, start "" explorer) can flash brief consoles
        #    because Windows console allocation rules are inconsistent.
        #
        #    The bulletproof technique used by professional installers:
        #    spawn wscript.exe (which has no console) running a tiny .vbs
        #    that calls Wscript.Shell.Run("cmd /c batch", 0, False). The
        #    `0` is vbHide — propagates to ALL children, no exceptions.
        vbs_path = os.path.join(tmp_dir, "run_hidden.vbs")
        # Escape backslashes and quotes for the VBS string literal
        bat_path_vbs = bat_path.replace('"', '""')
        vbs_content = (
            'Set WshShell = CreateObject("Wscript.Shell")\r\n'
            f'WshShell.Run "cmd /c """ & "{bat_path_vbs}" & """", 0, False\r\n'
        )
        try:
            with open(vbs_path, "w", encoding="utf-8") as f:
                f.write(vbs_content)
        except Exception:
            vbs_path = None  # fallback to direct cmd spawn below

        # 6. Spawn the helper. Detached so we can quit Throttlr immediately.
        DETACHED_PROCESS         = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW         = 0x08000000
        CREATE_BREAKAWAY_FROM_JOB= 0x01000000

        flags_full = (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP |
                      CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
        flags_fallback = (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP |
                          CREATE_NO_WINDOW)

        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE

        # Prefer wscript path (no console flashes); fall back to direct cmd.
        if vbs_path and os.path.exists(vbs_path):
            spawn_argv = ["wscript.exe", "//B", "//Nologo", vbs_path]
        else:
            spawn_argv = ["cmd", "/c", bat_path]

        try:
            subprocess.Popen(
                spawn_argv,
                creationflags=flags_full,
                startupinfo=startupinfo,
                close_fds=True,
                shell=False,
                cwd=tmp_dir,
            )
        except (OSError, PermissionError):
            # Job object refuses breakaway — fall back to basic detach
            subprocess.Popen(
                spawn_argv,
                creationflags=flags_fallback,
                startupinfo=startupinfo,
                close_fds=True,
                shell=False,
                cwd=tmp_dir,
            )
        return (True, "")
    except Exception as e:
        return (False, f"{type(e).__name__}: {e}")


# Changelog data for the in-app update log modal. Newest version FIRST.
# Each entry: {"version", "date", "title", "changes": [str, ...]}
# Keep change lines short — the modal is a quick reference, not a manual.
CHANGELOG = [
    {
        "version": "3.1.4",
        "date":    "June 2026",
        "title":   "Scenario library + shareable presets",
        "changes": [
            "NEW \u00b7 Scenario library. A new Scenarios tab under Quick Presets with 40+ named, realistic network conditions \u2014 cellular (2G through 5G), broadband (dial-up to fiber), wifi, satellite, gaming latency by distance, packet-loss patterns, jitter, and extreme test cases. One click applies the condition.",
            "NEW \u00b7 Export and import presets. Save your custom presets to a file and load them back (or share them) from the Quick Presets actions row, using a native file dialog.",
        ],
    },
    {
        "version": "3.1.3.2",
        "date":    "June 2026",
        "title":   "Multi-target per-app settings + cleaner single-target exit",
        "changes": [
            "NEW \u00b7 Per-app settings in Multi-Target. When you target more than one app, a PER-APP tab bar appears above the Functions section \u2014 one tab per app. Each app gets its own independent Lag / Drop / Throttle / Freeze / Block / Fun configuration. Switch tabs to set each one; hit Start and every targeted app runs with its own settings at the same time. Throttle gives each app its own bandwidth bucket, so two throttled apps no longer share a single cap.",
            "NEW \u00b7 Turning Multi-Target off now asks which app to keep. With several apps targeted, switching back to single-target opens a small chooser so you pick the one to keep instead of it silently guessing. Leaving Multi-Target also resets all functions to a clean slate.",
            "FIXED \u00b7 Switching from Multi-Target back to one app now actually narrows the target on the engine. Before, the chosen app showed in the UI but the others could keep getting throttled and the overlay still listed every app \u2014 now only the kept app is targeted and the overlay/title updates to match.",
            "FIXED \u00b7 Per-app configurations now reliably reach the engine, so each targeted app is throttled with its own settings instead of all of them inheriting whichever tab was touched last.",
        ],
    },
    {
        "version": "3.1.3.1",
        "date":    "May 2026",
        "title":   "Bug-fix patch — profile import, speed-test apply, hotkey rebind, app picker",
        "changes": [
            "FIXED · Importing a profile now refreshes the function controls on screen instantly. Before, the imported Lag / Drop / Throttle / Freeze / Block / Fun values were applied internally but the visible toggles and fields didn't update until something else forced a redraw — and the live traffic counter could briefly flash 'NaN' the moment you imported. Both gone.",
            "FIXED · The 'apply X% of your result' buttons in the speed test now actually set the Throttle rate and switch Throttle on. They were pointing at the wrong control, so they popped a confirmation toast while silently changing nothing.",
            "FIXED · The 'rebind' button in the hotkey-conflict popup now opens Settings → Hotkeys like it's supposed to. It was wired to a button that no longer exists, so clicking it did nothing.",
            "FIXED · The application picker no longer replays its entrance animation every time the running-process list refreshes (about once a second) or as you move the cursor over it. The stagger now plays only when you open the picker or switch tabs, and the list no longer rebuilds out from under your mouse.",
            "FIXED · Removed a stray horizontal scrollbar that flickered along the bottom of the Background apps list when hovering a row.",
        ],
    },
    {
        "version": "3.1.3",
        "date":    "May 2026",
        "title":   "Visual overhaul — animations, session stopwatch, start checks",
        "changes": [
            "NEW · Full animation pass powered by anime.js. Staggered entrances when the app launches, spring modal open/close, tab content fades, toast slide-ins, function-toggle pulses, preset-apply pops, and capture-start flourishes. Buttons and cards now have hover/press micro-interactions throughout.",
            "NEW · Animations master toggle in Settings → Appearance. On by default; flip it off to disable every animation app-wide (also respects your OS 'reduce motion' setting). Genuine status indicators like the running pulse stay alive.",
            "NEW · Session stopwatch. When capture starts, a seven-segment digital clock (authentic LCD font) counts up — in the app AND on the floating overlay. Green while running; on Stop it freezes on the final time and turns red; pressing Start again resets it to 00:00.",
            "NEW · Start pre-flight checks. Clicking Start without an application selected, or without any function enabled, now tells you exactly what's wrong three ways: an inline pill beside the Start button, an in-app toast, and a screen-level popup at the top-right of your screen (visible even over a game).",
            "NEW · Redesigned loading screen. The logo springs in, rings cascade outward, the brand and checklist stagger into place, and the whole thing lifts and blurs away when the app is ready.",
            "NEW · 'Buy me a coffee' button in the header — opens Ko-fi in your default browser. Throttlr is free and always will be; this just gives anyone who appreciates it a way to chip in. Also in Settings → Info → Support development.",
            "FIXED · Speed test falsely refusing to run. It was blocking whenever a function toggle (Lag, Drop, etc.) was checked — even with capture stopped — reporting 'Throttlr is still running'. Toggles only affect the network while capture is active, so the test now blocks only when the engine is genuinely running.",
            "FIXED · Settings/modal flicker. Opening a modal within a moment of closing one could make it flash open then vanish, due to a stale close-timer firing. Modals now cancel any pending close before reopening.",
            "FIXED · Action bar no longer shifts. The Stopped↔Running label change (and the stopwatch appearing) used to nudge the SENT/RECV/DROP/DELAY/HELD stats sideways. The status block is now a locked width, so everything stays put.",
            "FIXED · Clicking 'Customize <theme>' or 'Settings' while a custom theme (Retro, Cyberpunk, etc.) was active briefly clobbered the theme back to base before re-applying. Now preserved even when unsaved.",
            "FIXED · Light-theme readability detection now samples the card/modal background (--bg-2) rather than the body background, so themes with a dark backdrop but light content surfaces are detected correctly. Detection also re-runs on every theme-change path now.",
            "IMPROVED · Lag drain loop sleeps adaptively to the next packet's deadline instead of polling every 1ms — slightly better timing, less CPU when Lag is enabled.",
            "NEW · Prominent 'Update available' banner at the top of Settings → Info — hazard-stripe border, pulsing highlight, and a direct 'Install now' button.",
        ],
    },
    {
        "version": "3.1.1",
        "date":    "May 2026",
        "title":   "Splash hang fix + global hotkeys + Speed Test + per-app preview",
        "changes": [
            "NEW · 'Test my Speed' tool — comprehensive Cloudflare-based speed test. Measures latency + jitter (6 pings), then download (150MB) and upload (75MB) with live animated gauges. Refuses to run while capture is active so throttle/lag don't skew results. Final report shows verdict tier (15 named ladder from 'Dial-up' to 'Ridiculous'), per-capability descriptions, latency + jitter grades, connection symmetry note, AND a full network details block (ISP, AS number, public IP, geolocation, adapter name, adapter type, local IP, gateway, DNS servers).",
            "IMPROVED · Per-app preset restore prompt now shows you exactly what's about to be restored — every active function (Lag, Drop, Throttle, etc.) with its specific settings (ms / KB/s / drop chance / pattern / quotas / etc.) listed before you decide. No more flying blind when accepting saved configs.",
            "NEW · Hotkey conflict popup — when another app (Discord, OBS, Steam, etc.) has globally claimed one of Throttlr's hotkeys, a dismissable warning modal explains why it won't fire globally and offers a shortcut to the hotkey settings. Previously this failure was silent.",
            "FIXED · Global hotkeys (F5/F8/F9/F10) now work system-wide on built .exe releases. Root cause: the low-level keyboard hook approach silently fails inside PyInstaller's bootloader context (error 126), so hotkeys would only fire when Throttlr was the focused window. Reverted keyboard hotkeys to using Windows' RegisterHotKey API — which is the simpler, safer, more battle-tested approach that worked reliably in earlier Throttlr versions. Heads-up: RegisterHotKey is first-come-first-served, so if Discord, OBS, or Steam has globally bound the same key (e.g. F5), Throttlr's hotkey won't fire. Bind to a less-common combo if that happens. Mouse-button hotkeys (Mouse3/4/5) still use the low-level mouse hook since RegisterHotKey doesn't support mouse buttons.",
            "FIXED · Splash hanging at 0% on some machines. Root cause was actually two stacked issues: (1) Tailwind CSS loaded synchronously from its CDN, blocking all subsequent scripts if the CDN was slow. (2) An accidental duplicate `let _sessionStart` declaration in app.js — a fatal JS parse error that prevented the entire frontend from loading. Both fixed.",
            "IMPROVED · Lag function drain precision — reduced batching window from 5ms to 1ms so bursty traffic (TCP window flushes) gets smoother spacing on release. Heads-up though: Discord, games, and video apps have jitter buffers that adapt to latency by briefly speeding playback to catch up — that's their design, not a Throttlr bug. For a consistently laggy feel, pair Lag with Throttle (bandwidth limit) or use Drop.",
            "FIXED · Global hotkeys (F5 / F8 / F9 / F10) silently dying after a while. Windows has a hidden quirk where it removes your low-level keyboard hook if the callback ever takes more than 300ms — once removed, no more error, no more hotkeys until you restart Throttlr. Two changes: (1) the hook callback is now genuinely lock-free using an atomic frozenset, so it can never block on Python GIL contention. (2) A watchdog re-installs the hook every 30 seconds regardless of state, so even if Windows yanks it, you're never more than 30s away from working hotkeys again. End result: hotkeys now work reliably no matter what app has focus, even after hours of use.",
            "NEW · Startup logging — every launch now writes a timestamped log to %USERPROFILE%\\.throttlr\\startup.log so any future startup hang can be diagnosed without console access.",
            "NEW · Splash timeout fallback — if the JS-Python bridge fails to connect within 8 seconds, the splash now shows a clear error message instead of hanging at 0% forever.",
            "IMPROVED · Tray icon and hotkey watchdog setup now caught by defensive try/except — a failure in either subsystem can no longer block Throttlr from launching.",
        ],
    },
    {
        "version": "3.1.0",
        "date":    "May 2026",
        "title":   "Big update — tour, polish, network visibility, real-network testing",
        "changes": [
            "NEW · CLI launch arguments — `throttlr.exe --app discord.exe --lag 200 --start` and similar. Supports --app, --lag, --drop, --throttle, --block, --start, --version. Use for desktop shortcuts that open Throttlr already-configured.",
            "NEW · System tray icon — right-click for quick toggles (Start/Stop, Freeze, Block, Fun mode) without opening the main window. Left-click raises Throttlr. Menu labels update live to reflect current state.",
            "NEW · Dedicated latency chart in Settings → Network — full-width cyan-on-grid line with Y-axis labels and an empty-state hint when the probe is idle. Independent from the smaller overlay on the main traffic graph.",
            "NEW · Session summary toast — when you stop capture, a toast surfaces total packets, MB, drop %, lag count, and duration. Skips if the session was < 1s or trivial.",
            "NEW · Auto-pause-on-idle warning — opt-in in Settings → Behavior. Surfaces a toast when the target app has gone quiet for the configured threshold (default 30s). Doesn't auto-stop, just nudges.",
            "IMPROVED · Tour 'Try it now → Open app picker' now hand-holds the first pick — nudges with a tip toast and confirms success when you select something.",
            "NEW · Test my internet wizard (Settings → Network) — runs a real download speedtest against Cloudflare, then offers one-click 'apply 30% / 50% / 70% / 3G-feel' throttle buttons. No more guessing what KB/s feels like real bad internet.",
            "NEW · Bandwidth quota — set a daily MB cap; when the targeted app crosses it, auto-apply throttle / block / notify. Counter resets at midnight. 'Stop Steam after 5GB so it doesn't kill my hotspot.'",
            "NEW · DNS chaos mode — one toggle drops every outbound DNS query, simulating a broken DNS server. Independent of the Drop function. Apps using DNS-over-HTTPS bypass this (as expected).",
            "NEW · Bursty drop pattern — Drop function now supports clustered drops with configurable burst length + gap, in addition to the existing uniform-random mode. Much more realistic for testing real bad wireless and congested networks.",
            "NEW · Latency probe — pings a configurable host (default 1.1.1.1) once per second, draws RTT as a cyan overlay line on the main traffic graph, shows last / avg / min / max in Settings → Network. Independent of capture state.",
            "NEW · Live Packet Dump — tools rail entry that opens a live tcpdump-style tail of packet headers. Filter input, pause/resume, auto-scroll. Polled at 5Hz with bounded render so it stays smooth.",
            "IMPROVED · First-run tour rebuilt — branching paths (Gamer / Dev tester / Just exploring), spotlight overlays that point at the real UI, 'Try it now' buttons that actually do the thing, and a success page tailored to your chosen path.",
            "NEW · Replay the first-run tour from Settings → Info anytime.",
            "NEW · Settings search bar — type to filter every option across every tab. Matching rows highlight, tabs with matches show a badge, non-matches dim.",
            "NEW · WinDivert filter preview in Settings → Info (read-only) — see the actual filter string Throttlr is feeding to the kernel driver.",
            "IMPROVED · Crash modal now has a 'Copy report to clipboard' button — paste the full report straight into Discord / a bug report / wherever.",
        ],
    },
    {
        "version": "3.0.9",
        "date":    "May 2026",
        "title":   "Settings → Info polish",
        "changes": [
            "IMPROVED · System diagnostics now show CPU, memory, hostname, network adapter count, build mode, and Python runtime alongside the existing Platform/Privileges/WinDivert/Engine rows.",
            "REMOVED · 'Report a bug' and 'Latest release' buttons from the Info tab. The 'View changelog' button stays.",
            "FIXED · About blurb in Info tab no longer claims Throttlr is free and open source under MIT — text now reflects the proprietary licensing.",
        ],
    },
    {
        "version": "3.0.8",
        "date":    "May 2026",
        "title":   "Closed-source migration & auto-updater fix",
        "changes": [
            "FIXED · Auto-updater now points at the new public releases repo (throttlr-releases). Update checks work correctly going forward.",
            "INTERNAL · Project migrated to closed-source proprietary licensing. Source code is no longer publicly available.",
            "INTERNAL · Removed MIT license. Throttlr is now © 2026 Billy Papastavros, all rights reserved.",
        ],
    },
    {
        "version": "3.0.7",
        "date":    "May 2026",
        "title":   "Mouse hotkeys · Process tree picker · Filter script diagnostics · Plugins removed",
        "changes": [
            "NEW · Connected Processes — opt-in toggle (default OFF) below the app picker. When OFF, Throttlr targets every related process automatically (same as before). When ON, the panel becomes interactive: tick/untick individual subprocesses to include or exclude them. For Chrome this is huge — the actual network IO happens in a separate 'Network Service' subprocess (highlighted in green when detected) while the main browser does almost no traffic. Expand the panel to see PIDs + command-line args so you can identify exactly which subprocess does what.",
            "NEW · Filter Script modal now shows live runtime stats while open — packets evaluated, matched, match rate %, and eval errors. Watch the counters tick up in real time so you can SEE whether your expression is firing instead of guessing.",
            "NEW · Smart hints in the script modal surface when something looks off — script enabled but zero packets evaluated, 10K+ evaluated with zero matches, or majority erroring. Each hint tells you the likely cause.",
            "NEW · Last eval error is shown in the diagnostics panel — if your expression throws an exception (typo, undefined name) you see the real Python error instead of silently getting zero matches.",
            "NEW · Built-in 'How filter scripts work' explainer in the script modal — step-by-step testing flow plus the gotchas that bite people (pkt.host being empty for most packets, QUIC vs TCP for YouTube, GeoIP requirement for pkt.country, etc.).",
            "NEW · 'Tested expressions that visibly work' section with the four most reliable expressions. random() < 0.3 is the recommended sanity check.",
            "NEW · Side mouse buttons can now be hotkeys — Mouse3 (middle click), Mouse4 (back/X1), Mouse5 (forward/X2). Left/right click intentionally excluded so they don't swallow UI clicks. Bind via Settings → Hotkeys, then press the side button you want.",
            "NEW · Low-level mouse hook for system-wide mouse hotkeys. Side buttons fire in fullscreen games same as keyboard hotkeys.",
            "NEW · 'How to Use' tab added at the end of Settings — plain-English walkthrough of what Throttlr is, how to pick an app, what each function does, hotkey defaults, themes, and the floating overlay.",
            "NEW · Customize moved to its own modal-head CTA button. When a custom theme with customizable colors is active, '🎨 Customize <Theme>' appears in the Settings header. Click it to switch to the Customize pane.",
            "NEW · Text color is now customizable in Retro, Frutiger Aero, Liquid Glass, Cyberpunk, and Terminal themes. Pick exact ink/text color via the Customize pane.",
            "REMOVED · The plugins feature has been removed entirely. The Plugins tab, the PluginAPI / PluginManager classes, the bridge methods that exposed plugin operations to the UI, and the folder watcher have all been stripped. The `plugins_enabled` settings key is kept as a no-op so old settings files still parse cleanly.",
            "FIXED · Gradient picker labels (TOP-LEFT, TOP-RIGHT, BOTTOM-RIGHT) were getting cut off when 3+ stops squeezed into one row. Each stop's label now sits on its own line above the color picker.",
            "FIXED · Buttons in Retro, Frutiger Aero, and Terminal themes were getting clipped at the edges due to a base parallelogram clip-path that's right for the industrial theme but wrong for these. Force clip-path:none across all button selectors in those themes — buttons render as proper rectangles/pills.",
            "FIXED · Tabs in Liquid Glass and Frutiger Aero had a hard 'cut at the bottom' line where they met the body. Tabs are now fully-rounded pills.",
        ],
    },
    {
        "version": "3.0.6",
        "date":    "May 2026",
        "title":   "Overlay theme integration + 5 new community themes",
        "changes": [
            "NEW · The floating overlay now follows your active custom theme — Liquid Glass, Cyberpunk, Frutiger Aero, Terminal, and Retro all repaint the overlay to match. The overlay also picks up your customized accent (e.g. dragging Pink in Retro's customizer instantly tints the overlay).",
            "NEW · Live overlay preview when picking themes — clicking a theme tile in Settings updates the overlay immediately, not only after Save. Dragging color pickers in the customizer updates the overlay accent in real time. Cancel restores the saved theme.",
            "NEW · 5 themes now in the gallery at throttlr-themes.netlify.app — Liquid Glass (frosted dark with customizable accent), Terminal (phosphor green CRT), Frutiger Aero (sky/grass/water photo with Ken Burns drift, glassy pill buttons), Cyberpunk (neon HUD with notched panels + scan lines + targeting reticles), Retro (Y2K kidcore: cream panels, chunky black borders, coral pink + sky blue, Pixelify Sans).",
            "FIXED · Hotkeys silently broke when a custom theme was active. OverlayWindow._build_palette() was throwing on malformed theme_customizations data, which propagated up through __init__ and aborted MainWindow initialization BEFORE _rebind_hotkeys() could run. F5 / F8 / F9 / F10 just stopped doing anything. Wrapped the custom-theme branch in try/except + added isinstance guards so no settings weirdness can ever break hotkey registration again.",
            "FIXED · Theme flash when opening Settings. Opening Settings briefly flashed Industrial styling for ~250ms because applyAppearance / populateSettingsUI / cancelSettings called applyDesign() unconditionally then re-applied the custom theme on a timeout. Now they check for an active custom theme and skip the bounce entirely.",
            "FIXED · CRT scanlines bleeding through transparent themes. The built-in .crt-scanlines / .crt-noise / .crt-vignette overlay was painting horizontal stripes through every transparent panel on Liquid Glass, Frutiger Aero, Cyberpunk, and Terminal. Hidden on those themes (same approach Midnight uses).",
            "FIXED · Industrial hazard tape on soft themes. The diagonal pink/black hatching at top and bottom of the window is Industrial decoration — hidden on Retro, Frutiger Aero, and Liquid Glass.",
            "FIXED · Decorative L-bracket panel corners. .panel-corners and .panel-corners-2 were drawing little angular cyan brackets on every panel — hidden on Retro, Liquid Glass, and Cyberpunk where they clashed with the rounded/notched aesthetics.",
            "POLISH · Network Topology view now styled per theme — cream lavender grid for Retro, frosted glass for Frutiger Aero, neon HUD with magenta center glow for Cyberpunk, phosphor green grid for Terminal. No more dark canvas with yellow grid bleeding through every aesthetic.",
            "POLISH · Modal overlay backdrop (the dimmed bg behind dialogs) now matches each theme — lavender for Retro, deep sea-blue with heavy blur for Frutiger Aero, magenta radial glow for Cyberpunk, frosted heavy blur for Liquid Glass, pure black for Terminal.",
            "POLISH · Retro action bar contrast — the bottom strip with Stopped / SENT / DROP / Start was painting on the same cream as the function rows above it and blending in. Bumped to a darker beige + chunky 2px black top border + offset shadow for clear visual separation.",
            "POLISH · Themes gallery now uses a same-origin /themes/_index.json generated by a Netlify build script on every deploy, replacing the GitHub API approach (rate limits, CORS issues, stale caching). Loads instantly, no API quotas.",
        ],
    },
    {
        "version": "3.0.5",
        "date":    "May 2026",
        "title":   "Custom themes — drop-in CSS theming with live customization",
        "changes": [
            "NEW · Custom themes folder. Drop a paired .json manifest + .css file into your Throttlr profile's themes/ folder and they appear as tiles in Settings → Appearance. Click Open themes folder to find it, Rescan to pick up new files without restarting.",
            "NEW · Per-theme color customization. Themes can declare a `customizable` array in their manifest with color or gradient pickers. The customizer panel renders inline below the theme tiles when an installed theme is active — drag the picker, see the change instantly. Settings persist per-theme so each one remembers its dial-in.",
            "NEW · Themes gallery at throttlr-themes.netlify.app — browse, preview, and download community themes. Each theme is just a JSON + CSS pair, no installer needed. Click More themes in Settings → Appearance to open it.",
            "NEW · Bridge API for themes — listInstalledThemes(), loadThemeCss(filename), openThemesFolder(), openThemesGallery(), getThemesGalleryUrl(). Path-traversal protected so a malicious theme can't escape the themes directory.",
            "POLISH · body[data-custom-theme=\"<id>\"] selector for active custom theme (separate from data-design which is reserved for built-in color schemes). Custom CSS layered on top of the chosen base design.",
        ],
    },
    {
        "version": "3.0.4",
        "date":    "May 2026",
        "title":   "Hotkey reliability + Optimised theme",
        "changes": [
            "FIXED · Hotkeys now work reliably in fullscreen games + when other apps have grabbed the same key. The old code used Windows RegisterHotKey which silently failed if Discord overlay, OBS, Steam, or the game itself had already registered the same global hotkey — your F5 went to that other app instead of Throttlr. Replaced with a system-wide low-level keyboard hook that intercepts keypresses BEFORE any app processes them. Same keys, never conflicts.",
            "NEW · Click-to-set keybinds — click any hotkey field, press a key, done. No more scrolling through dropdowns. Esc cancels, Backspace unbinds. Supports any letter, digit, F-key, arrow, numpad, or punctuation key.",
            "NEW · Optimised theme — fourth design option for low-end hardware. Solid colors only, no gradients, no animations, no glow effects, system fonts. The fastest possible render path.",
            "POLISH · Changelog modal cleaned up — older versions now collapsed by default, click to expand. Stops the modal feeling overwhelming when there are 30+ versions of history. Current version + last-seen-version always start expanded so you see what's relevant.",
            "FIXED · Untagged v1.0.0 changelog items were rendering as empty rows — added the NEW prefix so they get proper badges like every other entry.",
        ],
    },
    {
        "version": "3.0.3",
        "date":    "May 2026",
        "title":   "Windows 7 theme + overlay polish",
        "changes": [
            "NEW · Windows 7 theme — third design option alongside Industrial and Midnight. Aero glass titlebars, cornflower blue accents, gradient buttons, rounded corners, drop shadows, Segoe UI font. The full late-2000s Microsoft software vibe.",
            "POLISH · Overlay Midnight theme redesigned to actually feel like Midnight — deep navy background (#0a0e1a, matching the main app), soft accent gradient bar instead of harsh hazard zigzag, subtle glow border when running. No more 'industrial-with-blue-tint' look.",
            "POLISH · Overlay also gets the Windows 7 chrome treatment when that theme is selected — Aero glass gradient bar with white shine on top edge, frost-blue subtle border.",
            "FIXED · Changelog modal items with POLISH tag had no badge so they appeared empty/cramped. Added the missing POLISH badge (purple POL chip) plus bumped font to 13px, brighter text color, more vertical breathing room, wider badge column, and a subtle left rail for visual rhythm. Items are now actually readable.",
        ],
    },
    {
        "version": "3.0.2",
        "date":    "May 2026",
        "title":   "Overlay theming",
        "changes": [
            "NEW · The floating overlay now follows your selected theme — Industrial keeps its hazard yellow, Midnight tints the overlay accent + background to match your selected accent variant (aurora, sunset, forest, amber, rose, ocean, or your custom color)",
            "NEW · Overlay theme updates live when you change themes in Settings — no restart needed",
            "POLISH · Status colors (drop=red, running=green, replay=cyan) intentionally stay constant across themes — semantic meaning takes priority over visual coherence",
        ],
    },
    {
        "version": "3.0.1",
        "date":    "May 2026",
        "title":   "Polish & post-launch fixes",
        "changes": [
            "FIXED · App crash on launch — SettingsManager.get() didn't accept a default arg, breaking LANCoordinator init. All 23 callers across automation/LAN/plugins now work.",
            "POLISH · Changelog modal is now properly scrollable with a themed scrollbar — no more squashed unreadable bullets",
            "POLISH · 'Vibes' preset tab renamed to 'Chaos' — better describes what's in it (SPIKE, DDOS BLOCK, Connection Killer, etc.)",
            "POLISH · Every icon in the app redrawn — bolder 2.4 stroke, round caps, more distinctive shapes. All monochrome via currentColor so they pick up theme tint cleanly.",
        ],
    },
    {
        "version": "3.0.0",
        "date":    "May 2026",
        "title":   "Phase 5 — Multi-machine LAN + Plugin system (the finale)",
        "changes": [
            "NEW · Multi-machine LAN coordination — control Throttlr running on other PCs on your network",
            "NEW · Auto-discovery via UDP broadcast — peers announce themselves every 5 seconds",
            "NEW · Secure pairing with 6-digit codes — only paired peers can be controlled",
            "NEW · Broadcast commands — start/stop capture, apply preset, toggle functions across all paired peers at once",
            "NEW · Live peer status — see each peer's running state, target app, and current bandwidth",
            "NEW · Settings → Network tab — manage discoverability, paired peers, and pairing requests",
            "NEW · Plugin system — drop .py files into the plugins folder for custom backend extensions",
            "NEW · Plugin lifecycle hooks: on_load, on_unload, on_capture_start, on_capture_stop, on_packet",
            "NEW · Settings → Plugins tab — discover, enable, disable, and view plugin status",
            "NEW · Bundled example plugin demonstrating the API",
            "NEW · 'Open plugins folder' shortcut for easy plugin install",
            "POLISH · This is v3.0.0 — major version bump marking the completion of the original 5-phase roadmap",
        ],
    },
    {
        "version": "2.7.0",
        "date":    "May 2026",
        "title":   "Phase 4 — Throttlr Studio (visual timeline editor)",
        "changes": [
            "NEW · Throttlr Studio — visual timeline editor for recorded sessions",
            "NEW · Open any .thrtlrec recording in a multi-lane timeline view (one lane per function)",
            "NEW · Function-on/off events render as colored blocks on their lane",
            "NEW · Drag any block to move it in time, drag the edges to resize",
            "NEW · Click empty timeline space to add a new event there",
            "NEW · Click a block to select it; press Delete to remove it",
            "NEW · Scrub head — drag to jump to any point in the timeline",
            "NEW · Snap-to-grid options (off / 100ms / 1s) for clean event boundaries",
            "NEW · Undo and redo (Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z) — full edit history",
            "NEW · Zoom in/out on the timeline via mouse wheel or +/- keys",
            "NEW · Save back over the original recording, or 'Save as' to a new file",
            "FIXED · Changelog modal now uses unambiguous wording — 'Updated from vX to vY' — and handles weird states (downgrade, stale settings) gracefully",
            "FIXED · Auto-update no longer flashes brief cmd windows for xcopy/timeout children — now uses a wscript.exe + .vbs wrapper which truly hides everything (vbHide propagates to all descendants)",
        ],
    },
    {
        "version": "2.6.0",
        "date":    "May 2026",
        "title":   "Phase 3 — Automation Rules Engine",
        "changes": [
            "NEW · Define rules of the form 'when X, then Y' that fire automatically",
            "NEW · Conditions: schedule (time + weekday window), app-running, bandwidth threshold, connection-count threshold",
            "NEW · Actions: apply a quick preset, toggle any function on/off, show a toast notification, start/stop capture",
            "NEW · Settings → Automation tab — manage rules with one-click enable/disable per rule",
            "NEW · Edge-triggered evaluation — rules fire once when condition becomes true, won't spam",
            "NEW · Master switch in the tab header to disable the entire engine without losing rules",
            "FIXED · Auto-update no longer hangs when a stale Throttlr.exe lingers (rolled in from v2.5.1)",
            "FIXED · Helper batch is now properly hidden during update (rolled in from v2.5.1)",
            "FIXED · Dot positions on the Geo Map no longer shift when other connections come/go (rolled in from v2.5.2)",
            "FIXED · App no longer lags after clicking Stop (rolled in from v2.5.2)",
            "NEW · Live download progress bar with MB/speed/ETA during update (rolled in from v2.5.1)",
            "NEW · Click any Inspector row for full connection details (rolled in from v2.5.2)",
            "NEW · Export connections as CSV (rolled in from v2.5.2)",
            "NEW · Topology view reworked — country clusters, bidirectional flow, idle fade, click for details (rolled in from v2.5.2)",
            "NEW · Map info bar showing countries, connections, bandwidth, top country (rolled in from v2.5.2)",
            "POLISH · Brighter map continents, sharper grid, stronger dot glow (rolled in from v2.5.2)",
            "POLISH · Bigger hitboxes on overlay layout toggles (rolled in from v2.5.2)",
        ],
    },
    {
        "version": "2.5.2",
        "date":    "May 2026",
        "title":   "Phase 2 polish — Map glow-up, Inspector detail view, Topology rework",
        "changes": [
            "NEW · Geo Map looks much better — brighter continents, sharper grid, glowing pulse rings, animated country trails",
            "NEW · Map stats bar — live counts of countries, connections, and total in/out bytes above the map",
            "NEW · Click any connection in the Inspector table to open a full detail panel with all bytes/packets/timing data",
            "NEW · Export connections as CSV from the Inspector — full snapshot, opens cleanly in Excel/Sheets",
            "NEW · Topology rework — connections now grouped into country clusters, bidirectional packet flow on edges, click any node for full details, idle nodes fade visually",
            "FIXED · Connection dots no longer jitter/jump between map refreshes — positions are now stable per remote address, not based on array order",
            "FIXED · App lag for ~1 second after clicking Stop — capture shutdown now runs on a background thread so the UI stays responsive",
            "NEW · Bigger click areas on the overlay layout toggles — the visual size is unchanged but the hitbox extends further so they're easier to hit",
        ],
    },
    {
        "version": "2.5.1",
        "date":    "May 2026",
        "title":   "Hotfix — auto-updater UX",
        "changes": [
            "FIXED · Auto-update no longer hangs when a stale Throttlr.exe lingers — replaced fragile process-wait with a retry-based file swap that just keeps trying for ~25 seconds",
            "FIXED · Helper batch is now properly hidden — no more black cmd window popping up during update (was caused by tasklist|find spawning its own console)",
            "NEW · Live download progress bar with MB downloaded, transfer speed, and time-remaining estimate",
            "NEW · Update modal is locked during install — close button + 'Not now' disabled so the install can't be accidentally interrupted",
            "NEW · More detailed update log at %TEMP%\\throttlr_update.log — every retry attempt is recorded for debugging",
        ],
    },
    {
        "version": "2.5.0",
        "date":    "May 2026",
        "title":   "Phase 2 — Network Geo Map",
        "changes": [
            "NEW · Connection Inspector now has a Map view — see your app's connections plotted on a world map in real time",
            "NEW · Each remote endpoint shows as a glowing dot at its country's location, sized by total bytes transferred",
            "NEW · Hover any dot to see the hostname, IP, country, and traffic stats",
            "NEW · Active connections pulse, idle ones fade to muted",
            "NEW · Toggle between Table view and Map view in the Inspector header",
            "NEW · Country center coordinates for ~250 countries embedded — no external lookup required",
        ],
    },
    {
        "version": "2.4.1",
        "date":    "May 2026",
        "title":   "Hotfix — auto-update relaunch on Program Files installs",
        "changes": [
            "FIXED · Auto-update now actually swaps files and relaunches when Throttlr is installed in Program Files",
            "FIXED · Helper batch uses explorer.exe to launch the new Throttlr — breaks the UAC elevation chain that was silently killing the relaunch",
            "FIXED · Helper batch process now fully detaches from Throttlr's job object so it survives the app exit",
            "NEW · Auto-update activity logs to %TEMP%\\throttlr_update.log for debugging if anything goes wrong",
        ],
    },
    {
        "version": "2.4.0",
        "date":    "May 2026",
        "title":   "Phase 1 — Killswitch, Profiles, Enhanced Graph",
        "changes": [
            "NEW · Global killswitch hotkey — instantly disables all 6 functions from anywhere (no default binding, set in Hotkeys settings)",
            "NEW · Profile import/export — save your full configuration (target apps, function settings, presets, filter script, theme) as a .throttlr file",
            "NEW · Drop a .throttlr file on the app window to import a profile",
            "NEW · Bandwidth graph upgrade — peak / average / total readouts above the graph, with proper KB/s and MB/s axis labels",
            "NEW · Drop indicator on the graph — small red marks where packet drops occurred",
            "NEW · Settings → Profile tab for the import/export controls",
        ],
    },
    {
        "version": "2.3.0",
        "date":    "May 2026",
        "title":   "Proper Windows installer",
        "changes": [
            "NEW · Real Windows installer (Throttlr-Setup.exe) — replaces the zip-extract install flow for new users",
            "NEW · Installs Throttlr to Program Files with Start Menu + optional Desktop shortcuts",
            "NEW · Proper uninstaller registered in Windows 'Add or Remove Programs'",
            "NEW · MIT license shown during install",
            "NEW · Optional 'Launch Throttlr after install' checkbox on the final wizard page",
        ],
    },
    {
        "version": "2.2.1",
        "date":    "May 2026",
        "title":   "Hotfix — UI freeze on update apply",
        "changes": [
            "FIXED · App no longer freezes when clicking 'Yes, update now' — download now runs in a background thread",
            "NEW · Live progress on the update button: 'Downloading…' → 'Extracting…' → 'Preparing…' → 'Restarting…'",
            "FIXED · App relaunch after update is now more reliable — explicit working directory + extra time for file handles to release",
        ],
    },
    {
        "version": "2.2.0",
        "date":    "May 2026",
        "title":   "Polished Info screen + system diagnostics",
        "changes": [
            "NEW · System diagnostics in Settings → Info — Windows version, admin status, WinDivert driver status",
            "NEW · 'Last checked' timestamp next to update status so you know how fresh the info is",
            "NEW · 'Report a bug' button opens a pre-filled GitHub issue",
            "NEW · Color-coded status pills (green = up to date, yellow = update available, red = error)",
            "RENAMED · Cleaner copy throughout the Info tab — clearer labels, less jargon",
            "REMOVED · 'Source code on GitHub' button (link still available via the repo URL in the bug report flow)",
        ],
    },
    {
        "version": "2.1.0",
        "date":    "May 2026",
        "title":   "Auto-update from GitHub",
        "changes": [
            "NEW · Throttlr now checks GitHub on every launch for new releases",
            "NEW · One-click in-app update — downloads, swaps files, restarts",
            "NEW · Settings → Info tab shows current version, latest version, and update status",
            "NEW · 'Not now' option remembers your choice until a newer release ships",
            "NEW · Manual 'Check now' button in Settings → Info to force a re-check",
            "NEW · Direct links to the GitHub repo and latest release page",
            "FIXED · After an update, the 'What's New' changelog now fires automatically on first launch of the new version",
        ],
    },
    {
        "version": "2.0.0",
        "date":    "May 2026",
        "title":   "Phase 2 + Phase 3 — the big one",
        "changes": [
            # Phase 2 features
            "NEW · Connection Inspector — see every connection your app makes",
            "NEW · HTTPS hostname inspector via TLS SNI parsing",
            "NEW · Domain blocklist — Ads / Trackers / Telemetry built-in lists + custom",
            "NEW · Geo blocking by region (12-region picker grid)",
            "NEW · Practice Ping mode — feel real high-ping gameplay",
            "NEW · Recording & Replay sessions (.thrtlrec format)",
            "NEW · Replay viewer with scrub bar + Play/Pause + speed selector (0.25× to 10×)",
            # Phase 3 features
            "NEW · Network Topology — live force-graph of remote endpoints",
            "NEW · PCAP capture — exports standard libpcap (Wireshark-compatible)",
            "NEW · Filter Script — sandboxed expression evaluator (AST-based)",
            # UI / layout
            "NEW · Side tool rail on the right edge, 7 advanced tools",
            "NEW · 25 SVG icons replacing every emoji (Lucide-style, MIT licensed)",
            "NEW · 8 distinct preset card icons (skull / snowflake / snail / phone / signal bars / satellite)",
            "NEW · 'Open folder' buttons in Recordings and PCAP modals",
            "NEW · 'View recordings' entry point",
            "NEW · First-launch tutorial (this thing) — re-watchable from Settings",
            "NEW · Update log on version change (this other thing)",
            "NEW · 28 new bridge slots (15 Phase 2 + 13 Phase 3)",
            # Fixes
            "FIXED · Per-app preset auto-save (was completely broken — never triggered)",
            "FIXED · Per-app preset prompt deduplicates per-session, skips empty configs",
            "FIXED · Bridge async pattern (getRecentApps / getPerAppPreset / getAchievements / getUserPresets)",
            "FIXED · Stats now reset on every Start — no more stale counters",
            "FIXED · Loading screen 'BY BILLY'S MATRIX' spacing under THROTTLR title",
            "FIXED · Record button no longer auto-opens recordings modal on stop",
            "FIXED · Toolbar text contrast (warm cream over dim grey)",
            "FIXED · Replay scrub slider properly themed (was default browser blue)",
            "FIXED · Cluttered action bar (tools moved out to the side rail)",
            # Layout / cleanup
            "RENAMED · 'Game Killer' preset → 'Connection Killer'",
            "RENAMED · 'Replay' button → 'View recordings'",
            "REMOVED · 'Voice Lag' preset",
            "REMOVED · Cramped horizontal toolbar from action bar",
        ],
    },
    {
        "version": "1.0.0",
        "date":    "Earlier",
        "title":   "Initial release + Phase 1",
        "changes": [
            "NEW · Per-app network throttling (lag, drop, throttle, freeze, block, fun)",
            "NEW · Quick presets, per-app memory, recent apps",
            "NEW · Multi-target mode, drag-drop .exe targeting",
            "NEW · Sound effects, animated tray icon",
            "NEW · Stream-safe overlay, ghost mode",
            "NEW · 10 achievements with toast notifications",
            "NEW · Industrial + Midnight designs (6 accent variants)",
            "NEW · Crash reporter, DNS-only drop, reset-on-start",
        ],
    },
]

DELAY_QUEUE_CAP = 200_000
FREEZE_QUEUE_CAP = 1_000_000

WM_HOTKEY = 0x0312
PM_REMOVE = 0x0001
VK_F5 = 0x74
VK_F8 = 0x77
VK_F9 = 0x78
VK_F10 = 0x79

# v3.0.7 — mouse button VK codes for hotkey use. Side mouse buttons (X1/X2)
# and middle click are common keybind targets in gaming. Left + right click
# are intentionally NOT exposed because they'd swallow normal UI clicks.
VK_MBUTTON  = 0x04   # middle mouse button (wheel click)
VK_XBUTTON1 = 0x05   # back / X1 — usually thumb button on the left side
VK_XBUTTON2 = 0x06   # forward / X2 — second thumb button

PROFILE_DIR = Path.home() / ".throttlr"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_PATH = PROFILE_DIR / "settings.json"

# v3.0.5 — custom themes folder. Users drop downloaded .json + .css pairs
# from throttlr-themes.netlify.app here. The app scans on boot and renders
# tiles next to the built-in 4 designs.
THEMES_DIR = PROFILE_DIR / "themes"
THEMES_DIR.mkdir(parents=True, exist_ok=True)
THEMES_GALLERY_URL = "https://throttlr-themes.netlify.app/"


KEY_NAMES = {
    # Function keys
    "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73,
    "F5": 0x74, "F6": 0x75, "F7": 0x76, "F8": 0x77,
    "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
    "F13": 0x7C, "F14": 0x7D, "F15": 0x7E, "F16": 0x7F,
    "F17": 0x80, "F18": 0x81, "F19": 0x82, "F20": 0x83,
    "F21": 0x84, "F22": 0x85, "F23": 0x86, "F24": 0x87,
    # Navigation cluster
    "Insert": 0x2D, "Home": 0x24, "End": 0x23,
    "Page Up": 0x21, "Page Down": 0x22, "Pause": 0x13,
    "Scroll Lock": 0x91, "Print Screen": 0x2C,
    # Arrows
    "Up": 0x26, "Down": 0x28, "Left": 0x25, "Right": 0x27,
    # Whitespace / control
    "Space": 0x20, "Enter": 0x0D, "Tab": 0x09,
    # Punctuation
    "-": 0xBD, "=": 0xBB, "[": 0xDB, "]": 0xDD, "\\": 0xDC,
    ";": 0xBA, "'": 0xDE, ",": 0xBC, ".": 0xBE, "/": 0xBF, "`": 0xC0,
    # Numpad
    "Num 0": 0x60, "Num 1": 0x61, "Num 2": 0x62, "Num 3": 0x63, "Num 4": 0x64,
    "Num 5": 0x65, "Num 6": 0x66, "Num 7": 0x67, "Num 8": 0x68, "Num 9": 0x69,
    "Num *": 0x6A, "Num +": 0x6B, "Num -": 0x6D, "Num .": 0x6E, "Num /": 0x6F,
    # v3.0.7 — Mouse buttons (side buttons + middle). Left/right click are
    # deliberately excluded so we don't break normal UI clicks.
    "Mouse3": VK_MBUTTON,
    "Mouse4": VK_XBUTTON1,
    "Mouse5": VK_XBUTTON2,
}
# Letters A-Z and digits 0-9 — populated programmatically rather than hand-typed
for _i, _c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
    KEY_NAMES[_c] = 0x41 + _i
for _i in range(10):
    KEY_NAMES[str(_i)] = 0x30 + _i


# ============================================================
# Settings
# ============================================================

DEFAULT_SETTINGS = {
    "theme": "lethal",
    "ui_design": "industrial",          # industrial | midnight | windows7 | optimised
    "midnight_accent": "aurora",        # aurora | sunset | forest | amber | rose | ocean
    "hotkey_startstop": "F5",
    "hotkey_freeze": "F8",
    "hotkey_block": "F9",
    "hotkey_fun": "F10",
    "hotkey_killswitch": "",        # global "disable all functions" — no default binding

    # Sound
    "sound_enabled": True,
    "sound_volume": 100,

    # Behavior
    "auto_start_on_launch": False,
    "auto_clear_freeze_queue": False,
    "reset_stats_on_start": True,        # Phase 2: default ON — fresh stats per run
    "confirm_before_quit": True,
    # v3.1.0 — Auto-pause-on-idle: warn (don't auto-stop) when no packets
    # have flowed for the configured threshold.
    "auto_pause_on_idle":      False,
    "auto_pause_idle_seconds": 30,

    # Onboarding — tutorial gates first launch, update log fires when version changes
    "tutorial_seen": False,
    "last_seen_version": "",
    "auto_stop_minutes": 0,
    "hotkey_notifications": True,

    # Auto-update — version string the user said "Not now" to. Stays set
    # until they update or a NEWER release supersedes it (then we prompt
    # again because the dismissed version is no longer the latest).
    "dismissed_update_version": "",

    # Window
    "window_w": 1100,
    "window_h": 920,

    # Floating overlay
    "show_overlay": True,
    "overlay_mode": "compact",          # compact | advanced | custom
    "overlay_advanced": False,          # legacy — kept for back-compat
    "overlay_x": 30,
    "overlay_y": 30,
    "overlay_opacity": 95,
    "overlay_locked": False,
    "overlay_layout": [],               # list of {type, visible} for custom mode
    "overlay_presets": {},              # name -> layout

    # Screen-edge border indicator
    "screen_border_enabled": False,
    "screen_border_duration_ms": 2000,
    "screen_border_feather": 90,

    # Appearance extras
    "compact_mode": False,
    "crt_effects": True,
    "anim_speed": 1.0,                  # 0.5 = slower, 2 = faster
    "animations_enabled": True,         # v3.1.2 — master anime.js animation toggle

    # Advanced
    "stats_interval_ms": 200,
    "apps_refresh_ms": 2000,
    "toast_duration_ms": 3500,
    "number_format": "raw",             # raw | abbrev
    "main_always_on_top": False,
    "auto_load_profile": "",            # name of profile to load on launch ("" = none)
    "tooltips_enabled": True,
    "skip_localhost": True,
    "verbose_logging": False,

    # ===== Phase 1 additions =====

    # Recent apps (most-recently-targeted, max 8)
    "recent_apps": [],

    # v3.0.7 — Connected Processes feature toggle. When False (default),
    # Throttlr targets all related processes for the chosen app
    # automatically (legacy behavior). When True, the inline tick/untick
    # picker becomes active and target_pid_excludes is honored.
    "connected_procs_enabled": False,

    # v3.0.7 — Show a small red percentage badge next to the Drop counter
    # in the bottom status bar, displaying drop / total %. Off by default
    # since most users only need the raw counter.
    "show_drop_pct": False,

    # v3.0.7 — Process tree picker: per-target-set, list of PIDs the user
    # has explicitly unticked in the Process Tree modal. Key is the
    # sorted+joined target names ("chrome.exe", "chrome.exe|Discord.exe"
    # etc.), value is a list of int PIDs. Capped at 16 entries to bound
    # the file size. Stale PIDs are harmless — they just won't match
    # anything in the current scan.
    "target_pid_excludes_by_app": {},

    # Per-app preset memory: { "Discord.exe": {<full filter cfg>}, ... }
    "per_app_presets": {},
    "auto_load_per_app_preset": True,   # prompt on app pick to restore last

    # User-named quick presets, on top of the built-in ones
    "user_quick_presets": [],            # list of {name, color, config}

    # Sound effects (per-function audio cues — distinct from Sound tab)
    "sound_effects_enabled": True,
    "sound_effects_volume": 80,

    # Theme — custom Midnight accent. Hex color string or "" if unused.
    "midnight_custom_color": "",         # e.g. "#ff44aa"
    "active_custom_theme": "",           # v3.0.5 — id of installed custom theme, empty = use built-in
    "theme_customizations": {},          # v3.0.5 — { theme_id: { key: value | [stops] } } user color overrides per theme

    # Stream-safe overlay — bigger fonts, opaque background for clean OBS capture
    "overlay_stream_safe": False,

    # Ghost mode — overlay invisible to screen-capture (Windows API)
    "overlay_ghost_mode": False,

    # Achievements ledger: { "first_drop": "2026-05-07T...", ... }
    "achievements_unlocked": {},

    # Animated taskbar/window icon while capture is running
    "animated_icon": True,

    # ===== Phase 3 (v2.6.0) — Automation Rules Engine =====
    # Master enable for the engine itself. When False, no rules fire even if
    # individual rules are marked enabled.
    "automation_enabled": True,

    # List of rule dicts. Each rule:
    #   {
    #     "id": "<uuid>",
    #     "name": "Throttle Discord during work hours",
    #     "enabled": True,
    #     "condition": {
    #         "type": "schedule" | "app_running" | "bandwidth" | "conn_count",
    #         ... type-specific params (see AutomationEngine for details)
    #     },
    #     "action": {
    #         "type": "preset" | "function" | "toast" | "capture",
    #         ... type-specific params
    #     }
    #   }
    "automation_rules": [],

    # ===== Phase 5 (v3.0.0) — LAN coordination + plugins =====
    # LAN sync — discoverable + accept pairing requests from other Throttlr
    # instances on the network. Off by default for privacy.
    "lan_sync_enabled":      False,
    # Display name shown to peers (defaults to hostname if empty)
    "lan_display_name":      "",
    # UDP discovery port (most users won't change)
    "lan_discovery_port":    7878,
    # TCP control port (commands + status)
    "lan_control_port":      7879,
    # List of trusted peers, each: {peer_id, name, last_ip, shared_secret}
    "lan_trusted_peers":     [],
    # Pending incoming pairing requests waiting for user approval:
    # [{peer_id, name, ip, code, expires_ts}]
    "lan_pending_pairings":  [],

    # Plugin system — plugins run with full Python privileges so they're
    # disabled by default. User must explicitly enable each one in Settings.
    "plugins_enabled":       [],   # list of plugin names (folder names) currently enabled
}


class SettingsManager:
    def __init__(self):
        self.data = dict(DEFAULT_SETTINGS)
        self.load()

    def load(self):
        try:
            if SETTINGS_PATH.exists():
                loaded = json.loads(SETTINGS_PATH.read_text())
                for k, v in DEFAULT_SETTINGS.items():
                    self.data[k] = loaded.get(k, v)
        except Exception:
            self.data = dict(DEFAULT_SETTINGS)

    def save(self):
        try:
            SETTINGS_PATH.write_text(json.dumps(self.data, indent=2))
        except Exception:
            pass

    def get(self, key, default=None):
        # Fall back to DEFAULT_SETTINGS first, then to the caller's default.
        # This preserves existing single-arg behavior (where default=None and
        # DEFAULT_SETTINGS handles the fallback) while supporting the natural
        # dict.get(key, default) pattern that callers expect.
        if key in self.data:
            return self.data[key]
        if key in DEFAULT_SETTINGS:
            return DEFAULT_SETTINGS[key]
        return default

    def set(self, key, value):
        self.data[key] = value
        self.save()


# ============================================================
# Sound
# ============================================================

_sound_enabled = True


def set_sound_enabled(on: bool):
    global _sound_enabled
    _sound_enabled = on


def play_tones(*notes):
    if not HAS_WINSOUND or not _sound_enabled:
        return
    def _run():
        try:
            for freq, dur in notes:
                winsound.Beep(int(freq), int(dur))
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()


# ============================================================
# FilterConfig
# ============================================================

@dataclass
class FilterConfig:
    target_pids: set = field(default_factory=set)
    target_name: str = ""
    target_names: list = field(default_factory=list)   # multi-target: list of names
    target_pid_excludes: set = field(default_factory=set)  # v3.0.7 — PIDs user has explicitly unticked in Process Tree picker
    connected_procs_enabled: bool = False  # v3.0.7 — gates whether the per-PID exclude list is honored. When False, all related processes are targeted (legacy behavior).
    pid_to_app: dict = field(default_factory=dict)  # v3.1.3.2 — multi-target: PID -> owning app name (for per-app settings)

    lag_on: bool = False
    lag_inbound: bool = True
    lag_outbound: bool = True
    lag_ms: int = 500
    lag_jitter_ms: int = 0

    drop_on: bool = False
    drop_inbound: bool = True
    drop_outbound: bool = True
    drop_chance: int = 60
    drop_dns_only: bool = False                          # only drop port-53 packets
    # v3.1.0 (real-networks batch) — bursty loss patterns. When pattern is
    # 'bursty', drops cluster: once a drop fires, the next N-1 packets also
    # drop (burst_len), then drops are inhibited for gap_len packets before
    # the next burst can start. Better mimics real bad wireless.
    drop_pattern: str = "uniform"   # "uniform" | "bursty"
    drop_burst_len: int = 4
    drop_gap_len: int = 20
    _drop_burst_remaining: int = 0   # internal state — packets left in current burst
    _drop_gap_remaining: int = 0     # internal state — packets to skip before next burst

    throttle_on: bool = False
    throttle_inbound: bool = True
    throttle_outbound: bool = True
    throttle_kbps: int = 100

    # v3.1.0 (real-networks batch) — Bandwidth quotas.
    # Daily-reset counter per target app. When today's bytes exceed
    # quota_mb, the configured action fires (throttle / block / notify).
    # quota_today_bytes persists across app restarts via QUOTA_FILE.
    bandwidth_quota_on: bool = False
    quota_mb: int = 1000                     # daily cap in megabytes
    quota_action: str = "throttle"           # "throttle" | "block" | "notify"
    quota_throttle_kbps: int = 50            # KB/s if action == throttle
    quota_today_bytes: int = 0               # running counter, reset on day rollover
    quota_day_iso: str = ""                  # YYYY-MM-DD of the current counter window
    quota_fired: bool = False                # has today's quota tripped yet?

    # v3.1.0 (real-networks batch) — DNS chaos mode.
    # When on, drop all outbound DNS queries (port 53). Simulates a
    # broken DNS server. Apps using DoH (Chrome/Firefox modern defaults)
    # bypass this — UI surfaces a tooltip explaining the caveat.
    dns_chaos_on: bool = False

    freeze_on: bool = False
    freeze_inbound: bool = True
    freeze_outbound: bool = True
    freeze_replay_ms: int = 0

    block_on: bool = False
    block_inbound: bool = True
    block_outbound: bool = True

    fun_mode: bool = False
    fun_intensity: int = 50

    packets_seen: int = 0
    packets_sent: int = 0      # v3.0.7 — outbound packets (target → internet)
    packets_received: int = 0  # v3.0.7 — inbound packets (internet → target)
    packets_dropped: int = 0
    packets_delayed: int = 0
    packets_held: int = 0
    bytes_seen: int = 0

    # ===== Phase 2 fields =====
    # Domain blocklist (a Block-Domain function alongside the existing 6)
    domain_block_on: bool = False
    domain_block_lists: list = field(default_factory=list)   # ["ads","trackers","telemetry"]
    domain_block_custom: list = field(default_factory=list)  # user-added domain strings
    # Geo blocking
    geo_block_on: bool = False
    geo_block_countries: list = field(default_factory=list)  # ["RU","CN",...]
    # Practice ping (just a wrapper around lag — no separate filter, but tracked
    # so the UI knows we're in "practice ping" mode for display purposes)
    practice_ping_on: bool = False
    practice_ping_target_ms: int = 0

    # ===== Phase 3 fields =====
    # Filter scripting — applied as a custom drop rule. Empty = disabled.
    script_source: str = ""
    script_action: str = "drop"      # "drop" | "keep_only" | "lag" | "log"
    script_on: bool = False


@dataclass
class ConnectionInfo:
    """Rich per-connection tracking — populated by the FLOW-layer listener
    and updated by the capture loop with byte counts. Surfaced to the UI
    via the Connection Inspector."""
    pid: int = 0
    proto: str = ""                  # "TCP" | "UDP"
    local_addr: str = ""
    local_port: int = 0
    remote_addr: str = ""
    remote_port: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    packets_in: int = 0
    packets_out: int = 0
    established_at: float = 0.0      # monotonic time
    last_seen: float = 0.0
    hostname: str = ""               # SNI from TLS ClientHello if available
    country: str = ""                # 2-letter ISO code from geo lookup


# ============================================================
# Phase 2 — domain blocklist data
# ============================================================

# Compact built-in blocklists. Each is a tuple of suffix patterns —
# matched via endswith() against an SNI/hostname. Keeps things fast and
# avoids regex overhead in the capture path.
BUILTIN_BLOCKLISTS = {
    "ads": (
        "doubleclick.net", "googleadservices.com", "googlesyndication.com",
        "adservice.google.com", "ads.yahoo.com", "advertising.com",
        "adnxs.com", "amazon-adsystem.com", "rubiconproject.com",
        "criteo.com", "criteo.net", "pubmatic.com", "openx.net",
        "moatads.com", "adsafeprotected.com", "scorecardresearch.com",
        "outbrain.com", "taboola.com", "media.net",
        "yieldlab.net", "yieldmo.com", "smartadserver.com",
    ),
    "trackers": (
        "google-analytics.com", "googletagmanager.com", "googletagservices.com",
        "facebook.com", "fb.com", "fbcdn.net", "connect.facebook.net",
        "hotjar.com", "mixpanel.com", "segment.io", "segment.com",
        "amplitude.com", "fullstory.com", "newrelic.com",
        "branch.io", "appsflyer.com", "adjust.com", "kochava.com",
        "chartbeat.com", "quantserve.com", "comscore.com",
        "matomo.org", "yandex.ru", "yandex.com",
    ),
    "telemetry": (
        "telemetry.microsoft.com", "vortex.data.microsoft.com",
        "events.data.microsoft.com", "settings-win.data.microsoft.com",
        "watson.telemetry.microsoft.com", "watson.microsoft.com",
        "incoming.telemetry.mozilla.org", "telemetry.mozilla.org",
        "metrics.icloud.com", "telemetry.dropbox.com",
        "stats.g.doubleclick.net", "ssl.google-analytics.com",
        "browser.events.data.msn.com",
    ),
}


# ============================================================
# Phase 2 — minimal embedded country IPv4 ranges for geo blocking.
# This is a coarse approximation — covers the most common ~30 countries
# at the /16 or /8 level. For finer-grained accuracy, users can drop a
# GeoLite2-Country.mmdb at ~/.throttlr/geoip.mmdb and we'll use that.
# Source: aggregated public RIR (ARIN/RIPE/APNIC/AFRINIC/LACNIC) data.
# Stored as a list of (cidr, cc) tuples; loaded once at module import.
# ============================================================
_GEO_RANGES_RAW = """\
1.0.0.0/8 US
2.0.0.0/8 EU
3.0.0.0/8 US
4.0.0.0/8 US
5.0.0.0/8 EU
6.0.0.0/8 US
7.0.0.0/8 US
8.0.0.0/8 US
9.0.0.0/8 US
11.0.0.0/8 US
12.0.0.0/8 US
13.0.0.0/8 US
14.0.0.0/8 AP
15.0.0.0/8 US
16.0.0.0/8 US
17.0.0.0/8 US
18.0.0.0/8 US
19.0.0.0/8 US
20.0.0.0/8 US
21.0.0.0/8 US
22.0.0.0/8 US
23.0.0.0/8 US
24.0.0.0/8 US
25.0.0.0/8 GB
26.0.0.0/8 US
27.0.0.0/8 AP
28.0.0.0/8 US
29.0.0.0/8 US
30.0.0.0/8 US
31.0.0.0/8 EU
32.0.0.0/8 US
33.0.0.0/8 US
34.0.0.0/8 US
35.0.0.0/8 US
36.0.0.0/8 AP
37.0.0.0/8 EU
38.0.0.0/8 US
39.0.0.0/8 CN
40.0.0.0/8 US
41.0.0.0/8 AF
42.0.0.0/8 AP
43.0.0.0/8 AP
44.0.0.0/8 US
45.0.0.0/8 US
46.0.0.0/8 EU
47.0.0.0/8 CA
48.0.0.0/8 US
49.0.0.0/8 AP
50.0.0.0/8 US
51.0.0.0/8 EU
52.0.0.0/8 US
53.0.0.0/8 DE
54.0.0.0/8 US
55.0.0.0/8 US
56.0.0.0/8 US
57.0.0.0/8 EU
58.0.0.0/8 AP
59.0.0.0/8 AP
60.0.0.0/8 AP
61.0.0.0/8 AP
62.0.0.0/8 EU
63.0.0.0/8 US
64.0.0.0/8 US
65.0.0.0/8 US
66.0.0.0/8 US
67.0.0.0/8 US
68.0.0.0/8 US
69.0.0.0/8 US
70.0.0.0/8 US
71.0.0.0/8 US
72.0.0.0/8 US
73.0.0.0/8 US
74.0.0.0/8 US
75.0.0.0/8 US
76.0.0.0/8 US
77.0.0.0/8 EU
78.0.0.0/8 EU
79.0.0.0/8 EU
80.0.0.0/8 EU
81.0.0.0/8 EU
82.0.0.0/8 EU
83.0.0.0/8 EU
84.0.0.0/8 EU
85.0.0.0/8 EU
86.0.0.0/8 EU
87.0.0.0/8 EU
88.0.0.0/8 EU
89.0.0.0/8 EU
90.0.0.0/8 EU
91.0.0.0/8 EU
92.0.0.0/8 EU
93.0.0.0/8 EU
94.0.0.0/8 EU
95.0.0.0/8 EU
96.0.0.0/8 US
97.0.0.0/8 US
98.0.0.0/8 US
99.0.0.0/8 US
100.0.0.0/8 US
101.0.0.0/8 AP
102.0.0.0/8 AF
103.0.0.0/8 AP
104.0.0.0/8 US
105.0.0.0/8 AF
106.0.0.0/8 AP
107.0.0.0/8 US
108.0.0.0/8 US
109.0.0.0/8 EU
110.0.0.0/8 AP
111.0.0.0/8 AP
112.0.0.0/8 AP
113.0.0.0/8 AP
114.0.0.0/8 AP
115.0.0.0/8 AP
116.0.0.0/8 AP
117.0.0.0/8 AP
118.0.0.0/8 AP
119.0.0.0/8 AP
120.0.0.0/8 AP
121.0.0.0/8 AP
122.0.0.0/8 AP
123.0.0.0/8 AP
124.0.0.0/8 AP
125.0.0.0/8 AP
126.0.0.0/8 JP
128.0.0.0/8 US
129.0.0.0/8 US
130.0.0.0/8 US
131.0.0.0/8 US
132.0.0.0/8 US
133.0.0.0/8 JP
134.0.0.0/8 US
135.0.0.0/8 US
136.0.0.0/8 US
137.0.0.0/8 US
138.0.0.0/8 US
139.0.0.0/8 US
140.0.0.0/8 US
141.0.0.0/8 EU
142.0.0.0/8 CA
143.0.0.0/8 US
144.0.0.0/8 US
145.0.0.0/8 EU
146.0.0.0/8 US
147.0.0.0/8 US
148.0.0.0/8 US
149.0.0.0/8 US
150.0.0.0/8 AP
151.0.0.0/8 EU
152.0.0.0/8 US
153.0.0.0/8 JP
154.0.0.0/8 US
155.0.0.0/8 US
156.0.0.0/8 US
157.0.0.0/8 US
158.0.0.0/8 US
159.0.0.0/8 US
160.0.0.0/8 US
161.0.0.0/8 US
162.0.0.0/8 US
163.0.0.0/8 AP
164.0.0.0/8 US
165.0.0.0/8 US
166.0.0.0/8 US
167.0.0.0/8 US
168.0.0.0/8 US
169.0.0.0/8 US
170.0.0.0/8 US
171.0.0.0/8 AP
172.0.0.0/8 US
173.0.0.0/8 US
174.0.0.0/8 US
175.0.0.0/8 AP
176.0.0.0/8 EU
177.0.0.0/8 BR
178.0.0.0/8 EU
179.0.0.0/8 BR
180.0.0.0/8 AP
181.0.0.0/8 LATAM
182.0.0.0/8 AP
183.0.0.0/8 AP
184.0.0.0/8 US
185.0.0.0/8 EU
186.0.0.0/8 LATAM
187.0.0.0/8 BR
188.0.0.0/8 EU
189.0.0.0/8 BR
190.0.0.0/8 LATAM
191.0.0.0/8 BR
192.0.0.0/8 US
193.0.0.0/8 EU
194.0.0.0/8 EU
195.0.0.0/8 EU
196.0.0.0/8 AF
197.0.0.0/8 AF
198.0.0.0/8 US
199.0.0.0/8 US
200.0.0.0/8 LATAM
201.0.0.0/8 LATAM
202.0.0.0/8 AP
203.0.0.0/8 AP
204.0.0.0/8 US
205.0.0.0/8 US
206.0.0.0/8 US
207.0.0.0/8 US
208.0.0.0/8 US
209.0.0.0/8 US
210.0.0.0/8 AP
211.0.0.0/8 AP
212.0.0.0/8 EU
213.0.0.0/8 EU
214.0.0.0/8 US
215.0.0.0/8 US
216.0.0.0/8 US
217.0.0.0/8 EU
218.0.0.0/8 AP
219.0.0.0/8 AP
220.0.0.0/8 AP
221.0.0.0/8 AP
222.0.0.0/8 AP
223.0.0.0/8 AP
"""

# Parse on import — fast lookup table indexed by first octet
_GEO_TABLE = {}
def _build_geo_table():
    for line in _GEO_RANGES_RAW.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            cidr, cc = line.split()
            first_octet = int(cidr.split('.')[0])
            _GEO_TABLE[first_octet] = cc
        except Exception:
            continue
_build_geo_table()

def lookup_country(ip_str: str) -> str:
    """Return ISO country code or region marker. Falls back to 'XX' on
    unknown. The bundled table is /8-granularity — adequate for blocking
    at the regional level. For finer accuracy users can drop a real
    GeoLite2-Country.mmdb at ~/.throttlr/geoip.mmdb."""
    try:
        first = int(ip_str.split('.')[0])
        return _GEO_TABLE.get(first, "XX")
    except Exception:
        return "XX"


# ============================================================
# Phase 2 — TLS SNI parser (extracts hostname from ClientHello)
# ============================================================

def parse_sni(payload: bytes) -> str:
    """Extract Server Name Indication from a TLS ClientHello.
    Returns the hostname or '' if not parseable. Strict, fast parser —
    bails out on any unexpected byte. Spec: RFC 6066 §3."""
    try:
        # TLS record header: type(1) + ver(2) + len(2)
        if len(payload) < 5:
            return ""
        if payload[0] != 0x16:               # 0x16 = handshake
            return ""
        # TLS handshake: msg_type(1) + len(3) + version(2) + random(32) +
        # session_id_len(1) + session_id(...) + cipher_suites_len(2) +
        # cipher_suites + compression_len(1) + compression + ext_len(2) + extensions
        if len(payload) < 43:
            return ""
        if payload[5] != 0x01:               # 0x01 = ClientHello
            return ""
        idx = 5 + 4 + 2 + 32                 # skip msg_type+len+version+random
        sess_id_len = payload[idx]; idx += 1 + sess_id_len
        if idx + 2 > len(payload):
            return ""
        cs_len = (payload[idx] << 8) | payload[idx + 1]
        idx += 2 + cs_len
        if idx + 1 > len(payload):
            return ""
        comp_len = payload[idx]; idx += 1 + comp_len
        if idx + 2 > len(payload):
            return ""
        ext_total = (payload[idx] << 8) | payload[idx + 1]
        idx += 2
        ext_end = idx + ext_total
        while idx + 4 <= ext_end:
            ext_type = (payload[idx] << 8) | payload[idx + 1]
            ext_len = (payload[idx + 2] << 8) | payload[idx + 3]
            idx += 4
            if ext_type == 0x00:             # SNI
                # SNI inner: list_len(2) + name_type(1) + name_len(2) + name
                if idx + 5 > len(payload):
                    return ""
                # list_len = (payload[idx] << 8) | payload[idx + 1]
                name_type = payload[idx + 2]
                if name_type != 0x00:
                    return ""
                name_len = (payload[idx + 3] << 8) | payload[idx + 4]
                if idx + 5 + name_len > len(payload):
                    return ""
                return payload[idx + 5: idx + 5 + name_len].decode('ascii', errors='replace')
            idx += ext_len
        return ""
    except Exception:
        return ""


def host_in_blocklists(host: str, lists: list, custom: list) -> bool:
    """Return True if hostname matches any active built-in or user list."""
    if not host:
        return False
    h = host.lower()
    for name in lists:
        for suffix in BUILTIN_BLOCKLISTS.get(name, ()):
            if h == suffix or h.endswith("." + suffix):
                return True
    for entry in custom:
        e = (entry or "").strip().lower().lstrip(".")
        if not e:
            continue
        if h == e or h.endswith("." + e):
            return True
    return False


# ============================================================
# Hotkeys
# ============================================================

class _LowLevelKeyboardHook(QObject):
    """v3.0.4 — System-wide low-level keyboard hook. Replaces the old
    RegisterHotKey-based GlobalHotkey class which had a real issue:
    RegisterHotKey silently fails (returns 0) when ANY other app has already
    registered the same key globally — Discord overlay, OBS, Steam, NVIDIA
    GeForce Experience, screen recorders, the game itself. Result: user
    presses F5 to start Throttlr, the OTHER app eats the key, Throttlr
    never sees it. They have to alt-tab and click the button manually.

    Low-level hooks intercept ALL keyboard input system-wide BEFORE any
    app processes it, completely bypassing the hotkey-conflict issue. This
    is what gaming overlays, screen recorders, and accessibility tools use.

    Single shared hook serves ALL hotkeys via a vk_code → callback dict.
    Hook callback never blocks the keypress (returns CallNextHookEx) so
    games still see the key normally — Throttlr just observes it.
    """

    keyPressed = Signal(int)   # emits vk_code on keydown for registered VKs

    # Win32 constants
    WH_KEYBOARD_LL = 13
    WM_KEYDOWN     = 0x0100
    WM_SYSKEYDOWN  = 0x0104
    HC_ACTION      = 0

    class _KBDLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ('vkCode',      wintypes.DWORD),
            ('scanCode',    wintypes.DWORD),
            ('flags',       wintypes.DWORD),
            ('time',        wintypes.DWORD),
            ('dwExtraInfo', ctypes.c_void_p),
        ]

    def __init__(self):
        super().__init__()
        # v3.1.1 — frozenset that the hook callback reads WITHOUT a lock.
        # Replaced atomically (Python attribute write is GIL-protected) when
        # register_vk / unregister_vk / clear mutate the set. The lock is
        # only held during MUTATION, never during the hook callback.
        self._registered_vks_frozen = frozenset()
        self._registered_vks = set()      # mutable, lock-protected, source of truth
        self._hook_handle = None
        self._thread = None
        self._stop = threading.Event()
        self._proc = None        # KEEP REFERENCE — GC'd callbacks crash ctypes
        self._lock = threading.RLock()
        # v3.1.1 — install bookkeeping for the watchdog
        self._install_count = 0          # incremented each time hook is installed
        self._last_install_ts = 0.0
        self._reinstall_callback = None  # set by external watchdog if any

    def _rebuild_frozen(self):
        """Snapshot the mutable set into a frozenset for lock-free reads
        from the hook callback. Caller MUST hold self._lock."""
        self._registered_vks_frozen = frozenset(self._registered_vks)

    def register_vk(self, vk_code: int):
        """Add a VK code to monitor. Calling this before start() is fine."""
        with self._lock:
            self._registered_vks.add(int(vk_code))
            self._rebuild_frozen()
        # v3.1.1 — Log registration to startup.log so we can verify each
        # hotkey actually attached to the LL hook on this machine.
        try:
            import builtins as _bi
            _hlog = getattr(_bi, '_throttlr_startup_log', None)
            if _hlog:
                _hlog(f"[hotkeys] register_vk(0x{int(vk_code):02x}) — frozen size now {len(self._registered_vks_frozen)}")
        except Exception:
            pass

    def unregister_vk(self, vk_code: int):
        with self._lock:
            self._registered_vks.discard(int(vk_code))
            self._rebuild_frozen()

    def clear(self):
        with self._lock:
            self._registered_vks.clear()
            self._rebuild_frozen()

    def start(self):
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="ThrottlrKBHook")
        self._thread.start()

    def stop(self):
        self._stop.set()

    def is_installed(self) -> bool:
        """Returns True only if SetWindowsHookExW returned a valid handle.
        Used by the app-level fallback filter to know whether to fire."""
        try:
            return self._hook_handle is not None and bool(self._hook_handle)
        except Exception:
            return False

    def reinstall_if_stale(self):
        """v3.1.1 — Watchdog entry point. Forces an unhook + re-hook cycle
        so the LL hook can never get silently yanked by Windows for more
        than `watchdog_interval` seconds. Cheap (~1ms)."""
        try:
            user32 = ctypes.windll.user32
            old_handle = self._hook_handle
            if old_handle:
                try:
                    user32.UnhookWindowsHookEx(old_handle)
                except Exception:
                    pass
                self._hook_handle = None
            # Install a fresh hook on the SAME thread that owns the message
            # pump. Since this method is called from outside the thread,
            # we need the thread to do the actual install. Set a flag and
            # let the run loop pick it up.
            self._reinstall_pending = True
        except Exception:
            pass

    def _run(self):
        try:
            user32   = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32

            HOOKPROC = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

            def hook_proc(nCode, wParam, lParam):
                try:
                    if nCode == self.HC_ACTION and wParam in (self.WM_KEYDOWN, self.WM_SYSKEYDOWN):
                        kbd = ctypes.cast(
                            lParam,
                            ctypes.POINTER(self._KBDLLHOOKSTRUCT)).contents
                        vk = int(kbd.vkCode)
                        # v3.1.1 — Lock-free read. Reading a Python attribute
                        # is atomic under the GIL, and frozenset membership
                        # check is O(1) with no lock. This must NEVER block:
                        # if Windows decides our callback took too long, it
                        # silently removes the hook (300ms LowLevelHooksTimeout).
                        if vk in self._registered_vks_frozen:
                            self.keyPressed.emit(vk)
                except Exception:
                    pass
                # Always pass through — never block the key
                return user32.CallNextHookEx(None, nCode, wParam, lParam)

            self._proc = HOOKPROC(hook_proc)

            # Set return type and arg types for SetWindowsHookExW
            user32.SetWindowsHookExW.restype = wintypes.HHOOK
            user32.SetWindowsHookExW.argtypes = [
                ctypes.c_int, HOOKPROC, wintypes.HMODULE, wintypes.DWORD]

            def _install_hook():
                """v3.1.1 — Helper so we can re-install when the watchdog
                flips _reinstall_pending. Returns True on success.

                Single attempt only. An earlier v3.1.1 build tried multiple
                fallbacks (NULL handle, user32.dll handle) to work around
                PyInstaller's error 126, but that approach caused full
                keyboard lockup on some machines — likely because multiple
                concurrent hook installs ended up in the global chain and
                the callback became a bottleneck.

                Safer behavior: try once with the textbook handle. If it
                fails, log it and accept the focus-only fallback. A broken
                global hotkey is annoying. A locked keyboard is awful."""
                hmod = kernel32.GetModuleHandleW(None)
                self._hook_handle = user32.SetWindowsHookExW(
                    self.WH_KEYBOARD_LL, self._proc, hmod, 0)
                if self._hook_handle:
                    self._install_count += 1
                    self._last_install_ts = time.time()
                    return True
                return False

            # v3.1.1 — Route hotkey events through startup.log too so
            # we can see them in PyInstaller GUI builds (where stderr
            # goes nowhere by default). Uses the same builtins logger
            # the rest of startup uses; safe no-op if not set.
            import builtins as _bi
            _hlog = getattr(_bi, '_throttlr_startup_log', None)
            def _log_hook(msg):
                """Best-effort dual log: stderr AND startup.log."""
                try:
                    print(msg, file=sys.stderr)
                except Exception:
                    pass
                if _hlog:
                    try:
                        _hlog(f"[hotkeys] {msg}")
                    except Exception:
                        pass

            if not _install_hook():
                err = ctypes.windll.kernel32.GetLastError() if hasattr(ctypes.windll, 'kernel32') else 0
                _log_hook(
                    f"SetWindowsHookExW FAILED (last error: {err}). "
                    f"Hotkeys will only fire when Throttlr has focus. "
                    f"This is a known PyInstaller limitation — running "
                    f"from source (python throttlr.py) doesn't have it.")
                return
            else:
                _log_hook(f"LL keyboard hook installed OK (handle={self._hook_handle})")

            # Pump messages — required for the hook callback to fire.
            msg = wintypes.MSG()
            self._reinstall_pending = False
            while not self._stop.is_set():
                # v3.1.1 — Watchdog re-install. Triggered every 30s from
                # the main thread; we do the actual install here so it
                # runs on the message-pump thread (LL hooks must be
                # installed from the thread that owns the pump).
                if self._reinstall_pending:
                    self._reinstall_pending = False
                    if _install_hook():
                        _log_hook(f"re-installed (count={self._install_count})")
                # PM_REMOVE = 1
                if user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
                else:
                    # Tight loop would burn CPU; this stays under 1% load
                    time.sleep(0.005)

            if self._hook_handle:
                user32.UnhookWindowsHookEx(self._hook_handle)
            self._hook_handle = None
        except Exception:
            pass


# Singleton — created on first GlobalHotkey() so we share one hook for all keys.
_KB_HOOK_SINGLETON = None
_KB_HOOK_LOCK      = threading.Lock()


def _get_kb_hook():
    global _KB_HOOK_SINGLETON
    if _KB_HOOK_SINGLETON is None:
        with _KB_HOOK_LOCK:
            if _KB_HOOK_SINGLETON is None:
                _KB_HOOK_SINGLETON = _LowLevelKeyboardHook()
                _KB_HOOK_SINGLETON.start()
    return _KB_HOOK_SINGLETON


# v3.0.7 — separate low-level mouse hook for X1/X2/middle button hotkeys.
# Same architecture as the keyboard hook but uses WH_MOUSE_LL and decodes
# mouse-specific messages. Emits the same `keyPressed(vk)` signal, using
# VK_MBUTTON / VK_XBUTTON1 / VK_XBUTTON2 as the VK code so the existing
# GlobalHotkey dispatcher works unchanged.

class _LowLevelMouseHook(QObject):
    """System-wide low-level mouse hook for side-button + middle-click hotkeys.
    Left + right click are intentionally NOT forwarded — they'd break normal
    UI clicks throughout the app (every click would also fire a hotkey)."""

    keyPressed = Signal(int)   # emits a "VK code" — VK_MBUTTON/XBUTTON1/XBUTTON2

    WH_MOUSE_LL     = 14
    WM_MBUTTONDOWN  = 0x0207
    WM_XBUTTONDOWN  = 0x020B
    HC_ACTION       = 0
    XBUTTON1        = 0x0001
    XBUTTON2        = 0x0002

    class _MSLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ('pt',          wintypes.POINT),
            ('mouseData',   wintypes.DWORD),
            ('flags',       wintypes.DWORD),
            ('time',        wintypes.DWORD),
            ('dwExtraInfo', ctypes.c_void_p),
        ]

    def __init__(self):
        super().__init__()
        self._registered_vks = set()
        self._hook_handle = None
        self._thread = None
        self._stop = threading.Event()
        self._proc = None
        self._lock = threading.RLock()

    def register_vk(self, vk_code: int):
        with self._lock:
            self._registered_vks.add(int(vk_code))

    def unregister_vk(self, vk_code: int):
        with self._lock:
            self._registered_vks.discard(int(vk_code))

    def is_installed(self) -> bool:
        try:
            return self._hook_handle is not None and bool(self._hook_handle)
        except Exception:
            return False

    def start(self):
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="ThrottlrMouseHook")
        self._thread.start()

    def _run(self):
        try:
            user32   = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
            HOOKPROC = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

            def hook_proc(nCode, wParam, lParam):
                try:
                    if nCode == self.HC_ACTION:
                        vk = None
                        if wParam == self.WM_MBUTTONDOWN:
                            vk = VK_MBUTTON
                        elif wParam == self.WM_XBUTTONDOWN:
                            ms = ctypes.cast(lParam,
                                ctypes.POINTER(self._MSLLHOOKSTRUCT)).contents
                            xbtn = (ms.mouseData >> 16) & 0xFFFF
                            if xbtn == self.XBUTTON1:
                                vk = VK_XBUTTON1
                            elif xbtn == self.XBUTTON2:
                                vk = VK_XBUTTON2
                        if vk is not None:
                            with self._lock:
                                registered = vk in self._registered_vks
                            if registered:
                                self.keyPressed.emit(vk)
                except Exception:
                    pass
                return user32.CallNextHookEx(None, nCode, wParam, lParam)

            self._proc = HOOKPROC(hook_proc)
            user32.SetWindowsHookExW.restype = wintypes.HHOOK
            user32.SetWindowsHookExW.argtypes = [
                ctypes.c_int, HOOKPROC, wintypes.HMODULE, wintypes.DWORD]
            self._hook_handle = user32.SetWindowsHookExW(
                self.WH_MOUSE_LL, self._proc,
                kernel32.GetModuleHandleW(None), 0)
            if not self._hook_handle:
                err = ctypes.windll.kernel32.GetLastError() if hasattr(ctypes.windll, 'kernel32') else 0
                print(f"[hotkeys] Mouse hook install failed (last error: {err}). "
                      f"Side mouse buttons won't fire as hotkeys.", file=sys.stderr)
                return
            print(f"[hotkeys] Low-level mouse hook installed (handle={self._hook_handle})",
                  file=sys.stderr)

            msg = wintypes.MSG()
            while not self._stop.is_set():
                bret = user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE)
                if bret:
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
                else:
                    time.sleep(0.005)
            try:
                user32.UnhookWindowsHookEx(self._hook_handle)
            except Exception:
                pass
            self._hook_handle = None
        except Exception as e:
            print(f"[hotkeys] Mouse hook thread crashed: {e}", file=sys.stderr)


_MOUSE_HOOK_SINGLETON = None
_MOUSE_HOOK_LOCK      = threading.Lock()


def _get_mouse_hook():
    global _MOUSE_HOOK_SINGLETON
    if _MOUSE_HOOK_SINGLETON is None:
        with _MOUSE_HOOK_LOCK:
            if _MOUSE_HOOK_SINGLETON is None:
                _MOUSE_HOOK_SINGLETON = _LowLevelMouseHook()
                _MOUSE_HOOK_SINGLETON.start()
    return _MOUSE_HOOK_SINGLETON


# Mouse VKs go to the mouse hook; everything else uses the keyboard hook.
_MOUSE_VKS = frozenset({VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2})


def _get_input_hook(vk_code: int):
    """Return the appropriate hook for a given VK — mouse hook for mouse
    buttons, keyboard hook for everything else."""
    if int(vk_code) in _MOUSE_VKS:
        return _get_mouse_hook()
    return _get_kb_hook()


# Map vk_code → list of GlobalHotkey instances listening to it
_HOTKEY_DISPATCH = {}
_HOTKEY_DISPATCH_LOCK = threading.RLock()


def _on_kb_hook_press(vk: int):
    """Routes a hooked keypress to all GlobalHotkey instances bound to it."""
    with _HOTKEY_DISPATCH_LOCK:
        listeners = list(_HOTKEY_DISPATCH.get(vk, []))
    for hk in listeners:
        try:
            hk.pressed.emit()
        except Exception:
            pass


# =============================================================
# v3.1.1 — RegisterHotKey-based global hotkeys.
#
# The LL keyboard hook approach (the class above) is more powerful in
# theory — it sees every key before any app does — but it has two big
# practical problems in built .exe releases:
#
#   1. GetModuleHandleW(None) returns error 126 (MOD_NOT_FOUND) inside
#      PyInstaller's bootloader, so SetWindowsHookExW fails. Hotkeys
#      silently revert to focus-only.
#   2. Even when it does install, anti-virus / EDR software increasingly
#      blocks LL keyboard hooks since keyloggers use them.
#
# RegisterHotKey is the OLD Win32 API for global hotkeys. It's simpler,
# safer, and works fine in PyInstaller because it doesn't need a module
# handle — just a window handle (which always exists). The downside is
# that hotkeys are first-come-first-served at the system level: if Discord
# or OBS registered F5 first, your F5 message never arrives.
#
# For users without those conflicts (the majority), RegisterHotKey just
# works. For conflict cases, users can bind to less-common combos.
#
# Architecture: WM_HOTKEY messages get caught by MainWindow.nativeEvent
# and dispatched to whichever GlobalHotkey object owns the hotkey ID.
# =============================================================

# Modifier constants for RegisterHotKey
MOD_ALT     = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT   = 0x0004
MOD_WIN     = 0x0008
MOD_NOREPEAT = 0x4000   # don't repeat-fire on key hold


class _RegisterHotKeyManager:
    """Global registry of RegisterHotKey calls. One singleton per app.
    Owns the (hotkey_id → callback) mapping. The actual WM_HOTKEY
    messages get caught in MainWindow.nativeEvent which calls
    dispatch_hotkey_id() here."""

    def __init__(self):
        self._next_id = 0xB100   # arbitrary base — just avoid collisions with system IDs
        self._hwnd = None        # set by attach_to_window()
        self._registrations = {} # hotkey_id → (vk_code, modifiers, callback)
        self._by_vk = {}         # vk_code → hotkey_id (for cleanup)
        self._lock = threading.RLock()
        # v3.1.1 — Track failed registrations so the UI can show a popup
        # when another app has globally claimed the same key. Cleared
        # and rebuilt each time _rebind_hotkeys runs.
        self.failed_registrations = []  # list of (vk_code, key_name) tuples

    def attach_to_window(self, hwnd):
        """Bind this manager to a window. All RegisterHotKey calls go
        to this HWND, and WM_HOTKEY messages must be dispatched from
        this window's nativeEvent."""
        self._hwnd = int(hwnd)
        # If any registrations queued before window was ready, install them now
        self._reinstall_all()

    def _reinstall_all(self):
        """Re-register every known hotkey. Used after attach_to_window
        if any registrations were queued early."""
        if not self._hwnd:
            return
        user32 = ctypes.windll.user32
        with self._lock:
            for hk_id, (vk, mods, _cb) in list(self._registrations.items()):
                try:
                    # Unregister first in case it's already bound (idempotent)
                    user32.UnregisterHotKey(self._hwnd, hk_id)
                    user32.RegisterHotKey(self._hwnd, hk_id, mods, vk)
                except Exception:
                    pass

    def register(self, vk_code: int, callback, modifiers: int = 0):
        """Register a global hotkey. Returns the hotkey ID on success,
        or None on failure. If no window is attached yet, registration
        is queued and will fire on attach_to_window().

        modifiers: bitmask of MOD_ALT/MOD_CONTROL/MOD_SHIFT/MOD_WIN.
        Pass 0 for no-modifier hotkeys (e.g. just F5). MOD_NOREPEAT is
        always added so held keys don't spam fire."""
        with self._lock:
            # If this VK is already registered, replace
            old_id = self._by_vk.get(int(vk_code))
            if old_id is not None:
                self._unregister_id(old_id)

            hk_id = self._next_id
            self._next_id += 1
            mods_with_norepeat = int(modifiers) | MOD_NOREPEAT
            self._registrations[hk_id] = (int(vk_code), mods_with_norepeat, callback)
            self._by_vk[int(vk_code)] = hk_id

        if self._hwnd:
            ok = self._install_one(hk_id, int(vk_code), mods_with_norepeat)
            if not ok:
                self._log(f"RegisterHotKey FAILED for VK=0x{vk_code:02x} mods=0x{modifiers:x} — likely already taken by another app")
                # v3.1.1 — Surface to UI so we can show a conflict popup
                key_name = self._vk_to_name(int(vk_code))
                with self._lock:
                    self.failed_registrations.append((int(vk_code), key_name))
            else:
                self._log(f"RegisterHotKey OK for VK=0x{vk_code:02x} mods=0x{modifiers:x} (id={hk_id})")
        return hk_id

    def _vk_to_name(self, vk: int) -> str:
        """Reverse-lookup VK code → human key name. Falls back to hex if
        the VK isn't in the KEY_NAMES table."""
        try:
            for name, code in KEY_NAMES.items():
                if int(code) == int(vk):
                    return name
        except Exception:
            pass
        return f"0x{vk:02x}"

    def clear_failure_list(self):
        """Called by MainWindow before re-binding. So the failed list
        reflects only the most recent rebind cycle, not historical
        attempts."""
        with self._lock:
            self.failed_registrations = []

    def get_failed_registrations(self):
        """Return a copy of the list of (vk_code, key_name) tuples for
        hotkeys that failed to register. Used by the UI to surface
        conflict notifications."""
        with self._lock:
            return list(self.failed_registrations)

    def _install_one(self, hk_id, vk, mods):
        """Actually call Win32 RegisterHotKey. Returns True on success."""
        try:
            user32 = ctypes.windll.user32
            user32.UnregisterHotKey(self._hwnd, hk_id)  # idempotent
            return bool(user32.RegisterHotKey(self._hwnd, hk_id, mods, vk))
        except Exception:
            return False

    def unregister_vk(self, vk_code: int):
        """Remove the hotkey for this VK code if one exists."""
        with self._lock:
            hk_id = self._by_vk.pop(int(vk_code), None)
            if hk_id is not None:
                self._unregister_id(hk_id)

    def _unregister_id(self, hk_id):
        self._registrations.pop(hk_id, None)
        if self._hwnd:
            try:
                ctypes.windll.user32.UnregisterHotKey(self._hwnd, hk_id)
            except Exception:
                pass

    def dispatch_hotkey_id(self, hk_id: int):
        """Called from MainWindow.nativeEvent when a WM_HOTKEY arrives.
        Looks up the callback and fires it. Cheap (just a dict lookup +
        a function call) so it can't slow the message pump."""
        with self._lock:
            entry = self._registrations.get(int(hk_id))
        if entry is not None:
            _, _, callback = entry
            try:
                callback()
            except Exception:
                pass

    def _log(self, msg):
        """Best-effort log to startup.log (set up by main())."""
        try:
            import builtins as _bi
            fn = getattr(_bi, '_throttlr_startup_log', None)
            if fn:
                fn(f"[hotkeys-rhk] {msg}")
        except Exception:
            pass


# Singleton
_RHK_MANAGER = None
_RHK_LOCK = threading.Lock()

def _get_rhk_manager() -> _RegisterHotKeyManager:
    global _RHK_MANAGER
    if _RHK_MANAGER is None:
        with _RHK_LOCK:
            if _RHK_MANAGER is None:
                _RHK_MANAGER = _RegisterHotKeyManager()
    return _RHK_MANAGER


class GlobalHotkey(QObject):
    """Public API matches the old class — one instance per registered hotkey.
    Internally backed by the shared low-level keyboard hook."""

    pressed = Signal()

    def __init__(self, vk_code: int, hotkey_id: int):
        super().__init__()
        self.vk_code = int(vk_code)
        self.hotkey_id = hotkey_id   # legacy; kept for API compatibility
        self.registered = False

    def start(self):
        # v3.1.1 — Route keyboard hotkeys through RegisterHotKey API
        # (works reliably in PyInstaller .exe builds, which the LL hook
        # doesn't). Mouse VKs stay on the LL mouse hook since
        # RegisterHotKey doesn't support mouse buttons at all.
        if int(self.vk_code) in _MOUSE_VKS:
            return self._start_mouse_via_ll_hook()
        else:
            return self._start_keyboard_via_register_hotkey()

    def _start_keyboard_via_register_hotkey(self):
        """v3.1.1 — RegisterHotKey path for keyboard VKs. The hotkey
        gets registered with no modifiers (matching the existing UI
        which only accepts a single key, not a key combo). If another
        app already claimed the same key globally, registration silently
        fails — the app-level filter then handles it when Throttlr has
        focus."""
        mgr = _get_rhk_manager()
        # Callback emits the Qt signal so handlers run on the main thread
        def _cb():
            try:
                self.pressed.emit()
            except Exception:
                pass
        mgr.register(self.vk_code, _cb, modifiers=0)
        self.registered = True

    def _start_mouse_via_ll_hook(self):
        """Legacy LL-hook path. Used only for mouse VKs (Mouse3/4/5)
        since RegisterHotKey doesn't support mouse buttons."""
        hook = _get_input_hook(self.vk_code)
        global _HOTKEY_DISPATCH_CONNECTED
        try:
            already = _HOTKEY_DISPATCH_CONNECTED  # noqa
        except NameError:
            _get_kb_hook().keyPressed.connect(_on_kb_hook_press, Qt.QueuedConnection)
            globals()['_HOTKEY_DISPATCH_CONNECTED'] = True
        global _MOUSE_HOOK_DISPATCH_CONNECTED
        try:
            already_m = _MOUSE_HOOK_DISPATCH_CONNECTED  # noqa
        except NameError:
            try:
                if _MOUSE_HOOK_SINGLETON is not None:
                    _MOUSE_HOOK_SINGLETON.keyPressed.connect(
                        _on_kb_hook_press, Qt.QueuedConnection)
                    globals()['_MOUSE_HOOK_DISPATCH_CONNECTED'] = True
            except Exception:
                pass
        if int(self.vk_code) in _MOUSE_VKS:
            try:
                if not globals().get('_MOUSE_HOOK_DISPATCH_CONNECTED'):
                    hook.keyPressed.connect(_on_kb_hook_press, Qt.QueuedConnection)
                    globals()['_MOUSE_HOOK_DISPATCH_CONNECTED'] = True
            except Exception:
                pass

        with _HOTKEY_DISPATCH_LOCK:
            _HOTKEY_DISPATCH.setdefault(self.vk_code, []).append(self)
        hook.register_vk(self.vk_code)
        self.registered = True

    def stop(self):
        try:
            if int(self.vk_code) in _MOUSE_VKS:
                # Legacy LL-hook path for mouse VKs
                with _HOTKEY_DISPATCH_LOCK:
                    lst = _HOTKEY_DISPATCH.get(self.vk_code, [])
                    if self in lst:
                        lst.remove(self)
                    if not lst:
                        _HOTKEY_DISPATCH.pop(self.vk_code, None)
                        if _MOUSE_HOOK_SINGLETON is not None:
                            _MOUSE_HOOK_SINGLETON.unregister_vk(self.vk_code)
            else:
                # v3.1.1 — keyboard path: unregister from RegisterHotKey manager
                _get_rhk_manager().unregister_vk(self.vk_code)
        except Exception:
            pass
        self.registered = False


class _AppLevelHotkeyFilter(QObject):
    """v3.0.6 — App-level fallback hotkey handler. Installs as a Qt application
    event filter, sees every key event Qt processes when Throttlr has focus.

    The low-level Windows keyboard hook in _LowLevelKeyboardHook is the
    primary mechanism (works system-wide, even when games own focus). But it
    can fail in rare cases — some EDR / antivirus setups block SetWindowsHookExW
    for non-system processes, or PyInstaller-frozen exes can have permission
    quirks. This filter is the safety net so hotkeys always work AT LEAST
    inside the Throttlr window.

    Reads the same hotkey_* settings the LL hook uses, so Settings → Hotkeys
    in the UI controls both paths simultaneously.
    """

    def __init__(self, main_window):
        super().__init__()
        self._main = main_window  # weak-ish; main_window outlives this filter

    def eventFilter(self, watched, event):
        try:
            from PySide6.QtCore import QEvent
            etype = event.type()
            if etype != QEvent.KeyPress and etype != QEvent.MouseButtonPress:
                return False
            mw = self._main
            if mw is None or not hasattr(mw, 'bridge'):
                return False

            # Suppress when the low-level Windows hook is alive and well —
            # otherwise we'd fire hotkeyFired twice (once from the LL hook,
            # once from this filter) when Throttlr has focus, which means
            # the user's toggle action would double-flip.
            try:
                if etype == QEvent.KeyPress:
                    hook = _KB_HOOK_SINGLETON
                else:
                    hook = _MOUSE_HOOK_SINGLETON
                if hook is not None and hook.is_installed():
                    return False
            except Exception:
                pass  # if anything goes wrong checking, fall through and fire

            settings = mw.settings
            # Read configured VKs (fall back to defaults)
            ss_vk = KEY_NAMES.get(settings.get("hotkey_startstop") or "", VK_F5)
            fz_vk = KEY_NAMES.get(settings.get("hotkey_freeze") or "",   VK_F8)
            bl_vk = KEY_NAMES.get(settings.get("hotkey_block") or "",    VK_F9)
            fn_vk = KEY_NAMES.get(settings.get("hotkey_fun") or "",      VK_F10)
            ks_key = settings.get("hotkey_killswitch") or ""
            ks_vk  = KEY_NAMES.get(ks_key) if ks_key else None

            if etype == QEvent.KeyPress:
                # Qt key → Windows VK mapping is direct for letters/numbers
                # but we use nativeVirtualKey() which gives the actual Win32 VK.
                try:
                    vk = int(event.nativeVirtualKey())
                except Exception:
                    return False
            else:
                # MouseButtonPress — translate Qt button → mouse VK. Skip
                # left + right click (they'd swallow normal UI clicks).
                from PySide6.QtCore import Qt as _Qt
                btn = event.button()
                if btn == _Qt.MiddleButton:
                    vk = VK_MBUTTON
                elif btn == _Qt.BackButton or btn == _Qt.XButton1:
                    vk = VK_XBUTTON1
                elif btn == _Qt.ForwardButton or btn == _Qt.XButton2:
                    vk = VK_XBUTTON2
                else:
                    return False  # left/right click — ignore

            if vk == ss_vk:
                mw.bridge.hotkeyFired.emit("startstop"); return True
            if vk == fz_vk:
                mw.bridge.hotkeyFired.emit("freeze"); return True
            if vk == bl_vk:
                mw.bridge.hotkeyFired.emit("block"); return True
            if vk == fn_vk:
                mw.bridge.hotkeyFired.emit("fun"); return True
            if ks_vk is not None and vk == ks_vk:
                mw.bridge.hotkeyFired.emit("killswitch"); return True
        except Exception:
            pass
        return False


# ============================================================
# NetworkController
# ============================================================

class NetworkController(QObject):
    status_changed = Signal(str)
    error_occurred = Signal(str)

    def __init__(self):
        super().__init__()
        self.config = FilterConfig()
        self.config_lock = threading.RLock()

        self.conn_map: dict = {}
        self.conn_lock = threading.RLock()
        # Phase 2 — richer per-connection tracking for the Connection
        # Inspector and the SNI/geo/blocklist filters. Keyed by local_port.
        # Populated by the FLOW-layer listener (real-time kernel events) and
        # decorated by the capture loop with byte counts and SNI hostnames.
        self.connection_table: dict = {}     # local_port -> ConnectionInfo

        self.delay_queue: list = []
        self.delay_lock = threading.Lock()
        self.delay_seq = 0

        self.freeze_queue: deque = deque()
        self.freeze_lock = threading.Lock()
        self.freeze_started_at: float = 0.0

        self.throttle_tokens_in = 0.0
        self.throttle_tokens_out = 0.0
        self.throttle_last_ts = time.monotonic()
        self.throttle_lock = threading.Lock()
        # v3.1.3.2 — per-app multi-target settings. When non-empty, the worker
        # selects a per-app FilterConfig per packet (via config.pid_to_app).
        # Empty => single shared config (legacy behavior, byte-identical).
        self.per_app_cfgs = {}
        self.throttle_state_by_app = {}  # app_name -> {"in":float,"out":float,"ts":float}

        self.bw_history_in = deque(maxlen=60)
        self.bw_history_out = deque(maxlen=60)
        self.bw_current_in = 0
        self.bw_current_out = 0
        self.bw_window_start = time.monotonic()

        self.running = False
        self.windivert = None
        self.flow_handle = None    # FLOW-layer handle for kernel-level PID resolution
        self._pass_through = False  # while True, capture loop just relays packets without filtering

        # Phase 3 — PCAP writer + compiled filter script
        self.pcap_writer = PcapWriter()
        self.filter_script = None   # None or FilterScript instance

        # v3.1.0 (network-visibility batch) — Background latency probe.
        # Runs a thread that pings a configurable host every second and
        # keeps the last 60 samples. Feeds both the main traffic graph
        # (RTT overlay line) and a dedicated readout.
        self.latency_probe_on: bool = False
        self.latency_probe_host: str = "1.1.1.1"
        self.latency_history: deque = deque(maxlen=60)  # list of (ms or None)
        self.latency_last_ms: float = 0.0
        self.latency_thread: threading.Thread = None
        self.latency_stop = threading.Event()

        # v3.1.0 — Live packet dump ring buffer (last 200 packet headers).
        # Captured opportunistically by _capture_loop when packet_dump_on
        # is True. Lightweight: just header tuples, no body bytes.
        self.packet_dump_on: bool = False
        self.packet_dump_buffer: deque = deque(maxlen=200)
        self.packet_dump_lock = threading.Lock()
        self.packet_dump_seq: int = 0

    def update_config(self, cfg: FilterConfig):
        with self.config_lock:
            was_frozen = self.config.freeze_on
            cfg.packets_seen = self.config.packets_seen
            cfg.packets_dropped = self.config.packets_dropped
            cfg.packets_delayed = self.config.packets_delayed
            cfg.packets_held = self.config.packets_held
            cfg.bytes_seen = self.config.bytes_seen
            self.config = cfg
            if cfg.freeze_on and not was_frozen:
                self.freeze_started_at = time.monotonic()
            elif not cfg.freeze_on and was_frozen:
                self.freeze_started_at = 0.0

    def reset_stats(self):
        with self.config_lock:
            self.config.packets_seen = 0
            self.config.packets_sent = 0       # v3.0.7
            self.config.packets_received = 0   # v3.0.7
            self.config.packets_dropped = 0
            self.config.packets_delayed = 0
            self.config.bytes_seen = 0
        self.bw_history_in.clear()
        self.bw_history_out.clear()
        self.bw_current_in = 0
        self.bw_current_out = 0

    def clear_freeze_queue(self):
        with self.freeze_lock:
            n = len(self.freeze_queue)
            self.freeze_queue.clear()
        with self.config_lock:
            self.config.packets_held = 0
        return n

    def get_stats(self):
        with self.config_lock:
            duration = 0.0
            if self.config.freeze_on and self.freeze_started_at:
                duration = time.monotonic() - self.freeze_started_at
            return (
                self.config.packets_seen,
                self.config.packets_dropped,
                self.config.packets_delayed,
                self.config.packets_held,
                self.config.bytes_seen,
                self.config.freeze_on,
                duration,
                self.config.packets_sent,       # v3.0.7
                self.config.packets_received,   # v3.0.7
            )

    def get_bandwidth_history(self):
        return list(self.bw_history_in), list(self.bw_history_out)

    # ----- v3.1.0 (network-visibility batch) — Latency probe -----
    # Pings a configurable host once per second, stores recent samples.
    # Runs independent of the WinDivert engine — even when capture is
    # stopped, the probe can keep measuring if the user wants.

    def get_latency_history(self):
        """Return a copy of the last ~60 RTT samples (ms). None entries
        represent failed pings."""
        return list(self.latency_history)

    def set_latency_probe(self, on: bool, host: str = None):
        """Toggle the probe and optionally update the target host. Safe to
        call from any thread."""
        if host is not None:
            h = (host or "").strip()
            if h:
                self.latency_probe_host = h
        if on and not self.latency_probe_on:
            self.latency_probe_on = True
            self.latency_stop.clear()
            t = threading.Thread(target=self._latency_loop, daemon=True)
            self.latency_thread = t
            t.start()
        elif not on and self.latency_probe_on:
            self.latency_probe_on = False
            self.latency_stop.set()

    def _latency_loop(self):
        """Background thread: shell out to ping.exe once per second, parse
        the RTT, push to history. Uses ping.exe so we don't need raw
        sockets — Throttlr already runs as admin but raw ICMP on Windows
        is fiddly enough that the shell-out is more reliable."""
        import re
        import subprocess as _sp
        # Hide the console window — CREATE_NO_WINDOW = 0x08000000 on Win32
        CREATE_NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0
        rtt_re = re.compile(r'time[=<]\s*(\d+(?:\.\d+)?)\s*ms', re.IGNORECASE)
        while not self.latency_stop.is_set() and self.latency_probe_on:
            ms = None
            try:
                host = self.latency_probe_host or "1.1.1.1"
                # -n 1 = one ping, -w 1000 = 1s timeout
                proc = _sp.run(
                    ["ping", "-n", "1", "-w", "1000", host],
                    capture_output=True, text=True, timeout=2,
                    creationflags=CREATE_NO_WINDOW,
                )
                m = rtt_re.search(proc.stdout or "")
                if m:
                    ms = float(m.group(1))
            except Exception:
                ms = None
            self.latency_history.append(ms)
            if ms is not None:
                self.latency_last_ms = ms
            # Wait ~1s, checking stop event every 100ms for fast shutdown
            for _ in range(10):
                if self.latency_stop.wait(0.1):
                    break

    # ----- v3.1.0 (network-visibility batch) — Live packet dump -----
    # Public helper used by _capture_loop to record a header tuple when
    # the dump tab is open. Stays cheap — bounded deque, tiny tuples,
    # no per-packet allocation beyond the tuple itself.

    def record_packet_dump(self, pkt, direction: str):
        """Cheaply append a packet header summary to the dump buffer.
        Called from the capture hot path — must be FAST."""
        if not self.packet_dump_on:
            return
        try:
            self.packet_dump_seq += 1
            # Header summary — keep it small. Direction is 'in' or 'out'.
            proto = 'TCP' if pkt.tcp else ('UDP' if pkt.udp else 'OTHER')
            src = f"{pkt.src_addr}:{pkt.src_port}" if (pkt.tcp or pkt.udp) else str(pkt.src_addr)
            dst = f"{pkt.dst_addr}:{pkt.dst_port}" if (pkt.tcp or pkt.udp) else str(pkt.dst_addr)
            size = len(pkt.raw) if pkt.raw else 0
            # (seq, monotonic_ts, direction, proto, src, dst, size)
            entry = (self.packet_dump_seq, time.monotonic(), direction, proto, src, dst, size)
            with self.packet_dump_lock:
                self.packet_dump_buffer.append(entry)
        except Exception:
            # Never let the dump crash the capture loop
            pass

    def get_packet_dump(self, since_seq: int = 0):
        """Return all dump entries newer than `since_seq`. Frontend polls
        with the last-seen seq so we don't resend the whole buffer."""
        with self.packet_dump_lock:
            return [e for e in self.packet_dump_buffer if e[0] > since_seq]

    def clear_packet_dump(self):
        with self.packet_dump_lock:
            self.packet_dump_buffer.clear()
            self.packet_dump_seq = 0

    def start(self):
        if self.running:
            return
        if not HAS_PYDIVERT:
            self.error_occurred.emit(f"pydivert not available: {PYDIVERT_ERROR}")
            return
        try:
            self.windivert = pydivert.WinDivert("tcp or udp")
            self.windivert.open()
            self.running = True
        except Exception as e:
            self.error_occurred.emit(
                f"Could not open WinDivert: {e}\n\n"
                "Make sure you're running as Administrator."
            )
            self.running = False
            return

        threading.Thread(target=self._capture_loop, daemon=True).start()
        threading.Thread(target=self._delay_drain_loop, daemon=True).start()
        threading.Thread(target=self._freeze_drain_loop, daemon=True).start()
        threading.Thread(target=self._conn_refresh_loop, daemon=True).start()
        # Open a second WinDivert handle on the FLOW layer to receive
        # connection-open/close events with ProcessId already attached at
        # the kernel level. This is dramatically more reliable than polling
        # psutil for the port→PID mapping, especially for short-lived UDP
        # flows (Discord voice, game traffic, etc.) that psutil can miss
        # entirely.
        self._start_flow_listener()
        self.status_changed.emit("running")

    def _start_flow_listener(self):
        """Open a SNIFF-mode WinDivert handle on the FLOW layer and start
        a thread that reads connection events into self.conn_map.
        Falls back silently if the FLOW layer is unavailable — the psutil-
        based refresh loop still runs as a backup."""
        try:
            import pydivert
            self.flow_handle = pydivert.WinDivert(
                "true",
                layer=pydivert.Layer.FLOW,
                flags=pydivert.Flag.SNIFF | pydivert.Flag.RECV_ONLY,
            )
            self.flow_handle.open()
            threading.Thread(target=self._flow_listen_loop, daemon=True).start()
        except Exception:
            # FLOW layer not supported / driver too old / something else —
            # fall back to psutil polling alone.
            self.flow_handle = None

    def _flow_listen_loop(self):
        """Read connection events as fast as the kernel emits them and
        populate both the lightweight conn_map (local_port → PID) and the
        richer connection_table (local_port → ConnectionInfo). Runs until
        self.running flips false or the handle is closed."""
        EVT_FLOW_ESTABLISHED = 1
        EVT_FLOW_DELETED     = 2
        while self.running and self.flow_handle is not None:
            try:
                pkt = self.flow_handle.recv()
            except Exception:
                break
            try:
                f = pkt.flow
                if f is None:
                    continue
                local_port = int(f.LocalPort)
                pid = int(f.ProcessId)
                evt = int(pkt.event)
                remote_port = int(f.RemotePort)
                proto_num = int(f.Protocol)
                # Convert the IPv6-mapped IPv4 stored in LocalAddr/RemoteAddr.
                # WinDivert stores IPv4 in [3] of the c_uint32 array in
                # *host* byte order, with [0..2] zero or 0xffff.
                la = int(f.LocalAddr[3])
                ra = int(f.RemoteAddr[3])
                local_addr = (f"{(la >> 24) & 0xff}.{(la >> 16) & 0xff}."
                              f"{(la >> 8) & 0xff}.{la & 0xff}") if la else ""
                remote_addr = (f"{(ra >> 24) & 0xff}.{(ra >> 16) & 0xff}."
                               f"{(ra >> 8) & 0xff}.{ra & 0xff}") if ra else ""
            except Exception:
                continue
            if pid <= 0 or local_port == 0:
                continue
            now = time.monotonic()
            proto_str = {6: "TCP", 17: "UDP"}.get(proto_num, str(proto_num))
            with self.conn_lock:
                if evt == EVT_FLOW_ESTABLISHED:
                    self.conn_map[local_port] = pid
                    info = ConnectionInfo(
                        pid=pid, proto=proto_str,
                        local_addr=local_addr, local_port=local_port,
                        remote_addr=remote_addr, remote_port=remote_port,
                        established_at=now, last_seen=now,
                    )
                    # Resolve country lazily — geo lookup is cheap
                    if remote_addr:
                        info.country = lookup_country(remote_addr)
                    self.connection_table[local_port] = info
                elif evt == EVT_FLOW_DELETED:
                    if self.conn_map.get(local_port) == pid:
                        self.conn_map.pop(local_port, None)
                    # Keep ConnectionInfo around for ~30s after close so the
                    # Inspector can still show the most-recently-closed flows.
                    info = self.connection_table.get(local_port)
                    if info and info.pid == pid:
                        info.last_seen = now
                        # Mark for cleanup later; capture_loop trims old entries
        try:
            if self.flow_handle:
                self.flow_handle.close()
        except Exception:
            pass
        self.flow_handle = None

    def stop(self):
        """Stop the capture. If the freeze queue still has held packets,
        drain them first (replay them out) and finalize the stop only when
        the queue is empty. The user expects this — that's the whole point
        of freeze: hold packets, then release them on demand.

        Pressing stop a second time during the drain force-quits."""
        if self._pass_through:
            # Already in drain mode and user hit stop again → cancel drain,
            # discard remaining packets, finalize immediately.
            self._finalize_stop()
            return

        with self.freeze_lock:
            queued = len(self.freeze_queue)

        if queued > 0:
            # Enter "draining for stop" mode.
            self._pass_through = True
            with self.config_lock:
                self.config.freeze_on = False
            threading.Thread(target=self._watch_drain_then_finalize,
                             daemon=True).start()
        else:
            self._finalize_stop()

    def _watch_drain_then_finalize(self):
        """Background watcher: waits for the freeze queue to drain to zero,
        then triggers the real shutdown."""
        # Hard timeout safety: if drain doesn't finish in 60s (e.g. user set
        # 2000ms replay with 100k packets in queue), force-stop anyway.
        deadline = time.monotonic() + 60.0
        while time.monotonic() < deadline:
            with self.freeze_lock:
                qlen = len(self.freeze_queue)
            if qlen == 0:
                break
            time.sleep(0.05)
        self._finalize_stop()

    def _finalize_stop(self):
        """The actual shutdown. Closes WinDivert handles, clears state,
        emits the stopped signal."""
        self.running = False
        self._pass_through = False
        try:
            if self.windivert:
                self.windivert.close()
        except Exception:
            pass
        self.windivert = None
        try:
            if self.flow_handle:
                self.flow_handle.close()
        except Exception:
            pass
        self.flow_handle = None
        # Phase 3: finalize PCAP recording if active
        try:
            if self.pcap_writer.recording:
                self.pcap_writer.stop()
        except Exception:
            pass
        with self.conn_lock:
            self.conn_map.clear()
            self.connection_table.clear()
        with self.delay_lock:
            self.delay_queue = []
            self.delay_seq = 0
        with self.freeze_lock:
            self.freeze_queue.clear()
        with self.config_lock:
            self.config.packets_held = 0
        self.status_changed.emit("stopped")

    def _conn_refresh_loop(self):
        tick = 0
        while self.running:
            try:
                self._refresh_conn_map()
            except Exception:
                pass
            tick += 1
            if tick % 2 == 0:
                try:
                    self._refresh_target_pids()
                except Exception:
                    pass
            # Every 10 ticks (~5s) trim stale connections from the table
            if tick % 10 == 0:
                try:
                    self._trim_connection_table()
                except Exception:
                    pass
            time.sleep(0.5)

    def _refresh_target_pids(self):
        """Re-resolve target_pids from the saved target_names. Walks the
        process tree to include child processes (Discord helpers, Chrome
        renderers, anti-cheat sub-processes, etc.) so the entire app family
        gets filtered, not just the parent.

        Honors target_names (multi-target). Falls back to target_name for
        legacy single-target behavior.

        v3.0.7 — also honors `target_pid_excludes` from the settings: a list
        of specific PIDs the user has unticked in the Process Tree picker.
        Those PIDs are removed from the resolved set so Throttlr ignores
        them. Stale PIDs in the exclude list (process exited) are harmless —
        they just don't match anything in the current scan."""
        with self.config_lock:
            names = list(self.config.target_names)
            if not names and self.config.target_name:
                names = [self.config.target_name]
        if not names:
            return

        name_set = set(names)

        # First pass: find every top-level PID whose process name matches ANY
        # of the targets.
        root_pids = set()
        root_pid_name = {}                       # v3.1.3.2 — pid -> matched app name
        try:
            for proc in psutil.process_iter(['pid', 'name']):
                try:
                    if proc.info['name'] in name_set:
                        root_pids.add(proc.info['pid'])
                        root_pid_name[proc.info['pid']] = proc.info['name']
                except Exception:
                    continue
        except Exception:
            return
        if not root_pids:
            return

        # Second pass: walk descendants of each root PID
        all_pids = set(root_pids)
        pid_to_app = dict(root_pid_name)          # v3.1.3.2 — seed with root pids
        try:
            for root_pid in list(root_pids):
                try:
                    p = psutil.Process(root_pid)
                    _root_name = root_pid_name.get(root_pid, "")
                    for child in p.children(recursive=True):
                        try:
                            all_pids.add(child.pid)
                            pid_to_app[child.pid] = _root_name
                        except Exception:
                            continue
                except Exception:
                    continue
        except Exception:
            pass

        # v3.0.7 — strip user-excluded PIDs from the final set, but ONLY when
        # the Connected Processes feature is enabled. When the feature is
        # off, Throttlr ignores the exclude list entirely and targets all
        # related processes (legacy behavior).
        try:
            if self.config.connected_procs_enabled:
                excludes = self.config.target_pid_excludes or set()
                if excludes:
                    all_pids -= set(int(x) for x in excludes)
        except Exception:
            pass

        with self.config_lock:
            self.config.target_pids = all_pids
            self.config.pid_to_app = pid_to_app

    def _refresh_conn_map(self):
        """psutil-polling fallback. The FLOW-layer listener is the primary
        source for the conn_map; this merges in any additional entries
        psutil knows about, without clobbering FLOW-discovered entries."""
        new_entries = {}
        try:
            for c in psutil.net_connections(kind="inet"):
                if c.pid is None:
                    continue
                if c.laddr:
                    # Key by local port to match the FLOW listener's format
                    new_entries[c.laddr.port] = c.pid
        except (psutil.AccessDenied, PermissionError):
            return
        except Exception:
            return
        # Merge: don't overwrite entries the FLOW listener has already
        # populated — those are from real kernel events and are more
        # reliable than the psutil snapshot.
        with self.conn_lock:
            for port, pid in new_entries.items():
                self.conn_map.setdefault(port, pid)

    def _packet_pid(self, pkt) -> int:
        """Resolve a packet's owning PID via the conn_map. The map is
        primarily fed by the FLOW-layer listener (kernel-level events with
        ProcessId), with a psutil-polling fallback. We key by local port —
        for outbound packets that's the source port, for inbound it's the
        destination port."""
        try:
            with self.conn_lock:
                cm = self.conn_map
            try:
                port = pkt.src_port if pkt.is_outbound else pkt.dst_port
            except Exception:
                return 0
            return cm.get(port, 0)
        except Exception:
            return 0

    def _matches_target(self, pkt) -> bool:
        with self.config_lock:
            tpids = set(self.config.target_pids)
        if not tpids:
            return False
        return self._packet_pid(pkt) in tpids

    def _direction_allowed(self, pkt, in_flag, out_flag) -> bool:
        try:
            return out_flag if pkt.is_outbound else in_flag
        except Exception:
            return False

    def _should_drop_packet(self, cfg) -> bool:
        """Return True if this packet should be dropped, based on the
        configured drop pattern. Called only when drop is on and direction
        already passed. v3.1.0 — supports 'uniform' (random %) and
        'bursty' (clustered drops with gaps between bursts)."""
        pattern = getattr(cfg, 'drop_pattern', 'uniform') or 'uniform'

        if pattern == 'bursty':
            # State machine: GAP → eligible → (roll dice) → BURST → GAP …
            # Mid-burst: always drop, decrement remaining counter
            if cfg._drop_burst_remaining > 0:
                cfg._drop_burst_remaining -= 1
                if cfg._drop_burst_remaining == 0:
                    # Burst just ended — start the inter-burst gap
                    cfg._drop_gap_remaining = max(1, int(cfg.drop_gap_len))
                return True
            # In gap — never drop, just count down
            if cfg._drop_gap_remaining > 0:
                cfg._drop_gap_remaining -= 1
                return False
            # Idle — roll dice. On a hit, start a burst of length burst_len.
            if random.randint(1, 100) <= cfg.drop_chance:
                blen = max(1, int(cfg.drop_burst_len))
                cfg._drop_burst_remaining = blen - 1   # this packet counts as #1
                if blen == 1:
                    cfg._drop_gap_remaining = max(1, int(cfg.drop_gap_len))
                return True
            return False

        # Uniform — same behavior as pre-v3.1.0
        return random.randint(1, 100) <= cfg.drop_chance

    def _update_bandwidth_quota(self, pkt_size: int):
        """Tick the daily byte counter and fire the configured action once
        when today's total crosses quota_mb. Called from the capture hot
        path with self.config_lock already held."""
        from datetime import date
        cfg = self.config
        today_iso = date.today().isoformat()

        # Day rollover — reset counter at midnight
        if cfg.quota_day_iso != today_iso:
            cfg.quota_day_iso = today_iso
            cfg.quota_today_bytes = 0
            cfg.quota_fired = False

        cfg.quota_today_bytes += pkt_size

        # Fire action if threshold crossed and we haven't fired yet today
        if not cfg.quota_fired and cfg.quota_today_bytes >= cfg.quota_mb * 1024 * 1024:
            cfg.quota_fired = True
            action = (cfg.quota_action or "throttle").lower()
            if action == "throttle":
                cfg.throttle_on = True
                cfg.throttle_kbps = max(1, int(cfg.quota_throttle_kbps))
            elif action == "block":
                cfg.block_on = True
            # 'notify' just flips the fired flag — frontend will surface it

    def _capture_loop(self):
        try:
            while self.running and self.windivert:
                try:
                    pkt = self.windivert.recv()
                except Exception:
                    if not self.running:
                        break
                    continue

                # During the post-stop drain, capture loop becomes a pure
                # relay — no PID matching, no filtering, no stat updates.
                # The drain loop is responsible for replaying the held
                # queue out to the network during this phase.
                if self._pass_through:
                    try:
                        self.windivert.send(pkt)
                    except Exception:
                        pass
                    continue

                if not self._matches_target(pkt):
                    try:
                        self.windivert.send(pkt)
                    except Exception:
                        pass
                    continue

                pkt_size = 0
                try:
                    pkt_size = len(pkt.raw)
                except Exception:
                    pass

                with self.config_lock:
                    self.config.packets_seen += 1
                    # v3.0.7 — split by direction so the UI can show both
                    # outbound (sent) and inbound (received) counts. pkt.is_outbound
                    # is the kernel-level direction flag from WinDivert.
                    try:
                        if pkt.is_outbound:
                            self.config.packets_sent += 1
                        else:
                            self.config.packets_received += 1
                    except Exception:
                        pass
                    self.config.bytes_seen += pkt_size
                    # v3.1.0 (real-networks) — Bandwidth quota counter.
                    # Update the per-day counter and fire the action exactly
                    # once when threshold is crossed.
                    if self.config.bandwidth_quota_on:
                        try:
                            self._update_bandwidth_quota(pkt_size)
                        except Exception:
                            pass
                    cfg = self.config
                    # v3.1.3.2 — multi-target per-app: pick this packet's app config
                    _pkt_app = None
                    if self.per_app_cfgs:
                        _pkt_app = self.config.pid_to_app.get(self._packet_pid(pkt))
                        if _pkt_app and _pkt_app in self.per_app_cfgs:
                            cfg = self.per_app_cfgs[_pkt_app]

                self._track_bandwidth(pkt, pkt_size)

                # === Phase 2: per-connection tracking + SNI parsing ===
                # Update the rich ConnectionInfo for this packet so the
                # Connection Inspector and the Domain/Geo filters have
                # accurate, current data.
                self._track_connection(pkt, pkt_size)

                # === Phase 3: PCAP recording ===
                # Always-on while pcap_writer.recording. We write the raw
                # IP packet bytes; Wireshark / tcpdump can decode this
                # straight away (linktype RAW IPv4).
                try:
                    if self.pcap_writer.recording:
                        self.pcap_writer.write_packet(bytes(pkt.raw))
                except Exception:
                    pass

                # v3.1.0 (network-visibility) — Live packet dump tap.
                # Cheap no-op when dump tab is closed (one bool check).
                if self.packet_dump_on:
                    try:
                        self.record_packet_dump(
                            pkt, 'out' if pkt.is_outbound else 'in')
                    except Exception:
                        pass

                # === Phase 3: Filter script ===
                # If a compiled filter script is active and matches this
                # packet, apply the configured action.
                if cfg.script_on and self.filter_script is not None and self.filter_script.compiled:
                    info = self._connection_for(pkt)
                    pv = _PktView(pkt,
                                  hostname=info.hostname if info else "",
                                  country=info.country if info else "")
                    if self.filter_script.matches(pv):
                        action = cfg.script_action
                        if action == "drop":
                            with self.config_lock:
                                self.config.packets_dropped += 1
                            continue
                        elif action == "keep_only":
                            # If it matches, it passes — nothing to do
                            pass
                        # "lag" and "log" actions could be handled here too;
                        # for now they're recognized but treat as drop=False
                    elif cfg.script_action == "keep_only":
                        # In keep_only mode, non-matching packets get dropped
                        with self.config_lock:
                            self.config.packets_dropped += 1
                        continue

                # === Phase 2: Domain blocklist ===
                # Drop packets whose connection has a hostname matching
                # any active blocklist. Uses the SNI captured on TLS
                # ClientHello packets.
                if cfg.domain_block_on:
                    info = self._connection_for(pkt)
                    if info and info.hostname and host_in_blocklists(
                            info.hostname, cfg.domain_block_lists, cfg.domain_block_custom):
                        with self.config_lock:
                            self.config.packets_dropped += 1
                        continue

                # === Phase 2: Geo blocking ===
                if cfg.geo_block_on and cfg.geo_block_countries:
                    info = self._connection_for(pkt)
                    if info and info.country in cfg.geo_block_countries:
                        with self.config_lock:
                            self.config.packets_dropped += 1
                        continue

                if cfg.block_on and self._direction_allowed(pkt, cfg.block_inbound, cfg.block_outbound):
                    with self.config_lock:
                        self.config.packets_dropped += 1
                    continue

                if cfg.freeze_on and self._direction_allowed(pkt, cfg.freeze_inbound, cfg.freeze_outbound):
                    with self.freeze_lock:
                        if len(self.freeze_queue) >= FREEZE_QUEUE_CAP:
                            self.freeze_queue.popleft()
                        self.freeze_queue.append(pkt)
                    with self.config_lock:
                        self.config.packets_held = len(self.freeze_queue)
                    continue

                if cfg.drop_on and self._direction_allowed(pkt, cfg.drop_inbound, cfg.drop_outbound):
                    # Optional "DNS only" sub-filter — only drop packets to/from
                    # port 53 (DNS). Lets the user simulate a broken DNS while
                    # leaving the rest of the connection intact.
                    on_dns = False
                    if cfg.drop_dns_only:
                        try:
                            on_dns = (pkt.src_port == 53 or pkt.dst_port == 53)
                        except Exception:
                            on_dns = False

                    # If drop_dns_only is set and this isn't a DNS packet,
                    # skip drop logic entirely. Otherwise consult the
                    # pattern-aware drop decision below.
                    should_eval = (not cfg.drop_dns_only) or on_dns

                    if should_eval and self._should_drop_packet(cfg):
                        with self.config_lock:
                            self.config.packets_dropped += 1
                        continue

                # v3.1.0 (real-networks batch) — DNS chaos mode.
                # Drop all outbound DNS queries (UDP/TCP port 53). Apps
                # see DNS as broken. Independent of the drop function so
                # the user can test "broken DNS" without dropping other
                # traffic. DoH apps bypass this — that's expected.
                if cfg.dns_chaos_on:
                    try:
                        if pkt.is_outbound and pkt.dst_port == 53:
                            with self.config_lock:
                                self.config.packets_dropped += 1
                            continue
                    except Exception:
                        pass

                if cfg.fun_mode:
                    if random.randint(0, 100) < cfg.fun_intensity / 4:
                        with self.config_lock:
                            self.config.packets_dropped += 1
                        continue

                if cfg.throttle_on and self._direction_allowed(pkt, cfg.throttle_inbound, cfg.throttle_outbound):
                    if not self._consume_token(pkt, pkt_size, cfg.throttle_kbps, _pkt_app):
                        with self.config_lock:
                            self.config.packets_dropped += 1
                        continue

                if cfg.lag_on and self._direction_allowed(pkt, cfg.lag_inbound, cfg.lag_outbound):
                    delay_ms = cfg.lag_ms
                    if cfg.lag_jitter_ms > 0:
                        jitter = random.randint(-cfg.lag_jitter_ms, cfg.lag_jitter_ms)
                        delay_ms = max(0, delay_ms + jitter)
                    if cfg.fun_mode and random.randint(0, 100) < cfg.fun_intensity / 3:
                        delay_ms += random.randint(500, 3000)
                    self._enqueue_delay(pkt, delay_ms)
                    with self.config_lock:
                        self.config.packets_delayed += 1
                    continue

                try:
                    self.windivert.send(pkt)
                except Exception:
                    pass
        except Exception as e:
            if self.running:
                self.error_occurred.emit(f"Capture error: {e}")
            self.running = False

    def _track_bandwidth(self, pkt, size):
        now = time.monotonic()
        is_out = False
        try:
            is_out = bool(pkt.is_outbound)
        except Exception:
            pass
        if is_out:
            self.bw_current_out += size
        else:
            self.bw_current_in += size
        if now - self.bw_window_start >= 1.0:
            self.bw_history_in.append(self.bw_current_in)
            self.bw_history_out.append(self.bw_current_out)
            self.bw_current_in = 0
            self.bw_current_out = 0
            self.bw_window_start = now

    def _connection_for(self, pkt):
        """Return the ConnectionInfo (or None) for this packet, keyed by
        local port — the same key used by conn_map."""
        try:
            port = pkt.src_port if pkt.is_outbound else pkt.dst_port
        except Exception:
            return None
        with self.conn_lock:
            return self.connection_table.get(port)

    def _track_connection(self, pkt, size):
        """Update the ConnectionInfo for this packet — bytes, last_seen,
        and SNI hostname if this is a TLS ClientHello on port 443."""
        try:
            is_out = bool(pkt.is_outbound)
            port = pkt.src_port if is_out else pkt.dst_port
            remote_addr = pkt.dst_addr if is_out else pkt.src_addr
            remote_port = pkt.dst_port if is_out else pkt.src_port
        except Exception:
            return

        now = time.monotonic()
        with self.conn_lock:
            info = self.connection_table.get(port)
            if info is None:
                # Create a stub if we missed the FLOW event (rare, but can happen
                # for connections that pre-existed our handle opening)
                pid = self.conn_map.get(port, 0)
                if pid <= 0:
                    return
                info = ConnectionInfo(
                    pid=pid,
                    proto="TCP" if pkt.tcp else ("UDP" if pkt.udp else ""),
                    local_addr=pkt.src_addr if is_out else pkt.dst_addr,
                    local_port=port,
                    remote_addr=remote_addr,
                    remote_port=remote_port,
                    established_at=now, last_seen=now,
                )
                if remote_addr:
                    info.country = lookup_country(remote_addr)
                self.connection_table[port] = info
            info.last_seen = now
            if is_out:
                info.bytes_out += size
                info.packets_out += 1
            else:
                info.bytes_in += size
                info.packets_in += 1
            # Backfill remote info if we got it later than the FLOW event
            if not info.remote_addr and remote_addr:
                info.remote_addr = remote_addr
                info.remote_port = remote_port
                info.country = lookup_country(remote_addr)

            # SNI parsing — only on outbound TLS handshake to port 443
            if (is_out and not info.hostname and
                    remote_port == 443 and pkt.tcp):
                try:
                    payload = bytes(pkt.tcp.payload) if pkt.tcp.payload else b""
                except Exception:
                    payload = b""
                if payload and len(payload) > 5 and payload[0] == 0x16:
                    host = parse_sni(payload)
                    if host:
                        info.hostname = host

    def _trim_connection_table(self):
        """Remove connections that haven't been seen in the last 60 seconds.
        Called periodically from the conn_refresh_loop."""
        cutoff = time.monotonic() - 60.0
        with self.conn_lock:
            stale = [k for k, v in self.connection_table.items()
                     if v.last_seen < cutoff]
            for k in stale:
                self.connection_table.pop(k, None)

    def _consume_token(self, pkt, size, kbps, app=None):
        # v3.1.3.2 — per-app throttling uses an independent token bucket per app
        # so two throttled apps don't share one cap. Single-target (app is None
        # or no per-app configs) uses the original controller-level bucket,
        # byte-identical to legacy behavior.
        use_app = app is not None and bool(self.per_app_cfgs)
        with self.throttle_lock:
            now = time.monotonic()
            tokens_per_sec = kbps * 1024
            burst_max = tokens_per_sec
            try:
                if use_app:
                    st = self.throttle_state_by_app.get(app)
                    if st is None:
                        st = {"in": 0.0, "out": 0.0, "ts": now}
                        self.throttle_state_by_app[app] = st
                    elapsed = now - st["ts"]
                    st["ts"] = now
                    if pkt.is_outbound:
                        st["out"] = min(burst_max, st["out"] + tokens_per_sec * elapsed)
                        if st["out"] >= size:
                            st["out"] -= size
                            try:
                                self.windivert.send(pkt)
                            except Exception:
                                pass
                            return True
                    else:
                        st["in"] = min(burst_max, st["in"] + tokens_per_sec * elapsed)
                        if st["in"] >= size:
                            st["in"] -= size
                            try:
                                self.windivert.send(pkt)
                            except Exception:
                                pass
                            return True
                else:
                    elapsed = now - self.throttle_last_ts
                    self.throttle_last_ts = now
                    if pkt.is_outbound:
                        self.throttle_tokens_out = min(burst_max,
                                                       self.throttle_tokens_out + tokens_per_sec * elapsed)
                        if self.throttle_tokens_out >= size:
                            self.throttle_tokens_out -= size
                            try:
                                self.windivert.send(pkt)
                            except Exception:
                                pass
                            return True
                    else:
                        self.throttle_tokens_in = min(burst_max,
                                                      self.throttle_tokens_in + tokens_per_sec * elapsed)
                        if self.throttle_tokens_in >= size:
                            self.throttle_tokens_in -= size
                            try:
                                self.windivert.send(pkt)
                            except Exception:
                                pass
                            return True
            except Exception:
                pass
        return False

    def _enqueue_delay(self, pkt, delay_ms):
        deadline = time.monotonic() + (delay_ms / 1000.0)
        with self.delay_lock:
            if len(self.delay_queue) >= DELAY_QUEUE_CAP:
                _, _, oldest = heapq.heappop(self.delay_queue)
                try:
                    if self.windivert:
                        self.windivert.send(oldest)
                except Exception:
                    pass
            heapq.heappush(self.delay_queue, (deadline, self.delay_seq, pkt))
            self.delay_seq += 1

    def _delay_drain_loop(self):
        """v3.1.1 — Adaptive-sleep drain. Previous version slept a fixed
        1ms regardless of queue state, which wasted CPU when nothing was
        due and could still introduce up to 1ms of timing slop. Now we
        peek at the next packet's deadline and sleep precisely until
        that moment (with a 0.5ms safety floor since Windows can't
        reliably sleep shorter than that even with timeBeginPeriod(1)).

        Net result: packets leave the queue closer to their actual
        deadlines, and the drain thread doesn't burn CPU spinning when
        the queue is empty or far-future.

        Note: this CAN'T fix the bigger issue where Discord/games have
        jitter buffers that absorb our delays by speeding playback.
        That's a property of those apps, not us. For a consistently
        laggy feel, users should pair Lag with light Drop."""
        while self.running:
            now = time.monotonic()
            to_send = []
            next_deadline = None
            with self.delay_lock:
                # Drain up to 8 overdue packets per iteration so we
                # don't dump a huge batch in one tight burst (preserves
                # original arrival spacing within a few ms).
                count = 0
                while self.delay_queue and self.delay_queue[0][0] <= now and count < 8:
                    _, _, pkt = heapq.heappop(self.delay_queue)
                    to_send.append(pkt)
                    count += 1
                # Peek at the next pending deadline so we know how long
                # to sleep before the next iteration.
                if self.delay_queue:
                    next_deadline = self.delay_queue[0][0]
            for pkt in to_send:
                try:
                    if self.windivert:
                        self.windivert.send(pkt)
                except Exception:
                    pass

            # Compute how long to sleep:
            # - Empty queue → sleep 5ms (cheap idle, will wake on next packet check)
            # - Next packet imminent (<0.5ms) → sleep the minimum (0.5ms)
            # - Otherwise → sleep until next deadline minus a tiny safety margin
            if next_deadline is None:
                sleep_for = 0.005
            else:
                remaining = next_deadline - time.monotonic()
                if remaining <= 0.0005:
                    sleep_for = 0.0005
                else:
                    # Cap at 20ms so we don't oversleep into a long-deadline
                    # queue and miss a newly-enqueued shorter-deadline packet.
                    # (Newly-enqueued packets re-shuffle the heap but we
                    # won't notice until we wake up.)
                    sleep_for = min(remaining, 0.020)
            time.sleep(sleep_for)

    def _freeze_drain_loop(self):
        while self.running:
            with self.config_lock:
                cfg = self.config
            with self.freeze_lock:
                qlen = len(self.freeze_queue)
            if cfg.freeze_on or qlen == 0:
                time.sleep(0.02)
                continue
            replay_ms = cfg.freeze_replay_ms
            with self.freeze_lock:
                if not self.freeze_queue:
                    with self.config_lock:
                        self.config.packets_held = 0
                    continue
                pkt = self.freeze_queue.popleft()
                with self.config_lock:
                    self.config.packets_held = len(self.freeze_queue)
            try:
                if self.windivert:
                    self.windivert.send(pkt)
            except Exception:
                pass
            if replay_ms > 0:
                time.sleep(replay_ms / 1000.0)


# ============================================================
# Process discovery
# ============================================================

def get_visible_window_pids():
    """Return set of PIDs that own at least one visible top-level window with a title.

    Windows-only. Used to distinguish 'open apps' (likely user-facing) from
    'background processes' in the app picker. Returns None on non-Windows
    so callers can degrade gracefully.
    """
    if sys.platform != "win32":
        return None

    try:
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        EnumWindowsProc = ctypes.WINFUNCTYPE(
            wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
        )
        pids = set()

        def cb(hwnd, lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                # Skip windows with no title — most invisible Win32 housekeeping
                # windows fall into this bucket.
                if user32.GetWindowTextLengthW(hwnd) == 0:
                    return True
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value:
                    pids.add(pid.value)
            except Exception:
                pass
            return True

        user32.EnumWindows(EnumWindowsProc(cb), 0)
        return pids
    except Exception:
        return None


def get_process_groups():
    """Return list of {name, pids[], conns, has_window} grouped by process name."""
    groups: dict = defaultdict(lambda: {"pids": set(), "conns": 0})
    try:
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                name = proc.info['name'] or "unknown"
                groups[name]["pids"].add(proc.info['pid'])
            except Exception:
                continue
    except Exception:
        return []

    try:
        for c in psutil.net_connections(kind="inet"):
            if c.pid is None:
                continue
            try:
                p = psutil.Process(c.pid)
                name = p.name()
                if name in groups:
                    groups[name]["conns"] += 1
            except Exception:
                continue
    except Exception:
        pass

    visible_pids = get_visible_window_pids()  # None on non-Windows

    out = []
    for name, info in groups.items():
        if visible_pids is None:
            has_window = False  # unknown — caller's filter UI will reflect this
        else:
            has_window = bool(info["pids"] & visible_pids)
        out.append({
            "name": name,
            "pids": list(info["pids"]),
            "instances": len(info["pids"]),
            "conns": info["conns"],
            "has_window": has_window,
        })
    out.sort(key=lambda x: (-x["conns"], x["name"].lower()))
    return out


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def ensure_qwebchannel_js(ui_dir: Path) -> bool:
    """Extract qwebchannel.js from Qt's compiled resources to the ui/ folder.
    
    QWebChannel ships qwebchannel.js as a Qt resource at qrc:///qtwebchannel/.
    We copy it to ui/qwebchannel.js so index.html can load it via file://.
    """
    target = ui_dir / "qwebchannel.js"
    if target.exists() and target.stat().st_size > 1000:
        return True  # Already there

    # Try Qt resource path
    try:
        f = QFile(":/qtwebchannel/qwebchannel.js")
        if f.open(QIODevice.ReadOnly):
            data = bytes(f.readAll())
            f.close()
            if data and len(data) > 1000:
                target.write_bytes(data)
                return True
    except Exception:
        pass

    # Try filesystem locations as a fallback
    try:
        import PySide6
        ps_root = Path(PySide6.__file__).parent
        candidates = [
            ps_root / "Qt6" / "resources" / "qtwebchannel" / "qwebchannel.js",
            ps_root / "Qt" / "resources" / "qtwebchannel" / "qwebchannel.js",
            ps_root / "qtwebchannel" / "qwebchannel.js",
        ]
        for c in candidates:
            if c.exists() and c.stat().st_size > 1000:
                target.write_bytes(c.read_bytes())
                return True
    except Exception:
        pass

    return False


# ============================================================
# Phase 2 — Recording / Replay
# ============================================================

RECORDINGS_DIR = PROFILE_DIR / "recordings"
try:
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

PCAP_DIR = PROFILE_DIR / "pcaps"
try:
    PCAP_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass


# ============================================================
# Phase 3 — PCAP writer (libpcap format, opens in Wireshark)
# ============================================================

class PcapWriter:
    """Writes captured packets to a standard libpcap file. The file format
    is a 24-byte global header followed by a 16-byte per-packet record
    header + the raw packet bytes (IPv4 header + payload).

    Opens lazily on first write; closes cleanly via stop()."""

    # Global header: magic + version + thiszone + sigfigs + snaplen + linktype
    # linktype 101 = LINKTYPE_RAW (raw IPv4/IPv6 — no Ethernet header), which
    # matches what WinDivert hands us at the network layer.
    _GLOBAL_HEADER = bytes([
        0xD4, 0xC3, 0xB2, 0xA1,            # magic (little-endian)
        0x02, 0x00, 0x04, 0x00,            # version 2.4
        0x00, 0x00, 0x00, 0x00,            # thiszone (UTC)
        0x00, 0x00, 0x00, 0x00,            # sigfigs
        0xFF, 0xFF, 0x00, 0x00,            # snaplen 65535
        0x65, 0x00, 0x00, 0x00,            # linktype 101 = RAW
    ])

    def __init__(self):
        self.recording = False
        self.file = None
        self.path = ""
        self.lock = threading.Lock()
        self.packet_count = 0
        self.byte_count = 0

    def start(self, target_app: str = ""):
        with self.lock:
            if self.recording:
                return self.path
            try:
                ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                safe = "".join(c if c.isalnum() or c in "-_" else "_"
                               for c in (target_app or "session"))[:40]
                fname = f"{ts}-{safe}.pcap"
                self.path = str(PCAP_DIR / fname)
                self.file = open(self.path, "wb")
                self.file.write(self._GLOBAL_HEADER)
                self.file.flush()
                self.recording = True
                self.packet_count = 0
                self.byte_count = 0
                return self.path
            except Exception:
                self.recording = False
                self.file = None
                self.path = ""
                return ""

    def write_packet(self, raw_bytes):
        """Append a packet record. Called from the capture loop."""
        if not self.recording or self.file is None:
            return
        try:
            with self.lock:
                if self.file is None:
                    return
                ts = time.time()
                ts_sec = int(ts)
                ts_usec = int((ts - ts_sec) * 1_000_000)
                length = len(raw_bytes)
                # 16-byte record header
                hdr = (ts_sec.to_bytes(4, 'little') +
                       ts_usec.to_bytes(4, 'little') +
                       length.to_bytes(4, 'little') +
                       length.to_bytes(4, 'little'))
                self.file.write(hdr)
                self.file.write(raw_bytes)
                self.packet_count += 1
                self.byte_count += length
        except Exception:
            # If write fails, stop recording to avoid filling disk with garbage
            self.recording = False

    def stop(self) -> str:
        with self.lock:
            try:
                if self.file:
                    self.file.flush()
                    self.file.close()
            except Exception:
                pass
            self.file = None
            self.recording = False
            return self.path

    def list_pcaps(self) -> list:
        try:
            files = []
            for p in sorted(PCAP_DIR.glob("*.pcap"),
                            key=lambda x: x.stat().st_mtime, reverse=True):
                try:
                    files.append({
                        "name": p.stem,
                        "path": str(p),
                        "size": p.stat().st_size,
                        "mtime": p.stat().st_mtime,
                    })
                except Exception:
                    continue
            return files
        except Exception:
            return []

    def delete_pcap(self, path: str) -> bool:
        try:
            p = Path(path)
            if p.parent != PCAP_DIR:
                return False
            p.unlink()
            return True
        except Exception:
            return False


# ============================================================
# Phase 3 — Filter scripting (sandboxed expression evaluator)
# ============================================================
# Lets users write filter expressions like:
#   pkt.dst_port == 443 and pkt.size > 500
#   pkt.host endswith ".discord.gg"
#   random() < 0.3
# Evaluated using Python's ast module — only specific node types are
# allowed, no arbitrary code execution. Compile once, evaluate per-packet.

import ast as _ast

_ALLOWED_AST_NODES = {
    _ast.Expression, _ast.BoolOp, _ast.BinOp, _ast.UnaryOp, _ast.Compare,
    _ast.Call, _ast.Attribute, _ast.Name, _ast.Load, _ast.Constant,
    _ast.And, _ast.Or, _ast.Not, _ast.USub, _ast.UAdd,
    _ast.Eq, _ast.NotEq, _ast.Lt, _ast.LtE, _ast.Gt, _ast.GtE,
    _ast.In, _ast.NotIn,
    _ast.Add, _ast.Sub, _ast.Mult, _ast.Div, _ast.FloorDiv, _ast.Mod,
    _ast.IfExp,
}

# Allowed builtins/functions inside scripts
def _scr_random():
    return random.random()
def _scr_len(x):
    try: return len(x)
    except: return 0
def _scr_lower(x):
    try: return str(x).lower()
    except: return ""
def _scr_startswith(s, p):
    try: return str(s).lower().startswith(str(p).lower())
    except: return False
def _scr_endswith(s, p):
    try: return str(s).lower().endswith(str(p).lower())
    except: return False
def _scr_contains(s, p):
    try: return str(p).lower() in str(s).lower()
    except: return False

_SCR_FUNCS = {
    "random": _scr_random, "len": _scr_len, "lower": _scr_lower,
    "startswith": _scr_startswith, "endswith": _scr_endswith,
    "contains": _scr_contains, "min": min, "max": max, "abs": abs,
}


class FilterScript:
    """Wraps a user-supplied expression. Parses+validates once at compile;
    evaluating per-packet is just a tree walk on the validated AST.

    v3.0.9 — tracks live runtime counters (eval/match/error) so the UI
    can show whether the script is actually firing. Otherwise users have
    no way to know if their expression is matching nothing, matching
    everything, or just throwing exceptions silently."""

    def __init__(self, source: str):
        self.source = (source or "").strip()
        self.ast_obj = None
        self.error = ""
        self.compiled = False
        # Live runtime diagnostics — reset on every (re-)compile
        self.eval_count   = 0
        self.match_count  = 0
        self.error_count  = 0
        self.last_error   = ""
        self._compile()

    def _compile(self):
        # Reset diagnostics on each compile
        self.eval_count = 0
        self.match_count = 0
        self.error_count = 0
        self.last_error = ""
        if not self.source:
            self.compiled = False
            return
        try:
            tree = _ast.parse(self.source, mode="eval")
        except SyntaxError as e:
            self.error = f"Syntax: {e.msg}"
            return
        # Validate every node
        for node in _ast.walk(tree):
            if type(node) not in _ALLOWED_AST_NODES:
                self.error = f"Disallowed: {type(node).__name__}"
                return
            # No double-underscore attributes allowed
            if isinstance(node, _ast.Attribute) and node.attr.startswith("_"):
                self.error = "Underscore attributes not allowed"
                return
            # Restrict function calls to whitelist
            if isinstance(node, _ast.Call):
                if not isinstance(node.func, _ast.Name):
                    self.error = "Only direct function calls allowed"
                    return
                if node.func.id not in _SCR_FUNCS:
                    self.error = f"Unknown function: {node.func.id}"
                    return
        self.ast_obj = compile(tree, "<filter-script>", "eval")
        self.compiled = True
        self.error = ""

    def matches(self, pkt_view) -> bool:
        """Evaluate against a packet view object. Any error → False (fail-safe).
        Increments live counters so the UI can show runtime stats."""
        if not self.compiled or self.ast_obj is None:
            return False
        self.eval_count += 1
        try:
            env = dict(_SCR_FUNCS)
            env["pkt"] = pkt_view
            result = eval(self.ast_obj, {"__builtins__": {}}, env)
            if bool(result):
                self.match_count += 1
                return True
            return False
        except Exception as e:
            self.error_count += 1
            # Keep last_error short — could fire millions of times
            self.last_error = f"{type(e).__name__}: {str(e)[:160]}"
            return False


class _PktView:
    """Lightweight view of a packet exposed to filter scripts. Only specific
    fields are exposed — no raw access."""
    __slots__ = ('src_port', 'dst_port', 'src_addr', 'dst_addr', 'size',
                 'proto', 'is_outbound', 'host', 'country')
    def __init__(self, pkt, hostname="", country=""):
        try:
            self.src_port = int(pkt.src_port or 0)
            self.dst_port = int(pkt.dst_port or 0)
            self.src_addr = str(pkt.src_addr or "")
            self.dst_addr = str(pkt.dst_addr or "")
            self.size = len(pkt.raw)
            self.proto = "TCP" if pkt.tcp else ("UDP" if pkt.udp else "OTHER")
            self.is_outbound = bool(pkt.is_outbound)
            self.host = str(hostname or "")
            self.country = str(country or "")
        except Exception:
            self.src_port = 0; self.dst_port = 0
            self.src_addr = ""; self.dst_addr = ""
            self.size = 0; self.proto = "OTHER"
            self.is_outbound = False; self.host = ""; self.country = ""


# ============================================================
# Phase 2 — Recording / Replay
# ============================================================


class RecordingManager:
    """Captures stat snapshots + config changes during a session and
    writes them to a gzipped-JSON `.thrtlrec` file. Format:
      { "v": 1, "started": iso, "ended": iso, "target": "...",
        "frames": [ {"t": ms_since_start, "stats": {...}, "config": {...}}, ... ] }
    Frames are written every stats tick when recording is active."""

    def __init__(self):
        self.recording = False
        self.start_time = 0.0
        self.target_app = ""
        self.frames = []
        self.last_config_hash = None
        self.lock = threading.Lock()

    def start(self, target_app: str = ""):
        with self.lock:
            self.recording = True
            self.start_time = time.time()
            self.target_app = target_app or ""
            self.frames = []
            self.last_config_hash = None

    def stop(self) -> str:
        """Stop recording and write the file. Returns the saved path."""
        with self.lock:
            if not self.recording:
                return ""
            self.recording = False
            data = {
                "v": 1,
                "started": _iso(self.start_time),
                "ended": _iso(time.time()),
                "target": self.target_app,
                "frames": self.frames,
            }
            self.frames = []
        try:
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            safe = "".join(c if c.isalnum() or c in "-_" else "_"
                           for c in (data["target"] or "session"))[:40]
            fname = f"{ts}-{safe}.thrtlrec"
            path = RECORDINGS_DIR / fname
            blob = json.dumps(data, separators=(",", ":")).encode("utf-8")
            import gzip
            with gzip.open(path, "wb") as f:
                f.write(blob)
            return str(path)
        except Exception:
            return ""

    def add_frame(self, stats: dict, config_snapshot: dict):
        """Add a frame. Config is only stored when it changes vs last frame."""
        if not self.recording:
            return
        with self.lock:
            t_ms = int((time.time() - self.start_time) * 1000)
            cfg_hash = hash(json.dumps(config_snapshot, sort_keys=True))
            frame = {"t": t_ms, "stats": stats}
            if cfg_hash != self.last_config_hash:
                frame["config"] = config_snapshot
                self.last_config_hash = cfg_hash
            self.frames.append(frame)
            # Cap memory: 1 frame per 200ms = 18000/hour. Hard cap 100k.
            if len(self.frames) > 100000:
                self.frames = self.frames[-100000:]

    def list_recordings(self) -> list:
        try:
            files = []
            for p in sorted(RECORDINGS_DIR.glob("*.thrtlrec"),
                            key=lambda x: x.stat().st_mtime, reverse=True):
                try:
                    files.append({
                        "name": p.stem,
                        "path": str(p),
                        "size": p.stat().st_size,
                        "mtime": p.stat().st_mtime,
                    })
                except Exception:
                    continue
            return files
        except Exception:
            return []

    def load_recording(self, path: str) -> dict:
        try:
            import gzip
            with gzip.open(path, "rb") as f:
                blob = f.read()
            return json.loads(blob.decode("utf-8"))
        except Exception:
            return {}

    def delete_recording(self, path: str) -> bool:
        try:
            p = Path(path)
            if p.parent != RECORDINGS_DIR:
                return False               # safety: only delete inside our dir
            p.unlink()
            return True
        except Exception:
            return False

    # ============================================================
    # Phase 4 (v2.7.0) — Throttlr Studio: timeline editing
    # ============================================================
    # Each recording stores frames containing periodic stats + sparse config
    # changes. The Studio works in a different shape — discrete EVENTS (a
    # function turning on or off) — which is what the user actually edits.
    # We convert in both directions on load/save. The original frames are
    # preserved (stats + structure); only the config changes are rewritten
    # to match the edited events.

    # The 6 functions whose on/off state we track on the timeline. Block
    # colors mirror the function-panel theming. Order matters — it's the
    # vertical lane order in Studio, top to bottom.
    STUDIO_FUNCTIONS = [
        ("lag",      "Lag",      "#ffb800"),
        ("drop",     "Drop",     "#ff5b5b"),
        ("throttle", "Throttle", "#66ddff"),
        ("freeze",   "Freeze",   "#7fbfff"),
        ("block",    "Block",    "#888888"),
        ("fun",      "Fun",      "#c66bff"),
    ]

    @classmethod
    def frames_to_events(cls, frames: list) -> dict:
        """Convert frame list → editable event list.

        Returns {
          'duration_ms': int,    # length of the recording
          'events': [{
              'lane': 'lag'|'drop'|...,
              'start_ms': int,
              'end_ms': int,
              'params': {<function-specific config snapshot at start>},
          }, ...]
        }
        Walks frames looking at config-change frames; each `<func>_on` going
        false→true opens a new event, true→false closes it. An event still
        open at end-of-recording is closed at duration_ms.
        """
        if not isinstance(frames, list) or not frames:
            return {"duration_ms": 0, "events": []}

        # Track current per-function state (was_on, start_t, params)
        open_events = {}   # func_key → {'start_ms': int, 'params': dict}
        events = []
        last_t = 0
        last_known_state = {f[0]: False for f in cls.STUDIO_FUNCTIONS}

        for frame in frames:
            t = int(frame.get("t", 0))
            last_t = max(last_t, t)
            cfg = frame.get("config")
            if cfg is None:
                continue   # stats-only frame, no config change

            # Compare each function's on flag in this frame to last known state
            for func_key, _, _ in cls.STUDIO_FUNCTIONS:
                # Map function key → config field that holds its on flag
                # Special case: 'fun' lives in cfg['fun_mode'], rest are '<key>_on'
                cfg_field = "fun_mode" if func_key == "fun" else f"{func_key}_on"
                cur = bool(cfg.get(cfg_field, False))
                prev = last_known_state[func_key]
                if cur and not prev:
                    # Open new event
                    open_events[func_key] = {
                        "start_ms": t,
                        # Capture relevant params for this function from the
                        # snapshot — used to restore on save
                        "params": cls._extract_fn_params(func_key, cfg),
                    }
                elif (not cur) and prev:
                    # Close existing event
                    if func_key in open_events:
                        ev = open_events.pop(func_key)
                        events.append({
                            "lane":     func_key,
                            "start_ms": ev["start_ms"],
                            "end_ms":   t,
                            "params":   ev["params"],
                        })
                last_known_state[func_key] = cur

        # Close any still-open events at end of recording
        for func_key, ev in open_events.items():
            events.append({
                "lane":     func_key,
                "start_ms": ev["start_ms"],
                "end_ms":   last_t,
                "params":   ev["params"],
            })

        events.sort(key=lambda e: (e["start_ms"], e["lane"]))
        return {"duration_ms": last_t, "events": events}

    @staticmethod
    def _extract_fn_params(func_key: str, cfg: dict) -> dict:
        """Extract function-relevant config fields. Used so when we save
        edited events, we restore the right per-function params."""
        if func_key == "lag":
            return {
                "lag_ms":         int(cfg.get("lag_ms", 500)),
                "lag_jitter_ms":  int(cfg.get("lag_jitter_ms", 0)),
                "lag_inbound":    bool(cfg.get("lag_inbound", True)),
                "lag_outbound":   bool(cfg.get("lag_outbound", True)),
            }
        if func_key == "drop":
            return {
                "drop_chance":    int(cfg.get("drop_chance", 60)),
                "drop_dns_only":  bool(cfg.get("drop_dns_only", False)),
                "drop_inbound":   bool(cfg.get("drop_inbound", True)),
                "drop_outbound":  bool(cfg.get("drop_outbound", True)),
            }
        if func_key == "throttle":
            return {
                "throttle_kbps":     int(cfg.get("throttle_kbps", 100)),
                "throttle_inbound":  bool(cfg.get("throttle_inbound", True)),
                "throttle_outbound": bool(cfg.get("throttle_outbound", True)),
            }
        if func_key == "freeze":
            return {
                "freeze_replay_ms":  int(cfg.get("freeze_replay_ms", 0)),
                "freeze_inbound":    bool(cfg.get("freeze_inbound", True)),
                "freeze_outbound":   bool(cfg.get("freeze_outbound", True)),
            }
        if func_key == "block":
            return {
                "block_inbound":     bool(cfg.get("block_inbound", True)),
                "block_outbound":    bool(cfg.get("block_outbound", True)),
            }
        if func_key == "fun":
            return {
                "fun_intensity":     int(cfg.get("fun_intensity", 50)),
            }
        return {}

    @classmethod
    def events_to_frames(cls, events: list, duration_ms: int,
                         original_frames: list) -> list:
        """Rebuild the frames array using edited events. Preserves stats
        from the original recording (we don't try to fabricate stats for
        new event ranges — that would be lying). Each event boundary
        becomes a config-change frame inserted at that millisecond."""
        # Sort events by start time, then lane (stable)
        events = sorted(events, key=lambda e: (int(e.get("start_ms", 0)), e.get("lane", "")))

        # Build a list of "transition points" — each is (t_ms, fn, on, params)
        transitions = []
        for ev in events:
            lane = ev.get("lane", "")
            if lane not in {f[0] for f in cls.STUDIO_FUNCTIONS}:
                continue
            s = int(ev.get("start_ms", 0))
            e = int(ev.get("end_ms",   s))
            if e <= s: e = s + 1
            params = ev.get("params") or {}
            transitions.append((s, lane, True,  params))
            transitions.append((e, lane, False, params))
        transitions.sort(key=lambda x: (x[0], 0 if x[2] else 1))   # off-before-on at same ms

        # Walk transitions, building config snapshots
        cur_state = {f[0]: False for f in cls.STUDIO_FUNCTIONS}
        cur_params = {f[0]: {} for f in cls.STUDIO_FUNCTIONS}

        # Carry forward stats from the closest preceding frame so the editor
        # output still has stats history. Build a sorted list of original
        # stats-only frames for lookup.
        orig_by_t = sorted([(int(f.get("t", 0)), f) for f in (original_frames or [])],
                           key=lambda x: x[0])

        def _stats_at(t_ms: int) -> dict:
            """Latest stats from original recording at or before t_ms."""
            best = {}
            for t, f in orig_by_t:
                if t <= t_ms:
                    best = f.get("stats") or best
                else:
                    break
            return best

        def _build_config_snapshot() -> dict:
            cfg = {}
            for fk, _, _ in cls.STUDIO_FUNCTIONS:
                if fk == "fun":
                    cfg["fun_mode"] = bool(cur_state[fk])
                else:
                    cfg[f"{fk}_on"] = bool(cur_state[fk])
                cfg.update(cur_params[fk])
            return cfg

        new_frames = []
        # Initial frame at t=0 with all functions off
        new_frames.append({
            "t": 0,
            "stats": _stats_at(0),
            "config": _build_config_snapshot(),
        })

        last_t = 0
        for t, lane, on, params in transitions:
            t = max(t, 0)
            if on:
                cur_state[lane] = True
                cur_params[lane] = dict(params)
            else:
                cur_state[lane] = False
            new_frames.append({
                "t": t,
                "stats": _stats_at(t),
                "config": _build_config_snapshot(),
            })
            last_t = max(last_t, t)

        # Final frame at duration_ms preserving the last config snapshot
        if duration_ms > last_t:
            new_frames.append({
                "t": int(duration_ms),
                "stats": _stats_at(int(duration_ms)),
            })

        return new_frames

    def save_edited_recording(self, src_path: str, dest_path: str,
                              events: list, duration_ms: int) -> tuple:
        """Save edited events back to a .thrtlrec file. Returns (ok, error)."""
        try:
            data = self.load_recording(src_path)
            if not data or "frames" not in data:
                return (False, "Could not read source recording")
            new_frames = self.events_to_frames(events, duration_ms, data["frames"])
            data["frames"] = new_frames
            data["edited"] = _iso(time.time())
            blob = json.dumps(data, separators=(",", ":")).encode("utf-8")
            import gzip
            with gzip.open(dest_path, "wb") as f:
                f.write(blob)
            return (True, "")
        except Exception as e:
            return (False, f"{type(e).__name__}: {e}")


def _iso(ts: float) -> str:
    try:
        return datetime.fromtimestamp(ts).isoformat()
    except Exception:
        return ""


# ============================================================
# AutomationEngine — Phase 3 (v2.6.0)
# ============================================================
# Polls active rules every 2 seconds. Each rule has a condition (when X) and
# an action (do Y). Edge-triggered: fires once when condition transitions
# false→true, won't re-fire while the condition stays true. Resets when the
# condition goes back false.
#
# Conditions:
#   - schedule    — time-of-day window + weekday selector
#   - app_running — process name appears in current process list
#   - bandwidth   — current total bw (in+out) exceeds threshold KB/s
#   - conn_count  — number of active tracked connections exceeds N
#
# Actions:
#   - preset   — apply a saved Quick Preset by name
#   - function — toggle one of the 6 functions (lag/drop/throttle/...) on/off
#   - toast    — show a desktop toast with custom message
#   - capture  — start or stop the engine
#
# Run from Qt main thread via QTimer to ensure all bridge ops happen on the
# main thread. Cheap to run — even with 50 rules, eval takes <1 ms.

class AutomationEngine(QObject):
    """Periodic rules evaluator. Owned by the Bridge."""

    # Emitted whenever a rule fires — JS subscribes for visual confirmation
    ruleFired = Signal(str)   # JSON: {rule_id, rule_name, action_summary, ts}

    POLL_INTERVAL_MS = 2000

    def __init__(self, controller: 'NetworkController', settings: 'SettingsManager',
                 bridge: 'Bridge'):
        super().__init__()
        self.controller = controller
        self.settings   = settings
        self.bridge     = bridge

        # Per-rule state: {rule_id: {"was_active": bool, "last_fired_ts": float}}
        self._rule_state = {}

        # Process list cache (refreshed each tick — psutil is expensive)
        self._proc_cache = set()
        self._proc_cache_ts = 0.0

        self._timer = QTimer(self)
        self._timer.setInterval(self.POLL_INTERVAL_MS)
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    # ---------- Tick loop ----------

    def _tick(self):
        try:
            if not self.settings.get("automation_enabled", True):
                return
            rules = self.settings.get("automation_rules", []) or []
            if not rules:
                return
            # Refresh proc cache once per tick (used by app_running condition)
            self._proc_cache = self._snapshot_processes()
            self._proc_cache_ts = time.time()

            for rule in rules:
                if not isinstance(rule, dict) or not rule.get("enabled", True):
                    continue
                self._evaluate(rule)
        except Exception as e:
            # Never let a rule eval crash the engine
            try:
                print(f"[automation] tick error: {e}")
            except Exception:
                pass

    def _evaluate(self, rule: dict):
        rule_id = rule.get("id") or ""
        if not rule_id:
            return
        cond = rule.get("condition") or {}
        try:
            is_active = self._check_condition(cond)
        except Exception as e:
            print(f"[automation] condition error in {rule_id}: {e}")
            return

        prev = self._rule_state.get(rule_id, {})
        was_active = bool(prev.get("was_active", False))

        # Edge-triggered: only fire on false → true transition
        if is_active and not was_active:
            self._fire_action(rule)
            self._rule_state[rule_id] = {
                "was_active": True,
                "last_fired_ts": time.time(),
            }
        elif not is_active and was_active:
            self._rule_state[rule_id] = {
                "was_active": False,
                "last_fired_ts": prev.get("last_fired_ts", 0),
            }

    # ---------- Conditions ----------

    def _check_condition(self, cond: dict) -> bool:
        ctype = (cond.get("type") or "").lower()
        if ctype == "schedule":
            return self._cond_schedule(cond)
        if ctype == "app_running":
            return self._cond_app_running(cond)
        if ctype == "bandwidth":
            return self._cond_bandwidth(cond)
        if ctype == "conn_count":
            return self._cond_conn_count(cond)
        return False

    def _cond_schedule(self, cond: dict) -> bool:
        """Active when current local time is within [start, end] AND today's
        weekday is in the selected set. start/end are 'HH:MM' strings.
        weekdays is a list of ints 0–6 (Mon=0)."""
        start_s = cond.get("start", "09:00")
        end_s   = cond.get("end",   "17:00")
        weekdays = cond.get("weekdays", [0, 1, 2, 3, 4])
        try:
            now = datetime.now()
            if int(now.weekday()) not in [int(d) for d in weekdays]:
                return False
            sh, sm = [int(x) for x in start_s.split(":")[:2]]
            eh, em = [int(x) for x in end_s.split(":")[:2]]
            cur_min = now.hour * 60 + now.minute
            start_min = sh * 60 + sm
            end_min   = eh * 60 + em
            if start_min <= end_min:
                return start_min <= cur_min < end_min
            else:
                # Wraps midnight (e.g. 22:00 → 06:00)
                return cur_min >= start_min or cur_min < end_min
        except Exception:
            return False

    def _cond_app_running(self, cond: dict) -> bool:
        """Active when the named process is in the current process list."""
        name = (cond.get("process_name") or "").strip().lower()
        if not name:
            return False
        return name in self._proc_cache

    def _cond_bandwidth(self, cond: dict) -> bool:
        """Active when current bw (in+out, KB/s) exceeds threshold."""
        threshold_kbps = float(cond.get("threshold_kbps", 0) or 0)
        if threshold_kbps <= 0:
            return False
        try:
            bw_in, bw_out = self.controller.get_bandwidth_history()
            cur_in  = (bw_in[-1]  if bw_in  else 0) / 1024.0
            cur_out = (bw_out[-1] if bw_out else 0) / 1024.0
            return (cur_in + cur_out) > threshold_kbps
        except Exception:
            return False

    def _cond_conn_count(self, cond: dict) -> bool:
        """Active when number of tracked connections exceeds threshold."""
        threshold = int(cond.get("threshold", 0) or 0)
        if threshold <= 0:
            return False
        try:
            return len(self.controller.connection_table) > threshold
        except Exception:
            return False

    # ---------- Actions ----------

    def _fire_action(self, rule: dict):
        action = rule.get("action") or {}
        atype = (action.get("type") or "").lower()
        rule_name = rule.get("name") or "(unnamed)"
        summary = ""
        try:
            if atype == "preset":
                summary = self._act_preset(action)
            elif atype == "function":
                summary = self._act_function(action)
            elif atype == "toast":
                summary = self._act_toast(action, rule_name)
            elif atype == "capture":
                summary = self._act_capture(action)
            else:
                summary = f"unknown action: {atype}"
        except Exception as e:
            summary = f"error: {e}"

        try:
            self.ruleFired.emit(json.dumps({
                "rule_id": rule.get("id"),
                "rule_name": rule_name,
                "action_summary": summary,
                "ts": time.time(),
            }))
        except Exception:
            pass

    def _act_preset(self, action: dict) -> str:
        """Apply a Quick Preset by name. Looks up user_quick_presets in settings."""
        preset_name = (action.get("preset_name") or "").strip()
        if not preset_name:
            return "skipped: no preset name"
        presets = self.settings.get("user_quick_presets", []) or []
        target = None
        for p in presets:
            if isinstance(p, dict) and p.get("name") == preset_name:
                target = p
                break
        if not target:
            return f"preset '{preset_name}' not found"
        cfg = target.get("config") or {}
        try:
            self.bridge._apply_filter_config(cfg)   # private helper, see Bridge
            return f"applied preset: {preset_name}"
        except Exception as e:
            return f"failed to apply preset: {e}"

    def _act_function(self, action: dict) -> str:
        """Toggle one of the 6 functions on/off."""
        func = (action.get("function") or "").lower()
        on   = bool(action.get("on", True))
        valid = {"lag", "drop", "throttle", "freeze", "block", "fun"}
        if func not in valid:
            return f"unknown function: {func}"
        try:
            with self.controller.config_lock:
                setattr(self.controller.config, f"{func}_on", on)
            return f"{func} → {'on' if on else 'off'}"
        except Exception as e:
            return f"failed: {e}"

    def _act_toast(self, action: dict, rule_name: str) -> str:
        """Show a desktop toast notification. Emits via the bridge's errorMessage
        signal which JS already subscribes to and renders as a toast."""
        msg = action.get("message") or f"Rule '{rule_name}' fired"
        try:
            self.bridge.errorMessage.emit(json.dumps({
                "level": "info",
                "message": msg,
                "source": "automation",
            }))
            return f"toast: {msg[:60]}"
        except Exception as e:
            return f"toast failed: {e}"

    def _act_capture(self, action: dict) -> str:
        """Start or stop capture."""
        cmd = (action.get("command") or "start").lower()
        try:
            if cmd == "start":
                if not self.controller.running:
                    self.controller.start()
                    return "capture started"
                return "capture already running"
            elif cmd == "stop":
                if self.controller.running:
                    threading.Thread(target=self.controller.stop, daemon=True).start()
                    return "capture stopping"
                return "capture already stopped"
            return f"unknown capture command: {cmd}"
        except Exception as e:
            return f"capture failed: {e}"

    # ---------- Helpers ----------

    def _snapshot_processes(self) -> set:
        """Return a set of lowercase process names currently running."""
        names = set()
        try:
            for p in psutil.process_iter(['name']):
                try:
                    n = (p.info.get('name') or '').lower()
                    if n:
                        names.add(n)
                except Exception:
                    continue
        except Exception:
            pass
        return names

    def stop(self):
        """Halt the timer (called on app shutdown)."""
        try:
            self._timer.stop()
        except Exception:
            pass


# ============================================================
# LANCoordinator — Phase 5 (v3.0.0)
# ============================================================
# Lets Throttlr instances on the same LAN discover each other and (after
# pairing) send each other commands. Architecture:
#
# 1. DISCOVERY — UDP broadcast on lan_discovery_port (default 7878)
#    Each instance periodically sends an "announce" message with its
#    peer_id, name, version, status, control_port. Peers that haven't been
#    heard from in PEER_TIMEOUT_S are dropped from the seen-list.
#
# 2. PAIRING — initiated by one peer:
#    a) PC A clicks "Pair new peer", generates 6-digit code, opens itself
#       to incoming pairing requests for 60 seconds.
#    b) PC B clicks "Connect to peer", picks PC A from the discovered list,
#       enters the 6-digit code.
#    c) PC B sends pairing TCP request with the code → PC A verifies →
#       both store each other in lan_trusted_peers with a shared secret
#       (derived from the code via PBKDF2 with a per-pairing salt).
#
# 3. COMMAND — once paired, peers can send signed JSON commands over TCP:
#    {"method": "start_capture", "params": {...}, "nonce": "...", "hmac": "..."}
#    HMAC-SHA256 over (method + params + nonce + timestamp) using the
#    shared secret. Replay protection via timestamp ±30s window.
#
# Run on a daemon thread to keep the Qt main thread free. Status updates
# emitted via Qt signal (peerListChanged) which the bridge re-emits to JS.

class LANCoordinator(QObject):
    """LAN peer discovery + control."""

    PEER_TIMEOUT_S      = 30
    BROADCAST_INTERVAL_S = 5
    PAIRING_WINDOW_S    = 60
    REPLAY_WINDOW_S     = 30
    DEFAULT_DISCOVERY_PORT = 7878
    DEFAULT_CONTROL_PORT   = 7879

    # Emitted when the seen-peer list changes (discoveries, expirations,
    # pairings, status updates). JSON: {peers: [...], pending: [...]}
    peerListChanged = Signal(str)

    # Emitted when an action arrives from a paired peer and we executed it
    # JSON: {from_name, method, ok, result}
    commandReceived = Signal(str)

    def __init__(self, controller: 'NetworkController', settings: 'SettingsManager',
                 bridge: 'Bridge'):
        super().__init__()
        self.controller = controller
        self.settings = settings
        self.bridge = bridge

        self._enabled = False
        self._stop_evt = threading.Event()
        self._threads = []

        # Map peer_id → {name, ip, port, version, status, last_seen_ts, paired}
        self._seen_peers = {}
        self._lock = threading.Lock()

        # Pending OUTGOING pairing — we're waiting for a peer to accept us
        self._pairing_outgoing = None   # {target_peer_id, code, started_ts}
        # Pending INCOMING pairing requests:
        # {peer_id: {name, ip, code, expires_ts}}
        self._pairing_incoming = {}

        # Our own peer identity (stable across runs)
        self._my_id = self._get_or_create_my_id()
        self._my_name = settings.get("lan_display_name", "") or self._hostname()
        self._discovery_port = int(settings.get("lan_discovery_port") or self.DEFAULT_DISCOVERY_PORT)
        self._control_port   = int(settings.get("lan_control_port")   or self.DEFAULT_CONTROL_PORT)

    # ---------- Public API ----------

    def start(self):
        """Start discovery + listening if not already running."""
        if self._enabled:
            return
        self._enabled = True
        self._stop_evt.clear()
        # Spawn 3 threads: announce, listen-broadcast, listen-tcp
        for target in (self._announce_loop, self._discovery_listen_loop, self._control_server_loop):
            t = threading.Thread(target=target, daemon=True)
            t.start()
            self._threads.append(t)
        # Reaper for expired peers + pairings
        t_reap = threading.Thread(target=self._reaper_loop, daemon=True)
        t_reap.start()
        self._threads.append(t_reap)

    def stop(self):
        """Stop all LAN activity."""
        self._enabled = False
        self._stop_evt.set()
        with self._lock:
            self._seen_peers.clear()
            self._pairing_outgoing = None
            self._pairing_incoming.clear()
        self._threads = []
        self._emit_peer_list()

    def list_peers(self) -> list:
        """Return list of currently known peers."""
        with self._lock:
            now = time.time()
            return sorted([
                {
                    "peer_id":  pid,
                    "name":     info.get("name", ""),
                    "ip":       info.get("ip", ""),
                    "port":     info.get("port", 0),
                    "version":  info.get("version", ""),
                    "status":   info.get("status", "idle"),
                    "target":   info.get("target", ""),
                    "kbps_in":  info.get("kbps_in", 0),
                    "kbps_out": info.get("kbps_out", 0),
                    "last_seen_ago_s": int(now - info.get("last_seen_ts", now)),
                    "paired":   self._is_paired(pid),
                }
                for pid, info in self._seen_peers.items()
            ], key=lambda x: x.get("name", ""))

    def list_pending_pairings(self) -> list:
        """Return incoming pairing requests waiting for approval."""
        with self._lock:
            now = time.time()
            return [
                {**p, "remaining_s": max(0, int(p.get("expires_ts", 0) - now))}
                for p in self._pairing_incoming.values()
            ]

    def open_pairing_window(self) -> str:
        """Open a 60-second window for incoming pairing requests, return
        the 6-digit code the user should share with the other peer."""
        code = "".join(random.choice("0123456789") for _ in range(6))
        with self._lock:
            self._pairing_outgoing = {
                "code": code,
                "started_ts": time.time(),
                "incoming_window_open": True,
            }
        return code

    def close_pairing_window(self):
        with self._lock:
            self._pairing_outgoing = None

    def request_pair(self, target_peer_id: str, code: str) -> tuple:
        """Send a pairing request to a discovered peer. Returns (ok, error)."""
        if len(code) != 6 or not code.isdigit():
            return (False, "Code must be 6 digits")
        with self._lock:
            target = self._seen_peers.get(target_peer_id)
        if not target:
            return (False, "Peer not found — has it gone offline?")
        try:
            shared_secret = self._derive_secret_from_code(code, target_peer_id, self._my_id)
            payload = {
                "type": "pair_request",
                "peer_id": self._my_id,
                "name": self._my_name,
                "code_hash": hashlib.sha256(code.encode("utf-8")).hexdigest()[:16],
            }
            resp = self._send_tcp(target["ip"], target["port"], payload, timeout=5)
            if not resp or resp.get("ok") is not True:
                return (False, resp.get("error", "Peer rejected pairing") if resp else "No response")
            # Pairing accepted — save trust
            self._add_trusted_peer(target_peer_id, target.get("name", ""), target["ip"], shared_secret)
            return (True, "")
        except Exception as e:
            return (False, f"{type(e).__name__}: {e}")

    def accept_pairing(self, peer_id: str) -> bool:
        """User approves a pending incoming pairing request."""
        with self._lock:
            req = self._pairing_incoming.pop(peer_id, None)
        if not req:
            return False
        # The shared secret was already derived when the request came in;
        # store it now that the user said yes.
        self._add_trusted_peer(peer_id, req.get("name", ""), req.get("ip", ""), req.get("secret", ""))
        self._emit_peer_list()
        return True

    def reject_pairing(self, peer_id: str) -> bool:
        with self._lock:
            removed = self._pairing_incoming.pop(peer_id, None)
        if removed:
            self._emit_peer_list()
        return bool(removed)

    def unpair(self, peer_id: str) -> bool:
        peers = list(self.settings.get("lan_trusted_peers", []) or [])
        new_peers = [p for p in peers if p.get("peer_id") != peer_id]
        if len(new_peers) == len(peers):
            return False
        self.settings.set("lan_trusted_peers", new_peers)
        self.settings.save()
        self._emit_peer_list()
        return True

    def send_command(self, peer_id: str, method: str, params: dict = None) -> tuple:
        """Send a signed command to a paired peer. Returns (ok, result_dict_or_error)."""
        secret = self._get_shared_secret(peer_id)
        if not secret:
            return (False, "Peer is not paired")
        with self._lock:
            target = self._seen_peers.get(peer_id)
        if not target:
            return (False, "Peer is offline")
        nonce = uuid.uuid4().hex[:16]
        ts = int(time.time())
        body = {
            "type":   "command",
            "from":   self._my_id,
            "method": method,
            "params": params or {},
            "nonce":  nonce,
            "ts":     ts,
        }
        body["hmac"] = self._sign(body, secret)
        try:
            resp = self._send_tcp(target["ip"], target["port"], body, timeout=8)
            if not resp:
                return (False, "No response from peer")
            return (bool(resp.get("ok")), resp)
        except Exception as e:
            return (False, f"{type(e).__name__}: {e}")

    def broadcast_command(self, method: str, params: dict = None) -> dict:
        """Send command to ALL paired peers. Returns dict of peer_id → (ok, result)."""
        results = {}
        peers = self.settings.get("lan_trusted_peers", []) or []
        for p in peers:
            pid = p.get("peer_id")
            if not pid:
                continue
            results[pid] = self.send_command(pid, method, params)
        return results

    # ---------- Threads ----------

    def _announce_loop(self):
        """Periodically broadcast our presence on the LAN."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            while not self._stop_evt.is_set():
                try:
                    msg = self._build_announce()
                    data = json.dumps(msg).encode("utf-8")
                    sock.sendto(data, ("<broadcast>", self._discovery_port))
                except Exception:
                    pass
                self._stop_evt.wait(self.BROADCAST_INTERVAL_S)
        finally:
            try: sock.close()
            except Exception: pass

    def _discovery_listen_loop(self):
        """Listen for announces from other Throttlr instances."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("", self._discovery_port))
            sock.settimeout(1.0)
            while not self._stop_evt.is_set():
                try:
                    data, addr = sock.recvfrom(4096)
                except (socket.timeout, OSError):
                    continue
                try:
                    msg = json.loads(data.decode("utf-8"))
                except Exception:
                    continue
                if msg.get("type") != "announce":
                    continue
                pid = msg.get("peer_id")
                if not pid or pid == self._my_id:
                    continue   # ignore ourselves
                with self._lock:
                    self._seen_peers[pid] = {
                        "name":         msg.get("name", "?"),
                        "ip":           addr[0],
                        "port":         int(msg.get("control_port", 0)),
                        "version":      msg.get("version", ""),
                        "status":       msg.get("status", "idle"),
                        "target":       msg.get("target", ""),
                        "kbps_in":      int(msg.get("kbps_in", 0)),
                        "kbps_out":     int(msg.get("kbps_out", 0)),
                        "last_seen_ts": time.time(),
                    }
                self._emit_peer_list()
        finally:
            try: sock.close()
            except Exception: pass

    def _control_server_loop(self):
        """Accept TCP connections for pairing + commands."""
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("", self._control_port))
            srv.listen(8)
            srv.settimeout(1.0)
            while not self._stop_evt.is_set():
                try:
                    conn, addr = srv.accept()
                except (socket.timeout, OSError):
                    continue
                # Handle each connection in its own thread so a slow client
                # can't block other commands
                t = threading.Thread(
                    target=self._handle_client, args=(conn, addr), daemon=True)
                t.start()
        finally:
            try: srv.close()
            except Exception: pass

    def _handle_client(self, conn, addr):
        try:
            conn.settimeout(8.0)
            buf = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                if b"\n" in buf or len(buf) > 65536:
                    break
            try:
                msg = json.loads(buf.decode("utf-8").strip())
            except Exception:
                self._send_resp(conn, {"ok": False, "error": "bad json"})
                return
            mtype = msg.get("type")
            if mtype == "pair_request":
                self._handle_pair_request(msg, addr, conn)
            elif mtype == "command":
                self._handle_command(msg, addr, conn)
            else:
                self._send_resp(conn, {"ok": False, "error": "unknown type"})
        except Exception:
            try:
                self._send_resp(conn, {"ok": False, "error": "internal error"})
            except Exception:
                pass
        finally:
            try: conn.close()
            except Exception: pass

    def _handle_pair_request(self, msg, addr, conn):
        """Incoming pairing request from another peer. We need a window
        currently open (user pressed 'Pair new peer') AND the code-hash
        must match the code we generated."""
        with self._lock:
            window = self._pairing_outgoing
            if not window or not window.get("incoming_window_open"):
                self._send_resp(conn, {"ok": False, "error": "no pairing window open"})
                return
            our_code = window.get("code", "")
        # Verify the code-hash they sent matches our code
        expected = hashlib.sha256(our_code.encode("utf-8")).hexdigest()[:16]
        if msg.get("code_hash") != expected:
            self._send_resp(conn, {"ok": False, "error": "wrong code"})
            return
        # Code matches — derive shared secret + queue user-approval prompt
        peer_id = msg.get("peer_id", "")
        name    = msg.get("name", "?")
        secret  = self._derive_secret_from_code(our_code, self._my_id, peer_id)
        with self._lock:
            self._pairing_incoming[peer_id] = {
                "peer_id":    peer_id,
                "name":       name,
                "ip":         addr[0],
                "expires_ts": time.time() + self.PAIRING_WINDOW_S,
                "secret":     secret,
            }
        # Tell the other side we accepted (the user will approve via UI; for
        # now we acknowledge so the request was structurally valid)
        self._send_resp(conn, {"ok": True, "msg": "awaiting user approval"})
        self._emit_peer_list()

    def _handle_command(self, msg, addr, conn):
        """Incoming signed command from a paired peer."""
        from_id = msg.get("from", "")
        secret = self._get_shared_secret(from_id)
        if not secret:
            self._send_resp(conn, {"ok": False, "error": "not paired"})
            return
        # Verify HMAC
        sig = msg.pop("hmac", "")
        if not sig or not self._verify_signature(msg, sig, secret):
            self._send_resp(conn, {"ok": False, "error": "bad signature"})
            return
        # Replay-protect via timestamp window
        ts = int(msg.get("ts", 0))
        if abs(time.time() - ts) > self.REPLAY_WINDOW_S:
            self._send_resp(conn, {"ok": False, "error": "stale request"})
            return
        method = msg.get("method", "")
        params = msg.get("params", {}) or {}
        # Execute the command (schedule on Qt thread for safety)
        result = self._execute_remote_command(method, params)
        try:
            peer_name = ""
            with self._lock:
                p = self._seen_peers.get(from_id)
                if p:
                    peer_name = p.get("name", "")
            self.commandReceived.emit(json.dumps({
                "from_name": peer_name,
                "method":    method,
                "ok":        bool(result.get("ok")),
                "result":    result,
            }))
        except Exception:
            pass
        self._send_resp(conn, result)

    def _reaper_loop(self):
        """Drop peers we haven't heard from in PEER_TIMEOUT_S, expire pairings."""
        while not self._stop_evt.is_set():
            self._stop_evt.wait(2.0)
            now = time.time()
            changed = False
            with self._lock:
                for pid in list(self._seen_peers.keys()):
                    if now - self._seen_peers[pid].get("last_seen_ts", now) > self.PEER_TIMEOUT_S:
                        del self._seen_peers[pid]
                        changed = True
                for pid in list(self._pairing_incoming.keys()):
                    if self._pairing_incoming[pid].get("expires_ts", now) < now:
                        del self._pairing_incoming[pid]
                        changed = True
                if self._pairing_outgoing:
                    if (now - self._pairing_outgoing.get("started_ts", now)) > self.PAIRING_WINDOW_S:
                        self._pairing_outgoing = None
                        changed = True
            if changed:
                self._emit_peer_list()

    # ---------- Helpers ----------

    def _build_announce(self) -> dict:
        cfg = self.controller.config
        bw_in, bw_out = self.controller.get_bandwidth_history()
        kin  = (bw_in[-1]  if bw_in  else 0) // 1024
        kout = (bw_out[-1] if bw_out else 0) // 1024
        return {
            "type":         "announce",
            "peer_id":      self._my_id,
            "name":         self._my_name,
            "version":      __version__,
            "control_port": self._control_port,
            "status":       "running" if self.controller.running else "idle",
            "target":       cfg.target_name or "",
            "kbps_in":      int(kin),
            "kbps_out":     int(kout),
        }

    def _send_tcp(self, ip: str, port: int, payload: dict, timeout: float = 5) -> dict:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect((ip, port))
                data = (json.dumps(payload) + "\n").encode("utf-8")
                s.sendall(data)
                buf = b""
                while True:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                    if b"\n" in buf or len(buf) > 65536:
                        break
                if not buf:
                    return None
                return json.loads(buf.decode("utf-8").strip())
        except Exception:
            return None

    def _send_resp(self, conn, payload: dict):
        try:
            data = (json.dumps(payload) + "\n").encode("utf-8")
            conn.sendall(data)
        except Exception:
            pass

    def _sign(self, body: dict, secret: str) -> str:
        s = self._canonical(body)
        return hmac.new(secret.encode("utf-8"), s.encode("utf-8"),
                        hashlib.sha256).hexdigest()

    def _verify_signature(self, body: dict, sig: str, secret: str) -> bool:
        expected = self._sign(body, secret)
        return hmac.compare_digest(expected, sig)

    def _canonical(self, body: dict) -> str:
        # Stable JSON so signature is reproducible
        return json.dumps(body, sort_keys=True, separators=(",", ":"))

    def _derive_secret_from_code(self, code: str, side_a: str, side_b: str) -> str:
        """Derive a shared secret from the pairing code + both peer IDs.
        Both sides compute the same value (we sort the IDs)."""
        ids = sorted([side_a, side_b])
        salt = (ids[0] + "|" + ids[1]).encode("utf-8")
        return hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), salt,
                                   iterations=10000).hex()

    def _is_paired(self, peer_id: str) -> bool:
        return self._get_shared_secret(peer_id) is not None

    def _get_shared_secret(self, peer_id: str) -> str:
        peers = self.settings.get("lan_trusted_peers", []) or []
        for p in peers:
            if p.get("peer_id") == peer_id:
                return p.get("shared_secret", "") or ""
        return ""

    def _add_trusted_peer(self, peer_id: str, name: str, ip: str, secret: str):
        peers = list(self.settings.get("lan_trusted_peers", []) or [])
        peers = [p for p in peers if p.get("peer_id") != peer_id]
        peers.append({
            "peer_id":       peer_id,
            "name":          name,
            "last_ip":       ip,
            "shared_secret": secret,
            "paired_ts":     time.time(),
        })
        self.settings.set("lan_trusted_peers", peers)
        self.settings.save()

    def _execute_remote_command(self, method: str, params: dict) -> dict:
        """Execute a command requested by a paired peer. Whitelist methods —
        we don't want to expose the entire bridge to LAN peers."""
        try:
            if method == "ping":
                return {"ok": True, "version": __version__}
            if method == "start_capture":
                self.bridge.startCapture()
                return {"ok": True}
            if method == "stop_capture":
                self.bridge.stopCapture()
                return {"ok": True}
            if method == "apply_preset":
                # params: {preset_name}
                preset_name = (params.get("preset_name") or "").strip()
                if not preset_name:
                    return {"ok": False, "error": "no preset_name"}
                presets = self.settings.get("user_quick_presets", []) or []
                target = next((p for p in presets if p.get("name") == preset_name), None)
                if not target:
                    return {"ok": False, "error": f"preset '{preset_name}' not found"}
                self.bridge._apply_filter_config(target.get("config") or {})
                return {"ok": True}
            if method == "toggle_function":
                func = (params.get("function") or "").lower()
                on   = bool(params.get("on", True))
                valid = {"lag", "drop", "throttle", "freeze", "block", "fun"}
                if func not in valid:
                    return {"ok": False, "error": f"invalid function: {func}"}
                with self.controller.config_lock:
                    setattr(self.controller.config, f"{func}_on", on)
                return {"ok": True}
            if method == "get_status":
                cfg = self.controller.config
                return {
                    "ok":      True,
                    "running": bool(self.controller.running),
                    "target":  cfg.target_name or "",
                }
            return {"ok": False, "error": f"unknown method: {method}"}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def _emit_peer_list(self):
        try:
            payload = json.dumps({
                "peers":   self.list_peers(),
                "pending": self.list_pending_pairings(),
                "pairing_window_open": self._pairing_outgoing is not None,
            })
            self.peerListChanged.emit(payload)
        except Exception:
            pass

    def _hostname(self) -> str:
        try:
            return socket.gethostname()
        except Exception:
            return "Throttlr"

    def _get_or_create_my_id(self) -> str:
        pid = self.settings.get("lan_my_peer_id", "") or ""
        if not pid:
            pid = uuid.uuid4().hex[:12]
            self.settings.set("lan_my_peer_id", pid)
            self.settings.save()
        return pid


# ============================================================
# Plugin system — REMOVED in v3.0.7
# ============================================================
# The plugin feature (PluginAPI + PluginManager classes, .py discovery,
# enable/disable, lifecycle hooks) was removed at user request. Kept
# the `plugins_enabled` settings default as a harmless no-op so old
# settings files still load cleanly. The Bridge methods that exposed
# plugin operations to the UI are also stripped.




# ============================================================
# Bridge: Python <-> JavaScript
# ============================================================

class Bridge(QObject):
    """JS-callable interface. Methods are slots; signals push events to JS."""

    statsChanged = Signal(str)
    statusChanged = Signal(str)
    hotkeyFired = Signal(str)
    # v3.1.1 — Fired when one or more hotkeys couldn't be globally
    # registered (another app claimed the key first). Frontend shows
    # a one-time toast/popup explaining the conflict.
    hotkeyConflict = Signal(str)
    errorMessage = Signal(str)
    appsRefreshed = Signal(str)
    updateStatus = Signal(str)        # auto-update progress + completion
    automationRuleFired = Signal(str) # Phase 3 — emits when an automation rule fires
    lanPeerListChanged  = Signal(str) # Phase 5 — emits when peer list updates
    lanCommandReceived  = Signal(str) # Phase 5 — emits when a remote peer sent us a command

    def __init__(self, controller: NetworkController, settings: SettingsManager,
                 on_hotkey_rebind=None):
        super().__init__()
        self.controller = controller
        self.settings = settings
        self._on_hotkey_rebind = on_hotkey_rebind

        # v3.0.7 — restore the Connected Processes feature toggle from
        # settings so it survives across launches.
        try:
            with self.controller.config_lock:
                self.controller.config.connected_procs_enabled = bool(
                    self.settings.get('connected_procs_enabled') or False)
        except Exception:
            pass

        # Phase 2 — recording manager
        self.recorder = RecordingManager()

        self._stats_timer = QTimer(self)
        self._stats_timer.setInterval(int(settings.get('stats_interval_ms') or 200))
        self._stats_timer.timeout.connect(self._emit_stats)
        self._stats_timer.start()

        self._apps_timer = QTimer(self)
        self._apps_timer.setInterval(int(settings.get('apps_refresh_ms') or 2000))
        self._apps_timer.timeout.connect(self._emit_apps)
        self._apps_timer.start()

        self.controller.status_changed.connect(self.statusChanged)
        self.controller.error_occurred.connect(self.errorMessage)

        # Phase 3 (v2.6.0) — Automation rules engine. Created here so it has
        # the same lifetime as Bridge. Forwards its ruleFired signal out to JS.
        self._automation = AutomationEngine(controller, settings, self)
        self._automation.ruleFired.connect(self.automationRuleFired)

        # Phase 5 (v3.0.0) — LAN coordinator. Plugin manager was removed
        # in v3.0.7, leaving just LAN here.
        self._lan = LANCoordinator(controller, settings, self)
        self._lan.peerListChanged.connect(self.lanPeerListChanged)
        self._lan.commandReceived.connect(self.lanCommandReceived)
        if bool(settings.get("lan_sync_enabled", False)):
            self._lan.start()

    def _emit_stats(self):
        result = self.controller.get_stats()
        # v3.0.7 — get_stats now returns 9 values; unpack with safety in
        # case anyone shimmed it differently.
        if len(result) >= 9:
            seen, dropped, delayed, held, sb, freeze_on, dur, sent, received = result[:9]
        else:
            seen, dropped, delayed, held, sb, freeze_on, dur = result[:7]
            sent = 0
            received = 0
        bw_in, bw_out = self.controller.get_bandwidth_history()
        # Live queue size — what's currently held. This is what the user
        # actually wants to see going down during a replay.
        with self.controller.freeze_lock:
            held_live = len(self.controller.freeze_queue)
        # "Replaying" = freeze is OFF but the queue still has packets being
        # drained out via the freeze drain loop. This is the visible state
        # the user wants — released packets streaming back to the network
        # at the configured speed. Also fires during the post-stop drain
        # phase (running flips off only when queue is empty).
        replaying = bool(
            (not freeze_on) and held_live > 0
            and (self.controller.running or self.controller._pass_through)
        )
        payload = {
            "seen": seen, "dropped": dropped, "delayed": delayed,
            "held": held_live, "bytes": sb,
            "sent": sent, "received": received,   # v3.0.7
            "freeze_on": freeze_on, "replaying": replaying,
            "freeze_duration": dur, "running": self.controller.running,
            "bw_in": bw_in, "bw_out": bw_out,
        }
        self.statsChanged.emit(json.dumps(payload))
        # Phase 2: feed the recorder when active
        try:
            if self.recorder.recording:
                with self.controller.config_lock:
                    cfg = self.controller.config
                    cfg_snap = {
                        "lag_on": cfg.lag_on, "lag_ms": cfg.lag_ms,
                        "drop_on": cfg.drop_on, "drop_chance": cfg.drop_chance,
                        "drop_dns_only": cfg.drop_dns_only,
                        "throttle_on": cfg.throttle_on, "throttle_kbps": cfg.throttle_kbps,
                        "freeze_on": cfg.freeze_on,
                        "block_on": cfg.block_on, "fun_on": cfg.fun_mode,
                        "domain_block_on": cfg.domain_block_on,
                        "geo_block_on": cfg.geo_block_on,
                    }
                self.recorder.add_frame(payload, cfg_snap)
        except Exception:
            pass
        # Also push to the overlay if attached. Wrapped in try/except so any
        # error here can never prevent statsChanged from emitting on the
        # next tick.
        try:
            if hasattr(self, "_overlay") and self._overlay is not None:
                cfg = self.controller.config
                last_in = bw_in[-1] if bw_in else 0
                last_out = bw_out[-1] if bw_out else 0
                kbps = (last_in + last_out) / 1024.0
                funcs = {
                    'lag':      bool(cfg.lag_on),
                    'drop':     bool(cfg.drop_on),
                    'throttle': bool(cfg.throttle_on),
                    'freeze':   bool(cfg.freeze_on),
                    'block':    bool(cfg.block_on),
                    'fun':      bool(cfg.fun_mode),
                }
                self._overlay.set_state(
                    running=self.controller.running,
                    app_name=self.controller.config.target_name,
                    sent=seen, dropped=dropped, delayed=delayed, held=held_live,
                    bytes_total=sb, kbps=kbps, funcs=funcs,
                    replaying=replaying,
                )
        except Exception as e:
            # Don't surface to the user — overlay update failures shouldn't
            # spam toasts. Log to stderr only.
            import sys
            print(f"[overlay update] {e}", file=sys.stderr)

    def _emit_apps(self):
        self.appsRefreshed.emit(json.dumps(get_process_groups()))

    @Slot(result=str)
    def getApps(self):
        return json.dumps(get_process_groups())

    # ====== v3.0.5 — Custom themes ======

    @Slot(result=str)
    def listInstalledThemes(self):
        """Scan the user's themes folder for .json manifests with paired .css
        files and return them as a JSON array. Frontend renders these as
        tiles next to the built-in designs."""
        out = []
        try:
            for jf in sorted(THEMES_DIR.glob("*.json")):
                try:
                    raw = jf.read_text(encoding="utf-8")
                    manifest = json.loads(raw)
                    if not isinstance(manifest, dict):
                        continue
                    # Validate required fields — silently skip broken manifests
                    if not manifest.get("id") or not manifest.get("name"):
                        continue
                    css_filename = manifest.get("css_file") or f"{manifest['id']}.css"
                    css_path = THEMES_DIR / css_filename
                    manifest["_filename"] = jf.name
                    manifest["_css_filename"] = css_filename
                    manifest["_css_exists"] = css_path.exists()
                    out.append(manifest)
                except Exception:
                    # Malformed JSON — skip it but keep loading the rest
                    continue
        except Exception:
            pass
        return json.dumps(out)

    @Slot(str, result=str)
    def loadThemeCss(self, css_filename):
        """Read a CSS file from the themes folder and return its contents.
        Frontend injects this into a <style> tag when the user activates
        a custom theme."""
        try:
            # Sanitize — only allow plain filenames, no path traversal
            name = Path(css_filename).name
            if not name.endswith(".css"):
                return ""
            p = THEMES_DIR / name
            if not p.exists():
                return ""
            # Resolve and confirm the file is actually inside THEMES_DIR
            # (paranoia — Path(name).name should already prevent traversal)
            if THEMES_DIR.resolve() not in p.resolve().parents:
                return ""
            return p.read_text(encoding="utf-8")
        except Exception:
            return ""

    @Slot()
    def openThemesFolder(self):
        """Open the user's themes folder in File Explorer (or platform
        equivalent). Called by the 'Open themes folder' button in
        Settings → Appearance."""
        try:
            import os, sys, subprocess
            path = str(THEMES_DIR.resolve())
            if sys.platform == "win32":
                # os.startfile is the standard way on Windows
                os.startfile(path)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
        except Exception:
            pass

    # v3.1.1 — Allowlist of external URLs the frontend is permitted to
    # open via openExternalUrl(). Keeping this strict prevents any
    # injected/compromised JS from being able to make the user's browser
    # navigate to an arbitrary URL (e.g. phishing pages). Each entry is
    # matched as an exact-prefix on the URL string.
    _EXTERNAL_URL_ALLOWLIST = (
        "https://ko-fi.com/billysmatrix",
        "https://github.com/BillysMatrix18/throttlr-releases",
        "https://github.com/BillysMatrix18/throttlr-releases/issues",
        # v3.1.3 — Feedback form on the public website. The form posts to a
        # private Google Sheet I control; only the page URL is opened.
        "https://throttlr.netlify.app/feedback.html",
    )

    @Slot(str, result=bool)
    def openExternalUrl(self, url):
        """Open a URL in the user's default browser. URLs are checked
        against a strict allowlist so the frontend can't open arbitrary
        destinations — this prevents a hypothetical script-injection
        from navigating the user to a malicious site.

        Returns True on success, False if the URL was rejected or the
        platform launcher failed."""
        try:
            url = str(url or "").strip()
            if not url:
                return False
            # Allowlist check — only opens known-safe destinations
            allowed = any(url.startswith(prefix)
                          for prefix in self._EXTERNAL_URL_ALLOWLIST)
            if not allowed:
                print(f"[openExternalUrl] REJECTED non-allowlisted URL: {url}",
                      file=sys.stderr)
                return False
            # Cross-platform launcher. QDesktopServices would also work
            # but adds a Qt dependency for what's a 3-line stdlib call.
            import subprocess
            if sys.platform == "win32":
                # Using os.startfile with a URL opens the default browser
                os.startfile(url)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", url])
            else:
                subprocess.Popen(["xdg-open", url])
            return True
        except Exception as e:
            print(f"[openExternalUrl] failed: {e}", file=sys.stderr)
            return False

    @Slot()
    def openThemesGallery(self):
        """Open the public themes gallery in the user's default browser.
        Called by the 'More themes' button in Settings → Appearance."""
        try:
            import webbrowser
            webbrowser.open(THEMES_GALLERY_URL)
        except Exception:
            pass

    @Slot(result=str)
    def getThemesGalleryUrl(self):
        return THEMES_GALLERY_URL

    @Slot(str, str)
    def previewOverlayTheme(self, theme_id, customizations_json):
        """Apply a temporary theme to the floating overlay WITHOUT saving
        settings — used by the in-app theme picker so the overlay updates
        live as the user clicks through theme tiles, before they hit Save.

        Called from JS:
          bridge.previewOverlayTheme('retro', JSON.stringify(customs))

        Pass an empty/unknown theme_id to revert the overlay to its
        settings-based palette (e.g. when user clicks Cancel)."""
        try:
            if not (hasattr(self, "_overlay") and self._overlay is not None):
                return
            customs = None
            if customizations_json:
                try:
                    customs = json.loads(customizations_json)
                except Exception:
                    customs = None
            self._overlay.preview_theme(theme_id or "", customs)
        except Exception:
            pass

    @Slot(result=str)
    def getSettings(self):
        return json.dumps(self.settings.data)

    @Slot(str, result=bool)
    def saveSettings(self, json_str):
        try:
            new_data = json.loads(json_str)
            for k, v in new_data.items():
                if k in DEFAULT_SETTINGS:
                    self.settings.set(k, v)
            set_sound_enabled(self.settings.get("sound_enabled"))
            if self._on_hotkey_rebind:
                self._on_hotkey_rebind()
            # Apply runtime-affecting settings live
            try:
                self._stats_timer.setInterval(int(self.settings.get('stats_interval_ms')))
                self._apps_timer.setInterval(int(self.settings.get('apps_refresh_ms')))
            except Exception:
                pass
            try:
                if hasattr(self, "_screen_border") and self._screen_border:
                    self._screen_border.set_show_duration_ms(int(self.settings.get('screen_border_duration_ms')))
                    self._screen_border.set_feather(int(self.settings.get('screen_border_feather')))
            except Exception:
                pass
            # v3.0.2 — refresh overlay's palette so theme changes take effect
            # without restarting the app.
            try:
                if hasattr(self, "_overlay") and self._overlay is not None:
                    self._overlay.refresh_theme()
            except Exception:
                pass
            return True
        except Exception:
            return False

    @Slot(str, result=bool)
    def setTargetApp(self, app_name):
        try:
            with self.controller.config_lock:
                self.controller.config.target_name = app_name
                # Single-target sets target_names to just this one for consistency
                self.controller.config.target_names = [app_name] if app_name else []
                # v3.0.7 — restore the user's per-app exclude list (if any).
                # Stored under the sorted+joined name key.
                try:
                    key = app_name or ""
                    stash = dict(self.settings.get('target_pid_excludes_by_app') or {})
                    saved = stash.get(key) or []
                    self.controller.config.target_pid_excludes = set(int(x) for x in saved)
                except Exception:
                    self.controller.config.target_pid_excludes = set()
            # Use the controller's helper which walks child processes too.
            # This ensures Discord helpers, Chrome renderers, etc. are
            # caught from the moment the user picks the app.
            self.controller._refresh_target_pids()
            with self.controller.config_lock:
                ok = bool(self.controller.config.target_pids)
            if not ok:
                with self.controller.config_lock:
                    self.controller.config.target_name = ""
                    self.controller.config.target_names = []
            return ok
        except Exception:
            return False

    # ============================================================
    # Phase 1 bridge slots
    # ============================================================

    @Slot(str, result=bool)
    def setTargetApps(self, json_names):
        """Multi-target: accept a JSON array of app names. The union of all
        their PIDs (plus child processes) becomes the target_pids set."""
        try:
            names = json.loads(json_names) if json_names else []
            if not isinstance(names, list):
                return False
            names = [str(n) for n in names if n]
            with self.controller.config_lock:
                self.controller.config.target_names = names
                # Display name: comma-joined for the title bar / overlay
                if len(names) == 0:
                    self.controller.config.target_name = ""
                elif len(names) == 1:
                    self.controller.config.target_name = names[0]
                else:
                    self.controller.config.target_name = " + ".join(names)
            self.controller._refresh_target_pids()
            with self.controller.config_lock:
                return bool(self.controller.config.target_pids)
        except Exception:
            return False

    @Slot(str)
    def addRecentApp(self, app_name):
        """Push an app to the front of the recent_apps list, dedupe, cap at 8."""
        try:
            if not app_name:
                return
            recent = list(self.settings.get('recent_apps') or [])
            recent = [a for a in recent if a != app_name]
            recent.insert(0, app_name)
            recent = recent[:8]
            self.settings.set('recent_apps', recent)
            self.settings.save()
        except Exception:
            pass

    # ============================================================
    # v3.0.7 — Process Tree picker
    # ============================================================
    # User-facing way to see + control exactly which PIDs Throttlr is
    # filtering. For Chrome that's a lifesaver — chrome.exe runs as ~10
    # processes (main browser, network service, GPU, audio, renderers...)
    # and the actual network IO happens in the "network" service process,
    # not the main browser. When filtering looks weak, users open this
    # to confirm Throttlr sees the right PIDs and to untick noisy ones.

    @Slot(result=str)
    def getProcessTree(self):
        """Returns the live process tree for the currently selected app(s).
        Each entry: pid, name, cmdline_preview, exe_path, parent_pid,
        is_main (true for root matches, false for descendants), excluded
        (true if user has unticked it). Sorted with main processes first."""
        try:
            with self.controller.config_lock:
                names = list(self.controller.config.target_names)
                if not names and self.controller.config.target_name:
                    names = [self.controller.config.target_name]
                excludes_set = set(int(x) for x in (self.controller.config.target_pid_excludes or set()))

            if not names:
                return json.dumps({"targets": [], "processes": []})

            name_set = set(names)
            results = []
            seen_pids = set()

            # Pass 1 — main processes whose name matches
            root_pids = []
            try:
                for proc in psutil.process_iter(['pid', 'name']):
                    try:
                        if proc.info['name'] in name_set:
                            root_pids.append(proc.info['pid'])
                    except Exception:
                        continue
            except Exception:
                pass

            def _row_for(p_obj, is_main, parent_pid):
                """Build a JSON-safe row from a psutil.Process."""
                try:
                    pid = p_obj.pid
                except Exception:
                    return None
                if pid in seen_pids:
                    return None
                seen_pids.add(pid)
                name, exe, cmdline = "", "", ""
                try:    name = p_obj.name()
                except Exception: pass
                try:    exe = p_obj.exe() or ""
                except Exception: pass
                try:
                    cl = p_obj.cmdline() or []
                    # Trim to the args portion — chop the exe path so the
                    # interesting part (--type=renderer etc.) is visible
                    if cl:
                        args = cl[1:] if len(cl) > 1 else []
                        cmdline = " ".join(args)[:200]
                except Exception: pass
                return {
                    "pid":      int(pid),
                    "name":     str(name),
                    "exe":      str(exe),
                    "cmdline":  str(cmdline),
                    "parent_pid": int(parent_pid) if parent_pid else 0,
                    "is_main":  bool(is_main),
                    "excluded": bool(pid in excludes_set),
                }

            # Add main + descendants
            for root_pid in root_pids:
                try:
                    root = psutil.Process(root_pid)
                except Exception:
                    continue
                row = _row_for(root, True, 0)
                if row:
                    results.append(row)
                try:
                    for child in root.children(recursive=True):
                        try:
                            child_parent = 0
                            try: child_parent = child.ppid()
                            except Exception: pass
                            crow = _row_for(child, False, child_parent)
                            if crow:
                                results.append(crow)
                        except Exception:
                            continue
                except Exception:
                    continue

            # Sort: main processes first, then by PID for stability
            results.sort(key=lambda r: (not r["is_main"], r["pid"]))

            return json.dumps({"targets": list(names), "processes": results})
        except Exception as e:
            return json.dumps({"targets": [], "processes": [], "error": str(e)})

    @Slot(str, result=bool)
    def setProcessTreeExcludes(self, json_pids):
        """Persist the list of PIDs the user has unticked in the picker.
        These PIDs are removed from the resolved target set on every
        _refresh_target_pids() call, so they're ignored by the capture."""
        try:
            pids = json.loads(json_pids) if json_pids else []
            if not isinstance(pids, list):
                return False
            int_pids = set()
            for p in pids:
                try: int_pids.add(int(p))
                except Exception: continue
            with self.controller.config_lock:
                self.controller.config.target_pid_excludes = int_pids
            # Persist to settings so it survives across sessions for the same
            # targeted app. Use the joined target name as the dictionary key
            # so different apps can have different exclude sets.
            try:
                key = "|".join(sorted(self.controller.config.target_names or []))
                stash = dict(self.settings.get('target_pid_excludes_by_app') or {})
                stash[key] = list(int_pids)
                # Cap the stash to ~16 apps so it doesn't grow forever
                if len(stash) > 16:
                    # Drop oldest insertion-order keys (dict preserves order)
                    for k in list(stash.keys())[:-16]:
                        stash.pop(k, None)
                self.settings.set('target_pid_excludes_by_app', stash)
                self.settings.save()
            except Exception:
                pass
            # Re-resolve target_pids immediately so the change takes effect
            self.controller._refresh_target_pids()
            return True
        except Exception:
            return False

    @Slot(result=bool)
    def getConnectedProcsEnabled(self):
        """v3.0.7 — returns whether the Connected Processes feature is on.
        When True, the per-PID exclude list is honored. When False,
        Throttlr targets every related PID (legacy behavior)."""
        try:
            return bool(self.controller.config.connected_procs_enabled)
        except Exception:
            return False

    @Slot(bool, result=bool)
    def setConnectedProcsEnabled(self, enabled):
        """v3.0.7 — toggle the Connected Processes feature. Persists across
        sessions via the settings file. Calls _refresh_target_pids() so the
        target set updates immediately when the toggle flips."""
        try:
            with self.controller.config_lock:
                self.controller.config.connected_procs_enabled = bool(enabled)
            try:
                self.settings.set('connected_procs_enabled', bool(enabled))
                self.settings.save()
            except Exception:
                pass
            # Re-resolve so flipping the toggle takes immediate effect
            self.controller._refresh_target_pids()
            return True
        except Exception:
            return False

    @Slot(result=str)
    def getRecentApps(self):
        try:
            return json.dumps(list(self.settings.get('recent_apps') or []))
        except Exception:
            return "[]"

    @Slot(str, result=str)
    def getPerAppPreset(self, app_name):
        """Return saved per-app config as a JSON string, or "" if none."""
        try:
            presets = self.settings.get('per_app_presets') or {}
            cfg = presets.get(app_name)
            return json.dumps(cfg) if cfg else ""
        except Exception:
            return ""

    @Slot(str, str, result=bool)
    def setPerAppPreset(self, app_name, json_cfg):
        """Save the supplied config as the per-app preset for app_name."""
        try:
            if not app_name:
                return False
            cfg = json.loads(json_cfg) if json_cfg else {}
            presets = dict(self.settings.get('per_app_presets') or {})
            presets[app_name] = cfg
            self.settings.set('per_app_presets', presets)
            self.settings.save()
            return True
        except Exception:
            return False

    @Slot(str, result=bool)
    def deletePerAppPreset(self, app_name):
        try:
            presets = dict(self.settings.get('per_app_presets') or {})
            if app_name in presets:
                del presets[app_name]
                self.settings.set('per_app_presets', presets)
                self.settings.save()
            return True
        except Exception:
            return False

    @Slot(bool)
    def setOverlayGhostMode(self, on):
        """Apply / remove the WDA_EXCLUDEFROMCAPTURE flag on the overlay
        window so it disappears from screen-recording tools."""
        try:
            self.settings.set('overlay_ghost_mode', bool(on))
            self.settings.save()
            ov = getattr(self, '_overlay', None)
            if ov is not None:
                _apply_ghost_mode(ov, bool(on))
        except Exception:
            pass

    @Slot(bool)
    def setOverlayStreamSafe(self, on):
        """Toggle stream-safe overlay rendering (chunky fonts + opaque bg)."""
        try:
            self.settings.set('overlay_stream_safe', bool(on))
            self.settings.save()
            ov = getattr(self, '_overlay', None)
            if ov is not None and hasattr(ov, 'set_stream_safe'):
                ov.set_stream_safe(bool(on))
        except Exception:
            pass

    @Slot(str)
    def applyMidnightCustomColor(self, hex_color):
        """Persist the user's custom Midnight accent color."""
        try:
            self.settings.set('midnight_custom_color', hex_color or "")
            self.settings.save()
        except Exception:
            pass

    @Slot(str)
    def unlockAchievement(self, name):
        """Record an achievement unlock with timestamp. No-op if already
        unlocked. Plays a unique tone."""
        try:
            unlocked = dict(self.settings.get('achievements_unlocked') or {})
            if name in unlocked:
                return
            from datetime import datetime
            unlocked[name] = datetime.now().isoformat()
            self.settings.set('achievements_unlocked', unlocked)
            self.settings.save()
            # Distinctive 4-note arpeggio for an achievement
            play_tones((523, 70), (659, 70), (784, 70), (1047, 130))
        except Exception:
            pass

    @Slot(str)
    def playSoundEffect(self, kind):
        """Play one of the per-function sound effects. Honors the
        sound_effects_enabled and sound_effects_volume settings."""
        try:
            if not self.settings.get('sound_effects_enabled'):
                return
            kind = (kind or "").lower()
            sequences = {
                'lag':      [(660, 80), (440, 120)],                  # downward warble
                'drop':     [(1500, 30), (700, 30), (300, 80)],       # laser zap
                'throttle': [(880, 80), (660, 80), (440, 80)],        # squeezed-down
                'freeze':   [(1200, 40), (1000, 40), (800, 40), (600, 80)],  # crystallize
                'block':    [(220, 200)],                             # heavy thump
                'fun':      [(440, 30), (880, 30), (220, 30), (1100, 30), (550, 60)],  # glitch chaos
                'preset':   [(523, 50), (784, 80)],                   # quick chime
                'achievement': [(523, 70), (659, 70), (784, 70), (1047, 130)],
            }
            seq = sequences.get(kind)
            if seq:
                play_tones(*seq)
        except Exception:
            pass

    @Slot(result=str)
    def getAchievements(self):
        try:
            return json.dumps(self.settings.get('achievements_unlocked') or {})
        except Exception:
            return "{}"

    @Slot(str, result=bool)
    def addUserPreset(self, json_preset):
        """Save a user-defined quick preset."""
        try:
            preset = json.loads(json_preset) if json_preset else None
            if not isinstance(preset, dict) or 'name' not in preset:
                return False
            existing = list(self.settings.get('user_quick_presets') or [])
            existing = [p for p in existing if p.get('name') != preset['name']]
            existing.insert(0, preset)
            existing = existing[:24]
            self.settings.set('user_quick_presets', existing)
            self.settings.save()
            return True
        except Exception:
            return False

    @Slot(str, result=bool)
    def deleteUserPreset(self, name):
        try:
            existing = list(self.settings.get('user_quick_presets') or [])
            existing = [p for p in existing if p.get('name') != name]
            self.settings.set('user_quick_presets', existing)
            self.settings.save()
            return True
        except Exception:
            return False

    @Slot(result=str)
    def getUserPresets(self):
        try:
            return json.dumps(list(self.settings.get('user_quick_presets') or []))
        except Exception:
            return "[]"

    @Slot(result=str)
    def exportPresetsToFile(self):
        """v3.1.4 — export the user's saved quick presets to a .throttlr-presets
        JSON file via a native Save dialog. Returns JSON {ok, path, count, error}."""
        try:
            from PySide6.QtWidgets import QFileDialog
            presets = list(self.settings.get('user_quick_presets') or [])
            default_name = f"throttlr-presets-{datetime.now().strftime('%Y-%m-%d')}.json"
            path, _ = QFileDialog.getSaveFileName(
                None,
                "Export Throttlr Presets",
                default_name,
                "Throttlr Presets (*.json);;All Files (*)"
            )
            if not path:
                return json.dumps({"ok": False, "cancelled": True, "error": ""})
            payload = {"type": "throttlr-presets", "version": 1, "presets": presets}
            with open(path, "w", encoding="utf-8") as f:
                f.write(json.dumps(payload, indent=2))
            return json.dumps({"ok": True, "path": path, "count": len(presets), "error": ""})
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(result=str)
    def importPresetsFromFile(self):
        """v3.1.4 — import quick presets from a JSON file via a native Open
        dialog. Accepts either our wrapped format ({presets:[...]}) or a raw
        array of preset objects. Merges into the user's presets (dedup by name).
        Returns JSON {ok, count, error}."""
        try:
            from PySide6.QtWidgets import QFileDialog
            path, _ = QFileDialog.getOpenFileName(
                None,
                "Import Throttlr Presets",
                "",
                "Throttlr Presets (*.json);;All Files (*)"
            )
            if not path:
                return json.dumps({"ok": False, "cancelled": True, "error": ""})
            with open(path, "r", encoding="utf-8") as f:
                data = json.loads(f.read())
            if isinstance(data, dict):
                incoming = data.get("presets", [])
            elif isinstance(data, list):
                incoming = data
            else:
                incoming = []
            if not isinstance(incoming, list):
                incoming = []
            existing = list(self.settings.get('user_quick_presets') or [])
            added = 0
            for preset in incoming:
                if not isinstance(preset, dict) or 'name' not in preset or 'cfg' not in preset:
                    continue
                existing = [p for p in existing if p.get('name') != preset['name']]
                existing.insert(0, preset)
                added += 1
            existing = existing[:48]
            self.settings.set('user_quick_presets', existing)
            self.settings.save()
            return json.dumps({"ok": True, "count": added, "error": ""})
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    # ============================================================
    # Phase 2 bridge slots — Connection Inspector, Recording,
    # Domain blocklist, Geo blocking, Practice ping
    # ============================================================

    @Slot(result=str)
    def getConnections(self):
        """Snapshot of the rich per-connection table for the Inspector."""
        try:
            with self.controller.conn_lock:
                items = list(self.controller.connection_table.values())
            now = time.monotonic()
            with self.controller.config_lock:
                target_pids = set(self.controller.config.target_pids)
            out = []
            for info in items:
                # Only show our targeted app's connections — Inspector is
                # specifically about understanding the targeted app
                if target_pids and info.pid not in target_pids:
                    continue
                age = max(0, now - info.established_at)
                idle = max(0, now - info.last_seen)
                out.append({
                    "pid": info.pid,
                    "proto": info.proto,
                    "local": f"{info.local_addr}:{info.local_port}" if info.local_addr else f":{info.local_port}",
                    "remote": f"{info.remote_addr}:{info.remote_port}" if info.remote_addr else "",
                    "remote_addr": info.remote_addr,
                    "remote_port": info.remote_port,
                    "bytes_in": info.bytes_in,
                    "bytes_out": info.bytes_out,
                    "packets_in": info.packets_in,
                    "packets_out": info.packets_out,
                    "age_s": round(age, 1),
                    "idle_s": round(idle, 1),
                    "hostname": info.hostname,
                    "country": info.country or "",
                })
            # Sort: most recently active first
            out.sort(key=lambda r: r["idle_s"])
            return json.dumps(out)
        except Exception:
            return "[]"

    @Slot(result=str)
    def exportConnectionsCSV(self):
        """v2.5.2 — Export the current connection list as CSV via a Save dialog.
        Returns JSON {ok, path, count, error}.

        CSV columns mirror the Inspector table plus the extra fields shown in
        the v2.5.2 detail modal — process ID, full local/remote address, proto,
        country, hostname, bytes/packets in/out, age, idle, established time."""
        try:
            from PySide6.QtWidgets import QFileDialog
            import csv as _csv

            # Snapshot the connection table (same logic as getConnections)
            with self.controller.conn_lock:
                items = list(self.controller.connection_table.values())
            now = time.monotonic()
            with self.controller.config_lock:
                target_pids = set(self.controller.config.target_pids)
            rows = []
            for info in items:
                if target_pids and info.pid not in target_pids:
                    continue
                rows.append(info)
            rows.sort(key=lambda i: max(0, now - i.last_seen))

            default_name = f"throttlr-connections-{datetime.now().strftime('%Y-%m-%d_%H-%M')}.csv"
            path, _ = QFileDialog.getSaveFileName(
                None,
                "Export Connections to CSV",
                default_name,
                "CSV File (*.csv);;All Files (*)"
            )
            if not path:
                return json.dumps({"ok": False, "cancelled": True, "error": ""})

            # Pick a sensible export timestamp once; per-row times are derived from it
            export_time = datetime.now().isoformat(timespec='seconds')

            with open(path, "w", encoding="utf-8", newline="") as f:
                writer = _csv.writer(f)
                writer.writerow([
                    "hostname", "remote_addr", "remote_port",
                    "local_addr", "local_port",
                    "country", "proto", "pid",
                    "bytes_in", "bytes_out", "total_bytes",
                    "packets_in", "packets_out",
                    "age_seconds", "idle_seconds",
                    "exported_at",
                ])
                for info in rows:
                    age = max(0, now - info.established_at)
                    idle = max(0, now - info.last_seen)
                    total = info.bytes_in + info.bytes_out
                    writer.writerow([
                        info.hostname or "",
                        info.remote_addr or "",
                        info.remote_port or 0,
                        info.local_addr or "",
                        info.local_port or 0,
                        info.country or "",
                        info.proto or "",
                        info.pid or 0,
                        info.bytes_in or 0,
                        info.bytes_out or 0,
                        total,
                        info.packets_in or 0,
                        info.packets_out or 0,
                        round(age, 2),
                        round(idle, 2),
                        export_time,
                    ])
            return json.dumps({
                "ok": True, "path": path, "count": len(rows), "error": ""
            })
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    # ---- Domain blocklist ----
    @Slot(bool)
    def setDomainBlockOn(self, on):
        with self.controller.config_lock:
            self.controller.config.domain_block_on = bool(on)

    @Slot(str)
    def setDomainBlockLists(self, json_lists):
        """Active built-in lists, e.g. ["ads","trackers"]."""
        try:
            lst = json.loads(json_lists) if json_lists else []
            if not isinstance(lst, list):
                return
            with self.controller.config_lock:
                self.controller.config.domain_block_lists = [str(x) for x in lst]
        except Exception:
            pass

    @Slot(str)
    def setDomainBlockCustom(self, json_domains):
        try:
            lst = json.loads(json_domains) if json_domains else []
            if not isinstance(lst, list):
                return
            with self.controller.config_lock:
                self.controller.config.domain_block_custom = [str(x) for x in lst]
        except Exception:
            pass

    @Slot(result=str)
    def getDomainBlocklistInfo(self):
        """Return both the available built-in lists (with sample domains)
        and the user's current selection/customs."""
        try:
            avail = {}
            for name, items in BUILTIN_BLOCKLISTS.items():
                avail[name] = {
                    "count": len(items),
                    "sample": list(items[:5]),
                }
            with self.controller.config_lock:
                cfg = self.controller.config
                state = {
                    "available": avail,
                    "active_lists": list(cfg.domain_block_lists),
                    "custom": list(cfg.domain_block_custom),
                    "on": bool(cfg.domain_block_on),
                }
            return json.dumps(state)
        except Exception:
            return "{}"

    # ---- Geo blocking ----
    @Slot(bool)
    def setGeoBlockOn(self, on):
        with self.controller.config_lock:
            self.controller.config.geo_block_on = bool(on)

    @Slot(str)
    def setGeoBlockCountries(self, json_codes):
        try:
            lst = json.loads(json_codes) if json_codes else []
            if not isinstance(lst, list):
                return
            with self.controller.config_lock:
                self.controller.config.geo_block_countries = [str(x).upper() for x in lst]
        except Exception:
            pass

    @Slot(result=str)
    def getGeoBlockState(self):
        try:
            with self.controller.config_lock:
                cfg = self.controller.config
                return json.dumps({
                    "on": bool(cfg.geo_block_on),
                    "countries": list(cfg.geo_block_countries),
                })
        except Exception:
            return "{}"

    # ---- Practice ping ----
    @Slot(int)
    def applyPracticePing(self, target_ms):
        """Apply the practice-ping target by configuring the lag function."""
        try:
            target_ms = max(0, min(2000, int(target_ms)))
            with self.controller.config_lock:
                cfg = self.controller.config
                cfg.practice_ping_on = target_ms > 0
                cfg.practice_ping_target_ms = target_ms
                cfg.lag_on = target_ms > 0
                cfg.lag_inbound = True
                cfg.lag_outbound = True
                cfg.lag_ms = target_ms
                # Add a small jitter (~10% of target, max 30ms) for realism
                cfg.lag_jitter_ms = min(30, target_ms // 10)
        except Exception:
            pass

    # ---- Recording / Replay ----
    @Slot(result=bool)
    def startRecording(self):
        try:
            target = self.controller.config.target_name
            self.recorder.start(target)
            return True
        except Exception:
            return False

    @Slot(result=str)
    def stopRecording(self):
        """Stop and persist. Returns the saved file path or "" on failure."""
        try:
            return self.recorder.stop()
        except Exception:
            return ""

    @Slot(result=bool)
    def isRecording(self):
        return bool(self.recorder.recording)

    @Slot(result=str)
    def listRecordings(self):
        try:
            return json.dumps(self.recorder.list_recordings())
        except Exception:
            return "[]"

    @Slot(str, result=str)
    def loadRecording(self, path):
        try:
            return json.dumps(self.recorder.load_recording(path))
        except Exception:
            return "{}"

    @Slot(str, result=bool)
    def deleteRecording(self, path):
        try:
            return self.recorder.delete_recording(path)
        except Exception:
            return False

    # ============================================================
    # Phase 4 (v2.7.0) — Throttlr Studio
    # ============================================================

    @Slot(str, result=str)
    def getStudioTimeline(self, path):
        """Load a recording and return its editable event-list shape.
        Returns JSON: {ok, duration_ms, target, started, events, error}."""
        try:
            data = self.recorder.load_recording(path)
            if not data:
                return json.dumps({"ok": False, "error": "Could not read recording"})
            tl = self.recorder.frames_to_events(data.get("frames", []) or [])
            return json.dumps({
                "ok":          True,
                "duration_ms": tl["duration_ms"],
                "events":      tl["events"],
                "target":      data.get("target", ""),
                "started":     data.get("started", ""),
                "ended":       data.get("ended",   ""),
                "edited":      data.get("edited",  ""),
            })
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(str, str, str, int, result=str)
    def saveStudioTimeline(self, src_path, dest_path, events_json, duration_ms):
        """Save edited events back to a .thrtlrec file.
        - src_path: original recording path (for stats lookup + metadata)
        - dest_path: where to write the new file (same as src for overwrite,
                     or a new path for 'Save as')
        - events_json: JSON-encoded event list
        - duration_ms: total recording duration in milliseconds
        Returns JSON: {ok, path, count, error}."""
        try:
            events = json.loads(events_json) if events_json else []
            if not isinstance(events, list):
                return json.dumps({"ok": False, "error": "events must be a JSON array"})
            # If dest_path is empty/relative, default to overwriting source
            if not dest_path or not dest_path.strip():
                dest_path = src_path
            # Safety: only allow writing inside RECORDINGS_DIR
            try:
                if Path(dest_path).resolve().parent != RECORDINGS_DIR.resolve():
                    return json.dumps({"ok": False, "error": "Destination must be inside the recordings folder"})
            except Exception:
                pass
            ok, err = self.recorder.save_edited_recording(
                src_path, dest_path, events, int(duration_ms))
            return json.dumps({
                "ok":    ok,
                "path":  dest_path if ok else "",
                "count": len(events),
                "error": err,
            })
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(str, result=str)
    def cloneRecordingForEdit(self, src_path):
        """Make a 'Save as' copy of the source path with '-edited' suffix.
        Returns JSON: {ok, new_path, error}."""
        try:
            p = Path(src_path)
            if not p.exists():
                return json.dumps({"ok": False, "error": "source not found"})
            stem = p.stem
            base = f"{stem}-edited"
            new_p = p.parent / f"{base}.thrtlrec"
            i = 2
            while new_p.exists():
                new_p = p.parent / f"{base}-{i}.thrtlrec"
                i += 1
            shutil.copy2(p, new_p)
            return json.dumps({"ok": True, "new_path": str(new_p)})
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(result=str)
    def getRecordingsFolder(self):
        try:
            return str(RECORDINGS_DIR)
        except Exception:
            return ""

    @Slot(result=bool)
    def openRecordingsFolder(self):
        """Open the recordings folder in the OS file browser."""
        try:
            path = str(RECORDINGS_DIR)
            if sys.platform == "win32":
                os.startfile(path)
            elif sys.platform == "darwin":
                import subprocess
                subprocess.Popen(["open", path])
            else:
                import subprocess
                subprocess.Popen(["xdg-open", path])
            return True
        except Exception:
            return False

    # ============================================================
    # Phase 3 bridge slots — Topology, PCAP, Filter scripting
    # ============================================================

    @Slot(result=str)
    def getTopology(self):
        """Snapshot of the connection table, aggregated for the topology
        graph: groups connections by remote IP and tallies bytes/count
        per remote endpoint."""
        try:
            with self.controller.conn_lock:
                items = list(self.controller.connection_table.values())
            with self.controller.config_lock:
                target_pids = set(self.controller.config.target_pids)
                target_name = self.controller.config.target_name
            agg = {}
            for info in items:
                if target_pids and info.pid not in target_pids:
                    continue
                if not info.remote_addr:
                    continue
                key = info.remote_addr
                slot = agg.setdefault(key, {
                    "addr": info.remote_addr,
                    "host": info.hostname or "",
                    "country": info.country or "",
                    "ports": set(),
                    "bytes_in": 0,
                    "bytes_out": 0,
                    "conns": 0,
                    "proto": info.proto,
                })
                slot["ports"].add(info.remote_port)
                slot["bytes_in"] += info.bytes_in
                slot["bytes_out"] += info.bytes_out
                slot["conns"] += 1
                # Prefer hostnames as we discover them
                if info.hostname and not slot["host"]:
                    slot["host"] = info.hostname
            nodes = []
            for k, v in agg.items():
                v["ports"] = sorted(list(v["ports"]))[:6]
                nodes.append(v)
            return json.dumps({
                "target": target_name or "",
                "nodes": nodes,
            })
        except Exception:
            return json.dumps({"target": "", "nodes": []})

    # ---- PCAP recording ----
    @Slot(result=bool)
    def startPcap(self):
        try:
            target = self.controller.config.target_name
            return bool(self.controller.pcap_writer.start(target))
        except Exception:
            return False

    @Slot(result=str)
    def stopPcap(self):
        try:
            return self.controller.pcap_writer.stop()
        except Exception:
            return ""

    @Slot(result=bool)
    def isPcapRecording(self):
        return bool(self.controller.pcap_writer.recording)

    @Slot(result=str)
    def getPcapStats(self):
        try:
            pw = self.controller.pcap_writer
            return json.dumps({
                "recording": pw.recording,
                "path": pw.path,
                "packets": pw.packet_count,
                "bytes": pw.byte_count,
            })
        except Exception:
            return "{}"

    @Slot(result=str)
    def listPcaps(self):
        try:
            return json.dumps(self.controller.pcap_writer.list_pcaps())
        except Exception:
            return "[]"

    @Slot(str, result=bool)
    def deletePcap(self, path):
        try:
            return self.controller.pcap_writer.delete_pcap(path)
        except Exception:
            return False

    @Slot(result=bool)
    def openPcapFolder(self):
        try:
            path = str(PCAP_DIR)
            if sys.platform == "win32":
                os.startfile(path)
            elif sys.platform == "darwin":
                import subprocess; subprocess.Popen(["open", path])
            else:
                import subprocess; subprocess.Popen(["xdg-open", path])
            return True
        except Exception:
            return False

    # ---- Filter scripting ----
    @Slot(str, result=str)
    def compileFilterScript(self, source):
        """Compile a filter expression. Returns JSON {ok, error}."""
        try:
            fs = FilterScript(source or "")
            if fs.compiled or not source.strip():
                self.controller.filter_script = fs if fs.compiled else None
                return json.dumps({"ok": True, "error": ""})
            return json.dumps({"ok": False, "error": fs.error})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    @Slot(bool)
    def setFilterScriptOn(self, on):
        with self.controller.config_lock:
            self.controller.config.script_on = bool(on)

    @Slot(str)
    def setFilterScriptAction(self, action):
        if action in ("drop", "keep_only", "lag", "log"):
            with self.controller.config_lock:
                self.controller.config.script_action = action

    @Slot(str)
    def setFilterScriptSource(self, source):
        """Save the source string to config (for persistence/display).
        Compilation is separate via compileFilterScript."""
        with self.controller.config_lock:
            self.controller.config.script_source = source or ""

    @Slot(result=str)
    def getFilterScriptState(self):
        try:
            with self.controller.config_lock:
                cfg = self.controller.config
                fs = self.controller.filter_script
                return json.dumps({
                    "source": cfg.script_source,
                    "action": cfg.script_action,
                    "on": cfg.script_on,
                    "compiled": bool(fs and fs.compiled),
                    "error": fs.error if fs else "",
                })
        except Exception:
            return "{}"

    @Slot(result=str)
    def getFilterScriptStats(self):
        """v3.0.9 — runtime diagnostics for the active filter script. The UI
        polls this while the script modal is open so the user can see live
        counters (evaluated / matched / errors). Without this they have no
        way to know if their expression is even firing — `matches()` swallows
        all exceptions per-packet and returns False (fail-safe), so a typo or
        a reference to an unavailable field (like pkt.host on non-TLS traffic)
        produces silent zero-match results."""
        try:
            with self.controller.config_lock:
                cfg = self.controller.config
                fs = self.controller.filter_script
            if fs is None:
                return json.dumps({
                    "active":      False,
                    "compiled":    False,
                    "on":          bool(cfg.script_on),
                    "eval_count":  0,
                    "match_count": 0,
                    "error_count": 0,
                    "last_error":  "",
                    "compile_error": "",
                })
            return json.dumps({
                "active":      True,
                "compiled":    bool(fs.compiled),
                "on":          bool(cfg.script_on),
                "eval_count":  int(fs.eval_count),
                "match_count": int(fs.match_count),
                "error_count": int(fs.error_count),
                "last_error":  fs.last_error or "",
                "compile_error": fs.error or "",
            })
        except Exception as e:
            return json.dumps({"active": False, "compiled": False, "compile_error": str(e)})

    # ============================================================
    # Onboarding — first-launch tutorial + update log
    # ============================================================

    @Slot(result=str)
    def getOnboardingState(self):
        """Return what onboarding flow (if any) should fire on this launch.
        - If the user has never seen the tutorial → mode = 'tutorial'
        - Else if last_seen_version differs from current → mode = 'changelog'
        - Else → mode = 'none'
        Tutorial trumps changelog — first-time users get the tutorial only,
        and tutorial completion records current version as seen so they
        don't double-prompt."""
        try:
            seen = bool(self.settings.get('tutorial_seen'))
            last_v = str(self.settings.get('last_seen_version') or "")
            cur_v = __version__
            if not seen:
                mode = 'tutorial'
            elif last_v != cur_v:
                mode = 'changelog'
            else:
                mode = 'none'
            return json.dumps({
                "mode": mode,
                "tutorial_seen": seen,
                "last_seen_version": last_v,
                "current_version": cur_v,
            })
        except Exception:
            return json.dumps({"mode": "none", "current_version": __version__})

    @Slot()
    def markTutorialSeen(self):
        """Mark the tutorial as completed. Does NOT touch last_seen_version
        — first-time users see the tutorial AND THEN the changelog right
        after, so they get a full intro to what's already in the app."""
        try:
            self.settings.set('tutorial_seen', True)
        except Exception:
            pass

    @Slot()
    def markVersionSeen(self):
        """User dismissed the changelog — record current version."""
        try:
            self.settings.set('last_seen_version', __version__)
        except Exception:
            pass

    @Slot()
    def resetTutorial(self):
        """Re-trigger the tutorial on next launch. Wired from Settings."""
        try:
            self.settings.set('tutorial_seen', False)
        except Exception:
            pass

    @Slot(result=str)
    def getChangelog(self):
        """Return the bundled changelog as JSON for the update-log modal."""
        try:
            return json.dumps(CHANGELOG)
        except Exception:
            return "[]"

    @Slot(result=str)
    def getCurrentVersion(self):
        return __version__

    # ============================================================
    # Auto-update — bridge slots
    # ============================================================

    @Slot(result=str)
    def getUpdateInfo(self):
        """Return current update-check state as JSON for the UI.
        Includes the user's previously-dismissed version so the UI can
        decide whether to show the modal proactively or just badge the
        Settings → Info tab."""
        try:
            state = update_checker.get_state() if update_checker else {
                "checked": False, "available": False, "current": __version__,
                "latest": "", "body": "", "html_url": GITHUB_RELEASES_URL,
                "zip_url": "", "error": "checker not initialized",
            }
            state["dismissed_version"] = str(self.settings.get('dismissed_update_version') or "")
            # The "should we prompt now?" flag — true only if there IS an update
            # AND the user hasn't already dismissed THIS specific version.
            state["should_prompt"] = bool(
                state.get("available") and state.get("latest")
                and state["latest"] != state["dismissed_version"]
            )
            return json.dumps(state)
        except Exception as e:
            return json.dumps({
                "checked": False, "available": False, "should_prompt": False,
                "current": __version__, "error": f"{type(e).__name__}: {e}",
            })

    @Slot()
    def recheckUpdate(self):
        """Manually re-trigger the GitHub check (e.g. user clicks "Check now"
        in Settings → Info). No-op if a check is already in flight."""
        try:
            if update_checker:
                update_checker.kick_off()
        except Exception:
            pass

    @Slot(str)
    def dismissUpdate(self, version):
        """User chose 'Not now' — remember which version they skipped so we
        don't prompt again for THIS version. Newer releases will still prompt."""
        try:
            v = str(version or "").strip()
            if v:
                self.settings.set('dismissed_update_version', v)
        except Exception:
            pass

    @Slot()
    def applyUpdate(self):
        """Kick off the update in a background thread so the UI stays responsive.
        Progress messages and the final result are emitted via the
        updateStatus signal — JS subscribes to that signal to update the
        modal text and trigger app exit when ready.

        Phases emitted: 'starting', 'downloading', 'extracting',
        'preparing', 'ready' (=> JS should call quitForUpdate), 'error'."""
        try:
            state = update_checker.get_state() if update_checker else {}
            zip_url = state.get("zip_url") or ""
            tag = state.get("latest") or ""
            if not zip_url:
                self.updateStatus.emit(json.dumps({
                    "phase": "error",
                    "ok": False,
                    "error": "No download URL is available for this release.",
                }))
                return

            # Spawn worker thread — applyUpdate returns immediately so the
            # JS event loop and Qt UI thread stay free
            self.updateStatus.emit(json.dumps({
                "phase": "starting",
                "message": "Starting…",
            }))
            t = threading.Thread(
                target=self._do_apply_update,
                args=(zip_url, tag),
                daemon=True,
            )
            t.start()
        except Exception as e:
            self.updateStatus.emit(json.dumps({
                "phase": "error",
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
            }))

    def _do_apply_update(self, zip_url, tag):
        """Worker: downloads + extracts + spawns helper batch. Runs in a
        background thread. Emits updateStatus signals at each milestone.

        v2.5.1 — progress_cb now accepts an optional extras dict so download
        progress can include byte counts, transfer speed, and ETA. The full
        payload gets forwarded to the JS UI via the updateStatus signal."""
        def progress_cb(phase, message, extras=None):
            try:
                payload = {"phase": phase, "message": message}
                if extras and isinstance(extras, dict):
                    payload.update(extras)
                self.updateStatus.emit(json.dumps(payload))
            except Exception:
                pass

        try:
            ok, err = install_update_and_relaunch(zip_url, tag, progress_cb=progress_cb)
            if ok:
                self.updateStatus.emit(json.dumps({
                    "phase": "ready",
                    "message": "Restarting…",
                    "ok": True,
                }))
            else:
                self.updateStatus.emit(json.dumps({
                    "phase": "error",
                    "ok": False,
                    "error": err,
                }))
        except Exception as e:
            self.updateStatus.emit(json.dumps({
                "phase": "error",
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
            }))

    @Slot()
    def quitForUpdate(self):
        """JS calls this after applyUpdate() returned ok=true so the app
        exits cleanly and the helper batch can swap the files."""
        try:
            QApplication.instance().quit()
        except Exception:
            pass

    @Slot(result=str)
    def getSystemInfo(self):
        """Return system/runtime diagnostics for the Settings → Info tab.
        Useful for users to confirm their environment looks correct, and
        for bug reports."""
        try:
            import platform
            # Windows version — try a friendly format first, fall back to platform.platform()
            try:
                wv = sys.getwindowsversion()
                win_str = f"Windows {wv.major}.{wv.minor} (build {wv.build})"
            except Exception:
                win_str = platform.platform()

            # Admin status — uses existing helper from the module
            try:
                admin_ok = bool(is_admin())
            except Exception:
                admin_ok = False

            # WinDivert driver — already detected at import time
            pydivert_ok = bool(HAS_PYDIVERT)
            pydivert_err = "" if pydivert_ok else (PYDIVERT_ERROR or "not installed")

            # Engine state — is capture currently running?
            engine_running = False
            try:
                engine_running = bool(getattr(self.controller, 'running', False))
            except Exception:
                pass

            # CPU — architecture + logical core count + max frequency where available
            cpu_str = ""
            try:
                arch = platform.machine() or "unknown"
                cores = psutil.cpu_count(logical=True) or 0
                freq_mhz = 0
                try:
                    f = psutil.cpu_freq()
                    if f and f.max:
                        freq_mhz = int(f.max)
                except Exception:
                    pass
                parts = [arch]
                if cores:
                    parts.append(f"{cores} cores")
                if freq_mhz:
                    parts.append(f"{freq_mhz/1000:.1f} GHz")
                cpu_str = " · ".join(parts)
            except Exception:
                cpu_str = "unknown"

            # Memory — total RAM rounded to 1 decimal GB
            ram_str = ""
            try:
                total = psutil.virtual_memory().total
                ram_str = f"{total / (1024 ** 3):.1f} GB"
            except Exception:
                ram_str = "unknown"

            # Hostname — local machine name
            host_str = ""
            try:
                host_str = socket.gethostname() or "unknown"
            except Exception:
                host_str = "unknown"

            # Network adapters — count of interfaces currently up, excluding loopback
            adapters_n = 0
            try:
                stats = psutil.net_if_stats()
                for name, st in stats.items():
                    if not getattr(st, 'isup', False):
                        continue
                    if name.lower().startswith(('loopback', 'lo')):
                        continue
                    adapters_n += 1
            except Exception:
                adapters_n = 0

            # Build mode — frozen .exe vs running from source
            frozen = bool(getattr(sys, 'frozen', False))
            build_str = "Compiled .exe" if frozen else "Python script"

            return json.dumps({
                "windows":      win_str,
                "python":       sys.version.split()[0],
                "admin":        admin_ok,
                "pydivert":     pydivert_ok,
                "pydivert_err": pydivert_err,
                "engine":       "running" if engine_running else "idle",
                "frozen":       frozen,
                # v3.0.9 — extra diagnostics
                "cpu":          cpu_str,
                "ram":          ram_str,
                "hostname":     host_str,
                "adapters":     adapters_n,
                "build":        build_str,
            })
        except Exception as e:
            return json.dumps({
                "error": f"{type(e).__name__}: {e}",
            })

    @Slot(result=str)
    def getFilterPreview(self):
        """Return a multi-line, read-only string describing the filter Throttlr
        is currently feeding to the kernel + the effective user-space rules.
        Surfaced in Settings → Info as a diagnostic — purely informational.

        v3.1.0 — added to give users visibility into the actual filter state
        without having to dig through every settings tab."""
        try:
            lines = []
            # The kernel-level WinDivert filter is intentionally broad — all
            # per-app + per-function filtering happens in user space against
            # the FilterConfig below.
            lines.append("Kernel filter:  tcp or udp")
            lines.append("Layer:          NETWORK")

            cfg = None
            try:
                cfg = self.controller.config
            except Exception:
                pass

            # Target app(s)
            if cfg is None:
                lines.append("Target:         (engine offline)")
            elif cfg.target_names:
                lines.append(f"Target:         Multi — {', '.join(cfg.target_names)}")
            elif cfg.target_name:
                pids = sorted(cfg.target_pids) if cfg.target_pids else []
                pid_str = f" (PID {pids[0]})" if len(pids) == 1 else (
                          f" ({len(pids)} PIDs)" if pids else "")
                lines.append(f"Target:         {cfg.target_name}{pid_str}")
            else:
                lines.append("Target:         (none)")

            # Active functions + their direction
            if cfg is not None:
                active = []
                func_specs = [
                    ("Lag",      cfg.lag_on,      cfg.lag_inbound,      cfg.lag_outbound),
                    ("Drop",     cfg.drop_on,     cfg.drop_inbound,     cfg.drop_outbound),
                    ("Throttle", cfg.throttle_on, cfg.throttle_inbound, cfg.throttle_outbound),
                    ("Freeze",   cfg.freeze_on,   cfg.freeze_inbound,   cfg.freeze_outbound),
                    ("Block",    cfg.block_on,    cfg.block_inbound,    cfg.block_outbound),
                ]
                for label, on, inb, out in func_specs:
                    if not on:
                        continue
                    if inb and out:
                        d = "In+Out"
                    elif inb:
                        d = "In"
                    elif out:
                        d = "Out"
                    else:
                        d = "off"
                    active.append(f"{label}({d})")
                if cfg.fun_mode:
                    active.append(f"Fun(intensity {cfg.fun_intensity})")
                lines.append(f"Active funcs:   {', '.join(active) if active else 'none'}")

                # Extras — only mention if active
                extras = []
                if cfg.script_on:
                    extras.append("Filter script")
                if cfg.domain_block_on:
                    n = len(cfg.domain_block_lists) + len(cfg.domain_block_custom)
                    extras.append(f"Domain block ({n} entries)")
                if cfg.geo_block_on:
                    extras.append(f"Geo block ({len(cfg.geo_block_countries)} countries)")
                if cfg.practice_ping_on:
                    extras.append(f"Practice ping ({cfg.practice_ping_target_ms}ms)")
                if extras:
                    lines.append(f"Extras:         {', '.join(extras)}")

            return "\n".join(lines)
        except Exception as e:
            return f"(filter preview unavailable: {type(e).__name__})"

    # ----- v3.1.0 (network-visibility batch) — Latency probe slots -----

    @Slot(bool, str, result=bool)
    def setLatencyProbe(self, on, host):
        """Turn the background ping probe on/off and set its target host."""
        try:
            self.controller.set_latency_probe(bool(on), host or "")
            return True
        except Exception as e:
            self.errorMessage.emit(f"Latency probe error: {e}")
            return False

    @Slot(result=str)
    def getLatencyState(self):
        """Return current latency probe state + recent samples as JSON.
        Frontend polls this for the graph overlay and the live readout."""
        try:
            history = self.controller.get_latency_history()
            samples = [(s if s is not None else -1) for s in history]
            valid = [s for s in history if s is not None]
            avg = (sum(valid) / len(valid)) if valid else 0.0
            mn  = min(valid) if valid else 0.0
            mx  = max(valid) if valid else 0.0
            return json.dumps({
                "on":      self.controller.latency_probe_on,
                "host":    self.controller.latency_probe_host,
                "last":    self.controller.latency_last_ms,
                "avg":     round(avg, 1),
                "min":     round(mn, 1),
                "max":     round(mx, 1),
                "samples": samples,   # last 60; -1 = failed ping
            })
        except Exception as e:
            return json.dumps({"error": str(e), "on": False, "samples": []})

    # ----- v3.1.0 (network-visibility batch) — Packet dump slots -----

    @Slot(bool, result=bool)
    def setPacketDump(self, on):
        """Toggle the live packet-dump tap. Frontend sets this when the
        dump modal opens/closes so the capture hot path stays cheap."""
        try:
            on = bool(on)
            self.controller.packet_dump_on = on
            if on:
                # Reset seq when re-enabling so the frontend doesn't get
                # stale entries from a previous session
                self.controller.clear_packet_dump()
            return True
        except Exception as e:
            self.errorMessage.emit(f"Packet dump error: {e}")
            return False

    @Slot(int, result=str)
    def getPacketDump(self, since_seq):
        """Return packets with seq > since_seq, as JSON. Frontend keeps
        track of the last seq it saw and asks for newer ones."""
        try:
            entries = self.controller.get_packet_dump(int(since_seq or 0))
            return json.dumps([
                {"seq": e[0], "ts": e[1], "dir": e[2], "proto": e[3],
                 "src": e[4], "dst": e[5], "size": e[6]}
                for e in entries
            ])
        except Exception as e:
            return json.dumps({"error": str(e)})

    @Slot(result=bool)
    def clearPacketDump(self):
        try:
            self.controller.clear_packet_dump()
            return True
        except Exception:
            return False

    # ----- v3.1.0 (real-networks batch) — Test-my-internet speedtest -----
    # Downloads a chunk from Cloudflare's edge (speed.cloudflare.com).
    # Streams progress via the speedtestProgress Signal. Runs in a worker
    # thread so we don't block the UI thread.

    speedtestProgress = Signal(str)   # JSON: {phase, bytes, elapsed_s, mbps}

    @Slot(int, result=bool)
    def runSpeedtest(self, target_mb):
        """Kick off a background speedtest. target_mb is the download size
        (typical: 25-100 MB). Returns True if the test started.

        Emits speedtestProgress(json) repeatedly during the run, with a
        final {phase: 'done', mbps: X} payload at the end."""
        try:
            mb = max(5, min(int(target_mb or 25), 200))
            t = threading.Thread(
                target=self._speedtest_worker, args=(mb,), daemon=True)
            t.start()
            return True
        except Exception as e:
            self.errorMessage.emit(f"Speedtest error: {e}")
            return False

    def _speedtest_worker(self, target_mb):
        """Hit Cloudflare's __down endpoint and measure throughput.
        Public, free, no API key, no library needed."""
        url = f"https://speed.cloudflare.com/__down?bytes={target_mb * 1024 * 1024}"
        try:
            self.speedtestProgress.emit(json.dumps({
                "phase": "starting", "host": "speed.cloudflare.com",
                "target_mb": target_mb,
            }))
            req = urllib.request.Request(url, headers={
                "User-Agent": f"Throttlr/{__version__} speedtest",
            })
            start = time.monotonic()
            bytes_down = 0
            last_emit = start
            with urllib.request.urlopen(req, timeout=30) as resp:
                # Read in 64KB chunks so we can emit progress smoothly
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    bytes_down += len(chunk)
                    now = time.monotonic()
                    # Throttle progress emissions to ~5/sec to keep UI calm
                    if now - last_emit >= 0.2:
                        elapsed = now - start
                        mbps = (bytes_down * 8) / (elapsed * 1_000_000) if elapsed > 0 else 0
                        self.speedtestProgress.emit(json.dumps({
                            "phase": "downloading",
                            "bytes": bytes_down,
                            "elapsed_s": round(elapsed, 2),
                            "mbps": round(mbps, 2),
                            "target_bytes": target_mb * 1024 * 1024,
                        }))
                        last_emit = now
            # Final result
            elapsed = max(time.monotonic() - start, 0.001)
            mbps = (bytes_down * 8) / (elapsed * 1_000_000)
            kbps = (bytes_down) / (elapsed * 1024)   # KB/s for throttle suggest
            self.speedtestProgress.emit(json.dumps({
                "phase": "done",
                "bytes": bytes_down,
                "elapsed_s": round(elapsed, 2),
                "mbps": round(mbps, 2),
                "kbps": round(kbps, 1),
            }))
        except Exception as e:
            self.speedtestProgress.emit(json.dumps({
                "phase": "error",
                "error": f"{type(e).__name__}: {e}",
            }))

    # =================================================================
    # v3.1.1 — Full speedtest: latency + download + upload.
    # Used by the new "Test my Speed" tool. Streams detailed progress
    # via fullSpeedtestProgress signal — phases: starting, latency,
    # downloading, uploading, done, error.
    #
    # v3.1.1 patch — Cloudflare's speed.cloudflare.com endpoints
    # started returning HTTP 403 to custom User-Agent strings
    # (treats them as scrapers). The fix is to use a realistic
    # browser UA, since these endpoints are designed to be called
    # by browser-based speed tests. Using a Chrome UA matches what
    # speed.cloudflare.com itself sends when you run the test in
    # your browser at speed.cloudflare.com.
    # =================================================================

    _SPEEDTEST_UA = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/127.0.0.0 Safari/537.36"
    )

    fullSpeedtestProgress = Signal(str)

    @Slot(result=bool)
    def runFullSpeedtest(self):
        """Kick off a comprehensive speedtest (latency + download + upload)."""
        # v3.1.1 — Log to startup.log so if anything goes wrong we have
        # a paper trail. Builtins-attached logger from main().
        def _stlog(msg):
            try:
                import builtins as _bi
                fn = getattr(_bi, '_throttlr_startup_log', None)
                if fn:
                    fn(f"[speedtest] {msg}")
            except Exception:
                pass

        _stlog("runFullSpeedtest() called")
        try:
            # Refuse to run ONLY if capture is genuinely active. When the
            # engine is running, throttle/lag/drop would distort results,
            # so we block and tell the user to stop it.
            #
            # v3.1.2 — We deliberately do NOT block on function toggle
            # state anymore. Toggles (Lag/Drop/Throttle/etc.) only affect
            # the network from inside the capture loop, which runs solely
            # while controller.running is True. With capture stopped, a
            # checked toggle does nothing to your connection — so blocking
            # on it was a false positive (the "Throttlr is still running"
            # error when nothing was actually running). controller.running
            # is the single source of truth.
            if self.controller.running:
                _stlog("blocked: controller is running")
                self.fullSpeedtestProgress.emit(json.dumps({
                    "phase": "blocked",
                    "error": "Throttlr is currently capturing. Stop the engine first — "
                             "any active throttle/lag/drop functions would distort the speedtest results.",
                }))
                return False

            _stlog("starting worker thread")
            t = threading.Thread(
                target=self._full_speedtest_worker, daemon=True)
            t.start()
            return True
        except Exception as e:
            _stlog(f"EXCEPTION in runFullSpeedtest: {type(e).__name__}: {e}")
            # Surface to UI via fullSpeedtestProgress (NOT errorMessage)
            # so the modal switches to the error pane, not a fading toast.
            try:
                self.fullSpeedtestProgress.emit(json.dumps({
                    "phase": "error",
                    "error": f"Failed to start: {type(e).__name__}: {e}",
                }))
            except Exception:
                pass
            return False

    def _full_speedtest_worker(self):
        """Runs a 3-phase test:
          1. Latency — 5 HEAD requests, take median round-trip time
          2. Download — 50MB stream from speed.cloudflare.com/__down
          3. Upload — 25MB POST to speed.cloudflare.com/__up

        Each phase emits live progress so the UI can animate. Final
        emit includes everything plus a "verdict" tier based on speed.
        """
        # v3.1.1 — Phase-by-phase logging so we can debug crashes
        def _stlog(msg):
            try:
                import builtins as _bi
                fn = getattr(_bi, '_throttlr_startup_log', None)
                if fn:
                    fn(f"[speedtest] {msg}")
            except Exception:
                pass

        _stlog("worker thread entered")
        results = {
            "latency_ms": None, "jitter_ms": None,
            "download_mbps": None, "upload_mbps": None,
        }
        try:
            # Phase 1 — Latency
            _stlog("phase 1: latency starting")
            self.fullSpeedtestProgress.emit(json.dumps({
                "phase": "starting", "host": "speed.cloudflare.com",
            }))
            pings = []
            for i in range(6):
                try:
                    req = urllib.request.Request(
                        "https://speed.cloudflare.com/__down?bytes=1",
                        method="GET",
                        headers={"User-Agent": self._SPEEDTEST_UA})
                    t0 = time.monotonic()
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        resp.read(1)
                    pings.append((time.monotonic() - t0) * 1000)  # ms
                except Exception:
                    pings.append(None)
                self.fullSpeedtestProgress.emit(json.dumps({
                    "phase": "latency",
                    "progress": (i + 1) / 6,
                    "current": pings[-1] if pings[-1] is not None else None,
                }))
            # Discard first ping (DNS/connection warmup), take median
            valid_pings = [p for p in pings[1:] if p is not None]
            if valid_pings:
                valid_pings.sort()
                median_ms = valid_pings[len(valid_pings) // 2]
                jitter = max(valid_pings) - min(valid_pings) if len(valid_pings) > 1 else 0
                results["latency_ms"] = round(median_ms, 1)
                results["jitter_ms"] = round(jitter, 1)

            _stlog(f"phase 1 done: median={results.get('latency_ms')}ms jitter={results.get('jitter_ms')}ms valid_pings={len(valid_pings) if valid_pings else 0}")

            # Phase 2 — Download (150MB for a longer, more accurate test)
            #
            # v3.1.1 patch — Cloudflare's /__down endpoint started
            # returning 403 for non-browser clients regardless of
            # User-Agent (likely TLS fingerprinting + header heuristics).
            # We try Cloudflare first with full browser-style headers,
            # then fall back to Hetzner's public speed test files which
            # have no bot detection and have been the de-facto free
            # speed test source for over a decade.
            DOWNLOAD_BYTES = 150 * 1024 * 1024
            _stlog(f"phase 2: download {DOWNLOAD_BYTES // (1024*1024)}MB starting")

            # Endpoints to try in order. Each tuple: (url, expected_bytes, label).
            # expected_bytes may be None if the endpoint serves a fixed file.
            download_endpoints = [
                (f"https://speed.cloudflare.com/__down?bytes={DOWNLOAD_BYTES}",
                 DOWNLOAD_BYTES, "cloudflare"),
                ("https://speed.hetzner.de/100MB.bin",
                 100 * 1024 * 1024, "hetzner-100MB"),
                ("https://proof.ovh.net/files/100Mb.dat",
                 100 * 1024 * 1024, "ovh-100MB"),
                ("https://ipv4.download.thinkbroadband.com/100MB.zip",
                 100 * 1024 * 1024, "thinkbroadband-100MB"),
            ]

            resp = None
            chosen_url = None
            chosen_total = DOWNLOAD_BYTES
            last_error = None
            for ep_url, ep_bytes, ep_label in download_endpoints:
                try:
                    _stlog(f"  trying download endpoint: {ep_label} ({ep_url})")
                    # Full browser-style header set. Cloudflare's anti-bot
                    # checks several of these in combination; matching what
                    # a real Chrome session sends gets us through.
                    req = urllib.request.Request(ep_url, headers={
                        "User-Agent":      self._SPEEDTEST_UA,
                        "Accept":          "*/*",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Accept-Encoding": "identity",   # don't gzip; we want raw bytes for accurate measurement
                        "Connection":      "keep-alive",
                        "Referer":         "https://speed.cloudflare.com/",
                        "sec-ch-ua":       '"Chromium";v="127", "Not)A;Brand";v="99"',
                        "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": '"Windows"',
                    })
                    resp = urllib.request.urlopen(req, timeout=180)
                    chosen_url = ep_url
                    chosen_total = ep_bytes
                    _stlog(f"  download endpoint accepted: {ep_label}")
                    break
                except Exception as e:
                    last_error = e
                    _stlog(f"  download endpoint {ep_label} failed: {type(e).__name__}: {e}")
                    continue

            if resp is None:
                # All endpoints failed — surface a useful error
                raise RuntimeError(
                    f"All download endpoints unreachable. "
                    f"Last error: {type(last_error).__name__}: {last_error}"
                )

            start = time.monotonic()
            bytes_down = 0
            last_emit = start
            with resp:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    bytes_down += len(chunk)
                    now = time.monotonic()
                    if now - last_emit >= 0.15:
                        elapsed = now - start
                        mbps = (bytes_down * 8) / (elapsed * 1_000_000) if elapsed > 0 else 0
                        self.fullSpeedtestProgress.emit(json.dumps({
                            "phase": "downloading",
                            "progress": min(1.0, bytes_down / chosen_total),
                            "current_mbps": round(mbps, 2),
                            "bytes": bytes_down,
                            "target_bytes": chosen_total,
                        }))
                        last_emit = now
            elapsed = max(time.monotonic() - start, 0.001)
            results["download_mbps"] = round((bytes_down * 8) / (elapsed * 1_000_000), 2)
            _stlog(f"phase 2 done: {results['download_mbps']} Mbps over {elapsed:.1f}s ({bytes_down} bytes)")

            # Phase 3 — Upload (75MB for a longer, more accurate test)
            UPLOAD_BYTES = 75 * 1024 * 1024
            _stlog(f"phase 3: upload {UPLOAD_BYTES // (1024*1024)}MB starting")
            # Generate payload — use os.urandom for incompressibility
            # (Cloudflare's endpoint doesn't compress but better safe)
            payload = os.urandom(UPLOAD_BYTES)

            # Use a streaming upload via a custom IO so we can emit progress
            class _ProgressIO(io.RawIOBase):
                def __init__(self, data, signal_obj, total):
                    self._data = data
                    self._pos = 0
                    self._signal = signal_obj
                    self._total = total
                    self._start = time.monotonic()
                    self._last_emit = self._start
                def readable(self): return True
                def read(self, size=-1):
                    if size < 0 or size > len(self._data) - self._pos:
                        size = len(self._data) - self._pos
                    if size <= 0:
                        return b""
                    chunk = self._data[self._pos:self._pos + size]
                    self._pos += size
                    now = time.monotonic()
                    if now - self._last_emit >= 0.15:
                        elapsed = now - self._start
                        mbps = (self._pos * 8) / (elapsed * 1_000_000) if elapsed > 0 else 0
                        try:
                            self._signal.emit(json.dumps({
                                "phase": "uploading",
                                "progress": min(1.0, self._pos / self._total),
                                "current_mbps": round(mbps, 2),
                                "bytes": self._pos,
                                "target_bytes": self._total,
                            }))
                        except Exception:
                            pass
                        self._last_emit = now
                    return chunk

            upload_url = "https://speed.cloudflare.com/__up"
            up_start = time.monotonic()
            try:
                req = urllib.request.Request(
                    upload_url,
                    data=_ProgressIO(payload, self.fullSpeedtestProgress, UPLOAD_BYTES),
                    method="POST",
                    headers={
                        "User-Agent":         self._SPEEDTEST_UA,
                        "Content-Length":     str(UPLOAD_BYTES),
                        "Content-Type":       "application/octet-stream",
                        "Accept":             "*/*",
                        "Accept-Language":    "en-US,en;q=0.9",
                        "Accept-Encoding":    "identity",
                        "Origin":             "https://speed.cloudflare.com",
                        "Referer":            "https://speed.cloudflare.com/",
                        "sec-ch-ua":          '"Chromium";v="127", "Not)A;Brand";v="99"',
                        "sec-ch-ua-mobile":   "?0",
                        "sec-ch-ua-platform": '"Windows"',
                    })
                with urllib.request.urlopen(req, timeout=240) as resp:
                    resp.read()  # consume response
                up_elapsed = max(time.monotonic() - up_start, 0.001)
                results["upload_mbps"] = round((UPLOAD_BYTES * 8) / (up_elapsed * 1_000_000), 2)
                _stlog(f"phase 3 done: {results['upload_mbps']} Mbps over {up_elapsed:.1f}s")
            except Exception as e:
                # Don't fail the whole test if upload fails — keep download results.
                # Upload endpoints are harder to find on free public infra than
                # downloads, so if Cloudflare blocks us we have nowhere else to
                # go and the test simply reports upload as "—".
                _stlog(f"phase 3 FAILED: {type(e).__name__}: {e}")
                self.fullSpeedtestProgress.emit(json.dumps({
                    "phase": "upload_failed", "error": str(e)
                }))

            # Phase 4 — Verdict
            _stlog("phase 4: computing verdict + network info")
            verdict = self._speedtest_verdict(results)
            # v3.1.1 — Gather network details (ISP, public IP, adapter info)
            # to include with the results so the user knows exactly what
            # connection was tested.
            network_info = self._gather_network_info()
            _stlog(f"network info gathered: ISP={network_info.get('isp')} adapter={network_info.get('primary_adapter')}")

            results["phase"] = "done"
            results["verdict"] = verdict
            results["network"] = network_info
            self.fullSpeedtestProgress.emit(json.dumps(results))
            _stlog("worker complete — emitted 'done' phase")

        except Exception as e:
            _stlog(f"WORKER CRASHED: {type(e).__name__}: {e}")
            import traceback as _tb
            _stlog(f"traceback: {_tb.format_exc()}")
            self.fullSpeedtestProgress.emit(json.dumps({
                "phase": "error",
                "error": f"{type(e).__name__}: {e}",
            }))

    def _gather_network_info(self):
        """v3.1.1 — Collect connection details to display in speedtest
        results. Each lookup is independent and fault-tolerant — if any
        one fails (no internet for ISP lookup, etc.) the rest still
        return. Worst case: all fields are 'Unknown'."""
        info = {
            "public_ip":   "Unknown",
            "isp":         "Unknown",
            "isp_org":     "Unknown",
            "city":        "Unknown",
            "region":      "Unknown",
            "country":     "Unknown",
            "primary_adapter":      "Unknown",
            "primary_adapter_type": "Unknown",
            "local_ip":             "Unknown",
            "gateway":              "Unknown",
            "dns_servers":          [],
        }

        # ---- Public IP + ISP from Cloudflare's trace endpoint ----
        # speed.cloudflare.com/meta returns JSON with the user's perceived
        # network. No API key, no rate limit for normal use.
        try:
            req = urllib.request.Request(
                "https://speed.cloudflare.com/meta",
                headers={"User-Agent": self._SPEEDTEST_UA})
            with urllib.request.urlopen(req, timeout=8) as resp:
                meta = json.loads(resp.read().decode('utf-8'))
                info["public_ip"] = meta.get("clientIp", "Unknown") or "Unknown"
                info["isp"]      = meta.get("asOrganization", "Unknown") or "Unknown"
                info["isp_org"]  = meta.get("asn", "")
                if info["isp_org"]:
                    info["isp_org"] = f"AS{info['isp_org']}"
                info["city"]     = meta.get("city",    "Unknown") or "Unknown"
                info["region"]   = meta.get("region",  "Unknown") or "Unknown"
                info["country"]  = meta.get("country", "Unknown") or "Unknown"
        except Exception:
            pass

        # ---- Local adapter info via Windows commands ----
        try:
            import subprocess as _sp
            CREATE_NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0
            # `route print 0.0.0.0` shows the default gateway and adapter
            # used for internet traffic. Cleaner than parsing ipconfig.
            try:
                result = _sp.run(
                    ["route", "print", "0.0.0.0"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=CREATE_NO_WINDOW)
                # Look for default-route line. Format varies by Windows
                # version but the gateway IP is usually in the 3rd column.
                for line in result.stdout.split('\n'):
                    parts = line.split()
                    if len(parts) >= 4 and parts[0] == '0.0.0.0' and parts[1] == '0.0.0.0':
                        info["gateway"] = parts[2]
                        info["local_ip"] = parts[3]
                        break
            except Exception:
                pass

            # `ipconfig /all` to find the adapter name + type for the
            # local IP we just identified.
            try:
                result = _sp.run(
                    ["ipconfig", "/all"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=CREATE_NO_WINDOW)
                # Parse output: find the adapter block containing our local_ip
                lines = result.stdout.split('\n')
                current_adapter = None
                current_adapter_type = None
                dns_collecting = False
                for line in lines:
                    stripped = line.strip()
                    # Adapter header line: "Ethernet adapter Wi-Fi:" / "Wireless LAN adapter Wi-Fi:"
                    if line and not line.startswith(' ') and 'adapter' in line.lower() and ':' in line:
                        # Extract adapter name (after "adapter ")
                        try:
                            idx = line.lower().index('adapter')
                            name_part = line[idx + len('adapter'):].rstrip(':').strip()
                            current_adapter = name_part
                            # Detect type from header text
                            if 'wireless' in line.lower() or 'wi-fi' in line.lower():
                                current_adapter_type = 'Wi-Fi'
                            elif 'ethernet' in line.lower():
                                current_adapter_type = 'Ethernet'
                            elif 'tunnel' in line.lower():
                                current_adapter_type = 'Tunnel/VPN'
                            elif 'bluetooth' in line.lower():
                                current_adapter_type = 'Bluetooth'
                            else:
                                current_adapter_type = 'Other'
                        except Exception:
                            pass
                        dns_collecting = False
                    # IPv4 line match — this block IS the one we want
                    elif 'IPv4 Address' in stripped and info["local_ip"] in stripped:
                        if current_adapter:
                            info["primary_adapter"] = current_adapter
                            info["primary_adapter_type"] = current_adapter_type or 'Unknown'
                    # DNS servers — only collect for primary adapter
                    elif 'DNS Servers' in stripped and current_adapter == info.get("primary_adapter"):
                        dns_collecting = True
                        # Extract DNS server IP from this line (after ":")
                        if ':' in stripped:
                            ip = stripped.split(':', 1)[1].strip()
                            if ip and ip != '::':
                                info["dns_servers"].append(ip)
                    elif dns_collecting and stripped and not ':' in stripped:
                        # Continuation line — additional DNS server
                        ip = stripped.strip()
                        if ip and not ip.startswith('Default'):
                            info["dns_servers"].append(ip)
                    elif dns_collecting and stripped and ':' in stripped:
                        # New field — stop collecting DNS
                        dns_collecting = False
            except Exception:
                pass
        except Exception:
            pass

        return info

    def _speedtest_verdict(self, r):
        """Generate a verdict object based on the measured speeds. The
        UI renders one of 15 possible verdict 'tiers' depending on
        download speed, with extra context drawn from latency and upload.
        """
        dl = r.get("download_mbps") or 0
        ul = r.get("upload_mbps") or 0
        lat = r.get("latency_ms") or 0
        jit = r.get("jitter_ms") or 0

        # 15-tier verdict ladder, ordered slowest → fastest
        tiers = [
            # (max_mbps, tier_name, headline, description, capabilities)
            (1, "DIAL-UP TIER", "Genuinely brutal",
             "Welcome to 1996. At under 1 Mbps you're effectively on a 56k modem in a world built for fiber. Almost nothing on the modern web is designed to work at this speed — pages will partially load, images will fail to render, and most apps will throw connection errors before they even open. If you're seeing this on a connection that should be faster, suspect a stuck modem, a broken Wi-Fi extender, or aggressive bandwidth throttling.",
             ["Plain-text emails (no attachments)", "Tiny HTML pages with no images",
              "ICQ and IRC-style text chat", "Definitely NOT for video, voice, or modern apps",
              "Even loading the Throttlr website would take ~3 minutes"]),

            (3, "VERY POOR", "Painfully slow",
             "You're barely above dial-up. Almost everything will feel sluggish — clicking a link, loading a chat app, opening an email. SD video might play if you're patient. Streaming and video calls are essentially out of reach. This is the speed range you'd see on a satellite connection in a remote area, or a cellular connection in a low-signal zone, or DSL in a region the telco forgot about.",
             ["Light web browsing (text-heavy sites)", "Email with small attachments",
              "VoIP calls (audio only, with frequent drops)", "Maybe SD YouTube if you wait for buffering",
              "Discord text chat works fine; voice will struggle"]),

            (5, "POOR", "Below modern usable",
             "This is the speed that frustrates people into switching ISPs. Web pages load slowly, anything embedded (videos, ads, third-party widgets) makes the whole page feel broken. SD video is possible; HD streaming will buffer constantly. If multiple devices share this connection, expect each one to feel half-broken.",
             ["Standard web browsing (single device)", "SD YouTube (480p with patience)",
              "Discord voice calls (mono audio only)", "Online gaming will work but feel laggy",
              "Cloud uploads are essentially impossible at any usable speed"]),

            (10, "BELOW AVERAGE", "Survivable but tight",
             "You can do basic modern things, but you'll constantly feel the ceiling. A single device watching SD video uses most of your bandwidth. Two devices doing anything simultaneously will cause noticeable slowdowns. This is the floor where 'broadband' really starts being a stretch — old DSL, slow rural cable, or a strained shared Wi-Fi connection.",
             ["SD streaming for one device", "Discord voice (stereo)",
              "Light gaming (high ping likely)", "Realistically only 1-2 active devices at once",
              "Software updates will run overnight, not on-demand"]),

            (25, "OKAY", "FCC-defined broadband floor",
             "Congratulations, you've reached what the FCC officially considers 'broadband' in 2024. Single-user HD streaming works, gaming is fine if your latency is low, and you can do most modern things — but a household will feel constrained. Two people streaming HD at the same time will already push the limit. If you're paying for more than this, your line is underperforming.",
             ["HD Netflix (1080p) for one device", "Discord HD video calls",
              "Online gaming (latency-dependent but stable)", "Cloud backups (slow but workable)",
              "Light remote work (Zoom, Slack, occasional file uploads)",
              "A 1 GB game download takes about 6 minutes"]),

            (50, "DECENT", "Solid for one person",
             "This is genuinely comfortable for a single user. HD streaming, online gaming, video calls — all smooth. Multi-device households will start feeling the ceiling during peak hours (everyone home, multiple streams), but for most of the day this just works. This is the typical 'I'm not paying premium for fiber' speed in 2024.",
             ["1080p streaming x1-2 devices simultaneously",
              "Stable online gaming with low ping",
              "Zoom HD calls without quality drops",
              "Light remote work + occasional large file transfers",
              "A 1 GB game download takes about 3 minutes",
              "Twitch streaming at 720p is possible"]),

            (100, "GOOD", "Modern household baseline",
             "You're now in the sweet spot for a 2-4 person household. 4K streaming on one device while the rest of the family does normal stuff — all comfortable. Cloud sync becomes invisible. Online gaming has plenty of headroom. This is what most fiber-deployed urban areas now offer as their entry tier, and it covers 95% of real household needs.",
             ["4K streaming (1 device) + 1080p on others",
              "Cloud sync stays invisible — never a bottleneck",
              "Smooth competitive gaming (even on multiple consoles)",
              "Streaming to Twitch in 1080p60",
              "A 1 GB game download takes about 90 seconds",
              "Working from home with HD video + screen share, no stutter"]),

            (200, "VERY GOOD", "Comfortable power-user territory",
             "Most things just work without you ever thinking about them. Multiple 4K streams, gaming, video calls, downloads in the background — your connection is no longer the limiting factor. Content creators and streamers start to find this comfortable. Power users running NAS systems, home labs, or multi-user households are all served.",
             ["Multi-device 4K streaming on everything at once",
              "Twitch streaming at 1080p60 with bitrate to spare",
              "Big game downloads (~25 min for a full 100 GB title)",
              "Multiple cloud uploads at once without anyone noticing",
              "A 1 GB file uploads in under a minute (with decent upload speed)",
              "Hosting Discord watch parties with no quality compromise"]),

            (500, "EXCELLENT", "Genuinely fast",
             "Whatever you're doing, the bottleneck is no longer your connection — it's your CPU, your disk, or the server on the other end. Streamers, content creators, multi-user households all handled with massive headroom. If you're paying for this and seeing this number, you're getting your money's worth. Most people who experience this speed never want to go back.",
             ["4K Twitch/YouTube streaming with high bitrate",
              "Large file uploads to YouTube without waiting",
              "Multiple 4K streams + simultaneous downloads",
              "Self-hosting small services for friends",
              "A 1 GB game download takes about 16 seconds",
              "Cloud-based dev workflows feel local",
              "Steam library re-downloads happen during dinner"]),

            (1000, "GIGABIT TIER", "Premium-grade",
             "Sub-1ms in-app latency to most CDNs. Game downloads measured in minutes, not hours. You're ahead of 95% of home connections globally. At this point your speed is rarely the limiting factor in anything — even saturated household use leaves headroom. This is what's commonly called 'gigabit fiber' and it's where the experience starts feeling magical.",
             ["100 GB game download in ~15 minutes",
              "Concurrent 4K streams on every device in the house",
              "Streamers/creators completely set",
              "Smooth VR streaming with no compression artifacts",
              "Re-downloading your entire Steam library is a weekend project, not a week",
              "Real-time cloud backup of huge folders",
              "Pretty much every modern app feels as fast as local"]),

            (2500, "MULTI-GIG", "Enthusiast territory",
             "Faster than most consumer hard drives can write. If you're actually saturating this, you're probably running a small business, hosting a Plex server for an extended family, or moving production-grade content. The chokepoint is no longer your ISP — it's your hardware. SATA SSDs cap out around 500 MB/s, so single-file transfers WILL be disk-bound long before they're network-bound.",
             ["AAA game in about 5 minutes",
              "8K streaming with zero compression compromise",
              "Production-grade content uploads (4K masters to clients)",
              "Multi-user prosumer environments",
              "Cloud-based 3D rendering pipelines",
              "Hosting a small online community/Plex server for dozens of users",
              "Backing up a 1TB drive in under an hour"]),

            (5000, "5 GIG", "Future-proof",
             "Wildly more than most homes will ever need. This is for fiber early adopters, small commercial setups, and people who just want to flex their connection at parties. At 5 Gbps you'll need an NVMe SSD to fully saturate single-file transfers; older SATA drives become the bottleneck. Most websites won't even serve to you this fast because of their CDN limits.",
             ["Multiple 8K streams across the house",
              "LAN parties hosting dozens of players",
              "Mid-size business-grade connectivity",
              "Full cloud workstation territory (think Shadow PC or GeForce Now at max quality)",
              "Real-time multi-camera 4K production uploads",
              "Backing up an entire NAS in under an hour"]),

            (10000, "10 GIG", "Data-center adjacent",
             "Residential 10G fiber. You're either flexing, running a serious home lab, or you genuinely need it for streaming/dev work. Most consumer apps literally cannot saturate this — they're not designed for it. Servers and CDNs throttle individual connections well below this. The only way to actually USE 10G is to be transferring between two equally-capable machines, like a NAS-to-NAS sync.",
             ["Real-time 8K multi-cam production",
              "Mirror-fast cloud workflows (cloud feels like local SSD)",
              "Small commercial backbone connectivity",
              "Symmetric NAS / file server hosting for dozens of clients",
              "Full datacenter VPS environments at home",
              "Streaming infrastructure for a small organization",
              "Realistic-grade ML model training data pulls"]),

            (50000, "ULTRA", "Backbone-level",
             "This isn't a normal residential speed. You're on enterprise fiber, a campus uplink, or sitting next to an internet exchange point. At 50 Gbps you're operating at the speed of major ISPs' inter-city backbones. Real-world apps cannot use this — you'd need specialized hardware (10G+ NICs, NVMe RAID, kernel-bypass networking) just to MEASURE this accurately. If you genuinely have this at home, this app probably can't keep up with you.",
             ["Anything you can think of, multiple times over",
              "Hosting a real internet service from your house",
              "Real-time ML model uploads to/from datacenters",
              "Multi-region disaster recovery sync"]),

            (float('inf'), "RIDICULOUS", "Wait, really?",
             "Either you're testing from inside a datacenter, you work at an ISP, or our measurement is just wrong. Nobody actually has this at home. If you DO have this at home, please tell us how because we want to come over. Most likely cause: you're running the test on a server, our endpoint hit a CDN edge with way more headroom than expected, or your line is somehow pegged to a Tier 1 backbone.",
             ["You don't need a verdict — you ARE the verdict",
              "Send us a screenshot, we'll add a 16th tier just for you"]),
        ]

        tier_info = tiers[-1]
        for cap, name, headline, desc, capabilities in tiers:
            if dl < cap:
                tier_info = (cap, name, headline, desc, capabilities)
                break
        _cap, tier_name, headline, desc, capabilities = tier_info

        # Latency assessment — separate from speed
        if lat == 0:
            latency_grade = "unknown"
            latency_detail = "Latency couldn't be measured."
        elif lat < 20:
            latency_grade = "excellent"
            latency_detail = f"{lat:.0f}ms — competitive gaming territory. Your inputs hit the server before you can blink."
        elif lat < 50:
            latency_grade = "good"
            latency_detail = f"{lat:.0f}ms — comfortable for everything including online gaming and live calls."
        elif lat < 100:
            latency_grade = "okay"
            latency_detail = f"{lat:.0f}ms — fine for streaming and casual gaming. Competitive shooters might feel slightly off."
        elif lat < 200:
            latency_grade = "high"
            latency_detail = f"{lat:.0f}ms — noticeable in real-time apps. Voice calls have a beat of delay; gaming will feel laggy."
        else:
            latency_grade = "very high"
            latency_detail = f"{lat:.0f}ms — uncomfortable for anything interactive. Could indicate satellite, distant server, or congestion."

        # Jitter assessment
        if jit == 0:
            jitter_grade = "unknown"
            jitter_detail = "Jitter couldn't be measured."
        elif jit < 5:
            jitter_grade = "rock solid"
            jitter_detail = f"{jit:.0f}ms — extremely stable, every packet arrives on time."
        elif jit < 15:
            jitter_grade = "good"
            jitter_detail = f"{jit:.0f}ms — minor variation, generally invisible to apps."
        elif jit < 30:
            jitter_grade = "noticeable"
            jitter_detail = f"{jit:.0f}ms — voice apps may glitch occasionally; competitive gaming will feel inconsistent."
        else:
            jitter_grade = "unstable"
            jitter_detail = f"{jit:.0f}ms — your latency is bouncing around badly. Calls drop quality, games rubberband."

        # Upload vs download ratio note
        ratio_note = ""
        if dl > 0 and ul > 0:
            ratio = ul / dl
            if ratio > 0.8:
                ratio_note = (f"Symmetric connection — uploads at {ul:.0f} Mbps run nearly as fast as downloads at {dl:.0f} Mbps. "
                              f"Almost certainly fiber. Great for streaming, large file sharing, hosting, and cloud sync.")
            elif ratio > 0.3:
                ratio_note = (f"Healthy upload speed — uploads at {ul:.0f} Mbps are about {int(ratio*100)}% of your download. "
                              f"You can stream/upload reasonably well without bottlenecks.")
            elif ratio > 0.1:
                ratio_note = (f"Typical asymmetric residential connection — uploads at {ul:.0f} Mbps are roughly {int(ratio*100)}% of your "
                              f"{dl:.0f} Mbps download. Common on cable, ADSL2+, and most non-fiber plans.")
            else:
                ratio_note = (f"Very asymmetric — uploads at {ul:.0f} Mbps are less than {int(ratio*100)+1}% of your download speed. "
                              f"Common on cable/DSL. You'll feel this when sharing large files, streaming to Twitch, or backing up to cloud.")
        elif dl > 0:
            ratio_note = "Upload speed wasn't measured (endpoint refused our test). Download numbers are accurate though."

        # NEW v3.1.1 — Use-case ratings (1-5 stars depending on how well
        # this speed handles common scenarios)
        def _rate(dl_min, lat_max=None):
            score = 5
            if dl < dl_min: score = 1
            elif dl < dl_min * 1.5: score = 2
            elif dl < dl_min * 2.5: score = 3
            elif dl < dl_min * 5: score = 4
            if lat_max and lat > 0 and lat > lat_max:
                score = max(1, score - 1)
            return "★" * score + "☆" * (5 - score)

        use_cases = [
            ("Web browsing",                _rate(5)),
            ("HD Netflix (1080p)",          _rate(5)),
            ("4K Netflix",                  _rate(25)),
            ("Online gaming",               _rate(15, lat_max=80)),
            ("Competitive gaming (FPS)",    _rate(25, lat_max=40)),
            ("Discord voice + video",       _rate(5,  lat_max=120)),
            ("Zoom HD meetings",            _rate(10, lat_max=150)),
            ("Twitch streaming (1080p60)",  _rate(50)),
            ("Cloud backup (large)",        _rate(30)),
            ("Big game download (100 GB)",  _rate(50)),
        ]

        # NEW v3.1.1 — Fun comparison facts. Two of these are picked
        # based on the speed tier — concrete, relatable references.
        if dl >= 1000:
            fun_facts = [
                f"You could download an entire 4K Blu-ray (~50 GB) in about {round(50 * 8 * 1024 / dl, 0):.0f} seconds.",
                f"Your 100 GB Call of Duty install completes in about {round(100 * 8 * 1024 / dl, 1):.1f} minutes.",
                f"You could re-download your entire Steam library overnight without trying.",
            ]
        elif dl >= 100:
            fun_facts = [
                f"A 1 GB game patch downloads in about {round(1 * 8 * 1024 / dl, 0):.0f} seconds.",
                f"A 50 GB AAA game completes in about {round(50 * 8 * 1024 / dl / 60, 1):.1f} minutes.",
                f"You can watch 4K Netflix on {int(dl // 25)} devices at once before hitting the ceiling.",
            ]
        elif dl >= 25:
            fun_facts = [
                f"A 1 GB file takes about {round(1 * 8 * 1024 / dl / 60, 1):.1f} minutes to download.",
                f"You can stream 1080p Netflix on {max(1, int(dl // 5))} devices at once.",
                f"A 50 GB game install takes about {round(50 * 8 * 1024 / dl / 60, 0):.0f} minutes.",
            ]
        elif dl >= 5:
            fun_facts = [
                f"A 1 GB file takes about {round(1 * 8 * 1024 / dl / 60, 0):.0f} minutes to download.",
                f"You can stream 1080p video on just one device at a time.",
                f"A 50 GB game would take about {round(50 * 8 * 1024 / dl / 3600, 1):.1f} hours.",
            ]
        else:
            fun_facts = [
                f"A 1 GB file would take roughly {round(1 * 8 * 1024 / max(dl, 0.1) / 60, 0):.0f} minutes to download.",
                f"Streaming SD video is about the upper limit you can reliably do.",
                f"This speed is below what most modern apps assume you have.",
            ]

        # NEW v3.1.1 — Concrete Throttlr presets to simulate worse speeds
        # for testing. Useful for game devs / streamers wanting to test
        # how their app behaves on poor connections.
        simulation_presets = []
        if dl > 50:
            simulation_presets.append({
                "name": "Mobile 4G",
                "settings": "Throttle: 20 Mbps both, Lag: 60ms",
                "feels_like": "Browsing on a phone at 4G in a decent-signal area",
            })
        if dl > 25:
            simulation_presets.append({
                "name": "Crowded café Wi-Fi",
                "settings": "Throttle: 10 Mbps down / 2 Mbps up, Lag: 80ms, Drop: 2%",
                "feels_like": "Working from a busy coffee shop on shared Wi-Fi",
            })
        if dl > 10:
            simulation_presets.append({
                "name": "Bad hotel Wi-Fi",
                "settings": "Throttle: 5 Mbps, Lag: 200ms, Drop: 5%, Jitter: 30ms",
                "feels_like": "That hotel where the Wi-Fi 'works' but barely",
            })
        if dl > 3:
            simulation_presets.append({
                "name": "Rural satellite",
                "settings": "Throttle: 3 Mbps, Lag: 600ms (one-way), Drop: 1%",
                "feels_like": "Old-school Hughesnet / Starlink in a rough cell",
            })

        return {
            "tier_name":      tier_name,
            "headline":       headline,
            "description":    desc,
            "capabilities":   capabilities,
            "latency_grade":  latency_grade,
            "latency_detail": latency_detail,
            "jitter_grade":   jitter_grade,
            "jitter_detail":  jitter_detail,
            "ratio_note":     ratio_note,
            "use_cases":      use_cases,
            "fun_facts":      fun_facts,
            "simulation_presets": simulation_presets,
        }


    @Slot(str, result=bool)
    def updateConfig(self, json_str):
        try:
            data = json.loads(json_str)
            self._apply_filter_config(data)
            return True
        except Exception as e:
            self.errorMessage.emit(f"Config error: {e}")
            return False

    def _filter_config_from_dict(self, data: dict, base) -> "FilterConfig":
        """Build a FilterConfig from a JS preset dict, preserving targeting and
        Phase-2/3 fields (domain/geo block, practice ping, filter script) from
        `base`. Shared by _apply_filter_config (single shared config) and
        updateAppConfig (per-app multi-target). Must be called with
        controller.config_lock held."""
        return FilterConfig(
            target_pids=set(base.target_pids),
            target_name=base.target_name,
            target_names=list(base.target_names),
            pid_to_app=dict(getattr(base, "pid_to_app", {}) or {}),
            lag_on=data.get("lag_on", False),
            lag_inbound=data.get("lag_in", True),
            lag_outbound=data.get("lag_out", True),
            lag_ms=int(data.get("lag_ms", 500)),
            lag_jitter_ms=int(data.get("lag_jitter_ms", 0)),
            drop_on=data.get("drop_on", False),
            drop_inbound=data.get("drop_in", True),
            drop_outbound=data.get("drop_out", True),
            drop_chance=int(data.get("drop_chance", 60)),
            drop_dns_only=bool(data.get("drop_dns_only", False)),
            drop_pattern=str(data.get("drop_pattern", "uniform") or "uniform"),
            drop_burst_len=max(1, int(data.get("drop_burst_len", 4))),
            drop_gap_len=max(1, int(data.get("drop_gap_len", 20))),
            throttle_on=data.get("throttle_on", False),
            throttle_inbound=data.get("throttle_in", True),
            throttle_outbound=data.get("throttle_out", True),
            throttle_kbps=int(data.get("throttle_kbps", 100)),
            bandwidth_quota_on=bool(data.get("bandwidth_quota_on", False)),
            quota_mb=max(1, int(data.get("quota_mb", 1000))),
            quota_action=str(data.get("quota_action", "throttle") or "throttle"),
            quota_throttle_kbps=max(1, int(data.get("quota_throttle_kbps", 50))),
            dns_chaos_on=bool(data.get("dns_chaos_on", False)),
            freeze_on=data.get("freeze_on", False),
            freeze_inbound=data.get("freeze_in", True),
            freeze_outbound=data.get("freeze_out", True),
            freeze_replay_ms=int(data.get("freeze_replay_ms", 0)),
            block_on=data.get("block_on", False),
            block_inbound=data.get("block_in", True),
            block_outbound=data.get("block_out", True),
            fun_mode=data.get("fun_on", False),
            fun_intensity=int(data.get("fun_intensity", 50)),
            domain_block_on=base.domain_block_on,
            domain_block_lists=list(base.domain_block_lists),
            domain_block_custom=list(base.domain_block_custom),
            geo_block_on=base.geo_block_on,
            geo_block_countries=list(base.geo_block_countries),
            practice_ping_on=base.practice_ping_on,
            practice_ping_target_ms=base.practice_ping_target_ms,
            script_source=base.script_source,
            script_action=base.script_action,
            script_on=base.script_on,
        )

    def _apply_filter_config(self, data: dict):
        """Apply a filter-config dict to the running engine. Used by
        updateConfig (JS-driven) and also by AutomationEngine when a rule
        action requests a preset application. Phase-2 and Phase-3 fields
        (domain block, geo block, practice ping, filter script) are preserved
        from the existing config — they have dedicated bridge slots and don't
        belong in the generic 6-function preset payload."""
        if not isinstance(data, dict):
            raise ValueError("filter config must be a dict")
        with self.controller.config_lock:
            new_cfg = self._filter_config_from_dict(data, self.controller.config)
        self.controller.update_config(new_cfg)

    @Slot(str, str, result=bool)
    def updateAppConfig(self, app_name, json_str):
        """v3.1.3.2 — multi-target per-app settings. Store a FilterConfig for a
        single app. The worker applies it to packets owned by that app
        (resolved via config.pid_to_app). Targeting + Phase-2/3 fields are
        inherited from the live config. No effect on single-target, which
        leaves per_app_cfgs empty."""
        try:
            if not app_name:
                return False
            data = json.loads(json_str) if json_str else {}
            if not isinstance(data, dict):
                return False
            with self.controller.config_lock:
                cfg = self._filter_config_from_dict(data, self.controller.config)
            self.controller.per_app_cfgs[str(app_name)] = cfg
            return True
        except Exception as e:
            self.errorMessage.emit(f"Per-app config error: {e}")
            return False

    @Slot()
    def clearAppConfigs(self):
        """v3.1.3.2 — drop all per-app settings + per-app throttle buckets.
        Called when multi-target is turned off so settings reset."""
        try:
            self.controller.per_app_cfgs = {}
            with self.controller.throttle_lock:
                self.controller.throttle_state_by_app = {}
        except Exception:
            pass

    @Slot()
    def startCapture(self):
        # Re-resolve target_pids right now in case the target app spawned
        # or restarted since selection. This prevents the very common case
        # where Discord/Chrome/games launch helper processes between when
        # the user picks the app and when they hit Start.
        try:
            self.controller._refresh_target_pids()
        except Exception:
            pass

        if not self.controller.config.target_pids:
            self.errorMessage.emit("No app selected — pick one from the list.")
            return
        play_tones((523, 60), (659, 60), (784, 90))
        # Always reset stats on Start — every run is a fresh measurement.
        # The reset_stats_on_start setting is kept for backward-compat but
        # we always reset; preserving stale stats across runs is confusing
        # (sent/dropped/delayed/held don't mean anything from a previous app).
        self.controller.reset_stats()
        self.controller.start()

    @Slot()
    def stopCapture(self):
        play_tones((784, 60), (659, 60), (523, 90))
        # v2.5.2 — run stop on a background thread so the GUI stays responsive.
        # _finalize_stop closes WinDivert handles which can briefly block the
        # caller (kernel drains its receive buffer); doing it inline on the Qt
        # main thread caused ~1s UI freeze right after clicking Stop.
        threading.Thread(target=self.controller.stop, daemon=True).start()

    @Slot()
    def resetStats(self):
        self.controller.reset_stats()

    @Slot(bool)
    def toggleFreeze(self, on):
        play_tones((880, 90)) if on else play_tones((440, 90))
        if not on and self.settings.get("auto_clear_freeze_queue"):
            self.controller.clear_freeze_queue()

    @Slot(bool)
    def toggleBlock(self, on):
        play_tones((1100, 80)) if on else play_tones((550, 80))

    @Slot(bool)
    def toggleFun(self, on):
        play_tones((660, 60), (880, 60), (1100, 80)) if on else play_tones((440, 80))

    @Slot(result=int)
    def clearFreezeQueue(self):
        return self.controller.clear_freeze_queue()

    @Slot(result=str)
    def listProfiles(self):
        try:
            files = sorted(p.stem for p in PROFILE_DIR.glob("*.json")
                           if p.name != "settings.json")
            return json.dumps(files)
        except Exception:
            return "[]"

    @Slot(str, str, result=bool)
    def saveProfile(self, name, json_str):
        try:
            safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()
            if not safe:
                return False
            (PROFILE_DIR / f"{safe}.json").write_text(json_str)
            return True
        except Exception:
            return False

    @Slot(str, result=str)
    def loadProfile(self, name):
        try:
            safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()
            return (PROFILE_DIR / f"{safe}.json").read_text()
        except Exception:
            return ""

    @Slot(str, result=bool)
    def deleteProfile(self, name):
        try:
            safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()
            (PROFILE_DIR / f"{safe}.json").unlink()
            return True
        except Exception:
            return False

    @Slot(result=bool)
    def isAdmin(self):
        return is_admin()

    @Slot(int, int)
    def playTone(self, freq, dur_ms):
        play_tones((freq, dur_ms))

    # -------- Window controls (frameless support) --------

    def set_window(self, window):
        """Called by MainWindow after construction so Bridge can drive window."""
        self._window = window

    @Slot()
    def minimizeWindow(self):
        if hasattr(self, "_window") and self._window:
            self._window.showMinimized()

    @Slot()
    def toggleMaximizeWindow(self):
        if hasattr(self, "_window") and self._window:
            if self._window.isMaximized():
                self._window.showNormal()
            else:
                self._window.showMaximized()

    @Slot()
    def closeWindow(self):
        if hasattr(self, "_window") and self._window:
            self._window.close()

    @Slot()
    def startDragWindow(self):
        if hasattr(self, "_window") and self._window:
            handle = self._window.windowHandle()
            if handle:
                handle.startSystemMove()

    @Slot(str)
    def startResizeWindow(self, edges_str):
        """edges_str like 'right', 'bottom', 'right,bottom', 'top,left', etc."""
        if not (hasattr(self, "_window") and self._window):
            return
        handle = self._window.windowHandle()
        if not handle:
            return
        # PySide6's Qt.Edge enum can't be constructed from 0 — must build int and cast
        e = 0
        if "top" in edges_str:    e |= Qt.TopEdge.value
        if "bottom" in edges_str: e |= Qt.BottomEdge.value
        if "left" in edges_str:   e |= Qt.LeftEdge.value
        if "right" in edges_str:  e |= Qt.RightEdge.value
        if e:
            handle.startSystemResize(Qt.Edges(e))

    @Slot(result=bool)
    def isMaximized(self):
        if hasattr(self, "_window") and self._window:
            return self._window.isMaximized()
        return False

    # -------- Overlay window (live preview — NOT persisted) --------
    # These slots only update runtime state. Persistence happens via
    # saveSettings (the Save button) so Cancel can revert without disk writes.

    def set_overlay(self, overlay):
        self._overlay = overlay

    @Slot(bool)
    def setOverlayVisible(self, visible):
        if hasattr(self, "_overlay") and self._overlay:
            if visible:
                self._overlay.show()
                self._overlay.raise_()
            else:
                self._overlay.hide()

    @Slot(str)
    def setOverlayMode(self, mode):
        if hasattr(self, "_overlay") and self._overlay:
            self._overlay.set_mode(mode)

    @Slot(bool)
    def setOverlayAdvanced(self, advanced):
        # Back-compat path
        if hasattr(self, "_overlay") and self._overlay:
            self._overlay.set_advanced(bool(advanced))

    @Slot(str)
    def setOverlayLayout(self, layout_json):
        """Apply a custom layout (list of {type, visible})."""
        if not (hasattr(self, "_overlay") and self._overlay):
            return
        try:
            layout = json.loads(layout_json)
            self._overlay.set_custom_layout(layout)
        except Exception:
            pass

    @Slot(int)
    def setOverlayOpacity(self, pct):
        if hasattr(self, "_overlay") and self._overlay:
            self._overlay.set_opacity_pct(int(pct))

    @Slot(bool)
    def setOverlayLocked(self, locked):
        if hasattr(self, "_overlay") and self._overlay:
            self._overlay.set_locked(bool(locked))

    @Slot(float)
    def setOverlayStopwatch(self, ms):
        """v3.1.2 — Mirror the web UI session stopwatch onto the floating
        overlay. -1 hides it (capture stopped)."""
        if hasattr(self, "_overlay") and self._overlay:
            try:
                self._overlay.set_stopwatch(int(ms))
            except Exception:
                pass

    @Slot(str, str)
    def showScreenNotification(self, message, kind):
        """v3.1.2 — Show a screen-level toast at the top-right of the screen
        (independent of the app window). Used for can't-start warnings."""
        try:
            if not hasattr(self, "_screen_notif") or self._screen_notif is None:
                self._screen_notif = ScreenNotification()
            self._screen_notif.show_message(message, kind or 'error')
        except Exception:
            pass

    @Slot(bool)
    def setScreenBorderEnabled(self, enabled):
        # Hide immediately if disabled (live preview)
        if not enabled and hasattr(self, "_screen_border") and self._screen_border:
            self._screen_border.hide_now()

    @Slot(int)
    def setScreenBorderDuration(self, ms):
        if hasattr(self, "_screen_border") and self._screen_border:
            self._screen_border.set_show_duration_ms(int(ms))

    @Slot(int)
    def setScreenBorderFeather(self, px):
        if hasattr(self, "_screen_border") and self._screen_border:
            self._screen_border.set_feather(int(px))

    @Slot()
    def previewScreenBorderRunning(self):
        """Trigger green border for preview (used by Apply preview button)."""
        if hasattr(self, "_screen_border") and self._screen_border:
            self._screen_border.show_running()

    @Slot()
    def previewScreenBorderStopped(self):
        if hasattr(self, "_screen_border") and self._screen_border:
            self._screen_border.show_stopped()

    def set_screen_border(self, sb):
        self._screen_border = sb

    @Slot(bool)
    def setMainAlwaysOnTop(self, on):
        """Toggle always-on-top on the main window. Live."""
        if hasattr(self, "_window") and self._window:
            flags = self._window.windowFlags()
            if on:
                flags |= Qt.WindowStaysOnTopHint
            else:
                flags &= ~Qt.WindowStaysOnTopHint
            # setWindowFlags hides the window — re-show it
            was_visible = self._window.isVisible()
            self._window.setWindowFlags(flags)
            if was_visible:
                self._window.show()

    @Slot(int)
    def setStatsInterval(self, ms):
        ms = max(50, min(2000, int(ms)))
        self._stats_timer.setInterval(ms)

    @Slot(int)
    def setAppsRefreshInterval(self, ms):
        ms = max(500, min(30000, int(ms)))
        self._apps_timer.setInterval(ms)

    # -------- Settings I/O --------

    @Slot(result=str)
    def exportSettingsJson(self):
        """Return all settings as a JSON string (caller can save to file)."""
        try:
            return json.dumps(self.settings.data, indent=2)
        except Exception:
            return "{}"

    # ============================================================
    # PROFILES — full app-state snapshot (target apps, function
    # settings, presets, filter script). Persists as a .throttlr
    # JSON file the user can share or back up.
    # ============================================================

    @Slot(result=str)
    def getConfig(self):
        """Return the live function config as JSON, keyed identically to a
        profile's function_config (lag_on, throttle_kbps, etc.). The UI calls
        this to re-sync the function-mod controls after a profile import."""
        try:
            with self.controller.config_lock:
                cfg = self.controller.config
                func_cfg = {
                    "lag_on": cfg.lag_on, "lag_ms": cfg.lag_ms, "lag_jitter_ms": cfg.lag_jitter_ms,
                    "lag_in": cfg.lag_in, "lag_out": cfg.lag_out,
                    "drop_on": cfg.drop_on, "drop_pct": cfg.drop_pct,
                    "drop_in": cfg.drop_in, "drop_out": cfg.drop_out,
                    "throttle_on": cfg.throttle_on, "throttle_kbps": cfg.throttle_kbps,
                    "throttle_in": cfg.throttle_in, "throttle_out": cfg.throttle_out,
                    "freeze_on": cfg.freeze_on, "freeze_in": cfg.freeze_in, "freeze_out": cfg.freeze_out,
                    "block_on": cfg.block_on, "block_in": cfg.block_in, "block_out": cfg.block_out,
                    "fun_on": cfg.fun_on, "fun_in": cfg.fun_in, "fun_out": cfg.fun_out,
                    "fun_corruption_pct": getattr(cfg, 'fun_corruption_pct', 5),
                    "fun_reorder_pct": getattr(cfg, 'fun_reorder_pct', 3),
                    "fun_duplicate_pct": getattr(cfg, 'fun_duplicate_pct', 2),
                }
            return json.dumps(func_cfg)
        except Exception as e:
            return json.dumps({"error": f"{type(e).__name__}: {e}"})

    @Slot(result=str)
    def exportProfileJson(self):
        """Build a Profile JSON: target apps + current function config +
        custom presets + filter script. Returns indented JSON string."""
        try:
            with self.controller.config_lock:
                cfg = self.controller.config
                func_cfg = {
                    "lag_on": cfg.lag_on, "lag_ms": cfg.lag_ms, "lag_jitter_ms": cfg.lag_jitter_ms,
                    "lag_in": cfg.lag_in, "lag_out": cfg.lag_out,
                    "drop_on": cfg.drop_on, "drop_pct": cfg.drop_pct,
                    "drop_in": cfg.drop_in, "drop_out": cfg.drop_out,
                    "throttle_on": cfg.throttle_on, "throttle_kbps": cfg.throttle_kbps,
                    "throttle_in": cfg.throttle_in, "throttle_out": cfg.throttle_out,
                    "freeze_on": cfg.freeze_on, "freeze_in": cfg.freeze_in, "freeze_out": cfg.freeze_out,
                    "block_on": cfg.block_on, "block_in": cfg.block_in, "block_out": cfg.block_out,
                    "fun_on": cfg.fun_on, "fun_in": cfg.fun_in, "fun_out": cfg.fun_out,
                    "fun_corruption_pct": getattr(cfg, 'fun_corruption_pct', 5),
                    "fun_reorder_pct": getattr(cfg, 'fun_reorder_pct', 3),
                    "fun_duplicate_pct": getattr(cfg, 'fun_duplicate_pct', 2),
                }
                target_apps_data = list(self.settings.get('target_apps') or [])

            profile = {
                "throttlr_profile_version": 1,
                "throttlr_app_version":     __version__,
                "exported_at":              int(time.time()),
                "name":                     "Throttlr Profile",
                # The actual snapshot
                "target_apps":              target_apps_data,
                "function_config":          func_cfg,
                "custom_presets":           list(self.settings.get('user_quick_presets') or []),
                "filter_script":            self.settings.get('filter_script') or "",
                # Visual prefs (optional but nice for sharing complete vibes)
                "ui_design":                self.settings.get('ui_design'),
                "midnight_accent":          self.settings.get('midnight_accent'),
            }
            return json.dumps(profile, indent=2)
        except Exception as e:
            return json.dumps({"error": f"{type(e).__name__}: {e}"})

    @Slot(str, result=str)
    def importProfileJson(self, json_str):
        """Apply a Profile JSON. Returns JSON {ok, error, name}."""
        try:
            data = json.loads(json_str)
            if not isinstance(data, dict):
                return json.dumps({"ok": False, "error": "Not a valid profile (root must be a JSON object)."})

            # Reject obviously-wrong files
            if "function_config" not in data and "target_apps" not in data:
                return json.dumps({"ok": False, "error": "This doesn't look like a Throttlr profile — missing required fields."})

            # 1. Apply visual prefs first (before functions, so the UI re-renders correctly)
            if data.get("ui_design") in ("industrial", "midnight", "windows7", "optimised"):
                self.settings.set('ui_design', data["ui_design"])
            if data.get("midnight_accent"):
                self.settings.set('midnight_accent', data["midnight_accent"])

            # 2. Apply target apps
            if isinstance(data.get("target_apps"), list):
                self.settings.set('target_apps', data["target_apps"])

            # 3. Apply custom presets
            if isinstance(data.get("custom_presets"), list):
                self.settings.set('user_quick_presets', data["custom_presets"])

            # 4. Apply filter script
            if isinstance(data.get("filter_script"), str):
                self.settings.set('filter_script', data["filter_script"])

            # 5. Apply function config — push into the live controller config
            fc = data.get("function_config") or {}
            if isinstance(fc, dict):
                with self.controller.config_lock:
                    cfg = self.controller.config
                    for key, value in fc.items():
                        if hasattr(cfg, key):
                            try:
                                setattr(cfg, key, value)
                            except Exception:
                                pass
                # Tell the UI to re-read everything
                try:
                    self.statsChanged.emit(json.dumps({"_force_refresh": True}))
                except Exception:
                    pass

            return json.dumps({
                "ok": True,
                "error": "",
                "name": data.get("name", "Throttlr Profile"),
            })
        except json.JSONDecodeError as e:
            return json.dumps({"ok": False, "error": f"Not a valid JSON file: {e}"})
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(result=str)
    def saveProfileToFile(self):
        """Open a Save dialog, write profile JSON to chosen path. Returns
        JSON {ok, path, error}."""
        try:
            from PySide6.QtWidgets import QFileDialog
            default_name = f"throttlr-profile-{datetime.now().strftime('%Y-%m-%d')}.throttlr"
            path, _ = QFileDialog.getSaveFileName(
                None,
                "Export Throttlr Profile",
                default_name,
                "Throttlr Profile (*.throttlr);;JSON (*.json);;All Files (*)"
            )
            if not path:
                return json.dumps({"ok": False, "cancelled": True, "error": ""})
            profile_json = self.exportProfileJson()
            with open(path, "w", encoding="utf-8") as f:
                f.write(profile_json)
            return json.dumps({"ok": True, "path": path, "error": ""})
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(result=str)
    def loadProfileFromFile(self):
        """Open an Open dialog, read .throttlr file, apply it. Returns
        JSON {ok, path, name, error}."""
        try:
            from PySide6.QtWidgets import QFileDialog
            path, _ = QFileDialog.getOpenFileName(
                None,
                "Import Throttlr Profile",
                "",
                "Throttlr Profile (*.throttlr);;JSON (*.json);;All Files (*)"
            )
            if not path:
                return json.dumps({"ok": False, "cancelled": True, "error": ""})
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            apply_result = json.loads(self.importProfileJson(content))
            apply_result["path"] = path
            return json.dumps(apply_result)
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(str, result=str)
    def loadProfileFromPath(self, path):
        """Apply a .throttlr file from a given path (used for drag-drop).
        Returns JSON {ok, path, name, error}."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            apply_result = json.loads(self.importProfileJson(content))
            apply_result["path"] = path
            return json.dumps(apply_result)
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(str, result=bool)
    def importSettingsJson(self, json_str):
        """Apply settings from a JSON string. Returns success bool."""
        try:
            data = json.loads(json_str)
            if not isinstance(data, dict):
                return False
            for k, v in data.items():
                if k in DEFAULT_SETTINGS:
                    self.settings.set(k, v)
            self.settings.save()
            return True
        except Exception:
            return False

    @Slot(result=bool)
    def resetSettingsToDefaults(self):
        try:
            self.settings.data = dict(DEFAULT_SETTINGS)
            self.settings.save()
            return True
        except Exception:
            return False

    @Slot(result=bool)
    def isOverlayVisible(self):
        if hasattr(self, "_overlay") and self._overlay:
            return self._overlay.isVisible()
        return False

    @Slot(result=str)
    def getDiagnostics(self):
        """Snapshot of the current capture state — for the user to verify
        the app is wired up correctly. Returned as JSON for the JS side
        to format and show."""
        try:
            cfg = self.controller.config
            with self.controller.freeze_lock:
                fq = len(self.controller.freeze_queue)
            with self.controller.delay_lock:
                dq = len(self.controller.delay_queue)
            with self.controller.conn_lock:
                cmap_size = len(self.controller.conn_map)
            data = {
                "target_name": cfg.target_name or "",
                "target_pid_count": len(cfg.target_pids),
                "running": bool(self.controller.running),
                "flow_listener": bool(self.controller.flow_handle is not None),
                "conn_map_size": cmap_size,
                "lag_on": bool(cfg.lag_on),  "lag_ms": int(cfg.lag_ms),
                "drop_on": bool(cfg.drop_on), "drop_chance": int(cfg.drop_chance),
                "throttle_on": bool(cfg.throttle_on), "throttle_kbps": int(cfg.throttle_kbps),
                "freeze_on": bool(cfg.freeze_on), "freeze_queue_len": fq,
                "block_on": bool(cfg.block_on),
                "fun_mode": bool(cfg.fun_mode),
                "delay_queue_len": dq,
                "packets_seen": int(cfg.packets_seen),
                "packets_dropped": int(cfg.packets_dropped),
                "packets_delayed": int(cfg.packets_delayed),
                "packets_held": int(cfg.packets_held),
            }
            return json.dumps(data)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # ============================================================
    # AUTOMATION RULES — Phase 3 (v2.6.0)
    # ============================================================

    @Slot(result=str)
    def getAutomationRules(self):
        """Return the rule list as JSON. Each rule:
        {id, name, enabled, condition: {type, ...}, action: {type, ...}}"""
        try:
            rules = self.settings.get("automation_rules", []) or []
            engine_on = bool(self.settings.get("automation_enabled", True))
            return json.dumps({
                "engine_enabled": engine_on,
                "rules": rules,
            })
        except Exception as e:
            return json.dumps({"engine_enabled": True, "rules": [], "error": str(e)})

    @Slot(str, result=str)
    def saveAutomationRule(self, json_str):
        """Insert or update one rule. If rule has an id matching an existing
        rule, replaces it. Otherwise appends. Returns {ok, rule_id, error}."""
        try:
            rule = json.loads(json_str) if json_str else None
            if not isinstance(rule, dict):
                return json.dumps({"ok": False, "error": "rule must be a JSON object"})
            # Required fields
            if not rule.get("name"):
                return json.dumps({"ok": False, "error": "rule needs a name"})
            if not isinstance(rule.get("condition"), dict):
                return json.dumps({"ok": False, "error": "rule needs a condition"})
            if not isinstance(rule.get("action"), dict):
                return json.dumps({"ok": False, "error": "rule needs an action"})
            # Generate id if missing
            if not rule.get("id"):
                rule["id"] = uuid.uuid4().hex[:12]
            rule.setdefault("enabled", True)

            existing = list(self.settings.get("automation_rules", []) or [])
            replaced = False
            for i, r in enumerate(existing):
                if r.get("id") == rule["id"]:
                    existing[i] = rule
                    replaced = True
                    break
            if not replaced:
                existing.append(rule)
            # Cap to 50 rules to keep settings.json sane
            existing = existing[:50]
            self.settings.set("automation_rules", existing)
            self.settings.save()
            return json.dumps({"ok": True, "rule_id": rule["id"]})
        except Exception as e:
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(str, result=bool)
    def deleteAutomationRule(self, rule_id):
        """Remove the rule with the given id. Returns True on success."""
        try:
            if not rule_id:
                return False
            existing = list(self.settings.get("automation_rules", []) or [])
            new_list = [r for r in existing if r.get("id") != rule_id]
            if len(new_list) == len(existing):
                return False  # not found
            self.settings.set("automation_rules", new_list)
            self.settings.save()
            # Drop any cached state for the deleted rule
            try:
                if hasattr(self, "_automation") and self._automation:
                    self._automation._rule_state.pop(rule_id, None)
            except Exception:
                pass
            return True
        except Exception:
            return False

    @Slot(str, bool, result=bool)
    def setAutomationRuleEnabled(self, rule_id, on):
        """Toggle a single rule's enabled state."""
        try:
            existing = list(self.settings.get("automation_rules", []) or [])
            changed = False
            for r in existing:
                if r.get("id") == rule_id:
                    r["enabled"] = bool(on)
                    changed = True
                    break
            if not changed:
                return False
            self.settings.set("automation_rules", existing)
            self.settings.save()
            # If we just disabled a rule, reset its cached active state so it
            # doesn't immediately re-fire when re-enabled
            try:
                if hasattr(self, "_automation") and self._automation:
                    if not on:
                        self._automation._rule_state.pop(rule_id, None)
            except Exception:
                pass
            return True
        except Exception:
            return False

    @Slot(bool, result=bool)
    def setAutomationEngineEnabled(self, on):
        """Master switch for the whole automation engine."""
        try:
            self.settings.set("automation_enabled", bool(on))
            self.settings.save()
            return True
        except Exception:
            return False

    @Slot(str, result=str)
    def testAutomationCondition(self, json_str):
        """Evaluate a condition right now without saving the rule. Used by
        the rule editor for a 'Test condition' button. Returns {active, error}."""
        try:
            cond = json.loads(json_str) if json_str else {}
            if not isinstance(cond, dict):
                return json.dumps({"active": False, "error": "condition must be a JSON object"})
            if hasattr(self, "_automation") and self._automation:
                # Refresh proc cache for accurate app_running result
                self._automation._proc_cache = self._automation._snapshot_processes()
                active = bool(self._automation._check_condition(cond))
                return json.dumps({"active": active, "error": ""})
            return json.dumps({"active": False, "error": "automation engine not initialised"})
        except Exception as e:
            return json.dumps({"active": False, "error": f"{type(e).__name__}: {e}"})

    @Slot(result=str)
    def listRunningProcesses(self):
        """Return a sorted list of unique running process names — used by the
        rule editor to populate the 'app_running' condition's process picker."""
        try:
            names = set()
            for p in psutil.process_iter(['name']):
                try:
                    n = (p.info.get('name') or '').strip()
                    if n:
                        names.add(n)
                except Exception:
                    continue
            return json.dumps(sorted(names, key=lambda s: s.lower()))
        except Exception:
            return "[]"

    # ============================================================
    # LAN coordination — Phase 5 (v3.0.0)
    # ============================================================

    @Slot(result=str)
    def lanGetState(self):
        """Return current LAN state: enabled, my_name, peer list, pending pairings."""
        try:
            enabled = bool(self.settings.get("lan_sync_enabled", False))
            data = {
                "enabled":  enabled,
                "my_name":  self._lan._my_name if self._lan else "",
                "my_id":    self._lan._my_id if self._lan else "",
                "peers":    self._lan.list_peers() if (self._lan and enabled) else [],
                "pending":  self._lan.list_pending_pairings() if (self._lan and enabled) else [],
                "trusted":  self.settings.get("lan_trusted_peers", []) or [],
                "pairing_window_open": bool(self._lan and self._lan._pairing_outgoing) if enabled else False,
            }
            return json.dumps(data)
        except Exception as e:
            return json.dumps({"enabled": False, "error": str(e)})

    @Slot(bool, result=bool)
    def lanSetEnabled(self, on):
        """Master toggle for LAN sync. Starts/stops discovery threads."""
        try:
            self.settings.set("lan_sync_enabled", bool(on))
            self.settings.save()
            if not self._lan:
                return False
            if on:
                self._lan.start()
            else:
                self._lan.stop()
            return True
        except Exception:
            return False

    @Slot(str, result=bool)
    def lanSetDisplayName(self, name):
        try:
            n = (name or "").strip()[:48]
            self.settings.set("lan_display_name", n)
            self.settings.save()
            if self._lan:
                self._lan._my_name = n or self._lan._hostname()
            return True
        except Exception:
            return False

    @Slot(result=str)
    def lanOpenPairingWindow(self):
        """Open a 60s window for incoming pairing requests, return the 6-digit code."""
        try:
            if not self._lan:
                return json.dumps({"ok": False, "error": "LAN not initialised"})
            code = self._lan.open_pairing_window()
            return json.dumps({"ok": True, "code": code, "expires_s": LANCoordinator.PAIRING_WINDOW_S})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    @Slot()
    def lanClosePairingWindow(self):
        try:
            if self._lan:
                self._lan.close_pairing_window()
        except Exception:
            pass

    @Slot(str, str, result=str)
    def lanRequestPair(self, target_peer_id, code):
        """Initiate pairing with a discovered peer using a 6-digit code."""
        try:
            if not self._lan:
                return json.dumps({"ok": False, "error": "LAN not initialised"})
            ok, err = self._lan.request_pair(target_peer_id, code)
            return json.dumps({"ok": ok, "error": err})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    @Slot(str, result=bool)
    def lanAcceptPairing(self, peer_id):
        try:
            return bool(self._lan and self._lan.accept_pairing(peer_id))
        except Exception:
            return False

    @Slot(str, result=bool)
    def lanRejectPairing(self, peer_id):
        try:
            return bool(self._lan and self._lan.reject_pairing(peer_id))
        except Exception:
            return False

    @Slot(str, result=bool)
    def lanUnpair(self, peer_id):
        try:
            return bool(self._lan and self._lan.unpair(peer_id))
        except Exception:
            return False

    @Slot(str, str, str, result=str)
    def lanSendCommand(self, peer_id, method, params_json):
        """Send a command to a single paired peer. Returns {ok, result}."""
        try:
            if not self._lan:
                return json.dumps({"ok": False, "error": "LAN not initialised"})
            params = json.loads(params_json) if params_json else {}
            ok, result = self._lan.send_command(peer_id, method, params)
            return json.dumps({"ok": ok, "result": result})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    @Slot(str, str, result=str)
    def lanBroadcastCommand(self, method, params_json):
        """Send a command to ALL paired peers. Returns dict of peer_id → result."""
        try:
            if not self._lan:
                return json.dumps({"ok": False, "error": "LAN not initialised"})
            params = json.loads(params_json) if params_json else {}
            results = self._lan.broadcast_command(method, params)
            # Convert tuples to JSON-serializable dicts
            out = {}
            for pid, (ok, result) in results.items():
                out[pid] = {"ok": ok, "result": result}
            return json.dumps({"ok": True, "results": out})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    # ============================================================
    # Plugins — REMOVED in v3.0.7. Slots stripped along with the feature.
    # ============================================================


# ============================================================
# ============================================================
# Overlay window — small always-on-top status HUD
# ============================================================

class ScreenNotification(QWidget):
    """v3.1.2 — Screen-level toast notification.

    Appears at the TOP-RIGHT of the primary screen (not the app window),
    as a frameless always-on-top overlay, then fades out. Used for
    can't-start warnings and similar alerts so they're visible even when
    the user is looking at a game / another window.

    A single instance is reused; calling show_message() again restarts
    the timer with the new text. Stacking isn't needed for the simple
    one-at-a-time warnings this is used for.
    """

    MARGIN = 18          # gap from screen edges
    HOLD_MS = 3200       # how long to stay fully visible

    def __init__(self):
        super().__init__()
        self.setWindowFlags(
            Qt.Window
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
            | Qt.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)

        self._kind = 'error'
        self._label = QLabel("", self)
        self._label.setWordWrap(True)
        self._label.setTextFormat(Qt.PlainText)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 13, 16, 13)
        lay.addWidget(self._label)

        self._fade = QPropertyAnimation(self, b"windowOpacity", self)
        self._fade.setEasingCurve(QEasingCurve.OutCubic)
        self._hold = QTimer(self)
        self._hold.setSingleShot(True)
        self._hold.timeout.connect(self._begin_fade_out)

        self.setFixedWidth(330)
        self._apply_style('error')

    def _apply_style(self, kind):
        # Accent + colors per kind. Error = red, success = green, info = amber.
        accents = {
            'error':   ('#c41e3a', '#ff6b81', 'rgba(28,10,12,0.97)'),
            'success': ('#2dffa6', '#9affd6', 'rgba(10,24,18,0.97)'),
            'info':    ('#ffb800', '#ffd97a', 'rgba(26,20,8,0.97)'),
        }
        border, text, bg = accents.get(kind, accents['error'])
        self.setStyleSheet(f"""
            QWidget {{
                background: {bg};
                border: 1px solid {border};
                border-left: 4px solid {border};
                border-radius: 8px;
            }}
            QLabel {{
                color: {text};
                background: transparent;
                border: none;
                font-family: 'Segoe UI', 'Inter', sans-serif;
                font-size: 13px;
                font-weight: 600;
            }}
        """)

    def show_message(self, message, kind='error'):
        self._apply_style(kind)
        self._label.setText(str(message or ""))
        self.adjustSize()

        # Position at the top-right of the primary screen's available area
        screen = QGuiApplication.primaryScreen()
        if screen:
            geo = screen.availableGeometry()
            x = geo.right() - self.width() - self.MARGIN
            y = geo.top() + self.MARGIN
            self.move(x, y)

        # Restart any in-flight animation/timer cleanly
        self._fade.stop()
        self._hold.stop()
        self.setWindowOpacity(0.0)
        self.show()
        self.raise_()

        self._fade.setDuration(240)
        self._fade.setStartValue(0.0)
        self._fade.setEndValue(1.0)
        try:
            self._fade.finished.disconnect()
        except Exception:
            pass
        self._fade.start()
        self._hold.start(self.HOLD_MS)

    def _begin_fade_out(self):
        self._fade.stop()
        self._fade.setDuration(420)
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(0.0)
        try:
            self._fade.finished.disconnect()
        except Exception:
            pass
        self._fade.finished.connect(self.hide)
        self._fade.start()


class OverlayWindow(QWidget):
    """Floating, always-on-top status display.

    Layout-driven: an ordered list of rows each rendering a piece of state.
    Built-in presets (compact / advanced) map to specific layouts; users can
    also define custom layouts via the settings UI.
    """

    DEFAULT_WIDTH = 340
    MIN_HEIGHT = 80
    TAPE_H = 8
    PAD_TOP = 12
    PAD_BOTTOM = 10

    # Row types and their heights (in painted pixels, not including spacing)
    ROW_HEIGHT = {
        'status_row':      32,
        'status_row_kbps': 32,   # status row with KB/s on the right
        'app_row':         22,
        'stats3':          38,
        'stats4':          38,
        'kbps_row':        20,
        'volume_row':      18,
        'funcs_row':       22,
    }
    ROW_GAP = 6

    LAYOUT_COMPACT = [
        {'type': 'status_row', 'visible': True},
        {'type': 'app_row',    'visible': True},
        {'type': 'stats3',     'visible': True},
    ]
    LAYOUT_ADVANCED = [
        {'type': 'status_row_kbps', 'visible': True},
        {'type': 'app_row',         'visible': True},
        {'type': 'stats4',          'visible': True},
        {'type': 'volume_row',      'visible': True},
        {'type': 'funcs_row',       'visible': True},
    ]

    # ============================================================
    # Theme palette — Phase 5.1 (v3.0.2)
    # ============================================================
    # The overlay was previously hardcoded with industrial colors. Now it
    # mirrors the main app's theme. Each "role" maps to a concrete color
    # that depends on (ui_design, midnight_accent) settings. The palette is
    # rebuilt whenever the theme changes via refresh_theme().
    #
    # Status colors (drop=red, running=green, replay=cyan) stay CONSTANT
    # across themes — they have semantic meaning (red = bad, green = good)
    # and themeing them would actually hurt usability.

    # Industrial palette (default, hazard yellow + warm grey)
    # chrome_style: 'industrial' = sharp 1px border + zigzag hazard tape
    _INDUSTRIAL_PALETTE = {
        'chrome_style':    'industrial',
        'bg':              "#07090a",
        'bg_streamsafe':   "#020304",
        'bg_top':          None,             # only used by gradient styles
        'accent':          "#ffb800",
        'accent_dim':      "#aa7a00",
        'border_idle':     "#1d1e18",
        'tape_a':          "#ffb800",
        'tape_b':          "#000000",
        'text':            "#e8e6d8",
        'text_dim':        "#5a5e5a",
        'text_dim2':       "#aaa6a0",
        # Status colors (don't theme — semantic meaning)
        'status_running':  "#7fff6a",
        'status_running_ring': "#3aa030",
        'status_replay':   "#66ddff",
        'status_drop':     "#c41e3a",
        'status_held':     "#66ddff",
        'status_fun':      "#7fff6a",
    }
    # Midnight palette — v3.0.3 redesigned to actually feel like the main app's
    # midnight theme: deep navy, no zigzag tape (replaced with a soft accent
    # bar that fades horizontally), softer text, subtle glow on the border.
    # chrome_style: 'midnight' = soft 2px glow border, gradient tape bar
    _MIDNIGHT_BASE = {
        'chrome_style':    'midnight',
        'bg':              "#0a0e1a",        # matches main app --bg
        'bg_streamsafe':   "#04060d",
        'bg_top':          "#11162a",        # subtle top→bottom panel gradient
        'accent_dim':      None,             # derived from accent at runtime
        'border_idle':     "#1f264a",        # main app --steel
        'tape_b':          None,             # no zigzag tape — see chrome_style
        'text':            "#e6ebf6",        # main app --bone
        'text_dim':        "#5a6a8a",
        'text_dim2':       "#a0b0d0",
        'status_running':  "#66e5b8",        # main app --term (mint)
        'status_running_ring': "#4ab590",    # main app --term-dim
        'status_replay':   "#7fbfff",
        'status_drop':     "#ff7b8a",        # main app --blood
        'status_held':     "#7fbfff",
        'status_fun':      "#a78bfa",
    }
    _MIDNIGHT_ACCENTS = {
        'aurora':  "#7fbfff",
        'sunset':  "#ff9e7a",
        'forest':  "#66e5b8",
        'amber':   "#ffc66e",
        'rose':    "#ff8ab2",
        'ocean':   "#5da9ff",
    }
    # Windows 7 palette — v3.0.3. The classic "Aero glass" look: light grey
    # background, cornflower blue accents, subtle gradients, rounded edges.
    # chrome_style: 'windows7' = glass-blue gradient bar + 1px subtle border
    _WINDOWS7_PALETTE = {
        'chrome_style':    'windows7',
        'bg':              "#eaf3fc",        # very pale frost-blue (Aero panel)
        'bg_streamsafe':   "#dde8f5",
        'bg_top':          "#ffffff",        # subtle white-to-frost-blue gradient
        'accent':          "#1a6cb6",        # Aero cornflower-deep
        'accent_dim':      "#3380bd",
        'border_idle':     "#9bb6d4",        # soft slate-blue
        'tape_a':          "#79b3eb",        # light Aero blue
        'tape_b':          "#3380bd",        # mid Aero blue (gradient stops)
        'text':            "#1c1c1c",        # dark grey on light bg
        'text_dim':        "#7a8a99",
        'text_dim2':       "#3a4a5c",
        # Status colors retained
        'status_running':  "#1f9c2f",        # Aero green (slightly darker for contrast on light bg)
        'status_running_ring': "#1f7c25",
        'status_replay':   "#2070b8",        # Aero blue
        'status_drop':     "#c52b2b",
        'status_held':     "#2070b8",
        'status_fun':      "#a040b8",
    }
    # Optimised palette — v3.0.4. Maximum performance: solid colors, no
    # gradients, no glow effects. Designed for low-end systems / older
    # hardware / users who want the most efficient render.
    # chrome_style: 'optimised' = solid 1px border, solid 2px accent line at top
    _OPTIMISED_PALETTE = {
        'chrome_style':    'optimised',
        'bg':              "#1e1e1e",        # neutral dark grey
        'bg_streamsafe':   "#0c0c0c",
        'bg_top':          None,             # no gradient
        'accent':          "#4ec9b0",        # VS Code-ish teal — readable, doesn't flicker
        'accent_dim':      "#3a8c7c",
        'border_idle':     "#3c3c3c",
        'tape_a':          "#4ec9b0",
        'tape_b':          None,             # no zigzag — chrome paints solid line
        'text':            "#d4d4d4",
        'text_dim':        "#808080",
        'text_dim2':       "#a0a0a0",
        'status_running':  "#4ec94e",
        'status_running_ring': "#3a8c3a",
        'status_replay':   "#4ec9c9",
        'status_drop':     "#f44747",
        'status_held':     "#4ec9c9",
        'status_fun':      "#c586c0",
    }

    # ============================================================
    # Custom theme palettes — v3.0.6 (theme overlay parity)
    # ============================================================
    # When a user activates a custom theme (Liquid Glass, Frutiger Aero,
    # Cyberpunk, Terminal, Retro, etc.), the overlay should match its vibe
    # rather than fall through to Industrial. These palettes map each
    # built-in custom theme to its overlay colors. Custom themes the user
    # installs from the gallery that aren't listed here still fall back to
    # Industrial gracefully.

    # Liquid Glass — frosted dark with the customizable accent
    _CUSTOM_LIQUID_GLASS_PALETTE = {
        'chrome_style':    'midnight',          # soft glow border, gradient bar
        'bg':              "#0d1018",
        'bg_streamsafe':   "#05070c",
        'bg_top':          "#161a26",
        'accent':          "#7fbfff",            # sky blue default
        'accent_dim':      "#3f6fa0",
        'border_idle':     "#2a3148",
        'tape_a':          "#7fbfff",
        'tape_b':          None,
        'text':            "#f0f4ff",
        'text_dim':        "#6878a0",
        'text_dim2':       "#a8b8d0",
        'status_running':  "#66e5b8",
        'status_running_ring': "#4ab590",
        'status_replay':   "#7fbfff",
        'status_drop':     "#ff7b8a",
        'status_held':     "#7fbfff",
        'status_fun':      "#a78bfa",
    }
    # Frutiger Aero — light sky/glass with cyan accent
    _CUSTOM_FRUTIGER_AERO_PALETTE = {
        'chrome_style':    'windows7',           # the Aero glass paint style fits perfectly
        'bg':              "#dff0fa",
        'bg_streamsafe':   "#cfe5f3",
        'bg_top':          "#ffffff",
        'accent':          "#5fd5f5",            # default cyan from frutiger-aero.json
        'accent_dim':      "#3aa8c8",
        'border_idle':     "#9bc5d8",
        'tape_a':          "#9fffe5",            # aurora green
        'tape_b':          "#5fd5f5",            # accent cyan
        'text':            "#0a2030",
        'text_dim':        "#5a6e7a",
        'text_dim2':       "#1c4258",
        'status_running':  "#3aa080",
        'status_running_ring': "#2a8068",
        'status_replay':   "#3a8cb0",
        'status_drop':     "#c52b2b",
        'status_held':     "#3a8cb0",
        'status_fun':      "#9050b8",
    }
    # Cyberpunk — neon magenta/cyan on void
    _CUSTOM_CYBERPUNK_PALETTE = {
        'chrome_style':    'midnight',           # use soft glow bar for that neon feel
        'bg':              "#0a0014",
        'bg_streamsafe':   "#040008",
        'bg_top':          "#15001f",
        'accent':          "#ff0080",            # magenta default
        'accent_dim':      "#a30050",
        'border_idle':     "#3a0a28",
        'tape_a':          "#ff0080",
        'tape_b':          None,
        'text':            "#e6e6ff",
        'text_dim':        "#705a78",
        'text_dim2':       "#b0a0c0",
        'status_running':  "#aaff44",
        'status_running_ring': "#6dba2a",
        'status_replay':   "#00f5ff",
        'status_drop':     "#ff3344",
        'status_held':     "#00f5ff",
        'status_fun':      "#ff80c8",
    }
    # Terminal — phosphor green CRT
    _CUSTOM_TERMINAL_PALETTE = {
        'chrome_style':    'optimised',          # solid lines fit the CRT aesthetic
        'bg':              "#000000",
        'bg_streamsafe':   "#000000",
        'bg_top':          None,
        'accent':          "#00ff66",            # phosphor green default
        'accent_dim':      "#00803a",
        'border_idle':     "#003820",
        'tape_a':          "#00ff66",
        'tape_b':          None,
        'text':            "#00ff66",
        'text_dim':        "#008a3a",
        'text_dim2':       "#3aff8a",
        'status_running':  "#00ff66",
        'status_running_ring': "#008a3a",
        'status_replay':   "#aaffaa",
        'status_drop':     "#ff5050",
        'status_held':     "#aaffaa",
        'status_fun':      "#aaffaa",
    }
    # Retro Y2K — cream + coral pink + sky blue, kidcore aesthetic
    _CUSTOM_RETRO_PALETTE = {
        'chrome_style':    'optimised',          # solid borders fit the chunky Y2K look
        'bg':              "#fdf4ed",            # cream
        'bg_streamsafe':   "#ecd9c5",
        'bg_top':          None,
        'accent':          "#ff7a9c",            # coral pink default
        'accent_dim':      "#c44a6c",
        'border_idle':     "#1a0f1d",            # almost-black border
        'tape_a':          "#ff7a9c",
        'tape_b':          None,
        'text':            "#1a0f1d",            # near-black ink on cream
        'text_dim':        "#4a3340",
        'text_dim2':       "#2d1f2a",
        'status_running':  "#6dd9a0",
        'status_running_ring': "#3f9f70",
        'status_replay':   "#7fc8e8",
        'status_drop':     "#ff5a6e",
        'status_held':     "#7fc8e8",
        'status_fun':      "#ff7a9c",
    }
    # Lookup — id (from theme manifest) → palette dict
    _CUSTOM_THEME_PALETTES = {
        'liquid-glass':  _CUSTOM_LIQUID_GLASS_PALETTE,
        'frutiger-aero': _CUSTOM_FRUTIGER_AERO_PALETTE,
        'cyberpunk':     _CUSTOM_CYBERPUNK_PALETTE,
        'terminal':      _CUSTOM_TERMINAL_PALETTE,
        'retro':         _CUSTOM_RETRO_PALETTE,
    }
    # Per-custom-theme keys for picking up customized accent colors that
    # the user dialed in via the in-app theme customizer
    _CUSTOM_ACCENT_KEYS = {
        'liquid-glass':  'accent',     # theme.customizable key 'accent' → overlay accent
        'frutiger-aero': 'accent',
        'cyberpunk':     'neon-0',     # theme.customizable key 'neon' first stop
        'terminal':      'phosphor',
        'retro':         'pink',
    }

    def _build_palette(self) -> dict:
        """Read current theme settings and return the role → hex-color map."""
        # v3.0.6: custom theme takes precedence over ui_design when active.
        # The whole custom-theme branch is wrapped in try/except so a malformed
        # settings dict (e.g. theme_customizations gone weird) can NEVER abort
        # OverlayWindow.__init__ — that would kill the rest of MainWindow init,
        # including hotkey registration. Found this the hard way.
        try:
            custom_id = (self.settings.get('active_custom_theme') or '').strip().lower()
            if custom_id and custom_id in self._CUSTOM_THEME_PALETTES:
                pal = dict(self._CUSTOM_THEME_PALETTES[custom_id])
                # Pick up the user's customized accent if they've set one. The
                # main app stores theme_customizations[theme_id][key] = "#hex" for
                # color-type customizables, [hex, hex, ...] for gradients.
                customs = self.settings.get('theme_customizations') or {}
                if isinstance(customs, dict):
                    theme_customs = customs.get(custom_id) or {}
                    if isinstance(theme_customs, dict):
                        accent_key = self._CUSTOM_ACCENT_KEYS.get(custom_id)
                        if accent_key:
                            val = theme_customs.get(accent_key)
                            if isinstance(val, list) and val:
                                val = val[0]   # gradient first stop
                            # Some keys are gradient stops like 'neon-0' meaning gradient 'neon' first stop
                            elif accent_key.endswith(('-0', '-1', '-2', '-3')):
                                base, idx = accent_key.rsplit('-', 1)
                                grad = theme_customs.get(base)
                                if isinstance(grad, list) and len(grad) > int(idx):
                                    val = grad[int(idx)]
                            if isinstance(val, str) and val.startswith('#') and len(val) in (4, 7, 9):
                                pal['accent']     = val
                                pal['accent_dim'] = self._darken(val, 0.55)
                                pal['tape_a']     = val
                return pal
        except Exception:
            # Any malformed settings shape — fall through to design-based palette
            pass

        # Fall through to design-based palette
        ui_design = (self.settings.get('ui_design') or 'industrial').lower()
        if ui_design == 'midnight':
            accent_name = (self.settings.get('midnight_accent') or 'aurora').lower()
            custom = (self.settings.get('midnight_custom_color') or '').strip()
            # Custom overrides accent_name if provided + valid-looking
            if custom and custom.startswith('#') and len(custom) in (4, 7, 9):
                accent = custom
            else:
                accent = self._MIDNIGHT_ACCENTS.get(accent_name, self._MIDNIGHT_ACCENTS['aurora'])
            pal = dict(self._MIDNIGHT_BASE)
            pal['accent']     = accent
            pal['accent_dim'] = self._darken(accent, 0.55)
            pal['tape_a']     = accent
            return pal
        if ui_design == 'windows7':
            return dict(self._WINDOWS7_PALETTE)
        if ui_design == 'optimised':
            return dict(self._OPTIMISED_PALETTE)
        # Default to industrial
        return dict(self._INDUSTRIAL_PALETTE)

    def preview_theme(self, custom_id: str, customizations=None):
        """Apply a temporary palette WITHOUT reading from settings — used by
        the main app's settings UI to preview a theme before the user clicks
        Save. Pass `customizations` as a dict matching the same shape as
        settings['theme_customizations'][theme_id] (so {'accent': '#hex'} for
        color types, {'sunset': ['#hex', '#hex', '#hex']} for gradients)."""
        try:
            custom_id = (custom_id or '').strip().lower()
            if not custom_id or custom_id not in self._CUSTOM_THEME_PALETTES:
                # Asked to preview a theme we don't have a palette for —
                # rebuild from settings to restore baseline
                self._palette = self._build_palette()
                self.update()
                return
            pal = dict(self._CUSTOM_THEME_PALETTES[custom_id])
            if isinstance(customizations, dict):
                accent_key = self._CUSTOM_ACCENT_KEYS.get(custom_id)
                if accent_key:
                    val = customizations.get(accent_key)
                    if isinstance(val, list) and val:
                        val = val[0]
                    elif accent_key.endswith(('-0', '-1', '-2', '-3')):
                        base, idx = accent_key.rsplit('-', 1)
                        grad = customizations.get(base)
                        if isinstance(grad, list) and len(grad) > int(idx):
                            val = grad[int(idx)]
                    if isinstance(val, str) and val.startswith('#') and len(val) in (4, 7, 9):
                        pal['accent']     = val
                        pal['accent_dim'] = self._darken(val, 0.55)
                        pal['tape_a']     = val
            self._palette = pal
            self.update()
        except Exception:
            pass

    @staticmethod
    def _darken(hex_color: str, factor: float = 0.5) -> str:
        """Return a darker version of a #rrggbb hex color (factor 0..1, 0=black)."""
        try:
            h = hex_color.lstrip('#')
            if len(h) == 3:
                h = ''.join(c*2 for c in h)
            r = int(h[0:2], 16)
            g = int(h[2:4], 16)
            b = int(h[4:6], 16)
            r = max(0, min(255, int(r * factor)))
            g = max(0, min(255, int(g * factor)))
            b = max(0, min(255, int(b * factor)))
            return f"#{r:02x}{g:02x}{b:02x}"
        except Exception:
            return hex_color

    def _qc(self, role: str) -> 'QColor':
        """Look up a palette role and return a QColor."""
        return QColor(self._palette.get(role, '#ffffff'))

    def refresh_theme(self):
        """Rebuild palette + repaint. Called when the user changes theme
        in the main app — connected via signal in MainWindow."""
        try:
            self._palette = self._build_palette()
            self.update()
        except Exception:
            pass

    def __init__(self, settings: 'SettingsManager'):
        super().__init__()
        self.settings = settings
        # Build the theme palette from current settings — gets refreshed when
        # the user changes themes via refresh_theme()
        self._palette = self._build_palette()

        self.setWindowFlags(
            Qt.Window
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
        )
        self._opacity_pct = int(self.settings.get('overlay_opacity') or 95)
        self._locked = bool(self.settings.get('overlay_locked'))
        self._mode = self.settings.get('overlay_mode') or (
            'advanced' if self.settings.get('overlay_advanced') else 'compact'
        )
        self._custom_layout = self._load_layout()
        self._apply_size()
        self.setWindowTitle("Throttlr Overlay")
        self.setWindowOpacity(max(0.30, min(1.0, self._opacity_pct / 100.0)))

        x = int(self.settings.get('overlay_x') or 30)
        y = int(self.settings.get('overlay_y') or 30)
        self.move(x, y)

        self._drag_offset = None
        self._running = False
        self._replaying = False
        self._app_name = ""
        self._sent = 0
        self._dropped = 0
        self._delayed = 0
        self._held = 0
        self._bytes = 0
        self._kbps = 0.0
        self._stopwatch_ms = -1   # v3.1.2 — session elapsed time; -1 = hidden
        self._stopwatch_stopped = False  # v3.1.2 — frozen (red) when True
        self._funcs = {
            'lag': False, 'drop': False, 'throttle': False,
            'freeze': False, 'block': False, 'fun': False,
        }
        self._pulse = 0
        self._stream_safe = bool(settings.get('overlay_stream_safe'))

        self._pulse_timer = QTimer(self)
        self._pulse_timer.setInterval(80)
        self._pulse_timer.timeout.connect(self._on_pulse)

    # ---- layout helpers ----
    def _load_layout(self):
        """Load custom layout from settings, fallback to compact preset."""
        raw = self.settings.get('overlay_layout')
        if isinstance(raw, list) and raw:
            # Validate row types
            valid = []
            for row in raw:
                if isinstance(row, dict) and row.get('type') in self.ROW_HEIGHT:
                    valid.append({'type': row['type'],
                                  'visible': row.get('visible', True)})
            if valid:
                return valid
        return [dict(r) for r in self.LAYOUT_COMPACT]

    def _active_layout(self):
        """Return the layout actually being painted right now."""
        if self._mode == 'compact':   return self.LAYOUT_COMPACT
        if self._mode == 'advanced':  return self.LAYOUT_ADVANCED
        return self._custom_layout

    def _compute_height(self, layout):
        h = self.TAPE_H + self.PAD_TOP
        first = True
        for row in layout:
            if not row.get('visible', True): continue
            rh = self.ROW_HEIGHT.get(row.get('type'), 22)
            if not first:
                h += self.ROW_GAP
            h += rh
            first = False
        h += self.PAD_BOTTOM
        return max(self.MIN_HEIGHT, h)

    def _apply_size(self):
        layout = self._active_layout()
        h = self._compute_height(layout)
        self.setFixedSize(self.DEFAULT_WIDTH, h)

    # ---- public setters ----
    def set_mode(self, mode: str):
        """mode: 'compact' | 'advanced' | 'custom'"""
        if mode not in ('compact', 'advanced', 'custom'):
            mode = 'compact'
        if mode == self._mode:
            return
        self._mode = mode
        self._apply_size()
        self.update()

    # Backward-compat: set_advanced toggles between compact and advanced
    def set_advanced(self, advanced: bool):
        self.set_mode('advanced' if advanced else 'compact')

    def set_custom_layout(self, layout):
        """Apply a user-defined layout (list of {type, visible}) and switch
        to custom mode."""
        if isinstance(layout, list):
            valid = []
            for row in layout:
                if isinstance(row, dict) and row.get('type') in self.ROW_HEIGHT:
                    valid.append({'type': row['type'],
                                  'visible': bool(row.get('visible', True))})
            if valid:
                self._custom_layout = valid
                self._mode = 'custom'
                self._apply_size()
                self.update()

    def set_opacity_pct(self, pct: int):
        self._opacity_pct = max(30, min(100, int(pct)))
        self.setWindowOpacity(self._opacity_pct / 100.0)

    def set_locked(self, locked: bool):
        self._locked = bool(locked)

    # ---- pulse ----
    def _on_pulse(self):
        self._pulse = (self._pulse + 1) % 24
        self.update()

    # ---- state ----
    def set_stopwatch(self, ms):
        """v3.1.2 — Update the session stopwatch shown on the overlay.
        Encoding from the web UI's Stopwatch module:
          * ms >= 0        → running, show green at this elapsed time
          * ms == -1       → hide entirely (reset / app exit)
          * ms <= -2       → stopped/frozen; real time = -(ms) - 1, show RED
        """
        ms = int(ms)
        if ms == -1:
            self._stopwatch_ms = -1
            self._stopwatch_stopped = False
        elif ms <= -2:
            self._stopwatch_ms = (-ms) - 1
            self._stopwatch_stopped = True
        else:
            self._stopwatch_ms = ms
            self._stopwatch_stopped = False
        self.update()

    def _fmt_stopwatch(self):
        """Format self._stopwatch_ms as M:SS or H:MM:SS."""
        ms = self._stopwatch_ms
        if ms < 0:
            return ""
        total = ms // 1000
        h = total // 3600
        m = (total % 3600) // 60
        s = total % 60
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m:02d}:{s:02d}"

    def set_state(self, running, app_name, sent, dropped, delayed, held,
                  bytes_total=0, kbps=0.0, funcs=None, replaying=False):
        if running and not self._running:
            self._pulse_timer.start()
        elif not running and self._running:
            self._pulse_timer.stop()
        self._running = bool(running)
        self._replaying = bool(replaying)
        self._app_name = app_name or ""
        self._sent = int(sent or 0)
        self._dropped = int(dropped or 0)
        self._delayed = int(delayed or 0)
        self._held = int(held or 0)
        self._bytes = int(bytes_total or 0)
        self._kbps = float(kbps or 0.0)
        if funcs:
            for k in self._funcs:
                if k in funcs:
                    self._funcs[k] = bool(funcs[k])
        # Keep the pulse animation running while replaying so the user
        # has a visible "something is happening" cue even when freeze is
        # technically off.
        if self._replaying and not self._pulse_timer.isActive():
            self._pulse_timer.start()
        self.update()

    # ---- paint dispatcher ----
    def paintEvent(self, ev):
        layout = self._active_layout()
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        self._paint_chrome(p, w, h)

        y = self.TAPE_H + self.PAD_TOP - 8
        first = True
        for row in layout:
            if not row.get('visible', True):
                continue
            rt = row.get('type')
            if not first:
                y += self.ROW_GAP
            self._paint_row(p, rt, y, w)
            y += self.ROW_HEIGHT.get(rt, 22)
            first = False
        p.end()

    # ---- chrome ----
    def set_stream_safe(self, on: bool):
        """Toggle stream-safe rendering. When on, the overlay renders with a
        fully-opaque dark background and slightly bolder outlines so it
        captures cleanly through OBS/Discord screen-share without alpha
        compositing weirdness."""
        self._stream_safe = bool(on)
        # Force a full repaint
        self.update()

    def _paint_chrome(self, p, w, h):
        """Paint background, hazard tape, and outer border. Chrome style is
        chosen by the active palette: 'industrial' (zigzag tape + sharp border),
        'midnight' (gradient bar + soft glow border), 'windows7' (Aero glass
        gradient bar + frost-blue subtle border)."""
        style = self._palette.get('chrome_style', 'industrial')
        bg = self._qc('bg_streamsafe' if self._stream_safe else 'bg')

        # Background — solid for industrial, vertical gradient for midnight + win7
        bg_top_hex = self._palette.get('bg_top')
        if bg_top_hex and style in ('midnight', 'windows7'):
            grad = QLinearGradient(0, 0, 0, h)
            grad.setColorAt(0.0, QColor(bg_top_hex))
            grad.setColorAt(1.0, bg)
            p.fillRect(0, 0, w, h, QBrush(grad))
        else:
            p.fillRect(0, 0, w, h, bg)

        if style == 'industrial':
            self._paint_chrome_industrial(p, w, h)
        elif style == 'midnight':
            self._paint_chrome_midnight(p, w, h)
        elif style == 'windows7':
            self._paint_chrome_windows7(p, w, h)
        elif style == 'optimised':
            self._paint_chrome_optimised(p, w, h)
        else:
            self._paint_chrome_industrial(p, w, h)

    def _paint_chrome_industrial(self, p, w, h):
        """Original zigzag hazard-tape + sharp border."""
        seg = 12
        x = -16
        toggle = 0
        tape_a = self._qc('tape_a')
        tape_b = self._qc('tape_b')
        while x < w:
            color = tape_a if toggle == 0 else tape_b
            poly = QPolygon([
                QPoint(x, 0), QPoint(x + seg, 0),
                QPoint(x + seg + self.TAPE_H, self.TAPE_H),
                QPoint(x + self.TAPE_H, self.TAPE_H),
            ])
            p.setBrush(QBrush(color))
            p.setPen(Qt.NoPen)
            p.drawPolygon(poly)
            x += seg
            toggle = 1 - toggle
        # Sharp 1px border, accent when running
        border = self._qc('accent') if self._running else self._qc('border_idle')
        p.setPen(QPen(border, 2 if self._stream_safe else 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(0, 0, w - 1, h - 1)

    def _paint_chrome_midnight(self, p, w, h):
        """Soft accent bar (no zigzag) with subtle glow border. Feels closer
        to the main app's midnight aesthetic — smooth, no harsh edges."""
        accent = self._qc('accent')
        # Top bar: horizontal gradient that fades from transparent → accent →
        # transparent. Looks like a soft accent strip rather than hazard tape.
        bar_grad = QLinearGradient(0, 0, w, 0)
        transparent = QColor(accent)
        transparent.setAlpha(0)
        mid = QColor(accent)
        mid.setAlpha(220)
        bar_grad.setColorAt(0.0,  transparent)
        bar_grad.setColorAt(0.15, mid)
        bar_grad.setColorAt(0.85, mid)
        bar_grad.setColorAt(1.0,  transparent)
        p.setBrush(QBrush(bar_grad))
        p.setPen(Qt.NoPen)
        p.drawRect(0, 0, w, self.TAPE_H)

        # Outer border — soft 2px when running (gives a glow feel),
        # very subtle when idle
        if self._running:
            # Inner glow ring — semi-transparent accent
            glow = QColor(accent)
            glow.setAlpha(140)
            p.setPen(QPen(glow, 2))
        else:
            p.setPen(QPen(self._qc('border_idle'), 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(0, 0, w - 1, h - 1)

    def _paint_chrome_windows7(self, p, w, h):
        """Aero glass gradient bar across the top — light Aero blue fading
        into mid Aero blue. Subtle frost-blue 1px border. Distinctive Win7
        visual language."""
        light = self._qc('tape_a')
        deep  = self._qc('tape_b')
        # Top bar — vertical gradient (light → deep) with a thin highlight
        # at the very top to suggest the Aero glass shine
        bar_grad = QLinearGradient(0, 0, 0, self.TAPE_H + 4)
        bar_grad.setColorAt(0.0, QColor("#cfe2f5"))   # near-white frost top
        bar_grad.setColorAt(0.4, light)
        bar_grad.setColorAt(1.0, deep)
        p.setBrush(QBrush(bar_grad))
        p.setPen(Qt.NoPen)
        p.drawRect(0, 0, w, self.TAPE_H + 4)
        # Hairline highlight at the top edge (Aero glass top reflection)
        hl = QColor("#ffffff")
        hl.setAlpha(160)
        p.setPen(QPen(hl, 1))
        p.drawLine(0, 0, w, 0)

        # Subtle blue border — Aero windows had a thin frost-blue outline
        if self._running:
            p.setPen(QPen(self._qc('accent'), 1))
        else:
            p.setPen(QPen(self._qc('border_idle'), 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(0, 0, w - 1, h - 1)

    def _paint_chrome_optimised(self, p, w, h):
        """v3.0.4 — minimal/optimised chrome. Solid colors only, no
        gradients, no glow. Designed for low-end systems."""
        # Solid 2px accent line at the top instead of zigzag tape
        p.setBrush(QBrush(self._qc('tape_a')))
        p.setPen(Qt.NoPen)
        p.drawRect(0, 0, w, 2)
        # Plain 1px border, accent when running
        border = self._qc('accent') if self._running else self._qc('border_idle')
        p.setPen(QPen(border, 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(0, 0, w - 1, h - 1)

    # ---- row dispatcher ----
    def _paint_row(self, p, rt, y, w):
        if rt == 'status_row':
            self._row_status(p, y, w, with_kbps=False)
        elif rt == 'status_row_kbps':
            self._row_status(p, y, w, with_kbps=True)
        elif rt == 'app_row':
            self._row_app(p, y, w)
        elif rt == 'stats3':
            self._row_stats(p, y, w, [
                ("SENT", self._sent,    self._qc('text_dim2')),
                ("DROP", self._dropped, self._qc('status_drop')),
                ("HELD", self._held,    self._qc('status_held')),
            ])
        elif rt == 'stats4':
            self._row_stats(p, y, w, [
                ("SENT",  self._sent,    self._qc('text_dim2')),
                ("DROP",  self._dropped, self._qc('status_drop')),
                ("DELAY", self._delayed, self._qc('accent')),
                ("HELD",  self._held,    self._qc('status_held')),
            ])
        elif rt == 'kbps_row':
            self._row_kbps(p, y, w)
        elif rt == 'volume_row':
            self._row_volume(p, y, w)
        elif rt == 'funcs_row':
            self._row_funcs(p, y, w)

    # ---- individual rows (each takes care of its own internal layout
    #      relative to the y baseline passed in) ----
    def _row_status(self, p, y, w, with_kbps=False):
        """Status dot + RUNNING/STOPPED/REPLAYING label, optional KB/s on the right."""
        cy = y + 16
        # Replaying takes visual priority over running — same active capture
        # but the user is watching a held-queue drain back into the network.
        if self._replaying:
            # Cyan pulse — distinct from running's green (status colors don't
            # theme — semantic meaning takes priority over visual coherence)
            pulse_r = 12 + (self._pulse % 8)
            replay = self._qc('status_replay')
            glow = QColor(replay)
            glow.setAlpha(max(15, 90 - self._pulse * 3))
            p.setBrush(QBrush(glow)); p.setPen(Qt.NoPen)
            p.drawEllipse(QPoint(20, cy), pulse_r, pulse_r)
            p.setBrush(QBrush(replay))
            p.drawEllipse(QPoint(20, cy), 7, 7)
            label = f"REPLAY  {self._held:,}"
            label_color = replay
        elif self._running:
            pulse_r = 12 + (self._pulse % 8)
            run = self._qc('status_running')
            glow = QColor(run)
            glow.setAlpha(max(15, 90 - self._pulse * 3))
            p.setBrush(QBrush(glow))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPoint(20, cy), pulse_r, pulse_r)
            p.setBrush(QBrush(run))
            p.drawEllipse(QPoint(20, cy), 7, 7)
            label = "RUNNING"
            label_color = run
        else:
            ring_base = self._qc('status_running_ring')
            ring = QColor(ring_base)
            ring.setAlpha(70)
            p.setBrush(QBrush(ring)); p.setPen(Qt.NoPen)
            p.drawEllipse(QPoint(20, cy), 10, 10)
            p.setBrush(QBrush(ring_base))
            p.drawEllipse(QPoint(20, cy), 7, 7)
            label = "STOPPED"
            label_color = self._qc('text_dim2')

        f = QFont("Impact" if sys.platform == "win32" else "Arial", 12)
        f.setBold(True)
        p.setFont(f)
        p.setPen(label_color)
        p.drawText(QRect(40, y + 4, 240, 24),
                   Qt.AlignLeft | Qt.AlignVCenter, label)

        # Right side: stopwatch (when active/frozen) > KB/s > brand
        f2 = QFont("Consolas" if sys.platform == "win32" else "Courier New", 9)
        sw = self._fmt_stopwatch()
        if sw and (self._running or self._replaying or self._stopwatch_stopped):
            # v3.1.2 — session stopwatch. Green while running, red when
            # frozen on the stopped time.
            f2.setBold(True)
            p.setFont(f2)
            if self._stopwatch_stopped:
                p.setPen(self._qc('status_drop'))   # red = stopped/frozen
            else:
                p.setPen(self._qc('status_running')) # green = running
            p.drawText(QRect(0, y + 4, w - 14, 24),
                       Qt.AlignRight | Qt.AlignVCenter, f"\u23f1 {sw}")
        elif with_kbps:
            f2.setBold(True)
            p.setFont(f2)
            p.setPen(self._qc('accent'))
            p.drawText(QRect(0, y + 4, w - 14, 24),
                       Qt.AlignRight | Qt.AlignVCenter,
                       f"{self._kbps:.1f} KB/s")
        else:
            p.setFont(f2)
            p.setPen(self._qc('text_dim'))
            p.drawText(QRect(0, y + 4, w - 14, 24),
                       Qt.AlignRight | Qt.AlignVCenter, "throttlr")

    def _row_app(self, p, y, w):
        f = QFont("Consolas" if sys.platform == "win32" else "Courier New", 9)
        f.setBold(True)
        p.setFont(f)
        p.setPen(self._qc('accent'))
        text = self._app_name or "(no target)"
        if len(text) > 42:
            text = text[:39] + "..."
        p.drawText(QRect(14, y + 2, w - 28, 18),
                   Qt.AlignLeft | Qt.AlignVCenter, text)

    def _row_stats(self, p, y, w, cells):
        n = len(cells)
        x0 = 14
        total_w = w - 28
        cell_w = total_w // n
        for i, (lab, val, col) in enumerate(cells):
            cx = x0 + i * cell_w
            f = QFont("Consolas" if sys.platform == "win32" else "Courier New", 8)
            p.setFont(f)
            p.setPen(self._qc('text_dim'))
            p.drawText(QRect(cx, y, cell_w, 12), Qt.AlignLeft, lab)
            f2 = QFont("Impact" if sys.platform == "win32" else "Arial", 12)
            f2.setBold(True)
            p.setFont(f2)
            p.setPen(col)
            val_str = f"{val:,}"
            if len(val_str) > 9:
                val_str = f"{val/1000:.0f}K"
            p.drawText(QRect(cx, y + 12, cell_w, 22),
                       Qt.AlignLeft, val_str)

    def _row_kbps(self, p, y, w):
        f = QFont("Consolas" if sys.platform == "win32" else "Courier New", 9)
        f.setBold(True)
        p.setFont(f)
        p.setPen(self._qc('text_dim'))
        p.drawText(QRect(14, y, 60, 18), Qt.AlignLeft | Qt.AlignVCenter, "RATE")
        p.setPen(self._qc('accent'))
        p.drawText(QRect(50, y, w - 64, 18),
                   Qt.AlignLeft | Qt.AlignVCenter, f"{self._kbps:.1f} KB/s")

    def _row_volume(self, p, y, w):
        f = QFont("Consolas" if sys.platform == "win32" else "Courier New", 8)
        p.setFont(f)
        p.setPen(self._qc('text_dim'))
        kb = self._bytes / 1024.0
        if kb < 1024:
            text = f"VOL  {kb:,.1f} KB"
        else:
            text = f"VOL  {kb/1024:,.2f} MB"
        p.drawText(QRect(14, y, w - 28, 18), Qt.AlignLeft, text)

    def _row_funcs(self, p, y, w):
        # Function chips — use accent for "neutral" funcs (lag/throttle) so
        # they tint with the active theme. drop/block stay red, freeze stays
        # cyan, fun stays green — those are semantic.
        accent = self._qc('accent')
        drop_c = self._qc('status_drop')
        held_c = self._qc('status_held')
        fun_c  = self._qc('status_fun')
        chips = [
            ('lag',      'LAG',   accent),
            ('drop',     'DROP',  drop_c),
            ('throttle', 'THROT', accent),
            ('freeze',   'FRZ',   held_c),
            ('block',    'BLOCK', drop_c),
            ('fun',      'FUN',   fun_c),
        ]
        chip_h = 16
        f = QFont("Consolas" if sys.platform == "win32" else "Courier New", 7)
        f.setBold(True)
        p.setFont(f)
        cell_w = (w - 28 - 5 * 4) // 6
        for i, (key, lab, col) in enumerate(chips):
            x = 14 + i * (cell_w + 4)
            active = self._funcs.get(key, False)
            if active:
                p.setBrush(QBrush(col))
                p.setPen(QPen(col, 1))
                p.drawRect(x, y, cell_w, chip_h)
                # Black text on most, white on the red chips for contrast
                p.setPen(QColor("#000000")
                         if col != drop_c
                         else QColor("#ffffff"))
            else:
                p.setBrush(Qt.NoBrush)
                p.setPen(QPen(self._qc('border_idle'), 1))
                p.drawRect(x, y, cell_w, chip_h)
                p.setPen(self._qc('text_dim'))
            p.drawText(QRect(x, y, cell_w, chip_h), Qt.AlignCenter, lab)

    # ---- drag (skip when locked) ----
    def mousePressEvent(self, e):
        if self._locked:
            return
        if e.button() == Qt.LeftButton:
            self._drag_offset = e.globalPosition().toPoint() - self.pos()
            e.accept()

    def mouseMoveEvent(self, e):
        if self._locked or self._drag_offset is None:
            return
        self.move(e.globalPosition().toPoint() - self._drag_offset)
        e.accept()

    def mouseReleaseEvent(self, e):
        if self._drag_offset is not None:
            self._drag_offset = None
            self.settings.set('overlay_x', self.x())
            self.settings.set('overlay_y', self.y())
            self.settings.save()
            e.accept()

    def contextMenuEvent(self, e):
        menu = QMenu(self)
        hide_act = menu.addAction("Hide overlay")
        modes_menu = menu.addMenu("Mode")
        compact_act = modes_menu.addAction("Compact")
        advanced_act = modes_menu.addAction("Advanced")
        custom_act = modes_menu.addAction("Custom")
        compact_act.setCheckable(True); compact_act.setChecked(self._mode == 'compact')
        advanced_act.setCheckable(True); advanced_act.setChecked(self._mode == 'advanced')
        custom_act.setCheckable(True);   custom_act.setChecked(self._mode == 'custom')
        toggle_lock = menu.addAction(
            "Unlock position" if self._locked else "Lock position"
        )
        action = menu.exec(e.globalPos())
        if action == hide_act:
            self.hide()
            self.settings.set('show_overlay', False)
            self.settings.save()
        elif action == compact_act:
            self.set_mode('compact')
            self.settings.set('overlay_mode', 'compact')
            self.settings.save()
        elif action == advanced_act:
            self.set_mode('advanced')
            self.settings.set('overlay_mode', 'advanced')
            self.settings.save()
        elif action == custom_act:
            self.set_mode('custom')
            self.settings.set('overlay_mode', 'custom')
            self.settings.save()
        elif action == toggle_lock:
            self.set_locked(not self._locked)
            self.settings.set('overlay_locked', self._locked)
            self.settings.save()


# ============================================================
# Screen-edge border indicator
# ============================================================

class ScreenBorderOverlay(QWidget):
    """Fullscreen click-through transparent window that paints a colored
    gradient frame around the primary monitor's edges.

    Uses CompositionMode_Lighten with four full-screen edge gradients so the
    final alpha at each pixel equals the maximum of the four 'closeness to
    edge' values — i.e. 1 minus the normalized distance to the nearest
    screen edge. This guarantees no seams or hard cut-off lines anywhere.
    """

    def __init__(self, settings: 'SettingsManager' = None):
        super().__init__()
        self.settings = settings
        self.setWindowFlags(
            Qt.Window
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
            | Qt.WindowTransparentForInput   # click-through
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)

        screen = QGuiApplication.primaryScreen()
        if screen:
            self.setGeometry(screen.geometry())

        self._color = QColor("#7fff6a")
        self._opacity = 0.0
        self._target_opacity = 0.0

        # Read defaults from settings if available — so the saved values
        # actually take effect on launch, not just when the slider moves.
        if settings:
            self._show_duration_ms = int(settings.get('screen_border_duration_ms') or 2000)
            self._feather = int(settings.get('screen_border_feather') or 90)
        else:
            self._show_duration_ms = 2000
            self._feather = 90

        self._anim = QTimer(self)
        self._anim.setInterval(16)
        self._anim.timeout.connect(self._tick)

    # ---- configuration ----
    def set_show_duration_ms(self, ms: int):
        self._show_duration_ms = max(0, int(ms))

    def set_feather(self, px: int):
        self._feather = max(20, min(400, int(px)))
        self.update()

    # ---- show with auto fade-out ----
    def show_running(self):
        self._show_with_color(QColor("#7fff6a"))

    def show_stopped(self):
        self._show_with_color(QColor("#c41e3a"))

    def _show_with_color(self, color):
        self._color = color
        self._target_opacity = 0.85
        self.show()
        self.raise_()
        # IMPORTANT: always (re-)start the timer here. It may have stopped
        # itself earlier when a previous fade reached its target.
        self._anim.start()
        if self._show_duration_ms > 0:
            QTimer.singleShot(self._show_duration_ms, self._begin_fadeout)

    def hide_now(self):
        self._target_opacity = 0.0
        self._anim.start()

    def _begin_fadeout(self):
        self._target_opacity = 0.0
        # Restart the timer — without this the fade never happens because
        # the timer auto-stopped when fade-in completed.
        self._anim.start()

    def _tick(self):
        diff = self._target_opacity - self._opacity
        if abs(diff) < 0.01:
            self._opacity = self._target_opacity
            self.update()
            self._anim.stop()
            if self._opacity <= 0.001:
                self.hide()
            return
        # Smooth easing toward target
        self._opacity += diff * 0.12
        self.update()

    # ---- paint: 4 full-screen edge gradients combined with Lighten ----
    def paintEvent(self, ev):
        if self._opacity <= 0.001:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        f = self._feather

        c = QColor(self._color)
        c.setAlphaF(self._opacity)
        zero = QColor(c.red(), c.green(), c.blue(), 0)

        # Each edge gradient is painted over the entire screen but only
        # produces non-zero alpha within `f` pixels of its edge. Subsequent
        # gradients use CompositionMode_Lighten so the final pixel takes the
        # MAX of the four overlapping alphas — equivalent to "1 minus the
        # normalized distance to the nearest edge", which is smooth
        # everywhere and has no seams at corners.

        # First edge — paints over transparent canvas with default SourceOver
        g = QLinearGradient(0, 0, 0, f)            # top
        g.setColorAt(0, c); g.setColorAt(1, zero)
        p.fillRect(0, 0, w, h, QBrush(g))

        # Switch to Lighten so the remaining gradients blend by max-channel
        p.setCompositionMode(QPainter.CompositionMode_Lighten)

        g = QLinearGradient(0, h, 0, h - f)        # bottom
        g.setColorAt(0, c); g.setColorAt(1, zero)
        p.fillRect(0, 0, w, h, QBrush(g))

        g = QLinearGradient(0, 0, f, 0)            # left
        g.setColorAt(0, c); g.setColorAt(1, zero)
        p.fillRect(0, 0, w, h, QBrush(g))

        g = QLinearGradient(w, 0, w - f, 0)        # right
        g.setColorAt(0, c); g.setColorAt(1, zero)
        p.fillRect(0, 0, w, h, QBrush(g))

        p.end()


# ============================================================
# v3.1.0 — System tray icon with quick-action context menu
# ============================================================

class ThrottlrTrayIcon(QSystemTrayIcon):
    """Adds a system tray icon with a right-click menu that exposes
    quick toggles without opening the main window. Items reflect current
    state and stay in sync via update_state().

    Why not auto-hide-to-tray on close? Throttlr is a tool — users expect
    closing the window to quit. The tray is purely a quick-access
    convenience, not a window-state hider."""

    def __init__(self, main_window, controller, parent=None):
        super().__init__(parent)
        self.main_window = main_window
        self.controller  = controller
        self.setToolTip("Throttlr — per-app network throttler")

        # Use the same icon the main app uses
        try:
            icon_path = _resource_path("throttlr.ico")
            if os.path.exists(icon_path):
                self.setIcon(QIcon(icon_path))
            else:
                # Generate a minimal yellow square fallback so the tray
                # shows *something* — better than an invisible icon.
                pm = QPixmap(32, 32)
                pm.fill(QColor(255, 184, 0))
                self.setIcon(QIcon(pm))
        except Exception:
            pass

        # Build menu
        self.menu = QMenu()
        self.act_show     = QAction("Show Throttlr", self.menu)
        self.act_separator0 = self.menu.addSeparator()
        self.act_startstop = QAction("Start capture", self.menu)
        self.act_freeze    = QAction("Toggle Freeze", self.menu)
        self.act_block     = QAction("Toggle Block",  self.menu)
        self.act_fun       = QAction("Toggle Fun mode", self.menu)
        self.act_separator1 = self.menu.addSeparator()
        self.act_quit      = QAction("Quit Throttlr", self.menu)

        self.menu.insertAction(self.act_separator0, self.act_show)
        self.menu.insertAction(self.act_separator1, self.act_startstop)
        self.menu.insertAction(self.act_separator1, self.act_freeze)
        self.menu.insertAction(self.act_separator1, self.act_block)
        self.menu.insertAction(self.act_separator1, self.act_fun)
        self.menu.addAction(self.act_quit)

        self.setContextMenu(self.menu)

        # Wiring — direct controller calls. Updates flow back through the
        # normal config-push path so the JS UI stays in sync.
        self.act_show.triggered.connect(self._show_window)
        self.act_startstop.triggered.connect(self._toggle_engine)
        self.act_freeze.triggered.connect(self._toggle_freeze)
        self.act_block.triggered.connect(self._toggle_block)
        self.act_fun.triggered.connect(self._toggle_fun)
        self.act_quit.triggered.connect(QApplication.instance().quit)

        # Single-click on the tray icon raises the main window (Windows
        # convention — left-click shows, right-click menus).
        self.activated.connect(self._on_activated)

    def _on_activated(self, reason):
        if reason == QSystemTrayIcon.Trigger:
            self._show_window()

    def _show_window(self):
        if self.main_window is None:
            return
        self.main_window.showNormal()
        self.main_window.raise_()
        self.main_window.activateWindow()

    def _toggle_engine(self):
        if self.controller.running:
            threading.Thread(target=self.controller.stop, daemon=True).start()
        else:
            self.controller.start()
        self.update_state()

    def _toggle_freeze(self):
        with self.controller.config_lock:
            self.controller.config.freeze_on = not self.controller.config.freeze_on
        self.update_state()

    def _toggle_block(self):
        with self.controller.config_lock:
            self.controller.config.block_on = not self.controller.config.block_on
        self.update_state()

    def _toggle_fun(self):
        with self.controller.config_lock:
            self.controller.config.fun_mode = not self.controller.config.fun_mode
        self.update_state()

    def update_state(self):
        """Refresh menu item labels to reflect current state. Should be
        called periodically (every ~1s) from the main window."""
        try:
            self.act_startstop.setText("Stop capture" if self.controller.running else "Start capture")
            cfg = self.controller.config
            self.act_freeze.setText(f"Freeze: {'ON' if cfg.freeze_on else 'off'}")
            self.act_block.setText( f"Block:  {'ON' if cfg.block_on  else 'off'}")
            self.act_fun.setText(   f"Fun mode: {'ON' if cfg.fun_mode else 'off'}")
            self.setToolTip(
                f"Throttlr — {'running' if self.controller.running else 'idle'}"
            )
        except Exception:
            pass


# ============================================================
# Main window — embedded webview
# ============================================================

class MainWindow(QMainWindow):
    """Hosts the QWebEngineView. UI runs as HTML/CSS/JS inside."""

    def __init__(self, controller: NetworkController, settings: SettingsManager):
        super().__init__()
        self.controller = controller
        self.settings = settings

        self.setWindowTitle("Throttlr — by Billy's Matrix")
        # Frameless: HTML provides its own title bar + window controls
        self.setWindowFlags(Qt.Window | Qt.FramelessWindowHint)
        # Allow the window to be transparent at the corners if HTML wants
        # (we don't actually use it but this keeps options open)
        # self.setAttribute(Qt.WA_TranslucentBackground, True)

        w = int(self.settings.get("window_w") or 1100)
        h = int(self.settings.get("window_h") or 920)
        self.resize(w, h)

        self.view = QWebEngineView(self)
        self.setCentralWidget(self.view)

        s = self.view.settings()
        s.setAttribute(QWebEngineSettings.JavascriptEnabled, True)
        s.setAttribute(QWebEngineSettings.LocalStorageEnabled, True)
        s.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
        s.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)
        s.setAttribute(QWebEngineSettings.AllowRunningInsecureContent, True)
        s.setAttribute(QWebEngineSettings.ErrorPageEnabled, True)

        self.channel = QWebChannel(self.view.page())
        self.bridge = Bridge(controller, settings,
                             on_hotkey_rebind=self._rebind_hotkeys)
        # Give the bridge a reference to this window so it can do window-control ops
        self.bridge.set_window(self)

        # Create the floating overlay
        self.overlay = OverlayWindow(settings)
        self.bridge.set_overlay(self.overlay)
        if settings.get('show_overlay'):
            self.overlay.show()

        # Screen-edge border indicator
        self.screen_border = ScreenBorderOverlay(settings)
        self.screen_border.set_show_duration_ms(int(settings.get('screen_border_duration_ms') or 2000))
        self.screen_border.set_feather(int(settings.get('screen_border_feather') or 90))
        self.bridge.set_screen_border(self.screen_border)
        # Listen to controller running state to flash green/red on transitions
        self.controller.status_changed.connect(self._on_controller_status)

        # Apply main-window always-on-top if configured
        if settings.get('main_always_on_top'):
            self.setWindowFlag(Qt.WindowStaysOnTopHint, True)

        self.channel.registerObject("bridge", self.bridge)
        self.view.page().setWebChannel(self.channel)

        html_path = self._find_ui_path()
        if html_path is None:
            QMessageBox.critical(
                self, "Missing UI",
                "Could not find ui/index.html — UI files missing."
            )
            sys.exit(1)

        # Make sure qwebchannel.js exists next to index.html
        if not ensure_qwebchannel_js(html_path.parent):
            QMessageBox.warning(
                self, "QWebChannel missing",
                "Could not extract qwebchannel.js — the UI may not respond.\n"
                "Try reinstalling PySide6."
            )

        # v3.1.1 — Hook page lifecycle so the startup log captures it
        try:
            import builtins as _bi
            _slog = getattr(_bi, '_throttlr_startup_log', lambda m: None)
            _slog(f"[webview] about to load {html_path}")
            def _on_load_finished(ok):
                _slog(f"[webview] loadFinished ok={ok}")
            def _on_load_started():
                _slog("[webview] loadStarted")
            self.view.page().loadStarted.connect(_on_load_started)
            self.view.page().loadFinished.connect(_on_load_finished)
        except Exception as _e:
            pass

        self.view.load(QUrl.fromLocalFile(str(html_path)))

        self.hotkey_startstop = None
        # v3.1.1 — Attach RegisterHotKey manager to this window's HWND
        # BEFORE rebinding hotkeys. The manager needs a window handle to
        # receive WM_HOTKEY messages. winId() returns a PyCapsule on Qt6;
        # int() converts it to the raw HWND that Win32 expects.
        try:
            hwnd = int(self.winId())
            _get_rhk_manager().attach_to_window(hwnd)
            import builtins as _bi
            _slog = getattr(_bi, '_throttlr_startup_log', None)
            if _slog:
                _slog(f"[hotkeys-rhk] manager attached to HWND {hwnd}")
        except Exception as e:
            print(f"[hotkeys-rhk] failed to attach manager to window: {e}", file=sys.stderr)

        self.hotkey_freeze = None
        self.hotkey_block = None
        self.hotkey_fun = None
        self.hotkey_killswitch = None
        self._rebind_hotkeys()

        # v3.0.6 — app-level fallback hotkey handler. This runs alongside the
        # low-level Windows hook and catches keypresses whenever Throttlr has
        # focus. So even if the LL hook can't install (some AVs / EDR block
        # it, or the user runs in a sandboxed environment), F5/F8/F9/F10 still
        # work when Throttlr is the active window. Last-resort safety net.
        try:
            app = QApplication.instance()
            if app is not None:
                self._app_hotkey_filter = _AppLevelHotkeyFilter(self)
                app.installEventFilter(self._app_hotkey_filter)
                print("[hotkeys] App-level fallback handler installed (works when Throttlr has focus)",
                      file=sys.stderr)
        except Exception as e:
            print(f"[hotkeys] App-level fallback failed: {e}", file=sys.stderr)

    def _find_ui_path(self):
        candidates = [
            Path(__file__).parent / "ui" / "index.html",
            Path(getattr(sys, "_MEIPASS", "")) / "ui" / "index.html",
            Path.cwd() / "ui" / "index.html",
        ]
        for p in candidates:
            if p.exists():
                return p.resolve()
        return None

    def nativeEvent(self, eventType, message):
        """v3.1.1 — Catch WM_HOTKEY messages from RegisterHotKey and
        route them to the appropriate handler. WM_HOTKEY messages arrive
        with wParam = the hotkey ID we passed to RegisterHotKey, which
        the manager uses to look up the callback.

        eventType is a bytes object like b"windows_generic_MSG".
        message is a ctypes pointer to a Windows MSG struct."""
        try:
            if eventType == b"windows_generic_MSG" or eventType == "windows_generic_MSG":
                # MSG layout: HWND, UINT message, WPARAM, LPARAM, ...
                # The PySide6 message arg is a sip.voidptr; cast to MSG
                from ctypes import wintypes as _wt, cast as _cast, POINTER as _PTR
                msg_ptr = _cast(int(message), _PTR(_wt.MSG))
                msg_struct = msg_ptr.contents
                if msg_struct.message == 0x0312:  # WM_HOTKEY
                    hk_id = int(msg_struct.wParam)
                    _get_rhk_manager().dispatch_hotkey_id(hk_id)
                    return True, 0   # handled
        except Exception:
            pass
        return False, 0   # not handled — let Qt continue processing

    def _vk_for(self, key_name, default):
        return KEY_NAMES.get(key_name, default)

    def _rebind_hotkeys(self):
        # v3.0.4 — use new stop() API which routes through the shared LL hook
        # rather than poking the old per-thread _stop event that no longer exists.
        # v3.0.6 — wrapped each step in try/except so one failure can never
        # silently break all the others (was happening when settings had stale
        # data from older versions).
        for hk in [self.hotkey_startstop, self.hotkey_freeze,
                   self.hotkey_block, self.hotkey_fun,
                   self.hotkey_killswitch]:
            if hk is not None:
                try:
                    hk.stop()
                except Exception:
                    pass

        # v3.1.1 — Reset the failure list so we only surface NEW failures
        # from this rebind cycle, not stale ones from previous cycles.
        try:
            _get_rhk_manager().clear_failure_list()
        except Exception:
            pass

        try:
            ss_vk = self._vk_for(self.settings.get("hotkey_startstop"), VK_F5)
            fz_vk = self._vk_for(self.settings.get("hotkey_freeze"), VK_F8)
            bl_vk = self._vk_for(self.settings.get("hotkey_block"), VK_F9)
            fn_vk = self._vk_for(self.settings.get("hotkey_fun"), VK_F10)
            ks_key = self.settings.get("hotkey_killswitch") or ""
            ks_vk = KEY_NAMES.get(ks_key) if ks_key else None
        except Exception as e:
            # Settings shape went weird — fall back to defaults so hotkeys
            # at least work with F5/F8/F9/F10 even if the user's saved
            # binding is corrupt.
            print(f"[hotkeys] Failed to read hotkey settings, using defaults: {e}",
                  file=sys.stderr)
            ss_vk, fz_vk, bl_vk, fn_vk, ks_vk = VK_F5, VK_F8, VK_F9, VK_F10, None

        # Register each hotkey individually, isolated by try/except so one
        # failure (e.g. invalid VK, hook init issue) doesn't take down the rest.
        def _bind(name, vk, hotkey_id, action):
            try:
                hk = GlobalHotkey(int(vk), hotkey_id)
                hk.pressed.connect(
                    lambda a=action: self.bridge.hotkeyFired.emit(a))
                hk.start()
                return hk
            except Exception as e:
                print(f"[hotkeys] Failed to register '{name}' (vk=0x{int(vk):02x}): {e}",
                      file=sys.stderr)
                return None

        self.hotkey_startstop = _bind("startstop", ss_vk, 0xB00C, "startstop")
        self.hotkey_freeze    = _bind("freeze",    fz_vk, 0xB00B, "freeze")
        self.hotkey_block     = _bind("block",     bl_vk, 0xB00D, "block")
        self.hotkey_fun       = _bind("fun",       fn_vk, 0xB00E, "fun")

        # Killswitch is optional — only register if a key is bound
        if ks_vk is not None:
            self.hotkey_killswitch = _bind("killswitch", ks_vk, 0xB00F, "killswitch")
        else:
            self.hotkey_killswitch = None

        # Diagnostic — visible if user runs Throttlr from a console window
        registered = [(name, hk) for name, hk in (
            ("startstop", self.hotkey_startstop),
            ("freeze",    self.hotkey_freeze),
            ("block",     self.hotkey_block),
            ("fun",       self.hotkey_fun),
            ("killswitch", self.hotkey_killswitch),
        ) if hk is not None and getattr(hk, 'registered', False)]
        print(f"[hotkeys] Registered {len(registered)} hotkey(s): "
              f"{', '.join(n for n, _ in registered)}", file=sys.stderr)

        # v3.1.1 — Surface any conflicts to the user. If another app has
        # globally claimed one of our keys, RegisterHotKey returned 0 and
        # the manager added it to failed_registrations. Emit a Bridge
        # signal so the frontend can show a toast/popup.
        try:
            failed = _get_rhk_manager().get_failed_registrations()
            if failed and self.bridge is not None:
                # Format as user-friendly list: "F5, F8"
                key_names = [name for _vk, name in failed]
                msg = (f"⚠ Hotkey conflict — "
                       f"{', '.join(key_names)} {'is' if len(key_names) == 1 else 'are'} already in use by another app "
                       f"(Discord, OBS, Steam, etc.) and won't fire globally. "
                       f"{'It' if len(key_names) == 1 else 'They'} will still work when Throttlr has focus. "
                       f"Rebind in Settings → Hotkeys to a different key to fix.")
                # Use the same hotkeyFired bus to send a notification —
                # frontend can listen for action='conflict' specially
                self.bridge.hotkeyConflict.emit(msg)
                print(f"[hotkeys] {msg}", file=sys.stderr)
        except Exception as e:
            print(f"[hotkeys] Failed to surface conflicts: {e}", file=sys.stderr)

    def _on_controller_status(self, status):
        """Flash screen border green when capture starts, red when it stops.
        Also drives the auto-stop timer.
        """
        # Auto-stop timer: starts when capture starts, cancels when it stops
        mins = int(self.settings.get('auto_stop_minutes') or 0)
        if status == 'running' and mins > 0:
            if not hasattr(self, '_auto_stop_timer') or self._auto_stop_timer is None:
                self._auto_stop_timer = QTimer(self)
                self._auto_stop_timer.setSingleShot(True)
                self._auto_stop_timer.timeout.connect(self._auto_stop_fire)
            self._auto_stop_timer.start(mins * 60 * 1000)
        elif status != 'running':
            if hasattr(self, '_auto_stop_timer') and self._auto_stop_timer:
                self._auto_stop_timer.stop()

        # Screen border indicator
        if not self.settings.get('screen_border_enabled'):
            return
        if not hasattr(self, 'screen_border') or self.screen_border is None:
            return
        if status == 'running':
            self.screen_border.show_running()
        else:
            self.screen_border.show_stopped()

    def _auto_stop_fire(self):
        """Auto-stop timer fired — stop capture."""
        try:
            self.controller.stop()
            self.bridge.errorMessage.emit("Auto-stopped — time limit reached.")
        except Exception:
            pass

    def closeEvent(self, e):
        # Confirm before closing if running and the setting is on
        if (self.controller.running
                and self.settings.get('confirm_before_quit')):
            r = QMessageBox.question(
                self, "Quit Throttlr?",
                "Capture is currently running. Quit anyway?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No
            )
            if r != QMessageBox.Yes:
                e.ignore()
                return
        try:
            self.controller.stop()
        except Exception:
            pass
        try:
            if hasattr(self, "overlay") and self.overlay is not None:
                self.overlay.close()
        except Exception:
            pass
        try:
            if hasattr(self, "screen_border") and self.screen_border is not None:
                self.screen_border.close()
        except Exception:
            pass
        self.settings.set("window_w", self.width())
        self.settings.set("window_h", self.height())
        super().closeEvent(e)


# ============================================================
# Splash screen
# ============================================================

def _resource_path(rel: str) -> str:
    """Resolve a path that works both when running from source and from a
    PyInstaller --onefile bundle (which extracts data files to sys._MEIPASS)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def _make_splash_pixmap() -> QPixmap:
    """Industrial / hazard themed splash, with the actual Throttlr logo."""
    w, h = 560, 320
    pm = QPixmap(w, h)
    pm.fill(QColor("#07090a"))
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    p.setRenderHint(QPainter.SmoothPixmapTransform)

    # Background — flat dark with subtle vignette
    bg = QLinearGradient(0, 0, 0, h)
    bg.setColorAt(0, QColor("#10120e"))
    bg.setColorAt(1, QColor("#07090a"))
    p.setBrush(QBrush(bg))
    p.setPen(Qt.NoPen)
    p.drawRect(0, 0, w, h)

    # Top hazard stripe
    stripe_h = 18
    stripe_w = 22
    from PySide6.QtGui import QPolygon
    for i in range(-2, w // stripe_w + 4):
        x = i * stripe_w
        path_pts = [QPoint(x, 0), QPoint(x + stripe_w, 0),
                    QPoint(x + stripe_w + stripe_h, stripe_h),
                    QPoint(x + stripe_h, stripe_h)]
        p.setBrush(QBrush(QColor("#ffb800")))
        p.setPen(Qt.NoPen)
        p.drawPolygon(QPolygon(path_pts))
        x2 = x + stripe_w
        path_pts2 = [QPoint(x2, 0), QPoint(x2 + stripe_w, 0),
                     QPoint(x2 + stripe_w + stripe_h, stripe_h),
                     QPoint(x2 + stripe_h, stripe_h)]
        p.setBrush(QBrush(QColor("#000000")))
        p.drawPolygon(QPolygon(path_pts2))

    # Bottom hazard stripe (mirrored)
    for i in range(-2, w // stripe_w + 4):
        x = i * stripe_w
        path_pts = [QPoint(x, h - stripe_h), QPoint(x + stripe_w, h - stripe_h),
                    QPoint(x + stripe_w + stripe_h, h),
                    QPoint(x + stripe_h, h)]
        p.setBrush(QBrush(QColor("#ffb800")))
        p.setPen(Qt.NoPen)
        p.drawPolygon(QPolygon(path_pts))
        x2 = x + stripe_w
        path_pts2 = [QPoint(x2, h - stripe_h), QPoint(x2 + stripe_w, h - stripe_h),
                     QPoint(x2 + stripe_w + stripe_h, h),
                     QPoint(x2 + stripe_h, h)]
        p.setBrush(QBrush(QColor("#000000")))
        p.drawPolygon(QPolygon(path_pts2))

    # Side bracket marks
    p.setPen(QPen(QColor("#ffb800"), 2))
    p.setBrush(Qt.NoBrush)
    bracket_size = 18
    p.drawLine(20, 36, 20 + bracket_size, 36)
    p.drawLine(20, 36, 20, 36 + bracket_size)
    p.drawLine(w - 20 - bracket_size, 36, w - 20, 36)
    p.drawLine(w - 20, 36, w - 20, 36 + bracket_size)
    p.drawLine(20, h - 36 - bracket_size, 20, h - 36)
    p.drawLine(20, h - 36, 20 + bracket_size, h - 36)
    p.drawLine(w - 20, h - 36 - bracket_size, w - 20, h - 36)
    p.drawLine(w - 20, h - 36, w - 20 - bracket_size, h - 36)

    # === Throttlr logo image, left-aligned ===
    logo_size = 100
    logo_x = 40
    logo_y = (h - logo_size) // 2
    try:
        logo = QPixmap(_resource_path(os.path.join("ui", "throttlr-logo.png")))
        if not logo.isNull():
            scaled = logo.scaled(
                logo_size, logo_size,
                Qt.KeepAspectRatio,
                Qt.SmoothTransformation,
            )
            p.drawPixmap(logo_x, logo_y, scaled)
    except Exception:
        pass

    # === Right side: text block ===
    text_x = logo_x + logo_size + 22
    text_w = w - text_x - 25

    # "THROTTLR" title
    f = p.font()
    f.setFamily("Impact")
    f.setPointSize(40)
    f.setBold(True)
    p.setFont(f)
    p.setPen(QColor("#e8e6d8"))
    p.drawText(QRect(text_x, logo_y + 8, text_w, 60),
               Qt.AlignLeft | Qt.AlignTop, "THROTTLR")

    # "BY BILLY'S MATRIX" tag — pushed well below the descenders of THROTTLR
    f.setFamily("Consolas")
    f.setPointSize(10)
    f.setBold(True)
    p.setFont(f)
    p.setPen(QColor("#ffb800"))
    p.drawText(QRect(text_x, logo_y + 78, text_w, 20),
               Qt.AlignLeft | Qt.AlignTop, "[ BY  BILLY'S  MATRIX ]")

    # Tagline
    f.setPointSize(9)
    f.setBold(False)
    p.setFont(f)
    p.setPen(QColor("#7fff6a"))
    p.drawText(QRect(text_x, logo_y + 108, text_w, 20),
               Qt.AlignLeft | Qt.AlignTop, "PER-APPLICATION  NETWORK  THROTTLER")

    # Status line
    p.setPen(QColor("#3aa030"))
    p.drawText(QRect(text_x, logo_y + 132, text_w, 20),
               Qt.AlignLeft | Qt.AlignTop, ">> SYSTEM   INITIALIZING . . .")

    p.end()
    return pm


# ============================================================
# Phase 1 helpers — ghost mode, animated icon, crash reporter
# ============================================================

def _apply_ghost_mode(window, on: bool) -> None:
    """Toggle WDA_EXCLUDEFROMCAPTURE on a Qt window's HWND so screen-capture
    tools (OBS, Win+G, Discord screen-share, etc.) see a hole where the
    window is. Windows-only — silently no-op elsewhere."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        WDA_NONE = 0x00
        WDA_EXCLUDEFROMCAPTURE = 0x11   # Win10 2004+ — also Win11
        hwnd = int(window.winId())
        affinity = WDA_EXCLUDEFROMCAPTURE if on else WDA_NONE
        ctypes.windll.user32.SetWindowDisplayAffinity(hwnd, affinity)
    except Exception:
        pass


def _make_running_icon_variant(base_pixmap):
    """Build a brighter 'running' variant of the app icon for the animated
    taskbar pulse. We composite a green tint on top of the base pixmap."""
    try:
        from PySide6.QtGui import QPixmap, QPainter, QColor
        if not base_pixmap or base_pixmap.isNull():
            return None
        pm = QPixmap(base_pixmap)
        p = QPainter(pm)
        p.setCompositionMode(QPainter.CompositionMode_Plus)
        # Subtle green wash: not so much it changes the icon shape, just
        # enough to register as a "live" pulse in peripheral vision.
        p.fillRect(pm.rect(), QColor(120, 220, 90, 70))
        p.end()
        return pm
    except Exception:
        return None


class _AnimatedIcon(QObject):
    """Drives a 2-frame icon animation on the QApplication while capture is
    running. Frame A = base icon, Frame B = brighter variant. Cycles every
    ~700ms. Stops cleanly when capture stops."""
    def __init__(self, app, settings):
        super().__init__()
        self.app = app
        self.settings = settings
        self.running = False
        self.frame = 0
        self._base = None
        self._bright = None
        self._timer = QTimer(self)
        self._timer.setInterval(700)
        self._timer.timeout.connect(self._tick)

    def setup(self):
        try:
            from PySide6.QtGui import QIcon, QPixmap
            ip = _resource_path("throttlr.ico")
            if not os.path.exists(ip):
                ip = _resource_path(os.path.join("ui", "throttlr-logo.png"))
            self._base = QPixmap(ip) if os.path.exists(ip) else None
            self._bright = _make_running_icon_variant(self._base)
        except Exception:
            pass

    def start(self):
        if not self.settings.get('animated_icon'):
            return
        if not self._base or not self._bright:
            return
        self.running = True
        self.frame = 0
        self._timer.start()

    def stop(self):
        self.running = False
        self._timer.stop()
        try:
            from PySide6.QtGui import QIcon
            if self._base:
                self.app.setWindowIcon(QIcon(self._base))
        except Exception:
            pass

    def _tick(self):
        try:
            from PySide6.QtGui import QIcon
            self.frame = 1 - self.frame
            pm = self._bright if self.frame else self._base
            if pm:
                self.app.setWindowIcon(QIcon(pm))
        except Exception:
            pass


def _write_crash_report(exc_type, exc_value, exc_tb):
    """Persist a crash report under ~/.throttlr/crashes/ for later debugging.

    Returns a (path, text) tuple. Either element may be None if writing or
    formatting failed — the caller should handle both being absent."""
    try:
        import traceback
        from datetime import datetime
        crash_dir = PROFILE_DIR / "crashes"
        crash_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = crash_dir / f"crash-{ts}.txt"
        body = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        header = (
            f"Throttlr crash report\n"
            f"Version: {__version__}\n"
            f"Time: {datetime.now().isoformat()}\n"
            f"Python: {sys.version.split()[0]}\n"
            f"Platform: {sys.platform}\n"
            f"\n"
        )
        text = header + body
        try:
            path.write_text(text, encoding='utf-8')
            return (str(path), text)
        except Exception:
            # File write failed but we still have the text in memory — return it
            # so the modal can at least offer clipboard copy.
            return (None, text)
    except Exception:
        return (None, None)


# ============================================================
# Main
# ============================================================

# v3.1.0 — CLI argument parsing.
# Flags are extracted before Qt sees argv. Supports launching Throttlr
# already-configured ("--app discord.exe --lag 200 --start"), printing
# version, and printing usage. Doesn't run headless — still launches the
# GUI, just preloaded.
def _parse_cli_args():
    import argparse
    parser = argparse.ArgumentParser(
        prog="throttlr",
        description="Per-application network throttler for Windows.",
        add_help=False,   # custom help to avoid Qt argparse conflict
    )
    parser.add_argument("--app",      type=str, default=None,
        help="Pre-target a process by executable name (e.g. discord.exe)")
    parser.add_argument("--lag",      type=int, default=None,
        help="Pre-set lag in milliseconds")
    parser.add_argument("--drop",     type=int, default=None,
        help="Pre-set drop chance 0-100")
    parser.add_argument("--throttle", type=int, default=None,
        help="Pre-set throttle in KB/s")
    parser.add_argument("--block", action="store_true",
        help="Start with Block enabled")
    parser.add_argument("--start", action="store_true",
        help="Auto-start capture immediately after launch")
    parser.add_argument("--version", action="store_true",
        help="Print version and exit")
    parser.add_argument("--help-cli", action="store_true",
        help="Print CLI help and exit")

    # Parse only known args so we don't conflict with Qt flags
    args, leftover = parser.parse_known_args(sys.argv[1:])
    # Trim recognized flags from sys.argv so Qt sees a clean list
    sys.argv = [sys.argv[0]] + leftover

    if args.version:
        print(f"Throttlr {__version__}")
        sys.exit(0)
    if args.help_cli:
        parser.print_help()
        sys.exit(0)
    return args


def _apply_cli_opts(cli_opts, controller, win):
    """Apply parsed CLI options after the controller + window are alive.
    Done on the Qt main thread to keep config-lock semantics correct."""
    try:
        cfg = controller.config
        any_change = False
        if cli_opts.app:
            cfg.target_name = cli_opts.app
            any_change = True
        if cli_opts.lag is not None and cli_opts.lag > 0:
            cfg.lag_on = True
            cfg.lag_ms = int(cli_opts.lag)
            any_change = True
        if cli_opts.drop is not None and cli_opts.drop > 0:
            cfg.drop_on = True
            cfg.drop_chance = max(1, min(100, int(cli_opts.drop)))
            any_change = True
        if cli_opts.throttle is not None and cli_opts.throttle > 0:
            cfg.throttle_on = True
            cfg.throttle_kbps = int(cli_opts.throttle)
            any_change = True
        if cli_opts.block:
            cfg.block_on = True
            any_change = True
        if any_change:
            controller.update_config(cfg)
        if cli_opts.start:
            controller.start()
    except Exception as e:
        print(f"CLI options failed to apply: {e}", file=sys.stderr)


def main():
    # v3.1.1 — Enable Chromium remote debugging so we can inspect the
    # splash JS console from Chrome at http://localhost:9222 if a startup
    # hang happens. Cost is near-zero; only listens on localhost.
    os.environ.setdefault("QTWEBENGINE_REMOTE_DEBUGGING", "9222")

    # v3.1.1 — Startup logging to disk. If the app hangs, the log will
    # show the last step that completed. Written to PROFILE_DIR (created
    # if missing). Always overwrites the previous log on launch.
    _startup_log_path = None
    def _log_startup(msg):
        """Append a timestamped line to the startup log. Never raises."""
        nonlocal _startup_log_path
        try:
            if _startup_log_path is None:
                PROFILE_DIR.mkdir(parents=True, exist_ok=True)
                _startup_log_path = PROFILE_DIR / "startup.log"
                # Truncate on first call so each launch gets a fresh log
                try:
                    header = (
                        f"Throttlr v{__version__} startup log\n"
                        f"{datetime.now().isoformat()}\n"
                        + ("=" * 60) + "\n"
                    )
                    _startup_log_path.write_text(header, encoding='utf-8')
                except Exception:
                    pass
            with open(_startup_log_path, 'a', encoding='utf-8') as f:
                f.write(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}\n")
        except Exception:
            pass

    # Expose the logger to MainWindow so it can log page-load events
    import builtins as _bi
    _bi._throttlr_startup_log = _log_startup

    _log_startup("main() entered")

    # v3.1.0 — CLI mode. Parses recognized flags out of sys.argv before
    # Qt sees them, then strips them so QApplication doesn't choke. The
    # flags are applied AFTER the controller initializes, but the GUI
    # still launches normally — useful for "open Throttlr already
    # configured for this app" launch shortcuts.
    try:
        cli_opts = _parse_cli_args()
        _log_startup("CLI args parsed")
    except Exception as e:
        _log_startup(f"CLI parse FAILED: {e}")
        cli_opts = None

    _log_startup("creating QApplication...")
    app = QApplication(sys.argv)
    app.setApplicationName("Throttlr")
    app.setOrganizationName("BillysMatrix")
    _log_startup("QApplication created")

    # Set the global app icon — propagates to taskbar, Alt+Tab, every
    # window without its own icon, and the splash screen.
    try:
        from PySide6.QtGui import QIcon
        icon_paths = [
            _resource_path("throttlr.ico"),
            _resource_path(os.path.join("ui", "throttlr-logo.png")),
        ]
        for ip in icon_paths:
            if os.path.exists(ip):
                app.setWindowIcon(QIcon(ip))
                break
    except Exception:
        pass

    settings = SettingsManager()
    set_sound_enabled(settings.get("sound_enabled"))

    # Kick off background GitHub release check. Non-blocking — startup proceeds
    # immediately; the check completes in the background and the result is
    # picked up when the JS UI calls bridge.getUpdateInfo() after init.
    global update_checker
    update_checker = UpdateChecker()
    update_checker.kick_off()

    try:
        splash = QSplashScreen(
            _make_splash_pixmap(),
            Qt.WindowStaysOnTopHint | Qt.FramelessWindowHint
        )
        splash.show()
        splash.raise_()
        splash.activateWindow()
        # Pump the event loop a few times to make sure the splash actually
        # paints before we get into the heavy MainWindow construction.
        for _ in range(8):
            app.processEvents()
    except Exception:
        splash = None

    if not is_admin():
        QMessageBox.warning(
            None, "Admin required",
            "Throttlr needs Administrator privileges to capture packets.\n\n"
            "Close this and re-launch via 'Run as administrator', or use\n"
            "run_as_admin.bat in the install folder."
        )

    _log_startup("creating NetworkController...")
    controller = NetworkController()
    _log_startup("NetworkController created")

    _log_startup("creating MainWindow...")
    try:
        win = MainWindow(controller, settings)
        _log_startup("MainWindow created OK")
    except Exception as _e:
        _log_startup(f"MainWindow CONSTRUCTION FAILED: {type(_e).__name__}: {_e}")
        import traceback
        _log_startup("traceback:\n" + traceback.format_exc())
        raise

    # v3.1.0 — System tray icon w/ quick-actions menu.
    # Only installed if the platform supports tray icons (everywhere
    # modern Windows does, but the check is defensive).
    _log_startup("installing tray icon...")
    tray = None
    try:
        if QSystemTrayIcon.isSystemTrayAvailable():
            tray = ThrottlrTrayIcon(win, controller, parent=app)
            tray.show()
            # Tick state refresh every second so menu labels stay in sync
            from PySide6.QtCore import QTimer as _QT
            _tray_timer = _QT(app)
            _tray_timer.timeout.connect(tray.update_state)
            _tray_timer.start(1000)
        _log_startup("tray icon ready")
    except Exception as _e:
        # Never let a tray-init failure block app startup
        _log_startup(f"tray icon failed (non-fatal): {_e}")
        print(f"Tray icon unavailable: {_e}", file=sys.stderr)

    # v3.1.1 — Hotkey watchdog. Windows silently unhooks low-level keyboard
    # hooks if our callback ever exceeds LowLevelHooksTimeout (default 300ms),
    # which can happen under brief GIL contention. Once unhooked, hotkeys
    # stop working until app restart — that's the "works sometimes, then
    # stops" bug. Watchdog fires every 30s and force-reinstalls the hook
    # regardless of state (cheap, ~1ms, the install thread handles it).
    _log_startup("setting up hotkey watchdog...")
    try:
        from PySide6.QtCore import QTimer as _QT
        _hook_watchdog = _QT(app)
        def _hook_watchdog_tick():
            try:
                hook = _KB_HOOK_SINGLETON
                if hook is not None and hasattr(hook, 'reinstall_if_stale'):
                    hook.reinstall_if_stale()
            except Exception:
                pass
        _hook_watchdog.timeout.connect(_hook_watchdog_tick)
        _hook_watchdog.start(30 * 1000)
        _log_startup("hotkey watchdog ready")
    except Exception as _e:
        _log_startup(f"hotkey watchdog setup failed (non-fatal): {_e}")
        print(f"Hotkey watchdog setup failed: {_e}", file=sys.stderr)

    # Animated taskbar icon while capture is running
    _log_startup("setting up animated taskbar icon...")
    anim_icon = _AnimatedIcon(app, settings)
    anim_icon.setup()
    def _on_status(status):
        if status == "running":
            anim_icon.start()
        else:
            anim_icon.stop()
    try:
        controller.status_changed.connect(_on_status)
    except Exception:
        pass
    _log_startup("animated taskbar icon ready")

    # If the user has ghost mode enabled and the overlay is up, apply it
    # immediately so the very first frame is already excluded from capture
    try:
        ov = getattr(win, '_overlay', None) or getattr(win.bridge, '_overlay', None)
        if ov is not None and settings.get('overlay_ghost_mode'):
            _apply_ghost_mode(ov, True)
    except Exception:
        pass
    _log_startup("ghost mode handled")

    play_tones((523, 40), (659, 40), (784, 60))

    if splash:
        # Hold the splash for a clearly visible moment, then swap to the
        # main window. splash.finish(win) waits for win to be shown to
        # close the splash, so call show() right after.
        def _swap():
            _log_startup("swap timer: finishing splash + showing window")
            splash.finish(win)
            win.show()
            win.raise_()
            win.activateWindow()
            _log_startup("window shown")
        QTimer.singleShot(1800, _swap)
        _log_startup("swap timer armed (1800ms)")
    else:
        win.show()
        _log_startup("window shown directly (no splash)")

    # v3.1.0 — Apply CLI options once the window is up.
    QTimer.singleShot(2200, lambda: _apply_cli_opts(cli_opts, controller, win))

    # Run the event loop. Wrap in try/except so any unhandled exception
    # (Qt bug, missing module, malformed setting) is captured to disk
    # rather than just vanishing without a trace.
    try:
        sys.exit(app.exec())
    except SystemExit:
        raise
    except Exception:
        path, text = _write_crash_report(*sys.exc_info())
        try:
            box = QMessageBox()
            box.setIcon(QMessageBox.Critical)
            box.setWindowTitle("Throttlr crashed")
            box.setText(
                "Something went wrong and Throttlr had to close.\n\n"
                f"A crash report was saved to:\n{path or '~/.throttlr/crashes/'}\n\n"
                "You can attach it when reporting the issue."
            )
            ok_btn = box.addButton(QMessageBox.Ok)
            copy_btn = None
            if text:
                # Only offer clipboard if we actually have the report text
                copy_btn = box.addButton("Copy report to clipboard",
                                         QMessageBox.ActionRole)
            box.setDefaultButton(ok_btn)
            box.exec()
            if copy_btn is not None and box.clickedButton() is copy_btn:
                try:
                    QApplication.clipboard().setText(text)
                except Exception:
                    pass
        except Exception:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
