import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../locales/en.json';
import zh from '../../locales/zh-CN.json';
import { useSettingsStore } from '../../store/settings-store';
import { WORKSPACE_TOUR, WORKSPACE_TOUR_ID } from './workspace-tour';

const coreRoot = path.resolve(__dirname, '../../../..');
const source = (relativePath: string) => fs.readFileSync(path.join(coreRoot, relativePath), 'utf8');

function lookup(dictionary: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    dictionary,
  );
}

describe('workspace tour', () => {
  it('points every step at a control the workspace really renders', () => {
    // Each selector is matched by a class or attribute these components write.
    const owners: Record<string, [string, string]> = {
      '.leftbar-tab-tray [data-panel-tab-label]': ['src/renderer/components/leftBars/LeftSidebarHeader.tsx', 'className="leftbar-tab-tray"'],
      '.workspace-super-view-entry': ['src/renderer/components/leftBars/LeftSidebarSubHeader.tsx', 'className="workspace-super-view-entry"'],
      '.dash-sec--create': ['src/renderer/views/ProjectDashboard.tsx', 'dash-sec dash-sec--create'],
      '.workspace-timeline-toggle': ['src/renderer/components/workspaceChrome/WorkspaceTabDock.tsx', 'workspace-timeline-toggle'],
      '[data-guide-anchor="agent-tab"] [data-panel-tab-label]': ['src/renderer/components/rightBars/RightSidebarHeader.tsx', "'agent-tab'"],
      '.sidebar-account-cell [data-guide-anchor="project-home"]': ['src/renderer/components/workspaceChrome/WorkspaceAccountControls.tsx', 'data-guide-anchor="project-home"'],
      '.sidebar-account-cell .notification-pill': ['src/renderer/components/notifications/NotificationPill.tsx', 'className="notification-pill"'],
      // A closed sidebar's toggle floats with these classes until it opens.
      '.workspace-sidebar-toggle--left.workspace-sidebar-toggle--floating': ['src/renderer/components/workspaceChrome/WindowControlButtons.tsx', "workspace-sidebar-toggle--${side}${isOpen ? '' : ' workspace-sidebar-toggle--floating"],
      '.workspace-sidebar-toggle--right.workspace-sidebar-toggle--floating': ['src/renderer/components/workspaceChrome/WindowControlButtons.tsx', "workspace-sidebar-toggle--${side}${isOpen ? '' : ' workspace-sidebar-toggle--floating"],
    };
    for (const step of WORKSPACE_TOUR) {
      for (const selector of [...step.targets, ...(step.fallback?.targets ?? [])]) {
        const owner = owners[selector];
        expect(owner, `${step.id}: ${selector}`).toBeDefined();
        expect(source(owner![0])).toContain(owner![1]);
      }
    }
  });

  it('has every step written in both languages', () => {
    const keys = ['guide.skip', 'guide.back', 'guide.next', 'guide.done',
      ...WORKSPACE_TOUR.flatMap((step) => [step.titleKey, step.bodyKey, ...(step.fallback ? [step.fallback.bodyKey] : [])])];
    for (const key of keys) {
      expect(typeof lookup(zh, key), key).toBe('string');
      expect(typeof lookup(en, key), key).toBe('string');
    }
  });

  it('starts once per device and can be shown again', () => {
    useSettingsStore.getState().resetGuides();
    useSettingsStore.getState().markGuideSeen(WORKSPACE_TOUR_ID);
    useSettingsStore.getState().markGuideSeen(WORKSPACE_TOUR_ID);
    expect(useSettingsStore.getState().guidesSeen).toEqual([WORKSPACE_TOUR_ID]);
    useSettingsStore.getState().resetGuides();
    expect(useSettingsStore.getState().guidesSeen).toEqual([]);
    expect(source('src/renderer/shells/desktop/DesktopWorkspace.tsx')).toContain('<WorkspaceGuide />');
    expect(source('src/renderer/features/settings/panels/BasicPreferencePanels.tsx')).toContain('resetGuides');
  });

  it('stays on this device', () => {
    expect(source('src/renderer/features/preference-sync/preference-fields.ts')).not.toContain('guidesSeen');
  });

  it('writes shortcuts plainly in index type, never as keycaps', () => {
    const css = source('src/styles/guide.css');
    for (const selector of ['.guide-card__count,\n.guide-card__shortcuts {', '.empty-state__hint-keys {']) {
      const start = css.indexOf(selector);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf('}', start));
      expect(block).toContain('font-family: var(--font-mono)');
      expect(block).not.toMatch(/border|background|border-radius/);
    }
  });
});
