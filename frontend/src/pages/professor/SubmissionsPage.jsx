/**
 * ExamProctor.ai — Professor Submissions Page (/professor/submissions)
 * Review student submissions, verify honesty scores, evaluate answers, and grant retakes.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileCheck, BookOpen, User, CheckCircle, AlertTriangle, Eye, RotateCcw,
  Search, RefreshCw, Clock, Filter
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';
import styles from './ProfessorDashboard.module.css';

export default function SubmissionsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [exams, setExams] = useState([]);
  const [selectedExamId, setSelectedExamId] = useState('');
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [grantingRetakeId, setGrantingRetakeId] = useState(null);

  const loadExams = useCallback(async () => {
    try {
      const { data } = await api.get('/exams');
      const list = data.data || [];
      setExams(list);
      if (list.length > 0 && !selectedExamId) {
        setSelectedExamId(list[0].exam_id);
      }
    } catch (err) {
      toast('Failed to load examinations.', 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedExamId, toast]);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  const loadSubmissions = useCallback(async (examId) => {
    if (!examId) return;
    setLoadingSubmissions(true);
    try {
      const { data } = await api.get(`/exams/${examId}/results`);
      setSubmissions(data.data?.results || []);
    } catch (err) {
      toast('Failed to load submissions for examination.', 'error');
      setSubmissions([]);
    } finally {
      setLoadingSubmissions(false);
    }
  }, [toast]);

  useEffect(() => {
    if (selectedExamId) {
      loadSubmissions(selectedExamId);
    }
  }, [selectedExamId, loadSubmissions]);

  const handleGrantRetake = async (attemptId, studentName) => {
    if (!window.confirm(`Authorize retake for ${studentName}? This preserves their initial attempt and allows a new attempt.`)) {
      return;
    }
    setGrantingRetakeId(attemptId);
    try {
      const { data } = await api.post(`/attempts/${attemptId}/grant-retake`, {
        reason: 'Authorized retake by professor.',
      });
      toast(data.data?.message || 'Retake authorized.', 'success');
      loadSubmissions(selectedExamId);
    } catch (err) {
      toast(err.response?.data?.message || 'Could not authorize retake.', 'error');
    } finally {
      setGrantingRetakeId(null);
    }
  };

  const filteredSubmissions = submissions.filter((sub) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const nameMatch = (sub.student_name || '').toLowerCase().includes(q);
    const usnMatch = (sub.student_usn || '').toLowerCase().includes(q);
    const emailMatch = (sub.student_email || '').toLowerCase().includes(q);
    return nameMatch || usnMatch || emailMatch;
  });

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Examination Submissions</h1>
          <p className={styles.subtitle}>
            Review candidate answer sheets, proctoring honesty scores, flag violations, and authorize retakes.
          </p>
        </div>
        <button
          onClick={() => loadSubmissions(selectedExamId)}
          className="btn btn-secondary btn-sm"
          title="Refresh submissions"
          disabled={!selectedExamId}
        >
          <RefreshCw size={14} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Selector & Search Toolbar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--space-4)',
        background: 'var(--color-surface)',
        border: 'var(--border-base)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        boxShadow: 'var(--shadow-sm)',
        margin: 'var(--space-6) 0'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flex: 1, minWidth: 260 }}>
          <label htmlFor="select-exam" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800, whiteSpace: 'nowrap' }}>
            Examination:
          </label>
          <select
            id="select-exam"
            className="form-select"
            value={selectedExamId}
            onChange={(e) => setSelectedExamId(e.target.value)}
            style={{ maxWidth: 380 }}
          >
            {exams.map((ex) => (
              <option key={ex.exam_id} value={ex.exam_id}>
                {ex.title} ({ex.exam_code || 'Draft'}) — {ex.status.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="text"
            className="form-input"
            style={{ padding: '6px 12px', fontSize: 'var(--font-size-xs)', width: 240 }}
            placeholder="Search student USN or name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Submissions Table */}
      {loadingSubmissions ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading candidate submissions…</p>
        </div>
      ) : filteredSubmissions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <FileCheck size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Submissions Found
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto' }}>
            {submissions.length === 0
              ? 'No student candidates have submitted responses for this examination yet.'
              : 'No submissions matched your search criteria.'}
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-alt)', borderBottom: 'var(--border-base)' }}>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Student Candidate</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Score</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Honesty / Integrity</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Flags</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Submission Time</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredSubmissions.map((sub) => {
                const isHighIntegrity = (sub.honesty_score ?? 100) >= 80;
                return (
                  <tr key={sub.attempt_id} style={{ borderBottom: 'var(--border-thin)' }}>
                    <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                      <div style={{ fontWeight: 800, color: 'var(--color-text-heading)' }}>{sub.student_name}</div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                        {sub.student_usn || sub.student_email}
                      </div>
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 700 }}>
                      {sub.score !== null ? `${sub.score} / ${sub.total_points || 100}` : 'Pending'}
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                      <span className={`badge ${isHighIntegrity ? 'badge-green' : 'badge-red'}`}>
                        {sub.honesty_score !== undefined ? `${sub.honesty_score}%` : '100%'}
                      </span>
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                      {sub.event_count > 0 ? (
                        <span className="badge badge-yellow">
                          <AlertTriangle size={12} /> {sub.event_count} Events
                        </span>
                      ) : (
                        <span className="badge badge-green">
                          <CheckCircle size={12} /> Clean
                        </span>
                      )}
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--font-size-xs)' }}>
                      {sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : 'In Progress'}
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => navigate(`/professor/attempts/${sub.attempt_id}/review`)}
                          title="Review attempt"
                        >
                          <Eye size={13} />
                          <span>Review</span>
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleGrantRetake(sub.attempt_id, sub.student_name)}
                          disabled={grantingRetakeId === sub.attempt_id}
                          title="Authorize candidate retake"
                        >
                          <RotateCcw size={13} />
                          <span>{grantingRetakeId === sub.attempt_id ? 'Authorizing…' : 'Retake'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
