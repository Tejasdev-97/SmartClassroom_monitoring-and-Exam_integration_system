# Smart Classroom Monitoring & Exam Integrity System
## Production Deployment Guide

This guide details deployment of the complete platform across Vercel (Frontend), Render (Backend + Database), and Object Storage.

---

## Architecture Overview

```
                                      ┌─────────────────────────────────────┐
                                      │         Vercel (Frontend)           │
                                      │  React 19 / Vite / PWA / WebRTC     │
                                      └──────────────────┬──────────────────┘
                                                         │ HTTPS & WSS
                                                         ▼
                                      ┌─────────────────────────────────────┐
                                      │          Render (Backend)           │
                                      │    FastAPI / Uvicorn (Port 8000)    │
                                      │  Classroom Hub & WebRTC Signaling   │
                                      └──────┬───────────┬───────────┬──────┘
                                             │           │           │
                    ┌────────────────────────┘           │           └────────────────────────┐
                    ▼                                    ▼                                    ▼
       ┌────────────────────────┐           ┌────────────────────────┐           ┌────────────────────────┐
       │   Render PostgreSQL    │           │ S3 / Cloudflare R2     │           │   Public / CoTurn      │
       │ Core Data + Classrooms │           │ Durable Evidence Clips │           │   STUN / TURN Relay    │
       └────────────────────────┘           └────────────────────────┘           └────────────────────────┘
```

---

## 1. Backend Deployment (Render)

### Option A: Render Blueprint (Recommended)
1. In your Render Dashboard, click **New +** -> **Blueprint**.
2. Connect repository: `https://github.com/Tejasdev-97/SmartClassroom_monitoring-and-Exam_integration_system.git`
3. Branch: `feature/classroom-monitoring` (or `main` once merged).
4. Render automatically parses [`render.yaml`](file:///D:/ExamProctor-SecondRound/render.yaml) and provisions:
   - Managed PostgreSQL database (`examproctor-postgres`)
   - Web Service (`examproctor-backend`) with Python 3.13 and auto-migrations (`alembic upgrade head`)

### Option B: Manual Web Service Setup
1. **New Web Service**:
   - Environment: `Python` (or `Docker` using `backend/Dockerfile`)
   - Build Command: `cd backend && pip install --upgrade pip && pip install -r requirements.txt`
   - Start Command: `cd backend && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - Health Check Path: `/api/v1/health`

2. **Required Environment Variables on Render**:
   | Variable | Value / Description |
   |---|---|
   | `APP_ENV` | `production` |
   | `SECRET_KEY` | Generate a strong 64-char random string |
   | `DATABASE_URL` | `postgresql+asyncpg://<user>:<pwd>@<host>/<dbname>` |
   | `SYNC_DATABASE_URL` | `postgresql+psycopg2://<user>:<pwd>@<host>/<dbname>` |
   | `CLASSROOM_DATABASE_URL` | Same as `SYNC_DATABASE_URL` (or dedicated classroom DB) |
   | `ALLOWED_ORIGINS` | `https://your-frontend.vercel.app,http://localhost:5173` |
   | `ACCESS_TOKEN_EXPIRE_MINUTES`| `60` |
   | `REFRESH_TOKEN_EXPIRE_DAYS` | `7` |
   | `SNAPSHOT_STORAGE_TYPE` | `local` (or `s3`) |
   | `CLIP_STORAGE_BACKEND` | `local` (or `s3`) |
   | `STUN_SERVER_URL` | `stun:stun.l.google.com:19302` |
   | `TURN_SERVER_URL` | (Optional) `turn:your-turn.org:3478?transport=udp` |
   | `TURN_USERNAME` | (Optional) TURN auth username |
   | `TURN_CREDENTIAL` | (Optional) TURN auth password |
   | `LEASE_SIGNING_KEY` | (Optional in dev, recommended in prod) Base64 Ed25519 private seed |
   | `BOOTSTRAP_ADMIN_EMAIL` | `admin@examproctor.ai` |
   | `BOOTSTRAP_ADMIN_PASSWORD` | Set your secure bootstrap password |

---

## 2. Frontend Deployment (Vercel)

### Deployment Steps
1. In Vercel, click **Add New** -> **Project**.
2. Import `https://github.com/Tejasdev-97/SmartClassroom_monitoring-and-Exam_integration_system.git`.
3. Settings:
   - **Framework Preset**: `Vite`
   - **Root Directory**: `frontend` (or project root, leveraging [`vercel.json`](file:///D:/ExamProctor-SecondRound/vercel.json))
   - **Build Command**: `vite build`
   - **Output Directory**: `dist`
4. **Environment Variables on Vercel**:
   | Variable | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `https://your-backend.onrender.com/api/v1` |

> [!NOTE]
> All routing rewrites and static asset exceptions for WASM (`ort-wasm*`, MediaPipe `vision_wasm*`) and models (`efficientdet_lite0.tflite`, `phone_classifier.onnx`) are preconfigured in [`vercel.json`](file:///D:/ExamProctor-SecondRound/vercel.json).

---

## 3. Evidence Storage (Neon Object Storage / S3-Compatible)

To ensure evidence durability across ephemeral container restarts, configure Neon Object Storage (or AWS S3 / Cloudflare R2 / MinIO):

### Neon Object Storage Setup
1. In your **Neon Console**, navigate to your project and enable **Object Storage**.
2. Note your S3-compatible API Endpoint (e.g. `https://<project-id>.s3.neon.tech`) and generate storage credentials (Access Key ID & Secret Access Key).
3. Create private buckets:
   - `examproctor-snapshots` (for student exam screen snapshots)
   - `examproctor-clips` (for classroom warning video clips)
4. Set the following environment variables on your Render backend:
   ```ini
   SNAPSHOT_STORAGE_TYPE=neon
   CLIP_STORAGE_BACKEND=neon
   NEON_OBJECT_STORAGE_ENDPOINT=https://<project-id>.s3.neon.tech
   NEON_OBJECT_STORAGE_ACCESS_KEY_ID=your_access_key_id
   NEON_OBJECT_STORAGE_SECRET_ACCESS_KEY=your_secret_access_key
   NEON_OBJECT_STORAGE_REGION=ap-southeast-1
   NEON_SNAPSHOT_BUCKET=examproctor-snapshots
   NEON_CLIP_BUCKET=examproctor-clips
   ```
   *(Standard AWS names `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT_URL`, and `AWS_REGION` are also fully supported as fallbacks).*

5. **Private Bucket Security**: All evidence objects remain strictly private. The backend issues short-lived presigned URLs (expires in 5 minutes) via `GET /api/v1/snapshots/{id}/url` and `GET /api/v1/classroom/clips/{id}/url` or streams them directly through authenticated endpoints after verifying professor/admin permissions. Credentials are never sent to the client.

---

## 4. Student Desktop Electron Application

The Windows student application can be built from source using:
```powershell
cd desktop-app
npm run dist
```
Generated installer:
- **Installer**: `desktop-app/dist/ExamProctor AI Student Setup 1.0.0.exe`
- **Architecture**: Windows x64 (NSIS standard installer with desktop & start-menu shortcuts)
- **Included Resources**: Bundled `student-agent` Python agent, MediaPipe WASM, and ONNX models.
