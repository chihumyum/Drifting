import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

interface ProtectedRouteProps {
  children: ReactNode;
}

interface LocationState {
  from?: {
    pathname: string;
  };
}

/**
 * 路由守卫组件
 * 未登录用户会被重定向到登录页面
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const location = useLocation();

  if (!isAuthenticated) {
    // 保存用户尝试访问的路径，登录后可以重定向回来
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

interface PublicOnlyRouteProps {
  children: ReactNode;
}

/**
 * 公共路由守卫组件
 * 已登录用户访问登录/注册页面会被重定向到首页
 */
export function PublicOnlyRoute({ children }: PublicOnlyRouteProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const location = useLocation();

  if (isAuthenticated) {
    // 如果有保存的来源路径，重定向到该路径，否则重定向到首页
    const state = location.state as LocationState | undefined;
    const from = state?.from?.pathname || '/';
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
}
