/**
 * ExamProctor.ai — Shared User Profile Page
 * Displays authenticated user information, role badges, institutional identifiers, and security state.
 */

import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { User, ShieldCheck, Mail, Key, Hash, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';

export default function ProfilePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [updating, setUpdating] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast('New passwords do not match.', 'error');
      return;
    }
    setUpdating(true);
    setStatusMsg(null);
    try {
      // In this system, user profile password update
      await api.patch('/users/me/password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      toast('Password updated successfully.', 'success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setStatusMsg({ type: 'success', text: 'Password successfully changed.' });
    } catch (err) {
      const msg = err?.response?.data?.message || err?.response?.data?.error?.message || 'Password update failed.';
      toast(msg, 'error');
      setStatusMsg({ type: 'error', text: msg });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: 860, margin: '0 auto' }}>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 800, color: 'var(--color-text-heading)' }}>
          Account Profile & Security
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>
          Manage your personal credentials, view your institutional role, and update your access password.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-6)' }}>
        {/* User Identity Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-blue)',
              color: '#ffffff',
              fontSize: '1.5rem',
              fontWeight: 900,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'var(--border-base)',
              boxShadow: '2px 2px 0 var(--color-border)'
            }}>
              {user?.full_name?.charAt(0)?.toUpperCase() || '?'}
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 800, color: 'var(--color-text-heading)' }}>
                {user?.full_name || 'Authenticated User'}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 4 }}>
                <span className={`badge ${user?.role === 'admin' ? 'badge-red' : user?.role === 'professor' ? 'badge-orange' : 'badge-blue'}`}>
                  {user?.role?.toUpperCase()}
                </span>
                <span className="badge badge-green">Active</span>
              </div>
            </div>
          </div>

          <div style={{ borderTop: 'var(--border-thin)', paddingTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)' }}>
              <span style={{ color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Mail size={14} /> Email Address:
              </span>
              <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{user?.email || '—'}</span>
            </div>

            {user?.usn && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)' }}>
                <span style={{ color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Hash size={14} /> Student USN / ID:
                </span>
                <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{user?.usn}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)' }}>
              <span style={{ color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ShieldCheck size={14} /> Authentication ID:
              </span>
              <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>
                {user?.user_id ? `${user.user_id.slice(0, 12)}…` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Change Password Card */}
        <div className="card">
          <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 800, marginBottom: 'var(--space-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Key size={18} style={{ color: 'var(--color-blue)' }} /> Change Access Password
          </h3>

          {statusMsg && (
            <div className={`alert ${statusMsg.type === 'success' ? 'badge-green' : 'badge-red'}`} style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-2) var(--space-3)' }}>
              {statusMsg.text}
            </div>
          )}

          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div className="form-group">
              <label className="form-label">Current Password</label>
              <input
                type="password"
                className="form-input"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <div className="form-group">
              <label className="form-label">New Password</label>
              <input
                type="password"
                className="form-input"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 6 characters"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Confirm New Password</label>
              <input
                type="password"
                className="form-input"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-type new password"
              />
            </div>

            <button
              type="submit"
              disabled={updating || !currentPassword || !newPassword}
              className="btn btn-primary"
              style={{ marginTop: 'var(--space-2)' }}
            >
              {updating ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
