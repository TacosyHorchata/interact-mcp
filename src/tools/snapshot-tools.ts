import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { takeSnapshot, diffSnapshot, annotateScreenshot } from '../snapshot.js';
import { wrapError } from '../errors.js';
import { validateOutputPath } from './visual.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

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
- output_file: Set to true to save the snapshot to a temp file instead of returning inline. Returns the file path — read with the Read tool when needed. Useful when the snapshot is large and you only need it on demand.

Returns: Text representation of the accessibility tree with @eN refs (and @cN refs if include_cursor_interactive is true).
If output_file=true: returns only the file path (e.g. /tmp/pilot-snap-abc123.txt).

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
      lean: z.boolean().optional().default(true).describe('Strip structural noise (empty rows/cells, separator text, duplicate labels). Default: true. Set false for raw ARIA tree.'),
      verbose: z.boolean().optional().describe('Alias for lean=false. Returns full ARIA tree with all structural nodes.'),
      output_file: z.boolean().optional().describe('Save snapshot to a temp file and return only the file path. Read with the Read tool when needed.'),
    },
    async ({ selector, interactive_only, compact, depth, include_cursor_interactive, max_elements, structure_only, lean, verbose, output_file }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ text: string; url: string; title: string; count: number }>('snapshot', {
            maxElements: max_elements ?? 200,
            interactive_only: interactive_only ?? false,
            structure_only: structure_only ?? false,
            lean: verbose ? false : (lean !== false),
            maxDepth: depth,
          });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `[extension] ${res.title} — ${res.url}\n${res.text}` }] };
        }
        const result = await takeSnapshot(bm, {
          selector,
          interactive: interactive_only,
          compact,
          depth,
          cursorInteractive: include_cursor_interactive,
          maxElements: max_elements,
          structureOnly: structure_only,
          lean: verbose ? false : (lean !== false),
        });
        bm.resetFailures();
        if (output_file) {
          const snapPath = path.join(os.tmpdir(), `pilot-snap-${crypto.randomBytes(6).toString('hex')}.txt`);
          fs.writeFileSync(snapPath, result, 'utf8');
          return { content: [{ type: 'text' as const, text: snapPath }] };
        }
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
      lean: z.boolean().optional().default(true).describe('Strip structural noise. Default: true.'),
    },
    async ({ selector, interactive_only, lean }) => {
      await bm.ensureBrowser();
      try {
        const result = await diffSnapshot(bm, {
          selector,
          interactive: interactive_only,
          lean: lean !== false,
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
    'pilot_find',
    `Find an element by visible text, label, placeholder, or role — without running a full snapshot.
Use when you know what you want to click or fill but don't need to see the entire page tree. Returns a @eN ref immediately usable by pilot_click, pilot_fill, pilot_hover, and other interaction tools. Saves tokens compared to pilot_snapshot when you only need one element.

Parameters:
- text: Visible text content of the element (e.g., "Sign in", "Submit")
- label: ARIA label or associated <label> text (e.g., "Email address", "Password")
- placeholder: Input placeholder text (e.g., "Search...", "Enter email")
- role: ARIA role to match (e.g., "button", "link", "textbox") — combine with text for precision
- exact: Set to true for exact text/label match (default: false, substring match)

Returns: A @eN ref for the found element and a description of what was found.

Errors:
- "Element not found": No element matched the criteria. Verify the text/label or run pilot_snapshot to inspect the page.
- "Multiple elements found": More than one element matched. Add role or use exact=true to narrow it down.`,
    {
      text: z.string().optional().describe('Visible text content to find'),
      label: z.string().optional().describe('ARIA label or <label> text'),
      placeholder: z.string().optional().describe('Input placeholder text'),
      role: z.string().optional().describe('ARIA role (e.g., "button", "link", "textbox")'),
      exact: z.boolean().optional().describe('Exact match (default: false = substring)'),
    },
    async ({ text, label, placeholder, role, exact }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ ref: string; tag: string; text: string }>('find', { text, label, role, placeholder });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Found ${res.ref} [${res.tag}] "${res.text}"` }] };
        }
        const frame = bm.getActiveFrame();
        const exactMatch = exact ?? false;

        let locator;
        let description = '';

        if (role && text) {
          locator = frame.getByRole(role as any, { name: text, exact: exactMatch });
          description = `[${role}] "${text}"`;
        } else if (label) {
          locator = frame.getByLabel(label, { exact: exactMatch });
          description = `label="${label}"`;
        } else if (placeholder) {
          locator = frame.getByPlaceholder(placeholder, { exact: exactMatch });
          description = `placeholder="${placeholder}"`;
        } else if (role) {
          locator = frame.getByRole(role as any);
          description = `[${role}]`;
        } else if (text) {
          locator = frame.getByText(text, { exact: exactMatch });
          description = `"${text}"`;
        } else {
          return { content: [{ type: 'text' as const, text: 'Provide at least one of: text, label, placeholder, role' }], isError: true };
        }

        const count = await locator.count();
        if (count === 0) {
          return { content: [{ type: 'text' as const, text: `Element not found: ${description}` }], isError: true };
        }
        if (count > 1) {
          const hint = role && text ? 'use exact=true to require an exact match' : role ? 'add text or label to narrow it down' : 'add role or use exact=true to narrow it down';
          return { content: [{ type: 'text' as const, text: `Multiple elements found (${count}) for ${description} — ${hint}` }], isError: true };
        }

        const resolvedRole = role || (label ? 'input' : text ? 'generic' : 'generic');
        const resolvedName = text || label || placeholder || '';
        const ref = bm.addSingleRef(locator.first(), resolvedRole, resolvedName);
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Found @${ref} ${description}` }] };
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
        const validatedPath = output_path ? validateOutputPath(output_path) : undefined;
        const screenshotPath = await annotateScreenshot(bm, validatedPath);
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
