import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { consoleBuffer, networkBuffer, dialogBuffer } from '../buffers.js';
import { wrapError } from '../errors.js';

function hasAwait(code: string): boolean {
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /\bawait\b/.test(stripped);
}

function needsBlockWrapper(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.split('\n').length > 1) return true;
  if (/\b(const|let|var|function|class|return|throw|if|for|while|switch|try)\b/.test(trimmed)) return true;
  if (trimmed.includes(';')) return true;
  return false;
}

function wrapForEvaluate(code: string): string {
  if (!hasAwait(code)) return code;
  const trimmed = code.trim();
  return needsBlockWrapper(trimmed)
    ? `(async()=>{\n${code}\n})()`
    : `(async()=>(${trimmed}))()`;
}

const MAX_EXPRESSION_LENGTH = 50 * 1024;

export function registerInspectionTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_console',
    `Retrieve browser console messages (console.log, console.warn, console.error) from a circular buffer.
Use when the user wants to debug JavaScript errors, check application logs, inspect warnings, or see what the page is printing to the console.

Parameters:
- level: Filter messages by log level — "error" (includes warnings), "warning", "info", or "all" (default: all)
- clear: Set to true to clear the buffer after reading (useful for checking new messages after an action)

Returns: Timestamped list of console messages with their log level, or "(no console messages)" if the buffer is empty.

Errors: None — returns empty message if no entries match the filter.`,
      {
      level: z.enum(['error', 'warning', 'info', 'all']).optional().describe('Filter by log level'),
      clear: z.boolean().optional().describe('Clear the buffer after reading'),
    },
    async ({ level, clear }) => {
      await bm.ensureBrowser();
      let entries = consoleBuffer.toArray();
      if (level && level !== 'all') {
        if (level === 'error') {
          entries = entries.filter(e => e.level === 'error' || e.level === 'warning');
        } else {
          entries = entries.filter(e => e.level === level);
        }
      }
      if (clear) consoleBuffer.clear();
      if (entries.length === 0) return { content: [{ type: 'text' as const, text: '(no console messages)' }] };
      const text = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'pilot_network',
    `Retrieve network requests (XHR, fetch, navigation, static assets) from a circular buffer.
Use when the user wants to debug API calls, check request/response status codes, monitor network activity, or verify that a request was made after an action.

Parameters:
- clear: Set to true to clear the buffer after reading (useful for isolating new requests after an action)

Returns: List of requests showing method, URL, status code, duration in ms, and response size in bytes. Or "(no network requests)" if the buffer is empty.

Errors: None — returns empty message if no entries exist.`,
      { clear: z.boolean().optional().describe('Clear the buffer after reading') },
    async ({ clear }) => {
      await bm.ensureBrowser();
      if (clear) { networkBuffer.clear(); return { content: [{ type: 'text' as const, text: 'Network buffer cleared.' }] }; }
      if (networkBuffer.length === 0) return { content: [{ type: 'text' as const, text: '(no network requests)' }] };
      const text = networkBuffer.toArray().map(e =>
        `${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'pilot_dialog',
    `Retrieve captured browser dialog messages (alert, confirm, prompt) from a circular buffer.
Use when the user wants to see what native dialogs appeared on the page, check prompt text, or verify that a dialog was triggered after an action. Note: configure auto-handling with pilot_handle_dialog to prevent dialogs from blocking page interaction.

Parameters:
- clear: Set to true to clear the buffer after reading

Returns: Timestamped list of dialogs showing type (alert/confirm/prompt), message text, and the action taken (accepted/dismissed) with any response text. Or "(no dialogs captured)" if empty.

Errors: None — returns empty message if no dialogs were captured.`,
      { clear: z.boolean().optional().describe('Clear the buffer after reading') },
    async ({ clear }) => {
      await bm.ensureBrowser();
      if (clear) { dialogBuffer.clear(); return { content: [{ type: 'text' as const, text: 'Dialog buffer cleared.' }] }; }
      if (dialogBuffer.length === 0) return { content: [{ type: 'text' as const, text: '(no dialogs captured)' }] };
      const text = dialogBuffer.toArray().map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'pilot_evaluate',
    `Execute a JavaScript expression or function in the browser page context and return the result.
Use when the user wants to run custom JavaScript on the page, read or modify DOM elements, extract data, or perform calculations. Supports async/await — use "await" to wait for promises. Multi-line code with await is automatically wrapped in an async IIFE.

Parameters:
- expression: JavaScript expression to evaluate (e.g., "document.title", "JSON.stringify(localStorage)", "await fetch('/api').then(r => r.json())"). Maximum 50 KB.

Returns: The expression result as a string, or pretty-printed JSON for objects/arrays.

Errors:
- "Evaluation failed": The JavaScript threw an error. Fix the expression syntax or handle the error in the page context.
- "Promise rejected": An awaited promise rejected. Check the API endpoint or async logic.`,
      { expression: z.string().max(MAX_EXPRESSION_LENGTH).describe('JavaScript expression to evaluate (max 50 KB)') },
    async ({ expression }) => {
      await bm.ensureBrowser();
      try {
        const wrapped = wrapForEvaluate(expression);
        const result = await bm.getPage().evaluate(wrapped);
        const text = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_cookies',
    `Retrieve all cookies for the current page context as a JSON array.
Use when the user wants to inspect cookies, debug authentication state, check session tokens, or verify that cookies were set correctly. For setting individual cookies, use pilot_set_cookie; for bulk import from a real browser, use pilot_import_cookies.

Parameters: (none)

Returns: JSON array of cookie objects with name, value, domain, path, expires, httpOnly, secure, and sameSite attributes.

Errors: None — returns empty array "[]" if no cookies exist.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const cookies = await bm.getPage().context().cookies();
        return { content: [{ type: 'text' as const, text: JSON.stringify(cookies, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_storage',
    `Read or write browser web storage (localStorage and sessionStorage).
Use when the user wants to inspect stored application data, check feature flags, debug session state, or set a specific localStorage value. Sensitive values (tokens, secrets, API keys) are automatically redacted for security.

Parameters:
- set_key: If provided, sets this key in localStorage to the value in set_value
- set_value: The value to set for set_key in localStorage (omit to read all storage instead)

Returns: When reading: JSON object with localStorage and sessionStorage contents (sensitive values redacted as "[REDACTED — N chars]"). When writing: Confirmation of the key set.

Errors: None — returns empty storage objects if no data exists.

Security: Values matching patterns like "eyJ..." (JWTs), "sk-..." (API keys), or keys containing "token", "secret", "password" are auto-redacted.`,
      {
      set_key: z.string().optional().describe('Key to set in localStorage'),
      set_value: z.string().optional().describe('Value to set'),
    },
    async ({ set_key, set_value }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        if (set_key) {
          await page.evaluate(([k, v]) => localStorage.setItem(k, v), [set_key, set_value || '']);
          return { content: [{ type: 'text' as const, text: `Set localStorage["${set_key}"]` }] };
        }
        const storage = await page.evaluate(() => ({
          localStorage: { ...localStorage },
          sessionStorage: { ...sessionStorage },
        }));
        // Redact sensitive values
        const SENSITIVE_KEY = /(^|[_.-])(token|secret|key|password|credential|auth|jwt|session|csrf)($|[_.-])|api.?key/i;
        const SENSITIVE_VALUE = /^(eyJ|sk-|sk_live_|pk_live_|ghp_|gho_|github_pat_|xox[bpsa]-|AKIA|AIza|SG\.|Bearer\s|sbp_)/;
        const redacted = JSON.parse(JSON.stringify(storage));
        for (const storeType of ['localStorage', 'sessionStorage'] as const) {
          const store = redacted[storeType];
          if (!store) continue;
          for (const [key, value] of Object.entries(store)) {
            if (typeof value !== 'string') continue;
            if (SENSITIVE_KEY.test(key) || SENSITIVE_VALUE.test(value)) {
              store[key] = `[REDACTED — ${value.length} chars]`;
            }
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(redacted, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_perf',
    `Measure page load performance metrics from the Navigation Timing API.
Use when the user wants to diagnose slow page loads, benchmark performance, or identify bottlenecks in DNS lookup, connection, server response, or DOM parsing.

Parameters: (none)

Returns: Table of timing metrics in milliseconds — dns, tcp, ssl, ttfb (time to first byte), download, domParse, domReady, and load.

Errors:
- "No navigation timing data available": The page has not completed a navigation or was loaded via non-standard means. Navigate to the page first with pilot_navigate, then reload.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const timings = await bm.getPage().evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          if (!nav) return 'No navigation timing data available.';
          return {
            dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
            tcp: Math.round(nav.connectEnd - nav.connectStart),
            ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
            ttfb: Math.round(nav.responseStart - nav.requestStart),
            download: Math.round(nav.responseEnd - nav.responseStart),
            domParse: Math.round(nav.domInteractive - nav.responseEnd),
            domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
            load: Math.round(nav.loadEventEnd - nav.startTime),
          };
        });
        if (typeof timings === 'string') return { content: [{ type: 'text' as const, text: timings }] };
        const text = Object.entries(timings).map(([k, v]) => `${k.padEnd(12)} ${v}ms`).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
