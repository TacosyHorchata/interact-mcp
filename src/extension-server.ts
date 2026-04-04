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
import { execSync } from 'child_process';
import * as crypto from 'crypto';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT = Number(process.env.PILOT_EXTENSION_PORT || 3131);
const COMMAND_TIMEOUT = 30_000;
const RECONNECT_DELAY = 3_000;
const HEARTBEAT_INTERVAL = 15_000; // ping clients every 15s
const HEARTBEAT_TIMEOUT = 10_000;  // dead if no pong within 10s
const TOKEN_DIR = path.join(os.homedir(), '.pilot');
const TOKEN_FILE = path.join(TOKEN_DIR, 'broker-token');

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

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

  // Client state
  private brokerSocket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Startup ──────────────────────────────────────────────

  start(): void {
    if (this.mode) return;
    this._tryBroker();
  }

  private _tryBroker(): void {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

    wss.on('listening', () => {
      this.mode = 'broker';
      this.wss = wss;
      // Generate and persist a broker token for authentication
      this._brokerToken = crypto.randomUUID();
      try {
        fs.mkdirSync(TOKEN_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, this._brokerToken, { mode: 0o600 });
      } catch {}
      this._startHeartbeat();
      console.error(`[pilot] Broker mode — listening on ws://127.0.0.1:${PORT} (session ${this.sessionId.slice(0, 8)})`);
    });

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[pilot] Port ${PORT} taken — connecting as client`);
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
          this._checkState();

          // Prune dead clients before re-initializing tabs
          this._pruneDeadClients();

          // Initialize tabs for all live sessions (including broker's own)
          for (const sid of [this.sessionId, ...this.mcpClients.keys()]) {
            if (!this.sessionTabs.has(sid)) {
              this._initSession(sid);
            }
          }
          return;
        }

        if (role === 'mcp') {
          clientSessionId = msg.sessionId;
          this.mcpClients.set(clientSessionId!, ws);
          console.error(`[pilot] MCP client connected: ${clientSessionId!.slice(0, 8)}`);

          // Create a tab for this session
          if (this.extensionSocket?.readyState === WebSocket.OPEN) {
            this._initSession(clientSessionId!);
          }
          return;
        }
        return;
      }

      if (role === 'extension') {
        // Response from extension — route to the right MCP client (or self)
        this._handleExtensionResponse(msg);
      } else if (role === 'mcp' && clientSessionId) {
        // Command from MCP client — forward to extension with sessionId context
        this._forwardToExtension(clientSessionId, msg);
      }
    });

    ws.on('close', () => {
      if (role === 'extension' && this.extensionSocket === ws) {
        this.extensionSocket = null;
        this.sessionTabs.clear();
        this._checkState();
      } else if (role === 'mcp' && clientSessionId) {
        console.error(`[pilot] MCP client disconnected: ${clientSessionId.slice(0, 8)}`);
        this.mcpClients.delete(clientSessionId);
        // Close the tab for this session
        this._closeSession(clientSessionId);
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
            this.sessionTabs.delete(sid);
          }
        }, HEARTBEAT_TIMEOUT);
        ws.once('pong', () => clearTimeout(pongTimer));
      }
    }, HEARTBEAT_INTERVAL);
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
    const tabId = this.sessionTabs.get(sessionId);
    this.extensionSocket.send(JSON.stringify({
      ...msg, sessionId, tabId,
    }));
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
    if (this.brokerSocket?.readyState === WebSocket.OPEN) return;
    this.mode = 'client';

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    ws.on('open', () => {
      this.brokerSocket = ws;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // Identify ourselves with token from broker
      let token: string | undefined;
      try { token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch {}
      ws.send(JSON.stringify({ type: 'hello', role: 'mcp', sessionId: this.sessionId, token }));
      console.error(`[pilot] Client mode — connected to broker (session ${this.sessionId.slice(0, 8)})`);
    });

    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    });

    ws.on('close', () => {
      this.brokerSocket = null;
      this._checkState();
      this.reconnectTimer = setTimeout(() => this._connectAsClient(), RECONNECT_DELAY);
    });

    ws.on('error', () => {
      this.brokerSocket = null;
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
        console.error('[pilot] Extension reconnected ✓');
      } else {
        console.error('[pilot] Extension disconnected — falling back to headed Chromium');
      }
      this._onStateChange?.(now);
    }
  }

  // ─── Public API (used by tools) ──────────────────────────

  isConnected(): boolean {
    if (this.mode === 'broker') {
      return this.extensionSocket !== null && this.extensionSocket.readyState === WebSocket.OPEN;
    }
    if (this.mode === 'client') {
      return this.brokerSocket !== null && this.brokerSocket.readyState === WebSocket.OPEN;
    }
    return false;
  }

  async send<T = unknown>(type: string, payload?: Record<string, unknown>, overrideTabId?: number): Promise<T> {
    if (!this.isConnected()) {
      throw new Error('Extension not connected');
    }
    const id = `${this.sessionId.slice(0, 8)}-${Date.now()}-${++this._counter}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension command "${type}" timed out after ${COMMAND_TIMEOUT}ms`));
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
          this.extensionSocket!.send(JSON.stringify({ ...cmd, tabId }));
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

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.mode === 'broker') {
      // Close all MCP client connections
      for (const ws of this.mcpClients.values()) ws.close();
      this.mcpClients.clear();
      // Close extension
      this.extensionSocket?.close();
      this.extensionSocket = null;
      this.wss?.close();
      this.wss = null;
      // Clean up token file
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
    } else if (this.mode === 'client') {
      this.brokerSocket?.close();
      this.brokerSocket = null;
    }
    // Reject all pending
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server stopped'));
    }
    this.pending.clear();
    this.mode = null;
  }

  getMode(): string { return this.mode ?? 'none'; }
  getSessionId(): string { return this.sessionId; }
  getSessionTab(): number | undefined { return this.sessionTabs.get(this.sessionId); }
  getClientCount(): number { return this.mcpClients.size; }
}

// Singleton
export const extensionServer = new ExtensionServer();
