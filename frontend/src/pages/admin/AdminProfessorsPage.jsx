/**
 * ExamProctor.ai — Admin Professor Management Page (/admin/professors)
 * Dedicated view to manage faculty accounts, departments, exam authorizations, and status.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Users, Plus, Search, UserCheck, UserX, KeyRound, Trash2,
  RefreshCw, GraduationCap, ShieldCheck
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';

export default function AdminProfessorsPage() {
  const { toast } = useToast();
  const [professors, setProfessors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'professor' });
  const [saving, setSaving] = useState(false);

  const loadProfessors = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/users?role=professor');
      const list = (data.data || []).filter((u) => u.role === 'professor');
      setProfessors(list);
    } catch {
      toast('Failed to load professor accounts.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadProfessors();
  }, [loadProfessors]);

  const handleCreateProfessor = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/users', { ...form, role: 'professor' });
      toast('Professor account created successfully.', 'success');
      setShowCreateModal(false);
      setForm({ full_name: '', email: '', password: '', role: 'professor' });
      loadProfessors();
    } catch (err) {
      toast(err?.response?.data?.message || 'Failed to create professor.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (user) => {
    const nextStatus = user.status === 'active' ? 'inactive' : 'active';
    try {
      await api.patch(`/users/${user.user_id}/status`, { status: nextStatus });
      toast(`Professor account marked ${nextStatus}.`, 'success');
      loadProfessors();
    } catch {
      toast('Failed to update professor status.', 'error');
    }
  };

  const filtered = professors.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (p.full_name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q);
  });

  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-6)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 800, color: 'var(--color-text-heading)' }}>
            Professor & Faculty Management
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>
            Oversee instructor accounts, course permissions, and examination creation authorizations.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button onClick={loadProfessors} className="btn btn-secondary btn-sm">
            <RefreshCw size={14} />
            <span>Refresh</span>
          </button>
          <button onClick={() => setShowCreateModal(true)} className="btn btn-primary btn-sm">
            <Plus size={14} />
            <span>Add Professor</span>
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div style={{ marginBottom: 'var(--space-4)', maxWidth: 360 }}>
        <input
          type="text"
          className="form-input"
          placeholder="Search by professor name or email…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading professors…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <GraduationCap size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Professors Found
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto var(--space-4)' }}>
            {professors.length === 0 ? 'No faculty accounts exist in the platform yet.' : 'No professors matched your search.'}
          </p>
          <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
            <Plus size={14} />
            <span>Add First Professor</span>
          </button>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-alt)', borderBottom: 'var(--border-base)' }}>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Professor</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Email</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Role</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Account Status</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((prof) => (
                <tr key={prof.user_id} style={{ borderBottom: 'var(--border-thin)' }}>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 700 }}>
                    {prof.full_name}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>
                    {prof.email}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    <span className="badge badge-orange">Faculty</span>
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    <span className={`badge ${prof.status === 'active' ? 'badge-green' : 'badge-red'}`}>
                      {prof.status || 'active'}
                    </span>
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'right' }}>
                    <button
                      onClick={() => handleToggleStatus(prof)}
                      className={`btn btn-sm ${prof.status === 'active' ? 'btn-secondary' : 'btn-success'}`}
                    >
                      {prof.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal: Create Professor */}
      {showCreateModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 800 }}>Create Professor Account</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <form onSubmit={handleCreateProfessor} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input
                  type="text"
                  className="form-input"
                  required
                  value={form.full_name}
                  onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                  placeholder="Dr. Alan Turing"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Institutional Email *</label>
                <input
                  type="email"
                  className="form-input"
                  required
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="professor@institution.edu"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Temporary Password *</label>
                <input
                  type="password"
                  className="form-input"
                  required
                  minLength={6}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Min 6 characters"
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary">
                  {saving ? 'Creating…' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
