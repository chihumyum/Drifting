import { create } from 'zustand';
import { bindHostedSession, clearHostedSessionBinding } from '../lib/hosted-session-binding';
import { authClient, type Session } from '../lib/auth-client';
import {
  clearSessionToken,
  invalidateSessionToken,
  flushSessionTokenStorage,
  getSessionToken,
  getSessionTokenRevision,
  hydrateSessionToken,
  setSessionToken,
} from '../lib/session-token';
import { APP_CONFIG, canUseHostedService } from '../lib/config';
import { initDatabase } from '../lib/db';
import { events } from '../lib/events';
import { readHostedProfile, writeHostedProfile, type HostedProfile } from '../lib/hosted-profile';
export interface User {
  id: string;
  email: string;
  name: string;
  image?: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export const LOCAL_USER_ID = 'drifting-library.db';
const localUser: User = {
  id: LOCAL_USER_ID,
  email: 'local@drifting.local',
  name: 'Local User',
  emailVerified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
export type HostedSessionStatus =
  | 'signed-out'
  | 'checking'
  | 'connected'
  | 'offline'
  | 'needs-reauth';
interface AuthState {
  /** Local workspace identity never changes when the cloud account changes. */
  isAuthenticated: boolean;
  user: User;
  session: Session | null;
  hostedUser: HostedProfile | null;
  hostedStatus: HostedSessionStatus;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, name: string): Promise<void>;
  adoptSession(): Promise<void>;
  logout(): Promise<void>;
  expireSession(): Promise<void>;
  checkSession(): Promise<void>;
  initAuth(): Promise<void>;
  refreshHostedSession(): Promise<void>;
}
let bootstrap: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
function requireHosted() {
  if (!canUseHostedService())
    throw new Error('HOSTED_SERVICE_DISABLED: account authentication is unavailable.');
}
async function assertAccountOwnership(accountId: string): Promise<void> {
  const { getDb } = await import('../lib/db');
  const { createSyncAppAuthorityRepository } = await import('../sync/app-authority-repository');
  const repository = createSyncAppAuthorityRepository(getDb());
  const state = await repository.read();
  if (
    state.mode === 'hosted' ||
    (state.transitionState !== 'stable' && state.targetMode === 'hosted')
  ) {
    const bindings = await repository.listActiveRuntimeBindings();
    if (bindings.some((binding) => binding.binding.accountRef !== accountId))
      throw new Error(
        'HOSTED_ACCOUNT_MISMATCH: Disconnect the current cloud account before connecting another account.',
      );
    // Empty libraries still own an account even when no runtime bindings exist.
    const { SyncProviderAccountTable, SyncConnectAttemptTable } = await import('../schema/drizzle');
    if (state.transitionState !== 'stable') {
      const { eq } = await import('drizzle-orm');
      const [attempt] = await getDb()
        .select()
        .from(SyncConnectAttemptTable)
        .where(eq(SyncConnectAttemptTable.attemptId, state.attemptId));
      if (attempt?.targetAccountSubjectId && attempt.targetAccountSubjectId !== accountId)
        throw new Error('HOSTED_ACCOUNT_MISMATCH');
    }
    const accounts = await getDb().select().from(SyncProviderAccountTable);
    if (
      accounts.some(
        (account) => account.providerKind === 'hosted' && account.accountSubjectId !== accountId,
      )
    )
      throw new Error('HOSTED_ACCOUNT_MISMATCH');
  }
}
export const useAuthStore = create<AuthState>()((set, get) => ({
  isAuthenticated: true,
  user: localUser,
  session: null,
  hostedUser: APP_CONFIG.LOCAL_ONLY_MODE ? null : readHostedProfile(),
  hostedStatus: 'signed-out',
  async login(email, password) {
    requireHosted();
    const previous = getSessionToken();
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message ?? 'Login failed');
      await get().adoptSession();
    } catch (error) {
      if (previous) setSessionToken(previous);
      else clearSessionToken();
      await flushSessionTokenStorage();
      throw error;
    }
  },
  async register(email, password, name) {
    requireHosted();
    const result = await authClient.signUp.email({ email, password, name });
    if (result.error) throw new Error(result.error.message ?? 'Registration failed');
  },
  async adoptSession() {
    requireHosted();
    const token = getSessionToken();
    const revision = getSessionTokenRevision();
    const ownsSession = () => token === getSessionToken() && revision === getSessionTokenRevision();
    const result = await authClient.getSession();
    if (!ownsSession()) throw new Error('SESSION_CHANGED');
    if (!result.data?.user || result.error)
      throw new Error(result.error?.message ?? 'Session unavailable');
    try {
      await assertAccountOwnership(result.data.user.id);
    } catch (error) {
      if (ownsSession()) await get().expireSession();
      throw error;
    }
    await flushSessionTokenStorage();
    if (!ownsSession()) throw new Error('SESSION_CHANGED');
    await (
      await import('../sync/hosted/session-recovery')
    ).resumeHostedAuthentication(result.data.user.id);
    if (!ownsSession()) throw new Error('SESSION_CHANGED');
    bindHostedSession(result.data.user.id, token);
    const hostedUser: HostedProfile = result.data.user;
    writeHostedProfile(hostedUser);
    set({ session: result.data, hostedUser, hostedStatus: 'connected' });
    events.emit('sync:authority-changed');
  },
  async logout() {
    const { flushLocalApplicationPersistence } = await import('../lib/persistence-lifecycle');
    await flushLocalApplicationPersistence();
    if (APP_CONFIG.LOCAL_ONLY_MODE) return;
    if (getSessionToken()) {
      requireHosted();
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? 'Sign out failed');
    }
    clearHostedSessionBinding();
    clearSessionToken();
    await flushSessionTokenStorage();
    writeHostedProfile(null);
    set({ session: null, hostedUser: null, hostedStatus: 'signed-out' });
    events.emit('sync:authority-changed');
  },
  async expireSession() {
    if (APP_CONFIG.LOCAL_ONLY_MODE) return;
    clearHostedSessionBinding();
    invalidateSessionToken();
    set({ session: null, hostedStatus: 'needs-reauth' });
    events.emit('sync:authority-changed');
    await flushSessionTokenStorage();
  },
  refreshHostedSession() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (APP_CONFIG.LOCAL_ONLY_MODE) return;
      if (!getSessionToken()) {
        set({ hostedStatus: get().hostedUser ? 'needs-reauth' : 'signed-out' });
        return;
      }
      if (!canUseHostedService()) {
        set({ hostedStatus: 'offline' });
        return;
      }
      const token = getSessionToken();
      const revision = getSessionTokenRevision();
      const ownsSession = () => {
        const owns = token === getSessionToken() && revision === getSessionTokenRevision();
        if (!owns && get().hostedStatus === 'checking') set({ hostedStatus: 'offline' });
        return owns;
      };
      set({ hostedStatus: 'checking' });
      try {
        const result = await authClient.getSession();
        if (!ownsSession()) return;
        if (result.error && result.error.status !== 401 && result.error.status !== 403) {
          set({ hostedStatus: 'offline' });
          return;
        }
        if (!result.data?.user) {
          await get().expireSession();
          return;
        }
        await assertAccountOwnership(result.data.user.id);
        if (!ownsSession()) return;
        await (
          await import('../sync/hosted/session-recovery')
        ).resumeHostedAuthentication(result.data.user.id);
        if (!ownsSession()) return;
        bindHostedSession(result.data.user.id, token);
        writeHostedProfile(result.data.user);
        set({ session: result.data, hostedUser: result.data.user, hostedStatus: 'connected' });
        events.emit('sync:authority-changed');
      } catch {
        if (ownsSession()) set({ hostedStatus: 'offline' });
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },
  checkSession() {
    if (bootstrap) return bootstrap;
    bootstrap = (async () => {
      await initDatabase(LOCAL_USER_ID);
      events.emit('db:ready');
      // Neither credential-store interaction nor a network probe may block local writing.
      if (!APP_CONFIG.LOCAL_ONLY_MODE)
        void hydrateSessionToken().then(() => get().refreshHostedSession());
    })().finally(() => {
      bootstrap = null;
    });
    return bootstrap;
  },
  initAuth() {
    return get().checkSession();
  },
}));
export type AuthStore = ReturnType<typeof useAuthStore.getState>;
