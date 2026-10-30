# MASTER IMPLEMENTATION BASELINE: SMART CLASSROOM MONITORING SYSTEM
**Project:** Smart Classroom Monitoring and Examination Integrity System  
**Repository:** `D:\ExamProctor-SecondRound`  
**Date:** 2026-10-30  
**Status:** Pre-Implementation Baseline Complete

---

## 1. Existing Application Architecture
- **Web Frontend:** React 19, Vite, Tailwind CSS, React Router v6, Lucide Icons, Neo-Brutalism design system tokens (`--neo-*`).
- **In-Browser Vision / Proctoring:** MediaPipe Tasks Vision (`FaceLandmarker`), ONNX Runtime Web (`YOLOv8`/`MobileNet` phone detector), HTML5 Canvas (`getUserMedia`).
- **Local Client Storage:** Dexie.js (IndexedDB) storing local attempt progress, proctoring events, and offline synchronization queues.
- **Desktop Packaging:** Electron 34 with standard main process (`desktop-app/main.js`), secure preload bridge (`desktop-app/preload.js`), and context isolation enabled.
- **Backend Server:** Python FastAPI running with Uvicorn, Pydantic v2 schemas, Starlette WebSockets.
- **Databases:**
  1. *Primary Database:* PostgreSQL accessed via SQLAlchemy 2.0 (asyncio + asyncpg) handling core users, exams, attempts, questions, submissions, and proctoring events.
  2. *Classroom Database:* Isolated SQLite (`classroom.db`) accessed via SQLAlchemy synchronous sessions managing classroom sessions, hardware devices, session-device assignments, active alerts, and instructor commands.
- **Student Agent:** Independent background Python process running `psutil`, `mss` (screen capture), `Pillow`, `aiohttp`/`websockets`, with a local authenticated HTTP bridge (`bridge.py`) listening on `127.0.0.1:41732`.
- **Browser Extension:** Chrome/Edge Manifest V3 extension tracking active URL navigation via `chrome.webNavigation` and forwarding domain events to the local agent bridge.

---

## 2. Existing Folder Structure
```
D:\ExamProctor-SecondRound\
├── backend/
│   ├── app/
│   │   ├── api/v1/         # Core exam, attempt, user, auth, settings, report endpoints
│   │   ├── classroom/      # Classroom monitoring module (hub, models, schemas, api, services)
│   │   ├── core/           # Config, database, security, dependencies
│   │   ├── models/         # SQLAlchemy models for PostgreSQL (User, Exam, Attempt, etc.)
│   │   └── services/       # Evidence storage, analysis, grading
│   ├── tests/              # Backend pytest suite (91 passing tests)
│   └── requirements.txt
├── desktop-app/
│   ├── main.js             # Electron main process (lifecycle, window, IPC)
│   ├── preload.js          # Electron contextBridge exposing electronAPI
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/     # UI primitives (Neo-Brutalism), layouts, headers, sidebars
│   │   ├── hooks/          # useAuth, useProctoring, useSyncWorker
│   │   ├── pages/
│   │   │   ├── admin/      # Admin dashboard, users, exams, reports, classrooms
│   │   │   ├── professor/  # Professor dashboard, exams, submissions, classroom (LiveMonitoring, Devices)
│   │   │   └── student/    # Student dashboard, available exams, entry, readiness, session, device status
│   │   ├── proctoring/     # MediaPipe, ONNX detectors, canvas capture, event engine
│   │   ├── services/       # api.js, classroomApi.js, dexie DB
│   │   └── stores/         # Zustand auth store
│   └── package.json        # Frontend scripts (88 passing vitest tests)
├── student-agent/
│   ├── agent.py            # Main agent loop, WebSocket client, command executor
│   ├── bridge.py           # Local HTTP server (port 41732) receiving frames/events
│   ├── screen_capture.py   # Desktop screen capture via mss
│   ├── monitor.py          # OS active window/app monitoring via win32 / psutil
│   └── offline_queue.py    # Local SQLite event queue for network dropouts
├── browser-extension/      # Chrome/Edge MV3 navigation tracker
└── docs/                   # Specifications, architecture, guides, audit reports
```

---

## 3. Existing Database Architecture
### Primary PostgreSQL Schema (`app/models/`)
- `users`: ID, email, hashed_password, role (`student`, `professor`, `admin`), is_active, full_name.
- `exams`: ID, title, description, created_by, duration_minutes, access_code, start_time, end_time, status (`draft`, `published`, `active`, `completed`), max_attempts.
- `attempts`: ID, exam_id, user_id, start_time, end_time, status (`in_progress`, `submitted`, `flagged`), score.
- `proctor_events`: ID, attempt_id, event_type (`face_absent`, `multiple_faces`, `phone_detected`, `tab_switch`), severity, timestamp, evidence_snapshot_id.
- `system_settings`: Global proctoring thresholds (confidence, grace period, violation counts).

### Independent Classroom SQLite Schema (`app/classroom/models.py`)
- `classroom_sessions`: ID, exam_id, professor_id, title, status (`active`, `paused`, `completed`), started_at, ended_at.
- `classroom_devices`: ID, device_id (hardware hash), student_id, hostname, platform, status (`pending`, `approved`, `revoked`).
- `classroom_session_devices`: Session-to-device mapping: session_id, device_id, status (`active`, `disconnected`, `terminated`).
- `classroom_alerts`: ID, session_id, device_id, alert_type, severity, message, timestamp, acknowledged.
- `classroom_commands`: ID, session_id, device_id, command_type (`lock`, `refresh`, `message`), status, response.

---

## 4. Existing Authentication Flow
- User logs in via `POST /api/v1/auth/login` receiving an access JWT (expires in 60m) and refresh JWT.
- Tokens stored in Zustand store and `localStorage`.
- Requests include `Authorization: Bearer <token>`.
- Professor/Admin routes protected by `RoleRoute` component checking token claims.
- Device enrollment requires a student login token to establish device-to-student association.

---

## 5. Existing Examination Lifecycle
1. **Catalog/Entry:** Student navigates to `/student/exams`, selects an exam, and enters the 6-character access code in `ExamEntryPage.jsx`.
2. **Readiness Check:** `ReadinessPage.jsx` validates camera permissions (`getUserMedia`), checks audio, displays system checklist, and requests user consent.
3. **Attempt Creation:** User clicks "Start Exam", sending `POST /api/v1/attempts/start`. Backend issues an `attempt_id`.
4. **Active Session:** `ExamSessionPage.jsx` loads questions, mounts `useProctoring.js`, starts countdown timer, and logs answers.
5. **Submission:** Student clicks "Submit Exam" or timer expires, sending `POST /api/v1/attempts/{id}/submit`.

---

## 6. Existing Electron Lifecycle
- `desktop-app/main.js` launches BrowserWindow with preload script.
- Preload exposes `window.electronAPI`:
  - `minimize()`, `maximize()`, `close()`
  - `systemInfo()` (hostname, platform, arch)
  - `agentStatus()`, `agentLaunch()`, `agentStop()` (IPC wrappers)
- Currently, **neither `ReadinessPage.jsx` nor `ExamSessionPage.jsx` triggers `agentLaunch`**.

---

## 7. Existing Student Agent Lifecycle
- Agent can be launched from terminal: `python agent.py --device-id <ID> --server <URL>`.
- Starts local HTTP bridge on `http://127.0.0.1:41732`.
- Enters polling loop waiting for `bridge._state.get("session_id")`.
- When `session_id` is set, connects to WebSocket `ws://<server>/classroom/ws/agent/<device_id>?session_id=<session_id>`.
- Starts concurrent tasks:
  1. `capture_and_send_screen`: captures desktop via `mss` at 2 fps, encodes JPEG (quality 55), transmits over WS.
  2. `send_webcam_loop`: reads `bridge._state["latest_webcam_frame"]`, transmits over WS at 1 fps.
  3. `monitor_applications`: polls Win32 active window every 1.5s, detects prohibited apps.
  4. `receive_commands`: listens for professor commands (`lock`, `message`, `refresh`).

---

## 8. Existing Screen Capture and Transmission
- `student-agent/screen_capture.py` captures primary monitor via `mss.mss().grab()`.
- Resized to 640×360, encoded as JPEG (quality 55) in `agent.py`.
- Payload sent as JSON: `{"type": "screen_frame", "timestamp": ..., "frame": "<base64>"}`.
- Backend `hub.py` caches latest frame in memory: `_latest_screen_frames[session_id][device_id]`.
- Hub broadcasts frame to all connected instructor WebSockets for that session.
- Frontend `StudentCctvCard.jsx` decodes base64 into `<img>` element.

---

## 9. Existing Webcam Capture and Transmission
- `frontend/src/proctoring/useProctoring.js` captures user webcam at 640×480 for MediaPipe and ONNX face/phone detection.
- Every 1000ms, renders video frame to offscreen 160×120 canvas.
- Posts frame to `http://127.0.0.1:41732/webcam-frame`.
- `bridge.py` stores frame in `_state["latest_webcam_frame"]`.
- `agent.py` forwards frame over WS as `{"type": "webcam_frame", "frame": "<base64>"}`.
- Hub broadcasts to instructor; `StudentCctvCard.jsx` renders inside circular badge.

---

## 10. Existing Proctoring Event Storage
- MediaPipe FaceLandmarker and ONNX YOLO phone detector run client-side in `cvEventEngine.js`.
- Events (`face_absent`, `multiple_faces`, `phone_detected`, `focus_loss`) are logged to Dexie IndexedDB.
- `useSyncWorker.js` synchronizes Dexie events with PostgreSQL `proctor_events` table.
- **CRITICAL GAP:** AI proctoring events are currently **never forwarded to the Student Agent or Classroom Hub**. The classroom monitoring screen only sees OS application events and browser extension domain alerts.

---

## 11. Existing Classroom WebSocket Architecture
- Instructor endpoint: `ws://<backend>/classroom/ws/instructor/{session_id}?token=<jwt>`.
- Agent endpoint: `ws://<backend>/classroom/ws/agent/{device_id}?session_id=<session_id>&token=<device_token>`.
- Hub (`hub.py`) maintains active socket sets per session and routes messages:
  - Agent → Instructor: `screen_frame`, `webcam_frame`, `alert`, `heartbeat`.
  - Instructor → Agent: `command` (`lock`, `refresh`, `message`).
- Broadcast throttled and buffered in memory.

---

## 12. Existing Offline Synchronization
- If student network drops, `student-agent/offline_queue.py` stores alerts and telemetry in a local SQLite file (`agent_offline.db`).
- Upon reconnection, agent sends buffered events via `POST /classroom/sync/events`.
- Backend verifies event IDs to prevent duplicate ingestion.
- Frontend Dexie sync worker provides parallel offline queue for exam answers and legacy proctor events.

---

## 13. Existing Professor Dashboard
- Routes: `/professor/dashboard`, `/professor/exams`, `/professor/classroom`, `/professor/classroom/live/:id`, `/professor/classroom/devices`.
- Real-time live monitoring grid implemented in `LiveMonitoringPage.jsx` and `ClassroomDashboard.jsx`.
- Uses `StudentCctvCard.jsx` and `SelectedStudentModal.jsx`.

---

## 14. Existing Student Dashboard
- Routes: `/student/dashboard`, `/student/exams`, `/student/exam/enter`, `/student/readiness/:id`, `/student/exam/session/:id`, `/student/device-status`.
- `DeviceStatusPage.jsx` has a broken endpoint: requests `/health` instead of `/status` on `127.0.0.1:41732`.

---

## 15. Existing Administrator Dashboard
- Routes: `/admin/dashboard`, `/admin/users`, `/admin/exams`, `/admin/classroom/sessions`, `/admin/classroom/devices`.
- Provides system health statistics and approval/revocation of registered hardware devices.

---

## 16. Existing Test Results (Baseline)
- **Backend Tests:** `pytest tests/` → **91 passed, 0 failed, 25 warnings** (12.72s).
- **Frontend Tests:** `npm test -- --run` → **88 passed, 0 failed** (13.55s).
- **Frontend Build:** `npm run build` → **SUCCESS (0 errors, 0 warnings)** (2.50s).
- **Python Agent Bytecode:** `py_compile` on all 6 agent scripts → **0 syntax errors**.

---

## 17. Identified Broken Integrations & Root Causes
1. **No Auto-Launch of Python Agent:** `ReadinessPage.jsx` and `ExamSessionPage.jsx` never trigger Electron `agentLaunch`.
2. **Agent Infinite Polling Deadlock:** `agent.py` loops waiting for `bridge._state.get("session_id")`, but the exam interface never posts the session ID to `http://127.0.0.1:41732/session`.
3. **Missing Device Assignment UI:** `CreateSessionModal.jsx` creates a session, but has no UI to assign devices to `ClassroomSessionDevice`. As a result, `build_grid()` returns `[]`, leaving the professor grid empty.
4. **AI Events Not Reaching Classroom Hub:** `useProctoring.js` logs face/phone events to Dexie/PostgreSQL, but never posts them to the agent bridge or classroom WebSocket.
5. **`DeviceStatusPage.jsx` 404 Bug:** Queries `http://127.0.0.1:41732/health`, which does not exist in `bridge.py` (`/status` is the valid endpoint).
6. **No Independent Webcam Click:** Clicking `.webcamOverlay` bubbles up to the card click, opening the full student modal rather than an enlarged camera preview.
7. **Missing 6-per-row Layout:** Selector and CSS grid only support `2x2`, `3x3`, `4x4`, and `Auto`.
8. **Hardcoded Localhost Assumptions:** Bridge and agent endpoints need to support dynamic LAN server addresses.

---

## 18. Security Issues
- Bridge on port 41732 must enforce local origin or token authentication to prevent arbitrary webpage probing.
- Device enrollment token must be bound to the authenticated student and active exam attempt.
- Remote instructor commands (`lock`, `message`) must be strictly validated and logged in audit trails.

---

## 19. Performance Concerns
- Concurrent screen capture at 2 fps + webcam at 1 fps per student consumes ~448 kbps bandwidth.
- A 20-student classroom requires ~9 Mbps ingress on the instructor laptop.
- In-memory frame dropping in `hub.py` prevents buffer bloating; however, frame decoding in the browser canvas must ensure low CPU utilization.

---

## 20. Exact Files Requiring Changes
1. `backend/app/classroom/api/sessions.py` (Add automatic exam-to-classroom device assignment endpoint)
2. `backend/app/classroom/api/devices.py` (Add automatic device auto-enrollment for active exam attempts)
3. `student-agent/bridge.py` (Add `/health` alias, add `/ai-events` endpoint for proctoring events)
4. `student-agent/agent.py` (Receive AI events from bridge and forward as alerts over WebSocket)
5. `desktop-app/main.js` (Handle agent auto-launch on exam entry and termination on submit)
6. `desktop-app/preload.js` (Expose agent start/session bridge IPC to renderer)
7. `frontend/src/proctoring/useProctoring.js` (Forward AI face/phone violation events to `http://127.0.0.1:41732/ai-events`)
8. `frontend/src/pages/student/ReadinessPage.jsx` (Auto-launch agent via Electron IPC, register session with bridge)
9. `frontend/src/pages/student/ExamSessionPage.jsx` (Notify bridge of active exam attempt, trigger session assignment)
10. `frontend/src/pages/student/DeviceStatusPage.jsx` (Fix health check URL to `/status`)
11. `frontend/src/pages/professor/classroom/CreateSessionModal.jsx` (Add device multi-select to assign registered devices)
12. `frontend/src/pages/professor/classroom/StudentCctvCard.jsx` (Add independent click handler for circular webcam preview)
13. `frontend/src/pages/professor/classroom/LiveMonitoringPage.jsx` (Add 6-per-row grid layout option and enlarged webcam modal)
14. `frontend/src/pages/professor/classroom/ClassroomDashboard.module.css` (Add `.grid-6x6` styles)

---
*Baseline audit verified. Phase 0 complete. Proceeding to Phase 1.*
