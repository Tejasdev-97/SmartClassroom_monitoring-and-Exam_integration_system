/**
 * ExamProctor.ai — Proctoring Hook
 * Integrates CameraManager + CVEventEngine into React state.
 * Used by ExamSessionPage to drive the proctoring panel and event recording.
 *
 * Evidence lifecycle (per continuous episode of a condition):
 *   candidate  -> (phone / multiple faces) provisional snapshot requested IMMEDIATELY and
 *                 non-blockingly; stored locally as 'provisional' (not yet evidence)
 *   start      -> temporal verification passed: event is CONFIRMED; the provisional snapshot is
 *                 promoted to deliverable evidence ('local' = queued for durable upload). For
 *                 face_absent / sustained_head_turn the snapshot is taken now (condition is
 *                 still present at confirmation). event_upsert (open) is enqueued.
 *   end        -> final duration/end time persisted and event_upsert enqueued
 *   rejected   -> candidate vanished before confirmation: provisional snapshot is discarded and
 *                 no event is ever created/synced
 * One representative snapshot is kept per episode; a later reappearance is a new episode
 * (new event id, own start/end/duration, own snapshot).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { CameraManager } from './cameraManager';
import { CVEventEngine } from './cvEventEngine';
import { eventRepo, snapshotRepo } from '../storage/repositories';
import { enqueueOperation } from '../storage/outbox';
import { round4 } from '../storage/canonicalJson';
import { FrameDetectors } from './frameDetectors';
import { v4 as uuidv4 } from 'uuid';

const FRAME_INTERVAL_MS = 500; // 2 fps for detection

const DETECTOR_NAME = 'mediapipe-face_landmarker+efficientdet_lite0';
const DETECTOR_VERSION = 'tasks-vision-1.1';
const RULE_VERSION = '2.0.0';

// Types for which an immediate (pre-confirmation) snapshot is requested.
const EARLY_EVIDENCE_TYPES = new Set(['phone_detected', 'multiple_faces']);
// Types that produce image evidence at all.
const EVIDENCE_TYPES = new Set(['phone_detected', 'multiple_faces', 'face_absent', 'sustained_head_turn']);

/** Round every number to 4 dp so client/server canonical hashes can never diverge. */
function roundDeep(v) {
  if (typeof v === 'number') return round4(v);
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
  return v;
}

function buildEventPayload(event, status) {
  const meta = roundDeep(event.metadata || {});
  const payload = {
    event_id:          event.event_id,
    event_type:        event.event_type,
    event_status:      status,
    client_started_at: event.client_started_at,
    client_ended_at:   event.client_ended_at ?? null,
    duration_ms:       event.duration_ms ?? null,
    detector_name:     DETECTOR_NAME,
    detector_version:  DETECTOR_VERSION,
    rule_version:      RULE_VERSION,
    metadata:          meta,
  };
  if (typeof meta.confidence === 'number') payload.confidence = meta.confidence;
  if (Array.isArray(meta.bbox)) payload.bounding_boxes = [meta.bbox];
  return payload;
}

export function useProctoring({ videoRef, attemptId, proctoringConfig, enabled = true }) {
  const [cameraState, setCameraState] = useState('idle'); // idle|requesting|active|error|stopped
  const [activeWarnings, setActiveWarnings] = useState([]); // [{id, type, message}]
  const [eventCount, setEventCount] = useState({});
  const [detectorStatus, setDetectorStatus] = useState({ face: 'idle', object: 'idle', error: null });
  const [detections, setDetections] = useState(null);
  const [storageWarning, setStorageWarning] = useState(null);

  const managerRef = useRef(null);
  const engineRef  = useRef(null);
  const frameLoopRef = useRef(null);
  const detectorRef = useRef(null);
  const pendingRef = useRef(new Set());       // in-flight event handlers (awaited on flush)
  const provisionalRef = useRef(new Map());   // event_id -> snapshot_id (candidate evidence)
  const inFlightCapturesRef = useRef(new Map()); // event_id -> Promise<snapshot_id>
  const isProcessingRef = useRef(false);
  const isStoppedRef = useRef(false);
  const lastWebcamStreamRef = useRef(0);
  const streamCanvasRef = useRef(null);

  const stopCamera = useCallback(() => {
    isStoppedRef.current = true;
    if (frameLoopRef.current) {
      clearInterval(frameLoopRef.current);
      frameLoopRef.current = null;
    }
    if (detectorRef.current) {
      try { detectorRef.current.close(); } catch { /* noop */ }
      detectorRef.current = null;
    }
    if (managerRef.current) {
      try { managerRef.current.stop(); } catch { /* noop */ }
    }
    if (videoRef?.current) {
      if (videoRef.current.srcObject) {
        try {
          const s = videoRef.current.srcObject;
          if (typeof s.getTracks === 'function') {
            s.getTracks().forEach((t) => {
              try { t.stop(); } catch { /* noop */ }
            });
          }
        } catch { /* noop */ }
      }
      videoRef.current.srcObject = null;
    }
    setCameraState('stopped');
  }, [videoRef]);

  const dismissWarning = useCallback((warningId) => {
    setActiveWarnings((prev) => prev.filter((w) => w.id !== warningId));
  }, []);

  /**
   * Capture a frame and store it locally. NEVER throws and never blocks the frame loop
   * (callers do not await it on the hot path). Returns the snapshot id or null.
   */
  const captureEvidence = useCallback(async (event, status, sourceCanvas = null) => {
    if (!attemptId || !managerRef.current?.isActive) return null;
    const capturedAt = new Date().toISOString(); // timestamp of the frame actually captured
    try {
      const snap = await managerRef.current.captureSnapshot(0.82, sourceCanvas);
      if (!snap) return null;
      const snapshot_id = uuidv4();
      await snapshotRepo.save({
        snapshot_id,
        attempt_id:         attemptId,
        event_id:           event.event_id,
        capture_reason:     event.event_type,
        client_captured_at: capturedAt,
        blob:               snap.blob,
        sha256:             snap.sha256,
        size_bytes:         snap.size,
        width:              snap.width,
        height:             snap.height,
        storage_status:     status, // 'provisional' | 'local'
        retry_count:        0,
      });
      return snapshot_id;
    } catch (e) {
      // Quota or capture failure must not corrupt answers/outbox or crash the exam.
      if (e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '')) {
        setStorageWarning('Device storage is full. Evidence images may not be saved; answers are still saved.');
      }
      console.warn('[Proctoring] snapshot unavailable:', e?.message);
      return null;
    }
  }, [attemptId]);

  const processEvent = useCallback(async (event) => {
    if (!attemptId) return;
    const type = event.event_type;
    const phase = event.phase;

    // ── candidate: immediate provisional evidence, no persistence of an event yet ──
    if (phase === 'candidate') {
      if (EARLY_EVIDENCE_TYPES.has(type)) {
        // Track the in-flight capture promise to eliminate race conditions
        const p = captureEvidence(event, 'provisional').then((id) => {
          if (id) provisionalRef.current.set(event.event_id, id);
          return id;
        });
        inFlightCapturesRef.current.set(event.event_id, p);
      }
      return;
    }

    // ── rejected: never became a confirmed event; drop provisional evidence ──
    if (phase === 'rejected') {
      // Await in-flight capture if one is currently processing to prevent orphaned snapshots
      const pendingCapture = inFlightCapturesRef.current.get(event.event_id);
      if (pendingCapture) {
        await pendingCapture.catch(() => null);
        inFlightCapturesRef.current.delete(event.event_id);
      }
      const id = provisionalRef.current.get(event.event_id);
      provisionalRef.current.delete(event.event_id);
      if (id) await snapshotRepo.discardProvisional(id);
      for (const s of await snapshotRepo.getProvisionalForEvent(event.event_id)) {
        await snapshotRepo.discardProvisional(s.snapshot_id);
      }
      return;
    }

    // ── confirmed episode start ──
    if (phase === 'start') {
      const WARNING_MESSAGES = {
        face_absent:         'No face detected. Please ensure your face is visible to the camera.',
        multiple_faces:      'Multiple people detected. Only one person may be present during the examination.',
        sustained_head_turn: 'Please face the screen. Sustained head turns are being monitored.',
        phone_detected:      'A mobile device has been detected. Please remove it from view.',
        camera_unavailable:  'Camera connection lost. Please reconnect your webcam.',
      };
      const msg = WARNING_MESSAGES[type];
      if (msg) {
        setActiveWarnings((prev) => [
          ...prev.filter((w) => w.type !== type),
          { id: event.event_id, type, message: msg },
        ]);
      }
      // Counter = confirmed continuous episodes (not raw frames).
      setEventCount((prev) => ({ ...prev, [type]: (prev[type] || 0) + 1 }));

      const open = { ...event, event_status: 'confirmed' };
      await eventRepo.save({
        event_id: open.event_id, attempt_id: attemptId, event_type: type,
        event_status: 'confirmed', client_started_at: open.client_started_at,
        client_ended_at: null, duration_ms: null, metadata: roundDeep(open.metadata || {}),
        detector_name: DETECTOR_NAME, detector_version: DETECTOR_VERSION, rule_version: RULE_VERSION,
      });

      // ── Relay confirmed AI event to the local Student Agent bridge ──
      // The agent will forward this over its classroom WebSocket so the professor
      // sees real-time face / phone warnings against the correct student card.
      // Fire-and-forget: never block the exam or proctoring engine.
      const AI_SEVERITY = {
        face_absent: 'high',
        multiple_faces: 'critical',
        phone_detected: 'critical',
        sustained_head_turn: 'medium',
        camera_unavailable: 'high',
        focus_loss: 'medium',
      };
      (() => {
        try {
          const bridgePort = (typeof window.electronAPI?.agentPort === 'function' ? window.electronAPI.agentPort() : null) || 41732;
          fetch(`http://127.0.0.1:${bridgePort}/ai-events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              events: [{
                event_type: type,
                event_id: open.event_id,
                attempt_id: attemptId,
                severity: AI_SEVERITY[type] || 'medium',
                client_timestamp: open.client_started_at || new Date().toISOString(),
                confidence: open.metadata?.confidence ?? 1.0,
                metadata: open.metadata || {},
              }],
            }),
          }).catch(() => {}); // Ignore bridge errors — exam must never be disrupted
        } catch { /* noop */ }
      })();

      if (EVIDENCE_TYPES.has(type)) {
        // Resolve any in-flight provisional capture
        const pendingCapture = inFlightCapturesRef.current.get(event.event_id);
        if (pendingCapture) {
          await pendingCapture.catch(() => null);
          inFlightCapturesRef.current.delete(event.event_id);
        }
        let snapId = provisionalRef.current.get(event.event_id);
        if (!snapId) {
          // Provisional capture missing/failed (or type captures at confirmation): try now.
          snapId = await captureEvidence(event, 'local');
        } else {
          provisionalRef.current.delete(event.event_id);
          await snapshotRepo.updateStatus(snapId, 'local'); // promote: now deliverable evidence
        }
      }

      await enqueueOperation({
        operationId: uuidv4(), attemptId, operationType: 'event_upsert', entityId: event.event_id,
        payload: buildEventPayload(open, 'confirmed'),
      });
      return;
    }

    // ── end: episode finished (also used for instantaneous auxiliary events) ──
    if (phase === 'end') {
      setActiveWarnings((prev) => prev.filter((w) => w.type !== type));

      const isAux = !EVIDENCE_TYPES.has(type);
      let metadata = event.metadata || {};
      if (!isAux) {
        const snaps = await snapshotRepo.getForEvent(event.event_id);
        if (!snaps.length) metadata = { ...metadata, evidence_unavailable: true };
      }
      const full = { ...event, metadata };

      await eventRepo.save({
        event_id: event.event_id, attempt_id: attemptId, event_type: type,
        event_status: 'confirmed', client_started_at: event.client_started_at,
        client_ended_at: event.client_ended_at, duration_ms: event.duration_ms,
        metadata: roundDeep(metadata),
        detector_name: DETECTOR_NAME, detector_version: DETECTOR_VERSION, rule_version: RULE_VERSION,
      });

      await enqueueOperation({
        operationId: uuidv4(), attemptId, operationType: 'event_upsert', entityId: event.event_id,
        payload: buildEventPayload(full, 'confirmed'),
      });
    }
  }, [attemptId, captureEvidence]);

  // Track in-flight handlers so submission can wait for them (ordering before finalize).
  const handleCvEvent = useCallback((event) => {
    const p = processEvent(event).catch((e) => console.warn('[Proctoring] event handling failed:', e?.message));
    pendingRef.current.add(p);
    p.finally(() => pendingRef.current.delete(p));
    return p;
  }, [processEvent]);

  // Load real MediaPipe models (served locally from /models) with single authoritative threshold
  const initDetector = useCallback(async () => {
    if (isStoppedRef.current) return { ready: false, error: 'Stopped' };
    const effectiveThreshold = proctoringConfig?.phone_detection_threshold ?? 0.65;
    const det = new FrameDetectors({
      phoneThreshold: effectiveThreshold,
    });
    detectorRef.current = det;
    const status = await det.load();
    if (isStoppedRef.current) {
      det.close();
      detectorRef.current = null;
      return { ready: false, error: 'Stopped' };
    }
    setDetectorStatus({ ...status });
    if (!det.ready) {
      console.warn('[Proctoring Diagnostic] Detectors unavailable:', status.error);
    } else {
      console.log('[Proctoring Diagnostic] Detectors successfully loaded:', status);
    }
    return status;
  }, [proctoringConfig]);

  // Frame processing loop (non-overlapping; real inference only)
  const runFrameLoop = useCallback(async () => {
    if (isStoppedRef.current || isProcessingRef.current || !enabled) return;
    const det = detectorRef.current;
    if (!det?.ready || !managerRef.current?.isActive || !videoRef.current) return;
    const video = videoRef.current;
    if (video.readyState < 2) return; // not ready

    isProcessingRef.current = true;
    try {
      const result = await det.detect(video);
      // Abort if stopped while inference was running (Requirement: pending inference cannot create new events after exam ended)
      if (isStoppedRef.current || !enabled) return;
      setDetections(result);

      // Signals whose model is unavailable are null and are not evaluated by the engine
      engineRef.current?.processFrame({
        faceCount: result.faceCount,
        headYaw: result.yaw,
        headPitch: result.pitch,
        phoneDetections: result.phones,
      });

      // Non-blocking webcam frame relay for classroom instructor live preview (reuses existing video element)
      const nowMs = performance.now();
      if (nowMs - lastWebcamStreamRef.current >= 1000) {
        lastWebcamStreamRef.current = nowMs;
        try {
          if (!streamCanvasRef.current && typeof document !== 'undefined') {
            streamCanvasRef.current = document.createElement('canvas');
            streamCanvasRef.current.width = 160;
            streamCanvasRef.current.height = 120;
          }
          if (streamCanvasRef.current) {
            const ctx = streamCanvasRef.current.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, 160, 120);
              const dataUrl = streamCanvasRef.current.toDataURL('image/jpeg', 0.5);
              const b64 = dataUrl.split(',')[1];
              if (b64) {
                const bridgePort = (typeof window.electronAPI?.agentPort === 'function' ? window.electronAPI.agentPort() : null) || 41732;
                // Relay to local student agent bridge (fire-and-forget)
                fetch(`http://127.0.0.1:${bridgePort}/webcam-frame`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    attempt_id: attemptId,
                    image_b64: b64,
                    timestamp: new Date().toISOString(),
                  }),
                }).catch(() => {});
              }
            }
          }
        } catch {
          // ignore non-critical relay errors
        }
      }
    } catch (e) {
      console.warn('[Proctoring Diagnostic] Frame inference warning:', e.message);
    } finally {
      isProcessingRef.current = false;
    }
  }, [videoRef, enabled]);

  // Main effect: start camera + engine when enabled
  useEffect(() => {
    if (!enabled || !attemptId) {
      setCameraState('idle');
      return undefined;
    }

    const videoEl = videoRef?.current;
    if (!videoEl) {
      setCameraState('initializing');
      console.log('[Proctoring Diagnostic] Waiting for video element attachment...');
      return undefined;
    }

    isStoppedRef.current = false;
    let isCancelled = false;

    setCameraState('initializing');
    console.log(`[Proctoring Diagnostic] Starting proctoring pipeline for attempt: ${attemptId}`);

    const instant = (event_type, metadata = {}) => {
      if (isStoppedRef.current || isCancelled) return;
      const now = new Date().toISOString();
      handleCvEvent({
        event_id: uuidv4(), event_type, event_status: 'confirmed',
        client_started_at: now, client_ended_at: now, duration_ms: 0, phase: 'end', metadata,
      });
    };

    const camera = new CameraManager(videoEl, (state, err) => {
      if (isCancelled || isStoppedRef.current) return;
      if (['permission_denied', 'camera_unavailable', 'error'].includes(state)) {
        setCameraState(state);
        if (state === 'error' || state === 'camera_unavailable') {
          instant('camera_unavailable', { error: err });
        }
      }
    });
    managerRef.current = camera;

    const engine = new CVEventEngine(proctoringConfig, handleCvEvent);
    engineRef.current = engine;

    (async () => {
      try {
        console.log('[Proctoring Diagnostic] 1/3 Requesting camera stream...');
        await camera.start();
        if (isCancelled || isStoppedRef.current) return;

        console.log('[Proctoring Diagnostic] 2/3 Camera stream active. Initializing AI detection models...');
        const status = await initDetector();
        if (isCancelled || isStoppedRef.current) return;

        if (!detectorRef.current?.ready) {
          console.warn('[Proctoring Diagnostic] Detection models failed to become ready:', status?.error);
          setCameraState('detection_error');
          instant('camera_unavailable', { reason: 'detection_error', error: status?.error });
          return;
        }

        console.log('[Proctoring Diagnostic] 3/3 Both camera and models ready. Pipeline fully ACTIVE.');
        setCameraState('active');

        if (frameLoopRef.current) {
          clearInterval(frameLoopRef.current);
        }
        const sampleInterval = proctoringConfig?.live_sampling_interval_ms ?? FRAME_INTERVAL_MS;
        frameLoopRef.current = setInterval(runFrameLoop, sampleInterval);
      } catch (err) {
        if (isCancelled || isStoppedRef.current) return;
        const errName = err?.name || '';
        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
          console.warn('[Proctoring Diagnostic] Camera permission denied.');
          setCameraState('permission_denied');
        } else if (
          errName === 'NotFoundError' ||
          errName === 'DevicesNotFoundError' ||
          errName === 'NotReadableError' ||
          errName === 'TrackStartError'
        ) {
          console.warn('[Proctoring Diagnostic] Camera device unavailable or in use:', err.message);
          setCameraState('camera_unavailable');
          instant('camera_unavailable', { error: err.message });
        } else {
          console.warn('[Proctoring Diagnostic] Proctoring startup failure:', err.message);
          setCameraState('error');
          instant('camera_unavailable', { error: err.message });
        }
      }
    })();

    // Page visibility monitoring (recorded; a browser cannot prevent tab switching)
    const onVisibility = () => { if (document.hidden && !isStoppedRef.current) instant('page_hidden'); };
    document.addEventListener('visibilitychange', onVisibility);

    // Fullscreen monitoring (recorded; exiting never discards pending data)
    const onFullscreen = () => { if (!document.fullscreenElement && !isStoppedRef.current) instant('fullscreen_exit'); };
    document.addEventListener('fullscreenchange', onFullscreen);

    return () => {
      isCancelled = true;
      stopCamera();
      engine.flushActiveEvents();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [enabled, attemptId, proctoringConfig, videoRef?.current, handleCvEvent, initDetector, runFrameLoop, stopCamera]);

  return {
    cameraState,
    detectorStatus,
    detections,
    activeWarnings,
    eventCount,
    storageWarning,
    dismissWarning,
    captureSnapshot: () => managerRef.current?.captureSnapshot(),
    /** Close active episodes and wait until every event handler has persisted + enqueued. */
    flushEvents: async () => {
      engineRef.current?.flushActiveEvents();
      await Promise.allSettled([...pendingRef.current]);
    },
    stopCamera,
    cameraManager:   managerRef,
  };
}
