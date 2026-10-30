/**
 * ExamProctor.ai — Device Manager Page.
 *
 * Professor view for managing enrolled student workstations:
 *   - See all registered devices (pending / approved / revoked)
 *   - Approve pending devices with room + workstation label
 *   - Revoke approved devices
 *   - View device details (hostname, OS, last heartbeat, status)
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import classroomApi from '../../../services/classroomApi';

const STATUS_STYLE = {
  pending:  { bg: '#f59e0b22', color: '#f59e0b', border: '#f59e0b44', label: 'Pending Approval' },
  approved: { bg: '#22c55e22', color: '#22c55e', border: '#22c55e44', label: 'Approved' },
  revoked:  { bg: '#6b728022', color: '#6b7280', border: '#6b728044', label: 'Revoked' },
};

const CONN_STYLE = {
  online:     { color: '#22c55e', icon: '🟢' },
  monitoring: { color: '#6366f1', icon: '🔵' },
  offline:    { color: '#6b7280', icon: '⚫' },
  error:      { color: '#ef4444', icon: '🔴' },
};

function ApproveModal({ device, onClose, onApproved }) {
  const [form, setForm] = useState({ room_name: '', workstation_label: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.room_name) { setError('Room name is required.'); return; }
    setLoading(true); setError('');
    try {
      const { data } = await classroomApi.approveDevice(device.device_id, form);
      onApproved(data.data);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Approval failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--color-card)', borderRadius: 16, padding: 32, width: 440,
        border: '1px solid var(--color-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          Approve Device
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <strong style={{ color: 'var(--color-text-primary)' }}>{device.hostname}</strong> — {device.os_type} {device.os_version}
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelSt}>Room / Lab Name *</label>
            <input style={inputSt} value={form.room_name} placeholder="e.g. Lab 101"
              onChange={e => setForm(f => ({ ...f, room_name: e.target.value }))} />
          </div>
          <div>
            <label style={labelSt}>Workstation Label (optional)</label>
            <input style={inputSt} value={form.workstation_label} placeholder="e.g. PC-12"
              onChange={e => setForm(f => ({ ...f, workstation_label: e.target.value }))} />
          </div>
          {error && <p style={{ color: '#ef4444', fontSize: 13, margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
            <button type="button" onClick={onClose} style={cancelSt}>Cancel</button>
            <button type="submit" disabled={loading} style={approveSt}>
              {loading ? 'Approving…' : '✓ Approve Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const labelSt  = { display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' };
const inputSt  = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#1a1f2e', color: 'var(--color-text-primary)', fontSize: 14, boxSizing: 'border-box' };
const cancelSt = { padding: '9px 20px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 14 };
const approveSt = { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#22c55e', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 };

export default function DeviceManagerPage() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [approveModal, setApproveModal] = useState(null);
  const [actionLoading, setActionLoading] = useState({});

  const load = useCallback(async () => {
    try {
      const { data } = await classroomApi.listDevices();
      setDevices(data.data || []);
    } catch (e) {
      console.error('Failed to load devices', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (deviceId) => {
    if (!window.confirm('Revoke this device? It will need to re-register before being used again.')) return;
    setActionLoading(l => ({ ...l, [deviceId]: 'revoking' }));
    try {
      await classroomApi.revokeDevice(deviceId);
      setDevices(prev => prev.map(d => d.device_id === deviceId ? { ...d, enrollment_status: 'revoked' } : d));
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Revoke failed.');
    } finally {
      setActionLoading(l => ({ ...l, [deviceId]: null }));
    }
  };

  const counts = {
    all:      devices.length,
    pending:  devices.filter(d => d.enrollment_status === 'pending').length,
    approved: devices.filter(d => d.enrollment_status === 'approved').length,
    revoked:  devices.filter(d => d.enrollment_status === 'revoked').length,
  };

  const filtered = devices.filter(d => {
    const matchStatus = filter === 'all' || d.enrollment_status === filter;
    const matchSearch = !search ||
      d.hostname.toLowerCase().includes(search.toLowerCase()) ||
      (d.room_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (d.workstation_label || '').toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchSearch;
  });

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
        <Link to="/professor/classroom" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none', fontSize: 13 }}>
          ← Sessions
        </Link>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: 'var(--color-text-primary)' }}>
            🔌 Device Manager
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Enroll and manage student workstations for classroom monitoring
          </p>
        </div>
        <button onClick={load} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>
          ↻ Refresh
        </button>
      </div>

      {/* Agent setup instructions */}
      <div style={{
        background: 'linear-gradient(135deg, #6366f111, #8b5cf611)', border: '1px solid #6366f133',
        borderRadius: 12, padding: '16px 20px', marginBottom: 24,
        display: 'flex', alignItems: 'flex-start', gap: 14,
      }}>
        <span style={{ fontSize: 24, flexShrink: 0 }}>ℹ️</span>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>
            How to enroll a student workstation
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
            1. Install the Python student agent on the student PC<br />
            2. Set <code style={{ background: '#0a0d1455', padding: '1px 5px', borderRadius: 4 }}>EP_SERVER_URL</code> env variable to this server's LAN IP + port (e.g. <code style={{ background: '#0a0d1455', padding: '1px 5px', borderRadius: 4 }}>http://192.168.1.1:8000</code>)<br />
            3. Run: <code style={{ background: '#0a0d1455', padding: '1px 5px', borderRadius: 4 }}>python agent.py</code> — the device will appear below as <em>Pending</em><br />
            4. Approve it here with the room name and workstation label
          </div>
        </div>
      </div>

      {/* Filters + Search */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        {['all', 'pending', 'approved', 'revoked'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
            border: filter === f ? '1px solid #6366f1' : '1px solid var(--color-border)',
            background: filter === f ? '#6366f122' : 'transparent',
            color: filter === f ? '#6366f1' : 'var(--color-text-secondary)',
            fontWeight: filter === f ? 700 : 400, textTransform: 'capitalize',
          }}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
          </button>
        ))}
        <input
          placeholder="Search hostname, room, label…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#1a1f2e', color: 'var(--color-text-primary)', fontSize: 13, width: 240 }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--color-text-secondary)' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          Loading devices…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 40px', border: '2px dashed var(--color-border)', borderRadius: 12, color: 'var(--color-text-secondary)' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔌</div>
          <div>{devices.length === 0 ? 'No devices registered yet. Run the student agent on a workstation to begin enrollment.' : 'No devices match your filters.'}</div>
        </div>
      ) : (
        <div style={{ background: 'var(--color-card)', borderRadius: 12, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                {['Workstation', 'Hostname', 'OS', 'Agent', 'Connection', 'Enrollment', 'Last Heartbeat', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => {
                const statusSt = STATUS_STYLE[d.enrollment_status] || STATUS_STYLE.revoked;
                const connSt = CONN_STYLE[d.current_status] || CONN_STYLE.offline;
                return (
                  <tr key={d.device_id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--color-border)' : 'none', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#ffffff08'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ fontWeight: 700, color: 'var(--color-text-primary)', fontSize: 14 }}>
                        {d.workstation_label || <span style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>—</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{d.room_name || '—'}</div>
                    </td>
                    <td style={{ padding: '14px 16px', fontFamily: 'monospace', fontSize: 12, color: 'var(--color-text-primary)' }}>
                      {d.hostname}
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {d.os_type} {d.os_version ? `(${d.os_version.slice(0, 20)})` : ''}
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>
                      v{d.agent_version}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{ color: connSt.color, fontSize: 13 }}>{connSt.icon} {d.current_status}</span>
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{
                        fontSize: 11, padding: '3px 9px', borderRadius: 10, fontWeight: 700,
                        background: statusSt.bg, color: statusSt.color, border: `1px solid ${statusSt.border}`,
                      }}>
                        {statusSt.label}
                      </span>
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleString() : '—'}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {d.enrollment_status === 'pending' && (
                          <button onClick={() => setApproveModal(d)} style={{
                            padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                            background: '#22c55e', color: '#fff',
                          }}>
                            ✓ Approve
                          </button>
                        )}
                        {d.enrollment_status === 'approved' && (
                          <button onClick={() => handleRevoke(d.device_id)} disabled={actionLoading[d.device_id] === 'revoking'} style={{
                            padding: '5px 12px', borderRadius: 6, border: '1px solid #ef444444', cursor: 'pointer', fontSize: 12,
                            background: '#ef444422', color: '#ef4444',
                          }}>
                            {actionLoading[d.device_id] === 'revoking' ? '…' : 'Revoke'}
                          </button>
                        )}
                        {d.enrollment_status === 'revoked' && (
                          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Approve modal */}
      {approveModal && (
        <ApproveModal
          device={approveModal}
          onClose={() => setApproveModal(null)}
          onApproved={(updated) => {
            setDevices(prev => prev.map(d => d.device_id === updated.device_id ? updated : d));
            setApproveModal(null);
          }}
        />
      )}
    </div>
  );
}
