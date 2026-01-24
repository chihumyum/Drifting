import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { authClient } from '../lib/auth-client';
import type { Session } from '../lib/auth-client';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';
import { initDatabase, resetDatabase } from '../lib/db';
import { events } from '../lib/events';
import loglevel from "loglevel";

const log = loglevel.getLogger("AuthStore");
log.setLevel(loglevel.levels.ERROR);

// 用户信息类型
export interface User {
  id: string;
  email: string;
  name: string;
  image?: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// 获取用户的数据库文件名（不是 project ID！）
export function getDbFileName(userId?: string): string {
  if (!userId) {
    return 'drifting-library.db'; // 匿名用户
  }
  return `${userId}_drifting.db`;
}

// Auth Store 状态接口
interface AuthState {
  // 状态
  isAuthenticated: boolean;
  session: Session | null;
  user: User | null;
  
  // Actions
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  initAuth: () => Promise<void>;
}

// 创建 Auth Store
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isAuthenticated: false,
      session: null,
      user: null,

      // 登录
      login: async (email: string, password: string) => {
        try {
          if (isAppClosedForPublic) {
            throw new Error(APP_CLOSED_MESSAGE);
          }
          
          const result = await authClient.signIn.email({
            email,
            password,
          });
          
          if (result.error) {
            throw new Error(result.error.message || 'Login failed');
          }

          // signIn returns { user, token }, not { session }
          // We need to get the session separately
          const sessionResult = await authClient.getSession();
          
          set({
            isAuthenticated: true,
            session: sessionResult.data || null,
            user: result.data?.user as User,
          });

          log.info('[Auth] Login successful:', result.data?.user?.email);
          
          // 登录成功后：切换到用户专属数据库
          try {
            await resetDatabase();
            await initDatabase(result.data?.user?.id);
            events.emit('db:ready');
            
            log.info('[Auth] User database initialized:', result.data?.user?.id);
          } catch (error) {
            log.error('[Auth] Failed to initialize user database:', error);
          }
        } catch (error) {
          log.error('[Auth] Login failed:', error);
          throw error;
        }
      },

      // 注册
      register: async (email: string, password: string, name: string) => {
        try {
          if (isAppClosedForPublic) {
            throw new Error(APP_CLOSED_MESSAGE);
          }
          
          const result = await authClient.signUp.email({
            email,
            password,
            name,
          });
          
          if (result.error) {
            throw new Error(result.error.message || 'Registration failed');
          }

          // signUp returns { user, token }, not { session }
          // We need to get the session separately
          const sessionResult = await authClient.getSession();
          
          set({
            isAuthenticated: true,
            session: sessionResult.data || null,
            user: result.data?.user as User,
          });

          log.info('[Auth] Registration successful:', result.data?.user?.email);
          
          // 注册成功后：切换到用户专属数据库
          try {
            await resetDatabase();
            const dbFileName = getDbFileName(result.data?.user?.id);
            await initDatabase(dbFileName);
            
            log.info('[Auth] User database initialized:', result.data?.user?.id);
          } catch (error) {
            log.error('[Auth] Failed to initialize user database:', error);
          }
        } catch (error) {
          log.error('[Auth] Registration failed:', error);
          throw error;
        }
      },

      // 登出
      logout: async () => {
        try {
          await authClient.signOut();
        } catch (error) {
          log.error('[Auth] Logout API call failed:', error);
        }

        // 清除本地状态
        set({
          isAuthenticated: false,
          session: null,
          user: null,
        });

        // 重置数据库连接，切换回匿名/demo模式的数据库
        try {
          await resetDatabase();
          await initDatabase(getDbFileName());
          events.emit('db:ready');
          log.info('[Auth] Anonymous database');
        } catch (error) {
          log.error('[Auth] Failed to reset database on logout:', error);
        }

        log.info('[Auth] Logout successful');
      },

      // 检查 session 状态
      checkSession: async () => {
        try {
          const result = await authClient.getSession();
          
          if (result.data) {
            set({
              isAuthenticated: true,
              session: result.data,
              user: result.data.user as User,
            });
          } else {
            set({
              isAuthenticated: false,
              session: null,
              user: null,
            });
          }
        } catch (error) {
          log.error('[Auth] Failed to check session:', error);
          set({
            isAuthenticated: false,
            session: null,
            user: null,
          });
        }
      },

      // 初始化认证状态
      initAuth: async () => {
        await get().checkSession();
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        session: state.session,
        user: state.user,
      }),
    }
  )
);

// 导出 Auth Store 类型
export type AuthStore = ReturnType<typeof useAuthStore.getState>;
