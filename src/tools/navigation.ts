import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';
import { validateNavigationUrl } from '../url-validation.js';

export function registerNavigationTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_navigate',
    `Navigate the browser to a URL and wait for DOM content to load.
Use when the user wants to go to a specific webpage, URL, or link.

Parameters:
- url: The URL to navigate to (e.g., "https://example.com" or relative paths)

Returns: Confirmation message with the HTTP status code and final URL after redirects.

Errors:
- "Invalid URL": The URL format is malformed. Provide a complete URL including the protocol.
- Timeout (15s): The page took too long to load. Try pilot_navigate again or check the URL.
- "Navigation denied": The URL was rejected by security validation (e.g., file:// on restricted origins).`,
    { url: z.string().describe('URL to navigate to (e.g., "https://example.com")') },
    async ({ url }) => {
      await bm.ensureBrowser();
      try {
        await validateNavigationUrl(url);
        const page = bm.getPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status = response?.status() || 'unknown';
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Navigated to ${url} (${status})` }] };
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
}
