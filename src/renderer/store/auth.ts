import { create } from 'zustand';
import { authClient } from '../lib/auth-client';
import type { Session } from '../lib/auth-client';
import { clearSessionToken, flushSessionTokenStorage } from '../lib/session-token';
import { isAuthRequired } from '../lib/config';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';
import { initDatabase, resetDatabase } from '../lib/db';
import { events } from '../lib/events';
import loglevel from 'loglevel';

const log = loglevel.getLogger('AuthStore');
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

const LOCAL_USER_ID = 'drifting-library.db';

function createLocalUser(): User {
  const now = new Date();
  return {
    id: LOCAL_USER_ID,
    email: 'local@drifting.local',
    name: 'Local User',
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  };
}

// 获取用户的数据库文件名
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
  // Adopt the session set by better-auth in the current cookie jar. Used by
  // login flows (OTP, 2FA) that finish the sign-in handshake outside the
  // password-only path above.
  adoptSession: () => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  initAuth: () => Promise<void>;
}

type CoreAuthState = Pick<AuthState, 'isAuthenticated' | 'session' | 'user'>;

// Older builds persisted Better Auth's full session object here. That object
// includes `session.token`, so retaining it would bypass the native credential
// store. Authentication is re-established from the keychain-backed bearer
// token during bootstrap; no auth state needs a localStorage cache.
try {
  localStorage.removeItem('auth-storage');
} catch {
  // localStorage can be disabled; the auth store itself remains memory-only.
}

function getLocalAuthState(): CoreAuthState {
  return {
    isAuthenticated: true,
    session: null,
    user: createLocalUser(),
  };
}

async function flushInactiveDatabaseBeforeSwitch(): Promise<void> {
  const { flushLocalApplicationPersistence } = await import('../lib/persistence-lifecycle');
  await flushLocalApplicationPersistence();
}

// 创建 Auth Store
export const useAuthStore = create<AuthState>()((set, get) => ({
  // 初始状态
  ...(isAuthRequired()
    ? {
        isAuthenticated: false,
        session: null,
        user: null,
      }
    : getLocalAuthState()),

  // 登录
  login: async (email: string, password: string) => {
    try {
      if (isAppClosedForPublic) {
        throw new Error(APP_CLOSED_MESSAGE);
      }

      // A normally routed login starts unauthenticated. If an account
      // switch reaches this action directly, quiesce the outgoing user's
      // mounted editors while its old bearer token is still active.
      if (get().isAuthenticated) {
        const { quiesceApplicationForDatabaseSwitch } =
          await import('../lib/persistence-lifecycle');
        await quiesceApplicationForDatabaseSwitch(() => {
          set({ isAuthenticated: false, session: null, user: null });
        });
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
      const session = sessionResult.data || null;
      const resolvedUser = (sessionResult.data?.user || result.data?.user) as User | undefined;
      if (!resolvedUser?.id) {
        throw new Error('Login failed: missing user in session');
      }

      // Persist the newly issued bearer token, then switch SQLite before
      // exposing the authenticated route. No old-user component can mount
      // against the new connection during this interval.
      await flushInactiveDatabaseBeforeSwitch();
      await flushSessionTokenStorage();
      await resetDatabase();
      await initDatabase(resolvedUser.id);
      set({ isAuthenticated: true, session, user: resolvedUser });
      events.emit('db:ready');

      log.info('[Auth] Login successful:', result.data?.user?.email);
      log.info('[Auth] User database initialized:', resolvedUser.id);
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

      if (get().isAuthenticated) {
        const { quiesceApplicationForDatabaseSwitch } =
          await import('../lib/persistence-lifecycle');
        await quiesceApplicationForDatabaseSwitch(() => {
          set({ isAuthenticated: false, session: null, user: null });
        });
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
      const session = sessionResult.data || null;
      const resolvedUser = (sessionResult.data?.user || result.data?.user) as User | undefined;
      if (!resolvedUser?.id) {
        throw new Error('Registration failed: missing user in session');
      }

      await flushInactiveDatabaseBeforeSwitch();
      await flushSessionTokenStorage();
      await resetDatabase();
      const dbFileName = getDbFileName(resolvedUser.id);
      await initDatabase(dbFileName);
      set({ isAuthenticated: true, session, user: resolvedUser });
      events.emit('db:ready');

      log.info('[Auth] Registration successful:', result.data?.user?.email);
      log.info('[Auth] User database initialized:', resolvedUser.id);
    } catch (error) {
      log.error('[Auth] Registration failed:', error);
      throw error;
    }
  },

  // Finish a sign-in started elsewhere (OTP, 2FA verify). Pulls the
  // session that better-auth wrote to the cookie jar and runs the same
  // post-login bookkeeping as `login`.
  adoptSession: async () => {
    if (get().isAuthenticated) {
      const { quiesceApplicationForDatabaseSwitch } = await import('../lib/persistence-lifecycle');
      // OAuth may already have installed the incoming account's token, so
      // never push the outgoing DB remotely under that new identity.
      await quiesceApplicationForDatabaseSwitch(
        () => set({ isAuthenticated: false, session: null, user: null }),
        { flushRemote: false },
      );
    }

    const sessionResult = await authClient.getSession();
    const session = sessionResult.data || null;
    const resolvedUser = sessionResult.data?.user as User | undefined;
    if (!resolvedUser?.id) {
      throw new Error('Session adoption failed: missing user');
    }

    await flushInactiveDatabaseBeforeSwitch();
    await flushSessionTokenStorage();
    await resetDatabase();
    await initDatabase(resolvedUser.id);
    set({ isAuthenticated: true, session, user: resolvedUser });
    events.emit('db:ready');
  },

  // 登出
  logout: async () => {
    if (!isAuthRequired()) {
      // Local-only mode has no account to switch and therefore no reason
      // to tear down/reopen the same database. Still honour the durability
      // barrier used by the native lifecycle path.
      await flushInactiveDatabaseBeforeSwitch();
      set(getLocalAuthState());
      return;
    }

    const {
      flushLocalApplicationPersistence,
      flushRemoteApplicationPersistence,
      quiesceApplicationForDatabaseSwitch,
    } = await import('../lib/persistence-lifecycle');

    // Flush old-account work while its bearer token and mounted editors
    // are still available. Keep the authenticated state intact until the
    // secure token deletion succeeds, otherwise the logout UI would
    // disappear and leave no way to retry a failed keychain operation.
    await flushLocalApplicationPersistence();
    await flushRemoteApplicationPersistence();

    try {
      await authClient.signOut();
    } catch (error) {
      log.error('[Auth] Logout API call failed:', error);
    }
    // Drop the bearer token so the next session starts clean.
    clearSessionToken();
    await flushSessionTokenStorage();

    // Only after secure deletion is confirmed may protected views unmount
    // and the old account's database be replaced. Remote work was already
    // drained above; after token removal only local close snapshots run.
    await quiesceApplicationForDatabaseSwitch(
      () => set({ isAuthenticated: false, session: null, user: null }),
      { flushRemote: false },
    );

    const { stopPreferencesSync } = await import('../services/preferences-sync.service');
    stopPreferencesSync();

    // 重置数据库连接，切换回匿名/demo模式的数据库
    await resetDatabase();
    await initDatabase(getDbFileName());
    events.emit('db:ready');
    log.info('[Auth] Anonymous database');

    log.info('[Auth] Logout successful');
  },

  // 检查 session 状态
  checkSession: async () => {
    if (!isAuthRequired()) {
      set(getLocalAuthState());
      return;
    }

    try {
      const result = await authClient.getSession();
      const session = result.data || null;
      const sessionUser = session?.user as User | undefined;

      if (session && sessionUser?.id) {
        const currentUserId = get().user?.id;
        if (currentUserId !== sessionUser.id) {
          if (currentUserId) {
            const { quiesceApplicationForDatabaseSwitch } =
              await import('../lib/persistence-lifecycle');
            // The in-memory bearer token now represents sessionUser, so
            // only finish old-DB local durability; never remote-push the
            // outgoing account under the incoming identity.
            await quiesceApplicationForDatabaseSwitch(
              () => set({ isAuthenticated: false, session: null, user: null }),
              { flushRemote: false },
            );
          } else {
            await flushInactiveDatabaseBeforeSwitch();
          }
          await resetDatabase();
          await initDatabase(sessionUser.id);
          events.emit('db:ready');
        }
        set({
          isAuthenticated: true,
          session,
          user: sessionUser,
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
}));

// 导出 Auth Store 类型
export type AuthStore = ReturnType<typeof useAuthStore.getState>;
