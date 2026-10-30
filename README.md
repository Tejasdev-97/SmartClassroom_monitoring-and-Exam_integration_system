# ExamProctor.ai

### Smart Classroom Monitoring & Examination Integrity System

ExamProctor.ai is a centralized examination management and smart classroom monitoring platform engineered for academic integrity, resilience, and student privacy. The system combines browser- and desktop-based assessments, local-first computer vision, real-time instructor surveillance, durable evidence capture, and offline examination continuity.

The goal is to **empower instructors to monitor authorized examination sessions from a centralized dashboard while ensuring students can complete exams through network interruptions without loss of work, supported by evidence-based review and transparent privacy safeguards.**

> **Academic integrity notice:** Automated computer-vision detections and monitoring indicators are signals for human evaluation, not proof of misconduct. Authorized educators and proctors must review contextual evidence and examine situational factors before making academic integrity determinations.

---

## 🏗️ System Architecture

ExamProctor.ai is composed of decoupled frontend, desktop, agent, and backend components communicating over secure REST, WebSockets, and local loopback bridges:

```mermaid
flowchart TD
    subgraph STUDENTS["Student Environment"]
        WEB["Website Student Client<br/>(React / Vite)"]
        ELECTRON["Student Desktop Application<br/>(Electron 34)"]
        AGENT["Student Monitoring Agent<br/>(Python Background Service)"]

        ELECTRON <-->|"Local Loopback Bridge<br/>(127.0.0.1:41732)"| AGENT
        WEB -.->|"Browser Inference<br/>(MediaPipe + ONNX)"| WEB
        ELECTRON -.->|"Native Screen & Cam Capture<br/>(desktopCapturer)"| ELECTRON
    end

    subgraph BACKEND["FastAPI Backend Services"]
        REST["REST API Router<br/>(/api/v1)"]
        AUTH["Auth & Permissions<br/>(JWT & Roles)"]
        EXAM_SVC["Exam & Attempt Engine<br/>(Lifecycle & Sync)"]
        HUB["Classroom Real-time Hub<br/>(WebSocket Manager)"]
        SIGNAL["WebRTC Signaling Relay<br/>(& ICE Server Config)"]
        STORAGE_SVC["Evidence Storage Service<br/>(S3 / Neon Adapter)"]

        REST --> AUTH
        REST --> EXAM_SVC
        REST --> STORAGE_SVC
    end

    subgraph SURVEILLANCE["Instructor & Administration"]
        PROF["Classroom Dashboard & Grid<br/>(Professor Portal)"]
        ADMIN["System Administration<br/>(User & Policy Controls)"]
    end

    subgraph PERSISTENCE["Durable Cloud Infrastructure"]
        POSTGRES[("Neon PostgreSQL<br/>Core DB & Metadata")]
        OBJECT_STORAGE[("Neon Object Storage<br/>(S3-Compatible Buckets)<br/>Screenshots & Video Clips")]
    end

    %% Client-Server Interconnections
    WEB -->|"HTTPS REST / Sync"| REST
    ELECTRON -->|"HTTPS REST / Sync"| REST
    PROF -->|"HTTPS REST & WSS"| REST
    ADMIN -->|"HTTPS REST"| REST

    AGENT -->|"WSS /classroom/agent/ws/{id}<br/>(Heartbeats & Commands)"| HUB
    PROF <-->|"WSS /classroom/ws/{session_id}<br/>(Live Grid & Alerts)"| HUB
    HUB <-->|"Signaling Relay<br/>(Offer / Answer / ICE)"| SIGNAL

    REST -->|"Async & Sync ORM"| POSTGRES
    STORAGE_SVC -->|"boto3 SDK (s3v4)"| OBJECT_STORAGE
```

### Media & Communication Pipeline
- **REST API (`/api/v1`)**: Handles user authentication, exam CRUD, attempt lifecycle, answer synchronization, policy management, and authenticated evidence download.
- **WebSocket Infrastructure**:
  - `/classroom/ws/{session_id}`: High-throughput channel for the Professor Dashboard delivering real-time student grid updates, proctoring alerts, and command acknowledgments.
  - `/classroom/agent/ws/{device_id}`: Dedicated authenticated duplex channel for the Python Student Agent handling status telemetry, instructor commands (`lock_screen`, `warn_student`, `terminate_exam`), and policy enforcement.
- **WebRTC Signaling**: Implemented in backend WebSocket hubs (`webrtc_offer`, `webrtc_answer`, `webrtc_ice_candidate`) and backed by `GET /api/v1/classroom/webrtc/config` to supply STUN/TURN ICE infrastructure.
  > *Note on Media Delivery:* WebRTC signaling and ICE configuration are fully implemented on the backend; full end-to-end peer-to-peer audio/video streaming is dependent upon network firewall topology and STUN/TURN relay availability.

---

## ✨ Key Features

### 1. Smart Classroom Monitoring
- **Centralized Professor Dashboard**: Live multi-student grid cards displaying real-time connectivity, active attempt status, warning tallies, and focus state.
- **Focused Student Surveillance**: Detailed view inspecting student telemetry, recent proctoring events, and desktop focus loss.
- **Instructor Remote Controls**: Issue real-time commands to student devices (lock interface, send warnings, terminate session) with verified command delivery receipts.
- **Device & Session Association**: Dynamic pairing of approved student hardware (`device_id`) to active examination sessions with access policy enforcement.

### 2. AI-Assisted Proctoring Pipeline
- **Face Absence Detection**: Tracks sustained intervals where the student is absent from the camera field.
- **Multiple Face Detection**: Identifies unauthorized secondary individuals within the frame.
- **Head Pose Estimation**: 3D landmark analysis identifying prolonged gaze deviation away from the display.
- **Multi-Stage Phone Detection**:
  1. *Candidate Detection*: MediaPipe EfficientDet Lite0 scans for potential handheld devices.
  2. *Secondary Verification*: Cropped candidates are classified by a custom MobileNetV3 model in ONNX Runtime Web to distinguish real phones from calculators, empty cases, or paper cutouts.
- **Event Engine**: Evaluates temporal thresholds to confirm sustained infractions before dispatching alerts to the classroom hub and local bridge.

### 3. Student Desktop Application (Electron)
- **Kiosk & Fullscreen Enforcement**: Locks examination window into native fullscreen; intercepts and reports `blur` and focus loss.
- **Screen & Display Monitoring**: Utilizes native `desktopCapturer` to capture primary display thumbnails upon focus loss.
- **Automatic Agent Orchestration**: Transparently verifies, launches, and communicates with the Python Student Agent over a hardened localhost bridge (`127.0.0.1:41732`).
- **Pre-Exam Readiness Check**: Stepwise hardware verification of webcam, microphone, network speed, fullscreen lock, and agent responsiveness.

### 4. Background Student Agent (Python)
- **Local Loopback Bridge**: Hardened HTTP server listening strictly on `127.0.0.1`, enforcing origin checks and request body size caps.
- **Offline Authorization Leases**: Validates cryptographic Ed25519-signed authorization leases against a pinned public key, permitting continued authorized local monitoring without internet access.
- **Durable Event Outbox**: Offline SQLite queue (`offline_events.db`) guaranteeing zero data loss for AI proctoring events and activity telemetry across network disconnects.
- **System Monitoring**: Tracks unauthorized background processes and active window focus shifts.

### 5. Evidence & Storage Architecture
- **Warning-Triggered Video Evidence Clips**: Captures rolling buffer clips with pre-roll and post-roll context around confirmed infractions, uploaded with SHA-256 integrity checks.
- **Neon Object Storage Integration**: Direct S3-compatible cloud storage for screenshot JPEG images and WebM video clips with private bucket security and short-lived presigned URLs.
- **Comprehensive PDF Reports**: Generates downloadable, tamper-evident ReportLab PDF dossiers containing candidate info, event chronologies, and embedded evidence photos.

### 6. Local-First Offline Continuity
- **IndexedDB & Dexie.js Storage**: Exam packages and student responses persist locally in the client database.
- **Idempotent Synchronization**: Outbox queue buffers operations with UUIDs and sequence numbers, syncing automatically with PostgreSQL once connectivity resumes.

---

## 👥 User Roles & Access Control

| Role | Access Scope | Capabilities |
|---|---|---|
| **Student** | Web & Desktop Client | Access assigned exams, complete hardware readiness tests, answer questions with offline fallback, submit responses, view monitoring status HUD. |
| **Professor / Instructor** | Web Portal | Create and configure exams, launch classroom sessions, approve student devices, view live multi-card monitoring grid, issue live commands, review clips and snapshots, export PDF dossiers. |
| **Administrator** | Web Portal | Global system oversight, user lifecycle management (RBAC), security audit log review, classroom policy defaults, system configuration. |

---

## 🛠️ Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Web Frontend** | React 19, Vite, Vanilla CSS Modules | Responsive SPA portal for students, professors, and administrators |
| **Desktop Application** | Electron 34, Node.js | Kiosk lockdown, native fullscreen, screen capture |
| **Client Routing** | React Router v7 | Hash-based client routing compatible with file:// Electron schemas |
| **Client Storage** | IndexedDB, Dexie.js | Local-first answer and exam package persistence |
| **Computer Vision** | MediaPipe Tasks Vision (WASM) | In-browser face landmark and object candidate detection |
| **Deep Learning** | ONNX Runtime Web, MobileNetV3 | Client-side neural network phone classification |
| **Backend Framework** | Python 3.13, FastAPI, Uvicorn | High-performance asynchronous API, WebSockets, background tasks |
| **Database ORM** | SQLAlchemy 2.0, Alembic | Async relational data mapping and versioned database migrations |
| **Primary Database** | Neon PostgreSQL | Relational storage for users, exams, attempts, events, and evidence metadata |
| **Evidence Storage** | Neon Object Storage / S3-compatible | Secure object storage for screenshots and video clips via `boto3` |
| **Real-Time Layer** | WebSockets | Duplex communication for classroom grid, agent telemetry, and commands |
| **Media Signaling** | WebRTC (STUN / TURN ICE) | Standard signaling relay for prospective peer-to-peer media streams |
| **Security & Cryptography** | python-jose, cryptography (Ed25519), bcrypt | JWT authentication, signed offline leases, password hashing |
| **Report Generation** | ReportLab, OpenPyXL | Cryptographic PDF forensic dossiers and Excel exports |
| **Testing Frameworks** | Pytest, pytest-asyncio, Node.js Test Runner | Automated unit, regression, and integration testing |

---

## 📂 Repository Structure

```text
ExamProctor-SecondRound/
├── backend/                        # FastAPI application and services
│   ├── alembic/                    # Database migration scripts
│   ├── app/
│   │   ├── api/v1/                 # Core API endpoints (auth, exams, attempts, snapshots, reports)
│   │   ├── classroom/              # Smart Classroom subsystem
│   │   │   ├── api/                # Classroom REST (devices, sessions, policies, clips, lease) & WebSockets
│   │   │   ├── services/           # Grid service, alert engine, clip_storage adapter
│   │   │   ├── hub.py              # Real-time WebSocket connection hub & WebRTC signaling
│   │   │   ├── models.py           # Classroom ORM models
│   │   │   └── db.py               # Classroom engine (PostgreSQL / SQLite fallback)
│   │   ├── core/                   # Security, permissions, errors, config
│   │   ├── db/                     # Primary PostgreSQL models & async session
│   │   └── services/               # evidence_storage.py, s3_storage.py (Neon S3 client)
│   ├── tests/                      # Pytest suite (106 tests covering clips, S3, exams, auth)
│   ├── requirements.txt            # Python dependencies (includes boto3, fastapi, sqlalchemy)
│   └── .env.example                # Documented environment variables
├── frontend/                       # React 19 + Vite web client
│   ├── public/                     # Static models (ONNX, TFLite) and MediaPipe WASM binaries
│   ├── src/
│   │   ├── components/             # Reusable UI components & Layouts
│   │   ├── contexts/               # AuthContext, ToastContext
│   │   ├── pages/                  # Student, Professor, Admin, and Classroom views
│   │   ├── proctoring/             # useProctoring hook, vision engine, frame processors
│   │   └── services/               # api.js, classroomApi.js
│   ├── package.json                # Frontend dependencies & scripts
│   └── vercel.json                 # Vercel deployment and SPA rewrite rules
├── desktop-app/                    # Electron student desktop application
│   ├── assets/                     # Application icons and branding
│   ├── dist/                       # Packaged Windows binaries & NSIS installer
│   ├── main.js                     # Electron main process (kiosk, screen monitoring, agent spawn)
│   ├── preload.js                  # Context-isolated secure IPC bridge
│   └── package.json                # electron-builder packaging configuration
├── student-agent/                  # Background Python monitoring agent
│   ├── agent.py                    # Agent daemon, WS client, system monitors, command handler
│   ├── bridge.py                   # Hardened loopback HTTP bridge (127.0.0.1:41732)
│   ├── agent_lease.py              # Ed25519 offline signed lease verification
│   ├── clip_outbox.py              # Durable warning video clip upload outbox
│   ├── offline_queue.py            # SQLite offline event persistence
│   └── tests/                      # Unit tests for agent core mechanics (12 tests)
├── browser-extension/              # Chromium manifest v3 monitoring extension
├── docs/                           # Technical documentation and audit reports
├── render.yaml                     # Render Blueprint specification (backend + PostgreSQL)
└── vercel.json                     # Root Vercel deployment configuration
```

---

## 💻 Local Development Setup

### Prerequisites
- **Operating System:** Windows 10/11, macOS, or Linux
- **Node.js:** v18.x or v20.x+ & npm
- **Python:** v3.11, v3.12, or v3.13
- **Database:** Local PostgreSQL instance or a free [Neon](https://neon.tech) cloud database

---

### 1. Clone the Repository

```powershell
git clone https://github.com/Tejasdev-97/SmartClassroom_monitoring-and-Exam_integration_system.git
cd SmartClassroom_monitoring-and-Exam_integration_system
git checkout feature/classroom-monitoring
```

---

### 2. Configure & Run Backend

Open a PowerShell terminal:

```powershell
cd backend

# Create and activate Python virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Install dependencies (including boto3, FastAPI, SQLAlchemy)
python -m pip install --upgrade pip
pip install -r requirements.txt

# Configure environment
Copy-Item .env.example .env
```

Edit `backend/.env` with your database connection strings:
```ini
APP_ENV=development
SECRET_KEY=your-random-development-secret-key-at-least-32-characters
DATABASE_URL=postgresql+asyncpg://user:pass@host/dbname?ssl=require
SYNC_DATABASE_URL=postgresql+psycopg2://user:pass@host/dbname?sslmode=require
CLASSROOM_DATABASE_URL=postgresql+psycopg2://user:pass@host/dbname?sslmode=require
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000

# Optional: Neon Object Storage (leave local for local disk development)
SNAPSHOT_STORAGE_TYPE=local
CLIP_STORAGE_BACKEND=local
```

Run database migrations, seed initial admin, and launch:
```powershell
alembic upgrade head
python bootstrap.py
uvicorn app.main:app --reload --port 8000
```
Backend API will be live at: `http://localhost:8000` (API Docs: `http://localhost:8000/api/docs`).

---

### 3. Configure & Run Frontend

Open a second PowerShell terminal:

```powershell
cd frontend
npm install
npm run dev
```
Vite development server will be live at: `http://localhost:5173`.

---

### 4. Run Electron Desktop Application (Dev Mode)

To run the student examination desktop application in development mode with live reload:

```powershell
cd desktop-app
npm install
npm run dev
```

---

### 5. Run Python Student Agent Standalone (Optional)

In development, the Electron app automatically spawns the agent. If you wish to test or run the Student Agent independently:

```powershell
cd student-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python agent.py --server http://localhost:8000
```

---

## 📦 Windows Electron Installer Build

The production Windows desktop application is packaged using `electron-builder` with an NSIS installer target.

### Build Artifacts
- **Installer Executable:** `desktop-app/dist/ExamProctor AI Student Setup 1.0.0.exe` (~131.75 MB)
- **Unpacked Application:** `desktop-app/dist/win-unpacked/ExamProctor AI Student.exe`
- **Included Assets:** Bundled `student-agent/` in `resources/student-agent/`, full MediaPipe WASM binaries, and ONNX neural network weights inside `resources/app.asar`.

### How to Rebuild the Installer
```powershell
cd desktop-app
# Builds frontend assets with relative base paths and packages the NSIS executable
npm run dist
```
> *Distribution Note:* Due to its size (~132 MB), the generated `.exe` is ignored by Git and should be distributed via GitHub Releases or institutional software portals.

---

## ☁️ Deployment Guide

The application is architected for continuous multi-cloud deployment:

```
Vercel (React Frontend)  ──HTTPS/WSS──>  Render (FastAPI Web Service)
                                                │
                                    ┌───────────┴───────────┐
                                    ▼                       ▼
                         Neon PostgreSQL          Neon Object Storage
                         (Relational Data)        (S3-Compatible Evidence)
```

### 1. Backend on Render
- Use the included [`render.yaml`](file:///D:/ExamProctor-SecondRound/render.yaml) Blueprint or configure a Web Service:
  - **Build Command:** `cd backend && pip install --upgrade pip && pip install -r requirements.txt`
  - **Start Command:** `cd backend && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
  - **Health Check Path:** `/api/v1/health`
- **Key Environment Variables**:
  - `DATABASE_URL`: `postgresql+asyncpg://...` (Render or Neon async connection)
  - `SYNC_DATABASE_URL`: `postgresql+psycopg2://...` (Alembic sync connection)
  - `CLASSROOM_DATABASE_URL`: `postgresql+psycopg2://...`
  - `ALLOWED_ORIGINS`: Exact frontend URL (e.g. `https://your-examproctor.vercel.app`)
  - `SNAPSHOT_STORAGE_TYPE`: `neon` (or `s3`)
  - `CLIP_STORAGE_BACKEND`: `neon` (or `s3`)
  - `NEON_OBJECT_STORAGE_ENDPOINT`: S3 endpoint provided by Neon
  - `NEON_OBJECT_STORAGE_ACCESS_KEY_ID`: Storage Access Key ID
  - `NEON_OBJECT_STORAGE_SECRET_ACCESS_KEY`: Storage Secret Access Key

### 2. Frontend on Vercel
- Deploy from the root or `/frontend` directory using [`vercel.json`](file:///D:/ExamProctor-SecondRound/vercel.json):
  - **Framework:** `Vite`
  - **Build Command:** `npm --prefix frontend install && npm --prefix frontend run build`
  - **Output Directory:** `frontend/dist`
  - **Environment Variable:** `VITE_API_BASE_URL=https://your-render-backend.onrender.com/api/v1`

*For complete step-by-step production instructions, review [`docs/DEPLOYMENT_GUIDE.md`](file:///D:/ExamProctor-SecondRound/docs/DEPLOYMENT_GUIDE.md).*

---

## 🧪 Testing & Quality Assurance

The codebase maintains automated test coverage across backend routers, evidence services, storage adapters, and agent mechanics:

### Run Backend Test Suite (106 Tests)
```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest tests/ -v
```
- **Total Backend Tests:** `106 passed`
  - Core authentication, exam lifecycle, and grading: `69 passed`
  - Video analysis & ReportLab PDF rendering: `6 passed`
  - Warning video clips, WebRTC config & signaling isolation: `7 passed`
  - Durable evidence storage & checksum verification: `16 passed`
  - Neon Object Storage S3 adapter & presigned URLs: `8 passed`

### Run Student Agent Test Suite (12 Tests)
```powershell
python -m pytest student-agent/tests/test_agent_core.py -v
```
- **Total Agent Tests:** `12 passed`
  - Ed25519 authorization lease verification & expiry rejection: `5 passed`
  - Durable offline queue persistence & restart survival: `1 passed`
  - Clip outbox idempotency & storage quota enforcement: `2 passed`
  - Loopback bridge origin restriction & token security: `4 passed`

> *Testing Status:* All 118 automated software tests pass cleanly. Physical multi-device classroom verification (e.g., multi-laptop Wi-Fi load tests and external TURN relay traversal across restricted corporate firewalls) remains scheduled for staged field trials.

---

## 🔒 Security, Privacy & Compliance Safeguards

- **Strict Cryptographic Leases**: Student Agents require valid Ed25519 signatures from the backend to activate monitoring capabilities, preventing unauthorized local monitoring activation.
- **Loopback Bridge Isolation**: Agent bridge binds strictly to `127.0.0.1` and inspects `Origin` headers, blocking malicious web scripts from accessing agent APIs or exfiltrating device secrets.
- **Private Object Storage**: Evidence buckets disallow public access; assets are accessed strictly via 5-minute presigned URLs or authenticated backend proxies.
- **Transparent Proctoring HUD**: Students are always informed when camera, screen, or proctoring services are active via an on-screen status banner.
- **Data Minimization**: Media processing occurs locally; raw continuous video streams are not recorded or transmitted, and short video clips are captured only when verified policy warnings trigger.

---

## 📄 License & Attribution

ExamProctor.ai is developed for academic integrity and examination monitoring.

**Attributions:**
- Built using [React](https://react.dev/), [Vite](https://vite.dev/), and [Electron](https://www.electronjs.org/).
- Computer vision powered by [Google MediaPipe](https://developers.google.com/mediapipe) and [ONNX Runtime](https://onnxruntime.ai/).
- Backend built with [FastAPI](https://fastapi.tiangolo.com/), [SQLAlchemy](https://www.sqlalchemy.org/), and [ReportLab](https://www.reportlab.com/).
- Cloud infrastructure supported by [Neon](https://neon.tech) and [Render](https://render.com).