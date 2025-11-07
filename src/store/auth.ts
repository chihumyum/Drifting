import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { authApi } from '../services/api/auth-api';
import type { LoginDto, RegisterDto } from '../services/api/auth-api';

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
          const response = await authApi.login(dto);
          
          set({
            isAuthenticated: true,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            user: response.user,
          });

          console.log('[Auth] Login successful:', response.user.email);
          
          // 登录成功后触发初始同步
          setTimeout(async () => {
            try {
              const { syncPullService } = await import('../lib/sync/sync-pull.service');
              await syncPullService.initialSync();
            } catch (error) {
              console.error('[Auth] Failed to trigger initial sync:', error);
            }
          }, 1000); // 延迟 1 秒，避免阻塞登录流程
        } catch (error) {
          console.error('[Auth] Login failed:', error);
          throw error;
        }
      },

      // 注册
      register: async (dto: RegisterDto) => {
        try {
          const response = await authApi.register(dto);
          
          // 注册成功后自动登录
          set({
            isAuthenticated: true,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            user: response.user,
          });

          console.log('[Auth] Registration successful:', response.user.email);
          
          // 注册成功后触发初始同步
          setTimeout(async () => {
            try {
              const { syncPullService } = await import('../lib/sync/sync-pull.service');
              await syncPullService.initialSync();
            } catch (error) {
              console.error('[Auth] Failed to trigger initial sync:', error);
            }
          }, 1000);
        } catch (error) {
          console.error('[Auth] Registration failed:', error);
          throw error;
        }
      },

      // 登出
      logout: () => {
        const state = get();
        
        // 调用后端登出接口（可选，失败不影响本地登出）
        if (state.accessToken) {
          authApi.logout().catch((error) => {
            console.error('[Auth] Logout API call failed:', error);
          });
        }

        // 清除本地状态
        set({
          isAuthenticated: false,
          accessToken: null,
          refreshToken: null,
          user: null,
        });

        console.log('[Auth] Logout successful');
      },

      // 设置 Access Token（用于 Token 刷新）
      setAccessToken: (token: string) => {
        set({ accessToken: token });
        console.log('[Auth] Access token updated');
      },

      // 刷新用户信息
      refreshUserInfo: async () => {
        try {
          const user = await authApi.getCurrentUser();
          set({ user });
          console.log('[Auth] User info refreshed:', user.email);
        } catch (error) {
          console.error('[Auth] Failed to refresh user info:', error);
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
