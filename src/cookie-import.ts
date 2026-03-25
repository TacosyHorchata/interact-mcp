/**
 * Chromium browser cookie import — read and decrypt cookies from real browsers.
 * Ported from gstack browse/src/cookie-import-browser.ts.
 *
 * Changes from gstack:
 *   - bun:sqlite → better-sqlite3
 *   - Bun.spawn → child_process.spawn/execSync
 *   - Removed picker UI (MCP uses direct import)
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

// ─── Types ──────────────────────────────────────────────────────

export interface BrowserInfo {
  name: string;
  dataDir: string;
  keychainService: string;
  aliases: string[];
  linuxDataDir?: string;
  linuxApplication?: string;
}

export interface ImportResult {
  cookies: PlaywrightCookie[];
  count: number;
  failed: number;
  domainCounts: Record<string, number>;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export class CookieImportError extends Error {
  constructor(
    message: string,
    public code: string,
    public action?: 'retry',
  ) {
    super(message);
    this.name = 'CookieImportError';
  }
}

type BrowserPlatform = 'darwin' | 'linux';

interface BrowserMatch {
  browser: BrowserInfo;
  platform: BrowserPlatform;
  dbPath: string;
}

// ─── Browser Registry ───────────────────────────────────────────

const BROWSER_REGISTRY: BrowserInfo[] = [
  { name: 'Comet',    dataDir: 'Comet/',                         keychainService: 'Comet Safe Storage',          aliases: ['comet', 'perplexity'] },
  { name: 'Chrome',   dataDir: 'Google/Chrome/',                 keychainService: 'Chrome Safe Storage',         aliases: ['chrome', 'google-chrome'], linuxDataDir: 'google-chrome/', linuxApplication: 'chrome' },
  { name: 'Chromium', dataDir: 'chromium/',                      keychainService: 'Chromium Safe Storage',       aliases: ['chromium'], linuxDataDir: 'chromium/', linuxApplication: 'chromium' },
  { name: 'Arc',      dataDir: 'Arc/User Data/',                 keychainService: 'Arc Safe Storage',            aliases: ['arc'] },
  { name: 'Brave',    dataDir: 'BraveSoftware/Brave-Browser/',   keychainService: 'Brave Safe Storage',          aliases: ['brave'], linuxDataDir: 'BraveSoftware/Brave-Browser/', linuxApplication: 'brave' },
  { name: 'Edge',     dataDir: 'Microsoft Edge/',                keychainService: 'Microsoft Edge Safe Storage', aliases: ['edge'], linuxDataDir: 'microsoft-edge/', linuxApplication: 'microsoft-edge' },
];

// ─── Key Cache ──────────────────────────────────────────────────

const keyCache = new Map<string, Buffer>();

// ─── Public API ─────────────────────────────────────────────────

export function findInstalledBrowsers(): BrowserInfo[] {
  return BROWSER_REGISTRY.filter(browser => {
    if (findBrowserMatch(browser, 'Default') !== null) return true;
    for (const platform of getSearchPlatforms()) {
      const dataDir = getDataDirForPlatform(browser, platform);
      if (!dataDir) continue;
      const browserDir = path.join(getBaseDir(platform), dataDir);
      try {
        const entries = fs.readdirSync(browserDir, { withFileTypes: true });
        if (entries.some(e =>
          e.isDirectory() && e.name.startsWith('Profile ') &&
          fs.existsSync(path.join(browserDir, e.name, 'Cookies'))
        )) return true;
      } catch {}
    }
    return false;
  });
}

export function listSupportedBrowserNames(): string[] {
  const hostPlatform = getHostPlatform();
  return BROWSER_REGISTRY
    .filter(browser => hostPlatform ? getDataDirForPlatform(browser, hostPlatform) !== null : true)
    .map(browser => browser.name);
}

export function listProfiles(browserName: string): Array<{ name: string; displayName: string }> {
  const browser = resolveBrowser(browserName);
  const profiles: Array<{ name: string; displayName: string }> = [];

  for (const platform of getSearchPlatforms()) {
    const dataDir = getDataDirForPlatform(browser, platform);
    if (!dataDir) continue;
    const browserDir = path.join(getBaseDir(platform), dataDir);
    if (!fs.existsSync(browserDir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(browserDir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== 'Default' && !entry.name.startsWith('Profile ')) continue;
      const cookiePath = path.join(browserDir, entry.name, 'Cookies');
      if (!fs.existsSync(cookiePath)) continue;
      if (profiles.some(p => p.name === entry.name)) continue;

      let displayName = entry.name;
      try {
        const prefsPath = path.join(browserDir, entry.name, 'Preferences');
        if (fs.existsSync(prefsPath)) {
          const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
          const email = prefs?.account_info?.[0]?.email;
          if (email && typeof email === 'string') {
            displayName = email;
          } else {
            const profileName = prefs?.profile?.name;
            if (profileName && typeof profileName === 'string') {
              displayName = profileName;
            }
          }
        }
      } catch {}

      profiles.push({ name: entry.name, displayName });
    }
    if (profiles.length > 0) break;
  }
  return profiles;
}

export function listDomains(browserName: string, profile = 'Default'): { domains: Array<{ domain: string; count: number }>; browser: string } {
  const browser = resolveBrowser(browserName);
  const match = getBrowserMatch(browser, profile);
  const db = openDb(match.dbPath, browser.name);
  try {
    const now = chromiumNow();
    const rows = db.prepare(
      `SELECT host_key AS domain, COUNT(*) AS count
       FROM cookies
       WHERE has_expires = 0 OR expires_utc > ?
       GROUP BY host_key
       ORDER BY count DESC`
    ).all(now.toString()) as Array<{ domain: string; count: number }>;
    return { domains: rows, browser: browser.name };
  } finally {
    db.close();
  }
}

export async function importCookies(
  browserName: string,
  domains: string[],
  profile = 'Default',
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };

  const browser = resolveBrowser(browserName);
  const match = getBrowserMatch(browser, profile);
  const derivedKeys = await getDerivedKeys(match);
  const db = openDb(match.dbPath, browser.name);

  try {
    const now = chromiumNow();
    const placeholders = domains.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, has_expires, samesite
       FROM cookies
       WHERE host_key IN (${placeholders})
         AND (has_expires = 0 OR expires_utc > ?)
       ORDER BY host_key, name`
    );
    const rows = stmt.all(...domains, now.toString()) as RawCookie[];

    const cookies: PlaywrightCookie[] = [];
    let failed = 0;
    const domainCounts: Record<string, number> = {};

    for (const row of rows) {
      try {
        const value = decryptCookieValue(row, derivedKeys);
        const cookie = toPlaywrightCookie(row, value);
        cookies.push(cookie);
        domainCounts[row.host_key] = (domainCounts[row.host_key] || 0) + 1;
      } catch {
        failed++;
      }
    }

    return { cookies, count: cookies.length, failed, domainCounts };
  } finally {
    db.close();
  }
}

// ─── Internal: Browser Resolution ───────────────────────────────

function resolveBrowser(nameOrAlias: string): BrowserInfo {
  const needle = nameOrAlias.toLowerCase().trim();
  const found = BROWSER_REGISTRY.find(b =>
    b.aliases.includes(needle) || b.name.toLowerCase() === needle
  );
  if (!found) {
    const supported = BROWSER_REGISTRY.flatMap(b => b.aliases).join(', ');
    throw new CookieImportError(
      `Unknown browser '${nameOrAlias}'. Supported: ${supported}`,
      'unknown_browser',
    );
  }
  return found;
}

function validateProfile(profile: string): void {
  if (/[/\\]|\.\./.test(profile) || /[\x00-\x1f]/.test(profile)) {
    throw new CookieImportError(`Invalid profile name: '${profile}'`, 'bad_request');
  }
}

function getHostPlatform(): BrowserPlatform | null {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform;
  return null;
}

function getSearchPlatforms(): BrowserPlatform[] {
  const current = getHostPlatform();
  const order: BrowserPlatform[] = [];
  if (current) order.push(current);
  for (const platform of ['darwin', 'linux'] as BrowserPlatform[]) {
    if (!order.includes(platform)) order.push(platform);
  }
  return order;
}

function getDataDirForPlatform(browser: BrowserInfo, platform: BrowserPlatform): string | null {
  return platform === 'darwin' ? browser.dataDir : browser.linuxDataDir || null;
}

function getBaseDir(platform: BrowserPlatform): string {
  return platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config');
}

function findBrowserMatch(browser: BrowserInfo, profile: string): BrowserMatch | null {
  validateProfile(profile);
  for (const platform of getSearchPlatforms()) {
    const dataDir = getDataDirForPlatform(browser, platform);
    if (!dataDir) continue;
    const dbPath = path.join(getBaseDir(platform), dataDir, profile, 'Cookies');
    try {
      if (fs.existsSync(dbPath)) {
        return { browser, platform, dbPath };
      }
    } catch {}
  }
  return null;
}

function getBrowserMatch(browser: BrowserInfo, profile: string): BrowserMatch {
  const match = findBrowserMatch(browser, profile);
  if (match) return match;

  const attempted = getSearchPlatforms()
    .map(platform => {
      const dataDir = getDataDirForPlatform(browser, platform);
      return dataDir ? path.join(getBaseDir(platform), dataDir, profile, 'Cookies') : null;
    })
    .filter((entry): entry is string => entry !== null);

  throw new CookieImportError(
    `${browser.name} is not installed (no cookie database at ${attempted.join(' or ')})`,
    'not_installed',
  );
}

// ─── Internal: Input Sanitization ───────────────────────────────

export function sanitizeBrowserName(browserName: string): string {
  return browserName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .trim() || 'unknown';
}

// ─── Internal: SQLite Access ────────────────────────────────────

function openDb(dbPath: string, browserName: string): Database.Database {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: any) {
    if (err.message?.includes('SQLITE_BUSY') || err.message?.includes('database is locked')) {
      return openDbFromCopy(dbPath, browserName);
    }
    if (err.message?.includes('SQLITE_CORRUPT') || err.message?.includes('malformed')) {
      throw new CookieImportError(`Cookie database for ${browserName} is corrupt`, 'db_corrupt');
    }
    throw err;
  }
}

function openDbFromCopy(dbPath: string, browserName: string): Database.Database {
  const tmpPath = path.join(os.tmpdir(), `pilot-cookies-${sanitizeBrowserName(browserName)}-${crypto.randomUUID()}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, tmpPath + '-wal');
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, tmpPath + '-shm');

    const db = new Database(tmpPath, { readonly: true });
    const origClose = db.close.bind(db);
    (db as any).close = () => {
      origClose();
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
      try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
    };
    return db;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new CookieImportError(
      `Cookie database is locked (${browserName} may be running). Try closing ${browserName} first.`,
      'db_locked',
      'retry',
    );
  }
}

// ─── Internal: Keychain Access ──────────────────────────────────

function deriveKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

function getCachedDerivedKey(cacheKey: string, password: string, iterations: number): Buffer {
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const derived = deriveKey(password, iterations);
  keyCache.set(cacheKey, derived);
  return derived;
}

async function getDerivedKeys(match: BrowserMatch): Promise<Map<string, Buffer>> {
  if (match.platform === 'darwin') {
    const password = await getMacKeychainPassword(match.browser.keychainService);
    return new Map([
      ['v10', getCachedDerivedKey(`darwin:${match.browser.keychainService}:v10`, password, 1003)],
    ]);
  }

  const keys = new Map<string, Buffer>();
  keys.set('v10', getCachedDerivedKey('linux:v10', 'peanuts', 1));

  const linuxPassword = await getLinuxSecretPassword(match.browser);
  if (linuxPassword) {
    keys.set('v11', getCachedDerivedKey(`linux:${match.browser.keychainService}:v11`, linuxPassword, 1));
  }
  return keys;
}

async function getMacKeychainPassword(service: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn('security', ['find-generic-password', '-s', service, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new CookieImportError(
        `macOS is waiting for Keychain permission. Look for a dialog asking to allow access to "${service}".`,
        'keychain_timeout',
        'retry',
      ));
    }, 10_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errText = stderr.trim().toLowerCase();
        if (errText.includes('user canceled') || errText.includes('denied') || errText.includes('interaction not allowed')) {
          reject(new CookieImportError(
            `Keychain access denied. Click "Allow" in the macOS dialog for "${service}".`,
            'keychain_denied',
            'retry',
          ));
          return;
        }
        if (errText.includes('could not be found') || errText.includes('not found')) {
          reject(new CookieImportError(
            `No Keychain entry for "${service}". Is this a Chromium-based browser?`,
            'keychain_not_found',
          ));
          return;
        }
        reject(new CookieImportError(`Could not read Keychain: ${stderr.trim()}`, 'keychain_error', 'retry'));
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new CookieImportError(`Could not read Keychain: ${err.message}`, 'keychain_error', 'retry'));
    });
  });
}

async function getLinuxSecretPassword(browser: BrowserInfo): Promise<string | null> {
  const attempts: string[][] = [
    ['secret-tool', 'lookup', 'Title', browser.keychainService],
  ];
  if (browser.linuxApplication) {
    attempts.push(
      ['secret-tool', 'lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', browser.linuxApplication],
      ['secret-tool', 'lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password', 'application', browser.linuxApplication],
    );
  }
  for (const cmd of attempts) {
    const password = await runPasswordLookup(cmd, 3_000);
    if (password) return password;
  }
  return null;
}

async function runPasswordLookup(cmd: string[], timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve(null); return; }
        const password = stdout.trim();
        resolve(password.length > 0 ? password : null);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

// ─── Internal: Cookie Decryption ────────────────────────────────

interface RawCookie {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer | Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number;
  is_httponly: number;
  has_expires: number;
  samesite: number;
}

function decryptCookieValue(row: RawCookie, keys: Map<string, Buffer>): string {
  if (row.value && row.value.length > 0) return row.value;

  const ev = Buffer.from(row.encrypted_value);
  if (ev.length === 0) return '';

  const prefix = ev.slice(0, 3).toString('utf-8');
  const key = keys.get(prefix);
  if (!key) throw new Error(`No decryption key available for ${prefix} cookies`);

  const ciphertext = ev.slice(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (plaintext.length <= 32) return '';
  return plaintext.slice(32).toString('utf-8');
}

function toPlaywrightCookie(row: RawCookie, value: string): PlaywrightCookie {
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    expires: chromiumEpochToUnix(row.expires_utc, row.has_expires),
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite: mapSameSite(row.samesite),
  };
}

// ─── Internal: Chromium Epoch Conversion ────────────────────────

const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;

function chromiumNow(): bigint {
  return BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET;
}

function chromiumEpochToUnix(epoch: number | bigint, hasExpires: number): number {
  if (hasExpires === 0 || epoch === 0 || epoch === 0n) return -1;
  const epochBig = BigInt(epoch);
  const unixMicro = epochBig - CHROMIUM_EPOCH_OFFSET;
  return Number(unixMicro / 1000000n);
}

function mapSameSite(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}
