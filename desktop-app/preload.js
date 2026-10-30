/**
 * ExamProctor.ai — Electron Secure Preload Script
 * Exposes a strictly restricted API to the React renderer via contextBridge.
 * Follows Electron security best practices: contextIsolation enabled, nodeIntegration disabled.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // Fullscreen management
  setFullscreen: (flag) => ipcRenderer.invoke('window:set-fullscreen', Boolean(flag)),
  getFullscreen: () => ipcRenderer.invoke('window:get-fullscreen'),

  // Event listeners for exam integrity
  onFullscreenChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, isFullscreen) => callback(isFullscreen);
    ipcRenderer.on('window:fullscreen-change', subscription);
    return () => ipcRenderer.removeListener('window:fullscreen-change', subscription);
  },

  onWindowBlur: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('window:blur', subscription);
    return () => ipcRenderer.removeListener('window:blur', subscription);
  },

  onWindowFocus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('window:focus', subscription);
    return () => ipcRenderer.removeListener('window:focus', subscription);
  },

  // App metadata
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getPlatform: () => process.platform,

  // Screen monitoring and focus evidence capture (exam-scoped)
  initScreenCaptureSession: (params) => ipcRenderer.invoke('screen-capture:init-session', params),
  requestScreenCapture: (params) => ipcRenderer.invoke('screen-capture:capture', params),
  stopScreenCaptureSession: () => ipcRenderer.invoke('screen-capture:stop-session'),

  // ── Classroom Agent Bridge (Python agent at 127.0.0.1:41732) ──────────────
  // These methods proxy IPC calls to the Python student agent's localhost bridge
  // without exposing Node.js http directly to the renderer.
  agentStatus:      ()       => ipcRenderer.invoke('agent:status'),
  agentSetSession:  (params) => ipcRenderer.invoke('agent:set-session', params),
  agentGetCommands: ()       => ipcRenderer.invoke('agent:get-commands'),
  agentCommandResult: (params) => ipcRenderer.invoke('agent:command-result', params),

  // Agent lifecycle — start/stop Python agent from the classroom UI
  agentLaunch:    (params) => ipcRenderer.invoke('agent:launch', params),
  agentStop:      ()       => ipcRenderer.invoke('agent:stop'),
  agentIsRunning: ()       => ipcRenderer.invoke('agent:is-running'),
  agentPort:      ()       => ipcRenderer.sendSync('agent:port:sync'),
});
