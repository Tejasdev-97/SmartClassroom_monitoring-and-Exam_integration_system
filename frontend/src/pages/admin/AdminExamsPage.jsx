/**
 * ExamProctor.ai — Admin Examination Management Page (/admin/exams)
 * Institution-wide oversight of all examinations across all departments and professors.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Clock, Play, Square, Eye, RefreshCw, AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';

export default function AdminExamsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const loadExams = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/exams');
      setExams(data.data || []);
    } catch {
      toast('Failed to load institution examinations.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  const filtered = exams.filter((e) => {
    if (filter === 'active') return e.status === 'active';
    if (filter === 'published') return e.status === 'published';
    if (filter === 'closed') return e.status === 'closed';
    return true;
  });

  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-6)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 800, color: 'var(--color-text-heading)' }}>
            Institution Examination Oversight
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>
            Monitor and audit all scheduled, active, and completed examinations across the institution.
          </p>
        </div>
        <button onClick={loadExams} className="btn btn-secondary btn-sm">
          <RefreshCw size={14} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-6)' }}>
        {['all', 'active', 'published', 'closed'].map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`btn btn-sm ${filter === t ? 'btn-primary' : 'btn-secondary'}`}
          >
            {t.toUpperCase()} ({exams.filter(e => t === 'all' ? true : e.status === t).length})
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading examinations…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <BookOpen size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Examinations Found
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto' }}>
            No exams match the selected status filter.
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-alt)', borderBottom: 'var(--border-base)' }}>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Examination</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Code</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Duration</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Status</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Created</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'right' }}>Audit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((exam) => (
                <tr key={exam.exam_id} style={{ borderBottom: 'var(--border-thin)' }}>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 800 }}>
                    {exam.title}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontFamily: 'monospace' }}>
                    {exam.exam_code || '—'}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    {Math.floor(exam.duration_seconds / 60)} min
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    <span className={`badge ${exam.status === 'active' ? 'badge-green' : exam.status === 'closed' ? 'badge-orange' : 'badge-blue'}`}>
                      {exam.status.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--font-size-xs)' }}>
                    {new Date(exam.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'right' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => navigate(`/professor/exams/${exam.exam_id}/monitor`)}
                      title="Inspect examination session"
                    >
                      <Eye size={13} />
                      <span>Inspect</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
