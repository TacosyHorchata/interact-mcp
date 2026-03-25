import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';
import {
  findInstalledBrowsers,
  importCookies,
  listSupportedBrowserNames,
  listProfiles,
  listDomains,
} from '../cookie-import.js';
import * as fs from 'fs';

export function registerSettingsTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_resize',
    `Set the browser viewport size in pixels to simulate different screen resolutions.
Use when the user wants to test responsive layouts, simulate a mobile or tablet screen, or change the visible area of the page. For multi-viewport screenshots, use pilot_responsive instead.

Parameters:
- width: Viewport width in pixels (e.g., 1280 for desktop, 375 for mobile)
- height: Viewport height in pixels (e.g., 720 for desktop, 812 for mobile)

Returns: Confirmation with the new viewport dimensions.

Errors: None — any valid pixel dimensions are accepted.`,
      {
      width: z.number().describe('Viewport width in pixels'),
      height: z.number().describe('Viewport height in pixels'),
    },
    async ({ width, height }) => {
      await bm.ensureBrowser();
      try {
        await bm.setViewport(width, height);
        return { content: [{ type: 'text' as const, text: `Viewport set to ${width}x${height}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_set_cookie',
    `Set a cookie on the current page's domain with a given name and value.
Use when the user wants to manually set a cookie for authentication, testing, or session management. The cookie is set on the domain of the currently active page. For bulk cookie import from a real browser, use pilot_import_cookies.

Parameters:
- name: Cookie name (e.g., "session_id", "theme")
- value: Cookie value (e.g., "abc123", "dark")

Returns: Confirmation with the cookie name (value is redacted for security).

Errors:
- "Cannot set cookie without a page": Navigate to a URL first with pilot_navigate.`,
      {
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
    },
    async ({ name, value }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const url = new URL(page.url());
        await page.context().addCookies([{
          name,
          value,
          domain: url.hostname,
          path: '/',
        }]);
        return { content: [{ type: 'text' as const, text: `Cookie set: ${name}=****` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_import_cookies',
    `Import cookies from a real Chromium browser (Chrome, Arc, Brave, Edge, Comet) by decrypting the browser's cookie database and adding them to the headless session.
Use when the user wants to transfer authentication state from their real browser, avoid re-login, access authenticated pages, or work with session cookies from an existing browser profile.

Parameters:
- browser: Browser name to import from — "chrome", "arc", "brave", "edge", or "comet". Auto-detects if omitted
- domains: Array of cookie domains to import (e.g., [".github.com", ".google.com"]). Required for import mode
- profile: Browser profile name to read cookies from (default: "Default"). Use list_profiles to see available profiles
- list_browsers: Set to true to list installed Chromium browsers on the system instead of importing
- list_profiles: Set to true with browser to list available profiles for that browser
- list_domains: Set to true with browser to list cookie domains available in that browser's database

Returns:
- Import mode: Count of cookies imported, per-domain breakdown, and count of any that failed to decrypt
- list_browsers mode: List of installed browser names
- list_profiles mode: List of profiles with display names
- list_domains mode: Top 50 cookie domains with counts

Errors:
- "No Chromium browsers found": No supported browsers are installed. Check the system.
- "Browser not found": The specified browser is not installed. Use list_browsers to see available options.
- "Cookie database not found": The browser's cookie file does not exist at the expected path. Check the profile name.
- Decryption failures: Some cookies may fail to decrypt (e.g., on Linux without keyring access). The count is reported.`,
      {
      browser: z.string().optional().describe('Browser name (chrome, arc, brave, edge, comet). Auto-detects if omitted.'),
      domains: z.array(z.string()).describe('Cookie domains to import (e.g. [".github.com", ".google.com"])'),
      profile: z.string().optional().describe('Browser profile name (default: "Default")'),
      list_browsers: z.boolean().optional().describe('List installed browsers instead of importing'),
      list_profiles: z.boolean().optional().describe('List available profiles for the specified browser'),
      list_domains: z.boolean().optional().describe('List cookie domains available in the browser'),
    },
    async ({ browser, domains, profile, list_browsers, list_profiles, list_domains: listDom }) => {
      try {
        if (list_browsers) {
          const installed = findInstalledBrowsers();
          if (installed.length === 0) {
            return { content: [{ type: 'text' as const, text: `No Chromium browsers found. Supported: ${listSupportedBrowserNames().join(', ')}` }] };
          }
          return { content: [{ type: 'text' as const, text: `Installed browsers:\n${installed.map(b => `  - ${b.name}`).join('\n')}` }] };
        }

        if (list_profiles && browser) {
          const profiles = listProfiles(browser);
          if (profiles.length === 0) {
            return { content: [{ type: 'text' as const, text: `No profiles found for ${browser}` }] };
          }
          return { content: [{ type: 'text' as const, text: `Profiles for ${browser}:\n${profiles.map(p => `  - ${p.name} (${p.displayName})`).join('\n')}` }] };
        }

        if (listDom && browser) {
          const result = listDomains(browser, profile || 'Default');
          const top = result.domains.slice(0, 50);
          return { content: [{ type: 'text' as const, text: `Cookie domains in ${result.browser} (top ${top.length}):\n${top.map(d => `  ${d.domain} (${d.count} cookies)`).join('\n')}` }] };
        }

        // Import mode
        await bm.ensureBrowser();
        const browserName = browser || 'chrome';
        const result = await importCookies(browserName, domains, profile || 'Default');

        if (result.cookies.length > 0) {
          await bm.getContext().addCookies(result.cookies as any);
        }

        const msg = [`Imported ${result.count} cookies from ${browserName}`];
        if (result.failed > 0) msg.push(`(${result.failed} failed to decrypt)`);
        if (Object.keys(result.domainCounts).length > 0) {
          msg.push('\nPer domain:');
          for (const [domain, count] of Object.entries(result.domainCounts)) {
            msg.push(`  ${domain}: ${count}`);
          }
        }
        return { content: [{ type: 'text' as const, text: msg.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_set_header',
    `Set a custom HTTP request header that will be sent with all subsequent requests from the browser.
Use when the user wants to add an authorization header, set a custom API key, override the Accept-Language header, or inject any custom header for testing. Sensitive header values (Authorization, Cookie, X-API-Key, etc.) are auto-redacted in the response for security.

Parameters:
- name: Header name (e.g., "Authorization", "X-Custom-Header", "Accept-Language")
- value: Header value (e.g., "Bearer token123", "en-US")

Returns: Confirmation with the header name and value (sensitive values shown as "****").

Errors: None — any valid header name and value are accepted.`,
      {
      name: z.string().describe('Header name'),
      value: z.string().describe('Header value'),
    },
    async ({ name, value }) => {
      await bm.ensureBrowser();
      try {
        await bm.setExtraHeader(name, value);
        const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
        const redactedValue = sensitiveHeaders.includes(name.toLowerCase()) ? '****' : value;
        return { content: [{ type: 'text' as const, text: `Header set: ${name}: ${redactedValue}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_set_useragent',
    `Set a custom browser User-Agent string, which recreates the browser context to apply the change while preserving cookies and page state.
Use when the user wants to simulate a different browser or device, bypass bot detection, test mobile user agents, or debug User-Agent-dependent behavior. Note: this recreates the browser context, which may briefly interrupt in-progress requests.

Parameters:
- useragent: The full User-Agent string (e.g., "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15")

Returns: Confirmation with the new User-Agent string.

Errors:
- Context recreation warnings: If cookies or state could not be fully preserved during context recreation, a warning is included.`,
      { useragent: z.string().describe('User agent string') },
    async ({ useragent }) => {
      await bm.ensureBrowser();
      try {
        bm.setUserAgent(useragent);
        const error = await bm.recreateContext();
        if (error) {
          return { content: [{ type: 'text' as const, text: `User agent set to "${useragent}" but: ${error}` }] };
        }
        return { content: [{ type: 'text' as const, text: `User agent set: ${useragent}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_handle_dialog',
    `Configure automatic handling of native browser dialogs (alert, confirm, prompt) that would otherwise block page interaction.
Use when the user wants to pre-configure dialog behavior so alerts/confirms do not pause automation, or provide a default text for prompt dialogs. Dialog messages are still captured in the dialog buffer (see pilot_dialog).

Parameters:
- accept: true to automatically accept all dialogs, false to automatically dismiss them
- prompt_text: Text to automatically enter for prompt-type dialogs (omit for empty string)

Returns: Confirmation of the configured dialog behavior.

Errors: None — this is a configuration-only call that always succeeds.`,
      {
      accept: z.boolean().describe('true to auto-accept, false to auto-dismiss'),
      prompt_text: z.string().optional().describe('Text to provide for prompt dialogs'),
    },
    async ({ accept, prompt_text }) => {
      await bm.ensureBrowser();
      bm.setDialogAutoAccept(accept);
      bm.setDialogPromptText(prompt_text || null);
      const msg = accept
        ? (prompt_text ? `Dialogs will be accepted with text: "${prompt_text}"` : 'Dialogs will be accepted')
        : 'Dialogs will be dismissed';
      return { content: [{ type: 'text' as const, text: msg }] };
    }
  );

  server.tool(
    'pilot_handoff',
    `Open a visible (headed) browser window preserving all current state — cookies, tabs, and localStorage.
Use when the user is blocked by CAPTCHAs, bot detection, or complex auth flows that require manual intervention in a headed browser. After the user solves the challenge, call pilot_resume to reclaim automated control.

Parameters: (none)

Returns: Confirmation that the browser is now in headed mode with instructions to call pilot_resume when done.

Errors:
- "Browser not initialized": Call pilot_navigate first to start a browser session.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const result = await bm.handoff();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_resume',
    `Resume automated control after a pilot_handoff session.
Use when the user has finished manual interaction in the headed browser (e.g., solved a CAPTCHA, completed auth) and wants to return to automated control.

Parameters: (none)

Returns: A fresh accessibility snapshot of the current page state, ready for continued interaction.

Errors:
- "No browser to resume": No prior pilot_handoff was called or the browser has been closed.`,
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        await bm.resume();
        const { takeSnapshot } = await import('../snapshot.js');
        const snapshot = await takeSnapshot(bm, { interactive: true });
        return { content: [{ type: 'text' as const, text: `RESUMED\n${snapshot}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_close',
    `Close the browser instance and release all associated resources.
Use when the user wants to end the browsing session, clean up after completing a task, or start fresh with a new browser session.

Parameters: (none)

Returns: Confirmation that the browser was closed.

Errors:
- "No browser to close": No browser session is currently running. Safe to ignore.`,
    {},
    async () => {
      try {
        await bm.close();
        return { content: [{ type: 'text' as const, text: 'Browser closed.' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
