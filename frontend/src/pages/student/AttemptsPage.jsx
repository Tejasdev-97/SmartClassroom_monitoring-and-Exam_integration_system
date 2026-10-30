/**
 * ExamProctor.ai — Student My Attempts Page (/student/attempts)
 * Active and previous attempts, local Dexie cache, and server synchronization status.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Clock, ArrowRight, Check, RefreshCw, WifiOff, AlertCircle } from 'lucide-react';
import { attemptRepo } from '../../storage/repositories';
import { useBackgroundSync, syncAttempt } from '../../workers/useSyncWorker';
import api from '../../services/api';
import styles from './StudentDashboard.module.css';

function StatusBadge({ status }) {
  const map = {
    authorized:      { cls: 'badge-blue',   label: 'Ready to start' },
    in_progress:     { cls: 'badge-orange',  label: 'In progress' },
    submitted_local: { cls: 'badge-yellow',  label: 'Saved on device — sync pending' },
    submitted:       { cls: 'badge-green',   label: 'Submitted — server confirmed' },
    expired:         { cls: 'badge-red',     label: 'Expired' },
  };
  const { cls, label } = map[status] || { cls: 'badge-blue', label: status };
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function AttemptsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncingMap, setSyncingMap] = useState({});
  const [syncErrors, setSyncErrors] = useState({});

  const loadLocal = useCallback(async () => {
    if (!user?.user_id) return;
    try {
      const local = await attemptRepo.getAllForStudent(user.user_id);
      const attemptMap = new Map();
      local.forEach((a) => attemptMap.set(a.attempt_id, a));

      try {
        const { data } = await api.get('/attempts/my-attempts');
        const serverAttempts = data.data || [];
        for (const sa of serverAttempts) {
          const existing = attemptMap.get(sa.attempt_id);
          const status = (existing?.status === 'submitted_local' && sa.status !== 'submitted')
            ? 'submitted_local'
            : sa.status;

          const merged = {
            ...existing,
            ...sa,
            status,
            student_user_id: user.user_id,
          };
          attemptMap.set(sa.attempt_id, merged);
          await attemptRepo.save(merged);
        }
      } catch (err) {
        console.warn('Network sync for student attempts unavailable; using local cache.', err?.message);
      }

      const isolated = Array.from(attemptMap.values()).filter(
        (a) => a.student_user_id === user.user_id
      );

      setAttempts(isolated.sort((a, b) =>
        new Date(b.authorized_at || 0) - new Date(a.authorized_at || 0)
      ));
    } catch (e) {
      console.error('Failed to load student attempts', e);
    } finally {
      setLoading(false);
    }
  }, [user?.user_id]);

  useEffect(() => {
    loadLocal();
  }, [loadLocal]);

  useBackgroundSync(loadLocal);

  const handleManualSync = async (attemptId) => {
    if (!navigator.onLine) {
      setSyncErrors((prev) => ({ ...prev, [attemptId]: 'Internet connection required to synchronize.' }));
      return;
    }
    setSyncingMap((prev) => ({ ...prev, [attemptId]: true }));
    setSyncErrors((prev) => ({ ...prev, [attemptId]: null }));
    try {
      const res = await syncAttempt(attemptId);
      if (res.status === 'error' || res.status === 'auth_expired') {
        setSyncErrors((prev) => ({
          ...prev,
          [attemptId]: res.message || 'Synchronization encountered an error; retryable.',
        }));
      } else {
        setSyncErrors((prev) => ({ ...prev, [attemptId]: null }));
      }
      await loadLocal();
    } catch (err) {
      setSyncErrors((prev) => ({
        ...prev,
        [attemptId]: err.message || 'Sync failed. Local data preserved.',
      }));
    } finally {
      setSyncingMap((prev) => ({ ...prev, [attemptId]: false }));
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>My Examination Attempts</h1>
          <p className={styles.subtitle}>
            Track active attempts, review submission states, and synchronize offline responses.
          </p>
        </div>
        <button onClick={loadLocal} className="btn btn-secondary btn-sm" title="Refresh">
          <RefreshCw size={14} />
          <span>Refresh</span>
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading attempts…</p>
        </div>
      ) : attempts.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <Clock size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Attempts Found
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto var(--space-4)' }}>
            You haven't started or submitted any examinations yet.
          </p>
        </div>
      ) : (
        <div className={styles.attemptList}>
          {attempts.map((attempt) => {
            const isServerConfirmed = attempt.status === 'submitted';
            const isPendingSync = attempt.status === 'submitted_local';
            const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
            const dur = attempt.duration_seconds ? `${Math.floor(attempt.duration_seconds / 60)} min` : '—';
            const isSyncing = syncingMap[attempt.attempt_id];
            const syncError = syncErrors[attempt.attempt_id];

            return (
              <div key={attempt.attempt_id} className={styles.attemptCard}>
                <div className={styles.attemptHeader}>
                  <div>
                    <div className={styles.attemptTitle}>{attempt.exam_title || 'Examination'}</div>
                    <div className={styles.attemptMeta}>
                      Attempt #{attempt.attempt_number} · Duration: {dur}
                    </div>
                  </div>
                  <StatusBadge status={attempt.status} />
                </div>

                {syncError && isPendingSync && (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-red)', marginBottom: 'var(--space-2)', fontWeight: 600 }}>
                    {syncError}
                  </div>
                )}

                <div className={styles.attemptFooter}>
                  <span className={styles.attemptDate}>
                    {attempt.authorized_at ? new Date(attempt.authorized_at).toLocaleString() : '—'}
                  </span>

                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    {(attempt.status === 'authorized' || attempt.status === 'in_progress') && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => navigate(`/student/exam/${attempt.attempt_id}`)}
                      >
                        Resume <ArrowRight size={14} />
                      </button>
                    )}

                    {(isPendingSync || isServerConfirmed) && (
                      <button
                        className="btn btn-success btn-sm"
                        disabled={isServerConfirmed || isSyncing || !isOnline}
                        onClick={() => handleManualSync(attempt.attempt_id)}
                      >
                        {isSyncing ? (
                          <>
                            <RefreshCw size={13} className="animate-spin" /> Syncing…
                          </>
                        ) : isServerConfirmed ? (
                          <>
                            <Check size={13} /> Synced
                          </>
                        ) : !isOnline ? (
                          <>
                            <WifiOff size={13} /> Offline
                          </>
                        ) : (
                          <>
                            <RefreshCw size={13} /> Sync Now
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
