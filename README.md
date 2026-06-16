# Throttlr

**Per-application network throttler for Windows — by Billy's Matrix.**

Throttlr lets you lag, drop, throttle, freeze, or block a *single app's*
network traffic — not your whole connection. Pick a process, choose what to do
to it, and everything else keeps running untouched.

This is the **public releases** repo. Grab the latest build below.

---

## Download

➡️ **[Download the latest release](https://github.com/BillysMatrix18/throttlr-releases/releases/latest)**

1. Download `Throttlr-Setup.exe` from the latest release.
2. Run it. Windows SmartScreen may warn that the publisher isn't recognised —
   this is normal for indie apps that aren't code-signed. Click
   **More info → Run anyway**.
3. When the admin (UAC) prompt appears, click **Yes**. Throttlr needs
   administrator rights to intercept packets — it won't work without it.

**Requirements:** 64-bit Windows 10 or 11. Nothing else to install.
No account, no telemetry.

---

## What it does

Pick an app from your running processes, then enable any combination of:

- **Lag** — adds delay (with optional jitter) to its packets
- **Drop** — randomly drops a percentage of its packets
- **Throttle** — caps its bandwidth (KB/s)
- **Freeze** — holds its packets, then releases them in a burst
- **Block** — cuts its traffic entirely
- **Fun** — chaos mode that mixes effects on top of whatever's enabled

Each function has independent **In / Out** direction controls.

Other features: a live traffic graph, a connection inspector and live map, a
large library of one-click network scenarios (3G, congested wifi, satellite,
high-ping, packet loss, and more), saveable presets you can export and share,
multiple themes, and global hotkeys.

---

## Use it for

- Testing how a game or app behaves on a bad connection (recreate 300ms ping,
  simulate packet loss, cap a background download mid-stream)
- QA on flaky-network conditions
- Inspecting exactly what a process is talking to

---

## Is it safe?

Throttlr is free, has no account system, and sends no telemetry. It needs
administrator rights because intercepting network packets requires a kernel
driver — that's the same reason tools like Clumsy and Wireshark ask for it.

If your antivirus or SmartScreen flags it, that's because the installer isn't
code-signed yet (signing certificates are expensive for a free indie tool), not
because anything's wrong. You're welcome to scan the installer before running.

---

## Support

Found a bug or have an idea? Open an issue on this repo, or use the in-app
feedback form.

*Throttlr is not affiliated with any app you can throttle.*
