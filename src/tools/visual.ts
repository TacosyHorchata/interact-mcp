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
  const allowedDir = process.env.PILOT_OUTPUT_DIR || os.tmpdir();
  const resolved = path.resolve(outputPath);
  const normalizedAllowed = path.resolve(allowedDir);
  if (!resolved.startsWith(normalizedAllowed + path.sep) && resolved !== normalizedAllowed) {
    throw new Error(`Output path must be within ${allowedDir}, got: ${outputPath}`);
  }
  return resolved;
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
    'Take a screenshot of the page or a specific element.',
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
    'Save the current page as a PDF.',
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
    'Take screenshots at mobile (375x812), tablet (768x1024), and desktop (1280x720).',
    { output_prefix: z.string().optional().describe('File path prefix for screenshots') },
    async ({ output_prefix }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const prefix = output_prefix || path.join(TEMP_DIR, 'pilot-responsive');
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
    'Text diff between two URLs — compare staging vs production, etc.',
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
