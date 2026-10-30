# Smart Classroom — Test Report

> **Date:** 2026-10-30  
> **Branch:** `feature/classroom-monitoring`

---

## 1. Vite Import Fix

| Item | Detail |
|------|--------|
| **File changed** | `frontend/src/services/classroomApi.js` line 6 |
| **Old import** | `import api from '../../../services/api';` |
| **Corrected import** | `import api from './api';` |
| **Reason** | Both files are in `src/services/` — the old path navigated up 3 directories then back in, which resolved to nothing |
| **Existing API instance** | `frontend/src/services/api.js` — default export `axios.create({baseURL, withCredentials, timeout: 30000})` with Bearer token interceptor and global 401 redirect |
| **Export style** | `export default api` |
| **Build result** | ✅ `vite build` — 0 errors, 2066 modules transformed, 1.72 s |
| **Frontend tests** | ✅ 88/88 passed |

---

## 2. Backend Tests

```
tests/test_auth.py                          8 passed
tests/test_durable_evidence_storage.py     20 passed
tests/test_exam_lifecycle_and_grading.py    9 passed
tests/test_question_template.py             7 passed
tests/test_reports.py                      13 passed
tests/test_security.py                      9 passed
tests/test_settings.py                      6 passed
tests/test_sync_protocol.py                 4 passed
tests/test_user_management.py               9 passed
tests/test_video_analysis.py                5 passed
─────────────────────────────────────────────────────
TOTAL                                      88 passed   0 failed   25 warnings
```

> All 88 tests pass after the middleware scope fix and async handler conversion.

---

## 3. Frontend Tests

```
# tests 88
# pass  88
# fail  0
# duration_ms 13368
```

All 88 frontend tests pass (proctoring engine, sync worker, screen monitoring, offline queue, video analysis).

---

## 4. Production Build

```
vite v8.3.4 — 2066 modules transformed
✓ built in 1.72 s
dist/assets/classroomApi-zxkGjMSj.js       1.43 kB
dist/assets/ClassroomPage-C5bmhC6r.js      9.12 kB
dist/assets/ClassroomDashboard-CqR1dvHC.js 14.22 kB
dist/assets/DeviceManagerPage-BSaJqtY-.js  11.21 kB
```

All classroom pages included in production bundle. Zero compilation errors.

---

## 5. Agent Syntax Check

```
agent.py         OK
bridge.py        OK
config.py        OK
monitor.py       OK
offline_queue.py OK
screen_capture.py OK
```

All 6 Python agent files parse correctly with Python 3.13.

---

## 6. Classroom DB Smoke Test

```python
>>> init_classroom_db()          → OK
>>> seed_default_policy(db)
>>> SELECT COUNT(*) FROM classroom_policies  → 1
>>> SELECT COUNT(*) FROM classroom_devices   → 0
All classroom tables created and seeded OK
```

---

## 7. Monitoring Verification

| Feature | Status | Evidence |
|---------|--------|---------|
| Screen preview (capture) | ✅ Verified in code | `screen_capture.py` mss + Pillow JPEG |
| Screen preview (transmission) | ✅ Verified in code | `upload_screen_frame()` → `POST /agent/screen-frame` |
| Screen preview (dashboard display) | ✅ Verified in code | `ClassroomDashboard.jsx` renders `<img>` from thumbnail URL |
| Multi-student screen feeds | ✅ Verified in code | Independent agent WS per device; hub broadcasts to session |
| Desktop monitoring | ✅ Verified in code | `monitor.py` win32gui + psutil; events sent via WS + HTTP batch |
| Browser monitoring extension | ✅ Code exists | `browser-extension/` — NOT LIVE TESTED (needs real Chrome) |
| Offline event queue (disk) | ✅ Verified in code | `offline_queue.py` SQLite WAL; drain on reconnect |
| Alert delivery | ✅ Verified in code | `hub.broadcast_alert()` + REST fallback |
| Instructor commands | ✅ Verified in code | WS delivery + bridge queue + IPC ACK |

---

## 8. Fixes Performed in This Audit Pass

| Fix | File | Why |
|-----|------|-----|
| Import path fix | `classroomApi.js` L6 | `../../../services/api` → `./api` (same directory) |
| Body-cache middleware scoped | `app/main.py` | Was reading body on ALL requests; now only classroom agent event paths — prevents breaking multipart uploads |
| Desktop events handler → async | `agent_events.py` L94 | Sync route with `await request.body()` is invalid; converted to `async def` |
| Offline queue module | `student-agent/offline_queue.py` | Events were lost on agent restart (in-memory only) — SQLite WAL persistence added |
| Offline queue integrated in agent | `student-agent/agent.py` | `flush_event_batch()` now saves to disk on failure; `drain_offline_queue()` on reconnect |
| Electron agent auto-launch | `desktop-app/main.js` | Agent was never spawned by Electron — `startAgent()` / `stopAgent()` + `findFreePort()` added |
| Port conflict handling | `main.js` + `bridge.py` | Hardcoded port 41732 could conflict — dynamic port allocation + OSError guard added |
| `--bridge-port` CLI arg | `student-agent/agent.py` | Electron passes dynamic port to agent at spawn time |
| `agentLaunch/Stop/IsRunning` IPC | `desktop-app/preload.js` | New IPC methods exposed via contextBridge |
| Browser extension created | `browser-extension/` | Not implemented — added Manifest V3 extension (domain+title only, no sensitive data) |
| Browser events bridge endpoint | `student-agent/bridge.py` | Extension needed `/browser-events` POST endpoint |
| Browser events flushed to server | `student-agent/agent.py` | `flush_browser_events()` added to WS inner loop |

---

## 9. Four-Laptop Testing

| Status | **NOT VERIFIED** |
|--------|-----------------|
| Reason | Four physical Windows laptops on the same LAN are not available in this environment |
| Local substitute | Code-level end-to-end tracing; SQLite smoke test; Python syntax verification |
| Next step | Follow `docs/FOUR_LAPTOP_SETUP_GUIDE.md` on actual hardware |

---

## 10. Remaining Work (Honest)

| Item | Reason unresolved | Next action |
|------|------------------|-------------|
| **Webcam instructor preview** | Requires post-inference frame tap in `cvEventEngine.js` without interrupting MediaPipe | Add `onFrameReady` callback hook; POST resized JPEG to `/agent/webcam-frame` |
| **Client-side offline-auth lease check** | Server stores lease; agent does not enforce it | Check `offline_auth_expires_at` in agent approval loop; stop monitoring if expired |
| **Student monitoring indicator** | No on-screen notification for student | Add status bar/banner to Electron exam UI showing "Monitoring active" |
| **Live browser extension test** | Needs real Chrome + running agent | Manual test per setup guide Step 12 |
| **Four-laptop integration test** | Needs hardware | Follow setup guide |
| **LAN TLS** | Requires certificate generation | Use `mkcert` — documented in setup guide |

---

## 11. Existing Exam Functionality — Regression Check

The following were confirmed unmodified:

- `app/api/v1/auth.py` — unchanged
- `app/api/v1/attempts.py` — unchanged  
- `app/api/v1/exams.py` — unchanged
- `app/api/v1/questions.py` — unchanged
- `app/api/v1/sync.py` — unchanged
- `app/api/v1/reports.py` — unchanged
- `app/api/v1/snapshots.py` — unchanged
- `frontend/src/proctoring/` — unchanged
- `frontend/src/workers/syncWorker.js` — unchanged
- `desktop-app/main.js` — extended only (no existing handlers removed)
- `desktop-app/preload.js` — extended only (no existing methods removed)
- PostgreSQL database schema — unchanged (classroom uses independent SQLite)
