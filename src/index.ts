#!/usr/bin/env node

/**
 * Pilot — Fast browser automation for LLMs
 *
 * Persistent Chromium browser with ref-based element selection,
 * snapshot diffing, cookie migration, and AI-friendly errors.
 *
 * Architecture:
 *   LLM Client → stdio (MCP) → this process → Playwright → Chromium
 *   First call: ~3s (launch Chromium)
 *   Subsequent: ~5-50ms (in-process, no HTTP overhead)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserManager } from './browser-manager.js';
import { registerAllTools, type ToolProfile } from './tools/register.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const server = new McpServer({
  name: 'pilot',
  version: '0.2.0',
});

const browserManager = new BrowserManager();

const profile = (process.env.PILOT_PROFILE || 'standard') as ToolProfile;
if (!['core', 'standard', 'full'].includes(profile)) {
  console.error(`[pilot] Invalid PILOT_PROFILE="${profile}". Use: core (9 tools), standard (25 tools), full (all tools). Defaulting to standard.`);
}
registerAllTools(server, browserManager, profile);

async function main() {
  // One-time star reminder on first run
  const markerPath = path.join(os.homedir(), '.pilot-welcomed');
  if (!fs.existsSync(markerPath)) {
    console.error('[pilot] Thanks for installing! If useful, star the repo:');
    console.error('[pilot] https://github.com/TacosyHorchata/pilot');
    try { fs.writeFileSync(markerPath, new Date().toISOString()); } catch {}
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[pilot] Server started on stdio');
}

// Graceful shutdown
async function shutdown() {
  console.error('[pilot] Shutting down...');
  await browserManager.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error(`[pilot] Fatal: ${err.message}`);
  process.exit(1);
});
