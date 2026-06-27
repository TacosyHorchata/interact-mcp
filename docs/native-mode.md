# Native Browser Mode

Pilot runs without the Chrome extension by default.

Native mode is the recommended backend for QA automation because screenshots come from Playwright's browser context instead of `chrome.tabs.captureVisibleTab()`. It does not depend on Chrome foreground focus, extension reload state, tab visibility, or capture quota timing.

## What Native Mode Guarantees

- No Chrome extension required.
- No manual Chrome focus hacks.
- One Pilot session maps to one isolated Playwright browser context and one active page.
- Six parallel MCP/Codex sessions can navigate and screenshot without sharing tabs.
- Screenshots are returned as PNG data and can be written through `pilot_screenshot`.
- The first Pilot process becomes the broker on `127.0.0.1:3131`; later Pilot processes connect as broker clients.

## Install For Codex

From a local checkout:

```bash
npm install
npm run build
codex mcp add pilot \
  --env PILOT_BROWSER_MODE=native \
  --env PILOT_PROFILE=full \
  -- node /absolute/path/to/pilot/dist/index.js
```

From the npm package:

```bash
codex mcp add pilot \
  --env PILOT_BROWSER_MODE=native \
  --env PILOT_PROFILE=full \
  -- npx -y pilot-mcp
```

Check the installed MCP config:

```bash
codex mcp get pilot
```

Expected:

```text
transport: stdio
env: PILOT_BROWSER_MODE=*****, PILOT_PROFILE=*****
```

## Runtime Modes

| Variable | Default | Meaning |
|---|---:|---|
| `PILOT_BROWSER_MODE=native` | yes | Use Playwright-backed isolated browser sessions. |
| `PILOT_BROWSER_MODE=extension` | no | Legacy extension-only mode. Requires the Chrome extension. |
| `PILOT_BROWSER_MODE=auto` | no | Use the extension if connected, otherwise native. |
| `PILOT_HEADLESS=1` | no | Run the native browser headless. Useful for stress/CI. |
| `PILOT_PROFILE=core|standard|full` | `standard` | Controls which MCP tools are exposed. |
| `PILOT_OUTPUT_DIR=/path` | system temp | Restricts screenshot/file output paths. |

For QA stress runs, use:

```bash
PILOT_BROWSER_MODE=native PILOT_HEADLESS=1
```

For visible local debugging, omit `PILOT_HEADLESS=1`.

If Playwright Chromium is missing:

```bash
npx playwright install chromium
```

## Verify Before QA Runs

Run the repository checks:

```bash
npm run build
npm test
```

Run direct WebSocket plus broker-client screenshot stress:

```bash
PILOT_HEADLESS=1 npm run stress:screenshots
```

Expected summary:

```text
[pilot-stress] direct: 6/6 passed
[pilot-stress] client: 6/6 passed
[pilot-stress] cleanup complete
```

Run real Codex MCP stress:

```bash
npm run stress:codex
```

Expected summary:

```text
[pilot-codex-stress] 6/6 passed
```

This starts six `codex exec` runs in parallel. Each run uses the installed `pilot` MCP, navigates to a unique URL, captures a screenshot, validates the PNG header, and exits only after all sessions finish.

By default, the runner disables all configured MCP servers except `pilot` for each stress child process. This keeps the test focused on Pilot and avoids unrelated OAuth/auth failures from other MCPs. To keep all MCPs enabled:

```bash
npm run stress:codex -- --disable-other-mcps false
```

Useful runner options:

```bash
npm run stress:codex -- --sessions 6 --timeout-ms 240000
```

## Manual Smoke Test

Use a fresh Codex session and ask:

```text
Use Pilot to open https://example.com/#manual-native-smoke, take a screenshot to /tmp/pilot-manual-smoke.png, verify it is a PNG, then report OK.
```

Then verify:

```bash
file /tmp/pilot-manual-smoke.png
rm -f /tmp/pilot-manual-smoke.png
```

## Local Cleanup Checks

After a stress run, there should be no broker listener and no orphan browser processes:

```bash
lsof -nP -iTCP:3131 -sTCP:LISTEN || true
ps -axo pid,ppid,command | rg 'dist/index\.js|chrome-headless-shell|playwright_chromiumdev_profile|pilot-codex-exec-stress' || true
```

If port `3131` is still held by an old Pilot process, stop only that process:

```bash
lsof -nP -iTCP:3131 -sTCP:LISTEN
kill <pid>
```

Do not use Docker for Pilot local verification.

## Extension Mode Is Legacy

The extension still exists for workflows that need a user's already-authenticated real Chrome profile.

Use it explicitly:

```bash
PILOT_BROWSER_MODE=extension node dist/index.js
```

For QA automation and screenshot evidence, native mode is the supported path.
