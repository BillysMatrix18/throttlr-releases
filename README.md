# Throttlr

**Per-application network throttler for Windows — by Billy's Matrix.**

Selectively lag, drop, freeze, throttle, or block a single app's traffic. Same engine as before — now with a webview UI (HTML/CSS/JS rendered inside the app via embedded Chromium).

## What it does

Pick an app from the running-process list. Enable any combination of:

- **Lag** — adds delay (with optional jitter) to packets
- **Drop** — randomly drops a percentage of packets
- **Throttle** — caps bandwidth (KB/s, token-bucket per direction)
- **Freeze** — holds packets in a queue; release as a burst or replay slowly
- **Block** — drops 100% of packets (instant disconnect)
- **Fun** — chaos mode, randomizes effects on top of whatever's enabled

Each function has independent **In / Out** direction controls.

Live traffic graph, profile save/load, multiple themes (Industrial, Midnight Aurora, plus 5 community themes loadable from the themes repo), global hotkeys (F5/F8/F9/F10, rebindable).

## Architecture

```
throttlr/
├── throttlr.py        ← Backend + webview host (Python)
├── ui/
│   ├── index.html     ← UI structure
│   ├── style.css      ← Glassmorphism + theme system
│   ├── app.js         ← Frontend logic + bridge
│   ├── qwebchannel.js ← Auto-extracted from Qt at first run
│   ├── worldmap-data.js ← Geo map data for Connection Inspector
│   └── throttlr-logo.png
├── requirements.txt
├── build.bat          ← Build single-file Throttlr.exe + installer
├── run_as_admin.bat   ← Launch with auto-elevation
└── throttlr.iss       ← Inno Setup installer script
```

The Python backend runs the network capture (via WinDivert/pydivert), exposes a
`Bridge` object as a JS-callable API through Qt's `QWebChannel`. The frontend uses
**Tailwind**, **Bootstrap**, **Shoelace**, and **animate.css** (loaded via CDN)
on top of custom themed glassmorphism CSS.

> **Note**: The UI loads CDN assets on first run (Tailwind, Bootstrap, Shoelace,
> animate.css). After first launch they're cached by the embedded Chromium so
> subsequent launches are instant. If you're behind a firewall that blocks
> `cdn.jsdelivr.net` / `cdnjs.cloudflare.com`, the UI still renders but loses
> the polish layer.

## Requirements

- Windows 7+
- Python 3.10+ (for development only)
- Administrator privileges (needed by WinDivert)
- WinDivert driver (auto-installed by pydivert on first run)

## Run from source

```cmd
pip install -r requirements.txt
run_as_admin.bat
```

## Build a single .exe

```cmd
build.bat
```

Produces `dist\Throttlr.exe` (~80–150 MB — Chromium is bundled) and, if Inno
Setup 6 is installed, `dist\Throttlr-Setup.exe` (the proper Windows installer).

## Hotkeys (default)

| Key  | Action       |
|------|--------------|
| F5   | Start/Stop   |
| F8   | Freeze toggle|
| F9   | Block toggle |
| F10  | Fun mode     |

Rebindable in **Settings → Hotkeys**. A killswitch hotkey is also available
(no default binding — pick your own).

## Notes on what actually works

Lag-switch packet replay (the dramatic "snap-back" effect from old games) doesn't
visibly affect modern apps — Discord/Zoom drop stale UDP via timestamped jitter
buffers, modern multiplayer games (Valorant, Roblox, Minecraft Bedrock) reject
out-of-sequence packets as cheats, VRChat extrapolates positions through Photon.

What **does** work reliably:
- **Block** — instant disconnect feel
- **Drop** — visible packet loss / rubber-banding
- **Lag** at short delays (50–300 ms) — noticeable lag without breaking the connection
- **Throttle** — caps download/upload bandwidth predictably

Long lag (>500 ms) and Freeze are most useful as a kill-switch — packets queue up,
release fires a burst, but the receiving app may already have moved on.

## Settings file location

`%APPDATA%\Throttlr\settings.json` — also where profiles are saved. This folder
survives uninstall, so your settings persist across reinstalls.

---

## License

Throttlr is proprietary software. © 2026 Billy Papastavros. All rights reserved.

Unauthorized copying, modification, distribution, or reverse engineering is
strictly prohibited.

Made by **Billy's Matrix**.
