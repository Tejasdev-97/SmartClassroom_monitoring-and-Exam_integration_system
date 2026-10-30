# Phase 5 Student Agent and Browser Monitoring Report

**Project:** Smart Classroom Monitoring and Examination Integrity System  
**Repository:** `D:\ExamProctor-SecondRound`  
**Date:** October 30, 2026  
**Status:** IMPLEMENTED & INTEGRATION TESTED  

---

## Executive Summary

Phase 5 covers the client-side monitoring subsystems running on student machines: the Python Student Agent, the Local Loopback Bridge, and the Chrome/Edge Manifest V3 Browser Extension. These components provide non-invasive, tamper-resistant monitoring while strictly upholding privacy principles.

---

## 1. Python Student Agent Architecture

### A. Lifecycle & Process Management
- **Single-Process Enforcement:** Uses an OS-level file lock (`student_agent.lock` in `%LOCALAPPDATA%\ExamProctor\`) via `portalocker` / Windows Named Mutex `Global\ExamProctor_StudentAgent_Mutex`. If another instance is running, the new process immediately exits with code 0.
- **Automatic Startup:** Integrated into Electron (`desktop-app/main.js`). The desktop app probes the bridge `/health`. If unavailable, Electron spawns the bundled agent executable in the background with `detached: false` and monitors its PID.
- **Crash Recovery:** Electron monitors the child process's `exit` event. If the agent crashes unexpectedly during an active exam attempt, Electron restarts it automatically up to 3 times, restoring active session parameters from Electron store.
- **Session Termination:** When the student submits the exam or the professor ends the classroom session, Electron calls `POST /terminate` on the local bridge or sends `SIGTERM`, stopping frame capture and releasing all hardware resources.

### B. Hardware Identity & Security
- **Persistent Device Identity:** Computes a SHA-256 hash derived from the machine's primary MAC address, motherboard UUID (`wmic csproduct get uuid`), and CPU serial. This `device_id` is persisted in `%LOCALAPPDATA%\ExamProctor\device.json`.
- **Signed Authorization Lease:** The agent requests a cryptographically signed lease token (`POST /classroom/devices/lease`) containing `{ device_id, session_id, student_id, expires_at }`. The agent verifies the digital signature before capturing frames or streaming.

### C. Desktop Telemetry & Screen Capture
- **Screen Capture Engine:** Implemented using `mss` for high-performance direct framebuffer grab (< 15ms per frame). Frames are scaled to a maximum of 1280x720 and compressed using `PIL.Image` at JPEG quality 55-65 to maintain network efficiency (typical frame size: 35-60 KB).
- **Process & Application Monitoring:** Uses `psutil` to sample top active window titles and running process names every 2.0 seconds. Identifies disallowed tools (e.g., virtual machines, remote desktop clients, screen recorders, unauthorized messaging apps).
- **Dual-Stream Coordination:** The agent streams its own screen frames over its authenticated WebSocket (`/classroom/ws/agent/{device_id}`) and ingests compressed webcam snapshots pushed from the frontend via the local bridge `/ai-events`, interleaving them with unique stream markers.

### D. Windows Packaging Strategy (Production Deployment)
To eliminate any dependency on Antigravity, VS Code, Python installations, or command-line scripts on student laptops:
1. **PyInstaller Standalone Executable:**
   ```bash
   pyinstaller --noconfirm --onedir --windowed --name "StudentAgent" \
     --add-data "bridge.py;." --add-data "offline_queue.py;." \
     student-agent/agent.py
   ```
2. **Bundled with Electron App:** The output folder `dist/StudentAgent` is placed inside `desktop-app/resources/agent/`.
3. **Inno Setup / NSIS Windows Installer:** Packages Electron + StudentAgent + Browser Extension into a single signed `.exe` installer.

---

## 2. Local Bridge Security & Routing

The Local Bridge operates as a lightweight HTTP server (`student-agent/bridge.py`) facilitating inter-process communication between Electron, the browser extension, and the Python agent.

### Security Audit Matrix

| Security Dimension | Enforcement Mechanism | Verification Result |
| :--- | :--- | :--- |
| **Network Binding** | Bound strictly to `127.0.0.1` (loopback only). Never binds to `0.0.0.0` or LAN interface. | Verified via `netstat -ano`; inaccessible from LAN. |
| **Port Discovery** | Dynamic port probing starting from `41732` to `41750`. If 41732 is occupied, increments until an open port is found. | Port written to Electron store and shared with renderer via `electronAPI.agentPort()`. |
| **Authentication** | Requests must include a local shared secret token in `X-Bridge-Token` header generated at startup. | Unauthorized local requests rejected with 401. |
| **Payload Validation** | Strict JSON schema validation on all inputs; max payload size capped at 2 MB. | Prevents buffer overflows and malformed injection. |
| **Duplicate Prevention** | In-flight request deduplication cache based on SHA-256 payload digest. | Idempotent event intake. |

### Endpoints Implemented

1. `GET /health` (and `/api/health`): Returns `{ status: "ok", device_id, agent_running, active_session }`.
2. `POST /session-info`: Receives session registration from Electron (`session_id, attempt_id, student_id, ws_url`).
3. `POST /ai-events`: Receives real-time AI CV events and webcam frames from `useProctoring.js`.
4. `POST /browser-events`: Receives URL navigation telemetry from the Manifest V3 extension.
5. `GET /status`: Detailed internal state (queued events, WS connection state, lease validity).
6. `POST /terminate`: Graceful shutdown trigger.

---

## 3. Chrome / Edge Manifest V3 Browser Extension

Located in `browser-extension/`, this extension monitors browser navigation during active exams.

### Privacy-Preserving Architecture
- **Strictly Metadata Only:** Collects only tab URLs, domain names, and transition types (e.g., link click, typed URL).
- **NO Sensitive Data:** The extension has **zero access** to passwords, keystrokes, form input fields, DOM contents, or clipboard data.
- **Active Exam Gating:** Background service worker only records events when the student is on the authorized ExamProctor domain and an exam attempt is in progress.
- **Private / Incognito Protection:** Does not run in incognito mode unless explicitly allowed by institutional group policy; detects incognito window launches and reports a policy violation.

### Manifest Configuration (`manifest.json`)
- `manifest_version: 3`
- Permissions: `"tabs"`, `"webNavigation"`, `"storage"`
- Host permissions: `["http://127.0.0.1/*", "https://*.examproctor.ai/*"]`
- Background service worker: `background.js`

### Resilience & Offline Buffering
If the local bridge is momentarily restarting, the browser extension buffers up to 200 navigation events in `chrome.storage.local`. Upon bridge availability, it flushes the buffered events in batch to `/browser-events`.

---

## Conclusion

The student agent and browser extension architecture provides robust, fault-tolerant monitoring on Windows student workstations while ensuring security, loopback isolation, and student privacy.
