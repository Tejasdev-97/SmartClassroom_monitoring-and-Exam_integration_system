/**
 * ExamProctor.ai — Classroom Sessions Overview Page.
 * Professor can create, view, and manage classroom monitoring sessions.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import classroomApi from '../../../services/classroomApi';

const STATUS_BADGE = {
  pending:  { label: 'Pending',  color: '#f59e0b' },
  active:   { label: 'Active',   color: '#22c55e' },
  paused:   { label: 'Paused',   color: '#3b82f6' },
  ended:    { label: 'Ended',    color: '#6b7280' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_BADGE[status] || { label: status, color: '#6b7280' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 10px', borderRadius: 20,
      fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
      background: cfg.color + '22', color: cfg.color,
      border: `1px solid ${cfg.color}44`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: cfg.color,
        boxShadow: status === 'active' ? `0 0 6px ${cfg.color}` : 'none',
        animation: status === 'active' ? 'pulse 2s infinite' : 'none',
      }} />
      {cfg.label}
    </span>
  );
}

function CreateSessionModal({ policies, onClose, onCreate }) {
  const [form, setForm] = useState({ room_name: '', policy_id: '', exam_id: '', offline_auth_minutes: 120 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.room_name || !form.policy_id) { setError('Room name and policy are required.'); return; }
    setLoading(true); setError('');
    try {
      const { data } = await classroomApi.createSession({
        room_name: form.room_name,
        policy_id: form.policy_id,
        exam_id: form.exam_id || undefined,
        offline_auth_minutes: parseInt(form.offline_auth_minutes) || 120,
      });
      onCreate(data.data);
      onClose();
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Failed to create session.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--color-card)', borderRadius: 16, padding: 32, width: 480,
        border: '1px solid var(--color-border)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        <h2 style={{ margin: '0 0 24px', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          New Classroom Session
        </h2>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Room / Lab Name *</label>
            <input style={inputStyle} value={form.room_name} placeholder="e.g. Lab 101"
              onChange={e => setForm(f => ({ ...f, room_name: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Monitoring Policy *</label>
            <select style={inputStyle} value={form.policy_id}
              onChange={e => setForm(f => ({ ...f, policy_id: e.target.value }))}>
              <option value="">— Select a policy —</option>
              {policies.map(p => <option key={p.policy_id} value={p.policy_id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Linked Exam ID (optional)</label>
            <input style={inputStyle} value={form.exam_id} placeholder="Leave blank for standalone monitoring"
              onChange={e => setForm(f => ({ ...f, exam_id: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Offline Auth Window (minutes)</label>
            <input type="number" style={inputStyle} value={form.offline_auth_minutes} min={10} max={480}
              onChange={e => setForm(f => ({ ...f, offline_auth_minutes: e.target.value }))} />
          </div>
          {error && <p style={{ color: '#ef4444', fontSize: 13, margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" onClick={onClose} style={cancelBtnStyle}>Cancel</button>
            <button type="submit" disabled={loading} style={primaryBtnStyle}>
              {loading ? 'Creating…' : 'Create Session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const labelStyle = { display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' };
const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)',
  background: 'var(--color-input-bg, #1a1f2e)', color: 'var(--color-text-primary)',
  fontSize: 14, boxSizing: 'border-box', outline: 'none',
};
const primaryBtnStyle = {
  padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--color-accent, #6366f1)', color: '#fff', fontWeight: 700, fontSize: 14,
};
const cancelBtnStyle = {
  padding: '10px 24px', borderRadius: 8, border: '1px solid var(--color-border)',
  background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 14,
};

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

  useEffect(() => { load(); }, [load]);

  const handleAction = async (sessionId, action) => {
    setActionLoading(l => ({ ...l, [sessionId]: action }));
    try {
      if (action === 'start') await classroomApi.startSession(sessionId);
      if (action === 'pause') await classroomApi.pauseSession(sessionId);
      if (action === 'end') { if (!window.confirm('End this session? This cannot be undone.')) return; await classroomApi.endSession(sessionId); }
      await load();
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Action failed.');
    } finally {
      setActionLoading(l => ({ ...l, [sessionId]: null }));
    }
  };

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: 'var(--color-text-primary)' }}>
            🖥️ Classroom Monitoring
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 14 }}>
            Create and manage live classroom proctoring sessions
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to="/professor/classroom/devices" style={{
            ...cancelBtnStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            🔌 Manage Devices
          </Link>
          <button onClick={() => setShowCreate(true)} style={{ ...primaryBtnStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            + New Session
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--color-text-secondary)' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          Loading sessions…
        </div>
      )}

      {/* Sessions grid */}
      {!loading && sessions.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '80px 40px',
          border: '2px dashed var(--color-border)', borderRadius: 16,
          color: 'var(--color-text-secondary)',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
          <h3 style={{ margin: '0 0 8px', color: 'var(--color-text-primary)' }}>No Sessions Yet</h3>
          <p style={{ margin: '0 0 20px' }}>Create your first classroom monitoring session to get started.</p>
          <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>+ Create First Session</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 20 }}>
        {sessions.map(s => (
          <div key={s.session_id} style={{
            background: 'var(--color-card)', borderRadius: 16, padding: 24,
            border: `1px solid ${s.status === 'active' ? '#22c55e33' : 'var(--color-border)'}`,
            boxShadow: s.status === 'active' ? '0 0 0 1px #22c55e33' : 'none',
            transition: 'box-shadow 0.2s',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                  {s.room_name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>
                  {s.session_id.slice(0, 8)}…
                </div>
              </div>
              <StatusBadge status={s.status} />
            </div>

            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {s.started_at && <span>▶ Started {new Date(s.started_at).toLocaleString()}</span>}
              {s.ended_at && <span>⏹ Ended {new Date(s.ended_at).toLocaleString()}</span>}
              {s.exam_id && <span>📝 Linked Exam: {s.exam_id.slice(0, 8)}…</span>}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {s.status !== 'ended' && (
                <button onClick={() => navigate(`/professor/classroom/session/${s.session_id}`)} style={{
                  ...primaryBtnStyle, padding: '8px 16px', fontSize: 13, flex: 1,
                }}>
                  🎛️ Open Dashboard
                </button>
              )}
              {s.status === 'pending' && (
                <button onClick={() => handleAction(s.session_id, 'start')}
                  disabled={actionLoading[s.session_id] === 'start'}
                  style={{ ...cancelBtnStyle, padding: '8px 16px', fontSize: 13, color: '#22c55e', borderColor: '#22c55e44' }}>
                  {actionLoading[s.session_id] === 'start' ? '…' : '▶ Start'}
                </button>
              )}
              {s.status === 'active' && (
                <>
                  <button onClick={() => handleAction(s.session_id, 'pause')}
                    disabled={actionLoading[s.session_id] === 'pause'}
                    style={{ ...cancelBtnStyle, padding: '8px 16px', fontSize: 13, color: '#f59e0b', borderColor: '#f59e0b44' }}>
                    ⏸ Pause
                  </button>
                  <button onClick={() => handleAction(s.session_id, 'end')}
                    disabled={actionLoading[s.session_id] === 'end'}
                    style={{ ...cancelBtnStyle, padding: '8px 16px', fontSize: 13, color: '#ef4444', borderColor: '#ef444444' }}>
                    ⏹ End
                  </button>
                </>
              )}
              {s.status === 'paused' && (
                <button onClick={() => handleAction(s.session_id, 'start')}
                  disabled={actionLoading[s.session_id] === 'start'}
                  style={{ ...cancelBtnStyle, padding: '8px 16px', fontSize: 13, color: '#22c55e', borderColor: '#22c55e44' }}>
                  ▶ Resume
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateSessionModal
          policies={policies}
          onClose={() => setShowCreate(false)}
          onCreate={(s) => setSessions(prev => [s, ...prev])}
        />
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
