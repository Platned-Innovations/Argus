import { type Permission } from '@argus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { AppShell } from './components/AppShell';
import { CenteredSpinner, EmptyState } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { AiSettingsPage } from './pages/admin/AiSettingsPage';
import { AuditPage } from './pages/admin/AuditPage';
import { IntegrationsPage } from './pages/admin/IntegrationsPage';
import { ScanningSettingsPage } from './pages/admin/ScanningSettingsPage';
import { SecuritySettingsPage } from './pages/admin/SecuritySettingsPage';
import { SourcesPage } from './pages/admin/SourcesPage';
import { TeamsPage } from './pages/admin/TeamsPage';
import { UsersPage } from './pages/admin/UsersPage';
import { DashboardPage } from './pages/DashboardPage';
import { FindingsPage } from './pages/FindingsPage';
import { ThreatIntelPage } from './pages/ThreatIntelPage';
import { TicketDetailPage } from './pages/TicketDetailPage';
import { TicketsPage } from './pages/TicketsPage';
import { PackagesPage } from './pages/PackagesPage';
import { SuppressionsPage } from './pages/SuppressionsPage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { RepositoriesPage } from './pages/RepositoriesPage';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage';
import { RequiredSetupPage } from './pages/RequiredSetupPage';
import './styles.css';
// Sonner also tries to inject these styles as an inline <style> tag, which the CSP (style-src 'self') blocks by design.
import 'sonner/dist/styles.css';
import { ShieldOff } from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <CenteredSpinner />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (me.restrictions.passwordChangeRequired || me.restrictions.mfaEnrollmentRequired) return <RequiredSetupPage />;
  return <AppShell>{children}</AppShell>;
}

function Allow({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? children : <EmptyState icon={<ShieldOff className="size-5" />} title="Not available" description="You do not have permission to view this page." />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Routes>
              <Route index element={<DashboardPage />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="repositories" element={<Allow permission="repos:read"><RepositoriesPage /></Allow>} />
              <Route path="repositories/:id" element={<Allow permission="repos:read"><RepositoryDetailPage /></Allow>} />
              <Route path="findings" element={<Allow permission="findings:read"><FindingsPage /></Allow>} />
              <Route path="packages" element={<Allow permission="repos:read"><PackagesPage /></Allow>} />
              <Route path="suppressions" element={<Allow permission="findings:read"><SuppressionsPage /></Allow>} />
              <Route path="admin/scanning" element={<Allow permission="settings:read"><ScanningSettingsPage /></Allow>} />
              <Route path="tickets" element={<Allow permission="tickets:read"><TicketsPage /></Allow>} />
              <Route path="tickets/:id" element={<Allow permission="tickets:read"><TicketDetailPage /></Allow>} />
              <Route path="intel" element={<Allow permission="findings:read"><ThreatIntelPage /></Allow>} />
              <Route path="admin/ai" element={<Allow permission="settings:manage"><AiSettingsPage /></Allow>} />
              <Route path="admin/integrations" element={<Allow permission="settings:manage"><IntegrationsPage /></Allow>} />
              <Route path="admin/sources" element={<Allow permission="sources:manage"><SourcesPage /></Allow>} />
              <Route path="admin/users" element={<Allow permission="users:read"><UsersPage /></Allow>} />
              <Route path="admin/teams" element={<Allow permission="teams:read"><TeamsPage /></Allow>} />
              <Route path="admin/audit" element={<Allow permission="audit:read"><AuditPage /></Allow>} />
              <Route path="admin/security" element={<Allow permission="settings:read"><SecuritySettingsPage /></Allow>} />
              <Route path="*" element={<EmptyState icon={<ShieldOff className="size-5" />} title="Page not found" />} />
            </Routes>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster richColors position="top-right" />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
