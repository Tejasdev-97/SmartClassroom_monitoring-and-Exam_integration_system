/**
 * ExamProctor.ai — Dedicated Professor Live Monitoring Page
 *
 * Dedicated live monitoring experience, separate from Classroom Management.
 * Displays:
 *   - Active sessions switcher
 *   - Overall live metrics (Active Desks, Streaming Screens, Streaming Webcams, Active Alerts)
 *   - Embedded CCTV Live Monitoring Matrix or session launcher
 *   - Real screen, webcam, active process, and AI detection feeds
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Radio, Monitor, Play, Pause, Square, AlertTriangle, ShieldCheck,
  RefreshCw, Wifi, WifiOff, Users, ArrowRight, Eye, ExternalLink, Activity
} from 'lucide-react';
import classroomApi from '../../../services/classroomApi';
import ClassroomDashboard from './ClassroomDashboard';
import styles from './ClassroomPage.module.css';

export default function LiveMonitoringPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await classroomApi.listSessions();
      const list = data.data || [];
      setSessions(list);
      // Auto-select active or pending session
      const active = list.find((s) => s.status === 'active') || list.find((s) => s.status === 'paused') || list[0];
      if (active && !selectedSessionId) {
        setSelectedSessionId(active.session_id);
      }
    } catch (e) {
      console.error('Failed to load sessions for live monitoring', e);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 10000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const activeSessions = sessions.filter((s) => s.status === 'active');
  const otherSessions = sessions.filter((s) => s.status !== 'active');

  return (
    <div className={styles.page}>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span className="badge badge-red" style={{ padding: '3px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Radio size={12} className="pulse" /> LIVE STREAMING
            </span>
            <span className="badge badge-blue" style={{ padding: '3px 8px', fontSize: '0.75rem' }}>
              PROCTOR CONSOLE
            </span>
          </div>
          <h1 className={styles.title} style={{ marginTop: 'var(--space-2)' }}>
            Real-Time Live Classroom & Student Monitoring
          </h1>
          <p className={styles.subtitle}>
            Direct visual oversight of student screens, circular webcam previews, active applications, and integrity violations across authorized examination workstations.
          </p>
        </div>

        <div className={styles.headerActions}>
          <Link to="/professor/classroom" className="btn btn-secondary btn-sm" id="btn-goto-classroom-mgmt">
            <Monitor size={14} />
            <span>Classroom Management</span>
          </Link>
          <button onClick={loadSessions} className="btn btn-secondary btn-sm" title="Refresh Sessions">
            <RefreshCw size={14} />
            <span>Refresh Feeds</span>
          </button>
        </div>
      </div>

      {/* ── Active Session Switcher Tabs ─────────────────────────────────── */}
      {sessions.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'center',
          overflowX: 'auto',
          paddingBottom: 'var(--space-2)',
          marginBottom: 'var(--space-4)',
          borderBottom: 'var(--border-thin)'
        }}>
          <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 800, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginRight: 'var(--space-2)' }}>
            Select Room:
          </span>
          {sessions.map((s) => {
            const isSelected = selectedSessionId === s.session_id;
            const isActive = s.status === 'active';
            return (
              <button
                key={s.session_id}
                onClick={() => setSelectedSessionId(s.session_id)}
                className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  whiteSpace: 'nowrap',
                  fontWeight: isSelected ? 800 : 600,
                  boxShadow: isSelected ? '3px 3px 0 var(--color-border)' : '1px 1px 0 var(--color-border)',
                }}
              >
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: isActive ? 'var(--color-green)' : s.status === 'paused' ? 'var(--color-orange)' : '#94a3b8'
                }} />
                <span>{s.room_name}</span>
                <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>({s.status.toUpperCase()})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Main Monitoring View ─────────────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading live monitoring matrix…</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <Monitor size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Classroom Sessions Configured
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 440, margin: '0 auto var(--space-6)' }}>
            Create and start a classroom session in Classroom Management to begin real-time desktop screen and webcam monitoring.
          </p>
          <Link to="/professor/classroom" className="btn btn-primary">
            <Monitor size={16} />
            <span>Go to Classroom Management</span>
          </Link>
        </div>
      ) : (
        selectedSessionId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Quick Session Stats Banner */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-heading)' }}>
                Active Session Matrix: <span style={{ color: 'var(--color-blue)' }}>{sessions.find(s => s.session_id === selectedSessionId)?.room_name}</span>
              </div>
              <Link
                to={`/professor/classroom/session/${selectedSessionId}`}
                className="btn btn-secondary btn-sm"
                title="Open fullscreen standalone CCTV matrix"
              >
                <ExternalLink size={14} />
                <span>Open Fullscreen Monitor</span>
              </Link>
            </div>

            {/* Embedded Live CCTV Dashboard */}
            <ClassroomDashboard key={selectedSessionId} />
          </div>
        )
      )}
    </div>
  );
}
