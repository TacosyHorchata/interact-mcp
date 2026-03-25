import { describe, it, expect } from 'vitest';
import { sanitizeBrowserName } from '../src/cookie-import.js';
import { validateOutputPath } from '../src/tools/visual.js';
import * as os from 'os';
import * as path from 'path';

describe('sanitizeBrowserName', () => {
  it('passes normal browser names through unchanged', () => {
    expect(sanitizeBrowserName('Chrome')).toBe('chrome');
    expect(sanitizeBrowserName('Brave')).toBe('brave');
    expect(sanitizeBrowserName('Arc')).toBe('arc');
  });

  it('strips forward slashes', () => {
    expect(sanitizeBrowserName('foo/bar')).toBe('foobar');
  });

  it('strips backslashes', () => {
    expect(sanitizeBrowserName('foo\\bar')).toBe('foobar');
  });

  it('removes parent directory references', () => {
    expect(sanitizeBrowserName('../../etc')).toBe('etc');
  });

  it('removes null bytes and control characters', () => {
    expect(sanitizeBrowserName('chr\x00ome')).toBe('chrome');
    expect(sanitizeBrowserName(`chr${String.fromCharCode(0x1f)}ome`)).toBe('chrome');
  });

  it('returns "unknown" for empty or whitespace-only strings', () => {
    expect(sanitizeBrowserName('')).toBe('unknown');
    expect(sanitizeBrowserName('   ')).toBe('unknown');
  });

  it('handles mixed case', () => {
    expect(sanitizeBrowserName('ChRoMe')).toBe('chrome');
  });

  it('returns "unknown" when all characters are stripped', () => {
    expect(sanitizeBrowserName('....')).toBe('unknown');
    expect(sanitizeBrowserName('!@#$%')).toBe('unknown');
  });
});

describe('validateOutputPath', () => {
  it('accepts paths within the default tmpdir', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-output.png');
    expect(() => validateOutputPath(tmpFile)).not.toThrow();
  });

  it('accepts paths in a subdirectory of tmpdir', () => {
    const nested = path.join(os.tmpdir(), 'sub', 'dir', 'file.png');
    expect(() => validateOutputPath(nested)).not.toThrow();
  });

  it('rejects paths outside the allowed directory', () => {
    expect(() => validateOutputPath('/etc/passwd')).toThrow(
      /Output path must be within/,
    );
  });

  it('rejects path traversal attempts', () => {
    const traversal = path.join(os.tmpdir(), '..', 'etc', 'passwd');
    expect(() => validateOutputPath(traversal)).toThrow(
      /Output path must be within/,
    );
  });

  it('respects PILOT_OUTPUT_DIR environment variable', () => {
    const originalDir = process.env.PILOT_OUTPUT_DIR;
    process.env.PILOT_OUTPUT_DIR = '/var/tmp';
    try {
      const validPath = path.join('/var/tmp', 'output.pdf');
      expect(() => validateOutputPath(validPath)).not.toThrow();

      const invalidPath = '/etc/shadow';
      expect(() => validateOutputPath(invalidPath)).toThrow(
        /Output path must be within/,
      );
    } finally {
      if (originalDir === undefined) {
        delete process.env.PILOT_OUTPUT_DIR;
      } else {
        process.env.PILOT_OUTPUT_DIR = originalDir;
      }
    }
  });
});
