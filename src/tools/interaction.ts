import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { takeSnapshot } from '../snapshot.js';
import { wrapError } from '../errors.js';
import * as fs from 'fs';
import * as path from 'path';

/** After an action, take a lightweight snapshot so the LLM doesn't need a separate call */
async function postActionSnapshot(bm: BrowserManager): Promise<string> {
  try {
    const snap = await takeSnapshot(bm, { interactive: true, maxElements: 20, lean: true });
    return '\n--- page state (interactive, top 20) ---\n' + snap;
  } catch {
    return '';
  }
}

export function registerInteractionTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_click',
    `Click an element on the page using a ref from pilot_snapshot or a CSS selector.
Use when the user wants to press a button, follow a link, check a checkbox, or interact with any clickable element. Auto-routes clicks on <option> elements to pilot_select_option.

Parameters:
- ref: Element reference from snapshot (e.g., "@e3") or a CSS selector (e.g., "button.submit")
- button: Mouse button to click — "left" (default), "right" (context menu), or "middle"
- double_click: Set to true for a double-click instead of single click

Returns: Confirmation with the clicked ref and the current URL after navigation (if any).

Errors:
- "Element not found": The ref is stale or the selector matches nothing. Run pilot_snapshot to get fresh refs.
- "Element is not clickable": The element exists but is obscured or disabled. Try scrolling to it first with pilot_scroll.
- "Timeout": The click triggered a navigation that took too long. The page may still be loading.`,
      {
      ref: z.string().describe('Element ref (@e3) or CSS selector'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
      double_click: z.boolean().optional().describe('Double-click instead of single click'),
    },
    async ({ ref, button, double_click }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          await bm.extSend('click', { ref, button, double_click });
          bm.resetFailures();
          const snap = await ext.send<{ text: string }>('snapshot', { maxElements: 20 });
          return { content: [{ type: 'text' as const, text: `Clicked ${ref}\n--- page state ---\n${snap.text}` }] };
        }
        const page = bm.getPage();

        // Auto-route: if ref points to a <option>, use selectOption
        const role = bm.getRefRole(ref);
        if (role === 'option') {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            const optionInfo = await resolved.locator.evaluate(el => {
              if (el.tagName !== 'OPTION') return null;
              const option = el as HTMLOptionElement;
              const select = option.closest('select');
              if (!select) return null;
              return { value: option.value, text: option.text };
            });
            if (optionInfo) {
              await resolved.locator.locator('xpath=ancestor::select').selectOption(optionInfo.value, { timeout: 5000 });
              bm.resetFailures();
              const snap = await postActionSnapshot(bm);
              return { content: [{ type: 'text' as const, text: `Selected "${optionInfo.text}" (auto-routed from click on <option>) → now at ${page.url()}${snap}` }] };
            }
          }
        }

        const resolved = await bm.resolveRef(ref);
        const clickOptions: any = { timeout: 5000 };
        if (button) clickOptions.button = button;
        if (double_click) clickOptions.clickCount = 2;

        if ('locator' in resolved) {
          await resolved.locator.click(clickOptions);
        } else {
          await page.click(resolved.selector, clickOptions);
        }
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        bm.resetFailures();
        const snap = await postActionSnapshot(bm);
        return { content: [{ type: 'text' as const, text: `Clicked ${ref} → now at ${page.url()}${snap}` }] };
      } catch (err) {
        bm.incrementFailures();
        const hint = bm.getFailureHint();
        let msg = wrapError(err);
        if (hint) msg += '\n' + hint;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_hover',
    `Hover the mouse over an element, triggering hover states, tooltips, and dropdown menus.
Use when the user wants to reveal hidden content, trigger a CSS :hover effect, or inspect tooltip text.

Parameters:
- ref: Element reference from snapshot (e.g., "@e7") or a CSS selector

Returns: Confirmation with the hovered element ref.

Errors:
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.
- Timeout (5s): The element could not be hovered — it may be off-screen or detached.`,
    { ref: z.string().describe('Element ref (@e3) or CSS selector') },
    async ({ ref }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          await bm.extSend('hover', { ref });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Hovered ${ref}` }] };
        }
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.hover({ timeout: 5000 });
        } else {
          await bm.getPage().hover(resolved.selector, { timeout: 5000 });
        }
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Hovered ${ref}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_fill',
    `Fill an input or textarea with new text, replacing any existing content.
Use when the user wants to enter text into a form field, search box, or editable element. Prefer pilot_fill over pilot_type for inputs because it is faster and clears existing content automatically.

Parameters:
- ref: Element reference from snapshot (e.g., "@e12") or a CSS selector (e.g., "#email")
- value: The text to fill into the element

Returns: Confirmation with the filled element ref.

Errors:
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.
- "Element is not editable": The element is read-only or disabled. Try pilot_click to enable it first.
- Timeout (5s): The element could not be filled.`,
      {
      ref: z.string().describe('Element ref (@e3) or CSS selector'),
      value: z.string().describe('Value to fill'),
    },
    async ({ ref, value }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          await bm.extSend('fill', { ref, value });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Filled ${ref}` }] };
        }
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.fill(value, { timeout: 5000 });
        } else {
          await bm.getPage().fill(resolved.selector, value, { timeout: 5000 });
        }
        bm.resetFailures();
        const snap = await postActionSnapshot(bm);
        return { content: [{ type: 'text' as const, text: `Filled ${ref}${snap}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_select_option',
    `Select an option from a <select> dropdown element by value, label, or visible text.
Use when the user wants to choose a dropdown option, select from a combobox, or pick from a list. Note: clicking an <option> in pilot_snapshot is auto-routed here.

Parameters:
- ref: The <select> element reference from snapshot (e.g., "@e5") or a CSS selector
- value: The option's value attribute, label, or visible text to match

Returns: Confirmation with the selected value and element ref.

Errors:
- "No option matched": The value does not match any option. Check the exact option text or value attribute via pilot_page_html.
- "Element not found": The ref is stale or does not point to a <select> element. Run pilot_snapshot.`,
      {
      ref: z.string().describe('Select element ref (@e3) or CSS selector'),
      value: z.string().describe('Option value, label, or text to select'),
    },
    async ({ ref, value }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await ext.send<{ selected: string; value: string }>('select_option', { ref, label: value });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Selected "${res.selected}" in ${ref}` }] };
        }
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.selectOption(value, { timeout: 5000 });
        } else {
          await bm.getPage().selectOption(resolved.selector, value, { timeout: 5000 });
        }
        bm.resetFailures();
        const snap = await postActionSnapshot(bm);
        return { content: [{ type: 'text' as const, text: `Selected "${value}" in ${ref}${snap}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_type',
    `Type text character-by-character into the currently focused element, simulating real keyboard input.
Use when the user wants to type into a contenteditable div, rich text editor, or a field that reacts to individual keystrokes (e.g., autocomplete, keypress events). For standard <input>/<textarea> elements, prefer pilot_fill which is faster.

Parameters:
- text: The text string to type
- submit: Set to true to press Enter after typing (useful for search fields and forms)

Returns: Character count typed and whether Enter was pressed.

Errors:
- "No element is focused": Nothing is focused on the page. Use pilot_click on the target field first.
- Timeout: The page became unresponsive during typing.`,
      {
      text: z.string().describe('Text to type'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
    },
    async ({ text, submit }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          await bm.extSend('type', { text });
          if (submit) await bm.extSend('press', { key: 'Enter' });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Typed ${text.length} characters${submit ? ' + Enter' : ''}` }] };
        }
        const page = bm.getPage();
        await page.keyboard.type(text);
        if (submit) await page.keyboard.press('Enter');
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Typed ${text.length} characters${submit ? ' + Enter' : ''}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_press_key',
    `Press a keyboard key or key combination on the page.
Use when the user wants to press Enter to submit a form, Tab to move between fields, Escape to close a modal, ArrowDown to navigate a list, or use any keyboard shortcut.

Parameters:
- key: Key name or combination (e.g., "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "Shift+Enter", "Control+a")

Returns: Confirmation of the key pressed.

Errors:
- "Unknown key": The key name is not recognized. Use standard Playwright key names (see docs.playwright.dev/key-input).`,
      { key: z.string().describe('Key name (e.g. Enter, Tab, Escape, ArrowDown, Shift+Enter)') },
    async ({ key }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          await bm.extSend('press', { key });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Pressed ${key}` }] };
        }
        await bm.getPage().keyboard.press(key);
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Pressed ${key}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_drag',
    `Drag one element and drop it onto another element on the page.
Use when the user wants to move an element, reorder items in a drag-and-drop list, or interact with a drag-and-drop UI.

Parameters:
- start_ref: The source element reference from snapshot (e.g., "@e3") or CSS selector to drag from
- end_ref: The target element reference from snapshot (e.g., "@e5") or CSS selector to drop onto

Returns: Confirmation with source and target refs.

Errors:
- "Element not found": Either ref is stale. Run pilot_snapshot to get fresh refs.
- Timeout (5s): The drag operation could not be completed. The elements may not support drag-and-drop.`,
      {
      start_ref: z.string().describe('Source element ref or CSS selector'),
      end_ref: z.string().describe('Target element ref or CSS selector'),
    },
    async ({ start_ref, end_ref }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const startResolved = await bm.resolveRef(start_ref);
        const endResolved = await bm.resolveRef(end_ref);

        const startLocator = 'locator' in startResolved ? startResolved.locator : page.locator(startResolved.selector);
        const endLocator = 'locator' in endResolved ? endResolved.locator : page.locator(endResolved.selector);

        await startLocator.dragTo(endLocator, { timeout: 5000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Dragged ${start_ref} → ${end_ref}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_scroll',
    `Scroll the page or a specific element into view.
Use when the user wants to scroll down a long page, scroll to the bottom, scroll to the top, or scroll a specific element into the viewport. With a ref, scrolls the element into view. Without a ref, scrolls the page by one viewport height or to a specific position.

Parameters:
- ref: Element reference from snapshot (e.g., "@e20") or CSS selector to scroll into view (omit for page scroll)
- direction: Page scroll direction when no ref is provided — "up", "down", "top", or "bottom" (default: "bottom")

Returns: Confirmation of what was scrolled and in which direction.

Errors:
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.
- Timeout (5s): The element could not be scrolled into view.`,
      {
      ref: z.string().optional().describe('Element ref or CSS selector to scroll into view'),
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional().describe('Scroll direction (when no ref)'),
    },
    async ({ ref, direction }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const scrollMap: Record<string, { deltaX: number; deltaY: number }> = {
            up: { deltaX: 0, deltaY: -300 },
            down: { deltaX: 0, deltaY: 300 },
            top: { deltaX: 0, deltaY: -99999 },
            bottom: { deltaX: 0, deltaY: 99999 },
          };
          const delta = ref ? { ref } : scrollMap[direction || 'down'];
          await bm.extSend('scroll', delta);
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Scrolled ${ref || direction || 'down'}` }] };
        }
        const page = bm.getPage();
        if (ref) {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            await resolved.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
          } else {
            await page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
          }
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Scrolled ${ref} into view` }] };
        }
        const scrollMap: Record<string, string> = {
          up: 'window.scrollBy(0, -window.innerHeight)',
          down: 'window.scrollBy(0, window.innerHeight)',
          top: 'window.scrollTo(0, 0)',
          bottom: 'window.scrollTo(0, document.body.scrollHeight)',
        };
        await page.evaluate(scrollMap[direction || 'bottom']);
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Scrolled ${direction || 'bottom'}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_wait',
    `Wait for a specific condition before proceeding — an element to appear, the network to become idle, or the page to finish loading.
Use when the user wants to wait for a dynamic element to load, wait for AJAX/fetch requests to complete, or wait for a modal/spinner to appear or disappear.

Parameters:
- ref: Element reference from snapshot (e.g., "@e10") or CSS selector to wait for
- state: What to wait for — "visible" (element appears, default), "hidden" (element disappears), "networkidle" (no network requests for 500ms), or "load" (page load event)
- timeout: Maximum wait time in milliseconds (default: 15000)

Returns: Confirmation of what was waited for and its state.

Errors:
- "Timeout waiting for element": The element did not reach the expected state in time. Increase timeout or check the selector.
- "Nothing to wait for": Neither ref nor state was provided. Supply at least one.`,
      {
      ref: z.string().optional().describe('Element ref or CSS selector to wait for'),
      state: z.enum(['visible', 'hidden', 'networkidle', 'load']).optional().describe('What to wait for'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 15000)'),
    },
    async ({ ref, state, timeout }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        const ms = timeout || 15000;
        if (ext && ref && (!state || state === 'visible')) {
          await bm.extSend('wait', { selector: ref.startsWith('@') ? `[data-pilot-ref="${ref.slice(1)}"]` : ref, timeout: ms });
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Element ${ref} is visible` }] };
        }
        const page = bm.getPage();
        if (state === 'networkidle') {
          await page.waitForLoadState('networkidle', { timeout: ms });
          return { content: [{ type: 'text' as const, text: 'Network idle' }] };
        }
        if (state === 'load') {
          await page.waitForLoadState('load', { timeout: ms });
          return { content: [{ type: 'text' as const, text: 'Page loaded' }] };
        }
        if (ref) {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            await resolved.locator.waitFor({ state: (state || 'visible') as any, timeout: ms });
          } else {
            await page.waitForSelector(resolved.selector, { state: (state || 'visible') as any, timeout: ms });
          }
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Element ${ref} is ${state || 'visible'}` }] };
        }
        return { content: [{ type: 'text' as const, text: 'Nothing to wait for — provide ref or state' }], isError: true };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_file_upload',
    `Upload one or more files to a file input element on the page.
Use when the user wants to attach files, upload images, or submit documents through a file input field.

Parameters:
- ref: The file input element reference from snapshot (e.g., "@e8") or a CSS selector pointing to an <input type="file">
- paths: Array of absolute file paths to upload (e.g., ["/home/user/photo.png", "/home/user/doc.pdf"])

Returns: Confirmation with file names and sizes uploaded.

Errors:
- "File not found": One or more paths do not exist on the filesystem. Verify the file paths.
- "Element not found": The ref is stale or does not point to a file input. Run pilot_snapshot.
- "Not a file input": The element is not an <input type="file">.`,
      {
      ref: z.string().describe('File input element ref or CSS selector'),
      paths: z.array(z.string()).describe('File paths to upload'),
    },
    async ({ ref, paths }) => {
      await bm.ensureBrowser();
      try {
        const resolvedPaths = paths.map(fp => {
          if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
          return fs.realpathSync(fp);
        });
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.setInputFiles(resolvedPaths);
        } else {
          await page.locator(resolved.selector).setInputFiles(resolvedPaths);
        }
        const fileInfo = resolvedPaths.map(fp => {
          const stat = fs.statSync(fp);
          return `${path.basename(fp)} (${stat.size}B)`;
        }).join(', ');
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Uploaded: ${fileInfo}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
