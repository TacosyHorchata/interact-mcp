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
import { extensionServer } from './extension-server.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

// ─── CLI: --install-extension ────────────────────────────────
if (process.argv.includes('--install-extension')) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const extDir = path.resolve(__dirname, '..', 'extension');
  if (!fs.existsSync(extDir)) {
    console.error(`Extension folder not found at ${extDir}`);
    process.exit(1);
  }
  console.log(`\nPilot Chrome Extension`);
  console.log(`─────────────────────`);
  console.log(`Extension folder: ${extDir}\n`);
  console.log(`To install:`);
  console.log(`  1. Open Chrome → chrome://extensions`);
  console.log(`  2. Enable Developer Mode (top right)`);
  console.log(`  3. Click "Load unpacked" → select the folder above\n`);
  // Try to open chrome://extensions automatically
  try {
    if (process.platform === 'darwin') execSync('open "chrome://extensions"', { stdio: 'ignore' });
    else if (process.platform === 'linux') execSync('xdg-open "chrome://extensions"', { stdio: 'ignore' });
    console.log(`Chrome extensions page opened. Paste this path:\n${extDir}\n`);
  } catch {
    console.log(`Open chrome://extensions manually and load the folder above.\n`);
  }
  process.exit(0);
}

const server = new McpServer({
  name: 'pilot',
  version: '0.4.0',
});

const browserManager = new BrowserManager();

let profile: ToolProfile = (process.env.PILOT_PROFILE || 'standard') as ToolProfile;
if (!['core', 'standard', 'full'].includes(profile)) {
  console.error(`[pilot] Invalid PILOT_PROFILE="${profile}". Use: core (9 tools), standard (30 tools), full (all tools). Defaulting to standard.`);
  profile = 'standard';
}
registerAllTools(server, browserManager, profile);

async function main() {
  extensionServer.start();
  extensionServer.onStateChange((connected) => {
    if (!connected) {
      // Reset log flags so next ensureBrowser() re-detects mode
      (browserManager as any)._loggedExtension = false;
      (browserManager as any)._loggedHeaded = false;
    }
  });
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
  extensionServer.stop();
  await browserManager.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error(`[pilot] Fatal: ${err.message}`);
  process.exit(1);
});
