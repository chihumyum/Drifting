import { describe, expect, it } from 'vitest';
import type { MobileWorkspaceSessionState } from './mobile-workspace-session';
import {
  captureMobileSuperViewReturnPoint,
  mobileSuperViewReturnPointMatches,
} from './mobile-super-view-state';

const session: MobileWorkspaceSessionState = {
  activeKey: 'node:b',
  papers: [
    { key: 'node:a', target: { entityType: 'node', id: 'a' }, scrollTop: 12 },
    { key: 'node:b', target: { entityType: 'node', id: 'b' }, scrollTop: 30 },
  ],
};
const location = { pathname: '/project/p/node/b', search: '?focus=1', hash: '#block' };

describe('Mobile Super View return point', () => {
  it('captures live active scroll and matches the exact paper and URL identity', () => {
    const point = captureMobileSuperViewReturnPoint(session, location, 44);
    const flushed = {
      ...session,
      papers: session.papers.map((paper) =>
        paper.key === session.activeKey ? { ...paper, scrollTop: 44 } : paper,
      ),
    };
    expect(mobileSuperViewReturnPointMatches(point, flushed, location)).toBe(true);
    expect(mobileSuperViewReturnPointMatches(point, session, location, 44)).toBe(true);
  });

  it.each([
    ['order', { ...session, papers: [...session.papers].reverse() }, location],
    ['active paper', { ...session, activeKey: 'node:a' }, location],
    [
      'scroll',
      { ...session, papers: [{ ...session.papers[0]!, scrollTop: 99 }, session.papers[1]!] },
      location,
    ],
    ['pathname', session, { ...location, pathname: '/project/p/node/a' }],
    ['search', session, { ...location, search: '' }],
    ['hash', session, { ...location, hash: '' }],
  ])('rejects a changed %s', (_label, nextSession, nextLocation) => {
    const point = captureMobileSuperViewReturnPoint(session, location);
    expect(mobileSuperViewReturnPointMatches(point, nextSession, nextLocation)).toBe(false);
  });
});
