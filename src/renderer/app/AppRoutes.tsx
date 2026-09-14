import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { isAuthRequired } from '../lib/config';
import { useAuthStore } from '../store/auth';
import { FullScreenStatus } from './components/FullScreenStatus';
import { LoginPage } from '../views/LoginPage';
import { RegisterPage } from '../views/RegisterPage';
import { ProjectPickerView } from '../views/ProjectPickerView';
import { MobileAuthPage } from '../shells/mobile/standalone/MobileAuthPage';
import { MobileProjectShelfView } from '../shells/mobile/standalone/MobileProjectShelfView';
import { getPlatformRuntime } from '../platform/runtime';
import { DeferredProjectRoute } from './DeferredProjectRoute';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const authRequired = isAuthRequired();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  useEffect(() => {
    void import('../lib/feature-access').then((module) => {
      if (!isAuthenticated || !userId) {
        module.resetFeatureAccess();
        return;
      }
      void module.refreshFeatureAccess(userId);
    });
  }, [isAuthenticated, userId]);

  if (isChecking) return <FullScreenStatus title={t('appShell.checkingAuthentication')} />;
  if (authRequired && (!isAuthenticated || !userId)) return <Navigate to="/login" replace />;
  return children;
}

function PublicRoute({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const authRequired = isAuthRequired();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  if (isChecking) return <FullScreenStatus title={t('appShell.checkingAuthentication')} />;
  if (!authRequired || (isAuthenticated && !!userId)) return <Navigate to="/" replace />;
  return children;
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
            <DeferredProjectRoute view="settings" />
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
    </Routes>
  );
}
