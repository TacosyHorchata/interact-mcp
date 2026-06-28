import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';

type GuideTopic =
  | 'quickstart'
  | 'refs'
  | 'browser_modes'
  | 'pilot_act'
  | 'evidence'
  | 'doctor'
  | 'troubleshooting'
  | 'patterns';

const GUIDES: Record<GuideTopic, string> = {
  quickstart: `Pilot quickstart for agents

Default loop:
1. pilot_navigate url
2. pilot_snapshot interactive_only=true lean=true
3. pilot_click / pilot_fill with @refs
4. pilot_snapshot_diff after actions

Shortcut:
- Use pilot_get for read-only "go to URL and tell me X" tasks.
- Use pilot_act when you know the human target and do not need a full snapshot first.

Keep outputs lean: prefer interactive_only, max_elements, snapshot_diff, and evidence artifacts over repeated full snapshots.`,

  refs: `Refs are ephemeral handles from snapshots.

Rules:
- @eN refs come from the accessibility tree.
- @cN refs come from cursor-interactive fallback scanning.
- Refs can go stale after navigation, rerender, or DOM mutation.
- If a ref fails twice, run pilot_snapshot again.

Use direct selectors only when the app has stable test ids or obvious CSS. For user-facing UI, refs and pilot_act are usually better.`,

  browser_modes: `Pilot browser modes

- extension: routes through the user's Chrome extension and real tabs.
- native: broker-owned Playwright Chromium backend.
- fallback: local headed/headless Chromium owned by the MCP process when no broker backend is connected.

Check routing with pilot_status or pilot_doctor.

For Cloudflare/CAPTCHA/auth flows, prefer pilot_handoff or extension mode. For deterministic CI-style checks, native/fallback is usually enough.`,

  pilot_act: `pilot_act resolves intent before acting.

Examples:
- pilot_act action="click" target="Sign in"
- pilot_act action="fill" target="Email" value="pedro@example.com"
- pilot_act action="select" target="Country" value="Mexico"
- pilot_act action="assert_text" target="Dashboard"

Use it for first attempts where a human label is clear. Use snapshot refs when precision matters or the page has repeated labels.`,

  evidence: `Evidence bundles turn browser work into durable proof.

Flow:
1. pilot_evidence_start name="checkout-repro"
2. pilot_act / pilot_evidence_step at meaningful checkpoints
3. pilot_evidence_export format="both" finish=true

Artifacts include evidence.json, evidence.md, screenshots, URL, console tail, network tail, and dialogs.

Use evidence for QA proof, bug repros, visual debugging, and handoffs to another agent.`,

  doctor: `Diagnostics and recovery

Use pilot_doctor first when automation smells broken:
- Transport closed
- stale refs after fresh snapshot
- extension/native confusion
- screenshot/readback failures
- orphan broker suspicion

Reset ladder:
1. pilot_reset scope="session"
2. pilot_reset scope="browser"
3. pilot_reset scope="broker" confirm_broker=true

Broker reset is guarded because multiple MCP sessions may share one broker.`,

  troubleshooting: `Common fixes

- Stale ref: run pilot_snapshot again, then retry with new @ref.
- Selector matched many elements: use pilot_find with role/text or exact=true.
- Element not visible: pilot_scroll ref="@eN", then retry.
- Page changed but snapshot is huge: use pilot_snapshot_diff.
- Bot detection: use pilot_handoff or extension mode.
- Broker confusion: pilot_doctor, then pilot_reset scope="session" first.`,

  patterns: `High-leverage agent patterns

Read task:
pilot_get -> answer.

Interact task:
pilot_navigate -> pilot_act or pilot_snapshot -> action -> pilot_snapshot_diff.

Bug repro:
pilot_evidence_start -> navigate -> steps/actions -> pilot_doctor if infra fails -> pilot_evidence_export.

Parallel sessions:
Do not share one tab. Open a new tab first with pilot_tab_new if separate agents must run concurrently.`,
};

export function registerGuideTools(server: McpServer, _bm: BrowserManager) {
  server.tool(
    'pilot_guide',
    `Read short just-in-time Pilot guidance for a specific agent workflow topic.
Use when an agent needs to know the right Pilot pattern, recovery path, browser mode, evidence flow, or ref behavior without loading the README or asking the user for instructions.

Parameters:
- topic: One of "quickstart", "refs", "browser_modes", "pilot_act", "evidence", "doctor", "troubleshooting", or "patterns"

Returns: A concise operational guide with recommended tool sequences and pitfalls for the requested topic.

Errors:
- "Unknown topic": The topic is not in the supported set; call without guessing and choose one of the enum values.`,
    {
      topic: z.enum(['quickstart', 'refs', 'browser_modes', 'pilot_act', 'evidence', 'doctor', 'troubleshooting', 'patterns']).describe('Guide topic to read'),
    },
    async ({ topic }) => {
      return { content: [{ type: 'text' as const, text: GUIDES[topic] }] };
    }
  );
}
