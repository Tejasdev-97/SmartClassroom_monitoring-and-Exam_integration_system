/**
 * ExamProctor.ai — Professor Results & Reports Page (/professor/reports)
 * Analytics, grade distribution, candidate performance, and export (PDF / Excel).
 */

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart3, Download, FileSpreadsheet, FileText, CheckCircle,
  AlertTriangle, BookOpen, Users, Award, RefreshCw
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';
import styles from './ProfessorDashboard.module.css';

export default function ReportsPage() {
  const { toast } = useToast();
  const [exams, setExams] = useState([]);
  const [selectedExamId, setSelectedExamId] = useState('');
  const [resultsData, setResultsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [exporting, setExporting] = useState(false);

  const loadExams = useCallback(async () => {
    try {
      const { data } = await api.get('/exams');
      const list = data.data || [];
      setExams(list);
      if (list.length > 0 && !selectedExamId) {
        setSelectedExamId(list[0].exam_id);
      }
    } catch {
      toast('Failed to load examinations.', 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedExamId, toast]);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  const loadResults = useCallback(async (examId) => {
    if (!examId) return;
    setLoadingData(true);
    try {
      const { data } = await api.get(`/exams/${examId}/results`);
      setResultsData(data.data || null);
    } catch {
      toast('Failed to load report data.', 'error');
      setResultsData(null);
    } finally {
      setLoadingData(false);
    }
  }, [toast]);

  useEffect(() => {
    if (selectedExamId) {
      loadResults(selectedExamId);
    }
  }, [selectedExamId, loadResults]);

  const handleDownload = async (format) => {
    if (!selectedExamId) return;
    setExporting(true);
    try {
      const res = await api.get(
        `/exams/${selectedExamId}/results/export?format=${format}`,
        { responseType: 'blob' }
      );
      const ext = format === 'excel' ? 'xlsx' : 'pdf';
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `results_${selectedExamId.slice(0, 8)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Exported ${format.toUpperCase()} report successfully.`, 'success');
    } catch {
      toast('Failed to export results report.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const results = resultsData?.results || [];
  const totalSubmissions = results.length;
  const avgScore = totalSubmissions > 0
    ? (results.reduce((acc, r) => acc + (r.score || 0), 0) / totalSubmissions).toFixed(1)
    : '0';
  const avgHonesty = totalSubmissions > 0
    ? (results.reduce((acc, r) => acc + (r.honesty_score ?? 100), 0) / totalSubmissions).toFixed(1)
    : '100';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Results & Reports</h1>
          <p className={styles.subtitle}>
            Performance metrics, grade analytics, candidate compliance summaries, and exportable grade books.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            onClick={() => handleDownload('pdf')}
            disabled={exporting || !selectedExamId || totalSubmissions === 0}
            className="btn btn-secondary btn-sm"
          >
            <FileText size={14} />
            <span>Export PDF</span>
          </button>
          <button
            onClick={() => handleDownload('excel')}
            disabled={exporting || !selectedExamId || totalSubmissions === 0}
            className="btn btn-primary btn-sm"
          >
            <FileSpreadsheet size={14} />
            <span>Export Excel</span>
          </button>
        </div>
      </div>

      {/* Exam Selector */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        background: 'var(--color-surface)',
        border: 'var(--border-base)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        boxShadow: 'var(--shadow-sm)',
        margin: 'var(--space-6) 0'
      }}>
        <label htmlFor="report-select-exam" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800 }}>
          Select Examination:
        </label>
        <select
          id="report-select-exam"
          className="form-select"
          value={selectedExamId}
          onChange={(e) => setSelectedExamId(e.target.value)}
          style={{ maxWidth: 440 }}
        >
          {exams.map((ex) => (
            <option key={ex.exam_id} value={ex.exam_id}>
              {ex.title} ({ex.exam_code || 'Draft'})
            </option>
          ))}
        </select>
      </div>

      {/* Aggregate KPI Cards */}
      <div className={styles.metricsGrid} style={{ marginBottom: 'var(--space-6)' }}>
        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span className={styles.metricLabel}>Total Submissions</span>
            <Users size={18} style={{ color: 'var(--color-blue)' }} />
          </div>
          <div className={styles.metricValue}>{totalSubmissions}</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span className={styles.metricLabel}>Average Score</span>
            <Award size={18} style={{ color: 'var(--color-green)' }} />
          </div>
          <div className={styles.metricValue}>{avgScore}</div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span className={styles.metricLabel}>Avg. Honesty Score</span>
            <CheckCircle size={18} style={{ color: 'var(--color-blue-deep)' }} />
          </div>
          <div className={styles.metricValue}>{avgHonesty}%</div>
        </div>
      </div>

      {/* Grade Details Table */}
      {loadingData ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto var(--space-4)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Calculating score distribution…</p>
        </div>
      ) : totalSubmissions === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <BarChart3 size={48} style={{ color: 'var(--color-blue)', margin: '0 auto var(--space-3)' }} />
          <h3 style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-heading)', marginBottom: 'var(--space-2)' }}>
            No Results Recorded
          </h3>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 360, margin: '0 auto' }}>
            No candidate attempt records have been submitted for this examination yet.
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-alt)', borderBottom: 'var(--border-base)' }}>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Candidate</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>USN / ID</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Score</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Honesty Score</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Integrity Events</th>
                <th style={{ padding: 'var(--space-3) var(--space-4)' }}>Submitted At</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.attempt_id} style={{ borderBottom: 'var(--border-thin)' }}>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 700 }}>
                    {r.student_name}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
                    {r.student_usn || r.student_email}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 800 }}>
                    {r.score !== null ? r.score : '—'}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    <span className={`badge ${(r.honesty_score ?? 100) >= 80 ? 'badge-green' : 'badge-red'}`}>
                      {r.honesty_score !== undefined ? `${r.honesty_score}%` : '100%'}
                    </span>
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    {r.event_count > 0 ? (
                      <span className="badge badge-yellow">{r.event_count} Events</span>
                    ) : (
                      <span className="badge badge-green">0</span>
                    )}
                  </td>
                  <td style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--font-size-xs)' }}>
                    {r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'}
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
