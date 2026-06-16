"""Example plugin shipped with Throttlr v3.0.0.

Demonstrates the plugin lifecycle hooks and PluginAPI usage. This plugin
just logs to the console and shows a toast each time you start/stop a
capture. Drop your own plugins in this folder and enable them via
Settings → Plugins.

Plugin file structure:
    <PROFILE_DIR>/plugins/
        capture_logger/
            plugin.py        ← entry point (this file)
            manifest.json    ← optional metadata override

The class with `on_load` is auto-discovered. Required attributes:
    name        — display name shown in Settings → Plugins
    version     — semver string
    description — what your plugin does

Optional lifecycle hooks (called by Throttlr when relevant):
    on_load(api)           — when plugin is enabled. `api` is a PluginAPI.
    on_unload()            — when disabled or app is closing.
    on_capture_start(target_app)
    on_capture_stop()
    on_packet(pkt)         — called for every captured packet (can return modified)
"""


class CaptureLoggerPlugin:
    name        = "Capture Logger"
    version     = "1.0.0"
    description = "Logs each capture start/stop to the console + shows a toast."

    def __init__(self):
        self._api = None
        self._captures = 0

    def on_load(self, api):
        """Called when the plugin is enabled. The `api` argument exposes
        a small surface for plugins to interact with Throttlr safely."""
        self._api = api
        api.log(f"Capture Logger loaded — Throttlr v{api.get_version()}")
        api.toast("Capture Logger plugin loaded", "info")

    def on_unload(self):
        if self._api:
            self._api.log(f"Capture Logger unloaded after {self._captures} captures")

    def on_capture_start(self, target_app):
        self._captures += 1
        if self._api:
            tgt = target_app or "(no target)"
            self._api.log(f"[capture #{self._captures}] start: {tgt}")
            self._api.toast(f"Recording capture #{self._captures}: {tgt}", "info")

    def on_capture_stop(self):
        if self._api:
            self._api.log(f"[capture #{self._captures}] stopped")

    # on_packet is intentionally omitted — that hook fires very frequently
    # (potentially thousands of times per second). Only implement it if you
    # really need per-packet inspection, and keep it FAST. You can return
    # a modified packet to alter what gets re-injected.
