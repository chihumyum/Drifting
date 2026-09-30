import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { APP_CONFIG } from '../lib/config';
import { useAuthStore } from '../store/auth';
import { FullScreenStatus } from './components/FullScreenStatus';
import { LoginPage } from '../views/LoginPage';
import { RegisterPage } from '../views/RegisterPage';
import { ProjectPickerView } from '../views/ProjectPickerView';
import { MobileAuthPage } from '../shells/mobile/standalone/MobileAuthPage';
import { MobileProjectShelfView } from '../shells/mobile/standalone/MobileProjectShelfView';
import { getPlatformRuntime } from '../platform/runtime';
import { DeferredProjectRoute } from './DeferredProjectRoute';
import { DesktopStandaloneSettingsView } from '../features/settings/desktop/DesktopStandaloneSettingsView';
import { MobileSettingsView } from '../shells/mobile/standalone/MobileSettingsView';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  if (isChecking) return <FullScreenStatus title={t('appShell.checkingAuthentication')} loading />;
  return children;
}

function PublicRoute({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const checkSession = useAuthStore(state => state.checkSession);
  useEffect(() => { void checkSession().then(() => setReady(true)); }, [checkSession]);
  // Login owns navigation until its initial library sync finishes (or fails).
  if (APP_CONFIG.LOCAL_ONLY_MODE) return <Navigate to="/" replace />;
  return ready ? children : <FullScreenStatus title={t('appShell.checkingAuthentication')} loading />;
}

export function AppRoutes() {
  const isMobileShell = getPlatformRuntime().isMobileShell;
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            {isMobileShell ? <MobileAuthPage initialMode="signin" /> : <LoginPage />}
          </PublicRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicRoute>
            {isMobileShell ? <MobileAuthPage initialMode="signup" /> : <RegisterPage />}
          </PublicRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            {isMobileShell ? <MobileProjectShelfView /> : <ProjectPickerView />}
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            {isMobileShell ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />}
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:projectId"
        element={
          <ProtectedRoute>
            <DeferredProjectRoute view="workspace" />
          </ProtectedRoute>
        }
      >
        <Route
          index
          element={
            <DeferredProjectRoute view="home" />
          }
        />
        <Route path="home" element={<Navigate to=".." replace />} />
        <Route path="new" element={null} />
        <Route path="editor" element={<Navigate to=".." replace />} />
        <Route
          path="editor/all"
          element={
            <DeferredProjectRoute view="allChapters" />
          }
        />
        <Route
          path="editor/:nodeId"
          element={
            <DeferredProjectRoute view="node" />
          }
        />
        <Route
          path="editor/storyline/:storylineId"
          element={
            <DeferredProjectRoute view="storyline" />
          }
        />
        <Route
          path="element/:elementId"
          element={
            <DeferredProjectRoute view="element" />
          }
        />
        <Route
          path="category/:categoryId"
          element={
            <DeferredProjectRoute view="category" />
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
