# BrowserManager — Internal Changes

Changes made to `src/browser-manager.ts` to support the new tools.

---

## Route Persistence

The core challenge: `recreateContext()` (called by `pilot_set_useragent`) tears down and rebuilds the Playwright context, which drops all `context.route()` registrations.

**Solution:** Store route configs separately from handlers. Rebuild handlers on every new context.

### State added

```ts
private blockPatterns: Set<string> = new Set();
private blockHandlers: Map<string, (route: Route) => void> = new Map();

private interceptConfigs: Map<string, {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  contentType?: string;
}> = new Map();
private interceptHandlers: Map<string, (route: Route) => void> = new Map();
```

### `applyRoutesFromConfig()`

Called in two places:
1. After `loadPersistedState()` in `launch()` — applies any routes from a loaded session
2. After `restoreState()` in `recreateContext()` — re-applies routes after context rebuild

```ts
private async applyRoutesFromConfig(): Promise<void> {
  const ctx = this.context!;
  // Re-register block routes
  for (const [pattern] of this.blockHandlers) {
    await ctx.unroute(pattern);
  }
  this.blockHandlers.clear();
  for (const pattern of this.blockPatterns) {
    const handler = (route: Route) => route.abort();
    this.blockHandlers.set(pattern, handler);
    await ctx.route(pattern, handler);
  }
  // Re-register intercept routes
  for (const [pattern] of this.interceptHandlers) {
    await ctx.unroute(pattern);
  }
  this.interceptHandlers.clear();
  for (const [pattern, config] of this.interceptConfigs) {
    const handler = (route: Route) => route.fulfill({ ... });
    this.interceptHandlers.set(pattern, handler);
    await ctx.route(pattern, handler);
  }
}
```

### Public API

```ts
// Block
async addBlockPattern(pattern: string): Promise<void>
async clearBlockPatterns(): Promise<void>
getBlockPatterns(): string[]

// Intercept
async addIntercept(pattern: string, response: InterceptConfig): Promise<void>
async clearIntercepts(): Promise<void>
getIntercepts(): Array<{ pattern: string; status: number }>
```

---

## Session Save/Load

```ts
async saveSessionToFile(filePath: string): Promise<number>
async loadSessionFromFile(filePath: string): Promise<number>
async clearSession(): Promise<void>
```

**`saveSessionToFile`:** Uses `context.storageState()` which returns `{ cookies, origins }`. Writes JSON to disk. Expands `~` to `HOME`. Returns cookie count.

**`loadSessionFromFile`:** Reads file, calls `context.addCookies(state.cookies)`. For each origin in `state.origins`, calls `page.goto(origin.origin)` then `page.evaluate()` to restore `localStorage` entries. Returns cookie count.

**`clearSession`:** Calls `context.clearCookies()`. Evaluates `localStorage.clear()` + `sessionStorage.clear()` on the current page.

---

## `addSingleRef`

Adds a single element to the ref map without running a full snapshot.

```ts
addSingleRef(locator: Locator, role: string, name: string): string
```

**Implementation:** Inspects `this.refs` for the current max `eN` number, assigns `e{max+1}`. Stores `{ locator, role, name }`. Returns the ref string (e.g., `"e5"`).

Used by `pilot_find` to return a ref that's compatible with `pilot_click`, `pilot_fill`, etc.

---

## Import added

```ts
import { type Route } from 'playwright';
```

Required for typed route handler signatures.
