/**
 * ExamProctor.ai — Student Available Exams Page (/student/available-exams)
 * Lists scheduled and active examinations with details and direct entry.
 */

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { BookOpen, Clock, Play, ArrowRight, ShieldCheck, Key } from 'lucide-react';
import api from '../../services/api';
import styles from './StudentDashboard.module.css';

export default function AvailableExamsPage() {
  const navigate = useNavigate();
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // In student context, we fetch exams or load from public listing
    api.get('/exams')
      .then(({ data }) => {
        const publishedOrLive = (data.data || []).filter(
          (e) => e.status === 'active' || e.status === 'published'
        );
        setExams(publishedOrLive);
      })
      .catch(() => setExams([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Available Examinations</h1>
          <p className={styles.subtitle}>
            Examinations scheduled for your registered cohort or currently active for submission.
          </p>
        </div>
        <Link to="/student/enter-exam" className="btn btn-primary btn-sm">
          <Key size={14} />
          <span>Enter Exam Code</span>
        </Link>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading available exams…</p>
        </div>
      ) : exams.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <BookOpen size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Open Examinations
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 420, margin: '0 auto var(--space-6)' }}>
            Your professor has not opened any live examinations right now. If your professor provided an exam code, enter it directly.
          </p>
          <Link to="/student/enter-exam" className="btn btn-primary">
            <Key size={16} />
            <span>Enter Exam Code</span>
          </Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-6)' }}>
          {exams.map((exam) => {
            const isLive = exam.status === 'active';
            return (
              <div key={exam.exam_id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-2)' }}>
                    <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 800, color: 'var(--color-text-heading)' }}>
                      {exam.title}
                    </h3>
                    <span className={`badge ${isLive ? 'badge-green' : 'badge-yellow'}`}>
                      {isLive ? 'LIVE' : 'SCHEDULED'}
                    </span>
                  </div>
                  <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)' }}>
                    {exam.instructions || 'Standard AI-proctored examination instructions apply.'}
                  </p>
                  <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Clock size={13} /> {Math.floor(exam.duration_seconds / 60)} minutes
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <ShieldCheck size={13} /> AI Monitored
                    </span>
                  </div>
                </div>

                <div style={{ paddingTop: 'var(--space-3)', borderTop: 'var(--border-thin)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {exam.exam_code ? (
                    <span style={{ fontFamily: 'monospace', fontWeight: 800, background: 'var(--color-surface-alt)', padding: '3px 8px', borderRadius: 'var(--radius-sm)', border: 'var(--border-thin)' }}>
                      Code: {exam.exam_code}
                    </span>
                  ) : <span />}

                  <Link to="/student/enter-exam" className={`btn btn-sm ${isLive ? 'btn-primary' : 'btn-secondary'}`}>
                    <span>Take Exam</span>
                    <ArrowRight size={13} />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
