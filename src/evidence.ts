/**
 * Evidence bundle recorder for agent-driven browser work.
 *
 * The recorder is intentionally small and explicit: agents opt in with
 * pilot_evidence_start, then capture step artifacts on demand or through
 * high-level tools like pilot_act. Artifacts live under the allowed output
 * directory and are written incrementally so partial runs are still useful.
 */

import type { BrowserManager } from './browser-manager.js';
import { consoleBuffer, dialogBuffer, networkBuffer, type DialogEntry, type LogEntry, type NetworkEntry } from './buffers.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface EvidenceStep {
  index: number;
  timestamp: string;
  label: string;
  action?: string;
  url?: string;
  screenshotPath?: string;
  error?: string;
  console: LogEntry[];
  network: NetworkEntry[];
  dialogs: DialogEntry[];
}

export interface EvidenceSession {
  id: string;
  name: string;
  outputDir: string;
  startedAt: string;
  steps: EvidenceStep[];
}

let activeSession: EvidenceSession | null = null;

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || 'run';
}

function writeJson(session: EvidenceSession): string {
  fs.mkdirSync(session.outputDir, { recursive: true });
  const jsonPath = path.join(session.outputDir, 'evidence.json');
  fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2), 'utf8');
  return jsonPath;
}

function formatEntryTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function writeMarkdown(session: EvidenceSession): string {
  fs.mkdirSync(session.outputDir, { recursive: true });
  const mdPath = path.join(session.outputDir, 'evidence.md');
  const lines: string[] = [
    `# Pilot Evidence: ${session.name}`,
    '',
    `- id: ${session.id}`,
    `- started: ${session.startedAt}`,
    `- output: ${session.outputDir}`,
    '',
  ];

  for (const step of session.steps) {
    lines.push(`## ${step.index}. ${step.label}`);
    lines.push('');
    lines.push(`- time: ${step.timestamp}`);
    if (step.action) lines.push(`- action: ${step.action}`);
    if (step.url) lines.push(`- url: ${step.url}`);
    if (step.screenshotPath) lines.push(`- screenshot: ${step.screenshotPath}`);
    if (step.error) lines.push(`- error: ${step.error}`);
    if (step.console.length > 0) {
      lines.push('');
      lines.push('Console:');
      lines.push('```');
      for (const entry of step.console) {
        lines.push(`[${formatEntryTime(entry.timestamp)}] [${entry.level}] ${entry.text}`);
      }
      lines.push('```');
    }
    if (step.network.length > 0) {
      lines.push('');
      lines.push('Network:');
      lines.push('```');
      for (const entry of step.network) {
        lines.push(`${entry.method} ${entry.url} -> ${entry.status ?? 'pending'} (${entry.duration ?? '?'}ms)`);
      }
      lines.push('```');
    }
    if (step.dialogs.length > 0) {
      lines.push('');
      lines.push('Dialogs:');
      lines.push('```');
      for (const entry of step.dialogs) {
        lines.push(`[${formatEntryTime(entry.timestamp)}] [${entry.type}] ${entry.message} -> ${entry.action}`);
      }
      lines.push('```');
    }
    lines.push('');
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  return mdPath;
}

export function startEvidenceSession(name?: string, outputDir?: string): EvidenceSession {
  const id = crypto.randomBytes(6).toString('hex');
  const sessionName = name?.trim() || `pilot-${id}`;
  const dir = outputDir || path.join(os.tmpdir(), `pilot-evidence-${slugify(sessionName)}-${id}`);
  activeSession = {
    id,
    name: sessionName,
    outputDir: dir,
    startedAt: new Date().toISOString(),
    steps: [],
  };
  writeJson(activeSession);
  return activeSession;
}

export function getEvidenceSession(): EvidenceSession | null {
  return activeSession;
}

export function stopEvidenceSession(): EvidenceSession | null {
  const session = activeSession;
  activeSession = null;
  return session;
}

async function currentUrl(bm: BrowserManager): Promise<string | undefined> {
  try {
    const ext = bm.getExtension();
    if (ext) {
      const res = await bm.extSend<{ url: string }>('get_url');
      return res.url;
    }
    return bm.getCurrentUrl();
  } catch {
    return undefined;
  }
}

async function captureScreenshot(bm: BrowserManager, session: EvidenceSession, index: number): Promise<string | undefined> {
  const screenshotPath = path.join(session.outputDir, `step-${String(index).padStart(2, '0')}.png`);
  try {
    const ext = bm.getExtension();
    if (ext) {
      const res = await bm.extSend<{ data: string }>('screenshot', { full_page: false });
      fs.writeFileSync(screenshotPath, Buffer.from(res.data, 'base64'));
      return screenshotPath;
    }
    await bm.getPage().screenshot({ path: screenshotPath, fullPage: false });
    return screenshotPath;
  } catch {
    return undefined;
  }
}

export async function recordEvidenceStep(
  bm: BrowserManager,
  input: {
    label: string;
    action?: string;
    error?: string;
    screenshot?: boolean;
    consoleCount?: number;
    networkCount?: number;
    dialogCount?: number;
  },
): Promise<EvidenceStep | null> {
  if (!activeSession) return null;
  fs.mkdirSync(activeSession.outputDir, { recursive: true });
  const index = activeSession.steps.length + 1;
  const step: EvidenceStep = {
    index,
    timestamp: new Date().toISOString(),
    label: input.label,
    action: input.action,
    error: input.error,
    url: await currentUrl(bm),
    console: consoleBuffer.last(input.consoleCount ?? 10),
    network: networkBuffer.last(input.networkCount ?? 10),
    dialogs: dialogBuffer.last(input.dialogCount ?? 5),
  };

  if (input.screenshot !== false) {
    step.screenshotPath = await captureScreenshot(bm, activeSession, index);
  }

  activeSession.steps.push(step);
  writeJson(activeSession);
  return step;
}

export function exportEvidenceSession(format: 'json' | 'markdown' | 'both' = 'both'): { jsonPath?: string; markdownPath?: string; session: EvidenceSession } | null {
  if (!activeSession) return null;
  const result: { jsonPath?: string; markdownPath?: string; session: EvidenceSession } = { session: activeSession };
  if (format === 'json' || format === 'both') result.jsonPath = writeJson(activeSession);
  if (format === 'markdown' || format === 'both') result.markdownPath = writeMarkdown(activeSession);
  return result;
}
