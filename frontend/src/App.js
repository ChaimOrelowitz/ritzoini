import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/layout/Layout.js';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import GroupDetailPage from './pages/GroupDetailPage';
import AdminUsersPage from './pages/AdminUsersPage';
import InstructorsPage from './pages/InstructorsPage';
import CalendarPage from './pages/CalendarPage';
import SetPasswordPage from './pages/SetPasswordPage';
import PaymentsPage from './pages/PaymentsPage';
import SessionsPage from './pages/SessionsPage';
import ComingSoonPage from './pages/ComingSoonPage';
import OOClientsPage from './pages/OOClientsPage';
import OOClientDetailPage from './pages/OOClientDetailPage';
import OOReferralSourcesPage from './pages/OOReferralSourcesPage';
import OOCallsPage from './pages/OOCallsPage';
import OOCallListPage from './pages/OOCallListPage';
import OOTranscriptsPage from './pages/OOTranscriptsPage';
import OOPeerNotesPage from './pages/OOPeerNotesPage';
import PeerSupervisionPage from './pages/PeerSupervisionPage';

function PrivateRoute({ children, adminOnly = false }) {
  const { user, profile, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && profile?.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/set-password" element={<SetPasswordPage />} />
        <Route path="/" element={
          <PrivateRoute><Layout /></PrivateRoute>
        }>
          <Route index element={<DashboardPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="groups/:id" element={<GroupDetailPage />} />
          <Route path="supervisors" element={
            <PrivateRoute adminOnly><AdminUsersPage /></PrivateRoute>
          } />
          <Route path="instructors" element={
            <PrivateRoute><InstructorsPage /></PrivateRoute>
          } />
          <Route path="payments" element={
            <PrivateRoute adminOnly><PaymentsPage /></PrivateRoute>
          } />
          {/* Legacy redirect */}
          <Route path="users" element={<Navigate to="/supervisors" replace />} />

          {/* One-On-One section */}
          <Route path="oo" element={<OOClientsPage />} />
          <Route path="oo/clients"          element={<OOClientsPage />} />
          <Route path="oo/clients/:id"      element={<OOClientDetailPage />} />
          <Route path="oo/calls"            element={<OOCallsPage />} />
          <Route path="oo/call-list"        element={<OOCallListPage />} />
          <Route path="oo/transcripts"      element={<OOTranscriptsPage />} />
          <Route path="oo/referral-sources" element={<OOReferralSourcesPage />} />
          <Route path="oo/peer-notes"       element={<OOPeerNotesPage />} />
          <Route path="oo/sessions" element={<ComingSoonPage title="One-On-One Sessions" />} />
          <Route path="oo/payments" element={<ComingSoonPage title="One-On-One Payments" />} />

          {/* Peer Supervision section */}
          <Route path="ps" element={<PeerSupervisionPage />} />
          <Route path="ps/sessions" element={<PeerSupervisionPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
