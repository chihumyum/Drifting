import { describe, expect, it } from 'vitest';

import {
  isContentActivationFromCreateRoute,
  isCreateActivationFromProjectHome,
} from './useSyncSplitFocusedUrl';

describe('Project Home route synchronization', () => {
  it('lets a newly activated create tab advance from Home to the create route', () => {
    expect(
      isCreateActivationFromProjectHome({
        atProjectHome: true,
        previousActiveTabKey: null,
        activeTabKey: 'create:universal-new',
      }),
    ).toBe(true);

    expect(
      isCreateActivationFromProjectHome({
        atProjectHome: true,
        previousActiveTabKey: 'node:chapter-before-home-settled',
        activeTabKey: 'create:universal-new',
      }),
    ).toBe(true);
  });

  it('still treats returning from an already-active create tab to Home as authoritative', () => {
    expect(
      isCreateActivationFromProjectHome({
        atProjectHome: true,
        previousActiveTabKey: 'create:universal-new',
        activeTabKey: 'create:universal-new',
      }),
    ).toBe(false);
  });

  it('does not classify non-Home route changes as a Home-to-create transition', () => {
    expect(
      isCreateActivationFromProjectHome({
        atProjectHome: false,
        previousActiveTabKey: null,
        activeTabKey: 'create:universal-new',
      }),
    ).toBe(false);
  });

  it('routes a create-to-content transition to the selected content instead of Home', () => {
    expect(
      isContentActivationFromCreateRoute({
        atCreateRoute: true,
        previousActiveTabKey: 'create:universal-new',
        activeTabKey: 'node:chapter-a',
      }),
    ).toBe(true);
  });

  it('does not reinterpret an ordinary visit to the create route as a draft close', () => {
    expect(
      isContentActivationFromCreateRoute({
        atCreateRoute: true,
        previousActiveTabKey: 'node:chapter-a',
        activeTabKey: 'node:chapter-a',
      }),
    ).toBe(false);
    expect(
      isContentActivationFromCreateRoute({
        atCreateRoute: false,
        previousActiveTabKey: 'create:universal-new',
        activeTabKey: 'node:chapter-a',
      }),
    ).toBe(false);
  });
});
