/**
 * Extension Multiplexer — Broker/Client architecture
 *
 * Multiple Claude Code sessions share one Chrome extension.
 * Each session gets its own Chrome tab.
 *
 * First pilot process to start → broker (holds port 3131, WS server)
 * Subsequent pilot processes → clients (connect to broker via WS)
 * Chrome extension → connects to broker, receives routed commands
 *
 * Flow:
 *   MCP Session A → broker → extension → Tab 1
 *   MCP Session B → broker → extension → Tab 2
 *   MCP Session C → broker → extension → Tab 3
 */

import { WebSocketServer, WebSocket } from 'ws';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { execSync } from 'child_process';
import * as crypto from 'crypto';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateNavigationUrl } from './url-validation.js';

const PORT = Number(process.env.PILOT_EXTENSION_PORT || 3131);
const COMMAND_TIMEOUT = 30_000;
const RECONNECT_DELAY = 3_000;
const HEARTBEAT_INTERVAL = 15_000; // ping clients every 15s
const HEARTBEAT_TIMEOUT = 10_000;  // dead if no pong within 10s
const EXTENSION_KEEPALIVE_INTERVAL = 10_000;
const SCREENSHOT_MIN_INTERVAL = 1000;
const BROWSER_MODE = (process.env.PILOT_BROWSER_MODE || 'native').toLowerCase();
const TOKEN_DIR = path.join(os.homedir(), '.pilot');
const TOKEN_FILE = path.join(TOKEN_DIR, 'broker-token');
const BROKER_INFO_FILE = path.join(TOKEN_DIR, `broker-${PORT}.json`);

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NativeRef = {
  locator: Locator;
  role: string;
  name: string;
};

type NativeSession = {
  context: BrowserContext;
  pages: Map<number, Page>;
  activeTabId: number;
  nextTabId: number;
  refMap: Map<string, NativeRef>;
};

type BrokerInfo = {
  pid: number;
  port: number;
  sessionId: string;
  backend: string;
  startedAt: string;
};

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

export function formatNativeActionErrorMessage(
  action: string,
  ref: unknown,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const hints: string[] = [];

  if (/strict mode violation/i.test(message)) {
    hints.push('selector matched multiple elements; run pilot_snapshot or pilot_find and use a unique @ref');
  }
  if (/outside of the viewport|not visible|element is not visible/i.test(message)) {
    hints.push('element is not interactable in the viewport; run pilot_scroll or target a visible @ref');
  }
  if (/Timeout \d+ms exceeded|timed out/i.test(message)) {
    hints.push('page or selector was not ready; run pilot_snapshot to verify current state before retrying');
  }
  if (/waiting for locator/i.test(message)) {
    hints.push('selector did not resolve to an actionable element; prefer snapshot refs over broad CSS/text selectors');
  }

  const target = ref === undefined || ref === null || ref === '' ? '' : ` ${String(ref)}`;
  const suffix = hints.length > 0 ? ` Hint: ${[...new Set(hints)].join('; ')}.` : '';
  return `pilot_${action}${target} failed: ${message}${suffix}`;
}

export class ExtensionServer {
  // Identity
  readonly sessionId = crypto.randomUUID();
  private _counter = 0;
  private pending: Map<string, PendingRequest> = new Map();
  private _brokerToken: string | null = null;

  // Mode
  private mode: 'broker' | 'client' | null = null;

  // Broker state
  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private mcpClients: Map<string, WebSocket> = new Map(); // sessionId → ws
  private sessionTabs: Map<string, number> = new Map();   // sessionId → chrome tabId
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private extensionKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private screenshotForwardQueue: Promise<void> = Promise.resolve();
  private lastScreenshotForwardAt = 0;
  private nativeBrowser: Browser | null = null;
  private nativeSessions: Map<string, NativeSession> = new Map();
  private nativeGlobalTabId = 1;
  private nativeBrowserPids: Set<number> = new Set();

  // Client state
  private brokerSocket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private extensionReady = false;
  private clientAssignedTabId: number | undefined;
  private stopped = false;

  // ─── Startup ──────────────────────────────────────────────

  start(): void {
    if (this.mode) return;
    this.stopped = false;
    this._tryBroker();
  }

  private _tryBroker(): void {
    if (this.stopped) return;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

    wss.on('listening', () => {
      this.mode = 'broker';
      this.wss = wss;
      // Generate and persist a broker token for authentication
      this._brokerToken = crypto.randomUUID();
      try {
        fs.mkdirSync(TOKEN_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, this._brokerToken, { mode: 0o600 });
        fs.writeFileSync(BROKER_INFO_FILE, JSON.stringify(this._brokerInfo(), null, 2), { mode: 0o600 });
      } catch {}
      this._startHeartbeat();
      console.error(`[pilot] Broker mode — listening on ws://127.0.0.1:${PORT} (session ${this.sessionId.slice(0, 8)})`);
    });

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[pilot] Port ${PORT} taken — connecting as client${this._brokerOwnerSummary()}`);
        this._connectAsClient();
      } else {
        console.error(`[pilot] WS server error: ${err.message}`);
      }
    });

    wss.on('connection', (ws) => this._handleBrokerConnection(ws));
  }

  // ─── Broker: Handle Connections ───────────────────────────

  private _handleBrokerConnection(ws: WebSocket): void {
    let identified = false;
    let role: 'extension' | 'mcp' = 'extension';
    let clientSessionId: string | null = null;

    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // First message identifies the connection
      if (!identified && msg.type === 'hello') {
        // Validate broker token for MCP clients (extension is exempt —
        // it's physically installed by the user and can't read the token file)
        if (msg.role === 'mcp' && this._brokerToken && msg.token !== this._brokerToken) {
          console.error(`[pilot] Rejected MCP client — invalid token`);
          ws.close(4001, 'Invalid token');
          return;
        }
        identified = true;
        role = msg.role;

        if (role === 'extension') {
          if (this.extensionSocket?.readyState === WebSocket.OPEN) {
            this.extensionSocket.close();
          }
          this.extensionSocket = ws;
          this.extensionReady = true;
          this._checkState();
          this._startExtensionKeepalive();
          this._broadcastExtensionState(true);

          if (this._shouldUseExtension()) {
            // Prune dead clients before re-initializing tabs
            this._pruneDeadClients();

            // Initialize tabs for all live sessions (including broker's own)
            for (const sid of [this.sessionId, ...this.mcpClients.keys()]) {
              if (!this.sessionTabs.has(sid)) {
                this._initSession(sid);
              }
            }
          }
          return;
        }

        if (role === 'mcp') {
          clientSessionId = msg.sessionId;
          this.mcpClients.set(clientSessionId!, ws);
          console.error(`[pilot] MCP client connected: ${clientSessionId!.slice(0, 8)}`);
          ws.send(JSON.stringify({
            id: msg.id,
            type: 'hello_ack',
            sessionId: clientSessionId,
            extensionConnected: this.isConnected(),
            backend: this.getBackend(),
          }));

          // Create a tab for this session
          if (this._shouldUseExtension()) {
            this._initSession(clientSessionId!);
          } else if (this._isNativeEnabled()) {
            this._initNativeSession(clientSessionId!)
              .catch((err) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'extension_state', sessionId: clientSessionId, extensionConnected: false, error: err.message }));
                }
              });
          }
          return;
        }
        return;
      }

      if (role === 'extension') {
        // Response from extension — route to the right MCP client (or self)
        this._handleExtensionResponse(msg);
      } else if (role === 'mcp' && clientSessionId) {
        // Command from MCP client — route to extension or native Playwright backend
        this._routeClientCommand(clientSessionId, msg);
      }
    });

    ws.on('close', () => {
      if (role === 'extension' && this.extensionSocket === ws) {
        this.extensionSocket = null;
        this.sessionTabs.clear();
        this.extensionReady = false;
        this._checkState();
        this._broadcastExtensionState(false);
      } else if (role === 'mcp' && clientSessionId) {
        console.error(`[pilot] MCP client disconnected: ${clientSessionId.slice(0, 8)}`);
        this.mcpClients.delete(clientSessionId);
        // Close the tab for this session
        this._closeSession(clientSessionId);
        this._closeNativeSession(clientSessionId);
        this.sessionTabs.delete(clientSessionId);
      }
    });

    ws.on('error', () => {});
  }

  /** Ask extension to create a tab for a session */
  private _initSession(sessionId: string): void {
    if (!this.extensionSocket || this.sessionTabs.has(sessionId)) return;
    const id = `sys-init-${sessionId.slice(0, 8)}-${++this._counter}`;
    this.extensionSocket.send(JSON.stringify({
      id, type: 'session_init', sessionId,
    }));

    // Listen for the response to store tabId
    const handler = (data: any) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id === id && msg.result?.tabId) {
        this.sessionTabs.set(sessionId, msg.result.tabId);
        console.error(`[pilot] Session ${sessionId.slice(0, 8)} → tab ${msg.result.tabId}`);
        const clientWs = this.mcpClients.get(sessionId);
        if (clientWs?.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'session_assigned',
            sessionId,
            tabId: msg.result.tabId,
          }));
        }
        this.extensionSocket?.removeListener('message', handler);
      }
    };
    this.extensionSocket.on('message', handler);
    // Cleanup handler after 10s
    setTimeout(() => this.extensionSocket?.removeListener('message', handler), 10_000);
  }

  /** Ask extension to close tab for a session */
  private _closeSession(sessionId: string): void {
    const tabId = this.sessionTabs.get(sessionId);
    if (!tabId || !this.extensionSocket) return;
    this.extensionSocket.send(JSON.stringify({
      id: `sys-close-${sessionId.slice(0, 8)}`, type: 'session_close', sessionId, tabId,
    }));
  }

  /** Remove MCP clients whose WebSocket is no longer open */
  private _pruneDeadClients(): void {
    for (const [sid, ws] of this.mcpClients) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.error(`[pilot] Pruned stale session ${sid.slice(0, 8)} (readyState=${ws.readyState})`);
        this.mcpClients.delete(sid);
        this._closeSession(sid);
        this.sessionTabs.delete(sid);
      }
    }
  }

  /** Periodic heartbeat to detect dead clients proactively */
  private _startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [sid, ws] of this.mcpClients) {
        if (ws.readyState !== WebSocket.OPEN) {
          console.error(`[pilot] Heartbeat: pruned dead session ${sid.slice(0, 8)}`);
          this.mcpClients.delete(sid);
          this._closeSession(sid);
          this._closeNativeSession(sid);
          this.sessionTabs.delete(sid);
          continue;
        }
        // Ping with timeout — if no pong, terminate
        ws.ping();
        const pongTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            console.error(`[pilot] Heartbeat: session ${sid.slice(0, 8)} unresponsive — terminating`);
            ws.terminate();
            this.mcpClients.delete(sid);
            this._closeSession(sid);
            this._closeNativeSession(sid);
            this.sessionTabs.delete(sid);
          }
        }, HEARTBEAT_TIMEOUT);
        ws.once('pong', () => clearTimeout(pongTimer));
      }
    }, HEARTBEAT_INTERVAL);
  }

  /** Keep the extension WebSocket and MV3 service worker awake while clients are active */
  private _startExtensionKeepalive(): void {
    if (this.extensionKeepaliveTimer) return;
    this.extensionKeepaliveTimer = setInterval(() => {
      const ws = this.extensionSocket;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        this.extensionReady = false;
        return;
      }
      try {
        ws.ping();
        ws.send(JSON.stringify({
          id: `sys-ping-${Date.now()}-${++this._counter}`,
          type: 'ping',
          sessionId: this.sessionId,
        }));
      } catch {
        this.extensionReady = false;
        try { ws.close(); } catch {}
      }
    }, EXTENSION_KEEPALIVE_INTERVAL);
  }

  private _broadcastExtensionState(connected: boolean): void {
    for (const [sid, ws] of this.mcpClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'extension_state',
          sessionId: sid,
          extensionConnected: this.isConnected(),
          extensionAvailable: connected,
          backend: this.getBackend(),
        }));
      }
    }
  }

  private _isNativeEnabled(): boolean {
    return BROWSER_MODE !== 'extension';
  }

  private _isExtensionModeEnabled(): boolean {
    return BROWSER_MODE === 'extension' || BROWSER_MODE === 'auto';
  }

  private _shouldUseExtension(): boolean {
    return this._isExtensionModeEnabled() && this.isExtensionReady();
  }

  private _shouldUseNative(): boolean {
    return this._isNativeEnabled() && !this._shouldUseExtension();
  }

  private _routeClientCommand(sessionId: string, msg: any): void {
    if (this._shouldUseExtension()) {
      this._forwardToExtension(sessionId, msg);
      return;
    }
    if (this._shouldUseNative()) {
      this._handleNativeRequest(sessionId, msg);
      return;
    }

    const clientWs = this.mcpClients.get(sessionId);
    if (clientWs?.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ id: msg.id, error: 'No Pilot browser backend connected' }));
    }
  }

  /** Forward command from MCP client to extension */
  private _forwardToExtension(sessionId: string, msg: any): void {
    if (!this.extensionSocket?.readyState || this.extensionSocket.readyState !== WebSocket.OPEN) {
      // Send error back to client
      const clientWs = this.mcpClients.get(sessionId);
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ id: msg.id, error: 'Extension not connected' }));
      }
      return;
    }

    if (msg.type === 'screenshot') {
      this.screenshotForwardQueue = this.screenshotForwardQueue
        .then(() => this._forwardScreenshotToExtension(sessionId, msg))
        .catch(() => {});
      return;
    }

    this._sendToExtension(sessionId, msg);
  }

  private async _forwardScreenshotToExtension(sessionId: string, msg: any): Promise<void> {
    const elapsed = Date.now() - this.lastScreenshotForwardAt;
    if (elapsed < SCREENSHOT_MIN_INTERVAL) {
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_MIN_INTERVAL - elapsed));
    }
    if (!this.extensionSocket?.readyState || this.extensionSocket.readyState !== WebSocket.OPEN) {
      const clientWs = this.mcpClients.get(sessionId);
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ id: msg.id, error: 'Extension not connected' }));
      }
      return;
    }
    this._sendToExtension(sessionId, msg);
    this.lastScreenshotForwardAt = Date.now();
  }

  private _sendToExtension(sessionId: string, msg: any): void {
    const extensionSocket = this.extensionSocket;
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      const clientWs = this.mcpClients.get(sessionId);
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ id: msg.id, error: 'Extension not connected' }));
      }
      return;
    }
    const tabId = this.sessionTabs.get(sessionId);
    extensionSocket.send(JSON.stringify({
      ...msg, sessionId, tabId,
    }));
  }

  // ─── Native Playwright Backend ────────────────────────────

  private async _handleNativeRequest(sessionId: string, msg: any): Promise<void> {
    const clientWs = this.mcpClients.get(sessionId);
    try {
      const result = await this._handleNativeCommand(sessionId, msg.type, msg.payload ?? {}, msg.tabId);
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ id: msg.id, sessionId, result }));
      }
    } catch (err) {
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          id: msg.id,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }

  private async _handleNativeCommand(
    sessionId: string,
    type: string,
    payload: Record<string, any> = {},
    tabId?: number,
  ): Promise<unknown> {
    switch (type) {
      case 'session_init':
        return await this._initNativeSession(sessionId);
      case 'session_close':
        await this._closeNativeSession(sessionId);
        return {};
      case 'tabs':
        return await this._nativeTabs(sessionId);
      case 'new_tab':
        return await this._nativeNewTab(sessionId, payload.url);
      case 'close_tab':
        return await this._nativeCloseTab(sessionId, payload.tabId ?? tabId);
      case 'switch_tab':
        return await this._nativeSwitchTab(sessionId, payload.tabId);
      case 'navigate':
        return await this._nativeNavigate(sessionId, payload.url, tabId);
      case 'back':
        return await this._nativeBack(sessionId, tabId);
      case 'forward':
        return await this._nativeForward(sessionId, tabId);
      case 'reload':
        return await this._nativeReload(sessionId, tabId);
      case 'get_url':
        return { url: (await this._nativePage(sessionId, tabId)).url() };
      case 'screenshot':
        return await this._nativeScreenshot(sessionId, payload, tabId);
      case 'snapshot':
        return await this._nativeSnapshot(sessionId, payload, tabId);
      case 'click':
        return await this._nativeClick(sessionId, payload, tabId);
      case 'fill':
        return await this._nativeFill(sessionId, payload, tabId);
      case 'type':
        await (await this._nativePage(sessionId, tabId)).keyboard.type(String(payload.text ?? ''));
        return {};
      case 'press':
        await (await this._nativePage(sessionId, tabId)).keyboard.press(String(payload.key));
        return {};
      case 'hover':
        await (await this._nativeResolve(sessionId, payload.ref, tabId)).hover({ timeout: 5000 });
        return {};
      case 'scroll':
        return await this._nativeScroll(sessionId, payload, tabId);
      case 'wait':
        return await this._nativeWait(sessionId, payload, tabId);
      case 'find':
        return await this._nativeFind(sessionId, payload, tabId);
      case 'select_option':
        return await this._nativeSelectOption(sessionId, payload, tabId);
      case 'page_text':
        return { text: await (await this._nativePage(sessionId, tabId)).locator('body').innerText({ timeout: 5000 }) };
      case 'page_html':
        return { html: await (await this._nativePage(sessionId, tabId)).content() };
      case 'page_links':
        return await this._nativePageLinks(sessionId, tabId);
      case 'page_forms':
        return await this._nativePageForms(sessionId, tabId);
      case 'element_state':
        return await this._nativeElementState(sessionId, payload, tabId);
      case 'evaluate':
        return { value: await (await this._nativePage(sessionId, tabId)).evaluate(String(payload.expression ?? payload.script ?? 'undefined')) };
      case 'ping':
        return { pong: true, backend: 'native' };
      default:
        throw new Error(`Unknown native command: ${type}`);
    }
  }

  private async _ensureNativeBrowser(): Promise<Browser> {
    if (this.nativeBrowser?.isConnected()) return this.nativeBrowser;

    const childPidsBefore = this._childPids();
    const isLinux = process.platform === 'linux';
    const launchArgs = isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [];
    const headed = process.env.PILOT_HEADLESS !== '1';
    this.nativeBrowser = await chromium.launch({
      headless: !headed,
      ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
      ...(isLinux && process.env.PILOT_CHROMIUM_PATH ? { executablePath: process.env.PILOT_CHROMIUM_PATH } : {}),
    });
    const childPidsAfter = this._childPids();
    for (const pid of childPidsAfter) {
      if (!childPidsBefore.has(pid) && this._isNativeBrowserPid(pid)) {
        this.nativeBrowserPids.add(pid);
      }
    }
    this.nativeBrowser.on('disconnected', () => {
      this.nativeBrowser = null;
      this.nativeSessions.clear();
      this.sessionTabs.clear();
      this._checkState();
    });
    return this.nativeBrowser;
  }

  private _childPids(): Set<number> {
    if (process.platform === 'win32') return new Set();
    try {
      const out = execSync(`pgrep -P ${process.pid}`, { encoding: 'utf8' }).trim();
      if (!out) return new Set();
      return new Set(out.split(/\s+/).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid)));
    } catch {
      return new Set();
    }
  }

  private _isNativeBrowserPid(pid: number): boolean {
    if (process.platform === 'win32') return false;
    try {
      const command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' });
      return /chrome-headless-shell|chromium|chrome/i.test(command);
    } catch {
      return false;
    }
  }

  private _killNativeBrowserChildren(): void {
    const pids = new Set<number>();
    for (const pid of this.nativeBrowserPids) {
      pids.add(pid);
      for (const child of this._descendantPids(pid)) pids.add(child);
    }
    const ordered = [...pids].sort((a, b) => b - a);
    for (const pid of ordered) try { process.kill(pid, 'SIGTERM'); } catch {}
    for (const pid of ordered) try { process.kill(pid, 'SIGKILL'); } catch {}
    this.nativeBrowserPids.clear();
  }

  private _descendantPids(rootPid: number): Set<number> {
    const found = new Set<number>();
    const visit = (pid: number) => {
      if (process.platform === 'win32') return;
      let out = '';
      try { out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim(); } catch { return; }
      if (!out) return;
      for (const raw of out.split(/\s+/)) {
        const childPid = Number(raw);
        if (!Number.isFinite(childPid) || found.has(childPid)) continue;
        found.add(childPid);
        visit(childPid);
      }
    };
    visit(rootPid);
    return found;
  }

  private async _initNativeSession(sessionId: string): Promise<{ tabId: number }> {
    const existing = this.nativeSessions.get(sessionId);
    if (existing) {
      return { tabId: existing.activeTabId };
    }

    const browser = await this._ensureNativeBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const tabId = this.nativeGlobalTabId++;
    const session: NativeSession = {
      context,
      pages: new Map([[tabId, page]]),
      activeTabId: tabId,
      nextTabId: this.nativeGlobalTabId,
      refMap: new Map(),
    };
    this.nativeSessions.set(sessionId, session);
    this.sessionTabs.set(sessionId, tabId);
    console.error(`[pilot] Native session ${sessionId.slice(0, 8)} → tab ${tabId}`);

    const clientWs = this.mcpClients.get(sessionId);
    if (clientWs?.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'session_assigned', sessionId, tabId, backend: 'native' }));
    }
    this._checkState();
    return { tabId };
  }

  private async _closeNativeSession(sessionId: string): Promise<void> {
    const session = this.nativeSessions.get(sessionId);
    if (!session) return;
    this.nativeSessions.delete(sessionId);
    this.sessionTabs.delete(sessionId);
    await this._closeNativeSessionPages(session);
  }

  private async _closeNativeSessionPages(session: NativeSession): Promise<void> {
    await Promise.all([...session.pages.values()].map((page) =>
      Promise.race([
        page.close(),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]).catch(() => {}),
    ));
    session.pages.clear();
    await Promise.race([
      session.context.close(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {});
  }

  private async _nativeSession(sessionId: string): Promise<NativeSession> {
    await this._initNativeSession(sessionId);
    const session = this.nativeSessions.get(sessionId);
    if (!session) throw new Error(`Native session not available: ${sessionId}`);
    return session;
  }

  private _nativePageFromSession(session: NativeSession, tabId?: number): Page {
    const id = tabId ?? session.activeTabId;
    const page = session.pages.get(id);
    if (!page) throw new Error(`Native tab ${id} not found`);
    return page;
  }

  private async _nativePage(sessionId: string, tabId?: number): Promise<Page> {
    return this._nativePageFromSession(await this._nativeSession(sessionId), tabId);
  }

  private async _nativeTabs(sessionId: string): Promise<Array<{ tabId: number; url: string; title: string; active: boolean }>> {
    const session = await this._nativeSession(sessionId);
    const tabs: Array<{ tabId: number; url: string; title: string; active: boolean }> = [];
    for (const [tabId, page] of session.pages) {
      tabs.push({
        tabId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: tabId === session.activeTabId,
      });
    }
    return tabs;
  }

  private async _nativeNewTab(sessionId: string, url?: string): Promise<{ tabId: number }> {
    if (url) await validateNavigationUrl(url);
    const session = await this._nativeSession(sessionId);
    const page = await session.context.newPage();
    const tabId = this.nativeGlobalTabId++;
    session.pages.set(tabId, page);
    session.activeTabId = tabId;
    session.nextTabId = this.nativeGlobalTabId;
    this.sessionTabs.set(sessionId, tabId);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { tabId };
  }

  private async _nativeCloseTab(sessionId: string, tabId?: number): Promise<Record<string, never>> {
    const session = await this._nativeSession(sessionId);
    const id = tabId ?? session.activeTabId;
    const page = session.pages.get(id);
    if (!page) throw new Error(`Native tab ${id} not found`);
    await page.close().catch(() => {});
    session.pages.delete(id);
    if (session.pages.size === 0) {
      const created = await this._nativeNewTab(sessionId);
      session.activeTabId = created.tabId;
    } else if (session.activeTabId === id) {
      session.activeTabId = [...session.pages.keys()][session.pages.size - 1];
    }
    this.sessionTabs.set(sessionId, session.activeTabId);
    return {};
  }

  private async _nativeSwitchTab(sessionId: string, tabId: number): Promise<Record<string, never>> {
    const session = await this._nativeSession(sessionId);
    if (!session.pages.has(tabId)) throw new Error(`Native tab ${tabId} not found`);
    session.activeTabId = tabId;
    this.sessionTabs.set(sessionId, tabId);
    return {};
  }

  private async _nativeNavigate(sessionId: string, url: string, tabId?: number): Promise<{ url: string }> {
    await validateNavigationUrl(url);
    const page = await this._nativePage(sessionId, tabId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { url: page.url() };
  }

  private async _nativeBack(sessionId: string, tabId?: number): Promise<{ url: string }> {
    const page = await this._nativePage(sessionId, tabId);
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    return { url: page.url() };
  }

  private async _nativeForward(sessionId: string, tabId?: number): Promise<{ url: string }> {
    const page = await this._nativePage(sessionId, tabId);
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    return { url: page.url() };
  }

  private async _nativeReload(sessionId: string, tabId?: number): Promise<{ url: string }> {
    const page = await this._nativePage(sessionId, tabId);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    return { url: page.url() };
  }

  private async _nativeScreenshot(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<{ data: string; mimeType: string }> {
    const page = await this._nativePage(sessionId, tabId);
    const buffer = await page.screenshot({
      fullPage: payload.full_page !== false,
      ...(payload.clip ? { clip: payload.clip } : {}),
    });
    return { data: buffer.toString('base64'), mimeType: 'image/png' };
  }

  private async _nativeSnapshot(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<{ text: string; url: string; title: string; count: number }> {
    const session = await this._nativeSession(sessionId);
    const page = this._nativePageFromSession(session, tabId);
    const locator = payload.selector ? page.locator(String(payload.selector)) : page.locator('body');
    const ariaText = await locator.ariaSnapshot({ timeout: 10000 }).catch(() => '');
    const lines = ariaText.split('\n');
    const output: string[] = [];
    const refMap = new Map<string, NativeRef>();
    const roleNameSeen = new Map<string, number>();
    const roleNameCounts = new Map<string, number>();
    const maxElements = Number(payload.maxElements ?? payload.max_elements ?? 200);
    const interactiveOnly = Boolean(payload.interactive_only);
    const structureOnly = Boolean(payload.structure_only);
    const maxDepth = typeof payload.maxDepth === 'number' ? payload.maxDepth : payload.depth;

    for (const line of lines) {
      const node = this._parseAriaLine(line);
      if (!node) continue;
      const key = `${node.role}:${node.name || ''}`;
      roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
    }

    let refCounter = 1;
    for (const line of lines) {
      const node = this._parseAriaLine(line);
      if (!node) continue;
      const depth = Math.floor(node.indent / 2);
      if (typeof maxDepth === 'number' && depth > maxDepth) continue;
      if (interactiveOnly && !INTERACTIVE_ROLES.has(node.role)) continue;
      if (refCounter > maxElements) continue;

      const ref = `e${refCounter++}`;
      const key = `${node.role}:${node.name || ''}`;
      const seenIndex = roleNameSeen.get(key) || 0;
      roleNameSeen.set(key, seenIndex + 1);

      let refLocator = page.getByRole(node.role as any, { name: node.name || undefined });
      if ((roleNameCounts.get(key) || 1) > 1) refLocator = refLocator.nth(seenIndex);
      refMap.set(ref, { locator: refLocator, role: node.role, name: node.name || '' });

      const indent = ' '.repeat(depth);
      let outputLine = `${indent}@${ref} [${node.role}]`;
      if (node.name && !structureOnly) outputLine += ` "${node.name}"`;
      if (node.props) outputLine += ` ${node.props}`;
      if (node.children && !structureOnly) outputLine += `: ${node.children}`;
      output.push(outputLine);
    }

    session.refMap = refMap;
    const text = output.length > 0 ? output.join('\n') : '(no accessible elements found)';
    return { text, url: page.url(), title: await page.title().catch(() => ''), count: refMap.size };
  }

  private _parseAriaLine(line: string): { indent: number; role: string; name: string | null; props: string; children: string } | null {
    const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
    if (!match) return null;
    return {
      indent: match[1].length,
      role: match[2],
      name: match[3] ?? null,
      props: match[4] || '',
      children: match[5]?.trim() || '',
    };
  }

  private async _nativeResolve(sessionId: string, refOrSelector: string, tabId?: number): Promise<Locator> {
    const session = await this._nativeSession(sessionId);
    const page = this._nativePageFromSession(session, tabId);
    if (refOrSelector?.startsWith('@')) {
      const ref = refOrSelector.slice(1);
      const found = session.refMap.get(ref);
      if (!found) throw new Error(`Ref ${refOrSelector} not found. Run pilot_snapshot first.`);
      return found.locator;
    }
    return page.locator(refOrSelector);
  }

  private async _nativeClick(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<Record<string, never>> {
    const locator = await this._nativeResolve(sessionId, String(payload.ref), tabId);
    try {
      await locator.click({
        timeout: 5000,
        ...(payload.button ? { button: payload.button } : {}),
        ...(payload.double_click ? { clickCount: 2 } : {}),
      });
    } catch (err) {
      throw new Error(formatNativeActionErrorMessage('click', payload.ref, err));
    }
    await (await this._nativePage(sessionId, tabId)).waitForLoadState('domcontentloaded').catch(() => {});
    return {};
  }

  private async _nativeFill(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<Record<string, never>> {
    const locator = await this._nativeResolve(sessionId, String(payload.ref), tabId);
    try {
      await locator.fill(String(payload.value ?? ''), { timeout: 5000 });
    } catch (err) {
      throw new Error(formatNativeActionErrorMessage('fill', payload.ref, err));
    }
    return {};
  }

  private async _nativeScroll(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<Record<string, never>> {
    const page = await this._nativePage(sessionId, tabId);
    if (payload.ref) {
      await (await this._nativeResolve(sessionId, String(payload.ref), tabId)).scrollIntoViewIfNeeded({ timeout: 5000 });
      return {};
    }
    await page.evaluate(({ x, y }) => window.scrollBy(x, y), {
      x: Number(payload.deltaX ?? 0),
      y: Number(payload.deltaY ?? 0),
    });
    return {};
  }

  private async _nativeWait(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<Record<string, never>> {
    const page = await this._nativePage(sessionId, tabId);
    const timeout = Number(payload.timeout ?? 15000);
    const selector = String(payload.selector ?? '');
    const refMatch = selector.match(/^\[data-pilot-ref="(.+)"\]$/);
    if (refMatch) {
      await (await this._nativeResolve(sessionId, `@${refMatch[1]}`, tabId)).waitFor({ state: 'visible', timeout });
    } else if (selector) {
      await page.locator(selector).waitFor({ state: 'visible', timeout });
    } else {
      await page.waitForLoadState('domcontentloaded', { timeout });
    }
    return {};
  }

  private async _nativeFind(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<{ ref: string; tag: string; text: string }> {
    const session = await this._nativeSession(sessionId);
    const page = this._nativePageFromSession(session, tabId);
    const text = payload.text ? String(payload.text) : undefined;
    const label = payload.label ? String(payload.label) : undefined;
    const role = payload.role ? String(payload.role) : undefined;
    const placeholder = payload.placeholder ? String(payload.placeholder) : undefined;

    let locator: Locator;
    if (role && text) locator = page.getByRole(role as any, { name: text });
    else if (role) locator = page.getByRole(role as any);
    else if (label) locator = page.getByLabel(label);
    else if (placeholder) locator = page.getByPlaceholder(placeholder);
    else if (text) locator = page.getByText(text);
    else throw new Error('Provide text, label, role, or placeholder');

    const count = await locator.count();
    if (count === 0) throw new Error('Element not found');
    const first = locator.first();
    const ref = `e${session.refMap.size + 1}`;
    const value = text || label || placeholder || role || '';
    session.refMap.set(ref, { locator: first, role: role || 'generic', name: value });
    const tag = await first.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'element');
    const visibleText = await first.innerText({ timeout: 1000 }).catch(() => value);
    return { ref: `@${ref}`, tag, text: visibleText };
  }

  private async _nativeSelectOption(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<{ selected: string; value: string }> {
    const locator = await this._nativeResolve(sessionId, String(payload.ref), tabId);
    const value = String(payload.value ?? payload.label ?? '');
    try {
      await locator.selectOption(value, { timeout: 5000 });
    } catch (err) {
      throw new Error(formatNativeActionErrorMessage('select_option', payload.ref, err));
    }
    return { selected: value, value };
  }

  private async _nativePageLinks(sessionId: string, tabId?: number): Promise<{ links: Array<{ text: string; href: string }> }> {
    const page = await this._nativePage(sessionId, tabId);
    const links = await page.locator('a[href]').evaluateAll((anchors) =>
      anchors.slice(0, 200).map((anchor) => ({
        text: (anchor.textContent || '').trim(),
        href: (anchor as HTMLAnchorElement).href,
      })),
    );
    return { links };
  }

  private async _nativePageForms(sessionId: string, tabId?: number): Promise<{ forms: any[]; count: number }> {
    const page = await this._nativePage(sessionId, tabId);
    const forms = await page.locator('form').evaluateAll((items) =>
      items.map((form, index) => ({
        index,
        action: (form as HTMLFormElement).action,
        method: (form as HTMLFormElement).method,
        text: (form.textContent || '').trim().slice(0, 500),
      })),
    );
    return { forms, count: forms.length };
  }

  private async _nativeElementState(sessionId: string, payload: Record<string, any>, tabId?: number): Promise<{ visible: boolean; enabled: boolean; checked: boolean | null; focused: boolean }> {
    const locator = await this._nativeResolve(sessionId, String(payload.ref), tabId);
    const [visible, enabled, checked, focused] = await Promise.all([
      locator.isVisible().catch(() => false),
      locator.isEnabled().catch(() => false),
      locator.isChecked().catch(() => null),
      locator.evaluate((el) => document.activeElement === el).catch(() => false),
    ]);
    return { visible, enabled, checked, focused };
  }

  /** Route extension response to the right MCP client or resolve local pending */
  private _handleExtensionResponse(msg: any): void {
    const sessionId = msg.sessionId;

    // If it's for this broker's own session
    if (sessionId === this.sessionId || !sessionId) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
      return;
    }

    // Route to the right MCP client
    const clientWs = this.mcpClients.get(sessionId);
    if (clientWs?.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(msg));
    }
  }

  // ─── Client Mode ─────────────────────────────────────────

  private _connectAsClient(): void {
    if (this.stopped) return;
    if (this.brokerSocket?.readyState === WebSocket.OPEN) return;
    this.mode = 'client';

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    ws.on('open', () => {
      if (this.stopped) {
        ws.close();
        return;
      }
      this.brokerSocket = ws;
      this.extensionReady = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // Identify ourselves with token from broker
      let token: string | undefined;
      try { token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch {}
      const helloId = `hello-${this.sessionId.slice(0, 8)}-${Date.now()}`;
      ws.send(JSON.stringify({ id: helloId, type: 'hello', role: 'mcp', sessionId: this.sessionId, token }));
      console.error(`[pilot] Client mode — connected to broker (session ${this.sessionId.slice(0, 8)})`);
    });

    ws.on('message', (data) => {
      if (this.stopped) return;
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'hello_ack' || msg.type === 'extension_state') {
        this.extensionReady = Boolean(msg.extensionConnected);
        if (typeof msg.assignedTabId === 'number') {
          this.clientAssignedTabId = msg.assignedTabId;
        }
        this._checkState();
        return;
      }
      if (msg.type === 'session_assigned' && typeof msg.tabId === 'number') {
        this.clientAssignedTabId = msg.tabId;
        this._checkState();
        return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    });

    ws.on('close', () => {
      if (this.stopped) return;
      this.brokerSocket = null;
      this.extensionReady = false;
      this.clientAssignedTabId = undefined;
      this._rejectPending('Pilot broker connection closed');
      this._checkState();
      this.reconnectTimer = setTimeout(() => this._connectAsClient(), RECONNECT_DELAY);
    });

    ws.on('error', () => {
      if (this.stopped) return;
      this.brokerSocket = null;
      this.extensionReady = false;
      this.clientAssignedTabId = undefined;
      this._rejectPending('Pilot broker connection errored');
      // Broker might have died — try to become broker
      this.mode = null;
      setTimeout(() => this._tryBroker(), RECONNECT_DELAY);
    });
  }

  // ─── State Change Tracking ────────────────────────────────
  private _wasConnected = false;
  private _onStateChange: ((connected: boolean) => void) | null = null;

  onStateChange(cb: (connected: boolean) => void): void {
    this._onStateChange = cb;
  }

  private _checkState(): void {
    const now = this.isConnected();
    if (now !== this._wasConnected) {
      this._wasConnected = now;
      if (now) {
        console.error(`[pilot] Browser backend ready ✓ (${this.getBackend()})`);
      } else {
        console.error('[pilot] Browser backend disconnected');
      }
      this._onStateChange?.(now);
    }
  }

  private _rejectPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private _brokerInfo(): BrokerInfo {
    return {
      pid: process.pid,
      port: PORT,
      sessionId: this.sessionId,
      backend: this.getBackend(),
      startedAt: new Date().toISOString(),
    };
  }

  private _brokerOwnerSummary(): string {
    const info = this.getBrokerInfo();
    if (!info) return '';
    const alive = this._pidAlive(info.pid) ? 'alive' : 'dead';
    return ` (owner pid=${info.pid} ${alive}, session=${info.sessionId.slice(0, 8)}, backend=${info.backend})`;
  }

  private _pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Public API (used by tools) ──────────────────────────

  isConnected(): boolean {
    if (this.mode === 'broker') {
      return this._isNativeEnabled() || this.isExtensionReady();
    }
    if (this.mode === 'client') {
      return this.brokerSocket !== null && this.brokerSocket.readyState === WebSocket.OPEN && this.extensionReady;
    }
    return false;
  }

  isExtensionReady(): boolean {
    return this.extensionSocket !== null && this.extensionSocket.readyState === WebSocket.OPEN;
  }

  async send<T = unknown>(type: string, payload?: Record<string, unknown>, overrideTabId?: number): Promise<T> {
    if (!this.isConnected()) {
      throw new Error('Pilot browser backend not connected');
    }
    const id = `${this.sessionId.slice(0, 8)}-${Date.now()}-${++this._counter}`;

    if (this.mode === 'broker' && this._shouldUseNative()) {
      return await this._handleNativeCommand(this.sessionId, type, payload ?? {}, overrideTabId) as T;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pilot browser command "${type}" timed out after ${COMMAND_TIMEOUT}ms`));
      }, COMMAND_TIMEOUT);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const cmd = { id, type, payload, sessionId: this.sessionId };

      try {
        if (this.mode === 'broker') {
          const tabId = overrideTabId ?? this.sessionTabs.get(this.sessionId);
          if (this._shouldUseExtension()) {
            this.extensionSocket!.send(JSON.stringify({ ...cmd, tabId }));
          } else {
            throw new Error('No Pilot browser backend connected');
          }
        } else {
          this.brokerSocket!.send(JSON.stringify(cmd));
        }
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.extensionKeepaliveTimer) {
      clearInterval(this.extensionKeepaliveTimer);
      this.extensionKeepaliveTimer = null;
    }
    await Promise.all([...this.nativeSessions.values()].map((session) => this._closeNativeSessionPages(session)));
    this.nativeSessions.clear();
    const nativeBrowser = this.nativeBrowser;
    this.nativeBrowser = null;
    if (nativeBrowser) {
      await Promise.race([
        nativeBrowser.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]).catch(() => {});
    }
    this._killNativeBrowserChildren();
    if (this.mode === 'broker') {
      // Close all MCP client connections
      for (const ws of this.mcpClients.values()) {
        ws.close();
        ws.terminate();
      }
      this.mcpClients.clear();
      // Close extension
      this.extensionSocket?.close();
      this.extensionSocket = null;
      const wss = this.wss;
      this.wss = null;
      if (wss) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          wss.close(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      // Clean up token file
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      try {
        const info = this.getBrokerInfo();
        if (!info || info.pid === process.pid) fs.unlinkSync(BROKER_INFO_FILE);
      } catch {}
    } else if (this.mode === 'client') {
      this.brokerSocket?.close();
      this.brokerSocket?.terminate();
      this.brokerSocket = null;
      this.clientAssignedTabId = undefined;
    }
    // Reject all pending
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server stopped'));
    }
    this.pending.clear();
    this.extensionReady = false;
    this.mode = null;
  }

  getMode(): string { return this.mode ?? 'none'; }
  getBackend(): string {
    if (this._shouldUseExtension()) return 'extension';
    if (this._isNativeEnabled()) return 'native';
    return 'none';
  }
  getSessionId(): string { return this.sessionId; }
  getSessionTab(): number | undefined {
    return this.mode === 'client'
      ? this.clientAssignedTabId
      : this.sessionTabs.get(this.sessionId);
  }
  getClientCount(): number { return this.mcpClients.size; }
  getBrokerInfo(): BrokerInfo | null {
    try {
      return JSON.parse(fs.readFileSync(BROKER_INFO_FILE, 'utf8')) as BrokerInfo;
    } catch {
      return null;
    }
  }
}

// Singleton
export const extensionServer = new ExtensionServer();
