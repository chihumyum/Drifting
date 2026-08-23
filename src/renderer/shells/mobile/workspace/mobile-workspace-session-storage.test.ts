import { describe, expect, it } from 'vitest';
import {
  readMobileWorkspaceSession,
  writeMobileWorkspaceSession,
} from './mobile-workspace-session-storage';
import {
  EMPTY_MOBILE_WORKSPACE_SESSION,
  mobileWorkspaceSessionReducer,
} from './mobile-workspace-session';

const chapter = (id: string) => ({ entityType: 'node' as const, id });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('mobile workspace restart restoration', () => {
  it('round-trips order, active paper, targets, and independent scroll positions', () => {
    let state = mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
      type: 'open',
      target: chapter('a'),
    });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('c') });
    state = mobileWorkspaceSessionReducer(state, { type: 'activate', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, { type: 'reorder', from: 2, to: 0 });
    state = mobileWorkspaceSessionReducer(state, {
      type: 'remember-scroll',
      key: 'node:a',
      scrollTop: 432,
    });

    const storage = memoryStorage();
    expect(writeMobileWorkspaceSession(storage, 'project', state)).toBe(true);
    expect(readMobileWorkspaceSession(storage, 'project')).toEqual(state);
  });

  it('fails closed for unavailable, malformed, or quota-failing storage', () => {
    expect(readMobileWorkspaceSession(null, 'project')).toBe(EMPTY_MOBILE_WORKSPACE_SESSION);
    expect(
      readMobileWorkspaceSession({ getItem: () => '{broken' }, 'project'),
    ).toBe(EMPTY_MOBILE_WORKSPACE_SESSION);
    expect(
      writeMobileWorkspaceSession(
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
        'project',
        EMPTY_MOBILE_WORKSPACE_SESSION,
      ),
    ).toBe(false);
  });
});
