/**
 * ExamProctor.ai — Active Exam Session Page
 *
 * Layout (PRD §11):
 *   ┌─────────────┬──────────────────────────────┬──────────┐
 *   │  Left panel │   Question area               │ Camera   │
 *   │  (nav +     │   (question text + answer)    │ panel    │
 *   │   timer)    │                               │ + events │
 *   └─────────────┴──────────────────────────────┴──────────┘
 *
 * Data flow:
 *   Answer typed → answerRepo.upsert() → enqueueOperation() → syncWorker uploads
 *   CV event     → eventRepo.save()    → enqueueOperation() → syncWorker uploads
 *   Submit       → attemptRepo.markLocallySubmitted() → enqueueOperation(finalize)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Send, X, Camera, Maximize2, Minimize2, RefreshCw, Monitor } from 'lucide-react';

import api from '../../services/api';
import { examPackageRepo, attemptRepo, answerRepo, eventRepo } from '../../storage/repositories';
import { enqueueOperation, getOperationForEntity } from '../../storage/outbox';
import { useProctoring } from '../../proctoring/useProctoring';
import { useScreenMonitoring } from '../../proctoring/screenMonitoring';
import { useSyncWorker } from '../../workers/useSyncWorker';
import SyncRecoveryPanel from '../../components/sync/SyncRecoveryPanel';
import styles from './ExamSessionPage.module.css';

// ── Countdown Timer ───────────────────────────────────────────────────────
// Driven by a PERSISTED absolute deadline (not tick counts): reloads and suspended/
// throttled tabs recompute the remaining time from the wall clock instead of resetting.
function CountdownTimer({ deadlineMs, onExpire }) {
  const calc = () => Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
  const [remaining, setRemaining] = useState(calc);
  const expiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);

  useEffect(() => {
    const tick = () => {
      const r = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setRemaining(r);
      if (r <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpireRef.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [deadlineMs]);

  const hours   = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  const pad     = (n) => String(n).padStart(2, '0');
  const isLow   = remaining < 300; // 5 min warning
  const isCrit  = remaining < 60;

  return (
    <div
      className={`${styles.timer} ${isLow ? styles.timerLow : ''} ${isCrit ? styles.timerCrit : ''}`}
      role="timer"
      aria-live="polite"
      aria-label={`Time remaining: ${hours ? pad(hours) + ':' : ''}${pad(minutes)}:${pad(seconds)}`}
    >
      {hours > 0 && <><span>{pad(hours)}</span><span className={styles.timerColon}>:</span></>}
      <span>{pad(minutes)}</span>
      <span className={styles.timerColon}>:</span>
      <span>{pad(seconds)}</span>
    </div>
  );
}

// ── Warning Card ──────────────────────────────────────────────────────────
function WarningCard({ warning, onDismiss }) {
  const critical = ['multiple_faces', 'phone_detected'].includes(warning.type);
  return (
    <div className={`warning-card ${critical ? 'warning-card-critical' : ''} ${styles.warnCard}`}>
      <AlertTriangle size={18} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
        {warning.message}
      </span>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => onDismiss(warning.id)}
        aria-label="Dismiss warning"
        style={{ padding: '2px 6px', minWidth: 0, flexShrink: 0 }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── MCQ Answer ────────────────────────────────────────────────────────────
function McqAnswer({ question, savedAnswer, onChange }) {
  const selected = savedAnswer?.answer_value?.selected_option || null;
  return (
    <div className={styles.mcqOptions}>
      {Object.entries(question.options || {}).map(([key, text]) => (
        <label
          key={key}
          htmlFor={`opt-${question.question_id}-${key}`}
          className={`${styles.mcqOption} ${selected === key ? styles.mcqSelected : ''}`}
        >
          <input
            type="radio"
            id={`opt-${question.question_id}-${key}`}
            name={`q-${question.question_id}`}
            value={key}
            checked={selected === key}
            onChange={() => onChange({ selected_option: key })}
          />
          <span className={styles.mcqKey}>{key}</span>
          <span className={styles.mcqText}>{text}</span>
        </label>
      ))}
    </div>
  );
}

// ── Short Answer ──────────────────────────────────────────────────────────
function ShortAnswer({ question, savedAnswer, onChange }) {
  const text = savedAnswer?.answer_value?.text || '';
  return (
    <textarea
      id={`sa-${question.question_id}`}
      className={`form-textarea ${styles.shortAnswerArea}`}
      placeholder="Type your answer here…"
      value={text}
      onChange={(e) => onChange({ text: e.target.value })}
      rows={6}
    />
  );
}

// ── Main Component ────────────────────────────────────────────────────────
export default function ExamSessionPage() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const [videoMounted, setVideoMounted] = useState(false);

  const [pkg, setPkg] = useState(null);           // exam package
  const [attempt, setAttempt] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState({});     // questionId → {answer_value, revision, operation_id}
  const [savingQ, setSavingQ] = useState(null);   // questionId being saved
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [cameraExpanded, setCameraExpanded] = useState(false);
  const [deadlineMs, setDeadlineMs] = useState(null);
  const submittingRef = useRef(false);
  const examReadyRef = useRef(false);
  const [loadError, setLoadError] = useState(null);
  const [loadingPkg, setLoadingPkg] = useState(true);

  // Fullscreen integrity and offline warning state
  const [fullscreenWarningActive, setFullscreenWarningActive] = useState(false);
  const [fullscreenSecondsRemaining, setFullscreenSecondsRemaining] = useState(5);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [offlineWarningDismissed, setOfflineWarningDismissed] = useState(false);
  const countdownIntervalRef = useRef(null);

  // CV proctoring
  const { cameraState, activeWarnings, eventCount, dismissWarning, flushEvents, storageWarning, stopCamera } = useProctoring({
    videoRef,
    videoMounted,
    attemptId,
    proctoringConfig: pkg?.proctoring_config,
    enabled: !submitted,
  });

  // Screen monitoring and focus evidence capture (independent lifecycle)
  const {
    state: screenMonitorState,
    activeWarning: screenWarning,
    onFocusLost: notifyScreenFocusLost,
    onFocusRestored: notifyScreenFocusRestored,
    onPageHidden: notifyScreenPageHidden,
    dismissWarning: dismissScreenWarning,
    stopScreenMonitoring,
  } = useScreenMonitoring({
    attemptId,
    consented: attempt?.screen_monitoring_consented ?? true,
    enabled: !submitted,
  });

  // Background sync (ordered operations, durable evidence, server-confirmed submission)
  const { syncStatus, syncDetail, syncNow, submissionState } = useSyncWorker(attemptId);
  const [showSyncPanel, setShowSyncPanel] = useState(false);

  // Escape collapses the enlarged camera (the exam itself keeps running underneath)
  useEffect(() => {
    if (!cameraExpanded) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setCameraExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cameraExpanded]);

  // Load exam package and attempt, with remote server recovery when not present in local storage
  const loadExamSession = useCallback(async () => {
    setLoadingPkg(true);
    setLoadError(null);
    try {
      let [localPkg, localAttempt] = await Promise.all([
        examPackageRepo.get(attemptId),
        attemptRepo.get(attemptId),
      ]);

      // If attempt is missing locally, query server to restore attempt metadata
      if (!localAttempt) {
        try {
          const { data } = await api.get('/attempts/my-attempts');
          const serverAttempts = data?.data || [];
          const found = serverAttempts.find((a) => a.attempt_id === attemptId);
          if (found) {
            localAttempt = found;
            await attemptRepo.save(found);
          }
        } catch (e) {
          console.warn('Could not fetch server attempt details', e?.message);
        }
      }

      // If package is missing locally, download from server using exam_id
      if (!localPkg && localAttempt?.exam_id) {
        try {
          const { data } = await api.get(
            `/exams/${localAttempt.exam_id}/package?attempt_id=${attemptId}`
          );
          if (data?.data) {
            localPkg = { attempt_id: attemptId, ...data.data };
            await examPackageRepo.save(localPkg);
          }
        } catch (e) {
          console.warn('Could not download exam package from server', e?.message);
          const errMsg = e?.response?.data?.error?.message || e?.response?.data?.detail || e?.message;
          if (e?.response?.status === 403) {
            throw new Error('This examination attempt is not authorized or has already ended.');
          }
          throw new Error(errMsg || 'Failed to download examination questions. Please check your network connection.');
        }
      }

      if (!localPkg) {
        throw new Error('Examination package unavailable. Please check your network connection or contact your professor.');
      }

      setPkg(localPkg);
      setAttempt(localAttempt);

      if (localAttempt?.status === 'submitted' || localAttempt?.status === 'submitted_local') {
        stopCamera();
        setSubmitted(true);
      }

      // Persisted absolute deadline
      if (localPkg && localAttempt) {
        let dl = localAttempt.deadline_at ? Date.parse(localAttempt.deadline_at) : NaN;
        if (!Number.isFinite(dl)) {
          const startIso = localAttempt.server_started_at || localAttempt.client_started_at || new Date().toISOString();
          dl = Date.parse(startIso) + (localPkg.duration_seconds || 0) * 1000;
          await attemptRepo.patch(attemptId, {
            client_started_at: localAttempt.client_started_at || startIso,
            deadline_at: new Date(dl).toISOString(),
          });
        }
        setDeadlineMs(dl);
      }

      // Load saved answers
      const { answerRepo: ar } = await import('../../storage/repositories');
      const saved = await ar.getAll(attemptId);
      const map = {};
      saved.forEach((a) => { map[a.question_id] = a; });
      setAnswers(map);
    } catch (err) {
      console.error('Failed to load exam session:', err);
      setLoadError(err.message || 'Unable to load examination session.');
    } finally {
      setLoadingPkg(false);
    }
  }, [attemptId, stopCamera]);

  useEffect(() => {
    loadExamSession();
  }, [loadExamSession]);

  // ── Register exam session with local Student Agent Bridge ──────────────────
  // This resolves the agent's startup deadlock: agent.py blocks waiting for
  // a session_id from the bridge before connecting to the classroom WebSocket.
  // We POST to /session once the exam attempt is confirmed loaded.
  useEffect(() => {
    if (!attempt || !attemptId) return;
    const IS_ELECTRON = typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);

    const registerWithBridge = async () => {
      // 1. Try to find the classroom session_id for this attempt from the backend
      let classroomSessionId = null;
      try {
        const { data } = await api.get(`/classroom/agent/session-for-attempt/${attemptId}`).catch(() => ({ data: null }));
        classroomSessionId = data?.data?.session_id || null;
      } catch { /* not available — bridge will work without it */ }

      const bridgePort = (typeof window.electronAPI?.agentPort === 'function' ? window.electronAPI.agentPort() : null) || 41732;

      // 2. POST to the bridge so the agent learns the session_id
      try {
        await fetch(`http://127.0.0.1:${bridgePort}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id:  classroomSessionId,
            attempt_id:  attemptId,
            student_user_id: attempt?.user_id || null,
          }),
        });
      } catch { /* bridge not running — non-fatal */ }

      // 3. Also push via Electron IPC (stronger guarantee, works even before bridge is up)
      if (IS_ELECTRON && window.electronAPI?.agentSetSession) {
        try {
          await window.electronAPI.agentSetSession({
            sessionId:  classroomSessionId,
            attemptId,
          });
        } catch { /* noop */ }
      }
    };

    registerWithBridge();
  }, [attempt, attemptId]);



  const currentQuestion = pkg?.questions?.[currentIndex];
  const totalQuestions  = pkg?.questions?.length || 0;

  // Save answer locally then enqueue for sync
  const handleAnswerChange = useCallback(async (answerValue) => {
    if (!currentQuestion) return;
    const qId = currentQuestion.question_id;
    setSavingQ(qId);

    const saved = await answerRepo.upsert({
      attemptId,
      questionId: qId,
      answerValue,
    });

    // Enqueue outbox operation
    await enqueueOperation({
      operationId:   saved.operation_id,
      attemptId,
      operationType: 'answer_upsert',
      entityId:      qId,
      payload: {
        question_id:      qId,
        answer_value:     answerValue,
        revision:         saved.revision,
        client_updated_at: saved.updated_at,
      },
    });

    setAnswers((prev) => ({ ...prev, [qId]: saved }));
    setSavingQ(null);
  }, [attemptId, currentQuestion]);

  // Navigate questions
  const goTo = useCallback((idx) => {
    if (idx >= 0 && idx < totalQuestions) setCurrentIndex(idx);
  }, [totalQuestions]);

  // Submit exam: durable local commit only. Server confirmation comes later from the
  // sync worker, strictly after every earlier operation has been acknowledged.
  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return; // repeated clicks / timer + click
    submittingRef.current = true;
    setSubmitLoading(true);
    stopScreenMonitoring();
    try {
      const current = await attemptRepo.get(attemptId);
      if (current && (current.status === 'submitted' || current.status === 'submitted_local')) {
        stopScreenMonitoring();
        stopCamera();
        setSubmitted(true);
        setShowSubmitModal(false);
        return;
      }

      // Close active episodes and wait until their event operations are queued, so they
      // precede the finalize operation in sequence order.
      await flushEvents();

      // Stop camera tracks and frame loop immediately upon submission
      stopScreenMonitoring();
      stopCamera();
      if (typeof window !== 'undefined' && window.electronAPI?.setFullscreen) {
        window.electronAPI.setFullscreen(false);
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      setFullscreenWarningActive(false);

      // Idempotent across crashes between enqueue and local commit: reuse an existing
      // finalize operation instead of creating a second submission.
      const prior = await getOperationForEntity(attemptId, 'submission_finalize', attemptId);
      const clientSubmittedAt = prior?.payload?.client_submitted_at || new Date().toISOString();
      const submissionOpId = prior?.operation_id || uuidv4();
      const record = prior || await enqueueOperation({
        operationId:   submissionOpId,
        attemptId,
        operationType: 'submission_finalize',
        entityId:      attemptId,
        payload: {
          submission_operation_id: submissionOpId,
          client_submitted_at:     clientSubmittedAt,
        },
      });

      await attemptRepo.markLocallySubmitted(attemptId, {
        submissionOperationId: submissionOpId,
        finalSequence: record.sequence_number, // the real operation sequence boundary
        clientSubmittedAt,
      });

      setSubmitted(true);
      setShowSubmitModal(false);
    } catch (err) {
      console.error('Submission error', err);
      submittingRef.current = false; // allow a retry; nothing was lost
    } finally {
      setSubmitLoading(false);
    }
  }, [attemptId, flushEvents, stopCamera]);

  // Handle return to fullscreen action
  const handleReturnToFullscreen = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI?.setFullscreen) {
      await window.electronAPI.setFullscreen(true);
    } else if (document.documentElement?.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
      } catch { /* ignore */ }
    }
  }, []);

  // Fullscreen exit & grace period handler
  const handleFullscreenExitDetected = useCallback(async () => {
    if (submittingRef.current || submitted || !examReadyRef.current) return;
    if (fullscreenWarningActive) return; // Prevent duplicate timers and duplicate outbox events

    setFullscreenWarningActive(true);
    setFullscreenSecondsRemaining(5);

    // Record proctoring event to local outbox
    const eventId = uuidv4();
    const nowIso = new Date().toISOString();
    try {
      await enqueueOperation({
        operationId: uuidv4(),
        attemptId,
        operationType: 'event_upsert',
        entityId: eventId,
        payload: {
          event_id: eventId,
          event_type: 'fullscreen_exit',
          event_status: 'confirmed',
          client_started_at: nowIso,
          client_ended_at: nowIso,
          duration_ms: 0,
          metadata: { reason: 'fullscreen_exit_detected', attempt_id: attemptId },
        },
      });
    } catch (e) {
      console.warn('Failed to record fullscreen_exit event', e);
    }

    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
    }

    let remaining = 5;
    countdownIntervalRef.current = setInterval(() => {
      remaining -= 1;
      setFullscreenSecondsRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
        setFullscreenWarningActive(false);
        // Timeout: automatically submit the examination
        handleSubmit();
      }
    }, 1000);
  }, [attemptId, submitted, fullscreenWarningActive, handleSubmit]);

  const pendingBlurTimerRef = useRef(null);
  const activeBlurEpisodeRef = useRef(null);

  // Window blur handler (debounced, distinct from fullscreen transitions)
  const handleWindowBlurDetected = useCallback((data) => {
    if (submittingRef.current || submitted || !examReadyRef.current) return;
    if (data?.isFullscreenTransition) {
      console.log('[Proctoring Diagnostic] Suppressed transient window blur during fullscreen mode transition.');
      return;
    }
    // If an episode or debounce timer is already running for the same continuous loss of focus, ignore duplicate
    if (activeBlurEpisodeRef.current || pendingBlurTimerRef.current) return;

    const blurIso = data?.timestamp || new Date().toISOString();
    const eventId = uuidv4();
    console.log('[Proctoring Diagnostic] Window focus lost; starting debounce verification (1200ms)...');

    notifyScreenFocusLost({ timestamp: blurIso, eventId });

    pendingBlurTimerRef.current = setTimeout(async () => {
      pendingBlurTimerRef.current = null;
      if (submittingRef.current || submitted) return;

      activeBlurEpisodeRef.current = {
        eventId,
        startedAt: blurIso,
      };

      try {
        await eventRepo.save({
          event_id: eventId,
          attempt_id: attemptId,
          event_type: 'window_blur',
          event_status: 'candidate',
          client_started_at: blurIso,
          client_ended_at: null,
          duration_ms: null,
          metadata: { reason: 'window_focus_loss_detected', attempt_id: attemptId },
        });
        console.log('[Proctoring Diagnostic] Genuine focus loss confirmed; candidate episode recorded.');
      } catch (e) {
        console.warn('Failed to record candidate window_blur event', e);
      }
    }, 1200);
  }, [attemptId, submitted, notifyScreenFocusLost]);

  // Window focus handler (closes active focus-loss episodes and cancels false alarms)
  const handleWindowFocusDetected = useCallback(async () => {
    // Notify screen monitoring that focus has been restored
    notifyScreenFocusRestored();

    // 1. If focus returned during debounce grace period (<1200ms), cancel without recording misconduct
    if (pendingBlurTimerRef.current) {
      clearTimeout(pendingBlurTimerRef.current);
      pendingBlurTimerRef.current = null;
      console.log('[Proctoring Diagnostic] Transient focus loss returned within grace window; no misconduct recorded.');
    }

    // 2. If a genuine episode was open, compute duration and finalize
    if (activeBlurEpisodeRef.current) {
      const { eventId, startedAt } = activeBlurEpisodeRef.current;
      activeBlurEpisodeRef.current = null;
      const nowIso = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
      console.log(`[Proctoring Diagnostic] Window focus restored after ${durationMs}ms`);

      if (durationMs >= 1000) {
        try {
          const payload = {
            event_id: eventId,
            event_type: 'window_blur',
            event_status: 'confirmed',
            client_started_at: startedAt,
            client_ended_at: nowIso,
            duration_ms: durationMs,
            metadata: {
              reason: 'window_focus_loss_detected',
              attempt_id: attemptId,
              duration_seconds: Math.round(durationMs / 1000),
            },
          };
          await eventRepo.save(payload);
          await enqueueOperation({
            operationId: uuidv4(),
            attemptId,
            operationType: 'event_upsert',
            entityId: eventId,
            payload,
          });
        } catch (e) {
          console.warn('Failed to record finalized window_blur event', e);
        }
      }
    }

    // 3. If window is focused and in fullscreen, clear any pending fullscreen warning
    if (typeof window !== 'undefined' && window.electronAPI?.getFullscreen) {
      window.electronAPI.getFullscreen().then((isFs) => {
        if (isFs && countdownIntervalRef.current) {
          setFullscreenWarningActive(false);
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      }).catch(() => {});
    }
  }, [attemptId]);

  // Stable handler refs to prevent effect recreation on render
  const exitHandlerRef = useRef(handleFullscreenExitDetected);
  exitHandlerRef.current = handleFullscreenExitDetected;

  const blurHandlerRef = useRef(handleWindowBlurDetected);
  blurHandlerRef.current = handleWindowBlurDetected;

  const focusHandlerRef = useRef(handleWindowFocusDetected);
  focusHandlerRef.current = handleWindowFocusDetected;

  // Online / offline event tracking
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setOfflineWarningDismissed(false);
    };
    const handleOffline = () => {
      setIsOnline(false);
      setOfflineWarningDismissed(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Electron fullscreen and window integrity lifecycle (stable mount effect)
  useEffect(() => {
    if (submitted) return undefined;

    // Enter fullscreen when active
    if (typeof window !== 'undefined' && window.electronAPI?.setFullscreen) {
      window.electronAPI.setFullscreen(true).then(() => {
        setTimeout(() => { examReadyRef.current = true; }, 1000);
      });
    } else {
      setTimeout(() => { examReadyRef.current = true; }, 1000);
    }

    let unsubFs = () => {};
    let unsubBlur = () => {};
    let unsubFocus = () => {};

    if (typeof window !== 'undefined' && window.electronAPI) {
      unsubFs = window.electronAPI.onFullscreenChange((isFullscreen) => {
        if (isFullscreen) {
          // Returned to fullscreen: dismiss warning and cancel auto-submit timer
          setFullscreenWarningActive(false);
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
        } else {
          exitHandlerRef.current?.();
        }
      });

      unsubBlur = window.electronAPI.onWindowBlur((data) => {
        blurHandlerRef.current?.(data);
      });

      unsubFocus = window.electronAPI.onWindowFocus(() => {
        focusHandlerRef.current?.();
      });
    }

    // HTML5 fullscreen change fallback for web browsers
    const handleHtmlFsChange = () => {
      const isFs = Boolean(document.fullscreenElement);
      if (isFs) {
        setFullscreenWarningActive(false);
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      } else {
        exitHandlerRef.current?.();
      }
    };
    document.addEventListener('fullscreenchange', handleHtmlFsChange);

    const handleVisibilityChange = () => {
      if (document.hidden && !submittingRef.current && !submitted) {
        notifyScreenPageHidden({ timestamp: new Date().toISOString() });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubFs();
      unsubBlur();
      unsubFocus();
      document.removeEventListener('fullscreenchange', handleHtmlFsChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (pendingBlurTimerRef.current) {
        clearTimeout(pendingBlurTimerRef.current);
        pendingBlurTimerRef.current = null;
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [attemptId, submitted, notifyScreenPageHidden]);


  // ── Submission confirmation screen ────────────────────────────────────
  if (submitted) {
    return (
      <div className={styles.submittedScreen}>
        <div className={styles.submittedCard}>
          <CheckCircle size={56} style={{ color: 'var(--color-green)' }} />
          <h1>Examination Submitted</h1>
          <p>
            Your submission is saved on this device. It is only final once the server
            confirms it; this happens automatically when you are connected.
          </p>
          <div className={styles.submittedMeta}>
            <span>Attempt ID:</span>
            <code>{attemptId.slice(0, 8)}…</code>
          </div>
          {submissionState.key.startsWith('confirmed') ? (
            <div className="alert alert-success" role="status">
              <CheckCircle size={16} />
              {submissionState.label}
            </div>
          ) : (
            <div className="alert alert-warning" role="status">
              <AlertTriangle size={16} />
              {submissionState.label}
            </div>
          )}
          <button className="btn btn-primary" onClick={() => navigate('/student')}>
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.loadingScreen}>
        <div style={{ maxWidth: 480, textAlign: 'center', padding: 'var(--space-6)' }}>
          <AlertTriangle size={48} color="var(--color-red)" style={{ marginBottom: 'var(--space-3)' }} />
          <h2 style={{ color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>Unable to Load Examination</h2>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)' }}>{loadError}</p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={loadExamSession}>
              <RefreshCw size={16} /> Retry
            </button>
            <button className="btn btn-secondary" onClick={() => navigate('/student')}>
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loadingPkg || !pkg) {
    return (
      <div className={styles.loadingScreen}>
        <div className="spinner spinner-lg" />
        <p>Loading exam…</p>
      </div>
    );
  }

  // ── Answered count ────────────────────────────────────────────────────
  const answeredCount = pkg.questions.filter(
    (q) => answers[q.question_id]?.answer_value
  ).length;

  return (
    <div className={styles.shell}>
      {/* Offline Mode Warning Banner */}
      {!isOnline && !offlineWarningDismissed && (
        <div
          className="alert alert-warning"
          style={{
            position: 'fixed',
            top: 'var(--space-3)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 999,
            maxWidth: '90%',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
          }}
          role="status"
        >
          <AlertTriangle size={18} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-size-sm)', flex: 1 }}>
            No internet connection. Offline mode is active. Your examination, monitoring, and answers will continue to be saved on this computer. Synchronization will resume when the connection returns.
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setOfflineWarningDismissed(true)}
            aria-label="Dismiss offline warning"
            style={{ padding: '2px 6px', minWidth: 0, flexShrink: 0 }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Fullscreen Exit Warning & Grace Period Modal */}
      {fullscreenWarningActive && (
        <div
          className="modal-backdrop"
          role="alertdialog"
          aria-modal="true"
          style={{ zIndex: 1100, background: 'rgba(0, 0, 0, 0.85)' }}
        >
          <div className="modal-dialog" style={{ maxWidth: 480, border: '2px solid var(--color-red)' }}>
            <div className="modal-header" style={{ borderBottom: '1px solid var(--color-red-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-red)' }}>
                <AlertTriangle size={22} />
                <h3 className="modal-title" style={{ color: 'var(--color-red)' }}>Fullscreen Exit Warning</h3>
              </div>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 'var(--font-size-base)', lineHeight: 1.5, fontWeight: 600 }}>
                You have exited fullscreen mode. Return to fullscreen within{' '}
                <span style={{ color: 'var(--color-red)', fontSize: 'var(--font-size-xl)' }}>
                  {fullscreenSecondsRemaining}s
                </span>{' '}
                or your exam will be automatically submitted.
              </p>
              <div
                style={{
                  height: 6,
                  background: 'var(--color-surface-hover)',
                  borderRadius: 3,
                  marginTop: 'var(--space-4)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${(fullscreenSecondsRemaining / 5) * 100}%`,
                    background: 'var(--color-red)',
                    transition: 'width 1s linear',
                  }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-primary w-full"
                onClick={handleReturnToFullscreen}
                id="btn-return-fullscreen"
              >
                Return to Fullscreen ({fullscreenSecondsRemaining}s)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Left panel: nav + timer ── */}
      <aside className={styles.leftPanel}>
        <div className={styles.examMeta}>
          <div className={styles.examTitle}>{pkg.title}</div>
          <div className={styles.examProgress}>
            {answeredCount}/{totalQuestions} answered
          </div>
        </div>

        {/* Timer */}
        {deadlineMs && (
          <CountdownTimer
            deadlineMs={deadlineMs}
            onExpire={handleSubmit /* time is up: commit the submission */}
          />
        )}

        {/* Question navigator */}
        <div className={styles.qNavGrid}>
          {pkg.questions.map((q, i) => {
            const isAnswered = !!answers[q.question_id]?.answer_value;
            const isCurrent  = i === currentIndex;
            return (
              <button
                key={q.question_id}
                id={`btn-qnav-${i + 1}`}
                className={`${styles.qNavBtn}
                  ${isCurrent  ? styles.qNavCurrent  : ''}
                  ${isAnswered ? styles.qNavAnswered : ''}`}
                onClick={() => goTo(i)}
                aria-label={`Question ${i + 1}${isAnswered ? ' (answered)' : ''}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>

        {/* Submit button */}
        <button
          id="btn-submit-exam"
          className="btn btn-orange w-full"
          onClick={() => setShowSubmitModal(true)}
        >
          <Send size={16} /> Submit Exam
        </button>
      </aside>

      {/* ── Main question area ── */}
      <main className={styles.questionArea} role="main">
        {currentQuestion && (
          <>
            <div className={styles.questionHeader}>
              <span className="badge badge-blue">
                Q{currentQuestion.question_number}
              </span>
              <span className={styles.questionMarks}>
                {currentQuestion.marks} mark{currentQuestion.marks !== 1 ? 's' : ''}
              </span>
              {savingQ === currentQuestion.question_id && (
                <span className={styles.savingIndicator}>
                  <span className="spinner" style={{ width: 14, height: 14 }} />
                  Saving…
                </span>
              )}
            </div>

            <div className={styles.questionText}>
              {currentQuestion.question_text}
            </div>

            <div className={styles.answerArea}>
              {currentQuestion.question_type === 'mcq' ? (
                <McqAnswer
                  question={currentQuestion}
                  savedAnswer={answers[currentQuestion.question_id]}
                  onChange={handleAnswerChange}
                />
              ) : (
                <ShortAnswer
                  question={currentQuestion}
                  savedAnswer={answers[currentQuestion.question_id]}
                  onChange={handleAnswerChange}
                />
              )}
            </div>

            {/* Navigation */}
            {pkg.allow_question_navigation && (
              <div className={styles.navButtons}>
                <button
                  className="btn btn-secondary"
                  onClick={() => goTo(currentIndex - 1)}
                  disabled={currentIndex === 0}
                  id="btn-prev-question"
                >
                  <ChevronLeft size={16} /> Previous
                </button>
                <span className={styles.qCounter}>
                  {currentIndex + 1} / {totalQuestions}
                </span>
                <button
                  className="btn btn-secondary"
                  onClick={() => goTo(currentIndex + 1)}
                  disabled={currentIndex === totalQuestions - 1}
                  id="btn-next-question"
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Right panel: camera + warnings ── */}
      <aside className={`${styles.rightPanel} ${cameraExpanded ? styles.rightPanelRaised : ''}`}>
        {/* Camera feed. The SAME <video> element/stream is only restyled when expanded. */}
        {cameraExpanded && (
          <div className={styles.cameraBackdrop} onClick={() => setCameraExpanded(false)} aria-hidden="true" />
        )}
        <div className={styles.cameraSlot}>
          <div
            className={`${styles.cameraBox} ${cameraExpanded ? styles.cameraBoxExpanded : ''}`}
            role={cameraExpanded ? 'dialog' : undefined}
            aria-label={cameraExpanded ? 'Enlarged camera preview' : undefined}
          >
            <video
              ref={(node) => {
                videoRef.current = node;
                if (node && !videoMounted) setVideoMounted(true);
              }}
              autoPlay
              playsInline
              muted
              className={styles.cameraVideo}
            />
            <div className={styles.cameraStatus}>
              <span
                className={styles.cameraStatusDot}
                style={{
                  background: cameraState === 'active'
                    ? 'var(--color-green)'
                    : cameraState === 'initializing'
                    ? 'var(--color-orange)'
                    : 'var(--color-red)',
                }}
              />
              <span>
                {cameraState === 'active'
                  ? 'Active'
                  : cameraState === 'initializing'
                  ? 'Initializing…'
                  : cameraState === 'permission_denied'
                  ? 'Camera Permission Denied'
                  : cameraState === 'camera_unavailable'
                  ? 'Camera Unavailable'
                  : cameraState === 'detection_error'
                  ? 'Detection Error'
                  : cameraState === 'stopped'
                  ? 'Stopped'
                  : 'Idle'}
              </span>
            </div>
            {['permission_denied', 'camera_unavailable', 'detection_error'].includes(cameraState) && (
              <div
                className="alert alert-danger"
                style={{
                  position: 'absolute',
                  bottom: '34px',
                  left: '6px',
                  right: '6px',
                  margin: 0,
                  padding: '5px 8px',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  zIndex: 3,
                  background: 'rgba(239, 68, 68, 0.95)',
                  color: '#fff',
                  borderRadius: '4px',
                  boxShadow: 'var(--shadow-md)',
                }}
                role="alert"
              >
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>
                  {cameraState === 'permission_denied' && 'Camera permission was denied. Please allow access in system settings.'}
                  {cameraState === 'camera_unavailable' && 'Camera is unavailable or in use by another application.'}
                  {cameraState === 'detection_error' && 'Failed to load AI proctoring models. Please restart the app.'}
                </span>
              </div>
            )}
            <button
              type="button"
              id="btn-toggle-camera-size"
              className={styles.cameraExpandBtn}
              onClick={() => setCameraExpanded((v) => !v)}
              aria-label={cameraExpanded ? 'Collapse camera preview' : 'Enlarge camera preview'}
              aria-expanded={cameraExpanded}
            >
              {cameraExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </div>

        {/* Sync / submission status (never shows green until the server has acknowledged) */}
        <div
          className={styles.syncRow}
          role="status"
          aria-live="polite"
          style={{ cursor: 'pointer' }}
          onClick={() => setShowSyncPanel(true)}
          title="Click to view offline evidence & recovery dashboard"
        >
          <span className={styles.syncLabel}>Sync</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`badge ${['synced', 'confirmed', 'confirmed_evidence_pending'].includes(submissionState.key) ? 'badge-green' : syncStatus === 'error' || syncStatus === 'auth_expired' ? 'badge-red' : 'badge-orange'}`}>
              {syncStatus === 'auth_expired' ? 'sign-in needed' : syncStatus === 'idle' ? 'starting' : syncStatus}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ padding: '2px 6px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={(e) => { e.stopPropagation(); setShowSyncPanel(true); }}
            >
              Queue
            </button>
          </div>
        </div>
        <div className={styles.syncDetail}>{submissionState.label}</div>
        {storageWarning && (
          <div className="alert alert-warning" role="alert">
            <AlertTriangle size={16} /> {storageWarning}
          </div>
        )}

        {/* Active warnings */}
        <div className={`${styles.warningsList} ${cameraExpanded ? styles.warningsAboveOverlay : ''}`}>
          {screenWarning && (
            <div
              className={`warning-card ${screenWarning.severity === 'critical' ? 'warning-card-critical' : ''} ${styles.warnCard}`}
              style={{ borderLeft: '4px solid var(--color-orange)' }}
              role="alert"
            >
              <Monitor size={18} style={{ flexShrink: 0, color: screenWarning.severity === 'critical' ? 'var(--color-red)' : 'var(--color-orange)' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-heading)' }}>
                  {screenWarning.title}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
                  {screenWarning.message}
                </span>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={dismissScreenWarning}
                aria-label="Dismiss warning"
                style={{ padding: '2px 6px', minWidth: 0, flexShrink: 0 }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {activeWarnings.map((w) => (
            <WarningCard key={w.id} warning={w} onDismiss={dismissWarning} />
          ))}
        </div>

        {/* Event summary */}
        {Object.keys(eventCount).length > 0 && (
          <div className={styles.eventSummary}>
            <div className={styles.eventSummaryTitle}>Events recorded</div>
            {Object.entries(eventCount).map(([type, count]) => (
              <div key={type} className={styles.eventSummaryRow}>
                <span>{type.replace(/_/g, ' ')}</span>
                <span className="badge badge-orange">{count}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* ── Submit confirmation modal ── */}
      {showSubmitModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-header">
              <h2 style={{ fontSize: 'var(--font-size-xl)' }}>Submit Examination?</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowSubmitModal(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <p>
                You have answered <strong>{answeredCount}</strong> of{' '}
                <strong>{totalQuestions}</strong> questions.
              </p>
              <p style={{ marginTop: 'var(--space-3)' }}>
                Once submitted, you cannot change your answers. Your answers
                are saved locally and will be uploaded automatically.
              </p>
              {answeredCount < totalQuestions && (
                <div className="alert alert-warning" style={{ marginTop: 'var(--space-4)' }}>
                  <AlertTriangle size={16} />
                  <span>
                    {totalQuestions - answeredCount} question(s) are unanswered.
                  </span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowSubmitModal(false)}
                id="btn-cancel-submit"
              >
                Continue exam
              </button>
              <button
                id="btn-confirm-submit"
                className="btn btn-orange"
                onClick={handleSubmit}
                disabled={submitLoading}
              >
                {submitLoading ? (
                  <><span className="spinner" style={{ width: 16, height: 16 }} /> Submitting…</>
                ) : (
                  <><Send size={16} /> Submit now</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Offline Evidence & Sync Recovery Dashboard */}
      <SyncRecoveryPanel
        attemptId={attemptId}
        syncStatus={syncStatus}
        syncDetail={syncDetail}
        submissionState={submissionState}
        syncNow={syncNow}
        isOpen={showSyncPanel}
        onClose={() => setShowSyncPanel(false)}
      />
    </div>
  );
}
