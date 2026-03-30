/**
 * Browser lifecycle manager — persistent Chromium, ref map, tab management.
 * Adapted from gstack browse/src/browser-manager.ts.
 *
 * Key difference: no HTTP daemon. Browser lives in-process with the MCP server.
 * This is faster than gstack's CLI→HTTP architecture (~5-50ms vs ~100-200ms).
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Frame,
  type Locator,
  type Cookie,
  type Route,
} from 'playwright';
import {
  addConsoleEntry,
  addNetworkEntry,
  addDialogEntry,
  networkBuffer,
  type DialogEntry,
} from './buffers.js';
import { validateNavigationUrl } from './url-validation.js';
import type { RefEntry } from './types.js';
import { extensionServer, type ExtensionServer } from './extension-server.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STATE_DIR = path.join(os.homedir(), '.pilot');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export interface BrowserState {
  cookies: Cookie[];
  pages: Array<{
    url: string;
    isActive: boolean;
    storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null;
  }>;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<number, Page> = new Map();
  private activeTabId: number = 0;
  private nextTabId: number = 1;
  private extraHeaders: Record<string, string> = {};
  private customUserAgent: string | null = null;

  // ─── Ref Map (snapshot → @e1, @e2, @c1, @c2, ...) ────────
  private refMap: Map<string, RefEntry> = new Map();

  // ─── Snapshot Diffing ─────────────────────────────────────
  private lastSnapshot: string | null = null;

  // ─── Iframe Frame Tracking ─────────────────────────────────
  private activeFrame: Frame | null = null;

  // ─── Dialog Handling ──────────────────────────────────────
  private dialogAutoAccept: boolean = true;
  private dialogPromptText: string | null = null;

  // ─── Failure Tracking ─────────────────────────────────────
  private consecutiveFailures: number = 0;

  // ─── URL Blocking ─────────────────────────────────────────
  private blockPatterns: Set<string> = new Set();
  private blockHandlers: Map<string, (route: Route) => void> = new Map();

  // ─── Network Intercepts ───────────────────────────────────
  private interceptConfigs: Map<string, { status?: number; body?: string; headers?: Record<string, string>; contentType?: string }> = new Map();
  private interceptHandlers: Map<string, (route: Route) => void> = new Map();

  // ─── Extension Bridge ─────────────────────────────────────────
  private _extActiveTab: number | undefined;

  getExtension(): ExtensionServer | null {
    return extensionServer.isConnected() ? extensionServer : null;
  }

  /** Send a command to the extension, targeting the active tab */
  async extSend<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T> {
    return extensionServer.send<T>(type, payload, this._extActiveTab);
  }

  /** Update the active extension tab (called by pilot_tab_new / pilot_tab_select) */
  setExtActiveTab(tabId: number): void {
    this._extActiveTab = tabId;
  }

  getExtActiveTab(): number | undefined {
    return this._extActiveTab;
  }

  async ensureBrowser(): Promise<void> {
    if (extensionServer.isConnected()) {
      if (!this._loggedExtension) {
        const tab = extensionServer.getSessionTab();
        console.error(`[pilot] Extension connected ✓ — using your real Chrome${tab ? ` (tab ${tab})` : ''}`);
        this._loggedExtension = true;
      }
      return;
    }
    if (this.browser && this.browser.isConnected()) return;
    if (!this._loggedHeaded) {
      console.error('[pilot] Extension not connected — running in headed Chromium mode');
      console.error('[pilot] For best experience, install the extension: npx pilot-mcp --install-extension');
      this._loggedHeaded = true;
    }
    await this.launch();
  }
  private _loggedExtension = false;
  private _loggedHeaded = false;

  async launch(): Promise<void> {
    const isLinux = process.platform === 'linux';
    const launchArgs: string[] = isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [];

    const headed = process.env.PILOT_HEADLESS !== '1';
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: !headed,
      ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
    };

    if (isLinux && process.env.PILOT_CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.PILOT_CHROMIUM_PATH;
    }

    this.browser = await chromium.launch(launchOptions);

    this.browser.on('disconnected', () => {
      console.error('[pilot] FATAL: Chromium process crashed or was killed.');
      this.browser = null;
      this.context = null;
      this.pages.clear();
    });

    const contextOptions: BrowserContextOptions = {
      viewport: { width: 1280, height: 720 },
    };
    if (this.customUserAgent) {
      contextOptions.userAgent = this.customUserAgent;
    }
    this.context = await this.browser.newContext(contextOptions);

    if (Object.keys(this.extraHeaders).length > 0) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }

    // Auto-restore persisted cookies
    // Removed: auto-loading persisted cookies on launch.
    // Cookies should only be restored via explicit pilot_auth({ action: "load" }).
    await this.applyRoutesFromConfig();

    await this.newTab();
  }

  async close(): Promise<void> {
    if (this.browser) {
      this.browser.removeAllListeners('disconnected');
      await Promise.race([
        this.browser.close(),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]).catch(() => {});
      this.browser = null;
      this.context = null;
      this.pages.clear();
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.browser || !this.browser.isConnected()) return false;
    try {
      const page = this.pages.get(this.activeTabId);
      if (!page) return true;
      await Promise.race([
        page.evaluate('1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Tab Management ────────────────────────────────────────
  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');
    if (url) await validateNavigationUrl(url);

    const page = await this.context.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;
    this.wirePageEvents(page);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    return id;
  }

  async closeTab(id?: number): Promise<void> {
    const tabId = id ?? this.activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    await page.close();
    this.pages.delete(tabId);

    if (tabId === this.activeTabId) {
      const remaining = [...this.pages.keys()];
      if (remaining.length > 0) {
        this.activeTabId = remaining[remaining.length - 1];
      } else {
        await this.newTab();
      }
    }
  }

  switchTab(id: number): void {
    if (!this.pages.has(id)) throw new Error(`Tab ${id} not found`);
    this.activeTabId = id;
  }

  getTabCount(): number {
    return this.pages.size;
  }

  async getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    const tabs: Array<{ id: number; url: string; title: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: id === this.activeTabId,
      });
    }
    return tabs;
  }

  // ─── Page Access ───────────────────────────────────────────
  getPage(): Page {
    const page = this.pages.get(this.activeTabId);
    if (!page) throw new Error('No active page. Use pilot_navigate first.');
    return page;
  }

  getCurrentUrl(): string {
    try {
      return this.getPage().url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── Ref Map ──────────────────────────────────────────────
  setRefMap(refs: Map<string, RefEntry>) {
    this.refMap = refs;
  }

  clearRefs() {
    this.refMap.clear();
  }

  async resolveRef(selector: string): Promise<{ locator: Locator } | { selector: string }> {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const ref = selector.slice(1);
      const entry = this.refMap.get(ref);
      if (!entry) {
        throw new Error(
          `Ref ${selector} not found. Run pilot_snapshot to get fresh refs.`
        );
      }
      const count = await entry.locator.count();
      if (count === 0) {
        throw new Error(
          `Ref ${selector} (${entry.role} "${entry.name}") is stale — element no longer exists. ` +
          `Run pilot_snapshot for fresh refs.`
        );
      }
      return { locator: entry.locator };
    }
    return { selector };
  }

  getRefRole(selector: string): string | null {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const entry = this.refMap.get(selector.slice(1));
      return entry?.role ?? null;
    }
    return null;
  }

  getRefCount(): number {
    return this.refMap.size;
  }

  // ─── Iframe Frames ──────────────────────────────────────
  getActiveFrame(): Frame {
    if (this.activeFrame && !this.activeFrame.isDetached()) {
      return this.activeFrame;
    }
    this.activeFrame = null;
    return this.getPage().mainFrame();
  }

  setActiveFrame(frame: Frame | null): void {
    this.activeFrame = frame;
    this.clearRefs();
  }

  async listFrames(): Promise<Array<{ index: number; url: string; name: string; isMain: boolean }>> {
    const page = this.getPage();
    return page.frames().map((f, i) => ({
      index: i,
      url: f.url(),
      name: f.name() || '',
      isMain: f === page.mainFrame(),
    }));
  }

  selectFrameByIndex(index: number): Frame {
    const page = this.getPage();
    const frames = page.frames();
    if (index < 0 || index >= frames.length) {
      throw new Error(`Frame index ${index} out of range (0-${frames.length - 1})`);
    }
    const frame = frames[index];
    this.setActiveFrame(frame === page.mainFrame() ? null : frame);
    return frame;
  }

  selectFrameByName(name: string): Frame {
    const page = this.getPage();
    const frame = page.frame({ name });
    if (!frame) {
      throw new Error(`Frame "${name}" not found. Use pilot_frames to list available frames.`);
    }
    this.setActiveFrame(frame === page.mainFrame() ? null : frame);
    return frame;
  }

  resetFrame(): void {
    this.setActiveFrame(null);
  }

  // ─── Snapshot Diffing ─────────────────────────────────────
  setLastSnapshot(text: string | null) {
    this.lastSnapshot = text;
  }

  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  // ─── Dialog Control ───────────────────────────────────────
  setDialogAutoAccept(accept: boolean) {
    this.dialogAutoAccept = accept;
  }

  getDialogAutoAccept(): boolean {
    return this.dialogAutoAccept;
  }

  setDialogPromptText(text: string | null) {
    this.dialogPromptText = text;
  }

  getDialogPromptText(): string | null {
    return this.dialogPromptText;
  }

  // ─── Viewport ──────────────────────────────────────────────
  async setViewport(width: number, height: number) {
    await this.getPage().setViewportSize({ width, height });
  }

  // ─── Extra Headers ─────────────────────────────────────────
  async setExtraHeader(name: string, value: string) {
    this.extraHeaders[name] = value;
    if (this.context) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }
  }

  // ─── User Agent ────────────────────────────────────────────
  setUserAgent(ua: string) {
    this.customUserAgent = ua;
  }

  getUserAgent(): string | null {
    return this.customUserAgent;
  }

  // ─── Context Access (for cookie operations) ────────────────
  getContext(): BrowserContext {
    if (!this.context) throw new Error('Browser not launched');
    return this.context;
  }

  // ─── State Save/Restore ───────────────────────────────────
  async saveState(): Promise<BrowserState> {
    if (!this.context) throw new Error('Browser not launched');
    const cookies = await this.context.cookies();
    const pages: BrowserState['pages'] = [];

    for (const [id, page] of this.pages) {
      const url = page.url();
      let storage = null;
      try {
        storage = await page.evaluate(() => ({
          localStorage: { ...localStorage },
          sessionStorage: { ...sessionStorage },
        }));
      } catch {}
      pages.push({
        url: url === 'about:blank' ? '' : url,
        isActive: id === this.activeTabId,
        storage,
      });
    }
    return { cookies, pages };
  }

  async restoreState(state: BrowserState): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');
    if (state.cookies.length > 0) {
      await this.context.addCookies(state.cookies);
    }

    let activeId: number | null = null;
    for (const saved of state.pages) {
      const page = await this.context.newPage();
      const id = this.nextTabId++;
      this.pages.set(id, page);
      this.wirePageEvents(page);

      if (saved.url) {
        await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }

      if (saved.storage) {
        try {
          await page.evaluate((s: { localStorage: Record<string, string>; sessionStorage: Record<string, string> }) => {
            if (s.localStorage) {
              for (const [k, v] of Object.entries(s.localStorage)) {
                localStorage.setItem(k, v);
              }
            }
            if (s.sessionStorage) {
              for (const [k, v] of Object.entries(s.sessionStorage)) {
                sessionStorage.setItem(k, v);
              }
            }
          }, saved.storage);
        } catch {}
      }
      if (saved.isActive) activeId = id;
    }

    if (this.pages.size === 0) {
      await this.newTab();
    } else {
      this.activeTabId = activeId ?? [...this.pages.keys()][0];
    }
    this.clearRefs();
  }

  // ─── Disk Persistence (cookies survive restarts) ──────────
  async persistState(): Promise<void> {
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      if (cookies.length === 0) return;
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies }, null, 2));
      console.error(`[pilot] Persisted ${cookies.length} cookies to ${STATE_FILE}`);
    } catch (err) {
      console.error(`[pilot] Failed to persist state: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async loadPersistedState(): Promise<void> {
    if (!this.context) return;
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const { cookies } = JSON.parse(raw) as { cookies: Cookie[] };
      if (cookies && cookies.length > 0) {
        await this.context.addCookies(cookies);
        console.error(`[pilot] Restored ${cookies.length} cookies from ${STATE_FILE}`);
      }
    } catch (err) {
      console.error(`[pilot] Failed to restore state: ${err instanceof Error ? err.message : err}`);
    }
  }

  async clearPersistedState(): Promise<void> {
    try {
      if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
        console.error('[pilot] Cleared persisted state');
      }
    } catch {}
  }

  async recreateContext(): Promise<string | null> {
    if (!this.browser || !this.context) throw new Error('Browser not launched');

    try {
      const state = await this.saveState();
      for (const page of this.pages.values()) {
        await page.close().catch(() => {});
      }
      this.pages.clear();
      await this.context.close().catch(() => {});

      const contextOptions: BrowserContextOptions = {
        viewport: { width: 1280, height: 720 },
      };
      if (this.customUserAgent) {
        contextOptions.userAgent = this.customUserAgent;
      }
      this.context = await this.browser.newContext(contextOptions);
      if (Object.keys(this.extraHeaders).length > 0) {
        await this.context.setExtraHTTPHeaders(this.extraHeaders);
      }
      await this.restoreState(state);
      await this.applyRoutesFromConfig();
      return null;
    } catch (err: unknown) {
      try {
        this.pages.clear();
        if (this.context) await this.context.close().catch(() => {});
        const contextOptions: BrowserContextOptions = {
          viewport: { width: 1280, height: 720 },
        };
        if (this.customUserAgent) {
          contextOptions.userAgent = this.customUserAgent;
        }
        this.context = await this.browser!.newContext(contextOptions);
        await this.newTab();
        this.clearRefs();
      } catch {}
      return `Context recreation failed: ${err instanceof Error ? err.message : String(err)}. Browser reset to blank tab.`;
    }
  }

  // ─── CDP: Connect to real user Chrome ────────────────────────
  private isCDP: boolean = false;

  async connectCDP(port: number = 9222): Promise<string> {
    const endpoint = `http://localhost:${port}`;

    let cdpBrowser: Browser;
    try {
      cdpBrowser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: Cannot connect to Chrome on port ${port} — ${msg}.\n\nMake sure Chrome is running with:\n  --remote-debugging-port=${port}\n\nExample (macOS):\n  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`;
    }

    // Grab the first existing context (real Chrome always has one)
    const contexts = cdpBrowser.contexts();
    const newContext = contexts[0] ?? await cdpBrowser.newContext();

    const oldBrowser = this.browser;

    this.browser = cdpBrowser;
    this.context = newContext;
    this.pages.clear();
    this.isHeaded = true;
    this.isCDP = true;

    this.browser.on('disconnected', () => {
      console.error('[pilot] CDP browser disconnected.');
      this.browser = null;
      this.context = null;
      this.pages.clear();
      this.isCDP = false;
    });

    // Map existing pages
    const existingPages = newContext.pages();
    if (existingPages.length > 0) {
      for (const page of existingPages) {
        const id = this.nextTabId++;
        this.pages.set(id, page);
        this.wirePageEvents(page);
      }
      this.activeTabId = [...this.pages.keys()][existingPages.length - 1];
    } else {
      await this.newTab();
    }

    this.clearRefs();

    if (oldBrowser) {
      oldBrowser.removeAllListeners('disconnected');
      oldBrowser.close().catch(() => {});
    }

    const pageCount = this.pages.size;
    const currentUrl = this.getCurrentUrl();
    return `Connected to real Chrome on port ${port}. ${pageCount} tab(s) found. Active page: ${currentUrl}\nAll automation now runs in your real Chrome profile — Cloudflare will see a real user.`;
  }

  getIsCDP(): boolean {
    return this.isCDP;
  }

  // ─── Handoff: Headless → Headed ─────────────────────────────
  private isHeaded: boolean = false;

  async handoff(): Promise<string> {
    if (this.isHeaded) {
      return `Already in headed mode at ${this.getCurrentUrl()}`;
    }
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    const state = await this.saveState();
    const currentUrl = this.getCurrentUrl();

    let newBrowser: Browser;
    const isLinux = process.platform === 'linux';
    const handoffArgs = isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [];

    const handoffOptions: Parameters<typeof chromium.launch>[0] = {
      headless: false,
      timeout: 15000,
      ...(handoffArgs.length > 0 ? { args: handoffArgs } : {}),
    };

    if (isLinux && process.env.PILOT_CHROMIUM_PATH) {
      handoffOptions.executablePath = process.env.PILOT_CHROMIUM_PATH;
    }

    try {
      newBrowser = await chromium.launch(handoffOptions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: Cannot open headed browser — ${msg}. Headless browser still running.`;
    }

    try {
      const contextOptions: BrowserContextOptions = {
        viewport: { width: 1280, height: 720 },
      };
      if (this.customUserAgent) {
        contextOptions.userAgent = this.customUserAgent;
      }
      const newContext = await newBrowser.newContext(contextOptions);

      if (Object.keys(this.extraHeaders).length > 0) {
        await newContext.setExtraHTTPHeaders(this.extraHeaders);
      }

      const oldBrowser = this.browser;

      this.browser = newBrowser;
      this.context = newContext;
      this.pages.clear();

      this.browser.on('disconnected', () => {
        console.error('[pilot] FATAL: Chromium process crashed or was killed.');
        this.browser = null;
        this.context = null;
        this.pages.clear();
      });

      await this.restoreState(state);
      this.isHeaded = true;

      oldBrowser.removeAllListeners('disconnected');
      oldBrowser.close().catch(() => {});

      return `Headed browser opened at ${currentUrl}. All cookies, tabs, and state preserved.`;
    } catch (err: unknown) {
      await newBrowser.close().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: Handoff failed — ${msg}. Headless browser still running.`;
    }
  }

  async resume(): Promise<void> {
    this.clearRefs();
    this.resetFailures();
  }

  getIsHeaded(): boolean {
    return this.isHeaded;
  }

  // ─── Failure Tracking ─────────────────────────────────────
  incrementFailures(): void {
    this.consecutiveFailures++;
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  getFailureHint(): string | null {
    if (this.consecutiveFailures >= 3) {
      return `HINT: ${this.consecutiveFailures} consecutive failures. Try running pilot_snapshot for fresh refs.`;
    }
    return null;
  }

  // ─── URL Blocking ─────────────────────────────────────────
  async addBlockPattern(pattern: string): Promise<void> {
    if (this.context && this.blockHandlers.has(pattern)) {
      await this.context.unroute(pattern, this.blockHandlers.get(pattern)!).catch(() => {});
      this.blockHandlers.delete(pattern);
    }
    this.blockPatterns.add(pattern);
    if (this.context) {
      const handler = (route: Route) => route.abort();
      this.blockHandlers.set(pattern, handler);
      await this.context.route(pattern, handler);
    }
  }

  async clearBlockPatterns(): Promise<void> {
    if (this.context) {
      for (const [pattern, handler] of this.blockHandlers) {
        await this.context.unroute(pattern, handler).catch(() => {});
      }
    }
    this.blockHandlers.clear();
    this.blockPatterns.clear();
  }

  getBlockPatterns(): string[] {
    return [...this.blockPatterns];
  }

  // ─── Network Intercepts ────────────────────────────────────
  async addIntercept(pattern: string, response: { status?: number; body?: string; headers?: Record<string, string>; contentType?: string }): Promise<void> {
    if (this.context && this.interceptHandlers.has(pattern)) {
      await this.context.unroute(pattern, this.interceptHandlers.get(pattern)!).catch(() => {});
      this.interceptHandlers.delete(pattern);
    }
    this.interceptConfigs.set(pattern, response);
    if (this.context) {
      const { status = 200, body = '', headers, contentType } = response;
      const handler = (route: Route) => route.fulfill({ status, body, headers, contentType });
      this.interceptHandlers.set(pattern, handler);
      await this.context.route(pattern, handler);
    }
  }

  async clearIntercepts(): Promise<void> {
    if (this.context) {
      for (const [pattern, handler] of this.interceptHandlers) {
        await this.context.unroute(pattern, handler).catch(() => {});
      }
    }
    this.interceptHandlers.clear();
    this.interceptConfigs.clear();
  }

  getIntercepts(): Array<{ pattern: string; status: number }> {
    return [...this.interceptConfigs.entries()].map(([pattern, cfg]) => ({
      pattern,
      status: cfg.status ?? 200,
    }));
  }

  private async applyRoutesFromConfig(): Promise<void> {
    if (!this.context) return;
    this.blockHandlers.clear();
    for (const pattern of this.blockPatterns) {
      const handler = (route: Route) => route.abort();
      this.blockHandlers.set(pattern, handler);
      await this.context.route(pattern, handler);
    }
    this.interceptHandlers.clear();
    for (const [pattern, cfg] of this.interceptConfigs) {
      const { status = 200, body = '', headers, contentType } = cfg;
      const handler = (route: Route) => route.fulfill({ status, body, headers, contentType });
      this.interceptHandlers.set(pattern, handler);
      await this.context.route(pattern, handler);
    }
  }

  // ─── Session Save/Load ────────────────────────────────────
  async saveSessionToFile(filePath: string): Promise<number> {
    const state = await this.saveState();
    const resolvedPath = filePath.replace(/^~/, os.homedir());
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, JSON.stringify(state, null, 2));
    return state.cookies.length;
  }

  async loadSessionFromFile(filePath: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');
    const resolvedPath = filePath.replace(/^~/, os.homedir());
    if (!fs.existsSync(resolvedPath)) throw new Error(`Session file not found: ${resolvedPath}`);
    const state = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as BrowserState;
    if (state.cookies && state.cookies.length > 0) {
      await this.context.addCookies(state.cookies);
    }
    const activePage = this.pages.get(this.activeTabId);
    if (activePage) {
      const savedPage = state.pages?.find(p => p.isActive) ?? state.pages?.[0];
      if (savedPage?.storage) {
        try {
          await activePage.evaluate((s) => {
            for (const [k, v] of Object.entries(s.localStorage || {})) localStorage.setItem(k, v);
            for (const [k, v] of Object.entries(s.sessionStorage || {})) sessionStorage.setItem(k, v);
          }, savedPage.storage);
        } catch {}
      }
    }
    return state.cookies?.length ?? 0;
  }

  async clearSession(): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');
    await this.context.clearCookies();
    for (const page of this.pages.values()) {
      try {
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      } catch {}
    }
  }

  // ─── Single Ref Addition (for pilot_find) ─────────────────
  addSingleRef(locator: Locator, role: string, name: string): string {
    let maxN = 0;
    for (const k of this.refMap.keys()) {
      if (k.startsWith('e')) {
        const n = parseInt(k.slice(1), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
    const ref = `e${maxN + 1}`;
    this.refMap.set(ref, { locator, role, name });
    return ref;
  }

  // ─── Page Event Wiring ────────────────────────────────────
  private wirePageEvents(page: Page) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs();
      }
    });

    page.on('dialog', async (dialog) => {
      const entry: DialogEntry = {
        timestamp: Date.now(),
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue() || undefined,
        action: this.dialogAutoAccept ? 'accepted' : 'dismissed',
        response: this.dialogAutoAccept ? (this.dialogPromptText ?? undefined) : undefined,
      };
      addDialogEntry(entry);

      try {
        if (this.dialogAutoAccept) {
          await dialog.accept(this.dialogPromptText ?? undefined);
        } else {
          await dialog.dismiss();
        }
      } catch {}
    });

    page.on('console', (msg) => {
      addConsoleEntry({
        timestamp: Date.now(),
        level: msg.type(),
        text: msg.text(),
      });
    });

    page.on('request', (req) => {
      addNetworkEntry({
        timestamp: Date.now(),
        method: req.method(),
        url: req.url(),
      });
    });

    page.on('response', (res) => {
      const url = res.url();
      const status = res.status();
      for (let i = networkBuffer.length - 1; i >= 0; i--) {
        const entry = networkBuffer.get(i);
        if (entry && entry.url === url && !entry.status) {
          networkBuffer.set(i, { ...entry, status, duration: Date.now() - entry.timestamp });
          break;
        }
      }
    });

    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (res) {
          const url = req.url();
          const body = await res.body().catch(() => null);
          const size = body ? body.length : 0;
          for (let i = networkBuffer.length - 1; i >= 0; i--) {
            const entry = networkBuffer.get(i);
            if (entry && entry.url === url && !entry.size) {
              networkBuffer.set(i, { ...entry, size });
              break;
            }
          }
        }
      } catch {}
    });
  }
}
