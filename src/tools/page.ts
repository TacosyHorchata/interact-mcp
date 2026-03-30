import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';

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

const DEFAULT_MAX_CHARS = 20000; // ~5K tokens — prevents unbounded output

function truncate(text: string, maxChars?: number): string {
  const limit = maxChars || DEFAULT_MAX_CHARS;
  if (text.length <= limit) return text;
  const truncated = text.slice(0, limit);
  const remaining = text.length - limit;
  return truncated + `\n\n── truncated: ${remaining} chars not shown (use max_chars to increase) ──`;
}

export function registerPageTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_page_text',
    'Extract clean text from the page (strips script/style/noscript/svg).',
    {
      max_chars: z.number().optional().describe('Max characters to return (default: 20000). Prevents token bloat on large pages.'),
    },
    async ({ max_chars }) => {
      await bm.ensureBrowser();
      try {
        const text = await getCleanText(bm.getPage());
        return { content: [{ type: 'text' as const, text: truncate(text, max_chars) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_html',
    'Get innerHTML of a selector/ref, or full page HTML if none provided.',
    {
      ref: z.string().optional().describe('Element ref or CSS selector'),
      max_chars: z.number().optional().describe('Max characters to return (default: 20000)'),
    },
    async ({ ref, max_chars }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        if (ref) {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            const html = await resolved.locator.innerHTML({ timeout: 5000 });
            return { content: [{ type: 'text' as const, text: truncate(html, max_chars) }] };
          }
          const html = await page.innerHTML(resolved.selector);
          return { content: [{ type: 'text' as const, text: truncate(html, max_chars) }] };
        }
        const html = await page.content();
        return { content: [{ type: 'text' as const, text: truncate(html, max_chars) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_links',
    'Get all links on the page as text + href pairs.',
    {
      max_chars: z.number().optional().describe('Max characters to return (default: 20000)'),
    },
    async ({ max_chars }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ links: Array<{ text: string; href: string }> }>('page_links');
          const result = res.links.map(l => `${l.text} → ${l.href}`).join('\n');
          return { content: [{ type: 'text' as const, text: truncate(result || '(no links found)', max_chars) }] };
        }
        const links = await bm.getPage().evaluate(() =>
          [...document.querySelectorAll('a[href]')].map(a => ({
            text: a.textContent?.trim().slice(0, 120) || '',
            href: (a as HTMLAnchorElement).href,
          })).filter(l => l.text && l.href)
        );
        const result = links.map(l => `${l.text} → ${l.href}`).join('\n');
        return { content: [{ type: 'text' as const, text: truncate(result || '(no links found)', max_chars) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_forms',
    `Extract all form elements on the page as structured JSON with their types, names, IDs, and current values.
Use when the user wants to understand form structure, see all input fields with their current values, check form methods and actions, or plan form filling automation. Password field values are redacted for security.

Parameters: (none)

Returns: JSON array of form objects, each containing the form's index, action URL, method, id, and an array of field objects with tag, type, name, id, placeholder, required, and value.

Errors: None — returns empty array "[]" if no forms exist on the page.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ forms: any[]; count: number }>('page_forms');
          return { content: [{ type: 'text' as const, text: JSON.stringify(res.forms, null, 2) }] };
        }
        const forms = await bm.getPage().evaluate(() => {
          return [...document.querySelectorAll('form')].map((form, i) => {
            const fields = [...form.querySelectorAll('input, select, textarea')].map(el => {
              const input = el as HTMLInputElement;
              return {
                tag: el.tagName.toLowerCase(),
                type: input.type || undefined,
                name: input.name || undefined,
                id: input.id || undefined,
                placeholder: input.placeholder || undefined,
                required: input.required || undefined,
                value: input.type === 'password' ? '[redacted]' : (input.value || undefined),
              };
            });
            return { index: i, action: form.action || undefined, method: form.method || 'get', id: form.id || undefined, fields };
          });
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(forms, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_attrs',
    `Get all HTML attributes of a specific element as a JSON object.
Use when the user wants to inspect an element's attributes (data-*, aria-*, class, id, href, src, etc.), check custom data attributes, or debug attribute-related issues.

Parameters:
- ref: Element reference from snapshot (e.g., "@e3") or CSS selector

Returns: JSON object mapping attribute names to their values.

Errors:
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.`,
      { ref: z.string().describe('Element ref or CSS selector') },
    async ({ ref }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        const attrs = await locator.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(attrs, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_css',
    `Get the computed CSS property value for a specific element.
Use when the user wants to check styling details (colors, fonts, dimensions, spacing), debug CSS issues, or verify that styles are applied correctly. Returns the final computed value after all CSS rules and inheritance are resolved.

Parameters:
- ref: Element reference from snapshot (e.g., "@e3") or CSS selector
- property: CSS property name in kebab-case or camelCase (e.g., "color", "font-size", "backgroundColor", "display")

Returns: The computed CSS property value as a string (e.g., "rgb(255, 0, 0)", "16px", "flex").

Errors:
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.`,
      {
      ref: z.string().describe('Element ref or CSS selector'),
      property: z.string().describe('CSS property name (e.g. color, font-size)'),
    },
    async ({ ref, property }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        const value = await locator.evaluate(
          (el, prop) => getComputedStyle(el).getPropertyValue(prop),
          property
        );
        return { content: [{ type: 'text' as const, text: value }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_element_state',
    `Check the current state of an element — whether it is visible, hidden, enabled, disabled, checked, editable, or focused.
Use when the user wants to verify an element's condition before interacting with it, check if a button is disabled, confirm a checkbox is checked, or debug why an interaction is failing.

Parameters:
- ref: Element reference from snapshot (e.g., "@e3") or CSS selector
- property: The state to check — "visible", "hidden", "enabled", "disabled", "checked", "editable", or "focused"

Returns: Boolean string "true" or "false" indicating the element's state for the requested property.

Errors:
- "Element not found": The ref is stale. Run pilot_snapshot to get fresh refs.`,
      {
      ref: z.string().describe('Element ref or CSS selector'),
      property: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'editable', 'focused']).describe('State to check'),
    },
    async ({ ref, property }) => {
      await bm.ensureBrowser();
      try {
        const ext = bm.getExtension();
        if (ext) {
          const res = await bm.extSend<{ visible: boolean; enabled: boolean; checked: boolean | null; focused: boolean }>('element_state', { ref });
          const stateMap: Record<string, boolean> = {
            visible: res.visible, hidden: !res.visible,
            enabled: res.enabled, disabled: !res.enabled,
            checked: res.checked ?? false, focused: res.focused,
            editable: res.enabled && res.visible,
          };
          return { content: [{ type: 'text' as const, text: String(stateMap[property] ?? false) }] };
        }
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);

        let result: boolean;
        switch (property) {
          case 'visible':  result = await locator.isVisible(); break;
          case 'hidden':   result = await locator.isHidden(); break;
          case 'enabled':  result = await locator.isEnabled(); break;
          case 'disabled': result = await locator.isDisabled(); break;
          case 'checked':  result = await locator.isChecked(); break;
          case 'editable': result = await locator.isEditable(); break;
          case 'focused':  result = await locator.evaluate((el) => el === document.activeElement); break;
        }
        return { content: [{ type: 'text' as const, text: String(result) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
