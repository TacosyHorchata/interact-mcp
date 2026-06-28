import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import type { Locator } from 'playwright';
import { takeSnapshot } from '../snapshot.js';
import { wrapError } from '../errors.js';
import { validateNavigationUrl } from '../url-validation.js';
import {
  exportEvidenceSession,
  getEvidenceSession,
  recordEvidenceStep,
  startEvidenceSession,
  stopEvidenceSession,
} from '../evidence.js';
import { validateOutputPath } from './visual.js';
import * as path from 'path';

type ActAction = 'navigate' | 'click' | 'fill' | 'select' | 'hover' | 'press' | 'assert_text';

type ResolvedTarget = {
  locator: Locator;
  ref?: string;
  strategy: string;
  matchCount: number;
};

function isDirectTarget(target: string): boolean {
  const trimmed = target.trim();
  return (
    trimmed.startsWith('@') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('.') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('xpath=') ||
    /^[a-z][\w-]*(?:[#.:[>~+])/i.test(trimmed)
  );
}

async function postActSnapshot(bm: BrowserManager): Promise<string> {
  try {
    const ext = bm.getExtension();
    if (ext) {
      const snap = await bm.extSend<{ text: string }>('snapshot', { maxElements: 20, interactive_only: true, lean: true });
      return `\n--- page state ---\n${snap.text}`;
    }
    const snap = await takeSnapshot(bm, { interactive: true, maxElements: 20, lean: true });
    return `\n--- page state ---\n${snap}`;
  } catch {
    return '';
  }
}

async function firstUsable(locator: Locator): Promise<{ locator: Locator; count: number } | null> {
  const count = await locator.count().catch(() => 0);
  if (count === 0) return null;
  const limit = Math.min(count, 8);
  for (let i = 0; i < limit; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return { locator: candidate, count };
    }
  }
  return { locator: locator.first(), count };
}

function addCandidate(
  candidates: Array<{ locator: Locator; strategy: string }>,
  locator: Locator,
  strategy: string,
): void {
  candidates.push({ locator, strategy });
}

async function resolveLocalIntent(
  bm: BrowserManager,
  action: ActAction,
  target: string,
  exact: boolean,
): Promise<ResolvedTarget> {
  const page = bm.getPage();

  if (isDirectTarget(target)) {
    const resolved = await bm.resolveRef(target);
    const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
    const usable = await firstUsable(locator);
    if (!usable) throw new Error(`No element matched direct target "${target}"`);
    return { locator: usable.locator, ref: target.startsWith('@') ? target : undefined, strategy: `direct:${target}`, matchCount: usable.count };
  }

  const frame = bm.getActiveFrame();
  const candidates: Array<{ locator: Locator; strategy: string }> = [];

  if (action === 'fill') {
    addCandidate(candidates, frame.getByLabel(target, { exact }), `label:${target}`);
    addCandidate(candidates, frame.getByPlaceholder(target, { exact }), `placeholder:${target}`);
    addCandidate(candidates, frame.getByRole('textbox' as any, { name: target, exact }), `role:textbox:${target}`);
    addCandidate(candidates, frame.getByRole('searchbox' as any, { name: target, exact }), `role:searchbox:${target}`);
  } else if (action === 'select') {
    addCandidate(candidates, frame.getByLabel(target, { exact }), `label:${target}`);
    addCandidate(candidates, frame.getByRole('combobox' as any, { name: target, exact }), `role:combobox:${target}`);
    addCandidate(candidates, frame.locator('select').filter({ hasText: target }), `select-has-text:${target}`);
  } else if (action === 'hover') {
    addCandidate(candidates, frame.getByText(target, { exact }), `text:${target}`);
    addCandidate(candidates, frame.getByRole('link' as any, { name: target, exact }), `role:link:${target}`);
    addCandidate(candidates, frame.getByRole('button' as any, { name: target, exact }), `role:button:${target}`);
  } else {
    for (const role of ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']) {
      addCandidate(candidates, frame.getByRole(role as any, { name: target, exact }), `role:${role}:${target}`);
    }
    addCandidate(candidates, frame.getByLabel(target, { exact }), `label:${target}`);
    addCandidate(candidates, frame.getByText(target, { exact }), `text:${target}`);
  }

  for (const candidate of candidates) {
    const usable = await firstUsable(candidate.locator);
    if (!usable) continue;
    const ref = bm.addSingleRef(usable.locator, action, target);
    return { locator: usable.locator, ref: `@${ref}`, strategy: candidate.strategy, matchCount: usable.count };
  }

  throw new Error(`No actionable target found for "${target}". Run pilot_snapshot or use a direct @ref/CSS selector.`);
}

async function resolveExtensionIntent(
  bm: BrowserManager,
  action: ActAction,
  target: string,
): Promise<{ ref: string; strategy: string; text?: string }> {
  if (isDirectTarget(target)) return { ref: target, strategy: `direct:${target}` };

  const attempts: Array<{ payload: Record<string, string>; strategy: string }> = [];
  if (action === 'fill') {
    attempts.push(
      { payload: { label: target }, strategy: `label:${target}` },
      { payload: { placeholder: target }, strategy: `placeholder:${target}` },
      { payload: { role: 'textbox', text: target }, strategy: `role:textbox:${target}` },
      { payload: { role: 'searchbox', text: target }, strategy: `role:searchbox:${target}` },
    );
  } else if (action === 'select') {
    attempts.push(
      { payload: { label: target }, strategy: `label:${target}` },
      { payload: { role: 'combobox', text: target }, strategy: `role:combobox:${target}` },
      { payload: { text: target }, strategy: `text:${target}` },
    );
  } else {
    for (const role of ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch']) {
      attempts.push({ payload: { role, text: target }, strategy: `role:${role}:${target}` });
    }
    attempts.push(
      { payload: { label: target }, strategy: `label:${target}` },
      { payload: { text: target }, strategy: `text:${target}` },
    );
  }

  for (const attempt of attempts) {
    try {
      const found = await bm.extSend<{ ref: string; text: string }>('find', attempt.payload);
      return { ref: found.ref, strategy: attempt.strategy, text: found.text };
    } catch {}
  }

  throw new Error(`No actionable target found for "${target}". Run pilot_snapshot or use a direct @ref/CSS selector.`);
}

function evidenceOutputDir(outputDir: string | undefined): string | undefined {
  if (!outputDir) return undefined;
  const marker = validateOutputPath(path.join(outputDir, '.pilot-evidence-root'));
  return path.dirname(marker);
}

export function registerAutomationTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_act',
    `Perform a high-level browser action by resolving a human target into the best available @ref, label, role, placeholder, text, or selector.
Use when an agent knows the user's intent ("click Sign in", "fill Email", "select Country") and should not waste a turn taking a full snapshot just to discover a selector. Prefer direct @refs when you already have them; use pilot_act for resilient first attempts and built-in recovery hints.

Parameters:
- action: "navigate", "click", "fill", "select", "hover", "press", or "assert_text"
- target: Human target text, label, placeholder, @ref, CSS selector, or key name for action="press"
- value: Text to fill, option to select, or key to press when different from target
- url: URL for action="navigate" (target may also hold the URL)
- exact: Set true for exact text/label/role matching in Playwright fallback mode
- evidence_label: Optional label to auto-capture in an active evidence bundle

Returns: The resolved strategy, target/ref used, and a lean post-action page state when relevant.

Errors:
- "No actionable target found": Target text did not resolve. Run pilot_snapshot or pass a direct @ref/CSS selector.
- Action-specific browser errors include recovery hints and a fresh compact page state when available.`,
    {
      action: z.enum(['navigate', 'click', 'fill', 'select', 'hover', 'press', 'assert_text']).describe('High-level action to perform'),
      target: z.string().optional().describe('Human target text, @ref, CSS selector, URL, or key name'),
      value: z.string().optional().describe('Value to fill/select or key to press'),
      url: z.string().optional().describe('URL for action="navigate"'),
      exact: z.boolean().optional().describe('Use exact matching in Playwright fallback mode'),
      evidence_label: z.string().optional().describe('Optional evidence step label when an evidence session is active'),
    },
    async ({ action, target, value, url, exact, evidence_label }) => {
      await bm.ensureBrowser();
      const actionName = action as ActAction;
      const evidenceAction = `pilot_act:${actionName}`;
      try {
        const ext = bm.getExtension();

        if (actionName === 'navigate') {
          const navUrl = url || target;
          if (!navUrl) {
            return { content: [{ type: 'text' as const, text: 'url or target is required for action="navigate"' }], isError: true };
          }
          await validateNavigationUrl(navUrl);
          if (ext) {
            const res = await bm.extSend<{ url: string }>('navigate', { url: navUrl });
            bm.resetFailures();
            const snap = await postActSnapshot(bm);
            const text = `Act navigate -> ${res.url}${snap}`;
            await recordEvidenceStep(bm, { label: evidence_label || `navigate ${navUrl}`, action: evidenceAction }).catch(() => null);
            return { content: [{ type: 'text' as const, text }] };
          }
          const page = bm.getPage();
          await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          bm.resetFailures();
          const snap = await postActSnapshot(bm);
          await recordEvidenceStep(bm, { label: evidence_label || `navigate ${navUrl}`, action: evidenceAction }).catch(() => null);
          return { content: [{ type: 'text' as const, text: `Act navigate -> ${page.url()}${snap}` }] };
        }

        if (actionName === 'press') {
          const key = value || target;
          if (!key) return { content: [{ type: 'text' as const, text: 'target or value is required for action="press"' }], isError: true };
          if (ext) await bm.extSend('press', { key });
          else await bm.getPage().keyboard.press(key);
          bm.resetFailures();
          await recordEvidenceStep(bm, { label: evidence_label || `press ${key}`, action: evidenceAction }).catch(() => null);
          return { content: [{ type: 'text' as const, text: `Act press -> ${key}` }] };
        }

        if (actionName === 'assert_text') {
          const text = target || value;
          if (!text) return { content: [{ type: 'text' as const, text: 'target or value is required for action="assert_text"' }], isError: true };
          if (ext) {
            await bm.extSend('find', { text });
          } else {
            await bm.getPage().getByText(text, { exact: exact ?? false }).first().waitFor({ state: 'visible', timeout: 5000 });
          }
          bm.resetFailures();
          await recordEvidenceStep(bm, { label: evidence_label || `assert text ${text}`, action: evidenceAction, screenshot: false }).catch(() => null);
          return { content: [{ type: 'text' as const, text: `Act assert_text passed -> "${text}"` }] };
        }

        if (!target) return { content: [{ type: 'text' as const, text: `target is required for action="${actionName}"` }], isError: true };

        if (ext) {
          const resolved = await resolveExtensionIntent(bm, actionName, target);
          if (actionName === 'click') await bm.extSend('click', { ref: resolved.ref });
          else if (actionName === 'fill') await bm.extSend('fill', { ref: resolved.ref, value: value ?? '' });
          else if (actionName === 'select') await bm.extSend('select_option', { ref: resolved.ref, label: value ?? target, value: value ?? target });
          else if (actionName === 'hover') await bm.extSend('hover', { ref: resolved.ref });
          bm.resetFailures();
          const snap = await postActSnapshot(bm);
          const text = `Act ${actionName} -> ${resolved.ref} via ${resolved.strategy}${snap}`;
          await recordEvidenceStep(bm, { label: evidence_label || `${actionName} ${target}`, action: evidenceAction }).catch(() => null);
          return { content: [{ type: 'text' as const, text }] };
        }

        const resolved = await resolveLocalIntent(bm, actionName, target, exact ?? false);
        await resolved.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        if (actionName === 'click') {
          await resolved.locator.click({ timeout: 5000 });
          await bm.getPage().waitForLoadState('domcontentloaded').catch(() => {});
        } else if (actionName === 'fill') {
          await resolved.locator.fill(value ?? '', { timeout: 5000 });
        } else if (actionName === 'select') {
          const option = value ?? target;
          await resolved.locator.selectOption(option, { timeout: 5000 }).catch(async () => {
            await resolved.locator.selectOption({ label: option }, { timeout: 5000 });
          });
        } else if (actionName === 'hover') {
          await resolved.locator.hover({ timeout: 5000 });
        }

        bm.resetFailures();
        const snap = await postActSnapshot(bm);
        const refText = resolved.ref ? ` ${resolved.ref}` : '';
        const multi = resolved.matchCount > 1 ? ` (picked first visible of ${resolved.matchCount})` : '';
        const text = `Act ${actionName}${refText} via ${resolved.strategy}${multi}${snap}`;
        await recordEvidenceStep(bm, { label: evidence_label || `${actionName} ${target}`, action: evidenceAction }).catch(() => null);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        bm.incrementFailures();
        let msg = wrapError(err);
        const hint = bm.getFailureHint();
        if (hint) msg += '\n' + hint;
        msg += await postActSnapshot(bm);
        await recordEvidenceStep(bm, { label: evidence_label || `${actionName} failed`, action: evidenceAction, error: msg }).catch(() => null);
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_evidence_start',
    `Start an evidence bundle that records browser proof for an agent task.
Use when the user asks for QA proof, visual debugging, repro evidence, bug reports, or any workflow where the agent should leave screenshots, console logs, network tails, and a machine-readable trail instead of loose chat claims.

Parameters:
- name: Human-readable run name used in the bundle metadata and default folder
- output_dir: Optional directory for artifacts. Must be inside PILOT_OUTPUT_DIR or the system temp directory.

Returns: Evidence session id, output directory, and current step count.

Errors:
- "Output path must be within ...": The requested output_dir is outside the allowed artifact directory.`,
    {
      name: z.string().optional().describe('Human-readable evidence run name'),
      output_dir: z.string().optional().describe('Directory for artifacts; must be inside PILOT_OUTPUT_DIR or /tmp'),
    },
    async ({ name, output_dir }) => {
      try {
        const session = startEvidenceSession(name, evidenceOutputDir(output_dir));
        return { content: [{ type: 'text' as const, text: `Evidence started: ${session.id}\nOutput: ${session.outputDir}\nSteps: 0` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_evidence_step',
    `Capture an evidence step with the current URL, screenshot, console tail, network tail, and dialogs.
Use when an agent reaches a meaningful checkpoint: before/after an action, after a failed assertion, after a visual bug reproduction, or before handing off findings to the user.

Parameters:
- label: Short step label explaining what this checkpoint proves
- screenshot: Set false to skip screenshot capture for text-only checkpoints
- console_count: Number of recent console entries to include (default 10)
- network_count: Number of recent network entries to include (default 10)

Returns: Captured step number, URL, screenshot path when available, and bundle output directory.

Errors:
- "No active evidence session": Run pilot_evidence_start first.
- Screenshot capture failures are non-fatal; the step is still recorded.`,
    {
      label: z.string().describe('Short checkpoint label'),
      screenshot: z.boolean().optional().describe('Capture screenshot (default true)'),
      console_count: z.number().optional().describe('Recent console entries to include (default 10)'),
      network_count: z.number().optional().describe('Recent network entries to include (default 10)'),
    },
    async ({ label, screenshot, console_count, network_count }) => {
      await bm.ensureBrowser();
      try {
        const session = getEvidenceSession();
        if (!session) return { content: [{ type: 'text' as const, text: 'No active evidence session. Run pilot_evidence_start first.' }], isError: true };
        const step = await recordEvidenceStep(bm, {
          label,
          screenshot,
          consoleCount: console_count,
          networkCount: network_count,
        });
        if (!step) return { content: [{ type: 'text' as const, text: 'No active evidence session. Run pilot_evidence_start first.' }], isError: true };
        const shot = step.screenshotPath ? `\nScreenshot: ${step.screenshotPath}` : '';
        return { content: [{ type: 'text' as const, text: `Evidence step ${step.index}: ${step.label}\nURL: ${step.url ?? 'unknown'}${shot}\nOutput: ${session.outputDir}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_evidence_export',
    `Export the active evidence bundle to JSON, Markdown, or both.
Use when the agent is done reproducing, validating, or debugging and needs durable artifacts the user or another agent can inspect without replaying the browser session.

Parameters:
- format: "json", "markdown", or "both" (default)
- finish: Set true to close the active evidence session after export

Returns: Paths to exported evidence files and the number of captured steps.

Errors:
- "No active evidence session": Run pilot_evidence_start first or avoid exporting empty proof.`,
    {
      format: z.enum(['json', 'markdown', 'both']).optional().describe('Export format (default both)'),
      finish: z.boolean().optional().describe('Close the active evidence session after export'),
    },
    async ({ format, finish }) => {
      try {
        const exported = exportEvidenceSession(format ?? 'both');
        if (!exported) return { content: [{ type: 'text' as const, text: 'No active evidence session. Run pilot_evidence_start first.' }], isError: true };
        if (finish) stopEvidenceSession();
        const paths = [
          exported.jsonPath ? `JSON: ${exported.jsonPath}` : null,
          exported.markdownPath ? `Markdown: ${exported.markdownPath}` : null,
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text' as const, text: `Evidence exported (${exported.session.steps.length} steps)\n${paths}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_intercept',
    `Intercept network requests matching a URL pattern and respond with custom status, headers, and body.
Use when the user wants to mock API responses, simulate error states (401, 500), test loading states, or run frontend tests without a real backend. All requests matching the pattern are fulfilled with the given response until cleared.

Parameters:
- pattern: URL glob pattern to intercept (e.g., "**/api/users", "*/auth*")
- response: Custom response — status (default 200), body (JSON string or text), headers, contentType
- clear: Set to true to remove all active intercepts

Returns:
- Add mode: Confirmation and list of active intercepts.
- clear mode: Confirmation that all intercepts were removed.

Errors:
- "Browser not launched": Navigate to a URL first.`,
    {
      pattern: z.string().optional().describe('URL glob pattern to intercept (e.g., "**/api/users")'),
      response: z.object({
        status: z.number().optional().describe('HTTP status code (default: 200)'),
        body: z.string().optional().describe('Response body as a string (JSON, HTML, or plain text)'),
        headers: z.record(z.string()).optional().describe('Custom response headers'),
        contentType: z.string().optional().describe('Content-Type header (e.g., "application/json")'),
      }).optional().describe('Custom response to return for matched requests'),
      clear: z.boolean().optional().describe('Remove all active intercepts'),
    },
    async ({ pattern, response, clear }) => {
      await bm.ensureBrowser();
      try {
        if (clear) {
          await bm.clearIntercepts();
          return { content: [{ type: 'text' as const, text: 'All intercepts cleared.' }] };
        }
        if (!pattern) {
          const active = bm.getIntercepts();
          return { content: [{ type: 'text' as const, text: active.length > 0 ? `Active intercepts (${active.length}):\n${active.map(i => `  ${i.pattern} → ${i.status}`).join('\n')}` : 'No active intercepts.' }] };
        }
        await bm.addIntercept(pattern, response ?? {});
        const active = bm.getIntercepts();
        return {
          content: [{
            type: 'text' as const,
            text: `Intercepting ${pattern} → ${response?.status ?? 200}. Active intercepts (${active.length}):\n${active.map(i => `  ${i.pattern} → ${i.status}`).join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_assert',
    `Assert a condition about the current page state and fail with a structured error if the assertion is not met.
Use when the user wants to verify the outcome of an action — that a URL was reached, text is present or absent, an element is visible/hidden/enabled, or an input has a specific value. Returns a clear pass/fail signal for agent-driven test flows.

Parameters:
- url: Assert the current page URL equals or contains this string
- text_present: Assert this text is visible somewhere on the page (waits up to 5s)
- text_absent: Assert this text is NOT visible on the page
- ref: Element ref (@eN) to assert a state or value on
- state: Expected element state — "visible", "hidden", "enabled", or "disabled"
- value: Expected input value for the element pointed to by ref

Returns: "✓ N assertion(s) passed" if all checks pass.

Errors:
- Returns isError=true with details of which assertion failed and what was found instead.`,
    {
      url: z.string().optional().describe('Assert current URL equals or contains this string'),
      text_present: z.string().optional().describe('Assert this text is visible on the page'),
      text_absent: z.string().optional().describe('Assert this text is NOT visible on the page'),
      ref: z.string().optional().describe('Element ref (@eN) to check state or value'),
      state: z.enum(['visible', 'hidden', 'enabled', 'disabled']).optional().describe('Expected element state'),
      value: z.string().optional().describe('Expected input value for the element ref'),
    },
    async ({ url, text_present, text_absent, ref, state, value }) => {
      await bm.ensureBrowser();
      const failures: string[] = [];
      let checks = 0;

      try {
        const page = bm.getPage();

        if (url !== undefined) {
          checks++;
          const currentUrl = page.url();
          if (!currentUrl.includes(url) && currentUrl !== url) {
            failures.push(`url: expected "${url}", got "${currentUrl}"`);
          }
        }

        if (text_present !== undefined) {
          checks++;
          try {
            await page.getByText(text_present).first().waitFor({ state: 'visible', timeout: 5000 });
          } catch {
            failures.push(`text_present: "${text_present}" not visible on page`);
          }
        }

        if (text_absent !== undefined) {
          checks++;
          const isVisible = await page.getByText(text_absent).first().isVisible();
          if (isVisible) {
            failures.push(`text_absent: "${text_absent}" is visible on page (expected absent)`);
          }
        }

        if (ref !== undefined) {
          try {
            const resolved = await bm.resolveRef(ref);
            const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);

            if (state !== undefined) {
              checks++;
              const isVisible = await locator.isVisible();
              const isEnabled = await locator.isEnabled();
              if (state === 'visible' && !isVisible) {
                failures.push(`${ref} state: expected "visible", element is hidden`);
              } else if (state === 'hidden' && isVisible) {
                failures.push(`${ref} state: expected "hidden", element is visible`);
              } else if (state === 'enabled' && !isEnabled) {
                failures.push(`${ref} state: expected "enabled", element is disabled`);
              } else if (state === 'disabled' && isEnabled) {
                failures.push(`${ref} state: expected "disabled", element is enabled`);
              }
            }

            if (value !== undefined) {
              checks++;
              const actualValue = await locator.inputValue().catch(() => null);
              if (actualValue === null) {
                const textContent = await locator.textContent().catch(() => '');
                if ((textContent ?? '').trim() !== value) {
                  failures.push(`${ref} value: expected "${value}", got "${(textContent ?? '').trim()}"`);
                }
              } else if (actualValue !== value) {
                failures.push(`${ref} value: expected "${value}", got "${actualValue}"`);
              }
            }

            // ref with no sub-checks = existence assertion
            if (state === undefined && value === undefined) {
              checks++;
            }
          } catch (err) {
            checks++;
            failures.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (checks === 0) {
          return { content: [{ type: 'text' as const, text: 'No assertions provided. Specify url, text_present, text_absent, ref+state, or ref+value.' }], isError: true };
        }

        if (failures.length > 0) {
          return { content: [{ type: 'text' as const, text: `✗ ${failures.length}/${checks} assertion(s) failed:\n${failures.join('\n')}` }], isError: true };
        }

        return { content: [{ type: 'text' as const, text: `✓ ${checks} assertion(s) passed` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_clipboard',
    `Read from or write to the browser clipboard.
Use when the user wants to read content that an app copied to clipboard (share links, API keys, generated tokens), or pre-populate clipboard with text for paste operations.

Parameters:
- action: "get" — read current clipboard text; "set" — write text to clipboard
- text: Text to write when action is "set"

Returns:
- get: The current clipboard text content.
- set: Confirmation that text was written to clipboard.

Errors:
- "Clipboard read failed": Browser security policy blocked clipboard access. Try in headed mode (pilot_handoff).`,
    {
      action: z.enum(['get', 'set']).describe('"get" to read clipboard, "set" to write'),
      text: z.string().optional().describe('Text to write to clipboard (required for action="set")'),
    },
    async ({ action, text }) => {
      await bm.ensureBrowser();
      try {
        const ctx = bm.getContext();
        const page = bm.getPage();

        if (action === 'set') {
          if (text === undefined) {
            return { content: [{ type: 'text' as const, text: 'text is required for action="set"' }], isError: true };
          }
          await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
          await page.evaluate((t) => navigator.clipboard.writeText(t), text);
          return { content: [{ type: 'text' as const, text: `Clipboard set (${text.length} chars)` }] };
        }

        // get
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
        const content = await page.evaluate(() => navigator.clipboard.readText());
        return { content: [{ type: 'text' as const, text: content || '(clipboard is empty)' }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('clipboard') || msg.includes('permission')) {
          return { content: [{ type: 'text' as const, text: `Clipboard read failed — browser security policy blocked access. Use pilot_handoff to switch to headed mode where clipboard is accessible.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
