/**
 * ExamProctor.ai — Camera Readiness Check Page
 * Verifies webcam access and downloads the exam package before starting.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Camera, CheckCircle, XCircle, AlertTriangle, ArrowRight, RefreshCw, Maximize2, Monitor } from 'lucide-react';
import api from '../../services/api';
import { examPackageRepo, attemptRepo } from '../../storage/repositories';
import { useToast } from '../../contexts/ToastContext';
import styles from './ReadinessPage.module.css';

const CHECK_STATES = {
  pending:  { icon: null,          label: 'Checking…' },
  pass:     { icon: CheckCircle,   label: 'Ready',    color: 'var(--color-green)' },
  fail:     { icon: XCircle,       label: 'Failed',   color: 'var(--color-red)' },
  warning:  { icon: AlertTriangle, label: 'Warning',  color: 'var(--color-orange)' },
};

function CheckRow({ label, state, detail }) {
  const cfg = CHECK_STATES[state] || CHECK_STATES.pending;
  const Icon = cfg.icon;
  return (
    <div className={styles.checkRow}>
      <div className={styles.checkLabel}>{label}</div>
      <div className={styles.checkStatus} style={{ color: cfg.color }}>
        {!Icon
          ? <span className="spinner" style={{ width: 18, height: 18 }} />
          : <Icon size={18} strokeWidth={2.5} />}
        <span>{cfg.label}</span>
      </div>
      {detail && <div className={styles.checkDetail}>{detail}</div>}
    </div>
  );
}

const IS_ELECTRON = typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);

export default function ReadinessPage() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const agentBridgePortRef = useRef(41732);

  const [checks, setChecks] = useState(() => ({
    camera:   'pending',
    package:  'pending',
    storage:  'pending',
    ...(IS_ELECTRON ? { agent: 'pending' } : {}),
  }));
  const [details, setDetails] = useState({});
  const [canStart, setCanStart] = useState(false);
  const [starting, setStarting] = useState(false);
  const [attempt, setAttempt] = useState(null);

  const setCheck = useCallback((key, state, detail = null) => {
    setChecks((prev) => ({ ...prev, [key]: state }));
    if (detail) setDetails((prev) => ({ ...prev, [key]: detail }));
  }, []);

  // Run readiness checks
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Load attempt
      const localAttempt = await attemptRepo.get(attemptId);
      if (!cancelled) setAttempt(localAttempt);

      // 2. Camera check
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCheck('camera', 'pass', 'Webcam detected and accessible.');
      } catch (err) {
        setCheck('camera', 'fail', `Camera unavailable: ${err.message}`);
      }

      // 3. Exam package download
      try {
        // Check if already cached locally
        const cached = await examPackageRepo.get(attemptId);
        if (cached) {
          setCheck('package', 'pass', `Package cached (${cached.questions?.length || 0} questions).`);
        } else {
          const { data } = await api.get(
            `/exams/${localAttempt?.exam_id}/package?attempt_id=${attemptId}`
          );
          await examPackageRepo.save({ attempt_id: attemptId, ...data.data });
          setCheck('package', 'pass',
            `Downloaded ${data.data.questions?.length || 0} questions.`);
        }
      } catch (err) {
        setCheck('package', 'fail', 'Could not download exam package. Check your connection.');
      }

      // 4. Storage quota check
      try {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
          const { usage, quota } = await navigator.storage.estimate();
          const usedMB = Math.round(usage / 1024 / 1024);
          const quotaMB = Math.round(quota / 1024 / 1024);
          const pct = Math.round((usage / quota) * 100);
          if (pct > 90) {
            setCheck('storage', 'warning',
              `Storage ${pct}% used (${usedMB}/${quotaMB} MB). Consider freeing space.`);
          } else {
            setCheck('storage', 'pass', `${quotaMB - usedMB} MB available.`);
          }
        } else {
          setCheck('storage', 'pass', 'Storage API not available — proceeding anyway.');
        }
      } catch {
        setCheck('storage', 'warning', 'Could not estimate storage quota.');
      }
    })();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* noop */ }
        });
        streamRef.current = null;
      }
    };
  }, [attemptId, setCheck]);

  // Electron-only: check/launch the Python student agent
  useEffect(() => {
    if (!IS_ELECTRON) return;
    let cancelled = false;
    (async () => {
      try {
        // First check if already running
        const status = await window.electronAPI.agentStatus();
        if (cancelled) return;
        if (status?.ok) {
          if (status.bridge_port) agentBridgePortRef.current = status.bridge_port;
          setCheck('agent', 'pass', `Monitoring agent running on port ${status.bridge_port || agentBridgePortRef.current}.`);
          return;
        }
      } catch { /* agent not running yet */ }

      // Try to launch it
      setCheck('agent', 'pending', 'Launching monitoring agent…');
      try {
        const result = await window.electronAPI.agentLaunch({});
        if (cancelled) return;
        if (result?.ok) {
          if (result.port) agentBridgePortRef.current = result.port;
          // Brief wait for agent bridge to initialize
          await new Promise((r) => setTimeout(r, 1500));
          const status2 = await window.electronAPI.agentStatus().catch(() => null);
          if (status2?.ok) {
            setCheck('agent', 'pass', `Monitoring agent started on port ${result.port || agentBridgePortRef.current}.`);
          } else {
            setCheck('agent', 'warning', 'Agent started but bridge not responding yet. Exam will start anyway.');
          }
        } else {
          setCheck('agent', 'warning', `Monitoring agent could not start: ${result?.error || 'Unknown error'}. Exam can proceed without local monitoring.`);
        }
      } catch (err) {
        if (!cancelled) {
          setCheck('agent', 'warning', `Agent launch failed: ${err?.message || 'Unknown error'}. Exam can proceed without local monitoring.`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [setCheck]);

  // Determine if all critical checks pass
  useEffect(() => {
    const crit = ['camera', 'package'];
    const allDone = Object.values(checks).every((s) => s !== 'pending');
    const critPassed = crit.every((k) => checks[k] === 'pass');
    if (allDone && critPassed) setCanStart(true);
  }, [checks]);

  const [showConsentModal, setShowConsentModal] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [screenConsent, setScreenConsent] = useState(true);

  const handleStart = () => {
    setShowConsentModal(true);
    setFullscreenError('');
  };

  const handleCancelConsent = () => {
    setShowConsentModal(false);
    setStarting(false);
    setFullscreenError('');
  };

  const handleConfirmFullscreenAndStart = async () => {
    setStarting(true);
    setFullscreenError('');
    try {
      // 0. Persist screen monitoring consent and initialize session
      await attemptRepo.patch(attemptId, { screen_monitoring_consented: screenConsent });
      if (typeof window !== 'undefined' && window.electronAPI?.initScreenCaptureSession) {
        try {
          await window.electronAPI.initScreenCaptureSession({ attemptId, consented: screenConsent });
        } catch (initErr) {
          console.warn('[Screen Monitoring] Failed to initialize Electron capture session:', initErr);
        }
      }

      // 0b. Ensure student agent is running and register the attempt with the bridge
      if (IS_ELECTRON) {
        try {
          const isRunning = await window.electronAPI.agentIsRunning();
          if (!isRunning?.running) {
            const launchResult = await window.electronAPI.agentLaunch({});
            if (launchResult?.port) agentBridgePortRef.current = launchResult.port;
            // Wait briefly for bridge to initialize
            await new Promise((r) => setTimeout(r, 1200));
          } else if (isRunning?.port) {
            agentBridgePortRef.current = isRunning.port;
          }
          // Register attempt context with the bridge so the agent can auto-connect
          // session_id will be empty if no classroom session is assigned yet;
          // the agent will re-poll once it receives a session_id update.
          await window.electronAPI.agentSetSession({ sessionId: null, attemptId });
        } catch (agentErr) {
          // Non-blocking: exam proceeds even if agent registration fails
          console.warn('[Readiness] Agent session registration failed:', agentErr?.message);
        }
      }

      // 1. Request native fullscreen in Electron and verify
      if (typeof window !== 'undefined' && window.electronAPI?.setFullscreen) {
        await window.electronAPI.setFullscreen(true);
        const isFs = await window.electronAPI.getFullscreen();
        if (!isFs) {
          setFullscreenError('Fullscreen mode could not be confirmed. Please check permissions or display settings and try again.');
          setStarting(false);
          return;
        }
      } else if (document.documentElement?.requestFullscreen) {
        try {
          await document.documentElement.requestFullscreen();
        } catch (fsErr) {
          console.warn('Browser HTML5 fullscreen request:', fsErr);
        }
      }

      // 2. Start attempt on backend
      try {
        await api.post(`/attempts/${attemptId}/start`);
      } catch (err) {
        // Even if server call fails, allow local start (offline-first continuity)
        console.warn('Backend start returned error; continuing offline', err?.message);
      }

      // 3. Update local attempt status & navigate
      await attemptRepo.updateStatus(attemptId, 'in_progress');
      toast('Exam started. Good luck!', 'success');
      navigate(`/student/exam/${attemptId}`);
    } catch (err) {
      console.error('Failed to start examination:', err);
      setFullscreenError(err?.message || 'Failed to start examination. Please try again.');
      setStarting(false);
    }
  };

  const retryAll = () => {
    setChecks({ camera: 'pending', package: 'pending', storage: 'pending' });
    setDetails({});
    setCanStart(false);
    // Cleanup existing stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    // Re-run effect by forcing remount
    window.location.reload();
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* Left — video preview */}
        <div className={styles.cameraPanel}>
          <div className={styles.cameraBorder}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={styles.video}
            />
            {checks.camera !== 'pass' && (
              <div className={styles.cameraOverlay}>
                <Camera size={40} />
                <span>Camera preview will appear here</span>
              </div>
            )}
          </div>
          <p className={styles.cameraHint}>
            Position yourself so your face is clearly visible and centred.
          </p>
        </div>

        {/* Right — checks + actions */}
        <div className={styles.rightPanel}>
          <div className={styles.header}>
            <h1 className={styles.title}>Readiness Check</h1>
            {attempt && (
              <p className={styles.sub}>{attempt.exam_title || 'Examination'}</p>
            )}
          </div>

          <div className={styles.checklist}>
            <CheckRow
              label="Webcam access"
              state={checks.camera}
              detail={details.camera}
            />
            <CheckRow
              label="Exam package"
              state={checks.package}
              detail={details.package}
            />
            <CheckRow
              label="Local storage"
              state={checks.storage}
              detail={details.storage}
            />
          </div>

          {/* Exam Rules & Continuity Guidelines (Phase 10) */}
          <div
            style={{
              background: 'var(--color-surface)',
              border: 'var(--border-thin)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-4)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
              fontSize: 'var(--font-size-xs)',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-heading)' }}>
              Examination Instructions & Proctoring Rules
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
              <div style={{ background: 'var(--color-surface-alt)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ fontWeight: 700, color: 'var(--color-text-secondary)' }}>Duration: </span>
                <strong style={{ color: 'var(--color-text-heading)' }}>
                  {attempt?.duration_seconds ? `${Math.floor(attempt.duration_seconds / 60)} minutes` : 'Standard'}
                </strong>
              </div>
              <div style={{ background: 'var(--color-surface-alt)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ fontWeight: 700, color: 'var(--color-text-secondary)' }}>Questions: </span>
                <strong style={{ color: 'var(--color-text-heading)' }}>
                  {details.package ? details.package.replace(/Downloaded |Package cached \(|\) questions\./g, '') : 'Ready'}
                </strong>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', color: 'var(--color-text-main)' }}>
              <div>
                <strong>• Camera & Proctoring:</strong> Maintain clear face visibility. Algorithms observe candidate conditions (face absence, multiple faces, head turns, phone presence). Automated flags do not equal cheating; all events require human assessor review.
              </div>
              <div>
                <strong>• Fullscreen Requirement:</strong> The examination runs in fullscreen. Exiting fullscreen or switching applications will be logged as an observable proctoring event.
              </div>
              <div>
                <strong>• Offline Continuity:</strong> If your network disconnects, your examination continues locally. Answers are saved safely on your device and will synchronize automatically once reconnected. Do not panic or close the browser.
              </div>
              <div>
                <strong>• Submission:</strong> Once finished, click Submit Examination. Your answers will be saved locally first, then confirmed by the server.
              </div>
            </div>
          </div>

          {!canStart &&
            Object.values(checks).every((s) => s !== 'pending') && (
            <div className="alert alert-error">
              <XCircle size={16} />
              <span>
                One or more critical checks failed. Resolve the issues above
                before starting your examination.
              </span>
            </div>
          )}

          <div className={styles.actions}>
            <button
              className="btn btn-secondary"
              onClick={retryAll}
              id="btn-retry-checks"
            >
              <RefreshCw size={16} /> Retry checks
            </button>
            <button
              id="btn-start-exam"
              className="btn btn-primary btn-lg"
              disabled={!canStart || starting}
              onClick={handleStart}
            >
              {starting ? (
                <><span className="spinner" style={{ width: 18, height: 18 }} /> Starting…</>
              ) : (
                <>Start Examination <ArrowRight size={16} /></>
              )}
            </button>
          </div>

          <div className={styles.notice}>
            <AlertTriangle size={14} />
            <span>
              Your webcam feed will be monitored throughout the examination.
              This is an observational process — all events are reviewed by
              a human before any determination is made.
            </span>
          </div>
        </div>
      </div>

      {/* Fullscreen User Consent Modal */}
      {showConsentModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Maximize2 size={20} color="var(--color-blue)" />
                <h2 className="modal-title">Enter Fullscreen & Begin Exam</h2>
              </div>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--color-text-primary)', marginBottom: 'var(--space-3)', lineHeight: 1.5 }}>
                To ensure exam integrity, this examination requires <strong>fullscreen mode</strong>.
              </p>
              <div className="alert alert-warning" style={{ marginBottom: 'var(--space-3)' }}>
                <AlertTriangle size={16} />
                <span>
                  Once started, exiting fullscreen or switching applications will trigger a proctoring alert with a 5-second grace window to return.
                </span>
              </div>
              {fullscreenError && (
                <div className="alert alert-error" style={{ marginBottom: 'var(--space-3)' }}>
                  <XCircle size={16} />
                  <span>{fullscreenError}</span>
                </div>
              )}

              {/* Screen Monitoring & Focus Evidence Disclosure */}
              <div
                style={{
                  background: 'var(--color-surface-alt)',
                  border: '1px solid var(--border-base, rgba(255,255,255,0.08))',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-3)',
                  marginBottom: 'var(--space-3)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: 'var(--space-2)' }}>
                  <Monitor size={16} color="var(--color-blue)" />
                  <strong style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-heading)' }}>
                    Screen Monitoring & Focus Evidence Disclosure
                  </strong>
                </div>
                <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: 1.45, margin: 0 }}>
                  • <strong>What is captured:</strong> A static snapshot of the desktop screen if you leave, switch away from, or minimize the active exam window.<br />
                  • <strong>When:</strong> Only during sustained focus-loss episodes exceeding 2–3 seconds.<br />
                  • <strong>Why:</strong> Contextual evidence for instructor review. No automated grade penalties or cheating determinations are made without human review.<br />
                  • <strong>Privacy & Storage:</strong> Stored locally on this device, synchronized securely upon reconnection, accessible strictly to authorized professors.
                </p>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: 'var(--font-size-xs)',
                    marginTop: 'var(--space-2)',
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                  }}
                >
                  <input
                    type="checkbox"
                    id="chk-screen-monitoring-consent"
                    checked={screenConsent}
                    onChange={(e) => setScreenConsent(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    I understand and grant affirmative consent for automated screen evidence capture during sustained focus loss.
                  </span>
                </label>
              </div>

              <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                Click below to enter fullscreen and begin your examination session.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={handleCancelConsent}
                disabled={starting}
                id="btn-cancel-fullscreen"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirmFullscreenAndStart}
                disabled={starting}
                id="btn-confirm-fullscreen"
              >
                {starting ? (
                  <><span className="spinner" style={{ width: 16, height: 16 }} /> Engaging Fullscreen…</>
                ) : (
                  <>Enter Fullscreen and Start <ArrowRight size={16} /></>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
