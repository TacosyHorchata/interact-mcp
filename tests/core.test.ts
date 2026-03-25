import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TOOLS_DIR = path.resolve(__dirname, '../src/tools');

const TOOL_FILES = [
  'navigation.ts',
  'snapshot-tools.ts',
  'interaction.ts',
  'page.ts',
  'inspection.ts',
  'visual.ts',
  'tabs.ts',
  'settings.ts',
  'iframe.ts',
];

interface ToolDef {
  name: string;
  description: string;
  file: string;
}

const ACTION_VERB_RE = /^[A-Z][a-zA-Z]+ /;

const SCENARIO_TRIGGER_RE =
  /\b(use when|use this|use to|use it|use for|ideal for|useful when|helpful when|when the user)\b/i;

const RETURNS_RE = /^Returns:?\s/mi;

const ERRORS_RE = /^Errors:?\s/mi;

function extractTools(filePath: string): ToolDef[] {
  const src = fs.readFileSync(filePath, 'utf-8');
  const tools: ToolDef[] = [];
  const re = /server\.tool\(\s*'([^']+)',\s*`([\s\S]*?)`\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    tools.push({
      name: match[1],
      description: match[2].trim(),
      file: path.basename(filePath),
    });
  }
  return tools;
}

function getAllTools(): ToolDef[] {
  return TOOL_FILES.flatMap((f) =>
    extractTools(path.join(TOOLS_DIR, f)),
  );
}

describe('tool description quality', () => {
  let tools: ToolDef[];

  beforeAll(() => {
    tools = getAllTools();
  });

  it('should find at least 30 tools across all tool files', () => {
    expect(tools.length).toBeGreaterThanOrEqual(30);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has a description longer than 40 characters', () => {
    const short = tools.filter((t) => t.description.length <= 40);
    expect(
      short,
      `Tools with descriptions <= 40 chars: ${short.map((t) => `${t.name} (${t.description.length} chars)`).join(', ')}`,
    ).toHaveLength(0);
  });

  it('every tool description starts with an action verb (capitalized word)', () => {
    const noVerb = tools.filter((t) => !ACTION_VERB_RE.test(t.description));
    expect(
      noVerb,
      `Tools missing action verb start: ${noVerb.map((t) => `${t.name} starts with "${t.description.slice(0, 20)}..."`).join(', ')}`,
    ).toHaveLength(0);
  });

  it('every tool description contains a scenario trigger ("Use when" or similar)', () => {
    const noTrigger = tools.filter((t) => !SCENARIO_TRIGGER_RE.test(t.description));
    expect(
      noTrigger,
      `Tools missing scenario trigger: ${noTrigger.map((t) => t.name).join(', ')}`,
    ).toHaveLength(0);
  });

  it('every tool description mentions what it returns', () => {
    const noReturns = tools.filter((t) => !RETURNS_RE.test(t.description));
    expect(
      noReturns,
      `Tools missing "Returns" section: ${noReturns.map((t) => t.name).join(', ')}`,
    ).toHaveLength(0);
  });

  it('every tool description mentions possible errors', () => {
    const noErrors = tools.filter((t) => !ERRORS_RE.test(t.description));
    expect(
      noErrors,
      `Tools missing "Errors" section: ${noErrors.map((t) => t.name).join(', ')}`,
    ).toHaveLength(0);
  });
});

describe('tool file structure', () => {
  it('all tool files exist and are readable', () => {
    for (const f of TOOL_FILES) {
      const fullPath = path.join(TOOLS_DIR, f);
      expect(fs.existsSync(fullPath), `Missing tool file: ${f}`).toBe(true);
      const stat = fs.statSync(fullPath);
      expect(stat.size, `Empty tool file: ${f}`).toBeGreaterThan(0);
    }
  });

  it('every tool file exports a register function', () => {
    for (const f of TOOL_FILES) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, f), 'utf-8');
      const hasExport = /export\s+function\s+register\w+Tools/.test(src);
      expect(hasExport, `${f} must export a register*Tools function`).toBe(true);
    }
  });

  it('all tools follow pilot_ naming convention', () => {
    const tools = getAllTools();
    const badNames = tools.filter((t) => !t.name.startsWith('pilot_'));
    expect(
      badNames,
      `Tools with non-pilot_ prefix: ${badNames.map((t) => t.name).join(', ')}`,
    ).toHaveLength(0);
  });
});
