/**
 * ExamProctor.ai — Live Classroom Dashboard (CCTV-Style)
 *
 * Real-time instructor view aligned with ExamProctor Neo-Brutalism design system.
 * Features:
 *   - Overview: Session controls, live duration timer, student & alert stats
 *   - CCTV-style monitoring grid with layout switches: 2×2, 3×3, 4×4, Auto
 *   - Per-student card: Screen preview, circular webcam preview, active window pill, warning counters
 *   - Selected Student View: Full inspection modal with enlarged previews, device telemetry, timeline & controls
 *   - Alert Panel: Real-time event log with severity hierarchy & review actions
 *   - Command Modal: Broadcast or targeted workstation instructions
 *   - Dual connection: Persistent WebSocket with automatic REST fallback
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Monitor, Play, Pause, Square, MessageSquare, AlertTriangle, ShieldCheck,
  RefreshCw, Wifi, WifiOff, Clock, User, HardDrive, Eye, Maximize2, X,
  Radio, Check, Ban, ExternalLink, Activity, Send, Grid2X2, Grid3X3, LayoutGrid,
  Unlock, Download, Camera, FileText
} from 'lucide-react';
import classroomApi from '../../../services/classroomApi';
import { useAuth } from '../../../contexts/AuthContext';
import styles from './ClassroomDashboard.module.css';

// ── Severity & Status Badges ──────────────────────────────────────────────────
function SeverityBadge({ severity }) {
  if (severity === 'critical') {
    return <span className="badge badge-red">Critical</span>;
  }
  if (severity === 'high') {
    return <span className="badge badge-orange">High</span>;
  }
  if (severity === 'medium') {
    return <span className="badge badge-yellow">Medium</span>;
  }
  return <span className="badge badge-blue">Low</span>;
}

function ConnectionBadge({ status }) {
  if (status === 'online' || status === 'monitoring') {
    return (
      <span className="badge badge-green" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>
        <Wifi size={10} />
        {status === 'monitoring' ? 'Monitored' : 'Online'}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="badge badge-red" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>
        <AlertTriangle size={10} />
        Error
      </span>
    );
  }
  return (
    <span className="badge" style={{ fontSize: '0.7rem', padding: '2px 6px', color: 'var(--color-text-secondary)', background: 'var(--color-surface-alt)' }}>
      <WifiOff size={10} />
      Offline
    </span>
  );
}

// ── Elapsed Duration Formatter ────────────────────────────────────────────────
function useSessionTimer(startedAt, status) {
  const [duration, setDuration] = useState('00:00:00');

  useEffect(() => {
    if (!startedAt) {
      setDuration('Not started');
      return;
    }

    const calc = () => {
      const diffMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
      const totalSec = Math.floor(diffMs / 1000);
      const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
      const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
      const secs = String(totalSec % 60).padStart(2, '0');
      setDuration(`${hrs}:${mins}:${secs}`);
    };

    calc();
    if (status === 'active') {
      const id = setInterval(calc, 1000);
      return () => clearInterval(id);
    }
  }, [startedAt, status]);

  return duration;
}

// ── Student CCTV Monitoring Card (Requirement B & E) ──────────────────────────
function StudentCctvCard({
  card,
  screenFrame,
  webcamFrame,
  onSelect,
  onCommand,
  onViewAlerts,
  onEnlargeWebcam,
  onEnlargeScreen,
  selected,
}) {
  const isAlerted = card.unresolved_alert_count > 0;
  const isOffline = card.connection_status === 'offline';

  // Live screen stream source: WebSocket frame -> card snapshot -> stored thumbnail
  const screenSrc = screenFrame?.b64
    ? `data:image/jpeg;base64,${screenFrame.b64}`
    : card.latest_screen_frame
    ? `data:image/jpeg;base64,${card.latest_screen_frame}`
    : card.latest_frame_id
    ? classroomApi.getThumbnailUrl(card.device_id, card.latest_frame_id)
    : null;

  // Live webcam stream source: WebSocket frame -> card snapshot
  const webcamSrc = webcamFrame?.b64
    ? `data:image/jpeg;base64,${webcamFrame.b64}`
    : card.latest_webcam_frame
    ? `data:image/jpeg;base64,${card.latest_webcam_frame}`
    : null;

  const priorityScore = card.weighted_severity_score || 0;
  const priorityBadge =
    priorityScore >= 4 ? 'CRITICAL' : priorityScore >= 2.5 ? 'HIGH' : priorityScore > 0 ? 'MED' : 'LOW';

  return (
    <div
      className={`${styles.monitorCard} ${selected ? styles.monitorCardSelected : ''} ${isAlerted ? styles.monitorCardAlerted : ''} ${isOffline ? styles.monitorCardOffline : ''}`}
      onClick={() => onSelect(card)}
      id={`student-card-${card.device_id}`}
    >
      {/* Header */}
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.workstationLabel}>
            {card.workstation_label || card.device_hostname || 'Workstation'}
          </div>
          <div className={styles.studentIdent} title={card.student_name || card.student_usn || 'Unassigned'}>
            {card.student_name ? `${card.student_name} ${card.student_usn ? `(${card.student_usn})` : ''}` : 'Unassigned Workstation'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span
            className="badge"
            style={{ fontSize: '0.65rem', padding: '2px 5px', background: 'var(--color-surface-alt)', border: '1px solid var(--color-border)' }}
          >
            {card.attempt_id ? 'In Exam' : 'Assigned'}
          </span>
          <ConnectionBadge status={card.connection_status} />
        </div>
      </div>

      {/* CCTV Screen Preview Area (16:9) */}
      <div className={styles.screenPreviewContainer}>
        {screenSrc && !isOffline ? (
          <img
            src={screenSrc}
            alt={`Screen of ${card.device_hostname}`}
            className={styles.screenImage}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className={styles.cctvStandby}>
            <Monitor size={28} className={styles.standbyIcon} />
            <div className={styles.standbyStatus}>
              {isOffline ? '[WORKSTATION DISCONNECTED]' : '[CCTV LIVE FEED READY]'}
            </div>
            <div style={{ fontSize: '0.65rem', opacity: 0.8 }}>
              {card.active_process || card.active_window_title || 'Awaiting application activity'}
            </div>
          </div>
        )}

        {/* Quick Screen Enlarge Button */}
        {screenSrc && !isOffline && (
          <button
            type="button"
            className={styles.screenEnlargeBtn}
            title="Enlarge desktop screen feed"
            onClick={(e) => {
              e.stopPropagation();
              onEnlargeScreen({ card, src: screenSrc });
            }}
          >
            <Maximize2 size={13} />
          </button>
        )}

        {/* Small Circular Webcam Preview Badge — Click independently enlarges webcam (Part B & E) */}
        <div
          className={styles.webcamOverlay}
          title={`Click to independently enlarge webcam: ${card.student_name || 'Student'}`}
          onClick={(e) => {
            e.stopPropagation();
            onEnlargeWebcam({ card, src: webcamSrc });
          }}
        >
          {webcamSrc && !isOffline ? (
            <img
              src={webcamSrc}
              alt="Cam"
              className={styles.webcamImg}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <div className={styles.webcamPlaceholder}>
              <User size={20} />
            </div>
          )}
        </div>

        {/* Active process / window title badge */}
        <div className={styles.activeProcessPill} title={card.active_window_title || card.active_process}>
          {card.active_process ? `▶ ${card.active_process}` : 'Idle / Inactive'}
        </div>
      </div>

      {/* Warning counters bar */}
      <div className={styles.warningBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {isAlerted ? (
            <span className={`${styles.warningBadge} ${styles.warningBadgeAlert}`}>
              <AlertTriangle size={12} />
              <span>
                {card.unresolved_alert_count} Warning{card.unresolved_alert_count !== 1 ? 's' : ''} ({priorityBadge})
              </span>
            </span>
          ) : (
            <span className={`${styles.warningBadge} ${styles.warningBadgeClean}`}>
              <ShieldCheck size={12} />
              <span>Clean</span>
            </span>
          )}
        </div>

        <div className={styles.heartbeatText}>
          {card.last_heartbeat_at ? `${new Date(card.last_heartbeat_at).toLocaleTimeString()}` : 'No heartbeat'}
        </div>
      </div>

      {/* Footer Actions */}
      <div className={styles.cardFooter}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect(card);
          }}
          className="btn btn-secondary btn-sm"
          style={{ flex: 1 }}
          title="Inspect Student Workstation"
        >
          <Eye size={12} />
          <span>Inspect</span>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onCommand(card, 'send_message');
          }}
          className="btn btn-secondary btn-sm"
          title="Send Message"
        >
          <MessageSquare size={12} />
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onCommand(card, 'send_warning');
          }}
          className="btn btn-secondary btn-sm"
          title="Send Warning"
        >
          <AlertTriangle size={12} />
        </button>

        {card.unresolved_alert_count > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onViewAlerts(card);
            }}
            className="btn btn-danger btn-sm"
            title="View Alerts"
          >
            <AlertTriangle size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Standalone Enlarged Webcam Preview Modal (Requirement B9 & E) ──────────────
function EnlargedWebcamModal({ item, onClose }) {
  if (!item || !item.card) return null;
  const { card, src } = item;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.independentModalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <User size={20} style={{ color: 'var(--color-blue)' }} />
            <div>
              <div className={styles.modalTitle}>
                Independent Webcam Feed — {card.student_name || 'Student'} ({card.workstation_label || card.device_hostname})
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {card.student_usn ? `USN: ${card.student_usn} • ` : ''}Workstation: {card.device_hostname}
              </div>
            </div>
          </div>
          <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        <div className={styles.webcamSquarePreview}>
          {src ? (
            <img src={src} alt="Enlarged Webcam Preview" />
          ) : (
            <div style={{ textAlign: 'center', color: '#94a3b8' }}>
              <User size={64} style={{ margin: '0 auto var(--space-2)' }} />
              <div>No active webcam stream available for this workstation</div>
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button onClick={onClose} className="btn btn-primary">
            Close Webcam View
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Standalone Enlarged Screen Preview Modal (Requirement B8) ───────────────────
function EnlargedScreenModal({ item, onClose, onRefresh }) {
  if (!item || !item.card) return null;
  const { card, src } = item;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.independentModalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Monitor size={20} style={{ color: 'var(--color-blue)' }} />
            <div>
              <div className={styles.modalTitle}>
                Live Desktop Screen — {card.student_name || 'Student'} ({card.workstation_label || card.device_hostname})
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Active Window: {card.active_window_title || card.active_process || 'Desktop'}
              </div>
            </div>
          </div>
          <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        <div className={styles.mediaLargePreview}>
          {src ? (
            <img src={src} alt="Enlarged Screen Stream" />
          ) : (
            <div style={{ textAlign: 'center', color: '#94a3b8' }}>
              <Monitor size={64} style={{ margin: '0 auto var(--space-2)' }} />
              <div>No screen stream available</div>
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button
            onClick={() => onRefresh(card)}
            className="btn btn-secondary"
            title="Request fresh frame from agent"
          >
            <RefreshCw size={14} />
            <span>Request Screen Refresh</span>
          </button>
          <button onClick={onClose} className="btn btn-primary">
            Close Screen View
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Selected Student Detailed View Modal (Requirement C & Part B) ─────────────
function SelectedStudentModal({ card, screenFrame, webcamFrame, session, onClose, onCommand }) {
  if (!card) return null;

  const [activeTab, setActiveTab] = useState('telemetry'); // 'telemetry' | 'timeline' | 'evidence'
  const [deviceAlerts, setDeviceAlerts] = useState([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);

  useEffect(() => {
    let active = true;
    if (activeTab === 'timeline' || activeTab === 'evidence') {
      setLoadingAlerts(true);
      classroomApi.listAlerts(session.session_id, { device_id: card.device_id, limit: 50 })
        .then(({ data }) => {
          if (active) setDeviceAlerts(data.data || []);
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoadingAlerts(false);
        });
    }
    return () => { active = false; };
  }, [activeTab, session.session_id, card.device_id]);

  const isOffline = card.connection_status === 'offline';
  const screenSrc = screenFrame?.b64
    ? `data:image/jpeg;base64,${screenFrame.b64}`
    : card.latest_screen_frame
    ? `data:image/jpeg;base64,${card.latest_screen_frame}`
    : card.latest_frame_id
    ? classroomApi.getThumbnailUrl(card.device_id, card.latest_frame_id)
    : null;

  const webcamSrc = webcamFrame?.b64
    ? `data:image/jpeg;base64,${webcamFrame.b64}`
    : card.latest_webcam_frame
    ? `data:image/jpeg;base64,${card.latest_webcam_frame}`
    : null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={`${styles.modalContent} ${styles.studentModalWide}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Monitor size={22} style={{ color: 'var(--color-blue)' }} />
            <div>
              <div className={styles.modalTitle}>
                {card.student_name || 'Unassigned Workstation'} — {card.workstation_label || card.device_hostname}
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {card.student_usn ? `USN: ${card.student_usn} • ` : ''}Room: {card.room_name || session?.room_name || 'Laboratory'}
              </div>
            </div>
          </div>

          <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        {/* Tab Selection */}
        <div className={styles.tabRow}>
          <button
            type="button"
            className={`${styles.tabItem} ${activeTab === 'telemetry' ? styles.tabItemActive : ''}`}
            onClick={() => setActiveTab('telemetry')}
          >
            Workstation Telemetry
          </button>
          <button
            type="button"
            className={`${styles.tabItem} ${activeTab === 'timeline' ? styles.tabItemActive : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            Event Timeline
          </button>
          <button
            type="button"
            className={`${styles.tabItem} ${activeTab === 'evidence' ? styles.tabItemActive : ''}`}
            onClick={() => setActiveTab('evidence')}
          >
            Evidence & Snapshots
          </button>
        </div>

        <div className={styles.studentDetailGrid}>
          {/* Left Column: Screen Preview & Webcam Preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className={styles.detailScreenContainer}>
              {screenSrc && !isOffline ? (
                <img
                  src={screenSrc}
                  alt={`Enlarged screen of ${card.device_hostname}`}
                  className={styles.screenImage}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <div className={styles.cctvStandby} style={{ height: '100%' }}>
                  <Monitor size={48} className={styles.standbyIcon} />
                  <div className={styles.standbyStatus}>
                    {isOffline ? '[WORKSTATION DISCONNECTED]' : 'LIVE CCTV SCREEN STREAM'}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-xs)', maxWidth: 320 }}>
                    Active Window: {card.active_window_title || card.active_process || 'Full Desktop Surface'}
                  </div>
                </div>
              )}

              {/* Enlarged Webcam Feed Preview (Requirement C) */}
              <div className={styles.detailWebcamContainer}>
                {webcamSrc && !isOffline ? (
                  <img
                    src={webcamSrc}
                    alt="Webcam Preview"
                    className={styles.webcamImg}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <div style={{ textAlign: 'center', color: '#cbd5e1' }}>
                    <User size={32} />
                    <div style={{ fontSize: '0.65rem', fontWeight: 'bold' }}>CAM FEED</div>
                  </div>
                )}
              </div>
            </div>

            {/* Quick Actions Bar (Part B Controls) */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => onCommand(card, 'send_message')}
                className="btn btn-primary btn-sm"
                title="Send notification to student"
              >
                <MessageSquare size={13} />
                <span>Message</span>
              </button>
              <button
                type="button"
                onClick={() => onCommand(card, 'send_warning')}
                className="btn btn-orange btn-sm"
                title="Send warning notice"
              >
                <AlertTriangle size={13} />
                <span>Warn</span>
              </button>
              <button
                type="button"
                onClick={() => onCommand(card, 'request_screen_refresh')}
                className="btn btn-secondary btn-sm"
                title="Request immediate screen refresh"
              >
                <RefreshCw size={13} />
                <span>Refresh Frame</span>
              </button>
              <button
                type="button"
                onClick={() => onCommand(card, 'enforce_focus')}
                className="btn btn-secondary btn-sm"
                title="Enforce application focus"
              >
                <Radio size={13} />
                <span>Focus</span>
              </button>
              <button
                type="button"
                onClick={() => onCommand(card, 'lock_workstation')}
                className="btn btn-danger btn-sm"
                title="Lock workstation screen"
              >
                <Ban size={13} />
                <span>Lock Desk</span>
              </button>
              <button
                type="button"
                onClick={() => onCommand(card, 'unlock_workstation')}
                className="btn btn-success btn-sm"
                title="Unlock workstation screen"
              >
                <Unlock size={13} />
                <span>Unlock</span>
              </button>
            </div>
          </div>

          {/* Right Column: Dynamic Content based on active tab */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {activeTab === 'telemetry' && (
              <>
                <div className="card" style={{ padding: 'var(--space-4)' }}>
                  <h4 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800, marginBottom: 'var(--space-3)' }}>
                    Workstation Telemetry
                  </h4>
                  <div className={styles.infoRow}>
                    <span className={styles.infoKey}>Connection Status:</span>
                    <span className={styles.infoVal}><ConnectionBadge status={card.connection_status} /></span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoKey}>Hostname:</span>
                    <span className={styles.infoVal}>{card.device_hostname}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoKey}>Device UUID:</span>
                    <span className={styles.infoVal}>{card.device_id.slice(0, 14)}…</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoKey}>Active Process:</span>
                    <span className={styles.infoVal}>{card.active_process || 'None'}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoKey}>Last Heartbeat:</span>
                    <span className={styles.infoVal}>
                      {card.last_heartbeat_at ? new Date(card.last_heartbeat_at).toLocaleTimeString() : 'Never'}
                    </span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoKey}>Severity Score:</span>
                    <span className={styles.infoVal} style={{ color: card.weighted_severity_score > 4 ? 'var(--color-red)' : 'inherit' }}>
                      {card.weighted_severity_score?.toFixed(1) || '0.0'}
                    </span>
                  </div>
                </div>

                <div className="card" style={{ padding: 'var(--space-4)' }}>
                  <h4 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800, marginBottom: 'var(--space-2)' }}>
                    Active Warnings ({card.unresolved_alert_count || 0})
                  </h4>
                  {card.unresolved_alert_count === 0 ? (
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-green)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Check size={16} /> No integrity violations reported.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      {Object.entries(card.alert_summary || {}).map(([type, cnt]) => (
                        <span key={type} className="badge badge-red">
                          {type.replace(/_/g, ' ')}: {cnt}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {activeTab === 'timeline' && (
              <div className="card" style={{ padding: 'var(--space-4)' }}>
                <h4 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800, marginBottom: 'var(--space-3)' }}>
                  Chronological Event Timeline
                </h4>
                {loadingAlerts ? (
                  <div style={{ textAlign: 'center', padding: 'var(--space-4)' }}>Loading timeline…</div>
                ) : deviceAlerts.length === 0 ? (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'center', padding: 'var(--space-4)' }}>
                    No events or violations detected for this workstation.
                  </div>
                ) : (
                  <div className={styles.timelineList}>
                    {deviceAlerts.map((ev) => (
                      <div key={ev.alert_id} className={styles.timelineEntry}>
                        <SeverityBadge severity={ev.severity} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 700, color: 'var(--color-text-heading)' }}>
                            {ev.alert_type.replace(/_/g, ' ').toUpperCase()}
                          </div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
                            {ev.description}
                          </div>
                        </div>
                        <span style={{ fontSize: '0.65rem', color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>
                          {new Date(ev.detected_at).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'evidence' && (
              <div className="card" style={{ padding: 'var(--space-4)' }}>
                <h4 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800, marginBottom: 'var(--space-3)' }}>
                  Captured Evidence & Snapshots
                </h4>
                <div className={styles.evidenceGrid}>
                  <div className={styles.evidenceThumb}>
                    {screenSrc ? <img src={screenSrc} alt="Screen Evidence" /> : <div style={{ color: '#fff', fontSize: '0.6rem', padding: 4 }}>Screen Stream</div>}
                    <div style={{ background: '#1e293b', color: '#fff', fontSize: '0.6rem', padding: '2px 4px' }}>Latest Screen</div>
                  </div>
                  <div className={styles.evidenceThumb}>
                    {webcamSrc ? <img src={webcamSrc} alt="Webcam Evidence" /> : <div style={{ color: '#fff', fontSize: '0.6rem', padding: 4 }}>Webcam Feed</div>}
                    <div style={{ background: '#1e293b', color: '#fff', fontSize: '0.6rem', padding: '2px 4px' }}>Latest Webcam</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={styles.modalFooter}>
          <button onClick={onClose} className="btn btn-secondary">
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Alert Slide-over Panel (Requirement D) ────────────────────────────────────
function AlertDrawer({ sessionId, device, onClose }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await classroomApi.listAlerts(sessionId, {
        device_id: device?.device_id,
        status: 'unreviewed',
        limit: 50,
      });
      setAlerts(data.data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [sessionId, device]);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = async (alertId, status) => {
    try {
      await classroomApi.reviewAlert(sessionId, alertId, { resolution_status: status });
      await load();
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Failed to update alert.');
    }
  };

  return (
    <div className={styles.alertDrawer}>
      <div className={styles.alertDrawerHeader}>
        <div className={styles.alertDrawerTitle}>
          <AlertTriangle size={18} />
          <span>Active Alerts {device ? `(${device.workstation_label || device.device_hostname})` : ''}</span>
        </div>
        <button onClick={onClose} className={styles.alertDrawerClose} aria-label="Close alerts">
          <X size={20} />
        </button>
      </div>

      <div className={styles.alertDrawerBody}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
            <div className="spinner" style={{ margin: '0 auto var(--space-2)' }} />
            <span style={{ fontSize: 'var(--font-size-xs)' }}>Loading alerts…</span>
          </div>
        )}

        {!loading && alerts.length === 0 && (
          <div style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--color-text-secondary)' }}>
            <ShieldCheck size={40} style={{ color: 'var(--color-green)', margin: '0 auto var(--space-2)' }} />
            <div style={{ fontWeight: 700, color: 'var(--color-text-heading)' }}>All Clean</div>
            <div style={{ fontSize: 'var(--font-size-xs)' }}>No unreviewed violation alerts for this session.</div>
          </div>
        )}

        {alerts.map((a) => (
          <div key={a.alert_id} className={styles.alertItem}>
            <div className={styles.alertItemHeader}>
              <SeverityBadge severity={a.severity} />
              <span className={styles.alertTimestamp}>
                {new Date(a.detected_at).toLocaleTimeString()}
              </span>
            </div>

            <div style={{ fontWeight: 'var(--font-weight-bold)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-heading)' }}>
              {a.alert_type.replace(/_/g, ' ').toUpperCase()}
            </div>

            <p className={styles.alertDesc}>{a.description}</p>

            <div className={styles.alertActions}>
              <button
                onClick={() => resolve(a.alert_id, 'acknowledged')}
                className="btn btn-success btn-sm"
                style={{ flex: 1 }}
              >
                <Check size={12} />
                <span>Acknowledge</span>
              </button>
              <button
                onClick={() => resolve(a.alert_id, 'confirmed_violation')}
                className="btn btn-danger btn-sm"
                style={{ flex: 1 }}
              >
                <AlertTriangle size={12} />
                <span>Flag Violation</span>
              </button>
              <button
                onClick={() => resolve(a.alert_id, 'dismissed')}
                className="btn btn-secondary btn-sm"
              >
                <span>Dismiss</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Command Modal (Targeted / Broadcast — Part B Controls) ──────────────────────
function CommandModal({ session, card, onClose, initialType = null }) {
  const [form, setForm] = useState({
    command_type: initialType || (card ? 'send_message' : 'broadcast_notice'),
    message: '',
    apps: '',
    domains: '',
  });
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [lastAck, setLastAck] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = { message: form.message };
      if (form.apps) {
        payload.blocked_processes = form.apps.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (form.domains) {
        payload.blocked_domains = form.domains.split(',').map((s) => s.trim()).filter(Boolean);
      }

      const res = await classroomApi.issueCommand(session.session_id, {
        target_device_id: card?.device_id || null,
        command_type: form.command_type,
        payload,
      });

      setLastAck(res.data?.data);
      setSent(true);
      setTimeout(onClose, 1400);
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Failed to dispatch command.');
    } finally {
      setLoading(false);
    }
  };

  const COMMANDS = [
    { value: 'send_message', label: '💬 Send Notification Message' },
    { value: 'send_warning', label: '⚠️ Send Proctoring Warning' },
    { value: 'broadcast_notice', label: '📢 Broadcast Notice to All Desks' },
    { value: 'request_screen_refresh', label: '📸 Request Screen Refresh' },
    { value: 'force_refresh', label: '🔄 Force Browser/App Refresh' },
    { value: 'enforce_focus', label: '🔒 Enforce Application Focus' },
    { value: 'lock_workstation', label: '🚫 Lock Workstation Screen' },
    { value: 'unlock_workstation', label: '🔓 Unlock Workstation Screen' },
    { value: 'restrict_apps', label: '🛑 Restrict Configured Applications' },
    { value: 'restrict_websites', label: '🌐 Restrict Configured Websites' },
  ];

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalTitle}>
            {card ? `Dispatch Command → ${card.workstation_label || card.device_hostname}` : '📢 Broadcast Notice to All Desks'}
          </div>
          <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        {sent ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
            <div style={{ fontSize: 40, marginBottom: 'var(--space-2)' }}>✅</div>
            <div style={{ fontWeight: 800, fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)' }}>
              Command Dispatched & Acknowledged!
            </div>
            {lastAck?.delivery_status && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)' }}>
                Delivery Status: <strong>{lastAck.delivery_status.toUpperCase()}</strong>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="select-command-type">Command Action</label>
              <select
                id="select-command-type"
                className="form-select"
                value={form.command_type}
                onChange={(e) => setForm((f) => ({ ...f, command_type: e.target.value }))}
              >
                {COMMANDS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            {['send_message', 'send_warning', 'broadcast_notice'].includes(form.command_type) && (
              <div className="form-group">
                <label className="form-label" htmlFor="input-command-msg">Message Content</label>
                <textarea
                  id="input-command-msg"
                  className="form-textarea"
                  value={form.message}
                  onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                  placeholder="Type proctoring instructions or warnings for the student…"
                  rows={3}
                  required
                />
              </div>
            )}

            {form.command_type === 'restrict_apps' && (
              <div className="form-group">
                <label className="form-label" htmlFor="input-command-apps">Restricted Process Names (comma-separated)</label>
                <input
                  id="input-command-apps"
                  className="form-input"
                  value={form.apps}
                  onChange={(e) => setForm((f) => ({ ...f, apps: e.target.value }))}
                  placeholder="e.g. discord.exe, telegram.exe, code.exe"
                  required
                />
              </div>
            )}

            {form.command_type === 'restrict_websites' && (
              <div className="form-group">
                <label className="form-label" htmlFor="input-command-domains">Restricted Domain Names (comma-separated)</label>
                <input
                  id="input-command-domains"
                  className="form-input"
                  value={form.domains}
                  onChange={(e) => setForm((f) => ({ ...f, domains: e.target.value }))}
                  placeholder="e.g. chatgpt.com, claude.ai, stackoverflow.com"
                  required
                />
              </div>
            )}

            <div className={styles.modalFooter}>
              <button type="button" onClick={onClose} className="btn btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={loading} className="btn btn-primary">
                <Send size={14} />
                <span>{loading ? 'Transmitting…' : 'Transmit Command'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}


// ── Main Classroom Dashboard Component ─────────────────────────────────────────
export default function ClassroomDashboard() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [session, setSession] = useState(null);
  const [grid, setGrid] = useState([]);
  const [screenFrames, setScreenFrames] = useState({}); // device_id -> { b64, timestamp }
  const [webcamFrames, setWebcamFrames] = useState({}); // device_id -> { b64, timestamp }
  const [loading, setLoading] = useState(true);
  const [wsStatus, setWsStatus] = useState('connecting');
  const [alertPanel, setAlertPanel] = useState(null);
  const [commandModal, setCommandModal] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [enlargedWebcam, setEnlargedWebcam] = useState(null);
  const [enlargedScreen, setEnlargedScreen] = useState(null);
  const [sortMode, setSortMode] = useState('priority'); // priority | alphabetical | join_time | latest_activity
  const [statusFilter, setStatusFilter] = useState('all');
  const [layoutMode, setLayoutMode] = useState('auto'); // 2x2 | 3x3 | 4x4 | 6x6 | auto
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const wsRef = useRef(null);
  const pollRef = useRef(null);

  // Load session information
  const loadSession = useCallback(async () => {
    try {
      const res = await classroomApi.getSession(sessionId);
      setSession(res.data.data);
    } catch {
      navigate('/professor/classroom');
    }
  }, [sessionId, navigate]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Live session timer
  const sessionDuration = useSessionTimer(session?.started_at, session?.status);

  // REST polling fallback
  const pollGrid = useCallback(async () => {
    try {
      const { data } = await classroomApi.getGrid(sessionId);
      const items = data.data || [];
      setGrid(items);
      items.forEach((card) => {
        if (card.latest_screen_frame) {
          setScreenFrames((prev) => ({
            ...prev,
            [card.device_id]: prev[card.device_id] || { b64: card.latest_screen_frame, timestamp: card.last_screen_at },
          }));
        }
        if (card.latest_webcam_frame) {
          setWebcamFrames((prev) => ({
            ...prev,
            [card.device_id]: prev[card.device_id] || { b64: card.latest_webcam_frame, timestamp: card.last_webcam_at },
          }));
        }
      });
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  // Session controls (Start, Pause, Resume, End)
  const handleSessionAction = async (action) => {
    setActionLoading(true);
    try {
      if (action === 'start') await classroomApi.startSession(sessionId);
      if (action === 'pause') await classroomApi.pauseSession(sessionId);
      if (action === 'end') {
        if (!window.confirm('End this classroom session? This will finalize proctoring for all computers.')) return;
        await classroomApi.endSession(sessionId);
      }
      await loadSession();
      await pollGrid();
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Session action failed.');
    } finally {
      setActionLoading(false);
    }
  };

  // WebSocket Subscription
  useEffect(() => {
    const token = localStorage.getItem('ep_access_token');
    const serverBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000')
      .replace('http://', 'ws://')
      .replace('https://', 'wss://');
    const wsUrl = `${serverBase}/classroom/ws/${sessionId}?token=${token}`;

    let ws;
    let reconnectTimer;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
        setLoading(false);
        clearInterval(pollRef.current);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'grid_update') {
            const items = msg.data || [];
            setGrid(items);
            items.forEach((card) => {
              if (card.latest_screen_frame) {
                setScreenFrames((prev) => ({
                  ...prev,
                  [card.device_id]: { b64: card.latest_screen_frame, timestamp: card.last_screen_at },
                }));
              }
              if (card.latest_webcam_frame) {
                setWebcamFrames((prev) => ({
                  ...prev,
                  [card.device_id]: { b64: card.latest_webcam_frame, timestamp: card.last_webcam_at },
                }));
              }
            });
          } else if (msg.type === 'screen_frame') {
            setScreenFrames((prev) => ({
              ...prev,
              [msg.device_id]: { b64: msg.image_b64, timestamp: msg.timestamp },
            }));
          } else if (msg.type === 'webcam_frame') {
            setWebcamFrames((prev) => ({
              ...prev,
              [msg.device_id]: { b64: msg.image_b64, timestamp: msg.timestamp },
            }));
          } else if (msg.type === 'alert') {
            pollGrid();
          }
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        setWsStatus('reconnecting');
        pollGrid();
        pollRef.current = setInterval(pollGrid, 5000);
        reconnectTimer = setTimeout(connect, 5000);
      };

      ws.onerror = () => {
        setWsStatus('error');
      };
    };

    pollGrid().then(() => setLoading(false));
    pollRef.current = setInterval(pollGrid, 5000);
    connect();

    return () => {
      clearTimeout(reconnectTimer);
      clearInterval(pollRef.current);
      ws?.close();
    };
  }, [sessionId, pollGrid]);

  // Aggregate Metrics
  const totalStudents = grid.length;
  const connectedCount = grid.filter((c) => c.connection_status === 'online' || c.connection_status === 'monitoring').length;
  const offlineCount = grid.filter((c) => c.connection_status === 'offline').length;
  const totalAlerts = grid.reduce((s, c) => s + (c.unresolved_alert_count || 0), 0);
  const activeWarningsCount = grid.filter((c) => c.unresolved_alert_count > 0).length;

  // Filter & Search & Sort
  const filteredGrid = useMemo(() => {
    let result = grid.filter((c) => {
      if (statusFilter === 'alerted' && c.unresolved_alert_count === 0) return false;
      if (statusFilter === 'online' && c.connection_status === 'offline') return false;
      if (statusFilter === 'offline' && c.connection_status !== 'offline') return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchName = (c.student_name || '').toLowerCase().includes(q);
        const matchUsn = (c.student_usn || '').toLowerCase().includes(q);
        const matchWs = (c.workstation_label || '').toLowerCase().includes(q);
        const matchHost = (c.device_hostname || '').toLowerCase().includes(q);
        return matchName || matchUsn || matchWs || matchHost;
      }
      return true;
    });

    return [...result].sort((a, b) => {
      if (sortMode === 'priority') {
        const pDiff = (b.weighted_severity_score || 0) - (a.weighted_severity_score || 0);
        if (pDiff !== 0) return pDiff;
        return (b.unresolved_alert_count || 0) - (a.unresolved_alert_count || 0);
      }
      if (sortMode === 'alphabetical') {
        const nameA = a.student_name || a.workstation_label || a.device_hostname || '';
        const nameB = b.student_name || b.workstation_label || b.device_hostname || '';
        return nameA.localeCompare(nameB);
      }
      if (sortMode === 'latest_activity') {
        const timeA = new Date(a.last_heartbeat_at || 0).getTime();
        const timeB = new Date(b.last_heartbeat_at || 0).getTime();
        return timeB - timeA;
      }
      if (sortMode === 'join_time') {
        const timeA = new Date(a.assigned_at || a.created_at || 0).getTime();
        const timeB = new Date(b.assigned_at || b.created_at || 0).getTime();
        return timeA - timeB;
      }
      return 0;
    });
  }, [grid, statusFilter, searchQuery, sortMode]);

  // Layout CSS Class (2x2, 3x3, 4x4, 6x6, Auto)
  const layoutClass =
    layoutMode === '2x2' ? styles.grid2x2 :
    layoutMode === '3x3' ? styles.grid3x3 :
    layoutMode === '4x4' ? styles.grid4x4 :
    layoutMode === '6x6' ? styles.grid6x6 :
    styles.gridAuto;

  return (
    <div className={styles.page}>
      {/* ── A. Classroom Overview & Header ─────────────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Link to="/professor/classroom" className={styles.backLink}>
            ← Back to Classroom Sessions
          </Link>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>
              🖥️ {session?.room_name || 'Classroom'} — CCTV Monitor
            </h1>
            {session && (
              <span className={`badge ${session.status === 'active' ? 'badge-green' : session.status === 'paused' ? 'badge-yellow' : 'badge-orange'}`}>
                {session.status.toUpperCase()}
              </span>
            )}
            <span
              className={`badge ${wsStatus === 'connected' ? 'badge-green' : 'badge-yellow'}`}
              title="Real-time WebSocket connection state"
            >
              <Activity size={12} />
              {wsStatus === 'connected' ? 'Live Telemetry' : 'Polling Sync'}
            </span>
          </div>
        </div>

        {/* Overview Action Controls */}
        <div className={styles.headerActions}>
          {session?.status === 'pending' && (
            <button
              onClick={() => handleSessionAction('start')}
              disabled={actionLoading}
              className="btn btn-success btn-sm"
              id="btn-session-start"
            >
              <Play size={14} />
              <span>Start Session</span>
            </button>
          )}

          {session?.status === 'active' && (
            <>
              <button
                onClick={() => handleSessionAction('pause')}
                disabled={actionLoading}
                className="btn btn-orange btn-sm"
                id="btn-session-pause"
              >
                <Pause size={14} />
                <span>Pause</span>
              </button>
              <button
                onClick={() => handleSessionAction('end')}
                disabled={actionLoading}
                className="btn btn-danger btn-sm"
                id="btn-session-end"
              >
                <Square size={14} />
                <span>End Session</span>
              </button>
            </>
          )}

          {session?.status === 'paused' && (
            <button
              onClick={() => handleSessionAction('start')}
              disabled={actionLoading}
              className="btn btn-success btn-sm"
              id="btn-session-resume"
            >
              <Play size={14} />
              <span>Resume Session</span>
            </button>
          )}

          <a
            href={classroomApi.getReportDownloadUrl(sessionId, 'json')}
            download={`classroom_session_${sessionId?.slice(0, 8)}_report.json`}
            className="btn btn-secondary btn-sm"
            id="btn-export-session-report"
            title="Download Session Report (JSON)"
          >
            <Download size={14} />
            <span>Export Report</span>
          </a>

          <button
            onClick={() => setCommandModal({ card: null })}
            className="btn btn-primary btn-sm"
            id="btn-broadcast-command"
          >
            <Radio size={14} />
            <span>Broadcast Command</span>
          </button>

          <button
            onClick={() => setAlertPanel({})}
            className={`btn btn-sm ${totalAlerts > 0 ? 'btn-danger' : 'btn-secondary'}`}
            id="btn-toggle-alerts"
          >
            <AlertTriangle size={14} />
            <span>{totalAlerts} Alerts</span>
          </button>
        </div>
      </div>

      {/* ── Stats Metric Cards (Requirement A) ─────────────────────────────── */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: 'var(--color-blue)' }}>{connectedCount}</div>
          <div className={styles.statLabel}>Connected Students</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: offlineCount > 0 ? 'var(--color-orange)' : 'var(--color-text-secondary)' }}>
            {offlineCount}
          </div>
          <div className={styles.statLabel}>Disconnected</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: totalAlerts > 0 ? 'var(--color-red)' : 'var(--color-green)' }}>
            {totalAlerts}
          </div>
          <div className={styles.statLabel}>Total Alerts</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: activeWarningsCount > 0 ? 'var(--color-orange)' : 'var(--color-text-heading)' }}>
            {activeWarningsCount}
          </div>
          <div className={styles.statLabel}>Active Warnings</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: 'var(--color-text-heading)', fontFamily: 'monospace' }}>
            {sessionDuration}
          </div>
          <div className={styles.statLabel}>Session Duration</div>
        </div>
      </div>

      {/* ── Toolbar: Filters, Search, Sorting & CCTV Grid Layout Selector ─── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          {/* Status Filter Tabs */}
          {[
            { key: 'all', label: `All (${totalStudents})` },
            { key: 'online', label: `Online (${connectedCount})` },
            { key: 'alerted', label: `Alerted (${activeWarningsCount})` },
            { key: 'offline', label: `Offline (${offlineCount})` },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`btn btn-sm ${statusFilter === tab.key ? 'btn-primary' : 'btn-secondary'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={styles.toolbarRight}>
          {/* Sorting Dropdown */}
          <select
            className="form-select"
            style={{ padding: '6px 10px', fontSize: 'var(--font-size-xs)', width: 160 }}
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value)}
            title="Sort workstations"
          >
            <option value="priority">Sort: Warning Priority</option>
            <option value="alphabetical">Sort: Alphabetical</option>
            <option value="latest_activity">Sort: Latest Activity</option>
            <option value="join_time">Sort: Join Time</option>
          </select>

          {/* Search Bar */}
          <input
            type="text"
            className="form-input"
            style={{ padding: '6px 12px', fontSize: 'var(--font-size-xs)', width: 200 }}
            placeholder="Search student or workstation…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          {/* Layout Mode Selector (2x2, 3x3, 4x4, 6x6, Auto) */}
          <div className={styles.layoutSelector} title="CCTV Grid Layout">
            <button
              className={`${styles.layoutBtn} ${layoutMode === '2x2' ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode('2x2')}
            >
              2×2
            </button>
            <button
              className={`${styles.layoutBtn} ${layoutMode === '3x3' ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode('3x3')}
            >
              3×3
            </button>
            <button
              className={`${styles.layoutBtn} ${layoutMode === '4x4' ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode('4x4')}
            >
              4×4
            </button>
            <button
              className={`${styles.layoutBtn} ${layoutMode === '6x6' ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode('6x6')}
            >
              6×6
            </button>
            <button
              className={`${styles.layoutBtn} ${layoutMode === 'auto' ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode('auto')}
            >
              Auto
            </button>
          </div>
        </div>
      </div>

      {/* ── B. Live Student Monitoring Grid (Requirement B) ─────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Connecting live CCTV matrix…</p>
        </div>
      ) : filteredGrid.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <Monitor size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Students Found in Current Matrix
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 420, margin: '0 auto' }}>
            {grid.length === 0
              ? 'No student workstations have been assigned to this session yet. Enroll and assign student PCs to monitor.'
              : 'No workstations matched the selected filters.'}
          </p>
        </div>
      ) : (
        <div className={`${styles.cctvGrid} ${layoutClass}`}>
          {filteredGrid.map((card) => (
            <StudentCctvCard
              key={card.device_id}
              card={card}
              screenFrame={screenFrames[card.device_id]}
              webcamFrame={webcamFrames[card.device_id]}
              selected={selectedStudent?.device_id === card.device_id}
              onSelect={setSelectedStudent}
              onCommand={(c, type) => setCommandModal({ card: c, initialType: type })}
              onViewAlerts={(c) => setAlertPanel(c)}
              onEnlargeWebcam={setEnlargedWebcam}
              onEnlargeScreen={setEnlargedScreen}
            />
          ))}
        </div>
      )}

      {/* ── Independent Enlarged Webcam Modal (Requirement B9 & E) ─────────── */}
      {enlargedWebcam && (
        <EnlargedWebcamModal
          item={enlargedWebcam}
          onClose={() => setEnlargedWebcam(null)}
        />
      )}

      {/* ── Independent Enlarged Screen Modal (Requirement B8) ─────────────── */}
      {enlargedScreen && (
        <EnlargedScreenModal
          item={enlargedScreen}
          onClose={() => setEnlargedScreen(null)}
          onRefresh={(card) => {
            classroomApi.issueCommand(sessionId, {
              target_device_id: card.device_id,
              command_type: 'request_screen_refresh',
              payload: {},
            }).catch(() => {});
          }}
        />
      )}

      {/* ── C. Selected Student View Modal (Requirement C) ─────────────────── */}
      {selectedStudent && (
        <SelectedStudentModal
          card={selectedStudent}
          screenFrame={screenFrames[selectedStudent.device_id]}
          webcamFrame={webcamFrames[selectedStudent.device_id]}
          session={session}
          onClose={() => setSelectedStudent(null)}
          onCommand={(c, type) => setCommandModal({ card: c, initialType: type })}
        />
      )}

      {/* ── D. Alert Panel Drawer (Requirement D) ───────────────────────────── */}
      {alertPanel !== null && (
        <AlertDrawer
          sessionId={sessionId}
          device={alertPanel?.device_id ? alertPanel : null}
          onClose={() => setAlertPanel(null)}
        />
      )}

      {/* ── Command Modal ─────────────────────────────────────────────────── */}
      {commandModal !== null && (
        <CommandModal
          session={session}
          card={commandModal.card}
          initialType={commandModal.initialType}
          onClose={() => setCommandModal(null)}
        />
      )}
    </div>
  );
}
