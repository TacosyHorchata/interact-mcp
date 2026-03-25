import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';

export function registerIframeTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_frames',
    `List all frames (iframes) on the current page with their indices, names, and URLs.
Use when the user wants to see what iframes exist on the page, find an iframe to interact with, or verify the page structure before switching frame context. The main frame is always index 0. Use pilot_frame_select to switch into an iframe.

Parameters: (none)

Returns: Numbered list of frames showing index, type ([main] or [iframe name="..."]), URL, and an arrow (→) marking the currently active frame. Returns "(no iframes — only the main frame)" if no iframes exist.

Errors: None.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const frames = await bm.listFrames();
        if (frames.length <= 1) {
          return { content: [{ type: 'text' as const, text: '(no iframes — only the main frame)' }] };
        }
        const activeFrame = bm.getActiveFrame();
        const page = bm.getPage();
        const allFrames = page.frames();
        const text = frames.map(f => {
          const isCurrent = allFrames[f.index] === activeFrame;
          const marker = isCurrent ? '→ ' : '  ';
          const label = f.isMain ? '[main]' : `[iframe${f.name ? ` name="${f.name}"` : ''}]`;
          return `${marker}[${f.index}] ${label} ${f.url}`;
        }).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_frame_select',
    `Switch the browser context into an iframe so that pilot_snapshot, pilot_click, pilot_fill, and other tools operate inside that frame instead of the main page.
Use when the user wants to interact with elements inside an embedded iframe, read iframe content, or fill forms within an iframe. After switching, all refs are cleared — run pilot_snapshot to get fresh refs for the iframe contents. Use pilot_frames to list available frames first.

Parameters:
- index: Frame index number from pilot_frames output (e.g., 1, 2)
- name: Frame name attribute (alternative to index)

Returns: Confirmation with the frame index/name and its URL, plus a reminder to run pilot_snapshot for fresh refs.

Errors:
- "Frame not found": The index or name does not match any frame. Run pilot_frames to see valid indices and names.
- "Provide index or name": Neither parameter was supplied.`,
      {
      index: z.number().optional().describe('Frame index from pilot_frames output'),
      name: z.string().optional().describe('Frame name attribute'),
    },
    async ({ index, name }) => {
      await bm.ensureBrowser();
      try {
        if (index !== undefined) {
          const frame = bm.selectFrameByIndex(index);
          return { content: [{ type: 'text' as const, text: `Switched to frame ${index} (${frame.url()}). Refs cleared — run pilot_snapshot for fresh refs.` }] };
        }
        if (name) {
          const frame = bm.selectFrameByName(name);
          return { content: [{ type: 'text' as const, text: `Switched to frame "${name}" (${frame.url()}). Refs cleared — run pilot_snapshot for fresh refs.` }] };
        }
        return { content: [{ type: 'text' as const, text: 'Provide index or name. Use pilot_frames to list available frames.' }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_frame_reset',
    `Switch the browser context back to the main page frame after working inside an iframe.
Use when the user wants to return to the main page after interacting with an iframe. All refs are cleared — run pilot_snapshot to get fresh refs for the main page content.

Parameters: (none)

Returns: Confirmation of switching to the main frame, with a reminder to run pilot_snapshot.

Errors: None — always succeeds.`,
    {},
    async () => {
      await bm.ensureBrowser();
      bm.resetFrame();
      return { content: [{ type: 'text' as const, text: 'Switched to main frame. Refs cleared — run pilot_snapshot for fresh refs.' }] };
    }
  );
}
