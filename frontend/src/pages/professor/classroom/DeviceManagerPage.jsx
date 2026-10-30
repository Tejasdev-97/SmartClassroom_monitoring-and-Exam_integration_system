/**
 * ExamProctor.ai — Device Manager Page
 * Neo-Brutalism visual alignment with existing Admin/Professor Tables.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  HardDrive, RefreshCw, ArrowLeft, Check, Ban, Search,
  Info, Monitor, ShieldAlert, Wifi, WifiOff, Clock
} from 'lucide-react';
import classroomApi from '../../../services/classroomApi';
import styles from './DeviceManagerPage.module.css';

function DeviceStatusBadge({ status }) {
  if (status === 'approved') {
    return <span className="badge badge-green"><Check size={12} /> Approved</span>;
  }
  if (status === 'pending') {
    return <span className="badge badge-yellow"><Clock size={12} /> Pending</span>;
  }
  if (status === 'revoked') {
    return <span className="badge badge-red"><Ban size={12} /> Revoked</span>;
  }
  return <span className="badge">{status}</span>;
}

function ConnectionStatusBadge({ status }) {
  if (status === 'online' || status === 'monitoring') {
    return (
      <span className="badge badge-green">
        <Wifi size={12} />
        {status === 'monitoring' ? 'Monitoring' : 'Online'}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="badge badge-red">
        <ShieldAlert size={12} />
        Error
      </span>
    );
  }
  return (
    <span className="badge" style={{ color: 'var(--color-text-secondary)', background: 'var(--color-surface-alt)' }}>
      <WifiOff size={12} />
      Offline
    </span>
  );
}

function ApproveModal({ device, onClose, onApproved }) {
  const [form, setForm] = useState({ room_name: device.room_name || '', workstation_label: device.workstation_label || '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.room_name) {
      setError('Room / Lab name is required.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data } = await classroomApi.approveDevice(device.device_id, form);
      onApproved(data.data);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Device approval failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalTitle}>Approve Workstation</div>
          <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', background: 'var(--color-blue-panel)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', border: 'var(--border-thin)' }}>
          <strong style={{ color: 'var(--color-text-heading)' }}>{device.hostname}</strong> — {device.os_type} {device.os_version} (Agent v{device.agent_version})
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="input-approve-room">Room / Laboratory Name *</label>
            <input
              id="input-approve-room"
              className="form-input"
              value={form.room_name}
              placeholder="e.g. Lab 101 — Computer Science"
              onChange={(e) => setForm((f) => ({ ...f, room_name: e.target.value }))}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="input-approve-ws">Workstation Identifier / Desk Label</label>
            <input
              id="input-approve-ws"
              className="form-input"
              value={form.workstation_label}
              placeholder="e.g. PC-01 or ROW2-SEAT04"
              onChange={(e) => setForm((f) => ({ ...f, workstation_label: e.target.value }))}
            />
            <span className="form-hint">Physical label affixed to this computer in the examination hall.</span>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className={styles.modalFooter}>
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="btn btn-success" id="btn-approve-submit">
              <Check size={16} />
              <span>{loading ? 'Approving…' : 'Approve Device'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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

  useEffect(() => {
    load();
  }, [load]);

  const handleRevoke = async (deviceId) => {
    if (!window.confirm('Revoke authorization for this device? It will immediately stop sending monitoring data.')) return;
    setActionLoading((l) => ({ ...l, [deviceId]: 'revoking' }));
    try {
      await classroomApi.revokeDevice(deviceId);
      setDevices((prev) =>
        prev.map((d) => (d.device_id === deviceId ? { ...d, enrollment_status: 'revoked' } : d))
      );
    } catch (e) {
      alert(e?.response?.data?.error?.message || 'Revoke failed.');
    } finally {
      setActionLoading((l) => ({ ...l, [deviceId]: null }));
    }
  };

  const counts = {
    all: devices.length,
    pending: devices.filter((d) => d.enrollment_status === 'pending').length,
    approved: devices.filter((d) => d.enrollment_status === 'approved').length,
    revoked: devices.filter((d) => d.enrollment_status === 'revoked').length,
  };

  const filtered = devices.filter((d) => {
    const matchStatus = filter === 'all' || d.enrollment_status === filter;
    const q = search.toLowerCase();
    const matchSearch =
      !search ||
      d.hostname?.toLowerCase().includes(q) ||
      (d.room_name || '').toLowerCase().includes(q) ||
      (d.workstation_label || '').toLowerCase().includes(q) ||
      (d.device_id || '').toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Link to="/professor/classroom" className={styles.backLink}>
            <ArrowLeft size={14} />
            <span>Back to Classroom Sessions</span>
          </Link>
          <h1 className={styles.title}>Device Manager</h1>
          <p className={styles.subtitle}>
            Enroll, approve, and monitor physical student workstations on the LAN
          </p>
        </div>

        <button onClick={load} className="btn btn-secondary" title="Refresh device list">
          <RefreshCw size={16} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Instruction Card */}
      <div className={styles.instructionCard}>
        <div className={styles.instructionIcon}>
          <Info size={22} />
        </div>
        <div>
          <div className={styles.instructionTitle}>Student Workstation Enrollment Protocol</div>
          <div className={styles.instructionSteps}>
            <div>1. Launch the student desktop agent on the target computer.</div>
            <div>2. Ensure <code>EP_SERVER_URL</code> points to this server's LAN address (e.g. <code>http://192.168.1.100:8000</code>).</div>
            <div>3. The workstation will register automatically and appear below as <strong>Pending</strong>.</div>
            <div>4. Click <strong>Approve</strong> to assign its laboratory name and desk identifier.</div>
          </div>
        </div>
      </div>

      {/* Controls Bar: Filters & Search */}
      <div className={styles.controlsBar}>
        <div className={styles.filterGroup}>
          {[
            { key: 'all', label: `All Workstations (${counts.all})` },
            { key: 'pending', label: `Pending Approval (${counts.pending})` },
            { key: 'approved', label: `Approved (${counts.approved})` },
            { key: 'revoked', label: `Revoked (${counts.revoked})` },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`${styles.filterBtn} ${filter === f.key ? styles.filterBtnActive : ''}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
          <input
            className={styles.searchInput}
            placeholder="Search hostname, lab, or desk…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Devices Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading workstation inventory…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <Monitor size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Workstations Found
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 400, margin: '0 auto' }}>
            {devices.length === 0
              ? 'No student agents have enrolled with the server yet. Start the agent on a workstation to begin.'
              : 'No workstations matched the selected filters.'}
          </p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workstation / Room</th>
                <th>Hostname / UUID</th>
                <th>Operating System</th>
                <th>Agent Version</th>
                <th>Connection</th>
                <th>Enrollment Status</th>
                <th>Last Heartbeat</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.device_id}>
                  <td>
                    <div style={{ fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-heading)' }}>
                      {d.workstation_label || <span style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>Unlabeled</span>}
                    </div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                      {d.room_name || 'Unassigned Lab'}
                    </div>
                  </td>

                  <td>
                    <div style={{ fontWeight: 'var(--font-weight-semibold)' }}>{d.hostname}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                      {d.device_id.slice(0, 8)}…
                    </div>
                  </td>

                  <td style={{ fontSize: 'var(--font-size-xs)' }}>
                    {d.os_type} {d.os_version ? `(${d.os_version.slice(0, 16)})` : ''}
                  </td>

                  <td>
                    <span className="codeChip" style={{ fontSize: 'var(--font-size-xs)' }}>
                      v{d.agent_version}
                    </span>
                  </td>

                  <td>
                    <ConnectionStatusBadge status={d.current_status} />
                  </td>

                  <td>
                    <DeviceStatusBadge status={d.enrollment_status} />
                  </td>

                  <td style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    {d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleTimeString() : '—'}
                  </td>

                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                      {d.enrollment_status === 'pending' && (
                        <button
                          onClick={() => setApproveModal(d)}
                          className="btn btn-success btn-sm"
                          id={`btn-approve-${d.device_id}`}
                        >
                          <Check size={14} />
                          <span>Approve</span>
                        </button>
                      )}

                      {d.enrollment_status === 'approved' && (
                        <button
                          onClick={() => handleRevoke(d.device_id)}
                          disabled={actionLoading[d.device_id] === 'revoking'}
                          className="btn btn-danger btn-sm"
                          id={`btn-revoke-${d.device_id}`}
                        >
                          <Ban size={14} />
                          <span>{actionLoading[d.device_id] === 'revoking' ? '…' : 'Revoke'}</span>
                        </button>
                      )}

                      {d.enrollment_status === 'revoked' && (
                        <button
                          onClick={() => setApproveModal(d)}
                          className="btn btn-secondary btn-sm"
                        >
                          <span>Re-approve</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Approve Modal */}
      {approveModal && (
        <ApproveModal
          device={approveModal}
          onClose={() => setApproveModal(null)}
          onApproved={(updated) => {
            setDevices((prev) =>
              prev.map((d) => (d.device_id === updated.device_id ? updated : d))
            );
            setApproveModal(null);
          }}
        />
      )}
    </div>
  );
}
