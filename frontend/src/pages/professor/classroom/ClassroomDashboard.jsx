/**
 * ExamProctor.ai — Live Classroom Dashboard.
 *
 * Real-time instructor view for an active classroom session.
 * Features:
 *   - Live grid of student workstations (severity-sorted)
 *   - Per-card: active process, window title, alert count, connection status
 *   - Alert panel with review actions
 *   - Instructor command panel (broadcast/targeted)
 *   - WebSocket subscription for push updates
 *   - REST polling fallback every 5s if WS is disconnected
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import classroomApi from '../../../services/classroomApi';
import { useAuth } from '../../../contexts/AuthContext';

// ── Severity palette ──────────────────────────────────────────────────────────
const SEV_COLOR = { low: '#22c55e', medium: '#f59e0b', high: '#f97316', critical: '#ef4444' };
const CONN_COLOR = { online: '#22c55e', monitoring: '#6366f1', offline: '#6b7280', error: '#ef4444' };
const CONN_ICON  = { online: '🟢', monitoring: '🔵', offline: '⚫', error: '🔴' };

// ── Sub-components ────────────────────────────────────────────────────────────

function DeviceCard({ card, onCommand, onViewAlerts, selected, onSelect }) {
  const topAlert = card.weighted_severity_score > 0
    ? Object.entries(card.alert_summary).sort((a, b) => b[1] - a[1])[0]
    : null;

  const borderColor = card.unresolved_alert_count > 0
    ? SEV_COLOR[topAlert ? (card.weighted_severity_score > 6 ? 'critical' : card.weighted_severity_score > 3 ? 'high' : 'medium') : 'medium']
    : CONN_COLOR[card.connection_status];

  return (
    <div
      onClick={() => onSelect(card.device_id)}
      style={{
        background: 'var(--color-card)',
        borderRadius: 14,
        padding: 16,
        border: `1.5px solid ${selected ? '#6366f1' : borderColor + '55'}`,
        cursor: 'pointer',
        transition: 'all 0.18s',
        boxShadow: selected ? '0 0 0 3px #6366f133' :
          card.unresolved_alert_count > 0 ? `0 0 0 1px ${borderColor}33` : 'none',
        position: 'relative',
        opacity: card.connection_status === 'offline' ? 0.65 : 1,
      }}
    >
      {/* Alert badge */}
      {card.unresolved_alert_count > 0 && (
        <span style={{
          position: 'absolute', top: -8, right: -8,
          background: card.weighted_severity_score > 6 ? '#ef4444' : '#f97316',
          color: '#fff', borderRadius: '50%', width: 22, height: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 800, boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          animation: 'pulse-badge 1.5s infinite',
        }}>
          {card.unresolved_alert_count}
        </span>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-text-primary)' }}>
            {card.workstation_label || card.device_hostname}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {card.student_name || card.student_usn || 'Unassigned'}
          </div>
        </div>
        <span style={{ fontSize: 18 }} title={card.connection_status}>
          {CONN_ICON[card.connection_status] || '⚫'}
        </span>
      </div>

      {/* Active process */}
      <div style={{
        background: '#0a0d1422', borderRadius: 8, padding: '6px 10px', marginBottom: 8,
        fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text-secondary)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {card.active_process || card.active_window_title || '—'}
      </div>

      {/* Alert summary pills */}
      {topAlert && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {Object.entries(card.alert_summary).slice(0, 3).map(([type, cnt]) => (
            <span key={type} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 10, fontWeight: 700,
              background: '#ef444422', color: '#ef4444',
            }}>
              {type.replace('_', ' ')} ×{cnt}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={e => { e.stopPropagation(); onViewAlerts(card); }}
          style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid var(--color-border)',
            background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 11, cursor: 'pointer' }}>
          🔔 Alerts
        </button>
        <button
          onClick={e => { e.stopPropagation(); onCommand(card, 'send_message'); }}
          style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid var(--color-border)',
            background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 11, cursor: 'pointer' }}>
          💬 Message
        </button>
      </div>
    </div>
  );
}


function AlertPanel({ sessionId, device, onClose }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await classroomApi.listAlerts(sessionId, {
        device_id: device?.device_id, status: 'unreviewed', limit: 50
      });
      setAlerts(data.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [sessionId, device]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (alertId, status) => {
    await classroomApi.reviewAlert(sessionId, alertId, { resolution_status: status });
    load();
  };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 420,
      background: 'var(--color-card)', borderLeft: '1px solid var(--color-border)',
      zIndex: 500, overflowY: 'auto', padding: 24,
      boxShadow: '-8px 0 32px rgba(0,0,0,0.4)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          🔔 Alerts {device ? `— ${device.workstation_label || device.device_hostname}` : '(All)'}
        </h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--color-text-secondary)' }}>✕</button>
      </div>
      {loading && <div style={{ color: 'var(--color-text-secondary)' }}>Loading…</div>}
      {!loading && alerts.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--color-text-secondary)' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
          No unreviewed alerts
        </div>
      )}
      {alerts.map(a => (
        <div key={a.alert_id} style={{
          background: '#0a0d1444', borderRadius: 10, padding: 14, marginBottom: 12,
          border: `1px solid ${SEV_COLOR[a.severity] || '#6b7280'}33`,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: SEV_COLOR[a.severity] || '#fff', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {a.alert_type.replace(/_/g, ' ')}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {new Date(a.detected_at).toLocaleTimeString()}
            </span>
          </div>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {a.description}
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => resolve(a.alert_id, 'acknowledged')} style={{
              flex: 1, padding: '5px 0', fontSize: 11, borderRadius: 6, cursor: 'pointer',
              background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44',
            }}>✓ Acknowledge</button>
            <button onClick={() => resolve(a.alert_id, 'confirmed_violation')} style={{
              flex: 1, padding: '5px 0', fontSize: 11, borderRadius: 6, cursor: 'pointer',
              background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444',
            }}>⚠ Flag Violation</button>
            <button onClick={() => resolve(a.alert_id, 'dismissed')} style={{
              flex: 1, padding: '5px 0', fontSize: 11, borderRadius: 6, cursor: 'pointer',
              background: '#6b728022', color: '#6b7280', border: '1px solid #6b728044',
            }}>✕ Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}


function CommandModal({ session, card, onClose }) {
  const [form, setForm] = useState({ command_type: card ? 'send_message' : 'broadcast_notice', message: '' });
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await classroomApi.issueCommand(session.session_id, {
        target_device_id: card?.device_id || null,
        command_type: form.command_type,
        payload: { message: form.message },
      });
      setSent(true);
      setTimeout(onClose, 1500);
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Command failed.');
    } finally {
      setLoading(false);
    }
  };

  const COMMANDS = [
    { value: 'send_message',     label: '💬 Send Message' },
    { value: 'broadcast_notice', label: '📢 Broadcast Notice' },
    { value: 'force_refresh',    label: '🔄 Force Refresh' },
    { value: 'enforce_focus',    label: '🔒 Enforce Focus' },
    { value: 'lock_workstation', label: '🚫 Lock Workstation' },
  ];

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 600,
      background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--color-card)', borderRadius: 16, padding: 32, width: 440,
        border: '1px solid var(--color-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        {sent ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <div style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>Command sent!</div>
          </div>
        ) : (
          <>
            <h3 style={{ margin: '0 0 20px', fontWeight: 700, fontSize: 18, color: 'var(--color-text-primary)' }}>
              {card ? `Command → ${card.workstation_label || card.device_hostname}` : '📢 Broadcast to All'}
            </h3>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Command Type</label>
                <select
                  value={form.command_type}
                  onChange={e => setForm(f => ({ ...f, command_type: e.target.value }))}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#1a1f2e', color: 'var(--color-text-primary)', fontSize: 14 }}>
                  {COMMANDS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              {['send_message', 'broadcast_notice'].includes(form.command_type) && (
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Message</label>
                  <textarea
                    value={form.message}
                    onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                    placeholder="Type your message…"
                    rows={3}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#1a1f2e', color: 'var(--color-text-primary)', fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" onClick={onClose} style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" disabled={loading} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
                  {loading ? 'Sending…' : '📤 Send'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function ClassroomDashboard() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [session, setSession] = useState(null);
  const [grid, setGrid] = useState([]);
  const [loading, setLoading] = useState(true);
  const [wsStatus, setWsStatus] = useState('connecting');
  const [alertPanel, setAlertPanel] = useState(null);  // null | { device_id, device_hostname, ... }
  const [commandModal, setCommandModal] = useState(null); // null | { card, type }
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const wsRef = useRef(null);
  const pollRef = useRef(null);

  // ── Load session info ───────────────────────────────────────────────────────
  useEffect(() => {
    classroomApi.getSession(sessionId)
      .then(r => setSession(r.data.data))
      .catch(() => navigate('/professor/classroom'));
  }, [sessionId, navigate]);

  // ── Grid polling (REST fallback) ────────────────────────────────────────────
  const pollGrid = useCallback(async () => {
    try {
      const { data } = await classroomApi.getGrid(sessionId);
      setGrid(data.data || []);
    } catch { /* ignore */ }
  }, [sessionId]);

  // ── WebSocket connection ────────────────────────────────────────────────────
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
        // Stop REST poll — WS is active
        clearInterval(pollRef.current);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'grid_update') setGrid(msg.data || []);
          if (msg.type === 'alert') {
            // Trigger visual flash — re-fetch grid for badge counts
            pollGrid();
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        setWsStatus('reconnecting');
        // Fall back to REST polling while WS is down
        pollGrid();
        pollRef.current = setInterval(pollGrid, 5000);
        reconnectTimer = setTimeout(connect, 5000);
      };

      ws.onerror = () => {
        setWsStatus('error');
      };
    };

    // Initial REST poll while WS negotiates
    pollGrid().then(() => setLoading(false));
    pollRef.current = setInterval(pollGrid, 5000);
    connect();

    return () => {
      clearTimeout(reconnectTimer);
      clearInterval(pollRef.current);
      ws?.close();
    };
  }, [sessionId, pollGrid]);

  // ── Filters ─────────────────────────────────────────────────────────────────
  const filteredGrid = grid.filter(c => {
    if (statusFilter === 'alerted') return c.unresolved_alert_count > 0;
    if (statusFilter === 'offline') return c.connection_status === 'offline';
    return true;
  });

  const totalAlerts = grid.reduce((s, c) => s + c.unresolved_alert_count, 0);
  const offlineCount = grid.filter(c => c.connection_status === 'offline').length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <Link to="/professor/classroom" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none', fontSize: 13 }}>
          ← Sessions
        </Link>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)', flex: 1 }}>
          🖥️ {session?.room_name || 'Classroom'} Dashboard
        </h1>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 12 }}>
          {[
            { label: 'Students', value: grid.length, color: '#6366f1' },
            { label: 'Alerts', value: totalAlerts, color: totalAlerts > 0 ? '#ef4444' : '#22c55e' },
            { label: 'Offline', value: offlineCount, color: offlineCount > 0 ? '#f59e0b' : '#22c55e' },
          ].map(stat => (
            <div key={stat.label} style={{
              background: 'var(--color-card)', borderRadius: 10, padding: '8px 16px',
              border: `1px solid ${stat.color}33`, textAlign: 'center',
            }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: stat.color }}>{stat.value}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* WS status */}
        <span style={{
          fontSize: 11, padding: '4px 10px', borderRadius: 8,
          background: wsStatus === 'connected' ? '#22c55e22' : '#f59e0b22',
          color: wsStatus === 'connected' ? '#22c55e' : '#f59e0b',
          border: `1px solid ${wsStatus === 'connected' ? '#22c55e44' : '#f59e0b44'}`,
        }}>
          {wsStatus === 'connected' ? '⚡ Live' : '🔄 Reconnecting…'}
        </span>

        {/* Broadcast command button */}
        <button onClick={() => setCommandModal({ card: null })} style={{
          padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff',
          fontWeight: 700, fontSize: 13,
        }}>
          📢 Broadcast
        </button>

        {/* Alert panel button */}
        {totalAlerts > 0 && (
          <button onClick={() => setAlertPanel({})} style={{
            padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444', fontWeight: 700, fontSize: 13,
          }}>
            🔔 {totalAlerts} Alert{totalAlerts !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[
          { key: 'all', label: `All (${grid.length})` },
          { key: 'alerted', label: `⚠ Alerted (${grid.filter(c => c.unresolved_alert_count > 0).length})` },
          { key: 'offline', label: `⚫ Offline (${offlineCount})` },
        ].map(f => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)} style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            border: statusFilter === f.key ? '1px solid #6366f1' : '1px solid var(--color-border)',
            background: statusFilter === f.key ? '#6366f122' : 'transparent',
            color: statusFilter === f.key ? '#6366f1' : 'var(--color-text-secondary)',
            fontWeight: statusFilter === f.key ? 700 : 400,
          }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner spinner-lg" />
        </div>
      ) : filteredGrid.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--color-text-secondary)' }}>
          <div style={{ fontSize: 48 }}>📋</div>
          <div>No devices match this filter.</div>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
          overflowY: 'auto',
          flex: 1,
          paddingRight: alertPanel ? 432 : 0,
          transition: 'padding-right 0.3s',
        }}>
          {filteredGrid.map(card => (
            <DeviceCard
              key={card.device_id}
              card={card}
              selected={selectedDeviceId === card.device_id}
              onSelect={setSelectedDeviceId}
              onCommand={(c, type) => setCommandModal({ card: c, type })}
              onViewAlerts={(c) => setAlertPanel(c)}
            />
          ))}
        </div>
      )}

      {/* Alert panel */}
      {alertPanel !== null && (
        <AlertPanel
          sessionId={sessionId}
          device={alertPanel?.device_id ? alertPanel : null}
          onClose={() => setAlertPanel(null)}
        />
      )}

      {/* Command modal */}
      {commandModal !== null && (
        <CommandModal
          session={session}
          card={commandModal.card}
          onClose={() => setCommandModal(null)}
        />
      )}

      <style>{`
        @keyframes pulse-badge {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
