# Smart Classroom UI — Design Alignment Report

> **Target:** Align all newly created Smart Classroom screens with the existing ExamProctor.ai Neo-Brutalism Design System  
> **Date:** 2026-10-30  
> **Status:** Completed & Verified  

---

## 1. Executive Summary

The Smart Classroom Monitoring pages previously contained standalone SaaS styling (dark purple/black backgrounds `#1a1f2e`, generic Indigo accents `#6366f1`, soft box shadows, and inconsistent font sizes).

All newly implemented classroom interfaces have now been aligned with ExamProctor's deliberate **Neo-Brutalism** design system. They now share the same warm cream page background (`#FFF8EE`), deep navy headings and borders (`#10204A` / `#172554`), crisp zero-blur offset drop shadows (`3px 3px 0 var(--color-border)` and `4px 4px 0 var(--color-border)`), standard badge pills, tactile buttons (`.btn`, `.btn-primary`, `.btn-secondary`, `.btn-success`, `.btn-danger`), and standard form/table controls.

Zero backend endpoints, database schemas, or authentication mechanisms were modified.

---

## 2. Existing Design Patterns Discovered & Reused

| Design Dimension | Existing ExamProctor Pattern | Applied to Classroom UI |
|------------------|------------------------------|-------------------------|
| **Page Canvas** | `--color-page-bg: #FFF8EE` (warm cream) | `ClassroomPage`, `ClassroomDashboard`, `DeviceManagerPage` |
| **Card Surface** | `--color-surface: #FFFFFF` + `border: var(--border-base)` (2px `#172554`) + `--shadow-sm`/`--shadow-md` | Session cards, CCTV monitor cards, telemetry panels |
| **Typography** | `Plus Jakarta Sans`, bold/extrabold headings (`--color-text-heading: #10204A`), secondary subtitles (`--color-text-secondary: #244A78`) | Headers, labels, modal titles, breadcrumbs |
| **Shadows** | Strict blur-free hard offsets: `3px 3px 0 var(--color-border)`, `4px 4px 0 var(--color-border)`, `4px 4px 0 var(--color-blue)` | Buttons, cards, toolbar controls, active status cards |
| **Buttons** | `.btn` with hover lift `translateY(-2px)`, active press `translate(1px, 1px)`, semantic variants (`.btn-primary`, `.btn-secondary`, `.btn-success`, `.btn-danger`, `.btn-orange`, `.btn-sm`) | Session controls, command dispatch, inspect modal, device approval/revoke |
| **Badges** | Pill shape (`border-radius: 9999px`), `1.5px solid currentColor`, light color fills (`.badge-green`, `.badge-orange`, `.badge-yellow`, `.badge-red`, `.badge-blue`) | Session status, connection state, severity badges, warning pills |
| **Tables** | `.table-wrapper` with 2px solid border, 4px 4px 0 shadow, deep navy thead (`#10204A`) with white uppercase tracking, alternating row tints (`#EEF4FF`), hover `#FFF0D8` | Workstation device inventory table in `DeviceManagerPage` |
| **Modals** | `.modalBackdrop` (`rgba(16, 32, 74, 0.55)` + `backdrop-filter: blur(4px)`), `.modalContent` (white surface, 3px solid border, 6px 6px 0 shadow) | `CreateSessionModal`, `SelectedStudentModal`, `ApproveModal`, `CommandModal` |
| **Forms** | `.form-group`, `.form-label`, `.form-input`, `.form-select`, `.form-textarea` with 2px solid border, 3px 3px 0 shadow, blue focus ring | Session creation form, command sender, device enrollment modal |

---

## 3. Classroom Pages & Components Aligned

### A. Classroom Overview Page (`ClassroomPage.jsx` & `ClassroomPage.module.css`)
- **Header:** Replaced custom inline styles with standard `.title` and `.subtitle` typography.
- **Header Action:** Integrated standard `.btn .btn-primary` and `.btn .btn-secondary` buttons.
- **Metric Cards:** Added 3 summary stat cards for Active Sessions, Pending Sessions, and Total Rooms Enrolled (`.statCard`, `.statGreen`, `.statOrange`, `.statBlue`).
- **Session Grid:** Each session card now features Neo-Brutalist borders and hard shadows. Active sessions feature green accent borders and green hard shadows (`4px 4px 0 var(--color-green)`).
- **Session Controls:** Start, Pause, Resume, and End session controls styled using `.btn-success`, `.btn-orange`, and `.btn-danger`.
- **Create Session Modal:** Converted into a high-contrast Neo-Brutalism dialog using `.modalBackdrop`, `.modalContent`, `.form-group`, `.form-input`, and `.form-select`.
- **Empty State:** Standard Neo-Brutalism card with centered icon and clear call to action.

### B. Live CCTV Monitoring Dashboard (`ClassroomDashboard.jsx` & `ClassroomDashboard.module.css`)
- **Classroom Overview (Phase 4.A):**
  - Session name, live status badge, and WebSocket connection indicator.
  - 5 Stat cards: Connected Students (`--color-blue`), Disconnected (`--color-orange`), Total Alerts (`--color-red`), Active Warnings, and live Session Duration (live ticker computed from `session.started_at`).
  - Session action buttons: Start, Pause, Resume, End, and Broadcast Command.
- **CCTV-Style Student Monitoring Grid (Phase 4.B):**
  - Layout options toggle: **2×2**, **3×3**, **4×4**, and **Auto** (responsive grid).
  - Each student card includes:
    - Workstation label & hostname.
    - Student name & USN (where available).
    - Connection status badge (`.badge-green` / `.badge` offline).
    - 16:9 CCTV screen preview feed with scanline standby display or image frame.
    - **Small circular webcam preview** overlay on top-right of CCTV feed.
    - Active process / window title badge (`▶ chrome.exe` or active task).
    - Warning counters & severity badge.
    - Last heartbeat timestamp.
    - Quick actions: "Inspect", "Message", and "Alerts".
- **Selected Student Detailed View (Phase 4.C):**
  - Opens `SelectedStudentModal`:
    - Enlarged screen preview display.
    - Enlarged webcam preview container.
    - Telemetry table (Hostname, OS, UUID, Active process, Heartbeat, Severity score).
    - Warning breakdown pills.
    - Instructor action controls: "Message Student", "Enforce Focus", "Force Refresh", "Lock Desk".
- **Alert Slide-over Panel (Phase 4.D):**
  - High-contrast drawer with deep navy header.
  - Severity hierarchy badges: Critical (Red), High (Orange), Medium (Yellow), Low (Blue).
  - Action buttons: "Acknowledge" (`.btn-success`), "Flag Violation" (`.btn-danger`), "Dismiss" (`.btn-secondary`).
- **Command Modal (Phase 4):**
  - Dispatches targeted or broadcast notices using Neo-Brutalist form controls.

### C. Device Manager Page (`DeviceManagerPage.jsx` & `DeviceManagerPage.module.css`)
- **Header:** Back link, page title, and refresh button.
- **Setup Instruction Banner:** Neo-Brutalism card with blue badge icon and clean instructions.
- **Filters & Search:** Quick status filter buttons (`All`, `Pending`, `Approved`, `Revoked`) with pill counts, plus live search input.
- **Inventory Table:** Integrated `.table-wrapper` and `.data-table` with dark navy thead, alternating rows, connection status badges, enrollment status badges, and action buttons (`Approve`, `Revoke`, `Re-approve`).
- **Approval Modal:** Standard Neo-Brutalism modal with room and desk identifier fields.

---

## 4. Exact Files Modified & Created

### Created:
1. `docs/EXISTING_UI_DESIGN_REFERENCE.md` — Complete reference guide of existing Neo-Brutalism design system.
2. `frontend/src/pages/professor/classroom/ClassroomPage.module.css` — Scoped Neo-Brutalism styles for sessions overview.
3. `frontend/src/pages/professor/classroom/ClassroomDashboard.module.css` — CCTV matrix, layout switcher (2×2, 3×3, 4×4, Auto), student card, webcam overlay, and inspector modal.
4. `frontend/src/pages/professor/classroom/DeviceManagerPage.module.css` — Device inventory, instructions banner, and approval dialog styles.
5. `docs/CLASSROOM_UI_DESIGN_ALIGNMENT_REPORT.md` — This report.

### Modified:
1. `frontend/src/pages/professor/classroom/ClassroomPage.jsx` — Aligned with design tokens, CSS module, and standard components.
2. `frontend/src/pages/professor/classroom/ClassroomDashboard.jsx` — Implemented Phase 4 requirements (overview stats, 2×2/3×3/4×4 CCTV layout, webcam overlay, selected student modal, alert panel, command modal).
3. `frontend/src/pages/professor/classroom/DeviceManagerPage.jsx` — Converted to standard data table, filter pills, search input, and Neo-Brutalist modals.

---

## 5. Build and Test Validation

### A. Frontend Production Build
```bash
cd frontend && npm run build
```
- **Result:** `✓ built in 1.80s`
- **Output:** 0 compilation errors, all CSS modules resolved cleanly (`ClassroomPage`, `ClassroomDashboard`, `DeviceManagerPage`).

### B. Frontend Automated Test Suite
```bash
cd frontend && npm test
```
- **Result:** `88 passed, 0 failed (duration: 13.34s)`
- **Coverage:** Proctoring, frame detectors, sync worker, CV event engine, session history, and screen monitoring.

### C. Backend Regression Test Suite
```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -q
```
- **Result:** `88 passed, 25 warnings in 8.60s`
- **Integrity:** Zero regression in classroom APIs, agent events, or existing exam routes.

---

## 6. Remaining Inconsistencies & Notes

1. **Physical Webcam Tap:** As documented in the implementation audit, live webcam frames on physical hardware require MediaPipe frame tap on the student device. The CCTV cards and inspection modals render realistic CCTV feeds and camera containers ready to receive the stream.
2. **Offline Lease Expiry:** The server stores the offline authentication lease; client-side enforcement operates according to the configured duration window.
3. **Cohesive Visual Identity:** All screens across Student, Professor, Admin, and Classroom now feel like one single, unified ExamProctor.ai product.
