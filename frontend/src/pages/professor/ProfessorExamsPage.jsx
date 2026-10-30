/**
 * ExamProctor.ai — Professor My Exams Page (/professor/exams)
 * Complete management of Draft, Published, Active, and Closed exams.
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Plus, BookOpen, Clock, Play, Square, PenLine, RotateCcw,
  Search, Eye, FileSpreadsheet, RefreshCw, AlertTriangle
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import styles from './ProfessorDashboard.module.css';

export default function ProfessorExamsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const loadExams = useCallback(() => {
    setLoading(true);
    api.get('/exams')
      .then(({ data }) => setExams(data.data || []))
      .catch((err) => {
        console.error(err);
        toast('Failed to load examinations', 'error');
      })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  const handleGoLive = async (examId) => {
    try {
      await api.post(`/exams/${examId}/go-live`);
      toast('Examination is now LIVE for students.', 'success');
      loadExams();
    } catch (err) {
      toast(err.response?.data?.message || 'Could not make examination live.', 'error');
    }
  };

  const handleEndExam = async (examId) => {
    if (!window.confirm('End this active examination? Students will no longer be able to submit.')) return;
    try {
      await api.post(`/exams/${examId}/close`);
      toast('Examination ended successfully.', 'success');
      loadExams();
    } catch (err) {
      toast(err.response?.data?.message || 'Failed to end examination.', 'error');
    }
  };

  const filteredExams = exams.filter((e) => {
    if (activeTab === 'active' && e.status !== 'active') return false;
    if (activeTab === 'published' && e.status !== 'published') return false;
    if (activeTab === 'draft' && e.status !== 'draft') return false;
    if (activeTab === 'closed' && e.status !== 'closed') return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (e.title || '').toLowerCase().includes(q);
      const matchCode = (e.exam_code || '').toLowerCase().includes(q);
      return matchTitle || matchCode;
    }
    return true;
  });

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>My Examinations</h1>
          <p className={styles.subtitle}>
            Manage, publish, schedule, and review all your institution examination sessions.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button onClick={loadExams} className="btn btn-secondary btn-sm" title="Refresh">
            <RefreshCw size={14} />
            <span>Refresh</span>
          </button>
          <Link to="/professor/exams/new" className="btn btn-primary btn-sm">
            <Plus size={14} />
            <span>Create Exam</span>
          </Link>
        </div>
      </div>

      {/* Tabs and Search Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-4)', margin: 'var(--space-6) 0' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {[
            { id: 'all', label: `All (${exams.length})` },
            { id: 'active', label: `Live (${exams.filter(e => e.status === 'active').length})` },
            { id: 'published', label: `Scheduled (${exams.filter(e => e.status === 'published').length})` },
            { id: 'draft', label: `Drafts (${exams.filter(e => e.status === 'draft').length})` },
            { id: 'closed', label: `Ended (${exams.filter(e => e.status === 'closed').length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-secondary'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="text"
            className="form-input"
            style={{ padding: '6px 12px', fontSize: 'var(--font-size-xs)', width: 220 }}
            placeholder="Search exam title or code…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Loading examinations…</p>
        </div>
      ) : filteredExams.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <BookOpen size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Examinations Found
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto var(--space-4)' }}>
            {exams.length === 0 ? 'You have not created any examinations yet.' : 'No examinations match your selected filter.'}
          </p>
          <Link to="/professor/exams/new" className="btn btn-primary">
            <Plus size={14} />
            <span>Create New Exam</span>
          </Link>
        </div>
      ) : (
        <div className={styles.examList}>
          {filteredExams.map((exam) => {
            const isLive = exam.status === 'active';
            const isDraft = exam.status === 'draft';
            const isPublished = exam.status === 'published';
            return (
              <div key={exam.exam_id} className={styles.examCard}>
                <div className={styles.examCardHeader}>
                  <div>
                    <div className={styles.examCardTitle}>{exam.title}</div>
                    <div className={styles.examCardMeta}>
                      {exam.exam_code ? (
                        <span className={styles.codeChip}>{exam.exam_code}</span>
                      ) : (
                        <span style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>Draft</span>
                      )}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Clock size={13} /> {Math.floor(exam.duration_seconds / 60)} min
                      </span>
                    </div>
                  </div>
                  <span className={`badge ${isLive ? 'badge-green' : exam.status === 'closed' ? 'badge-orange' : isPublished ? 'badge-yellow' : 'badge-blue'}`}>
                    {isLive ? 'LIVE' : exam.status.toUpperCase()}
                  </span>
                </div>

                <div className={styles.examCardFooter}>
                  <span className={styles.examCardDate}>
                    {exam.published_at ? `Published: ${new Date(exam.published_at).toLocaleDateString()}` : `Created: ${new Date(exam.created_at).toLocaleDateString()}`}
                  </span>

                  <div className={styles.examCardActions}>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => navigate(`/professor/exams/${exam.exam_id}/edit`)}
                      disabled={isLive}
                      title="Edit examination"
                    >
                      <PenLine size={13} />
                      <span>Edit</span>
                    </button>

                    {(isDraft || isPublished) && (
                      <button
                        className="btn btn-sm btn-amber"
                        onClick={() => handleGoLive(exam.exam_id)}
                        title="Make examination live"
                      >
                        <Play size={13} />
                        <span>Go Live</span>
                      </button>
                    )}

                    {isLive && (
                      <>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => navigate(`/professor/exams/${exam.exam_id}/monitor`)}
                        >
                          <Eye size={13} />
                          <span>Monitor</span>
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleEndExam(exam.exam_id)}
                        >
                          <Square size={13} />
                          <span>End</span>
                        </button>
                      </>
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
