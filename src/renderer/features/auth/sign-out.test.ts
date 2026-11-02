import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({
  unuploaded: 0,
  calls: [] as string[],
  authority: { mode: 'hosted', status: 'cloud-active' },
  mounted: true,
  hostedStatus: 'connected',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}(${options.count})`,
  }),
}));
vi.mock('../../sync/hosted/disconnect', () => ({
  countHostedUnuploadedChanges: async () => sync.unuploaded,
  disconnectHosted: async (_signal: AbortSignal, options: { uploadFirst: boolean }) => {
    sync.calls.push(`disconnect(uploadFirst=${options.uploadFirst})`);
  },
  waitForHostedUpload: async () => undefined,
}));
vi.mock('../../store/auth', () => {
  const state = {
    get hostedStatus() {
      return sync.hostedStatus;
    },
    logout: async () => {
      sync.calls.push('logout');
    },
  };
  const useAuthStore = (select: (value: typeof state) => unknown) => select(state);
  useAuthStore.getState = () => state;
  return { useAuthStore };
});
vi.mock('../../sync/product-authority-react', () => ({ useProductSyncAuthority: () => sync.authority }));
vi.mock('../../sync/product-runtime-react', () => ({
  useProductSyncRuntime: () => ({ mounted: sync.mounted }),
}));
vi.mock('../../components/ui/Modal', () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ModalRoot: pass,
    ModalCard: pass,
    ModalBody: pass,
    ModalActions: pass,
    ModalHeader: ({ title }: { title: ReactNode }) => createElement('header', null, title),
  };
});

import { SignOutDialog } from './SignOutDialog';
import { finishSignOut, requestSignOut, useSignOutDialogStore } from './sign-out';

beforeEach(() => {
  sync.unuploaded = 0;
  sync.calls = [];
  sync.authority = { mode: 'hosted', status: 'cloud-active' };
  sync.mounted = true;
  sync.hostedStatus = 'connected';
});
afterEach(() => useSignOutDialogStore.getState().close());

describe('signing out', () => {
  it('signs out at once when this Mac holds nothing the cloud lacks', async () => {
    const afterSignOut = vi.fn();
    await requestSignOut(afterSignOut);
    expect(sync.calls).toEqual(['logout']);
    expect(afterSignOut).toHaveBeenCalledOnce();
    expect(useSignOutDialogStore.getState().request).toBeNull();
  });

  it('asks first while changes have not uploaded, without signing out', async () => {
    sync.unuploaded = 12;
    const afterSignOut = vi.fn();
    await requestSignOut(afterSignOut);
    expect(sync.calls).toEqual([]);
    expect(afterSignOut).not.toHaveBeenCalled();
    expect(useSignOutDialogStore.getState().request).toMatchObject({ unuploaded: 12, afterSignOut });
  });

  it('disconnects without waiting again, then signs out, only when the author asked', async () => {
    await finishSignOut(new AbortController().signal, { disconnect: true });
    expect(sync.calls).toEqual(['disconnect(uploadFirst=false)', 'logout']);
    sync.calls = [];
    await finishSignOut(new AbortController().signal, { disconnect: false });
    expect(sync.calls).toEqual(['logout']);
  });

  it('does not sign out once cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(finishSignOut(controller.signal, { disconnect: false })).rejects.toThrow('cancelled');
    expect(sync.calls).toEqual([]);
  });
});

describe('the sign-out dialog', () => {
  const render = () => renderToStaticMarkup(createElement(SignOutDialog, { unuploaded: 7, onClose: () => {} }));

  it('offers to upload first when sync can upload, and to disconnect the library', () => {
    const html = render();
    expect(html).toContain('auth.signOut.pending(7)');
    expect(html).toContain('auth.signOut.uploadFirst');
    expect(html).toContain('auth.signOut.now');
    expect(html).toContain('auth.signOut.disconnect');
  });

  it('only signs out now while sync is paused, offline or not running', () => {
    for (const blocked of [
      () => (sync.authority = { mode: 'hosted', status: 'cloud-paused' }),
      () => (sync.hostedStatus = 'offline'),
      () => (sync.mounted = false),
    ]) {
      blocked();
      const html = render();
      expect(html).toContain('auth.signOut.now');
      expect(html).not.toContain('auth.signOut.uploadFirst');
      sync.authority = { mode: 'hosted', status: 'cloud-active' };
      sync.hostedStatus = 'connected';
      sync.mounted = true;
    }
  });

  it('has no disconnect switch for a library that is not connected', () => {
    sync.authority = { mode: 'local', status: 'local' };
    expect(render()).not.toContain('auth.signOut.disconnect');
  });
});
