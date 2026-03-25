import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { takeSnapshot, diffSnapshot, annotateScreenshot } from '../snapshot.js';
import { wrapError } from '../errors.js';
import * as fs from 'fs';

export function registerSnapshotTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_snapshot',
    `Capture an accessibility tree snapshot of the page with @eN refs for element selection.
Use when the user wants to see the page structure, find elements to interact with, or get refs for click/fill/hover. This is the primary way to understand what is on the page. Refs from this snapshot are used by pilot_click, pilot_fill, pilot_hover, pilot_select_option, and most other interaction tools.

Parameters:
- selector: CSS selector to scope the snapshot to a specific subtree (e.g., "#main-content")
- interactive_only: Set to true to show only interactive elements (buttons, links, inputs) — saves tokens on large pages
- compact: Set to true to remove empty structural nodes from the tree
- depth: Limit the tree depth (0 = root only). Useful for reducing token usage on deeply nested pages
- include_cursor_interactive: Set to true to scan for elements with cursor:pointer, onclick, or tabindex that are not in the ARIA tree — returns @cN refs
- max_elements: Maximum elements to include before truncating (saves tokens on very large pages)
- structure_only: Set to true to show tree structure without text content — saves tokens when you only need the element hierarchy

Returns: Text representation of the accessibility tree with @eN refs (and @cN refs if include_cursor_interactive is true).

Errors:
- Timeout: The page is too complex or unresponsive. Try scoping with selector or using max_elements.`,
      {
      selector: z.string().optional().describe('CSS selector to scope the snapshot'),
      interactive_only: z.boolean().optional().describe('Only show interactive elements (buttons, links, inputs)'),
      compact: z.boolean().optional().describe('Remove empty structural nodes'),
      depth: z.number().optional().describe('Limit tree depth (0 = root only)'),
      include_cursor_interactive: z.boolean().optional().describe('Scan for cursor:pointer/onclick/tabindex elements not in ARIA tree'),
      max_elements: z.number().optional().describe('Max elements to include before truncating (saves tokens on large pages)'),
      structure_only: z.boolean().optional().describe('Show tree structure without text content — saves tokens'),
    },
    async ({ selector, interactive_only, compact, depth, include_cursor_interactive, max_elements, structure_only }) => {
      await bm.ensureBrowser();
      try {
        const result = await takeSnapshot(bm, {
          selector,
          interactive: interactive_only,
          compact,
          depth,
          cursorInteractive: include_cursor_interactive,
          maxElements: max_elements,
          structureOnly: structure_only,
        });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_snapshot_diff',
    `Compare the current page state against the previously captured snapshot, showing a unified diff of what changed.
Use when the user wants to verify the effect of an action (click, fill, navigation), check if dynamic content loaded, or see what changed on the page without re-reading the entire snapshot. The first call stores a baseline; subsequent calls diff against it.

Parameters:
- selector: CSS selector to scope both snapshots to a specific subtree
- interactive_only: Set to true to only diff interactive elements (buttons, links, inputs)

Returns: Unified diff text showing added (+) and removed (-) lines between snapshots.

Errors:
- "No baseline snapshot": This is the first call — a baseline will be stored for future diffs.
- Timeout: The page is unresponsive.`,
      {
      selector: z.string().optional().describe('CSS selector to scope the snapshot'),
      interactive_only: z.boolean().optional().describe('Only show interactive elements'),
    },
    async ({ selector, interactive_only }) => {
      await bm.ensureBrowser();
      try {
        const result = await diffSnapshot(bm, {
          selector,
          interactive: interactive_only,
        });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_annotated_screenshot',
    `Take a PNG screenshot with red overlay boxes and ref labels at each @eN/@cN element position.
Use when the user wants a visual debug overlay showing where each snapshot ref is located on the page, or needs to verify element positions visually. Requires a prior pilot_snapshot call to populate the ref positions. For a clean visual capture without debug overlays, use pilot_screenshot instead.

Parameters:
- output_path: Optional file path to save the annotated screenshot (default: temp directory)

Returns: The annotated screenshot as a base64 PNG image and the file path where it was saved.

Errors:
- "No ref positions": Run pilot_snapshot first to capture element positions before taking an annotated screenshot.
- Timeout: The page is unresponsive.`,
      {
      output_path: z.string().optional().describe('Output file path for the screenshot'),
    },
    async ({ output_path }) => {
      await bm.ensureBrowser();
      try {
        const screenshotPath = await annotateScreenshot(bm, output_path);
        bm.resetFailures();

        // Read the image and return as base64
        const imageData = fs.readFileSync(screenshotPath);
        const base64 = imageData.toString('base64');

        return {
          content: [
            { type: 'text' as const, text: `Annotated screenshot saved: ${screenshotPath}` },
            { type: 'image' as const, data: base64, mimeType: 'image/png' },
          ],
        };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
