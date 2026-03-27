import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';

export function registerAutomationTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_intercept',
    `Intercept network requests matching a URL pattern and respond with custom status, headers, and body.
Use when the user wants to mock API responses, simulate error states (401, 500), test loading states, or run frontend tests without a real backend. All requests matching the pattern are fulfilled with the given response until cleared.

Parameters:
- pattern: URL glob pattern to intercept (e.g., "**/api/users", "*/auth*")
- response: Custom response — status (default 200), body (JSON string or text), headers, contentType
- clear: Set to true to remove all active intercepts

Returns:
- Add mode: Confirmation and list of active intercepts.
- clear mode: Confirmation that all intercepts were removed.

Errors:
- "Browser not launched": Navigate to a URL first.`,
    {
      pattern: z.string().optional().describe('URL glob pattern to intercept (e.g., "**/api/users")'),
      response: z.object({
        status: z.number().optional().describe('HTTP status code (default: 200)'),
        body: z.string().optional().describe('Response body as a string (JSON, HTML, or plain text)'),
        headers: z.record(z.string()).optional().describe('Custom response headers'),
        contentType: z.string().optional().describe('Content-Type header (e.g., "application/json")'),
      }).optional().describe('Custom response to return for matched requests'),
      clear: z.boolean().optional().describe('Remove all active intercepts'),
    },
    async ({ pattern, response, clear }) => {
      await bm.ensureBrowser();
      try {
        if (clear) {
          await bm.clearIntercepts();
          return { content: [{ type: 'text' as const, text: 'All intercepts cleared.' }] };
        }
        if (!pattern) {
          const active = bm.getIntercepts();
          return { content: [{ type: 'text' as const, text: active.length > 0 ? `Active intercepts (${active.length}):\n${active.map(i => `  ${i.pattern} → ${i.status}`).join('\n')}` : 'No active intercepts.' }] };
        }
        await bm.addIntercept(pattern, response ?? {});
        const active = bm.getIntercepts();
        return {
          content: [{
            type: 'text' as const,
            text: `Intercepting ${pattern} → ${response?.status ?? 200}. Active intercepts (${active.length}):\n${active.map(i => `  ${i.pattern} → ${i.status}`).join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_assert',
    `Assert a condition about the current page state and fail with a structured error if the assertion is not met.
Use when the user wants to verify the outcome of an action — that a URL was reached, text is present or absent, an element is visible/hidden/enabled, or an input has a specific value. Returns a clear pass/fail signal for agent-driven test flows.

Parameters:
- url: Assert the current page URL equals or contains this string
- text_present: Assert this text is visible somewhere on the page (waits up to 5s)
- text_absent: Assert this text is NOT visible on the page
- ref: Element ref (@eN) to assert a state or value on
- state: Expected element state — "visible", "hidden", "enabled", or "disabled"
- value: Expected input value for the element pointed to by ref

Returns: "✓ N assertion(s) passed" if all checks pass.

Errors:
- Returns isError=true with details of which assertion failed and what was found instead.`,
    {
      url: z.string().optional().describe('Assert current URL equals or contains this string'),
      text_present: z.string().optional().describe('Assert this text is visible on the page'),
      text_absent: z.string().optional().describe('Assert this text is NOT visible on the page'),
      ref: z.string().optional().describe('Element ref (@eN) to check state or value'),
      state: z.enum(['visible', 'hidden', 'enabled', 'disabled']).optional().describe('Expected element state'),
      value: z.string().optional().describe('Expected input value for the element ref'),
    },
    async ({ url, text_present, text_absent, ref, state, value }) => {
      await bm.ensureBrowser();
      const failures: string[] = [];
      let checks = 0;

      try {
        const page = bm.getPage();

        if (url !== undefined) {
          checks++;
          const currentUrl = page.url();
          if (!currentUrl.includes(url) && currentUrl !== url) {
            failures.push(`url: expected "${url}", got "${currentUrl}"`);
          }
        }

        if (text_present !== undefined) {
          checks++;
          try {
            await page.getByText(text_present).first().waitFor({ state: 'visible', timeout: 5000 });
          } catch {
            failures.push(`text_present: "${text_present}" not visible on page`);
          }
        }

        if (text_absent !== undefined) {
          checks++;
          const isVisible = await page.getByText(text_absent).first().isVisible();
          if (isVisible) {
            failures.push(`text_absent: "${text_absent}" is visible on page (expected absent)`);
          }
        }

        if (ref !== undefined) {
          try {
            const resolved = await bm.resolveRef(ref);
            const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);

            if (state !== undefined) {
              checks++;
              const isVisible = await locator.isVisible();
              const isEnabled = await locator.isEnabled();
              if (state === 'visible' && !isVisible) {
                failures.push(`${ref} state: expected "visible", element is hidden`);
              } else if (state === 'hidden' && isVisible) {
                failures.push(`${ref} state: expected "hidden", element is visible`);
              } else if (state === 'enabled' && !isEnabled) {
                failures.push(`${ref} state: expected "enabled", element is disabled`);
              } else if (state === 'disabled' && isEnabled) {
                failures.push(`${ref} state: expected "disabled", element is enabled`);
              }
            }

            if (value !== undefined) {
              checks++;
              const actualValue = await locator.inputValue().catch(() => null);
              if (actualValue === null) {
                const textContent = await locator.textContent().catch(() => '');
                if ((textContent ?? '').trim() !== value) {
                  failures.push(`${ref} value: expected "${value}", got "${(textContent ?? '').trim()}"`);
                }
              } else if (actualValue !== value) {
                failures.push(`${ref} value: expected "${value}", got "${actualValue}"`);
              }
            }

            // ref with no sub-checks = existence assertion
            if (state === undefined && value === undefined) {
              checks++;
            }
          } catch (err) {
            checks++;
            failures.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (checks === 0) {
          return { content: [{ type: 'text' as const, text: 'No assertions provided. Specify url, text_present, text_absent, ref+state, or ref+value.' }], isError: true };
        }

        if (failures.length > 0) {
          return { content: [{ type: 'text' as const, text: `✗ ${failures.length}/${checks} assertion(s) failed:\n${failures.join('\n')}` }], isError: true };
        }

        return { content: [{ type: 'text' as const, text: `✓ ${checks} assertion(s) passed` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_clipboard',
    `Read from or write to the browser clipboard.
Use when the user wants to read content that an app copied to clipboard (share links, API keys, generated tokens), or pre-populate clipboard with text for paste operations.

Parameters:
- action: "get" — read current clipboard text; "set" — write text to clipboard
- text: Text to write when action is "set"

Returns:
- get: The current clipboard text content.
- set: Confirmation that text was written to clipboard.

Errors:
- "Clipboard read failed": Browser security policy blocked clipboard access. Try in headed mode (pilot_handoff).`,
    {
      action: z.enum(['get', 'set']).describe('"get" to read clipboard, "set" to write'),
      text: z.string().optional().describe('Text to write to clipboard (required for action="set")'),
    },
    async ({ action, text }) => {
      await bm.ensureBrowser();
      try {
        const ctx = bm.getContext();
        const page = bm.getPage();

        if (action === 'set') {
          if (text === undefined) {
            return { content: [{ type: 'text' as const, text: 'text is required for action="set"' }], isError: true };
          }
          await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
          await page.evaluate((t) => navigator.clipboard.writeText(t), text);
          return { content: [{ type: 'text' as const, text: `Clipboard set (${text.length} chars)` }] };
        }

        // get
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
        const content = await page.evaluate(() => navigator.clipboard.readText());
        return { content: [{ type: 'text' as const, text: content || '(clipboard is empty)' }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('clipboard') || msg.includes('permission')) {
          return { content: [{ type: 'text' as const, text: `Clipboard read failed — browser security policy blocked access. Use pilot_handoff to switch to headed mode where clipboard is accessible.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
