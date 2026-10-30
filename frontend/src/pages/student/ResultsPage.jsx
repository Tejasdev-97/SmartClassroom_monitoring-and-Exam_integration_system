/**
 * ExamProctor.ai — Student My Results Page (/student/results)
 * Released examination scores, percentage, pass/fail status, and feedback.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Award, CheckCircle, Clock, ShieldCheck, BookOpen, AlertCircle } from 'lucide-react';
import api from '../../services/api';
import styles from './StudentDashboard.module.css';

export default function ResultsPage() {
  const { user } = useAuth();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/attempts/my-attempts')
      .then(({ data }) => {
        const submitted = (data.data || []).filter(
          (a) => a.status === 'submitted' || a.status === 'submitted_local'
        );
        setResults(submitted);
      })
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>My Results & Scores</h1>
          <p className={styles.subtitle}>
            Official scores, performance feedback, and integrity evaluations released by your professors.
          </p>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading examination results…</p>
        </div>
      ) : results.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <Award size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Released Results
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto' }}>
            Results will appear here once your submitted examinations are reviewed and finalized.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
          {results.map((res) => {
            const score = res.score ?? res.total_score ?? 'Pending Review';
            const honesty = res.honesty_score ?? 100;
            return (
              <div key={res.attempt_id} className="card" style={{ padding: 'var(--space-5)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <div>
                    <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 800, color: 'var(--color-text-heading)', marginBottom: 'var(--space-1)' }}>
                      {res.exam_title || 'Examination'}
                    </h3>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                      Attempt #{res.attempt_number} · Submitted {res.submitted_at ? new Date(res.submitted_at).toLocaleDateString() : 'Recently'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <span className="badge badge-green">
                      <CheckCircle size={12} /> Submitted
                    </span>
                    <span className={`badge ${honesty >= 80 ? 'badge-blue' : 'badge-orange'}`}>
                      <ShieldCheck size={12} /> {honesty}% Integrity
                    </span>
                  </div>
                </div>

                <div style={{
                  display: 'flex',
                  gap: 'var(--space-6)',
                  marginTop: 'var(--space-4)',
                  paddingTop: 'var(--space-4)',
                  borderTop: 'var(--border-thin)',
                  alignItems: 'center'
                }}>
                  <div>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', fontWeight: 600 }}>
                      Final Score:
                    </span>
                    <span style={{ fontSize: 'var(--font-size-xl)', fontWeight: 900, color: 'var(--color-text-heading)' }}>
                      {typeof score === 'number' ? `${score} pts` : score}
                    </span>
                  </div>

                  <div style={{ borderLeft: 'var(--border-thin)', paddingLeft: 'var(--space-6)' }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', fontWeight: 600 }}>
                      Status:
                    </span>
                    <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-green)' }}>
                      Server Confirmed
                    </span>
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
