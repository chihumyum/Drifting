import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { isAuthRequired } from '../lib/config';
import { useAuthStore } from '../store/auth';
import { FullScreenStatus } from './components/FullScreenStatus';
import { LoginPage } from '../views/LoginPage';
import { RegisterPage } from '../views/RegisterPage';
import { ProjectPickerView } from '../views/ProjectPickerView';
import { ProjectDashboard } from '../views/ProjectDashboard';
import { EditorShell } from '../views/EditorShell';
import { DesktopAppShell } from '../shells/desktop/DesktopAppShell';
import {
  DesktopAllChaptersEditorRoute,
  DesktopCategoryEditorRoute,
  DesktopElementEditorRoute,
  DesktopNodeEditorRoute,
  DesktopStorylineEditorRoute,
} from '../features/editor/desktop/DesktopEditorRoutes';

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
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicRoute>
            <RegisterPage />
          </PublicRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ProjectPickerView />
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:projectId"
        element={
          <ProtectedRoute>
            <DesktopAppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={null} />
        <Route
          path="home"
          element={
            <EditorShell view="project-dashboard">
              <ProjectDashboard />
            </EditorShell>
          }
        />
        <Route path="editor" element={<Navigate to=".." replace />} />
        <Route
          path="editor/all"
          element={
            <EditorShell view="all-chapters-editor">
              <DesktopAllChaptersEditorRoute />
            </EditorShell>
          }
        />
        <Route
          path="editor/:nodeId"
          element={
            <EditorShell view="node-editor">
              <DesktopNodeEditorRoute />
            </EditorShell>
          }
        />
        <Route
          path="editor/storyline/:storylineId"
          element={
            <EditorShell view="storyline-editor">
              <DesktopStorylineEditorRoute />
            </EditorShell>
          }
        />
        <Route
          path="element/:elementId"
          element={
            <EditorShell view="element-editor">
              <DesktopElementEditorRoute />
            </EditorShell>
          }
        />
        <Route
          path="category/:categoryId"
          element={
            <EditorShell view="category-editor">
              <DesktopCategoryEditorRoute />
            </EditorShell>
          }
        />
      </Route>
    </Routes>
  );
}
