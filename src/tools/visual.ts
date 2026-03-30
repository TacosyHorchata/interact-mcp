import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';
import { validateNavigationUrl } from '../url-validation.js';
import * as Diff from 'diff';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_DIR = process.platform === 'win32' ? os.tmpdir() : '/tmp';

export function validateOutputPath(outputPath: string): string {
  const allowed = process.env.PILOT_OUTPUT_DIR || os.tmpdir();
  let normalizedAllowed: string;
  try {
    normalizedAllowed = fs.realpathSync(path.resolve(allowed));
  } catch {
    normalizedAllowed = path.resolve(allowed);
  }
  try {
    const parentDir = path.dirname(outputPath);
    const realParent = fs.realpathSync(parentDir);
    const resolved = path.resolve(realParent, path.basename(outputPath));
    if (!resolved.startsWith(normalizedAllowed + path.sep) && resolved !== normalizedAllowed) {
      throw new Error(`Output path must be within ${normalizedAllowed}: ${outputPath}`);
    }
    return resolved;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Output path must be within')) {
      throw err;
    }
    const resolved = path.resolve(outputPath);
    if (!resolved.startsWith(normalizedAllowed + path.sep) && resolved !== normalizedAllowed) {
      throw new Error(`Output path must be within ${normalizedAllowed}: ${outputPath}`);
    }
    return resolved;
  }
}

async function getCleanText(page: import('playwright').Page): Promise<string> {
  return await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    return clone.innerText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  });
}

export function registerVisualTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_screenshot',
    `Take a PNG screenshot of the current page or a specific element.
Use when the user wants to capture what the page looks like visually, save a screenshot to disk, or capture a specific element's appearance. For a visual debug overlay with ref labels, use pilot_annotated_screenshot instead.

Parameters:
- ref: Element reference from snapshot (e.g., "@e3") or CSS selector to screenshot a specific element (omit for full page)
- full_page: Set to false for viewport-only capture (default: true, captures the entire scrollable page)
- output_path: File path to save the screenshot (default: /tmp/pilot-screenshot.png). Must be within the allowed output directory
- clip: Crop region as {x, y, width, height} pixel coordinates for a specific area of the page

Returns: The screenshot as a base64 PNG image and the file path where it was saved.

Errors:
- "Output path must be within ...": The path is outside the allowed directory. Set PILOT_OUTPUT_DIR or use /tmp.
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.`,
      {
      ref: z.string().optional().describe('Element ref or CSS selector to screenshot'),
      full_page: z.boolean().optional().describe('Capture full page (default: true)'),
      output_path: z.string().optional().describe('Output file path'),
      clip: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }).optional().describe('Clip region {x, y, width, height}'),
    },
    async ({ ref, full_page, output_path, clip }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ data: string; mimeType: string }>('screenshot');
          const screenshotPath = output_path ? validateOutputPath(output_path) : path.join(TEMP_DIR, 'pilot-screenshot.png');
          fs.writeFileSync(screenshotPath, Buffer.from(res.data, 'base64'));
          return {
            content: [
              { type: 'text' as const, text: `Screenshot saved: ${screenshotPath}` },
              { type: 'image' as const, data: res.data, mimeType: 'image/png' },
            ],
          };
        }
        const page = bm.getPage();
        const screenshotPath = output_path ? validateOutputPath(output_path) : path.join(TEMP_DIR, 'pilot-screenshot.png');

        if (ref) {
          const resolved = await bm.resolveRef(ref);
          const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
          await locator.screenshot({ path: screenshotPath, timeout: 5000 });
        } else if (clip) {
          await page.screenshot({ path: screenshotPath, clip });
        } else {
          await page.screenshot({ path: screenshotPath, fullPage: full_page !== false });
        }

        const imageData = fs.readFileSync(screenshotPath);
        const base64 = imageData.toString('base64');

        return {
          content: [
            { type: 'text' as const, text: `Screenshot saved: ${screenshotPath}` },
            { type: 'image' as const, data: base64, mimeType: 'image/png' },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_pdf',
    `Save the current page as a PDF document in A4 format.
Use when the user wants to export the page as a downloadable PDF, save a receipt, or archive a page for offline reading.

Parameters:
- output_path: File path to save the PDF (default: /tmp/pilot-page.pdf). Must be within the allowed output directory

Returns: Confirmation with the file path where the PDF was saved.

Errors:
- "Output path must be within ...": The path is outside the allowed directory. Set PILOT_OUTPUT_DIR or use /tmp.
- "Page is not HTML": The current page is a non-HTML resource (e.g., a binary download) and cannot be exported as PDF.`,
      { output_path: z.string().optional().describe('Output file path') },
    async ({ output_path }) => {
      await bm.ensureBrowser();
      try {
        const pdfPath = output_path ? validateOutputPath(output_path) : path.join(TEMP_DIR, 'pilot-page.pdf');
        await bm.getPage().pdf({ path: pdfPath, format: 'A4' });
        return { content: [{ type: 'text' as const, text: `PDF saved: ${pdfPath}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_responsive',
    `Capture full-page screenshots at three standard responsive breakpoints — mobile (375x812), tablet (768x1024), and desktop (1280x720).
Use when the user wants to preview how a page looks across different screen sizes, test responsive design, or generate viewport comparison screenshots. The browser viewport is restored to its original size after capture.

Parameters:
- output_prefix: File path prefix for the saved screenshots (default: /tmp/pilot-responsive). Files are saved as {prefix}-mobile.png, {prefix}-tablet.png, {prefix}-desktop.png

Returns: List of viewport names, dimensions, and file paths for each screenshot.

Errors:
- "Output path must be within ...": The prefix path is outside the allowed directory.
- Timeout: The page took too long to render at one of the viewports.`,
      { output_prefix: z.string().optional().describe('File path prefix for screenshots') },
    async ({ output_prefix }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const prefix = validateOutputPath(output_prefix || path.join(TEMP_DIR, 'pilot-responsive'));
        const viewports = [
          { name: 'mobile', width: 375, height: 812 },
          { name: 'tablet', width: 768, height: 1024 },
          { name: 'desktop', width: 1280, height: 720 },
        ];
        const originalViewport = page.viewportSize();
        const results: string[] = [];

        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          const filePath = `${prefix}-${vp.name}.png`;
          await page.screenshot({ path: filePath, fullPage: true });
          results.push(`${vp.name} (${vp.width}x${vp.height}): ${filePath}`);
        }

        if (originalViewport) await page.setViewportSize(originalViewport);

        return { content: [{ type: 'text' as const, text: results.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_diff',
    `Generate a text diff comparing the visible content of two URLs — useful for comparing staging vs production, before vs after deployments, or detecting content differences between pages.
Use when the user wants to see what text differs between two pages, verify a deployment did not break content, or compare two versions of the same site. Strips scripts, styles, and SVG before comparing.

Parameters:
- url1: The first URL to navigate to and capture (shown as removed lines "---" in the diff)
- url2: The second URL to navigate to and capture (shown as added lines "+++" in the diff)

Returns: Unified diff text showing lines removed from url1 and added in url2.

Errors:
- "Invalid URL": Either URL is malformed. Provide complete URLs with protocol.
- Timeout (15s): A page took too long to load. Check the URL or network connectivity.`,
      {
      url1: z.string().describe('First URL'),
      url2: z.string().describe('Second URL'),
    },
    async ({ url1, url2 }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        await validateNavigationUrl(url1);
        await page.goto(url1, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const text1 = await getCleanText(page);

        await validateNavigationUrl(url2);
        await page.goto(url2, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const text2 = await getCleanText(page);

        const changes = Diff.diffLines(text1, text2);
        const output: string[] = [`--- ${url1}`, `+++ ${url2}`, ''];

        for (const part of changes) {
          const prefix = part.added ? '+' : part.removed ? '-' : ' ';
          const lines = part.value.split('\n').filter(l => l.length > 0);
          for (const line of lines) {
            output.push(`${prefix} ${line}`);
          }
        }

        return { content: [{ type: 'text' as const, text: output.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
