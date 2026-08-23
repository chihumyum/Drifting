import { describe, expect, it } from 'vitest';
import {
  EMPTY_MOBILE_WORKSPACE_SESSION,
  mobileWorkspaceSessionReducer,
  normalizeMobileWorkspaceSession,
} from './mobile-workspace-session';

const chapter = (id: string) => ({ entityType: 'node' as const, id });

describe('mobile workspace paper session', () => {
  it('inserts a new paper to the right and activates an existing paper without duplicating it', () => {
    const first = mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
      type: 'open',
      target: chapter('a'),
    });
    const second = mobileWorkspaceSessionReducer(first, { type: 'open', target: chapter('b') });
    const reopened = mobileWorkspaceSessionReducer(second, { type: 'open', target: chapter('a') });
    expect(second.papers.map((paper) => paper.target.id)).toEqual(['a', 'b']);
    expect(reopened.papers).toHaveLength(2);
    expect(reopened.activeKey).toBe('node:a');
  });

  it('chooses the nearest remaining paper when the active paper closes', () => {
    let state = mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
      type: 'open',
      target: chapter('a'),
    });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('c') });
    state = mobileWorkspaceSessionReducer(state, { type: 'activate', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, { type: 'close', key: 'node:b' });
    expect(state.papers.map((paper) => paper.target.id)).toEqual(['a', 'c']);
    expect(state.activeKey).toBe('node:c');
  });

  it('closes a neighboring paper without changing the active paper', () => {
    let state = mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
      type: 'open',
      target: chapter('a'),
    });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('c') });
    state = mobileWorkspaceSessionReducer(state, { type: 'activate', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, { type: 'close', key: 'node:a' });
    expect(state.papers.map((paper) => paper.target.id)).toEqual(['b', 'c']);
    expect(state.activeKey).toBe('node:b');
  });

  it('reorders papers without changing their identity, scroll, or active key', () => {
    let state = mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
      type: 'open',
      target: chapter('a'),
    });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, {
      type: 'remember-scroll',
      key: 'node:a',
      scrollTop: 120,
    });
    state = mobileWorkspaceSessionReducer(state, { type: 'reorder', from: 0, to: 1 });
    expect(state.papers.map((paper) => [paper.key, paper.scrollTop])).toEqual([
      ['node:b', 0],
      ['node:a', 120],
    ]);
    expect(state.activeKey).toBe('node:b');
  });

  it('clears every open paper without deleting its underlying entity', () => {
    const state = mobileWorkspaceSessionReducer(
      mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
        type: 'open',
        target: chapter('a'),
      }),
      { type: 'clear' },
    );
    expect(state).toEqual(EMPTY_MOBILE_WORKSPACE_SESSION);
  });

  it('normalizes duplicate and invalid persisted papers', () => {
    const persisted = { key: 'old', target: chapter('a'), scrollTop: -12 };
    const state = normalizeMobileWorkspaceSession({
      papers: [
        persisted,
        { key: 'duplicate', target: chapter('a') },
        { key: 'b', target: chapter('b') },
        { key: 'unknown', target: { entityType: 'unknown', id: 'c' } },
      ],
      activeKey: 'missing',
    } as never);
    expect(state.papers.map((paper) => paper.key)).toEqual(['node:a', 'node:b']);
    expect(state.papers.map((paper) => paper.scrollTop)).toEqual([0, 0]);
    expect(state.activeKey).toBe('node:a');
    expect(persisted.key).toBe('old');
  });

  it('remembers an independent non-negative scroll position for every paper', () => {
    let state = mobileWorkspaceSessionReducer(EMPTY_MOBILE_WORKSPACE_SESSION, {
      type: 'open',
      target: chapter('a'),
    });
    state = mobileWorkspaceSessionReducer(state, { type: 'open', target: chapter('b') });
    state = mobileWorkspaceSessionReducer(state, {
      type: 'remember-scroll',
      key: 'node:a',
      scrollTop: 840,
    });
    state = mobileWorkspaceSessionReducer(state, {
      type: 'remember-scroll',
      key: 'node:b',
      scrollTop: -20,
    });
    expect(state.papers.map((paper) => paper.scrollTop)).toEqual([840, 0]);
  });
});
