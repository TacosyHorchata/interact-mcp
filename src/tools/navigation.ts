import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { takeSnapshot, pageContentPreview } from '../snapshot.js';
import { wrapError } from '../errors.js';
import { validateNavigationUrl } from '../url-validation.js';

export function registerNavigationTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_navigate',
    `Navigate the browser to a URL and wait for DOM content to load.
Use when the user wants to go to a specific webpage, URL, or link.

For read tasks ("go to X and tell me Y"), prefer pilot_get — it returns full readable
content + interactive elements in one call, eliminating a follow-up snapshot call.

Parameters:
- url: The URL to navigate to (e.g., "https://example.com" or relative paths)

Returns: Confirmation message with the HTTP status code, content preview, and interactive elements.

Errors:
- "Invalid URL": The URL format is malformed. Provide a complete URL including the protocol.
- Timeout (15s): The page took too long to load. Try pilot_navigate again or check the URL.
- "Navigation denied": The URL was rejected by security validation (e.g., file:// on restricted origins).`,
    { url: z.string().describe('URL to navigate to (e.g., "https://example.com")') },
    async ({ url }) => {
      await bm.ensureBrowser();
      try {
        await validateNavigationUrl(url);
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ url: string }>('navigate', { url });
          const snap = await bm.extSend<{ text: string }>('snapshot', { maxElements: 30 });
          return { content: [{ type: 'text' as const, text: `Navigated to ${res.url}\n--- interactive elements ---\n${snap.text}` }] };
        }
        const page = bm.getPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status = response?.status() || 'unknown';
        bm.resetFailures();
        let snap = '';
        try {
          const [preview, interactive] = await Promise.all([
            pageContentPreview(page),
            takeSnapshot(bm, { interactive: true, maxElements: 30, lean: true }),
          ]);
          snap = `\n--- content preview ---\n${preview}\n--- interactive elements ---\n${interactive}`;
        } catch {}
        return { content: [{ type: 'text' as const, text: `Navigated to ${url} (${status})${snap}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_back',
    `Navigate back to the previous page in browser history.
Use when the user wants to go back to the prior page they visited.

Parameters: (none)

Returns: The URL of the page after navigating back.

Errors:
- "No previous page in history": There is nothing to go back to. Use pilot_navigate instead.
- Timeout (15s): The previous page took too long to load.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ url: string }>('back');
          return { content: [{ type: 'text' as const, text: `Back → ${res.url}` }] };
        }
        const page = bm.getPage();
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Back → ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_forward',
    `Navigate forward to the next page in browser history.
Use when the user wants to go forward after using pilot_back.

Parameters: (none)

Returns: The URL of the page after navigating forward.

Errors:
- "No next page in history": There is nothing to go forward to. Use pilot_navigate instead.
- Timeout (15s): The next page took too long to load.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ url: string }>('forward');
          return { content: [{ type: 'text' as const, text: `Forward → ${res.url}` }] };
        }
        const page = bm.getPage();
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Forward → ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_reload',
    `Reload the current page, waiting for DOM content to load.
Use when the user wants to refresh the page, clear dynamic state, or retry a failed load.

Parameters: (none)

Returns: The URL of the reloaded page.

Errors:
- Timeout (15s): The page took too long to reload. Try again or check network connectivity.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ url: string }>('reload');
          return { content: [{ type: 'text' as const, text: `Reloaded ${res.url}` }] };
        }
        const page = bm.getPage();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Reloaded ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_get',
    `Navigate to a URL and return its full readable content + interactive elements in one call.

Use this as the primary tool for "go to X and find Y" read tasks. It combines navigation
and content extraction, eliminating the need for a separate snapshot call.

Parameters:
- url: The URL to fetch

Returns: Page title, readable body text (up to 1500 chars), and interactive elements.
         Enough context to answer most read questions without additional tool calls.

Errors:
- Timeout (15s): The page took too long to load.`,
    { url: z.string().describe('URL to navigate to') },
    async ({ url }) => {
      await bm.ensureBrowser();
      try {
        await validateNavigationUrl(url);
        const page = bm.getPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        const [preview, interactive] = await Promise.all([
          pageContentPreview(page),
          takeSnapshot(bm, { lean: true, maxElements: 50 }),
        ]);
        const text = `${page.url()}\n\n--- content ---\n${preview}\n\n--- interactive ---\n${interactive}`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
