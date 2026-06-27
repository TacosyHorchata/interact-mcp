#!/usr/bin/env node
import { spawn } from 'child_process';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_SESSIONS = 6;
const DEFAULT_URL = 'https://example.com/';
const TIMEOUT_MS = 240_000;

const args = parseArgs(process.argv.slice(2));
const sessionCount = Number(args.sessions || DEFAULT_SESSIONS);
const baseUrl = String(args.url || DEFAULT_URL);
const outDir = path.resolve(String(args.outDir || os.tmpdir()));
const cwd = path.resolve(String(args.cwd || process.cwd()));
const timeoutMs = Number(args.timeoutMs || TIMEOUT_MS);
const model = args.model ? String(args.model) : null;
const disableOtherMcps = args.disableOtherMcps !== 'false';

fs.mkdirSync(outDir, { recursive: true });
assertPilotMcpConfigured();

const results = await Promise.allSettled(
  Array.from({ length: sessionCount }, (_, index) => runCodexSession(index + 1)),
);

let passed = 0;
for (const [index, result] of results.entries()) {
  const sessionNumber = index + 1;
  if (result.status === 'fulfilled') {
    passed += 1;
    console.error(`[pilot-codex-stress] ${sessionNumber}/${sessionCount} ok file=${result.value.file}`);
  } else {
    console.error(`[pilot-codex-stress] ${sessionNumber}/${sessionCount} failed: ${result.reason?.message || result.reason}`);
  }
}

console.error(`[pilot-codex-stress] ${passed}/${sessionCount} passed`);
if (passed !== sessionCount) process.exitCode = 1;
await cleanupPilotProcesses();

async function runCodexSession(index) {
  const screenshotPath = path.join(outDir, `pilot-codex-agent-${index}.png`);
  const finalPath = path.join(outDir, `pilot-codex-agent-${index}.txt`);
  const logPath = path.join(outDir, `pilot-codex-agent-${index}.log`);
  fs.rmSync(screenshotPath, { force: true });
  fs.rmSync(finalPath, { force: true });
  fs.rmSync(logPath, { force: true });

  const targetUrl = sessionUrl(baseUrl, index);
  const prompt = [
    `Objective: mechanical Pilot MCP stress run for isolated Codex agent ${index}.`,
    'Do not modify files.',
    'Use only these Pilot MCP calls: pilot_navigate, then pilot_screenshot.',
    `Navigate to ${targetUrl}.`,
    `Save a PNG screenshot to ${screenshotPath}.`,
    `Final answer exactly: OK agent-${index} ${screenshotPath}`,
  ].join(' ');

  const codexArgs = [
    'exec',
    '-C',
    cwd,
    '--sandbox',
    'danger-full-access',
    '--ephemeral',
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    'model_verbosity="low"',
    '--output-last-message',
    finalPath,
    ...mcpDisableConfigArgs(),
  ];
  if (model) codexArgs.push('--model', model);
  codexArgs.push(prompt);

  const child = spawn('codex', codexArgs, {
    cwd,
    env: {
      ...process.env,
      PILOT_BROWSER_MODE: 'native',
      PILOT_HEADLESS: '1',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logStream = fs.createWriteStream(logPath);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  let exitCode;
  try {
    exitCode = await waitForChild(child, timeoutMs);
  } finally {
    logStream.end();
  }

  if (exitCode !== 0) {
    throw new Error(`codex exec exited ${exitCode}; log=${logPath}`);
  }

  assertPng(screenshotPath);
  assertCodexLog(logPath, targetUrl);
  const finalText = fs.existsSync(finalPath) ? fs.readFileSync(finalPath, 'utf8') : '';
  const expectedFinal = `OK agent-${index} ${screenshotPath}`;
  if (finalText.trim() !== expectedFinal) {
    throw new Error(`missing OK final response for agent ${index}; final=${finalPath}; log=${logPath}`);
  }
  return { file: screenshotPath };
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessGroup(child.pid, 'SIGTERM');
      setTimeout(() => {
        killProcessGroup(child.pid, 'SIGKILL');
      }, 2000);
      reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`codex exec terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {}
  try { process.kill(pid, signal); } catch {}
}

function assertPng(file) {
  const buffer = fs.readFileSync(file);
  if (
    buffer.length < 8 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    throw new Error(`Invalid PNG: ${file}`);
  }
}

function assertCodexLog(logPath, targetUrl) {
  const log = fs.readFileSync(logPath, 'utf8');
  const required = [
    targetUrl,
    'mcp: pilot/pilot_navigate (completed)',
    'mcp: pilot/pilot_screenshot (completed)',
  ];
  for (const marker of required) {
    if (!log.includes(marker)) {
      throw new Error(`Missing Codex/Pilot evidence "${marker}" in ${logPath}`);
    }
  }
}

function sessionUrl(base, index) {
  const url = new URL(base);
  url.hash = `codex-agent-${index}`;
  return url.toString();
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

function assertPilotMcpConfigured() {
  try {
    execFileSync('codex', ['mcp', 'get', 'pilot'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch {
    throw new Error('Codex MCP server "pilot" is not configured. Run `codex mcp add pilot --env PILOT_BROWSER_MODE=native --env PILOT_PROFILE=full -- node /absolute/path/to/dist/index.js`.');
  }
}

function mcpDisableConfigArgs() {
  if (!disableOtherMcps) return [];

  return discoverMcpNames()
    .filter((name) => name !== 'pilot')
    .flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
}

function discoverMcpNames() {
  const configNames = discoverConfiguredMcpNames();
  if (configNames.length > 0) return configNames;

  try {
    const output = execFileSync('codex', ['mcp', 'list'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      encoding: 'utf8',
    });
    const names = new Set();
    for (const line of output.split('\n')) {
      if (!line.includes(' enabled ')) continue;
      const name = line.trim().split(/\s+/)[0];
      if (name && name !== 'Name') names.add(name);
    }
    return [...names];
  } catch {
    return [];
  }
}

function discoverConfiguredMcpNames() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }

  const names = new Set();
  const heading = /^\[mcp_servers\.((?:"[^"]+")|(?:[^\].]+))(?:\.env|\.tools\.[^\]]+)?\]$/gm;
  let match;
  while ((match = heading.exec(text))) {
    const raw = match[1];
    const name = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    if (name) names.add(name);
  }
  return [...names];
}

async function cleanupPilotProcesses() {
  const distIndex = path.join(cwd, 'dist', 'index.js');
  let output = '';
  try {
    output = execSync('ps -axo pid,command', { encoding: 'utf8' });
  } catch {
    return;
  }

  const pids = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(`node ${distIndex}`))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  if (pids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}
