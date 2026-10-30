/**
 * ExamProctor.ai — Root Application
 * Sets up providers, router, and lazy-loaded page routes.
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import './index.css';

// In Electron / file:// protocol, HTML5 pushState cannot match filesystem paths.
// We use HashRouter for Electron desktop and preserve BrowserRouter for the web.
const isElectron = typeof window !== 'undefined' && (Boolean(window.electronAPI?.isElectron) || window.location.protocol === 'file:');
const Router = isElectron ? HashRouter : BrowserRouter;

// ── Layouts ───────────────────────────────────────────────────────────────
import AppLayout from './components/layout/AppLayout';
import ExamLayout from './components/layout/ExamLayout';

// ── Auth & Public pages ─────────────────────────────────────────────────────
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const LandingPage = lazy(() => import('./pages/public/LandingPage'));

// ── Student pages ──────────────────────────────────────────────────────────
const StudentDashboard    = lazy(() => import('./pages/student/StudentDashboard'));
const AvailableExamsPage  = lazy(() => import('./pages/student/AvailableExamsPage'));
const ExamEntryPage       = lazy(() => import('./pages/student/ExamEntryPage'));
const AttemptsPage        = lazy(() => import('./pages/student/AttemptsPage'));
const ResultsPage         = lazy(() => import('./pages/student/ResultsPage'));
const DeviceStatusPage    = lazy(() => import('./pages/student/DeviceStatusPage'));
const ReadinessPage       = lazy(() => import('./pages/student/ReadinessPage'));
const ExamSessionPage     = lazy(() => import('./pages/student/ExamSessionPage'));

// ── Professor pages ────────────────────────────────────────────────────────
const ProfessorDashboard  = lazy(() => import('./pages/professor/ProfessorDashboard'));
const ProfessorExamsPage  = lazy(() => import('./pages/professor/ProfessorExamsPage'));
const ExamBuilderPage     = lazy(() => import('./pages/professor/ExamBuilderPage'));
const ExamMonitorPage     = lazy(() => import('./pages/professor/ExamMonitorPage'));
const AttemptReviewPage   = lazy(() => import('./pages/professor/AttemptReviewPage'));
const VideoAnalysisPage   = lazy(() => import('./pages/professor/VideoAnalysisPage'));
const SubmissionsPage     = lazy(() => import('./pages/professor/SubmissionsPage'));
const ReportsPage         = lazy(() => import('./pages/professor/ReportsPage'));

// ── Classroom Monitoring pages ─────────────────────────────────────────────
const ClassroomPage       = lazy(() => import('./pages/professor/classroom/ClassroomPage'));
const ClassroomDashboard  = lazy(() => import('./pages/professor/classroom/ClassroomDashboard'));
const DeviceManagerPage   = lazy(() => import('./pages/professor/classroom/DeviceManagerPage'));
const LiveMonitoringPage  = lazy(() => import('./pages/professor/classroom/LiveMonitoringPage'));

// ── Admin pages ────────────────────────────────────────────────────────────
const AdminDashboard      = lazy(() => import('./pages/admin/AdminDashboard'));
const UserManagement      = lazy(() => import('./pages/admin/UserManagement'));
const AdminProfessorsPage = lazy(() => import('./pages/admin/AdminProfessorsPage'));
const AdminExamsPage      = lazy(() => import('./pages/admin/AdminExamsPage'));
const AdminReportsPage    = lazy(() => import('./pages/admin/AdminReportsPage'));
const SystemSettings      = lazy(() => import('./pages/admin/SystemSettings'));
const AuditLogPage        = lazy(() => import('./pages/admin/AuditLogPage'));

// ── Shared ─────────────────────────────────────────────────────────────────
const ProfilePage         = lazy(() => import('./pages/shared/ProfilePage'));
const NotFoundPage        = lazy(() => import('./pages/NotFoundPage'));

function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--color-page-bg)',
    }}>
      <div className="spinner spinner-lg" />
    </div>
  );
}

function RequireAuth({ children, allowedRoles }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/unauthorized" replace />;
  }
  return children;
}

function RoleRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'admin') return <Navigate to="/admin" replace />;
  if (user.role === 'professor') return <Navigate to="/professor" replace />;
  return <Navigate to="/student" replace />;
}

export default function App() {
  return (
    <Router>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* Public: Desktop app lands on /login, web lands on LandingPage */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={isElectron ? <Navigate to="/login" replace /> : <LandingPage />} />

              {/* Student routes */}
              <Route element={<RequireAuth allowedRoles={['student']}><AppLayout /></RequireAuth>}>
                <Route path="/student" element={<StudentDashboard />} />
                <Route path="/student/available-exams" element={<AvailableExamsPage />} />
                <Route path="/student/enter-exam" element={<ExamEntryPage />} />
                <Route path="/student/attempts" element={<AttemptsPage />} />
                <Route path="/student/results" element={<ResultsPage />} />
                <Route path="/student/status" element={<DeviceStatusPage />} />
                <Route path="/student/profile" element={<ProfilePage />} />
                <Route path="/student/readiness/:attemptId" element={<ReadinessPage />} />
              </Route>

              {/* Exam session — full-page layout (no sidebar) */}
              <Route element={<RequireAuth allowedRoles={['student']}><ExamLayout /></RequireAuth>}>
                <Route path="/student/exam/:attemptId" element={<ExamSessionPage />} />
              </Route>

              {/* Professor routes */}
              <Route element={<RequireAuth allowedRoles={['professor', 'admin']}><AppLayout /></RequireAuth>}>
                <Route path="/professor" element={<ProfessorDashboard />} />
                <Route path="/professor/exams" element={<ProfessorExamsPage />} />
                <Route path="/professor/exams/new" element={<ExamBuilderPage />} />
                <Route path="/professor/exams/:examId/edit" element={<ExamBuilderPage />} />
                <Route path="/professor/exams/:examId/monitor" element={<ExamMonitorPage />} />
                <Route path="/professor/live-monitoring" element={<LiveMonitoringPage />} />
                <Route path="/professor/video-analysis" element={<VideoAnalysisPage />} />
                <Route path="/professor/submissions" element={<SubmissionsPage />} />
                <Route path="/professor/reports" element={<ReportsPage />} />
                <Route path="/professor/classroom" element={<ClassroomPage />} />
                <Route path="/professor/classroom/session/:sessionId" element={<ClassroomDashboard />} />
                <Route path="/professor/classroom/devices" element={<DeviceManagerPage />} />
                <Route path="/professor/profile" element={<ProfilePage />} />
                <Route path="/professor/attempts/:attemptId/review" element={<AttemptReviewPage />} />
              </Route>

              {/* Admin routes */}
              <Route element={<RequireAuth allowedRoles={['admin']}><AppLayout /></RequireAuth>}>
                <Route path="/admin" element={<AdminDashboard />} />
                <Route path="/admin/users" element={<UserManagement />} />
                <Route path="/admin/professors" element={<AdminProfessorsPage />} />
                <Route path="/admin/exams" element={<AdminExamsPage />} />
                <Route path="/admin/classroom" element={<ClassroomPage />} />
                <Route path="/admin/video-analysis" element={<VideoAnalysisPage />} />
                <Route path="/admin/reports" element={<AdminReportsPage />} />
                <Route path="/admin/settings" element={<SystemSettings />} />
                <Route path="/admin/audit" element={<AuditLogPage />} />
                <Route path="/admin/profile" element={<ProfilePage />} />
              </Route>

              {/* Shared profile route */}
              <Route path="/profile" element={<RequireAuth><AppLayout><ProfilePage /></AppLayout></RequireAuth>} />

              {/* 404 */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </AuthProvider>
    </Router>
  );
}
