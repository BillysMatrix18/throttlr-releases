# Throttlr Plugins

This folder contains plugins for Throttlr. Each plugin extends Throttlr's
backend with custom Python code.

## How to install a plugin

1. Drop a folder containing a `plugin.py` file into this directory, OR
2. Drop a single `.py` file directly into this directory

Then open Throttlr → Settings → Plugins → toggle the plugin on.

## How to write a plugin

Create a class with `on_load(self, api)` and these attributes:

```python
class MyPlugin:
    name        = "My Plugin"
    version     = "1.0.0"
    description = "What this plugin does"

    def on_load(self, api):
        api.log("loaded!")
        self._api = api

    def on_unload(self):
        pass

    def on_capture_start(self, target_app):
        # Called when user clicks Start
        pass

    def on_capture_stop(self):
        # Called when user clicks Stop
        pass

    def on_packet(self, pkt):
        # Called for every captured packet
        # Return the (possibly modified) packet, or None to drop
        # WARNING: this fires thousands of times per second — keep it FAST
        return pkt
```

The `api` parameter passed to `on_load` is a restricted facade exposing:

| Method | Description |
|---|---|
| `api.log(msg)` | Print to console (visible in dev mode) |
| `api.toast(msg, level)` | Show a toast in the Throttlr window |
| `api.get_version()` | Returns Throttlr version string |
| `api.get_setting(key, default)` | Read from settings.json |

Plugins run with full Python privileges so only enable plugins you trust.

## Example

See the bundled `capture_logger` plugin for a working demonstration.
