# New Tools — Implementation Notes

**Date:** 2026-03-27
**Implemented from:** `docs/feature-roadmap.md`
**Total new tools:** 7

---

## Tool Profile Assignment

| Tool | Profile | File |
|------|---------|------|
| `pilot_auth` | standard | `src/tools/settings.ts` |
| `pilot_block` | standard | `src/tools/settings.ts` |
| `pilot_find` | standard | `src/tools/snapshot-tools.ts` |
| `pilot_intercept` | full | `src/tools/automation.ts` |
| `pilot_assert` | full | `src/tools/automation.ts` |
| `pilot_clipboard` | full | `src/tools/automation.ts` |
| `pilot_geolocation` | full | `src/tools/settings.ts` |

Standard profile is now 28 tools (was 25). Full is unrestricted.

---

## `pilot_auth` — Session Save/Restore

Saves/loads browser session state (cookies + localStorage + sessionStorage) to a JSON file via `BrowserManager.saveSessionToFile()` / `loadSessionFromFile()`.

```ts
pilot_auth({ action: "save", path: "~/.pilot/session.json" })
pilot_auth({ action: "load", path: "~/.pilot/session.json" })
pilot_auth({ action: "clear" })
```

**Implementation:** Uses Playwright `context.storageState()` to serialize and `context.addCookies()` + `page.evaluate()` to restore. `path` supports `~` expansion. `clear` calls `context.clearCookies()` + evaluates `localStorage.clear()` / `sessionStorage.clear()`.

---

## `pilot_block` — URL Pattern Blocking

Blocks network requests matching glob patterns via `context.route()` + `route.abort()`. Includes a built-in 20-pattern `"ads"` preset covering major ad/tracker networks.

```ts
pilot_block({ preset: "ads" })
pilot_block({ patterns: ["*analytics*"] })
pilot_block({ clear: true })
```

**Implementation:** Patterns and their handlers are stored separately in `BrowserManager` (`blockPatterns: Set<string>`, `blockHandlers: Map<string, handler>`). On `recreateContext()`, `applyRoutesFromConfig()` re-registers all routes on the new context — blocks survive User-Agent changes and context recreation.

**ADS_PRESET (20 patterns):** Covers Google Ads, DoubleClick, Hotjar, Facebook Pixel, Twitter Analytics, Bing Ads, Criteo, Outbrain, Taboola, LinkedIn Ads, Amazon DSP, Quantserve, Scorecard Research, Moat.

---

## `pilot_find` — Semantic Element Finder

Resolves a single element ref from visible text, label, placeholder, or role — without a full snapshot.

```ts
pilot_find({ text: "Sign in" })
pilot_find({ role: "button", text: "Submit" })
pilot_find({ label: "Email address" })
pilot_find({ placeholder: "Search..." })
```

**Returns:** `Found @eN <description>` — ref is immediately usable by all interaction tools.

**Implementation:** Uses Playwright locators (`getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`). On count === 1, calls `BrowserManager.addSingleRef()` which finds the current max `eN` ref number and assigns `e{max+1}` to avoid collisions with snapshot-assigned refs.

**Error hints are context-aware:**
- `role + text` + multiple matches → `"use exact=true to require an exact match"`
- `role` only + multiple matches → `"add text or label to narrow it down"`
- otherwise → `"add role or use exact=true to narrow it down"`

---

## `pilot_intercept` — Network Request Mocking

Intercepts requests matching a URL pattern and fulfills them with a custom response.

```ts
pilot_intercept({ pattern: "**/api/users", response: { status: 200, body: '[{"id":1}]' } })
pilot_intercept({ pattern: "**/auth", response: { status: 401 } })
pilot_intercept({ clear: true })
```

**Implementation:** Uses `context.route(pattern, route => route.fulfill({...}))`. Configs stored in `interceptConfigs: Map<string, config>` and re-applied on context recreation via `applyRoutesFromConfig()`. `contentType` defaults to `application/json` when not specified.

---

## `pilot_assert` — Page Assertions

Checks one or more conditions about current page state. Returns a structured pass/fail.

```ts
pilot_assert({ url: "/dashboard" })
pilot_assert({ text_present: "Welcome back", text_absent: "Error" })
pilot_assert({ ref: "@e3", state: "visible" })
pilot_assert({ ref: "@e3", value: "user@example.com" })
```

**Returns:** `✓ N assertion(s) passed` or `isError: true` with `✗ N/M failed: <details>`.

**Implementation notes:**
- `url` check: uses `String.includes()` so partial URLs work
- `text_present`: waits up to 5s via `waitFor({ state: 'visible' })`
- `text_absent`: instant `isVisible()` check (no wait)
- `state` and `value` on the same `ref` each increment `checks` independently (not 1 for both)
- `ref` with no `state`/`value` = pure existence check (`checks++` only when both are undefined)
- `value` falls back to `textContent()` if element has no input value (handles non-input elements)

---

## `pilot_clipboard` — Clipboard Read/Write

```ts
pilot_clipboard({ action: "get" })
pilot_clipboard({ action: "set", text: "hello world" })
```

**Implementation:** Calls `context.grantPermissions(['clipboard-read', 'clipboard-write'])` before every operation. Uses `page.evaluate(() => navigator.clipboard.readText/writeText())`. Headless Chrome supports clipboard access after permission grant.

**Known limitation:** May be blocked by some security policies in headless mode. Error message directs user to `pilot_handoff` for headed mode.

---

## `pilot_geolocation` — Fake GPS

```ts
pilot_geolocation({ latitude: 19.4326, longitude: -99.1332 })  // Mexico City
pilot_geolocation({ clear: true })
```

**Implementation:** `context.grantPermissions(['geolocation'])` + `context.setGeolocation({ latitude, longitude, accuracy })`. `accuracy` defaults to 10m. `clear` calls `context.setGeolocation(null)`.

---

## `automation.ts` — New File

`src/tools/automation.ts` groups the Tier 2–3 tools (`pilot_intercept`, `pilot_assert`, `pilot_clipboard`) that are full-profile only. Registered via `registerAutomationTools(server, bm)` called from `registerAllTools()` in `register.ts`.

---

## BrowserManager Extensions

See `browser-manager.md` for the internal changes that support these tools.
