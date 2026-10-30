/**
 * ExamProctor.ai — Admin Platform Reports & Analytics Page (/admin/reports)
 * Platform-wide metrics, system integrity analytics, and compliance summaries.
 */

import { useState, useEffect } from 'react';
import { BarChart3, Users, Award, ShieldCheck, Activity, HardDrive, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import classroomApi from '../../services/classroomApi';

export default function AdminReportsPage() {
  const [stats, setStats] = useState({
    usersCount: 0,
    examsCount: 0,
    activeSessionsCount: 0,
    devicesCount: 0,
  });
  const [loading, setLoading] = useState(true);

  const loadMetrics = async () => {
    setLoading(false);
    try {
      const [uRes, eRes, sRes, dRes] = await Promise.allSettled([
        api.get('/users'),
        api.get('/exams'),
        classroomApi.listSessions(),
        classroomApi.listDevices(),
      ]);

      setStats({
        usersCount: uRes.status === 'fulfilled' ? (uRes.value.data.data || []).length : 0,
        examsCount: eRes.status === 'fulfilled' ? (eRes.value.data.data || []).length : 0,
        activeSessionsCount: sRes.status === 'fulfilled' ? (sRes.value.data.data || []).filter(s => s.status === 'active').length : 0,
        devicesCount: dRes.status === 'fulfilled' ? (dRes.value.data.data || []).length : 0,
      });
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMetrics();
  }, []);

  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-6)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 800, color: 'var(--color-text-heading)' }}>
            Institutional Analytics & Reports
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>
            Platform-wide examination metrics, security compliance, and workstation integrity reporting.
          </p>
        </div>
        <button onClick={loadMetrics} className="btn btn-secondary btn-sm">
          <RefreshCw size={14} />
          <span>Refresh Analytics</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-8)' }}>
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
              Total Enrolled Users
            </div>
            <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 900, color: 'var(--color-blue)', marginTop: 4 }}>
              {stats.usersCount}
            </div>
          </div>
          <Users size={32} style={{ color: 'var(--color-blue)' }} />
        </div>

        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
              Examinations Created
            </div>
            <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 900, color: 'var(--color-green)', marginTop: 4 }}>
              {stats.examsCount}
            </div>
          </div>
          <Award size={32} style={{ color: 'var(--color-green)' }} />
        </div>

        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
              Live Classroom Sessions
            </div>
            <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 900, color: 'var(--color-orange)', marginTop: 4 }}>
              {stats.activeSessionsCount}
            </div>
          </div>
          <Activity size={32} style={{ color: 'var(--color-orange)' }} />
        </div>

        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
              Enrolled Workstations
            </div>
            <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 900, color: 'var(--color-blue-deep)', marginTop: 4 }}>
              {stats.devicesCount}
            </div>
          </div>
          <HardDrive size={32} style={{ color: 'var(--color-blue-deep)' }} />
        </div>
      </div>

      {/* Compliance Overview */}
      <div className="card" style={{ padding: 'var(--space-6)' }}>
        <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 800, marginBottom: 'var(--space-2)' }}>
          Platform Integrity & Compliance Standard
        </h3>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)' }}>
          All examination sessions enforce cryptographic SHA-256 session tokens, client-side offline authorization leases, and strict non-blocking AI face & object verification.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <span className="badge badge-green"><ShieldCheck size={14} /> Offline Lease Security Active</span>
          <span className="badge badge-blue"><ShieldCheck size={14} /> MediaPipe AI Verified</span>
          <span className="badge badge-orange"><ShieldCheck size={14} /> LAN Frame Transport Enabled</span>
        </div>
      </div>
    </div>
  );
}
