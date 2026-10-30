# Four-Laptop Physical Integration Test Guide & Runbook

**Project:** Smart Classroom Monitoring and Examination Integrity System  
**Repository:** `D:\ExamProctor-SecondRound`  
**Date:** October 30, 2026  
**Status:** IMPLEMENTED & DOCUMENTED (Physical multi-hardware execution: `NOT VERIFIED`)  

---

## Executive Summary

This document provides the complete, step-by-step runbook for physically executing the 4-laptop demonstration. It outlines network topography, environment setup, execution commands, and the 17-step physical integration test protocol.

> [!IMPORTANT]
> In accordance with project instructions, because this test requires 4 physically separate hardware machines on a shared local network, its status is marked **NOT VERIFIED** until physical hardware execution is completed. All software logic, endpoints, and scripts are **IMPLEMENTED** and **INTEGRATION TESTED**.

---

## 1. Physical Hardware & Network Layout

```
                        +---------------------------------------+
                        |  Classroom Wi-Fi Router / AP          |
                        |  SSID: ExamProctor_LAN                |
                        |  AP Client Isolation: DISABLED        |
                        +-------------------+-------------------+
                                            |
        +-------------------+---------------+-------------------+-------------------+
        |                   |                                   |                   |
        ▼                   ▼                                   ▼                   ▼
+---------------+   +---------------+                   +---------------+   +---------------+
|   LAPTOP 1    |   |   LAPTOP 2    |                   |   LAPTOP 3    |   |   LAPTOP 4    |
|  Instructor   |   |   Student 1   |                   |   Student 2   |   |   Student 3   |
| 192.168.1.100 |   | 192.168.1.101 |                   | 192.168.1.102 |   | 192.168.1.103 |
+---------------+   +---------------+                   +---------------+   +---------------+
```

---

## 2. Laptop-by-Laptop Setup Procedures

### Laptop 1: Instructor Station (Server & Dashboard)
1. **Network Configuration:** Connect to `ExamProctor_LAN`. Note local IPv4 address (e.g., `192.168.1.100`).
2. **Open Firewall Port 8000:**
   ```powershell
   # Run in PowerShell as Administrator:
   New-NetFirewallRule -DisplayName "ExamProctor 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
   ```
3. **Start PostgreSQL Database & Backend Server:**
   ```powershell
   cd D:\ExamProctor-SecondRound\backend
   .\.venv\Scripts\Activate.ps1
   uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```
4. **Start Frontend Web Dashboard:**
   ```powershell
   cd D:\ExamProctor-SecondRound\frontend
   npm run dev -- --host 0.0.0.0 --port 5173
   ```
5. **Open Browser:** Navigate to `http://localhost:5173` and log in with professor credentials (`professor@examproctor.ai`).

---

### Laptops 2, 3, and 4: Student Workstations
Perform these steps on each student laptop:

1. **Network Configuration:** Connect to `ExamProctor_LAN`. Ensure `ping 192.168.1.100` succeeds.
2. **Set Backend URL Environment / Config:**
   Open `%LOCALAPPDATA%\ExamProctor\config.json` or `.env`:
   ```json
   {
     "BACKEND_API_URL": "http://192.168.1.100:8000",
     "BACKEND_WS_URL": "ws://192.168.1.100:8000"
   }
   ```
3. **Launch Student Application:**
   Run the ExamProctor desktop app (or browser pointing to `http://192.168.1.100:5173`).
4. **Log in:**
   - Laptop 2: `student1@examproctor.ai`
   - Laptop 3: `student2@examproctor.ai`
   - Laptop 4: `student3@examproctor.ai`

---

## 3. The 17-Step Physical Integration Protocol

Follow these exact steps during the live physical demonstration:

| Step # | Action | Expected Physical Result | Verification Check |
| :---: | :--- | :--- | :--- |
| **1** | Instructor creates classroom session on Laptop 1 and clicks "Start Monitoring". | Session status transitions to `active`. CCTV matrix displays empty waiting grid. | Status indicator turns GREEN. |
| **2** | Student 1 (Laptop 2) selects authorized exam and begins readiness check. | Camera, microphone, and screen readiness green checks appear. | Readiness cards show OK. |
| **3** | Student 1 clicks "Enter Examination". | Electron automatically launches Student Agent in background. Bridge `/health` returns 200 OK. | Agent process visible in Task Manager. |
| **4** | Student 1 connects to classroom. | Student 1 CCTV card appears in Laptop 1 dashboard. | Card appears with `DEV-LAPTOP-01`. |
| **5** | Stream verification for Student 1. | Real live screen and live webcam frames render inside Student 1 card. | Move mouse on Laptop 2; movement appears on Laptop 1. |
| **6** | Student 2 (Laptop 3) begins exam and joins session. | Student 2 card appears next to Student 1 in 2x2 layout. | Dual feeds render side-by-side. |
| **7** | Student 3 (Laptop 4) begins exam and joins session. | Student 3 card appears. Grid updates to 3 cards. | All 3 student identities displayed. |
| **8** | Simultaneous multi-feed check. | All three screens and webcams update simultaneously without stutter. | Total inbound bandwidth ~680 kbps. |
| **9** | Disconnect Student 2: Turn off Wi-Fi on Laptop 3. | Student 2 card marks as `Offline` with last frame timestamp. | Amber / gray disconnect badge appears. |
| **10** | Verify other students during outage. | Student 1 and Student 3 feeds continue updating smoothly in real-time. | Zero disruption to Laptops 2 and 4. |
| **11** | Reconnect Student 2: Re-enable Wi-Fi on Laptop 3. | Agent reconnects with exponential backoff. Status flips back to `Online`. | Reconnects in < 3.5 seconds. |
| **12** | Deduplication check. | Student 2 feed resumes in existing card; NO duplicate card is created. | Card count remains exactly 3. |
| **13** | AI Event Trigger: Student 1 picks up a physical phone. | Candidate phone detection triggers in `cvEventEngine.js`. | Red "Unauthorized Device" badge flashes on Laptop 1. |
| **14** | Instructor Intervention: Instructor clicks "Send Warning" to Student 1. | Dialog appears on Student 1 screen; warning counter on Laptop 1 increments to 1. | Student 1 acknowledges message. |
| **15** | Student 1 submits examination. | Student 1 card updates to `Submitted`. Agent streaming stops immediately. | Webcam indicator turns OFF. |
| **16** | Instructor ends classroom session. | Laptop 1 clicks "End Session". Broadcasts `session_ended`. Agents on Laptops 3 & 4 terminate cleanly. | Student agents disarm and exit. |
| **17** | Stale frame verification. | Disconnected or ended feeds show gray offline state; no stale frame is masked as live. | Live clock indicator halts. |

---

## 4. Troubleshooting & On-Site Diagnostics

| Symptom | Probable Cause | Immediate Remediation |
| :--- | :--- | :--- |
| **Student cannot reach backend (Connection refused)** | Laptop 1 IP changed or Windows Firewall blocking TCP 8000. | Check `ipconfig` on Laptop 1; re-run `New-NetFirewallRule` for port 8000. |
| **Agent fails to launch on student laptop** | Port 41732 conflict or missing Python dependencies. | Check Electron console logs; bridge automatically steps to 41733. |
| **Webcam preview black / missing** | Another app (Zoom, Teams, Camera) holding exclusive camera handle. | Close conflicting apps and refresh readiness page. |
| **Student feeds freeze simultaneously** | Wi-Fi router saturated or AP isolation enabled. | Ensure router supports 802.11ac/ax and AP isolation is toggled OFF. |

---

## Conclusion

This protocol provides the deterministic roadmap to demonstrate end-to-end multi-student classroom integrity and real-time monitoring on physical hardware.
