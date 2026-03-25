import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';

export function registerTabTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_tabs',
    `List all open browser tabs with their IDs, URLs, titles, and which tab is currently active.
Use when the user wants to see what tabs are open, find a specific tab by title or URL, or check which tab is active before switching.

Parameters: (none)

Returns: Numbered list of tabs showing [id], title, URL, and an arrow (→) marking the active tab.

Errors: None — returns empty list if no tabs exist (unlikely in normal operation).`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const tabs = await bm.getTabListWithTitles();
        const text = tabs.map(t =>
          `${t.active ? '→ ' : '  '}[${t.id}] ${t.title || '(untitled)'} — ${t.url}`
        ).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_tab_new',
    `Open a new browser tab, optionally navigating to a URL.
Use when the user wants to open a link in a new tab, create a blank tab, or work with multiple pages simultaneously.

Parameters:
- url: Optional URL to navigate to in the new tab (omit for a blank about:blank tab)

Returns: The new tab's ID and URL (if provided).

Errors:
- "Invalid URL": The URL is malformed. Provide a complete URL with protocol.`,
      { url: z.string().optional().describe('URL to navigate to in the new tab') },
    async ({ url }) => {
      await bm.ensureBrowser();
      try {
        const id = await bm.newTab(url);
        return { content: [{ type: 'text' as const, text: `Opened tab ${id}${url ? ` → ${url}` : ''}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_tab_close',
    `Close a browser tab by its ID, or close the currently active tab if no ID is specified.
Use when the user wants to close a popup, remove an unwanted tab, or clean up after finishing work in a tab.

Parameters:
- id: Tab ID to close (omit to close the current active tab). Use pilot_tabs to list tab IDs.

Returns: Confirmation that the tab was closed.

Errors:
- "No such tab": The provided tab ID does not exist. Run pilot_tabs to see valid IDs.
- "Cannot close last tab": The last remaining tab cannot be closed.`,
      { id: z.number().optional().describe('Tab ID to close') },
    async ({ id }) => {
      await bm.ensureBrowser();
      try {
        await bm.closeTab(id);
        return { content: [{ type: 'text' as const, text: `Closed tab${id ? ` ${id}` : ''}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_tab_select',
    `Switch the active browser context to a specific tab by its ID.
Use when the user wants to work in a different tab, bring a background tab to the foreground, or continue automation in a previously opened tab. Use pilot_tabs to find tab IDs.

Parameters:
- id: The tab ID to switch to (from pilot_tabs output)

Returns: Confirmation with the tab ID that is now active.

Errors:
- "No such tab": The provided tab ID does not exist. Run pilot_tabs to see valid IDs.`,
      { id: z.number().describe('Tab ID to switch to') },
    async ({ id }) => {
      await bm.ensureBrowser();
      try {
        bm.switchTab(id);
        return { content: [{ type: 'text' as const, text: `Switched to tab ${id}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
