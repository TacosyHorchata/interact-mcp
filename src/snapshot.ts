/**
 * Snapshot — accessibility tree with ref-based element selection.
 * Adapted from gstack browse/src/snapshot.ts.
 *
 * Architecture (no DOM mutation):
 *   1. page.locator(scope).ariaSnapshot() → YAML-like accessibility tree
 *   2. Parse tree, assign refs @e1, @e2, ...
 *   3. Build Playwright Locator for each ref (getByRole + nth)
 *   4. Store Map<string, RefEntry> on BrowserManager
 *   5. Return compact text output with refs prepended
 */

import type { Page, Locator, Frame } from 'playwright';
import type { BrowserManager } from './browser-manager.js';
import type { RefEntry, SnapshotOptions } from './types.js';
import * as Diff from 'diff';
import * as os from 'os';
import * as path from 'path';

const TEMP_DIR = process.platform === 'win32' ? os.tmpdir() : '/tmp';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

/** Structural roles that are noise in lean mode when they have no unique content */
const STRUCTURAL_ROLES = new Set([
  'table', 'rowgroup', 'row', 'cell', 'grid', 'gridcell',
  'group', 'list', 'listitem', 'tree', 'treegrid',
]);

/** Text content that is just visual separators — no semantic value */
const SEPARATOR_PATTERN = /^[|()·•–—:,\s]+$/;

interface ParsedNode {
  indent: number;
  role: string;
  name: string | null;
  props: string;
  children: string;
  rawLine: string;
}

function parseLine(line: string): ParsedNode | null {
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ?? null,
    props: match[4] || '',
    children: match[5]?.trim() || '',
    rawLine: line,
  };
}

export async function takeSnapshot(
  bm: BrowserManager,
  opts: SnapshotOptions = {}
): Promise<string> {
  const frame = bm.getActiveFrame();

  let rootLocator: Locator;
  if (opts.selector) {
    rootLocator = frame.locator(opts.selector);
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  } else {
    rootLocator = frame.locator('body');
  }

  const ariaText = await rootLocator.ariaSnapshot();
  if (!ariaText || ariaText.trim().length === 0) {
    bm.setRefMap(new Map());
    return '(no accessible elements found)';
  }

  const lines = ariaText.split('\n');
  const refMap = new Map<string, RefEntry>();
  const output: string[] = [];
  let refCounter = 1;
  let truncated = false;
  let skippedCount = 0;

  const roleNameCounts = new Map<string, number>();
  const roleNameSeen = new Map<string, number>();

  // First pass: count role+name pairs
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;
    const key = `${node.role}:${node.name || ''}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
  }

  // Second pass: assign refs and build locators
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;

    const depth = Math.floor(node.indent / 2);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    if (opts.depth !== undefined && depth > opts.depth) continue;

    if (opts.interactive && !isInteractive) {
      const key = `${node.role}:${node.name || ''}`;
      roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
      continue;
    }

    if (opts.compact && !isInteractive && !node.name && !node.children) continue;

    // ─── Lean mode: strip structural noise ──────────────
    if (opts.lean) {
      // Skip empty structural nodes (row/cell/table with no meaningful content)
      if (STRUCTURAL_ROLES.has(node.role) && !node.name && !node.children) continue;
      // Skip structural nodes whose name just repeats children (cell "Hacker News..." when children have the links)
      if (STRUCTURAL_ROLES.has(node.role) && node.name && !isInteractive) continue;
      // Skip text nodes that are just separators (strip surrounding quotes first)
      const textContent = (node.children || node.name || '').replace(/^"|"$/g, '').trim();
      if (node.role === 'text' && SEPARATOR_PATTERN.test(textContent)) continue;
    }

    // ─── Max elements truncation ───────────────────────
    if (opts.maxElements && refCounter > opts.maxElements) {
      skippedCount++;
      truncated = true;
      continue;
    }

    const ref = `e${refCounter++}`;
    const indent = '  '.repeat(depth);

    const key = `${node.role}:${node.name || ''}`;
    const seenIndex = roleNameSeen.get(key) || 0;
    roleNameSeen.set(key, seenIndex + 1);
    const totalCount = roleNameCounts.get(key) || 1;

    let locator: Locator;
    if (opts.selector) {
      locator = frame.locator(opts.selector).getByRole(node.role as any, {
        name: node.name || undefined,
      });
    } else {
      locator = frame.getByRole(node.role as any, {
        name: node.name || undefined,
      });
    }

    if (totalCount > 1) {
      locator = locator.nth(seenIndex);
    }

    refMap.set(ref, { locator, role: node.role, name: node.name || '' });

    const displayIndent = opts.lean ? ' '.repeat(depth) : indent;
    let outputLine = `${displayIndent}@${ref} [${node.role}]`;
    if (node.name && !opts.structureOnly) outputLine += ` "${node.name}"`;
    if (node.props) outputLine += ` ${node.props}`;
    if (node.children && !opts.structureOnly) outputLine += `: ${node.children}`;

    output.push(outputLine);
  }

  // ─── Cursor-interactive scan ─────────────────────────
  if (opts.cursorInteractive) {
    try {
      const cursorElements = await frame.evaluate(() => {
        const STANDARD_INTERACTIVE = new Set([
          'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS',
        ]);
        const results: Array<{ selector: string; text: string; reason: string }> = [];
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
          if (STANDARD_INTERACTIVE.has(el.tagName)) continue;
          if (!(el as HTMLElement).offsetParent && el.tagName !== 'BODY') continue;

          const style = getComputedStyle(el);
          const hasCursorPointer = style.cursor === 'pointer';
          const hasOnclick = el.hasAttribute('onclick');
          const hasTabindex = el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex')!, 10) >= 0;
          const hasRole = el.hasAttribute('role');

          if (!hasCursorPointer && !hasOnclick && !hasTabindex) continue;
          if (hasRole) continue;

          const parts: string[] = [];
          let current: Element | null = el;
          while (current && current !== document.documentElement) {
            const parent: Element | null = current.parentElement;
            if (!parent) break;
            const siblings = [...parent.children];
            const index = siblings.indexOf(current) + 1;
            parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
            current = parent;
          }
          const selector = parts.join(' > ');
          const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || el.tagName.toLowerCase();
          const reasons: string[] = [];
          if (hasCursorPointer) reasons.push('cursor:pointer');
          if (hasOnclick) reasons.push('onclick');
          if (hasTabindex) reasons.push(`tabindex=${el.getAttribute('tabindex')}`);

          results.push({ selector, text, reason: reasons.join(', ') });
        }
        return results;
      });

      if (cursorElements.length > 0) {
        output.push('');
        output.push('── cursor-interactive (not in ARIA tree) ──');
        let cRefCounter = 1;
        for (const elem of cursorElements) {
          const ref = `c${cRefCounter++}`;
          const locator = frame.locator(elem.selector);
          refMap.set(ref, { locator, role: 'cursor-interactive', name: elem.text });
          output.push(`@${ref} [${elem.reason}] "${elem.text}"`);
        }
      }
    } catch {
      output.push('');
      output.push('(cursor scan failed — CSP restriction)');
    }
  }

  bm.setRefMap(refMap);

  if (output.length === 0) {
    return '(no interactive elements found)';
  }

  if (truncated) {
    output.push('');
    output.push(`── truncated: ${skippedCount} more elements not shown (use max_elements to adjust) ──`);
  }

  const snapshotText = output.join('\n');
  bm.setLastSnapshot(snapshotText);
  return snapshotText;
}

export async function diffSnapshot(
  bm: BrowserManager,
  opts: SnapshotOptions = {}
): Promise<string> {
  const frame = bm.getActiveFrame();

  let rootLocator: Locator;
  if (opts.selector) {
    rootLocator = frame.locator(opts.selector);
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  } else {
    rootLocator = frame.locator('body');
  }

  // Save previous snapshot BEFORE takeSnapshot overwrites it
  const lastSnapshot = bm.getLastSnapshot();

  // Take a fresh snapshot (this updates bm.lastSnapshot internally)
  const currentText = await takeSnapshot(bm, opts);

  if (!lastSnapshot || lastSnapshot === currentText) {
    if (!lastSnapshot) {
      return currentText + '\n\n(no previous snapshot to diff against — this snapshot stored as baseline)';
    }
    return '(no changes detected)';
  }

  const changes = Diff.diffLines(lastSnapshot, currentText);
  const diffOutput: string[] = ['--- previous snapshot', '+++ current snapshot', ''];

  for (const part of changes) {
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    const diffLines = part.value.split('\n').filter(l => l.length > 0);
    for (const line of diffLines) {
      diffOutput.push(`${prefix} ${line}`);
    }
  }

  bm.setLastSnapshot(currentText);
  return diffOutput.join('\n');
}

/**
 * Extract readable content from the page: title + main body text.
 * Used to enrich navigate responses so the LLM can answer read-tasks
 * without a separate snapshot call.
 */
export async function pageContentPreview(page: Page): Promise<string> {
  const [title, body] = await Promise.all([
    page.title().catch(() => ''),
    page.evaluate(() => {
      const main = document.querySelector('main, [role="main"], article, #content, .content, #main');
      const el = (main as HTMLElement) || document.body;
      return (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
    }).catch(() => ''),
  ]);
  const parts: string[] = [];
  if (title) parts.push(`title: ${title}`);
  if (body) parts.push(body);
  return parts.join('\n\n');
}

export async function annotateScreenshot(
  bm: BrowserManager,
  outputPath?: string
): Promise<string> {
  const page = bm.getPage();
  const screenshotPath = outputPath || path.join(TEMP_DIR, 'pilot-annotated.png');

  // Get all ref bounding boxes
  const refMap = (bm as any).refMap as Map<string, RefEntry>;
  if (!refMap || refMap.size === 0) {
    throw new Error('No refs available. Run pilot_snapshot first.');
  }

  const boxes: Array<{ ref: string; box: { x: number; y: number; width: number; height: number } }> = [];
  for (const [ref, entry] of refMap) {
    try {
      const box = await entry.locator.boundingBox({ timeout: 1000 });
      if (box) {
        boxes.push({ ref: `@${ref}`, box });
      }
    } catch {}
  }

  // Inject overlay divs
  await page.evaluate((boxes) => {
    for (const { ref, box } of boxes) {
      const overlay = document.createElement('div');
      overlay.className = '__pilot_annotation__';
      overlay.style.cssText = `
        position: absolute; top: ${box.y}px; left: ${box.x}px;
        width: ${box.width}px; height: ${box.height}px;
        border: 2px solid red; background: rgba(255,0,0,0.1);
        pointer-events: none; z-index: 99999;
        font-size: 10px; color: red; font-weight: bold;
      `;
      const label = document.createElement('span');
      label.textContent = ref;
      label.style.cssText = 'position: absolute; top: -14px; left: 0; background: red; color: white; padding: 0 3px; font-size: 10px;';
      overlay.appendChild(label);
      document.body.appendChild(overlay);
    }
  }, boxes);

  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Remove overlays
  await page.evaluate(() => {
    document.querySelectorAll('.__pilot_annotation__').forEach(el => el.remove());
  });

  return screenshotPath;
}
