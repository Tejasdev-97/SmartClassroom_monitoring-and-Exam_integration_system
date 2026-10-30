# Four-Laptop Setup Guide

> **Smart Classroom Monitoring and Examination Integrity System**  
> Target: 4 Windows 10/11 laptops on the same Wi-Fi or Ethernet LAN

---

## Hardware Layout

| Laptop | Role | What runs |
|--------|------|-----------|
| **Laptop 1** (Instructor) | Server + Dashboard | FastAPI backend · React frontend · SQLite classroom DB |
| **Laptop 2** | Student 1 | Electron exam app · Python student agent |
| **Laptop 3** | Student 2 | Electron exam app · Python student agent |
| **Laptop 4** | Student 3 | Electron exam app · Python student agent |

---

## Prerequisites (All Laptops)

1. Windows 10 / 11  
2. Python 3.11 or 3.12 (python.org installer — add to PATH)  
3. Node.js 20 LTS (nodejs.org)  
4. Git (git-scm.com)

### Instructor Laptop Only

5. PostgreSQL 15+ running locally, or a reachable PostgreSQL server  
6. Clone the repository:
   ```powershell
   git clone https://github.com/Tejasdev-97/SmartClassroom_monitoring-and-Exam_integration_system.git
   cd SmartClassroom_monitoring-and-Exam_integration_system
   ```

### Student Laptops Only

7. Copy only the `student-agent/` folder and `desktop-app/` folder from the repository (or clone the full repo).

---

## Step 1 — Find the Instructor Laptop's LAN IP

On **Laptop 1**, open PowerShell:

```powershell
ipconfig
```

Look for the `IPv4 Address` under your active adapter (Wi-Fi or Ethernet). Example:

```
IPv4 Address. . . : 192.168.1.42
```

Write this down — all student laptops will use it.

---

## Step 2 — Configure Windows Firewall (Instructor Laptop)

Allow inbound traffic on ports 8000 (backend) and 5173 (Vite dev server) from the LAN:

```powershell
# Run as Administrator
New-NetFirewallRule -DisplayName "ExamProctor Backend" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
New-NetFirewallRule -DisplayName "ExamProctor Frontend" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow
```

> **Wi-Fi Client Isolation:** Some access points block traffic between wireless clients.  
> If student agents cannot reach the instructor laptop, either:  
> - Switch to an Ethernet switch for all laptops, or  
> - Disable AP client isolation in the router admin panel.

---

## Step 3 — Start the Backend (Instructor Laptop)

```powershell
cd backend

# First time only: create venv and install deps
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# Copy and fill environment file
copy .env.example .env
# Edit .env: set DATABASE_URL, SECRET_KEY, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD

# Apply database migrations
.venv\Scripts\alembic upgrade head

# Start the server (accessible on LAN)
.venv\Scripts\uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Verify: open `http://localhost:8000/api/docs` in the instructor browser — Swagger UI should appear.

---

## Step 4 — Start the Frontend (Instructor Laptop)

Open a **second** PowerShell window:

```powershell
cd frontend
npm install          # first time only
npm run dev -- --host 0.0.0.0
```

> `--host 0.0.0.0` makes the Vite dev server reachable from student laptops for testing.

Verify: open `http://localhost:5173` — the ExamProctor login page should appear.

---

## Step 5 — Set Up the Student Agent (Each Student Laptop)

On each student laptop (Laptops 2, 3, 4):

```powershell
cd student-agent

# Create virtual environment and install dependencies
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Set the server URL (replace with the instructor laptop's LAN IP from Step 1):

```powershell
$env:EP_SERVER_URL = "http://192.168.1.42:8000"
```

Or create a persistent config by running once:

```powershell
.venv\Scripts\python agent.py --server http://192.168.1.42:8000
```

The agent will write the URL to `agent_config.json` and remember it.

---

## Step 6 — Enroll Student Devices

On each student laptop, run the agent:

```powershell
.venv\Scripts\python agent.py
```

The agent will:
1. Register itself with the server (first run only)
2. Print `Waiting for instructor approval…`

On the **instructor laptop**, open `http://localhost:5173` → log in as professor → **Classroom → Manage Devices**.

You will see one pending device per student laptop. Click **✓ Approve** for each, enter:
- **Room Name**: e.g. `Lab 101`
- **Workstation Label**: e.g. `PC-01`, `PC-02`, `PC-03`

After approval, each agent will print `Device approved! Starting monitoring.`

---

## Step 7 — Create a Classroom Session

On the instructor dashboard:

1. Go to **Classroom** in the sidebar
2. Click **+ New Session**
3. Fill in Session Name (e.g. "CS301 Midterm")
4. Select the **Standard Exam Policy** (auto-seeded)
5. Click **Create Session**
6. In the session row, click **▶ Start**

---

## Step 8 — Assign Student Devices to the Session

In the **ClassroomDashboard** (click **Open Dashboard** next to the running session):

- The dashboard opens and shows an empty grid
- Student agents will automatically connect via WebSocket once the session starts
- If devices are not shown: click the **≡ Devices** button and assign approved devices manually

---

## Step 9 — Verify Screen Previews

On the **instructor dashboard**, each device card should show:
- A screen thumbnail that updates approximately every 5 seconds
- A green "online" status badge
- Last heartbeat timestamp

> **If no preview appears:**  
> - Check that the agent is running on the student laptop (`agent.py` output shows "Session assigned")  
> - Check firewall: `port 8000` must be reachable from the student laptop  
> - Verify `EP_SERVER_URL` uses the instructor's LAN IP (not localhost)

---

## Step 10 — Verify Webcam Status

> **Note:** Webcam frame relay to the instructor dashboard is not yet implemented in this version.  
> The existing MediaPipe/ONNX webcam proctoring (face/phone detection) continues to work on the student laptop.  
> Webcam relay is the primary remaining feature — see audit doc for implementation plan.

---

## Step 11 — Trigger a Test Event

On a student laptop, open a **prohibited application** (e.g. Notepad — if `notepad.exe` is in the default blocked-process list):

```
notepad
```

Within 5–10 seconds, the instructor dashboard should show:
- A **red alert badge** on that device's card
- An alert in the alert panel: "Prohibited application detected: notepad.exe"

> **To test without a real blocked app:** run the agent with a custom policy that flags `notepad.exe`.

---

## Step 12 — Install the Browser Extension (Optional)

On each student laptop, in Chrome or Edge:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `browser-extension/` from the repository

The extension icon appears in the toolbar. During an active session, it shows `ON` badge.

All browser navigation (domain + page title only) is reported to the agent bridge.

---

## Step 13 — Disconnect One Student (Offline Test)

On **Laptop 2**, disconnect from Wi-Fi (or run `netsh wlan disconnect`).

Observe:
- The instructor dashboard changes Laptop 2's status to **offline** (within ~30 s)
- The agent on Laptop 2 logs `WS disconnected — reconnecting in X.Xs`
- Events are saved to `student-agent/offline_events.db`

Reconnect Laptop 2:

```powershell
netsh wlan connect name="YourSSID"
```

Observe:
- Agent logs `Syncing N queued offline events…`
- Events appear in the instructor's alert list with correct original timestamps

---

## Step 14 — Send an Instructor Command

On the instructor dashboard:

1. Click a device card
2. Click **💬 Message**
3. Type a message (e.g. "30 minutes remaining")
4. Click **Send**

The agent on the student laptop receives the command via WebSocket and the Electron app can display it in the student UI.

---

## Step 15 — End the Session

On the instructor dashboard, click **⏹ End Session**.

Observe:
- All device statuses change to `offline`
- Agent on each student laptop logs `Session status: ended`
- The `_stop` event fires and monitoring halts
- The agent process exits cleanly

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Agent says "Could not register with server" | Check `EP_SERVER_URL` — must be instructor LAN IP, not localhost |
| Dashboard shows no devices after session start | Check Windows Firewall port 8000 on instructor laptop |
| Screen previews not updating | Verify mss is installed: `pip install mss pillow` in the agent venv |
| Port 41732 already in use | Run agent with `--bridge-port 41733` (or use Electron which auto-finds a free port) |
| Wi-Fi clients can't reach each other | Disable AP client isolation in router settings |
| Agent stuck "waiting for approval" | Check instructor dashboard — device must be approved before monitoring begins |
| IP address changed (DHCP) | Update `EP_SERVER_URL` on all student laptops; set a static IP on the instructor laptop |
| Laptop goes to sleep | Windows: disable sleep during exam — Settings → System → Power & Sleep → Never |
| Port 8000 blocked by antivirus | Add uvicorn.exe and python.exe to antivirus exclusions |

---

## Network Security Notes

- All LAN communication uses **plain HTTP/WebSocket** (no TLS) by default.
- For higher security in a real lab, generate a self-signed certificate with `mkcert`:
  ```powershell
  mkcert -install
  mkcert 192.168.1.42  # replace with actual instructor IP
  ```
  Then start uvicorn with `--ssl-keyfile` and `--ssl-certfile` flags and update student configs to use `https://`.
- The agent bridge (`127.0.0.1:41732`) is loopback-only and cannot be reached from the network.
- Device secrets are bcrypt-hashed and never stored in plaintext.

---

## Privilege Requirements

| Feature | Admin rights required? |
|---------|----------------------|
| Installing Python, Node.js | Yes (one-time install) |
| Running the agent `agent.py` | No — standard user |
| Configuring Windows Firewall | Yes — use PowerShell as Administrator |
| Installing browser extension | No — developer mode in browser |
| Running the Electron exam app | No — standard user |
