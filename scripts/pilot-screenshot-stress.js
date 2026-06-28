#!/usr/bin/env node
import { Buffer } from 'buffer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PILOT_EXTENSION_PORT || 3131);
const TOKEN_FILE = path.join(os.homedir(), '.pilot', 'broker-token');
const DEFAULT_SESSIONS = 6;
const DEFAULT_URL = 'https://example.com/';
const TIMEOUT_MS = 45_000;

const args = parseArgs(process.argv.slice(2));
const sessionCount = Number(args.sessions || DEFAULT_SESSIONS);
const baseUrl = String(args.url || DEFAULT_URL);
const mode = String(args.mode || 'both');
const outDir = path.resolve(String(args.outDir || os.tmpdir()));
const shouldStartBroker = Boolean(args.startBroker);
const requireOwnedBroker = Boolean(args.requireOwnedBroker);
const shouldLaunchChrome = Boolean(args.launchChrome);
const chromeProfile = path.resolve(String(args.chromeProfile || path.join(os.tmpdir(), 'pilot-chrome-stress-profile')));
const launchSettleMs = Number(args.launchSettleMs || 5000);
const stressExtensionDir = path.join(os.tmpdir(), `pilot-extension-stress-${PORT}`);

async function runMode(selectedMode) {
  const start = Date.now();
  const workers = Array.from({ length: sessionCount }, (_, index) =>
    selectedMode === 'direct'
      ? runDirectSession(index + 1)
      : runClientSession(index + 1),
  );
  const results = await Promise.allSettled(workers);
  const passed = results.filter((result) => result.status === 'fulfilled').length;

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      const value = result.value;
      console.error(`[pilot-stress] ${selectedMode} ${index + 1}/${sessionCount} ok tab=${value.tabId} url=${value.url} file=${value.file}`);
    } else {
      console.error(`[pilot-stress] ${selectedMode} ${index + 1}/${sessionCount} failed: ${result.reason?.message || result.reason}`);
    }
  }

  console.error(`[pilot-stress] ${selectedMode}: ${passed}/${sessionCount} passed in ${Date.now() - start}ms`);
  if (passed !== sessionCount) {
    process.exitCode = 1;
  }
}

async function runDirectSession(index) {
  const token = readBrokerToken();
  const sessionId = `stress-direct-${process.pid}-${Date.now()}-${index}`;
  const client = await DirectClient.connect(sessionId, token);
  try {
    const assigned = await client.waitForAssigned();
    const url = sessionUrl(baseUrl, index);
    await client.request('navigate', { url });
    const current = await client.request('get_url');
    assertSessionUrl(current.url, index);
    const screenshot = await client.request('screenshot');
    const file = writePng(selectedModePath('direct', index), screenshot.data);
    return { tabId: assigned.tabId, url: current.url, file };
  } finally {
    client.close();
  }
}

async function runClientSession(index) {
  const { ExtensionServer } = await import('../dist/extension-server.js');
  const client = new ExtensionServer();
  client.start();
  try {
    await waitFor(() => {
      if (client.getMode() === 'broker') {
        throw new Error('Stress client became broker. Start Pilot broker before running this script.');
      }
      return client.isConnected() && typeof client.getSessionTab() === 'number';
    }, TIMEOUT_MS);

    const url = sessionUrl(baseUrl, index);
    await client.send('navigate', { url });
    const current = await client.send('get_url');
    assertSessionUrl(current.url, index);
    const screenshot = await client.send('screenshot');
    const file = writePng(selectedModePath('client', index), screenshot.data);
    return { tabId: client.getSessionTab(), url: current.url, file };
  } finally {
    await client.stop();
  }
}

class DirectClient {
  constructor(sessionId, ws) {
    this.sessionId = sessionId;
    this.ws = ws;
    this.counter = 0;
    this.pending = new Map();
    this.assigned = null;

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'session_assigned') {
        this.assigned = msg;
        return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result ?? msg);
    });
  }

  static async connect(sessionId, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const client = new DirectClient(sessionId, ws);
    await client.hello(token);
    return client;
  }

  hello(token) {
    return this.request('hello', undefined, {
      role: 'mcp',
      token,
      sessionId: this.sessionId,
    });
  }

  request(type, payload, extra = {}) {
    const id = `${this.sessionId}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, payload, sessionId: this.sessionId, ...extra }));
    });
  }

  async waitForAssigned() {
    await waitFor(() => this.assigned, TIMEOUT_MS);
    return this.assigned;
  }

  close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Client closed with pending request ${id}`));
    }
    this.pending.clear();
    this.ws.close();
    this.ws.terminate();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function readBrokerToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new Error(`Broker token not found at ${TOKEN_FILE}. Start Pilot broker first.`);
  }
}

function sessionUrl(base, index) {
  const url = new URL(base);
  url.hash = `session-${index}`;
  return url.toString();
}

function assertSessionUrl(url, index) {
  if (!url || !url.includes(`#session-${index}`)) {
    throw new Error(`Expected URL to include #session-${index}, got ${url}`);
  }
}

function selectedModePath(selectedMode, index) {
  return path.join(outDir, `pilot-stress-${selectedMode}-${index}.png`);
}

function writePng(file, base64) {
  const buffer = Buffer.from(base64, 'base64');
  if (
    buffer.length < 8 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    throw new Error(`Invalid PNG data for ${file}`);
  }
  fs.writeFileSync(file, buffer);
  return file;
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

fs.mkdirSync(outDir, { recursive: true });

const brokerHandle = shouldStartBroker ? await startBroker() : null;
const chrome = shouldLaunchChrome ? launchChrome() : null;

try {
  if (chrome) {
    await delay(launchSettleMs);
  }
  if (brokerHandle) {
    await waitFor(() => brokerHandle.server.isConnected(), TIMEOUT_MS);
  }
  const modes = mode === 'both' ? ['direct', 'client'] : [mode];
  for (const selectedMode of modes) {
    if (!['direct', 'client'].includes(selectedMode)) {
      throw new Error(`Unknown mode: ${selectedMode}. Use direct, client, or both.`);
    }
    await runMode(selectedMode);
  }
} finally {
  if (brokerHandle) await brokerHandle.server.stop();
  if (chrome) {
    try { chrome.kill(); } catch {}
  }
  console.error('[pilot-stress] cleanup complete');
}

async function startBroker() {
  const { ExtensionServer } = await import('../dist/extension-server.js');
  const broker = new ExtensionServer();
  broker.start();
  await waitFor(() => broker.getMode() === 'broker' || broker.getMode() === 'client', TIMEOUT_MS);
  if (broker.getMode() === 'broker') {
    console.error(`[pilot-stress] broker started session=${broker.getSessionId().slice(0, 8)}`);
    return { server: broker, owned: true };
  }
  if (requireOwnedBroker) {
    const info = broker.getBrokerInfo?.();
    await broker.stop();
    throw new Error(
      `Port ${PORT} is already owned by another Pilot broker` +
      (info ? ` (pid=${info.pid}, session=${String(info.sessionId).slice(0, 8)}, backend=${info.backend})` : '') +
      '. Stop it or omit --require-owned-broker to reuse it.',
    );
  }
  await waitFor(() => broker.isConnected() && typeof broker.getSessionTab() === 'number', TIMEOUT_MS);
  const info = broker.getBrokerInfo?.();
  console.error(
    `[pilot-stress] reusing existing broker` +
    (info ? ` pid=${info.pid} session=${String(info.sessionId).slice(0, 8)} backend=${info.backend}` : '') +
    ` via client session=${broker.getSessionId().slice(0, 8)}`,
  );
  return { server: broker, owned: false };
}

function launchChrome() {
  if (process.platform !== 'darwin') {
    throw new Error('--launch-chrome currently supports macOS Chrome/Chromium only.');
  }
  stopChromeProfile();
  fs.rmSync(chromeProfile, { recursive: true, force: true });
  const extensionPath = prepareExtensionForPort();
  const browser = findBrowserExecutable();
  const child = spawn(browser, [
    `--user-data-dir=${chromeProfile}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  console.error(`[pilot-stress] launched browser=${browser} profile=${chromeProfile}`);
  return child;
}

function findBrowserExecutable() {
  if (process.env.PILOT_CHROME_BIN) return process.env.PILOT_CHROME_BIN;

  const candidates = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1212/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1181/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('No Chrome for Testing/Chromium executable found. Set PILOT_CHROME_BIN.');
  }
  return found;
}

function prepareExtensionForPort() {
  const sourceExtension = path.resolve('extension');
  if (PORT === 3131) return sourceExtension;

  fs.rmSync(stressExtensionDir, { recursive: true, force: true });
  fs.cpSync(sourceExtension, stressExtensionDir, { recursive: true });
  const backgroundPath = path.join(stressExtensionDir, 'background.js');
  const background = fs.readFileSync(backgroundPath, 'utf8');
  fs.writeFileSync(
    backgroundPath,
    background.replace("const WS_URL = 'ws://127.0.0.1:3131';", `const WS_URL = 'ws://127.0.0.1:${PORT}';`),
  );
  console.error(`[pilot-stress] prepared extension copy=${stressExtensionDir}`);
  return stressExtensionDir;
}

function stopChromeProfile() {
  try {
    execFileSync('pkill', ['-f', chromeProfile], { stdio: 'ignore' });
  } catch {}
}
