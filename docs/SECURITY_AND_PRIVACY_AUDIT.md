# Security and Privacy Audit Report

**Project:** Smart Classroom Monitoring and Examination Integrity System  
**Repository:** `D:\ExamProctor-SecondRound`  
**Date:** October 30, 2026  
**Status:** AUDITED & VERIFIED  

---

## Executive Summary

This Security and Privacy Audit evaluates the defensive posture, authorization models, isolation boundaries, cryptographic controls, and privacy protections across the entire ExamProctor architecture. The assessment confirms that student feeds are cryptographically and logically isolated, device authorization is strictly enforced, and student privacy is protected according to zero-trust principles.

---

## 1. Authentication & Role-Based Access Control (RBAC)

### A. JWT Token Lifecycles & Claims
- **Tokens Issued:**
  - Access Token: Short-lived (30 minutes), signed with `HS256` using server-side secret `JWT_SECRET`.
  - Refresh Token: Long-lived (7 days), stored with httpOnly semantics or protected Electron secure storage.
- **Claims Verified:** Each token encapsulates `{ sub: user_id, role: "admin" | "professor" | "student", exp, iat }`.
- **Role Verification:** FastAPIs `Security(get_current_user)` and `require_role(["professor", "admin"])` dependencies enforce strict endpoint gating. Students attempting to call professor APIs receive HTTP 403 `FORBIDDEN`.

### B. Device Authentication & Hardware Binding
- Hardware devices are enrolled with a cryptographically verified `device_id` computed from hardware components (MAC, motherboard UUID, CPU serial).
- Each device holds a unique hardware authentication token (`device_secret`) created during enrollment.
- When an agent connects, the server verifies `(device_id, device_secret)` in `classroom_devices` table before upgrading the WebSocket connection.

---

## 2. Stream Isolation & Multi-Tenant Feed Security

### A. Student-to-Student Feed Isolation
A fundamental security vulnerability in exam proctoring systems is packet eavesdropping, where a malicious student attempts to view another student's webcam or screen.

```
[Student Laptop A] ──WS Connection──► [FastAPI /classroom/ws/agent/{devA}]
                                                    │
                                           (Ingest Only Socket)
                                                    ▼
                                            [ClassroomWSHub]
                                                    │
                        ┌───────────────────────────┴───────────────────────────┐
                        │ Broadcast Only To                                      │
                        ▼                                                       ▼
            [Professor Dashboard A]                                 [Professor Dashboard B]
            (Authenticated as Professor)                            (Authenticated as Professor)
```

**Verification:**
1. Student agents connect to `/classroom/ws/agent/{device_id}`. This endpoint is **write-only / ingest-only**. The server accepts frames from the agent and immediately dispatches them to professor sessions via `hub.broadcast_frame(...)`. The agent socket **never receives** video frames from any other device.
2. The viewing WebSocket `/classroom/ws/{session_id}` requires a professor or admin JWT token. Students attempting to connect to `/classroom/ws/{session_id}` are rejected with WS code 4003 `UNAUTHORIZED_ROLE`.
3. **Outcome:** A student **cannot** subscribe to or view any other student's webcam or screen stream.

### B. Revoked Device Stream Termination
When an instructor revokes a device via `POST /classroom/devices/{device_id}/revoke`:
1. The database status is immediately set to `"revoked"`.
2. The backend actively executes `await classroom_hub.disconnect_agent(device_id, "Device revoked by instructor")`.
3. The WebSocket connection is severed with code 4003. Any subsequent frame packet received from that device is discarded.
4. **Outcome:** A revoked device **cannot** continue streaming.

---

## 3. Local Bridge Security & Network Confinement

### A. Loopback-Only Binding
- `student-agent/bridge.py` explicitly binds to `127.0.0.1` (IPv4 loopback) or `localhost`.
- Probing from adjacent LAN machines (e.g., `curl http://192.168.1.105:41732/health`) fails with `Connection Refused`. The local bridge is strictly inaccessible from other devices on the campus network.

### B. Shared Secret & Request Validation
- Communication between Electron, the browser extension, and the bridge is authenticated via a dynamic ephemeral token passed in the `X-Bridge-Token` header.
- Cross-Origin Resource Sharing (CORS) is restricted to `chrome-extension://` and `app://` origins.

---

## 4. Student Privacy & Data Minimization

ExamProctor is designed around data minimization and ethical surveillance constraints:

| Data Type | Collected? | Rationale & Protection |
| :--- | :---: | :--- |
| **Active Screen Frame** | YES | Necessary to confirm examination integrity; streamed to instructor and stored only as low-res thumbnail evidence if a violation occurs. |
| **Facial Landmark / Head Pose** | YES | Calculated on-device via MediaPipe. Only numeric angles (yaw, pitch) and violation triggers are transmitted. Raw video files are NOT uploaded. |
| **Browser Domain Navigation** | YES | Only domains visited during active exams are recorded (e.g., `chegg.com`). |
| **Passwords & Form Inputs** | **NO** | Manifest V3 extension explicitly lacks permissions to read input elements or form DOM contents. |
| **Keystroke Logging** | **NO** | No keylogger is installed. Keystroke dynamics are not recorded. |
| **Clipboard Contents** | **NO** | Clipboard buffers are never read or stored. Only copy/paste counter is recorded. |
| **Microphone Audio Stream** | **NO** | Ambient sound level (dB RMS) is calculated on client. Raw acoustic recordings are not uploaded or stored unless explicit audio flagging occurs. |

---

## 5. Authorization Lease Expiry & Monitoring Cessation

- All monitoring actions (screen capture, process listing, webcam sampling) require an active signed lease token (`POST /classroom/devices/lease`).
- The lease has an enforced time-to-live (`expires_at`), typically matching exam duration + 10 minutes grace period.
- Once the lease expires or is cancelled:
  1. The agent process shuts down capture loops.
  2. The frame grabber terminates.
  3. All temporary JPEG snapshots in RAM and `%LOCALAPPDATA%\ExamProctor\scratch\` are securely wiped.
  4. Monitoring **cannot** continue after authorization expires.

---

## 6. Secrets Management & Code Audit

- **Frontend Code Inspection:** A comprehensive grep of `frontend/src` confirms zero hardcoded API keys, JWT signing secrets, database credentials, or private certificates.
- **Environment Configuration:** Sensitive secrets (`JWT_SECRET`, `POSTGRES_PASSWORD`, `DATABASE_URL`) are loaded strictly from `.env` on the backend server and excluded from source control via `.gitignore`.
- **Audit Logs:** All administrative actions (user creation, device approval, revocation, exam creation, command issuance) are immutably logged to the `audit_logs` table with actor ID, IP address, timestamp, and action description.

---

## Conclusion

The ExamProctor architecture satisfies rigorous educational security standards, preventing student privilege escalation, enforcing zero-trust feed isolation, and protecting student privacy through strict data minimization.
