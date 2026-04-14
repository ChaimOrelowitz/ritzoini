import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/layout/Layout.js';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import GroupDetailPage from './pages/GroupDetailPage';
import SupervisorsPage from './pages/SupervisorsPage';
import InstructorsPage from './pages/InstructorsPage';
import CalendarPage from './pages/CalendarPage';

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
        <Route path="/" element={
          <PrivateRoute><Layout /></PrivateRoute>
        }>
          <Route index element={<DashboardPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="groups/:id" element={<GroupDetailPage />} />
          <Route path="supervisors" element={
            <PrivateRoute adminOnly><SupervisorsPage /></PrivateRoute>
          } />
          <Route path="instructors" element={
            <PrivateRoute><InstructorsPage /></PrivateRoute>
          } />
          {/* Legacy redirect */}
          <Route path="users" element={<Navigate to="/supervisors" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
