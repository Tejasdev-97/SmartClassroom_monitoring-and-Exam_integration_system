/**
 * ExamProctor.ai — Classroom Sessions Overview Page
 * Neo-Brutalism visual alignment with existing Professor Dashboard.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Monitor, Plus, Play, Pause, Square, ExternalLink, HardDrive,
  Users, AlertTriangle, Clock, X, CheckCircle, ShieldCheck
} from 'lucide-react';
import classroomApi from '../../../services/classroomApi';
import styles from './ClassroomPage.module.css';

function SessionStatusBadge({ status }) {
  if (status === 'active') {
    return (
      <span className="badge badge-green">
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />
        Active
      </span>
    );
  }
  if (status === 'paused') {
    return (
      <span className="badge badge-yellow">
        <Pause size={12} />
        Paused
      </span>
    );
  }
  if (status === 'ended') {
    return (
      <span className="badge" style={{ color: 'var(--color-text-secondary)', background: 'var(--color-surface-alt)' }}>
        <Square size={10} />
        Ended
      </span>
    );
  }
  return (
    <span className="badge badge-orange">
      <Clock size={12} />
      Pending
    </span>
  );
}

function CreateSessionModal({ policies, onClose, onCreate }) {
  const [form, setForm] = useState({
    room_name: '',
    policy_id: policies[0]?.policy_id || '',
    exam_id: '',
    offline_auth_minutes: 120,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [approvedDevices, setApprovedDevices] = useState([]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(true);

  useEffect(() => {
    if (policies.length > 0 && !form.policy_id) {
      setForm((f) => ({ ...f, policy_id: policies[0].policy_id }));
    }
  }, [policies, form.policy_id]);

  // Load approved devices for selection
  useEffect(() => {
    setDevicesLoading(true);
    classroomApi.listDevices({ enrollment_status: 'approved' })
      .then(({ data }) => {
        const devices = data?.data || [];
        setApprovedDevices(devices);
        // Pre-select all approved devices
        setSelectedDeviceIds(devices.map((d) => d.device_id));
      })
      .catch(() => setApprovedDevices([]))
      .finally(() => setDevicesLoading(false));
  }, []);

  const toggleDevice = (deviceId) => {
    setSelectedDeviceIds((prev) =>
      prev.includes(deviceId)
        ? prev.filter((id) => id !== deviceId)
        : [...prev, deviceId]
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.room_name || !form.policy_id) {
      setError('Room name and policy are required.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // 1. Create the session
      const { data } = await classroomApi.createSession({
        room_name: form.room_name,
        policy_id: form.policy_id,
        exam_id: form.exam_id || undefined,
        offline_auth_minutes: parseInt(form.offline_auth_minutes, 10) || 120,
      });
      const session = data.data;

      // 2. Assign selected approved devices to the session immediately
      if (selectedDeviceIds.length > 0 && session?.session_id) {
        const assignments = selectedDeviceIds.map((device_id) => ({
          device_id,
          student_user_id: null,
          student_name: null,
          student_usn: null,
          attempt_id: null,
        }));
        try {
          await classroomApi.assignDevices(session.session_id, assignments);
        } catch (assignErr) {
          // Non-fatal: session created, devices not assigned — professor can retry
          console.warn('[Classroom] Device assignment after session creation failed:', assignErr?.message);
        }
      }

      onCreate(session);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Failed to create session.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className={styles.modalHeader}>
          <div className={styles.modalTitle}>New Classroom Session</div>
          <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="input-room-name">Room / Lab Name *</label>
            <input
              id="input-room-name"
              className="form-input"
              value={form.room_name}
              placeholder="e.g. Lab 101 — Computer Science"
              onChange={(e) => setForm((f) => ({ ...f, room_name: e.target.value }))}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="select-policy">Monitoring Policy *</label>
            <select
              id="select-policy"
              className="form-select"
              value={form.policy_id}
              onChange={(e) => setForm((f) => ({ ...f, policy_id: e.target.value }))}
              required
            >
              <option value="">— Select an integrity policy —</option>
              {policies.map((p) => (
                <option key={p.policy_id} value={p.policy_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="input-exam-id">Linked Exam ID (optional)</label>
            <input
              id="input-exam-id"
              className="form-input"
              value={form.exam_id}
              placeholder="Leave blank for standalone monitoring"
              onChange={(e) => setForm((f) => ({ ...f, exam_id: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="input-offline-auth">Offline Auth Lease Window (minutes)</label>
            <input
              id="input-offline-auth"
              type="number"
              className="form-input"
              value={form.offline_auth_minutes}
              min={10}
              max={480}
              onChange={(e) => setForm((f) => ({ ...f, offline_auth_minutes: e.target.value }))}
            />
            <span className="form-hint">Allows student agents to operate through temporary network drops.</span>
          </div>

          {/* ── Device Assignment ─────────────────────────────────────────── */}
          <div className="form-group">
            <label className="form-label">
              <HardDrive size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Assign Approved Student Devices
            </label>
            {devicesLoading ? (
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', padding: '8px 0' }}>
                Loading devices…
              </div>
            ) : approvedDevices.length === 0 ? (
              <div className="alert alert-info" style={{ fontSize: '0.85rem' }}>
                No approved devices found. Register and approve student workstations in the Device Manager first.
              </div>
            ) : (
              <div style={{
                border: '2px solid var(--neo-border)',
                borderRadius: 'var(--radius-sm)',
                maxHeight: 180,
                overflowY: 'auto',
                background: 'var(--color-surface)',
              }}>
                {approvedDevices.map((device) => (
                  <label
                    key={device.device_id}
                    htmlFor={`device-chk-${device.device_id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--color-border)',
                      fontSize: '0.875rem',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      id={`device-chk-${device.device_id}`}
                      type="checkbox"
                      checked={selectedDeviceIds.includes(device.device_id)}
                      onChange={() => toggleDevice(device.device_id)}
                      style={{ width: 16, height: 16, accentColor: 'var(--neo-accent)' }}
                    />
                    <HardDrive size={14} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600 }}>{device.hostname}</span>
                    {device.workstation_label && (
                      <span style={{ color: 'var(--color-text-secondary)', marginLeft: 4 }}>
                        — {device.workstation_label}
                      </span>
                    )}
                    {device.room_name && (
                      <span className="badge badge-blue" style={{ marginLeft: 'auto', fontSize: '0.7rem' }}>
                        {device.room_name}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
            {approvedDevices.length > 0 && (
              <span className="form-hint">
                {selectedDeviceIds.length} of {approvedDevices.length} device(s) selected for monitoring.
              </span>
            )}
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className={styles.modalFooter}>
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="btn btn-primary" id="btn-create-session-submit">
              {loading ? 'Creating Session…' : 'Create & Assign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



export default function ClassroomPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [actionLoading, setActionLoading] = useState({});

  const load = useCallback(async () => {
    try {
      const [sessRes, polRes] = await Promise.all([
        classroomApi.listSessions(),
        classroomApi.listPolicies(),
      ]);
      setSessions(sessRes.data.data || []);
      setPolicies(polRes.data.data || []);
    } catch (e) {
      console.error('Failed to load classroom data', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAction = async (sessionId, action) => {
    setActionLoading((l) => ({ ...l, [sessionId]: action }));
    try {
      if (action === 'start') await classroomApi.startSession(sessionId);
      if (action === 'pause') await classroomApi.pauseSession(sessionId);
      if (action === 'end') {
        if (!window.confirm('End this classroom session? This action will finalize all monitoring.')) return;
        await classroomApi.endSession(sessionId);
      }
      await load();
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Action failed.');
    } finally {
      setActionLoading((l) => ({ ...l, [sessionId]: null }));
    }
  };

  const activeSessionsCount = sessions.filter((s) => s.status === 'active').length;
  const pendingSessionsCount = sessions.filter((s) => s.status === 'pending').length;
  const totalSessionsCount = sessions.length;

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Classroom Monitoring</h1>
          <p className={styles.subtitle}>
            Oversee physical laboratory workstations and real-time examination sessions
          </p>
        </div>

        <div className={styles.headerActions}>
          <Link to="/professor/classroom/devices" className="btn btn-secondary">
            <HardDrive size={16} />
            <span>Manage Devices</span>
          </Link>
          <button
            onClick={() => setShowCreate(true)}
            className="btn btn-primary"
            id="btn-new-classroom-session"
          >
            <Plus size={16} />
            <span>New Session</span>
          </button>
        </div>
      </div>

      {/* Stats summary row */}
      <div className={styles.statsRow}>
        <div className={`${styles.statCard} ${styles.statGreen}`}>
          <Play size={24} />
          <div className={styles.statValue}>{activeSessionsCount}</div>
          <div className={styles.statLabel}>Active Sessions</div>
        </div>
        <div className={`${styles.statCard} ${styles.statOrange}`}>
          <Clock size={24} />
          <div className={styles.statValue}>{pendingSessionsCount}</div>
          <div className={styles.statLabel}>Pending Sessions</div>
        </div>
        <div className={`${styles.statCard} ${styles.statBlue}`}>
          <Monitor size={24} />
          <div className={styles.statValue}>{totalSessionsCount}</div>
          <div className={styles.statLabel}>Total Rooms Enrolled</div>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading classroom sessions…</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && sessions.length === 0 && (
        <div className={styles.emptyState}>
          <Monitor size={48} />
          <h3>No Classroom Sessions Yet</h3>
          <p>Create your first classroom session to begin monitoring student workstations in real time.</p>
          <button onClick={() => setShowCreate(true)} className="btn btn-primary">
            <Plus size={16} />
            <span>Create First Session</span>
          </button>
        </div>
      )}

      {/* Sessions Grid */}
      {!loading && sessions.length > 0 && (
        <div className={styles.sessionsGrid}>
          {sessions.map((s) => {
            const isActive = s.status === 'active';
            return (
              <div
                key={s.session_id}
                className={`${styles.sessionCard} ${isActive ? styles.sessionCardActive : ''}`}
              >
                <div className={styles.sessionHeader}>
                  <div>
                    <div className={styles.roomName}>{s.room_name}</div>
                    <div className={styles.sessionId}>ID: {s.session_id.slice(0, 8)}…</div>
                  </div>
                  <SessionStatusBadge status={s.status} />
                </div>

                <div className={styles.sessionMeta}>
                  {s.started_at && (
                    <div className={styles.sessionMetaItem}>
                      <Clock size={14} />
                      <span>Started: {new Date(s.started_at).toLocaleString()}</span>
                    </div>
                  )}
                  {s.ended_at && (
                    <div className={styles.sessionMetaItem}>
                      <Square size={14} />
                      <span>Ended: {new Date(s.ended_at).toLocaleString()}</span>
                    </div>
                  )}
                  {s.exam_id && (
                    <div className={styles.sessionMetaItem}>
                      <ShieldCheck size={14} />
                      <span>Linked Exam: <code style={{ fontFamily: 'monospace' }}>{s.exam_id.slice(0, 8)}…</code></span>
                    </div>
                  )}
                </div>

                <div className={styles.sessionActions}>
                  {s.status !== 'ended' && (
                    <button
                      onClick={() => navigate(`/professor/classroom/session/${s.session_id}`)}
                      className="btn btn-primary btn-sm"
                      style={{ flex: 1 }}
                      id={`btn-open-dashboard-${s.session_id}`}
                    >
                      <ExternalLink size={14} />
                      <span>Open Live CCTV</span>
                    </button>
                  )}

                  {s.status === 'pending' && (
                    <button
                      onClick={() => handleAction(s.session_id, 'start')}
                      disabled={actionLoading[s.session_id] === 'start'}
                      className="btn btn-success btn-sm"
                    >
                      <Play size={14} />
                      <span>{actionLoading[s.session_id] === 'start' ? '…' : 'Start'}</span>
                    </button>
                  )}

                  {s.status === 'active' && (
                    <>
                      <button
                        onClick={() => handleAction(s.session_id, 'pause')}
                        disabled={actionLoading[s.session_id] === 'pause'}
                        className="btn btn-orange btn-sm"
                      >
                        <Pause size={14} />
                        <span>{actionLoading[s.session_id] === 'pause' ? '…' : 'Pause'}</span>
                      </button>
                      <button
                        onClick={() => handleAction(s.session_id, 'end')}
                        disabled={actionLoading[s.session_id] === 'end'}
                        className="btn btn-danger btn-sm"
                      >
                        <Square size={14} />
                        <span>{actionLoading[s.session_id] === 'end' ? '…' : 'End'}</span>
                      </button>
                    </>
                  )}

                  {s.status === 'paused' && (
                    <button
                      onClick={() => handleAction(s.session_id, 'start')}
                      disabled={actionLoading[s.session_id] === 'start'}
                      className="btn btn-success btn-sm"
                    >
                      <Play size={14} />
                      <span>{actionLoading[s.session_id] === 'start' ? '…' : 'Resume'}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <CreateSessionModal
          policies={policies}
          onClose={() => setShowCreate(false)}
          onCreate={(s) => setSessions((prev) => [s, ...prev])}
        />
      )}
    </div>
  );
}
