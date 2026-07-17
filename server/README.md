# Chromium Bridge

MCP bridge between your Chromium-based browser and Claude Code: browser
automation tools (`browser_*`) plus a Claude chat panel in the browser — for
Chromium browsers where the official "Claude in Chrome" extension doesn't work
(Arc, Vivaldi, and others).

This package is the MCP server half. It requires the companion browser
extension from the repository:

**Full setup, docs, and the extension: https://github.com/dashi96/chromium-bridge**

Quick start:

1. Load the extension (`extension/` folder from the repo) via `chrome://extensions` → "Load unpacked".
2. Register the server:
   `claude mcp add -s user chromium-bridge -- npx chromium-bridge`
3. Restart your Claude Code session and check that `browser_status` returns `{"connected": true}`.

MIT © Dashi Dantsaranov
