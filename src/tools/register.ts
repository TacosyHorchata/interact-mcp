import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserManager } from '../browser-manager.js';
import { registerNavigationTools } from './navigation.js';
import { registerSnapshotTools } from './snapshot-tools.js';
import { registerInteractionTools } from './interaction.js';
import { registerPageTools } from './page.js';
import { registerInspectionTools } from './inspection.js';
import { registerVisualTools } from './visual.js';
import { registerTabTools } from './tabs.js';
import { registerSettingsTools } from './settings.js';
import { registerIframeTools } from './iframe.js';
import { registerAutomationTools } from './automation.js';

export type ToolProfile = 'core' | 'standard' | 'full';

/**
 * core (9 tools) — minimum viable browser interaction.
 * Inspired by Armin Ronacher's observation that he only uses 8 of 26 tools.
 * Research shows LLM degradation at 30+ tools.
 */
const CORE_TOOLS = new Set([
  'pilot_navigate',
  'pilot_snapshot',
  'pilot_snapshot_diff',
  'pilot_click',
  'pilot_fill',
  'pilot_type',
  'pilot_press_key',
  'pilot_wait',
  'pilot_screenshot',
]);

/**
 * standard (28 tools) — common automation needs without inspection overhead.
 */
const STANDARD_TOOLS = new Set([
  ...CORE_TOOLS,
  // navigation
  'pilot_back', 'pilot_forward', 'pilot_reload',
  // interaction
  'pilot_hover', 'pilot_select_option', 'pilot_scroll', 'pilot_drag',
  // tabs
  'pilot_tabs', 'pilot_tab_new', 'pilot_tab_close', 'pilot_tab_select',
  // page reading
  'pilot_page_text', 'pilot_page_html',
  // visual
  'pilot_annotated_screenshot',
  // iframe
  'pilot_frames', 'pilot_frame_select', 'pilot_frame_reset',
  // session + config
  'pilot_auth', 'pilot_block', 'pilot_find',
]);

const PROFILE_TOOLS: Record<ToolProfile, Set<string> | null> = {
  core: CORE_TOOLS,
  standard: STANDARD_TOOLS,
  full: null, // null = no filter, register everything
};

function createFilteredServer(server: McpServer, allowed: Set<string>): McpServer {
  const originalTool = server.tool.bind(server);

  const filtered = Object.create(server) as McpServer;
  filtered.tool = ((...args: unknown[]) => {
    const name = args[0] as string;
    if (!allowed.has(name)) return;
    return (originalTool as Function).apply(server, args);
  }) as typeof server.tool;

  return filtered;
}

export function registerAllTools(server: McpServer, bm: BrowserManager, profile: ToolProfile = 'full'): void {
  const allowed = PROFILE_TOOLS[profile];
  const effectiveServer = allowed ? createFilteredServer(server, allowed) : server;

  registerNavigationTools(effectiveServer, bm);
  registerSnapshotTools(effectiveServer, bm);
  registerInteractionTools(effectiveServer, bm);
  registerPageTools(effectiveServer, bm);
  registerInspectionTools(effectiveServer, bm);
  registerVisualTools(effectiveServer, bm);
  registerTabTools(effectiveServer, bm);
  registerSettingsTools(effectiveServer, bm);
  registerIframeTools(effectiveServer, bm);
  registerAutomationTools(effectiveServer, bm);
}
