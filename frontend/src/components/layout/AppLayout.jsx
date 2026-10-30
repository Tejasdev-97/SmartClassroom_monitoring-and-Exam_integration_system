/**
 * ExamProctor.ai — Main App Layout (Fixed, Collapsible & Responsive Sidebar)
 * Shared across Student, Professor, and Administrator dashboards.
 */

import { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  LayoutDashboard, BookOpen, Users, Settings, LogOut,
  ShieldCheck, Video, Menu, X, ChevronLeft, ChevronRight, Monitor,
  Radio, PlusCircle, CheckCircle, BarChart3, User, Key, Clock, Award,
  Laptop, GraduationCap,
} from 'lucide-react';
import brandLogo from '../../assets/examproctor.ai_logo.png';
import styles from './AppLayout.module.css';

function NavItem({ to, icon: Icon, label, collapsed, onClick }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={({ isActive }) =>
        `${styles.navItem} ${isActive ? styles.navItemActive : ''} ${collapsed ? styles.navItemCollapsed : ''}`
      }
    >
      <Icon size={20} strokeWidth={2} style={{ flexShrink: 0 }} />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('ep_sidebar_collapsed') === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('ep_sidebar_collapsed', String(next));
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const closeMobileDrawer = () => setMobileOpen(false);

  // 3.1 Professor Sidebar Navigation
  const professorLinks = [
    { to: '/professor', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/professor/exams/new', icon: PlusCircle, label: 'Create Exam' },
    { to: '/professor/exams', icon: BookOpen, label: 'My Exams' },
    { to: '/professor/live-monitoring', icon: Radio, label: 'Live Monitoring' },
    { to: '/professor/video-analysis', icon: Video, label: 'Video Analysis' },
    { to: '/professor/submissions', icon: CheckCircle, label: 'Submissions' },
    { to: '/professor/reports', icon: BarChart3, label: 'Results & Reports' },
    { to: '/professor/classroom', icon: Monitor, label: 'Classroom Management' },
    { to: '/professor/profile', icon: User, label: 'Profile' },
  ];

  // 3.2 Student Sidebar Navigation
  const studentLinks = [
    { to: '/student', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/student/available-exams', icon: BookOpen, label: 'Available Exams' },
    { to: '/student/enter-exam', icon: Key, label: 'Enter Exam' },
    { to: '/student/attempts', icon: Clock, label: 'My Attempts' },
    { to: '/student/results', icon: Award, label: 'My Results' },
    { to: '/student/status', icon: Laptop, label: 'Device & Proctoring Status' },
    { to: '/student/profile', icon: User, label: 'Profile' },
  ];

  // 3.3 Admin Sidebar Navigation
  const adminLinks = [
    { to: '/admin', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/admin/users', icon: Users, label: 'User Management' },
    { to: '/admin/professors', icon: GraduationCap, label: 'Professor Management' },
    { to: '/admin/exams', icon: BookOpen, label: 'Examination Management' },
    { to: '/admin/classroom', icon: Monitor, label: 'Classroom & Device Management' },
    { to: '/admin/video-analysis', icon: Video, label: 'Video Analysis' },
    { to: '/admin/reports', icon: BarChart3, label: 'Reports & Analytics' },
    { to: '/admin/settings', icon: Settings, label: 'System Settings' },
    { to: '/admin/audit', icon: ShieldCheck, label: 'Audit Logs' },
    { to: '/admin/profile', icon: User, label: 'Profile' },
  ];

  const links =
    user?.role === 'admin' ? adminLinks :
    user?.role === 'professor' ? professorLinks :
    studentLinks;

  return (
    <div className={styles.shell}>
      {/* ── Mobile Topbar ─────────────────────────────────────────────────── */}
      <header className={styles.mobileTopbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <img
            src={brandLogo}
            alt="ExamProctor.ai"
            className={styles.brandLogoImg}
            style={{ width: 32, height: 32 }}
          />
          <span style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', letterSpacing: '-0.02em' }}>
            ExamProctor<span style={{ color: 'var(--color-orange)' }}>.ai</span>
          </span>
        </div>
        <button
          className={styles.mobileMenuBtn}
          onClick={() => setMobileOpen(true)}
          aria-label="Open Navigation Menu"
          id="btn-mobile-menu"
        >
          <Menu size={24} />
        </button>
      </header>

      {/* ── Mobile Backdrop ───────────────────────────────────────────────── */}
      {mobileOpen && (
        <div
          className={styles.mobileBackdrop}
          onClick={closeMobileDrawer}
          aria-hidden="true"
        />
      )}

      {/* ── Fixed Sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''} ${mobileOpen ? styles.sidebarMobileOpen : ''}`}
        aria-label="Sidebar navigation"
      >
        {/* Brand & Collapse Header */}
        <div className={styles.brand}>
          <div className={styles.brandLeft}>
            <img
              src={brandLogo}
              alt="ExamProctor.ai"
              className={styles.brandLogoImg}
            />
            {!collapsed && (
              <div>
                <div className={styles.brandName}>ExamProctor<span>.ai</span></div>
                <div className={styles.brandRole}>{user?.role?.toUpperCase()}</div>
              </div>
            )}
          </div>

          {/* Desktop Collapse / Mobile Close Button */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {mobileOpen ? (
              <button
                className={styles.collapseBtn}
                onClick={closeMobileDrawer}
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            ) : (
              <button
                className={styles.collapseBtn}
                onClick={toggleCollapse}
                title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
                aria-label={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
                id="btn-toggle-sidebar"
              >
                {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
              </button>
            )}
          </div>
        </div>

        {/* Navigation Items (Scrollable) */}
        <nav className={styles.nav} aria-label="Main navigation">
          {links.map((l) => (
            <NavItem
              key={l.to}
              {...l}
              collapsed={collapsed}
              onClick={closeMobileDrawer}
            />
          ))}
        </nav>

        {/* Anchored Footer (User Profile & Red Logout) */}
        <div className={styles.sidebarFooter}>
          {!collapsed && (
            <div className={styles.userInfo}>
              <div className={styles.userAvatar}>
                {user?.full_name?.charAt(0)?.toUpperCase() || '?'}
              </div>
              <div className={styles.userDetails}>
                <span className={styles.userName}>{user?.full_name}</span>
                <span className={styles.userUsn}>{user?.usn || user?.email}</span>
              </div>
            </div>
          )}

          <button
            className={`${styles.logoutBtn} ${collapsed ? styles.logoutBtnCollapsed : ''}`}
            onClick={handleLogout}
            id="btn-logout"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut size={16} />
            {!collapsed && <span>Log out</span>}
          </button>
        </div>
      </aside>

      {/* ── Main Content Area ─────────────────────────────────────────────── */}
      <main className={`${styles.main} ${collapsed ? styles.mainCollapsed : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
