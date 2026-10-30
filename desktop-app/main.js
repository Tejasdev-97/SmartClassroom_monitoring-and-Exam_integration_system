/**
 * ExamProctor.ai — Electron Main Process
 * Manages the desktop application lifecycle, secure BrowserWindow creation,
 * native fullscreen enforcement, focus tracking, and camera permissions.
 */

const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Enforce single application instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

function getEntryUrl() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (isDev) {
    return { type: 'url', value: devServerUrl };
  }

  // Look for built dist/index.html in production locations
  const possiblePaths = [
    path.join(__dirname, 'frontend/dist/index.html'),
    path.join(__dirname, '../frontend/dist/index.html'),
    path.join(process.resourcesPath || '', 'frontend/dist/index.html'),
    path.join(process.resourcesPath || '', 'app.asar/frontend/dist/index.html'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return { type: 'file', value: p };
    }
  }

  // Default to relative frontend/dist
  return { type: 'file', value: path.join(__dirname, '../frontend/dist/index.html') };
}

let fullscreenTransitionUntil = 0;

function markFullscreenTransition(durationMs = 2000) {
  fullscreenTransitionUntil = Math.max(fullscreenTransitionUntil, Date.now() + durationMs);
}

function createWindow() {
  const icoCandidate = path.join(__dirname, 'assets', 'icon.ico');
  const pngCandidate = path.join(__dirname, 'assets', 'icon.png');
  let iconPath;
  if (process.platform === 'win32' && fs.existsSync(icoCandidate)) {
    iconPath = icoCandidate;
  } else if (fs.existsSync(pngCandidate)) {
    iconPath = pngCandidate;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: 'ExamProctor.ai — Student Examination Platform',
    icon: iconPath,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Grant camera permission for proctoring checks
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });

  // Native fullscreen event forwarding
  mainWindow.on('enter-full-screen', () => {
    markFullscreenTransition(1500);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-change', true);
    }
  });

  mainWindow.on('leave-full-screen', () => {
    markFullscreenTransition(1500);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-change', false);
    }
  });

  // Focus and blur tracking for examination integrity
  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const isFullscreenTransition = Date.now() < fullscreenTransitionUntil;
      mainWindow.webContents.send('window:blur', {
        timestamp: new Date().toISOString(),
        isFullscreenTransition,
      });
    }
  });

  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus', {
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Restrict navigation to prevent leaving the application
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isLocalhost = url.startsWith('http://localhost:5173') || url.startsWith('http://127.0.0.1:5173');
    const isFile = url.startsWith('file://');
    if (!isLocalhost && !isFile) {
      event.preventDefault();
      console.warn('[Security] Blocked external navigation to:', url);
    }
  });

  // Deny new window creation (window.open, target="_blank")
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[Security] Denied window.open to:', url);
    return { action: 'deny' };
  });

  // Load content
  const entry = getEntryUrl();
  console.log(`[ExamProctor Desktop] Resolved frontend entry (${entry.type}):`, entry.value);
  if (entry.type === 'url') {
    const devUrl = entry.value.replace(/\/+$/, '');
    mainWindow.loadURL(`${devUrl}/#/login`);
  } else {
    mainWindow.loadFile(entry.value, { hash: '/login' });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Second instance focus
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Register IPC handlers
ipcMain.handle('window:set-fullscreen', (_event, flag) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const target = Boolean(flag);
    if (mainWindow.isFullScreen() !== target) {
      markFullscreenTransition(2000);
      mainWindow.setFullScreen(target);
    }
    return mainWindow.isFullScreen();
  }
  return false;
});

ipcMain.handle('window:get-fullscreen', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.isFullScreen();
  }
  return false;
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

// ── Screen Monitoring & Focus Evidence Capture Coordinator ─────────────────
let screenCaptureSession = {
  attemptId: null,
  consented: false,
  status: 'idle', // 'idle' | 'active' | 'stopped'
  capturedEventIds: new Set(),
};

async function captureScreenThumbnail() {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    throw new Error('desktopCapturer is unavailable in this environment');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1280, height: 720 },
  });
  if (!sources || sources.length === 0) {
    throw new Error('No screen display source available for capture');
  }
  const primarySource = sources[0];
  const thumbnail = primarySource.thumbnail;
  if (!thumbnail || thumbnail.isEmpty()) {
    throw new Error('Screen capture resulted in empty thumbnail');
  }
  const size = thumbnail.getSize();
  const jpegBuffer = thumbnail.toJPEG(75);
  return {
    base64: jpegBuffer.toString('base64'),
    width: size.width,
    height: size.height,
    mimeType: 'image/jpeg',
    sizeBytes: jpegBuffer.length,
    sourceName: primarySource.name || 'Primary Display',
  };
}

ipcMain.handle('screen-capture:init-session', (_event, params) => {
  const { attemptId, consented } = params || {};
  if (!attemptId || typeof attemptId !== 'string') {
    return { success: false, error: 'Invalid attempt ID' };
  }
  screenCaptureSession = {
    attemptId,
    consented: Boolean(consented),
    status: 'active',
    capturedEventIds: new Set(),
  };
  console.log(`[Screen Monitoring] Initialized session for attempt: ${attemptId} (consented: ${screenCaptureSession.consented})`);
  return { success: true, status: 'active', consented: screenCaptureSession.consented };
});

ipcMain.handle('screen-capture:capture', async (_event, params) => {
  const { attemptId, eventId, requestId, reason } = params || {};
  if (screenCaptureSession.status !== 'active') {
    return {
      success: false,
      error: `Screen capture session is not active (${screenCaptureSession.status})`,
      requestId,
      eventId,
      attemptId,
    };
  }
  if (screenCaptureSession.attemptId !== attemptId) {
    return {
      success: false,
      error: 'Unauthorized attempt ID for active session',
      requestId,
      eventId,
      attemptId,
    };
  }
  if (!screenCaptureSession.consented) {
    return {
      success: false,
      error: 'Screen capture consent was not granted for this examination',
      requestId,
      eventId,
      attemptId,
    };
  }
  if (screenCaptureSession.capturedEventIds.has(eventId)) {
    return {
      success: false,
      error: `Screenshot already captured for event: ${eventId}`,
      requestId,
      eventId,
      attemptId,
    };
  }

  try {
    const result = await captureScreenThumbnail();
    screenCaptureSession.capturedEventIds.add(eventId);
    console.log(`[Screen Monitoring] Successfully captured evidence for event: ${eventId} (${result.width}x${result.height}, ${result.sizeBytes} bytes)`);
    return {
      success: true,
      data: result,
      requestId,
      eventId,
      attemptId,
      reason: reason || 'focus_loss',
    };
  } catch (err) {
    console.warn(`[Screen Monitoring] Capture failed for event ${eventId}:`, err.message);
    return {
      success: false,
      error: err.message || 'Screen capture execution failed',
      requestId,
      eventId,
      attemptId,
    };
  }
});

ipcMain.handle('screen-capture:stop-session', () => {
  screenCaptureSession.status = 'stopped';
  screenCaptureSession.capturedEventIds.clear();
  console.log('[Screen Monitoring] Stopped screen capture session; all pending captures disarmed.');
  return { success: true };
});

// ── Classroom Agent Bridge (Electron ↔ Python Agent at 127.0.0.1:41732) ──────
// These IPC handlers allow the React renderer to communicate with the Python
// student agent via the localhost HTTP bridge, without directly exposing Node.js.

const http = require('http');
const { spawn, execSync } = require('child_process');

// ── Python Agent Process Management ──────────────────────────────────────────
let _agentProcess = null;   // child_process.ChildProcess or null
let _agentPort    = 41732;  // default; may be reassigned if port is taken

/**
 * Check if a TCP port is free by attempting a quick connection.
 * Returns Promise<boolean> — true if free.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = require('net').createConnection({ port, host: '127.0.0.1' });
    tester.once('error', () => resolve(true));
    tester.once('connect', () => { tester.destroy(); resolve(false); });
  });
}

/**
 * Find a free port starting from `start`.
 */
async function findFreePort(start = 41732, maxTry = 20) {
  for (let p = start; p < start + maxTry; p++) {
    if (await isPortFree(p)) return p;
  }
  return start; // fall back
}

/**
 * Locate the Python executable to use.
 * Prefer a venv inside student-agent/, then fall back to system python3/python.
 */
function findPython() {
  const isWin = process.platform === 'win32';
  const agentDir = path.join(__dirname, '..', 'student-agent');
  const venvPython = isWin
    ? path.join(agentDir, '.venv', 'Scripts', 'python.exe')
    : path.join(agentDir, '.venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) return venvPython;
  return isWin ? 'python' : 'python3';
}

/**
 * Start the Python student agent.
 * Safe to call multiple times — will not spawn a second process if one is running.
 */
async function startAgent(serverUrl) {
  if (_agentProcess && _agentProcess.exitCode === null) {
    console.log('[Agent] Already running (pid', _agentProcess.pid, ')');
    return { ok: true, pid: _agentProcess.pid, port: _agentPort };
  }

  const port = await findFreePort(41732);
  _agentPort = port;

  const python  = findPython();
  const agentDir = path.join(__dirname, '..', 'student-agent');
  const agentScript = path.join(agentDir, 'agent.py');

  if (!fs.existsSync(agentScript)) {
    console.error('[Agent] agent.py not found at', agentScript);
    return { ok: false, error: 'agent.py not found' };
  }

  const args = ['agent.py', '--bridge-port', String(port)];
  if (serverUrl) args.push('--server', serverUrl);

  _agentProcess = spawn(python, args, {
    cwd:   agentDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  _agentProcess.stdout.on('data', (d) => console.log('[Agent]', d.toString().trim()));
  _agentProcess.stderr.on('data', (d) => console.error('[Agent ERR]', d.toString().trim()));
  _agentProcess.on('exit', (code) => {
    console.log('[Agent] Exited with code', code);
    _agentProcess = null;
  });

  console.log('[Agent] Spawned pid', _agentProcess.pid, 'on bridge port', port);
  return { ok: true, pid: _agentProcess.pid, port };
}

/**
 * Stop the Python student agent gracefully (SIGTERM, then SIGKILL after 3 s).
 */
function stopAgent() {
  if (!_agentProcess) return;
  try {
    _agentProcess.kill('SIGTERM');
    const timeout = setTimeout(() => {
      if (_agentProcess) _agentProcess.kill('SIGKILL');
    }, 3000);
    _agentProcess.once('exit', () => clearTimeout(timeout));
  } catch (e) {
    console.error('[Agent] Stop error:', e.message);
  }
  _agentProcess = null;
}

function agentBridgeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: '127.0.0.1',
      port: _agentPort,  // use dynamic port resolved at launch
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 3000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Agent bridge timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Get agent status — renderer calls window.electronAPI.agentStatus() */
ipcMain.handle('agent:status', async () => {
  try {
    return await agentBridgeRequest('GET', '/status', null);
  } catch {
    return { ok: false, error: 'Agent not running' };
  }
});

/** Notify the agent which session+attempt is active */
ipcMain.handle('agent:set-session', async (_event, params) => {
  const { sessionId, attemptId } = params || {};
  try {
    return await agentBridgeRequest('POST', '/session', { session_id: sessionId, attempt_id: attemptId });
  } catch {
    return { ok: false, error: 'Agent not running' };
  }
});

/** Get pending instructor commands forwarded by the agent */
ipcMain.handle('agent:get-commands', async () => {
  try {
    return await agentBridgeRequest('GET', '/commands', null);
  } catch {
    return { commands: [] };
  }
});

/** Report command execution result back to the agent */
ipcMain.handle('agent:command-result', async (_event, params) => {
  try {
    return await agentBridgeRequest('POST', '/command-result', params);
  } catch {
    return { ok: false };
  }
});

// Launch / stop agent via IPC (React UI calls this when a session starts)
ipcMain.handle('agent:launch', async (_event, { serverUrl } = {}) => {
  return await startAgent(serverUrl);
});

ipcMain.handle('agent:stop', () => {
  stopAgent();
  return { ok: true };
});

ipcMain.handle('agent:is-running', () => ({
  running: Boolean(_agentProcess && _agentProcess.exitCode === null),
  port:    _agentPort,
}));

/** Return the current agent bridge port (sync — called from renderer via sendSync) */
ipcMain.on('agent:port:sync', (event) => {
  event.returnValue = _agentPort;
});

/** Return the current agent bridge port (async — for completeness) */
ipcMain.handle('agent:port', () => _agentPort);


// App lifecycle
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopAgent();   // always clean up agent on exit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => stopAgent());
