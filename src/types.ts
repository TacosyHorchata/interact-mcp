import type { Locator } from 'playwright';

export interface RefEntry {
  locator: Locator;
  role: string;
  name: string;
}

export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  cursorInteractive?: boolean;
  maxElements?: number;
  structureOnly?: boolean;
  lean?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
