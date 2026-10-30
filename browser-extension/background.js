/**
 * ExamProctor Classroom Monitor — Background Service Worker
 *
 * Privacy principles:
 *   - Only captures: domain hostname, page title (truncated to 80 chars), timestamp.
 *   - Does NOT capture: URL path/query/hash, passwords, keystrokes, clipboard,
 *     form data, or private browsing activity.
 *   - Only active during an explicitly authorised classroom session.
 *   - Session token is issued by the Python student agent over localhost:41732.
 *   - Data is sent only to 127.0.0.1:41732 (the local student agent bridge).
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let sessionState = {
  active:     false,   // true only when session is authorised
  sessionId:  null,
  deviceId:   null,
  token:      null,    // short-lived session token issued by agent
  bridgePort: 41732,   // may be overridden by agent registration response
};

const eventBuffer = [];   // hold events when agent is unreachable
const MAX_BUFFER  = 200;

// ── Agent communication ───────────────────────────────────────────────────────

async function postToAgent(path, payload) {
  const url = `http://127.0.0.1:${sessionState.bridgePort}${path}`;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function getFromAgent(path) {
  const url = `http://127.0.0.1:${sessionState.bridgePort}${path}`;
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// ── Session management ────────────────────────────────────────────────────────

async function checkSession() {
  const status = await getFromAgent('/status');
  if (!status || !status.ok) {
    if (sessionState.active) {
      sessionState.active = false;
      updateIcon(false);
    }
    return;
  }

  const wasActive = sessionState.active;
  sessionState.active    = Boolean(status.session_id);
  sessionState.sessionId = status.session_id  || null;
  sessionState.deviceId  = status.device_id   || null;
  sessionState.token     = status.session_token || null;
  if (status.bridge_port) sessionState.bridgePort = status.bridge_port;

  if (sessionState.active !== wasActive) {
    updateIcon(sessionState.active);
  }
}

function updateIcon(active) {
  chrome.action.setBadgeText({ text: active ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: active ? '#6366f1' : '#6b7280' });
}

// ── Tab event handling ────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isPrivate(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return u.startsWith('chrome://') ||
         u.startsWith('chrome-extension://') ||
         u.startsWith('edge://') ||
         u.startsWith('about:') ||
         u.startsWith('data:') ||
         u.startsWith('file://');
}

function enqueue(event) {
  if (eventBuffer.length >= MAX_BUFFER) eventBuffer.shift();
  eventBuffer.push(event);
}

async function flushBuffer() {
  if (!sessionState.active || eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0, 50);
  const result = await postToAgent('/browser-events', {
    session_id: sessionState.sessionId,
    device_id:  sessionState.deviceId,
    events:     batch,
  });
  if (!result) {
    // Push back on failure — next flush will retry
    eventBuffer.unshift(...batch);
  }
}

function recordNavigation(tabId, url, title) {
  if (!sessionState.active) return;
  if (isPrivate(url))        return;
  const domain = extractDomain(url);
  if (!domain)               return;

  const event = {
    event_type:       'navigation',
    domain,
    title:            (title || '').slice(0, 80),   // 80-char max, no path info
    client_timestamp: new Date().toISOString(),
    idempotency_key:  `${tabId}-${Date.now()}`,
  };
  enqueue(event);
}

// ── Listeners ─────────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    recordNavigation(tabId, tab.url, tab.title);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!sessionState.active) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) recordNavigation(tabId, tab.url, tab.title);
  } catch { /* tab may have closed */ }
});

// ── Periodic tasks ────────────────────────────────────────────────────────────

// Check session every 15 seconds
chrome.alarms.create('session-check', { periodInMinutes: 0.25 });
// Flush buffer every 5 seconds
chrome.alarms.create('flush-buffer',  { periodInMinutes: 1 / 12 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'session-check') {
    await checkSession();
  } else if (alarm.name === 'flush-buffer') {
    await flushBuffer();
  }
});

// ── Message API (popup ↔ background) ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-status') {
    sendResponse({
      active:     sessionState.active,
      sessionId:  sessionState.sessionId,
      deviceId:   sessionState.deviceId,
      buffered:   eventBuffer.length,
    });
  } else if (msg.type === 'set-port') {
    sessionState.bridgePort = msg.port || 41732;
    sendResponse({ ok: true });
  }
  return true;
});

// Initial check
checkSession();
