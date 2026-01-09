import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { authApi } from '../services/api/auth-api';
import type { LoginDto, RegisterDto } from '../services/api/auth-api';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';
import { initDatabase, resetDatabase } from '../lib/db';
import { events } from '../lib/events';
import loglevel from "loglevel";

const log = loglevel.getLogger("AuthStore");
log.setLevel(loglevel.levels.ERROR);

// 用户信息类型（与后端返回一致）
export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  subscriptionTier: string;
  createdAt: string;
  updatedAt: string;
}

// 获取用户的 project ID
export function getProjectId(userId?: string): string {
  if (!userId) {
    return 'default-project'; // 匿名用户
  }
  return `default-project-${userId}`;
}

// Auth Store 状态接口
interface AuthState {
  // 状态
  isAuthenticated: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  
  // Actions
  login: (dto: LoginDto) => Promise<void>;
  register: (dto: RegisterDto) => Promise<void>;
  logout: () => void;
  setAccessToken: (token: string) => void;
  refreshUserInfo: () => Promise<void>;
}

// 创建 Auth Store
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isAuthenticated: false,
      accessToken: null,
      refreshToken: null,
      user: null,

      // 登录
      login: async (dto: LoginDto) => {
        try {
          if (isAppClosedForPublic) {
            throw new Error(APP_CLOSED_MESSAGE);
          }
          const response = await authApi.login(dto);
          
          set({
            isAuthenticated: true,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            user: response.user,
          });

          log.info('[Auth] Login successful:', response.user.email);
          
          // 登录成功后：切换到用户专属数据库，然后从服务器拉取数据
          try {
            // 1. 重置当前数据库连接
            await resetDatabase();
            
            // 2. 初始化用户专属数据库
            const projectId = getProjectId(response.user.id);
            await initDatabase(projectId, response.user.id);
            events.emit('db:ready');
            
            log.info('[Auth] User database initialized:', response.user.id);
            
            // 3. 从服务器拉取数据到本地数据库
            const { syncPullService } = await import('../lib/sync/sync-pull.service');
            await syncPullService.initialSync();
          } catch (error) {
            log.error('[Auth] Failed to initialize user database or sync:', error);
          }
        } catch (error) {
          log.error('[Auth] Login failed:', error);
          throw error;
        }
      },

      // 注册
      register: async (dto: RegisterDto) => {
        try {
          if (isAppClosedForPublic) {
            throw new Error(APP_CLOSED_MESSAGE);
          }
          const response = await authApi.register(dto);
          
          // 注册成功后自动登录
          set({
            isAuthenticated: true,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            user: response.user,
          });

          log.info('[Auth] Registration successful:', response.user.email);
          
          // 注册成功后：切换到用户专属数据库，然后从服务器拉取数据
          try {
            await resetDatabase();
            const projectId = getProjectId(response.user.id);
            await initDatabase(projectId, response.user.id);
            events.emit('db:ready');
            
            log.info('[Auth] User database initialized:', response.user.id);
            
            const { syncPullService } = await import('../lib/sync/sync-pull.service');
            await syncPullService.initialSync();
          } catch (error) {
            log.error('[Auth] Failed to initialize user database or sync:', error);
          }
        } catch (error) {
          log.error('[Auth] Registration failed:', error);
          throw error;
        }
      },

      // 登出
      logout: async () => {
        const state = get();
        
        // 调用后端登出接口（可选，失败不影响本地登出）
        if (state.accessToken) {
          authApi.logout().catch((error) => {
            log.error('[Auth] Logout API call failed:', error);
          });
        }

        // 清除本地状态
        set({
          isAuthenticated: false,
          accessToken: null,
          refreshToken: null,
          user: null,
        });

        // 重置数据库连接，切换回匿名/demo模式的数据库
        try {
          await resetDatabase();
          await initDatabase(getProjectId()); // 无userId，使用匿名数据库
          events.emit('db:ready');
          log.info('[Auth] Switched to anonymous database');
        } catch (error) {
          log.error('[Auth] Failed to reset database on logout:', error);
        }

        log.info('[Auth] Logout successful');
      },

      // 设置 Access Token（用于 Token 刷新）
      setAccessToken: (token: string) => {
        set({ accessToken: token });
        log.info('[Auth] Access token updated');
      },

      // 刷新用户信息
      refreshUserInfo: async () => {
        try {
          const user = await authApi.getCurrentUser();
          set({ user });
          log.info('[Auth] User info refreshed:', user.email);
        } catch (error) {
          log.error('[Auth] Failed to refresh user info:', error);
          // 如果刷新失败，可能是 token 过期，登出用户
          get().logout();
          throw error;
        }
      },
    }),
    {
      name: 'auth-storage', // localStorage key
      storage: createJSONStorage(() => localStorage),
      // 只持久化必要的数据
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

// 导出 Auth Store 类型（用于 api.ts 动态导入）
export type AuthStore = ReturnType<typeof useAuthStore.getState>;
