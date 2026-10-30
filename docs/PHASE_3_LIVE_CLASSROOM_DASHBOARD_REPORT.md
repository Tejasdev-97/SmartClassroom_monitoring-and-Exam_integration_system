# Phase 3 & 7 Live Classroom Monitoring Dashboard Report

**Project:** Smart Classroom Monitoring and Examination Integrity System  
**Repository:** `D:\ExamProctor-SecondRound`  
**Date:** October 30, 2026  
**Status:** IMPLEMENTED & INTEGRATION TESTED  

---

## Executive Summary

This report documents the completion of the Professor Real-Time Classroom Monitoring Dashboard (`ClassroomDashboard.jsx` and `ClassroomDashboard.module.css`). Built to mirror a state-of-the-art CCTV security operations center, the dashboard enables continuous simultaneous visual surveillance, live telemetry ingestion, and rapid interventions across dozens of concurrent student examination workstations.

---

## 1. Student CCTV Card Specification

Every monitored student workstation is represented by an active `StudentCctvCard` displaying real-time telemetry:

```
+-------------------------------------------------------------------------+
| [● ONLINE] Student: Alice Smith (CS-101)                 [⚠️ 2 Warnings] |
+----------------------------------------------------+--------------------+
|                                                    |   WEBCAM PREVIEW   |
|                                                    |     [320 x 240]    |
|              LIVE SCREEN STREAM                    |   (Click to Zoom)  |
|                 [1280 x 720]                       |                    |
|                                                    | [● Face In Frame]  |
|                                                    +--------------------+
|                                                    | [🔍 Maximize Screen]|
+----------------------------------------------------+--------------------+
| Device: DEV-LAPTOP-01 | Agent: v1.4.0 (Active) | Exam: Attempt #1 In-Prog|
| Last Frame: 0.3s ago  | Last Event: Gaze Aversion (Low, 2m ago)         |
+-------------------------------------------------------------------------+
```

### Specific Display Elements:
1. **Student Identity:** Full name, roll number/email, and student UUID.
2. **Dual Stream Previews:**
   - **Screen Preview:** Continuous rendering of desktop framebuffer captures received from the Python Agent.
   - **Webcam Preview:** Real-time facial monitoring stream received from the client-side proctoring engine.
3. **Status Badges:**
   - **Connection Status:** `Online` (green pulse), `Offline` (gray), or `Reconnecting` (amber pulse).
   - **Agent Status:** `Active` (green) or `Unresponsive` (red).
   - **Camera Status:** `Active` (green), `Occluded` (red), or `Multiple Faces` (red badge).
   - **Examination Status:** `In Progress` (blue), `Paused` (yellow), or `Submitted` (green).
4. **Warning Counters:** Display of cumulative instructor-confirmed warnings, visually separated from raw heuristic algorithm event counts.
5. **Frame Timestamps:** Time elapsed since last received frame (e.g., `0.4s ago` vs `Stale: 14s ago`).
6. **Last Detected Event:** Recent violation type, timestamp, and severity indicator.

---

## 2. Multi-Grid Matrix Layout Controls

The CCTV grid provides dynamic column layouts to support different class sizes and monitor aspect ratios:

| Layout Option | CSS Grid Definition | Recommended Use Case |
| :---: | :---: | :--- |
| **2x2** | `repeat(2, minmax(0, 1fr))` | Small seminars or high-detail observation (1–4 students) |
| **3x3** | `repeat(3, minmax(0, 1fr))` | Standard lab room (5–9 students) |
| **4x4** | `repeat(4, minmax(0, 1fr))` | Standard classroom cohort (10–16 students) |
| **6x6** | `repeat(6, minmax(0, 1fr))` | Large lecture hall monitoring (17–36 students) |
| **Auto** | `repeat(auto-fill, minmax(360px, 1fr))` | Responsive fluid fitting based on window dimensions |

The layout selection is preserved in component state and immediately adapts without disrupting ongoing video packet decoding.

---

## 3. Independent Webcam & Screen Interaction

### A. Independent Webcam Enlargement (`EnlargedWebcamModal`)
- Clicking the webcam preview triggers `onEnlargeWebcam(e)`.
- **Event Propagation Protection:** The click handler explicitly calls `e.stopPropagation()`. This prevents the parent card click handler from accidentally triggering the full student detail modal.
- Opens a dedicated high-contrast dialog displaying the student's live webcam stream at 640x480 resolution, accompanied by facial landmark bounding boxes, head pose angles, and live eye gaze direction.

### B. Independent Screen Enlargement (`EnlargedScreenModal`)
- Clicking the "Maximize Screen" overlay button triggers `onEnlargeScreen(e)` with `e.stopPropagation()`.
- Renders the student's primary display at up to 1920x1080 resolution with a "Request Screen Refresh" quick-trigger button.

### C. Concurrency Guarantee
Selecting or enlarging an individual student's webcam or screen **does not pause or terminate** background WebSocket reception for other student cards. All other student cards continue decoding and rendering frames concurrently.

---

## 4. Student Deep-Inspection Modal (`SelectedStudentModal`)

Clicking the card body opens the comprehensive multi-tab inspector:

```
+-------------------------------------------------------------------------+
| [INSPECTOR] Student: Bob Jones (DEV-LAPTOP-02)              [X Close]   |
+-------------------------------------------------------------------------+
| [ Tab 1: Workstation Telemetry ] [ Tab 2: Timeline ] [ Tab 3: Evidence ]|
+-------------------------------------------------------------------------+
| [Larger Screen Stream: 960x540]          | [Webcam Stream: 320x240]     |
|                                          |                              |
| Telemetry Details:                       | Live Violation Score: 18%    |
| - IP: 192.168.1.102                      | Confirmed Warnings: 1        |
| - OS: Windows 11 Pro                     | Heuristic Events: 4          |
| - Active Process: Chrome (ExamProctor)   | Battery: 88% (AC Connected)  |
+------------------------------------------+------------------------------+
| Quick Actions:                                                          |
| [ Send Message ]  [ Issue Warning ]  [ Request Refresh ]  [ Enforce Focus ]|
| [ 🔒 Lock Desk ]  [ 🔓 Unlock Desk ] [ Restrict Apps ]    [ Restrict Web ]  |
+-------------------------------------------------------------------------+
```

### Tab Features:
1. **Workstation Telemetry:** Shows live CPU/memory load, active window title, network ping, and battery state.
2. **Event Timeline:** Displays chronological list of all detected proctoring anomalies, system messages, and instructor commands.
3. **Evidence & Snapshots:** Displays thumbnail grid of captured violation JPEG blobs. Clicking an evidence item displays the full-size image with confidence annotations.

---

## 5. Warning Management & Sorting Engine

### A. Severity Levels
- **Critical (Red):** Unauthorized secondary phone detected, unauthorized person substitution, external display attached.
- **High (Amber):** Prolonged gaze aversion (> 10s), multiple faces in frame, blacklisted application launched.
- **Medium (Yellow):** Window blur, focus lost, head turned away (> 3s).
- **Low (Blue):** Minor posture shift, momentary lighting fluctuation.
- **Informational (Gray):** Agent heartbeat, tab navigation within exam bounds.

### B. Dynamic Card Sorting
The dashboard provides four real-time sorting modes:
1. **Priority (Severity Score):** Students with critical alerts and unacknowledged violations appear first.
2. **Alphabetical:** Sorted by student name (A–Z).
3. **Join Time:** Earliest joined student workstations appear first.
4. **Latest Activity:** Students with the most recent telemetry or frame activity float to the top.

### C. Heuristic vs Confirmed Violation Distinction
- **Detected Events (Heuristic):** Automated computer vision outputs (e.g., candidate phone detection). Stored as alerts; displayed as yellow/amber indicators.
- **Confirmed Violations (Instructor):** Only incremented when the professor explicitly issues a formal warning (`send_warning`) or flags the event in the audit tab.

---

## Conclusion

The Live Classroom Dashboard provides an enterprise-grade proctoring operations matrix that blends high-performance video streaming with granular student management, robust event sorting, and reliable workstation control.
