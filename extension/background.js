/**
 * Pilot MCP — Background Service Worker (Multiplexer)
 *
 * Connects to the Pilot MCP broker on localhost:3131.
 * Multiple Claude Code sessions share this extension —
 * each session gets its own Chrome tab.
 *
 * Protocol:
 *   Broker → Extension: { id, type, payload, sessionId, tabId }
 *   Extension → Broker: { id, result|error, sessionId }
 */

const WS_URL = 'ws://127.0.0.1:3131';
const RECONNECT_DELAY = 3000;

let ws = null;
let reconnectTimer = null;

// sessionId → tabId mapping (managed by session_init/session_close)
const sessionTabs = new Map();
// sessionId → groupId
const sessionGroups = new Map();

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
let colorIndex = 0;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[pilot] Connected to broker');
    clearTimeout(reconnectTimer);
    updateBadge(true);
    // Identify as extension
    ws.send(JSON.stringify({ type: 'hello', role: 'extension' }));
  };

  ws.onclose = () => {
    console.log('[pilot] Disconnected from broker, reconnecting...');
    ws = null;
    updateBadge(false);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = () => {};

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    const { id, type, payload = {}, sessionId, tabId } = msg;
    let result, error;

    try {
      result = await handleCommand(type, payload, sessionId, tabId);
    } catch (err) {
      error = err.message || String(err);
    }

    const response = { id, sessionId };
    if (error !== undefined) response.error = error;
    else response.result = result;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  };
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#22c55e' : '#ef4444' });
}

// ─── Command Router ────────────────────────────────────────

async function handleCommand(type, payload, sessionId, tabId) {
  switch (type) {
    // ── Session Management ──
    case 'session_init':
      return await initSession(sessionId);
    case 'session_close':
      return await closeSession(sessionId, tabId);

    // ── Tab Management ──
    case 'tabs':
      return await getTabs();
    case 'new_tab':
      return await newTab(payload.url, sessionId);
    case 'close_tab':
      return await closeTab(payload.tabId);
    case 'switch_tab':
      return await switchTab(payload.tabId, sessionId);

    // ── Navigation (uses session's tab) ──
    case 'navigate':
      return await navigate(payload.url, tabId);
    case 'back':
      return await goBack(tabId);
    case 'forward':
      return await goForward(tabId);
    case 'reload':
      return await doReload(tabId);
    case 'get_url':
      return await getUrl(tabId);

    // ── Screenshot ──
    case 'screenshot':
      return await screenshot(tabId);

    // ── Content Script Commands ──
    case 'snapshot':
    case 'click':
    case 'fill':
    case 'type':
    case 'press':
    case 'scroll':
    case 'hover':
    case 'select_option':
    case 'wait':
    case 'find':
    case 'page_links':
    case 'page_forms':
    case 'element_state':
    case 'evaluate':
    case 'page_text':
    case 'page_html':
      return await relayToContent(type, payload, tabId);

    case 'ping':
      return { pong: true };

    default:
      throw new Error(`Unknown command: ${type}`);
  }
}

// ─── Session Management ────────────────────────────────────

async function initSession(sessionId) {
  // Check if we already have a tab for this session
  if (sessionTabs.has(sessionId)) {
    const existing = sessionTabs.get(sessionId);
    try {
      await chrome.tabs.get(existing);
      return { tabId: existing };
    } catch {
      // Tab was closed, create a new one
    }
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  sessionTabs.set(sessionId, tab.id);

  // Create a tab group for this session (optional — not supported in all browsers)
  if (chrome.tabGroups) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      const color = GROUP_COLORS[colorIndex++ % GROUP_COLORS.length];
      await chrome.tabGroups.update(groupId, {
        title: `✈️ ${sessionId.slice(0, 6)}`,
        color,
        collapsed: false,
      });
      sessionGroups.set(sessionId, groupId);
      console.log(`[pilot] Session ${sessionId.slice(0, 8)} → tab ${tab.id} (group ${color})`);
    } catch (err) {
      console.warn('[pilot] Could not create tab group:', err);
    }
  }

  return { tabId: tab.id };
}

async function closeSession(sessionId, tabId) {
  const id = tabId || sessionTabs.get(sessionId);
  if (id) {
    try { await chrome.tabs.remove(id); } catch {}
  }
  // Remove group (Chrome auto-removes empty groups)
  sessionGroups.delete(sessionId);
  sessionTabs.delete(sessionId);
  return {};
}

// ─── Tab Helpers ───────────────────────────────────────────

function resolveTab(tabId) {
  if (tabId) return tabId;
  throw new Error('No tab assigned to this session — call session_init first');
}

async function getTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(t => ({
    tabId: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
  }));
}

async function newTab(url, sessionId) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
  await waitForTabLoad(tab.id);
  // Add to session's group and update active tab
  if (sessionId) {
    sessionTabs.set(sessionId, tab.id);
    const groupId = sessionGroups.get(sessionId);
    if (groupId) {
      try { await chrome.tabs.group({ tabIds: [tab.id], groupId }); } catch {}
    }
  }
  return { tabId: tab.id };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  // Remove from session mapping
  for (const [sid, tid] of sessionTabs) {
    if (tid === tabId) sessionTabs.delete(sid);
  }
  return {};
}

async function switchTab(tabId, sessionId) {
  await chrome.tabs.update(tabId, { active: true });
  if (sessionId) sessionTabs.set(sessionId, tabId);
  return {};
}

// ─── Navigation ────────────────────────────────────────────

async function navigate(url, tabId) {
  const id = resolveTab(tabId);
  await chrome.tabs.update(id, { url });
  await waitForTabLoad(id);
  const updated = await chrome.tabs.get(id);
  return { url: updated.url };
}

async function goBack(tabId) {
  const id = resolveTab(tabId);
  await chrome.tabs.goBack(id);
  await waitForTabLoad(id);
  const updated = await chrome.tabs.get(id);
  return { url: updated.url };
}

async function goForward(tabId) {
  const id = resolveTab(tabId);
  await chrome.tabs.goForward(id);
  await waitForTabLoad(id);
  const updated = await chrome.tabs.get(id);
  return { url: updated.url };
}

async function doReload(tabId) {
  const id = resolveTab(tabId);
  await chrome.tabs.reload(id);
  await waitForTabLoad(id);
  const updated = await chrome.tabs.get(id);
  return { url: updated.url };
}

async function getUrl(tabId) {
  const id = resolveTab(tabId);
  const tab = await chrome.tabs.get(id);
  return { url: tab.url };
}

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.webNavigation.onCompleted.removeListener(listener);
      resolve();
    }, timeout);

    function listener(details) {
      if (details.tabId === tabId && details.frameId === 0) {
        clearTimeout(timer);
        chrome.webNavigation.onCompleted.removeListener(listener);
        resolve();
      }
    }
    chrome.webNavigation.onCompleted.addListener(listener);
  });
}

// ─── Screenshot ────────────────────────────────────────────

async function screenshot(tabId) {
  // Focus the tab briefly to capture
  const id = resolveTab(tabId);
  await chrome.tabs.update(id, { active: true });
  await new Promise(r => setTimeout(r, 100));
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { data: base64, mimeType: 'image/png' };
}

// ─── Content Script Relay ──────────────────────────────────

async function relayToContent(type, payload, tabId) {
  const id = resolveTab(tabId);

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: ['content.js'],
    });
  } catch {
    // Already injected or can't inject
  }

  const results = await chrome.tabs.sendMessage(id, { type, payload });
  if (results?.error) throw new Error(results.error);
  return results?.result ?? results;
}

// ─── Internal Messages (from popup) ───────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({
      pong: ws && ws.readyState === WebSocket.OPEN,
      sessions: sessionTabs.size,
    });
  }
  return false;
});

// ─── Startup ───────────────────────────────────────────────

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
