import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { designSystemDocs } from '../../components/design-system-docs.test-support';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function rule(css: string, selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find((match) => match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector);
  expect(found, `missing rule: ${selector}`).toBeTruthy();
  return found![2];
}

describe('the paper-corner sync mark (docs/hosted-sync/sync-status.md)', () => {
  it('sits on the stage, so split view keeps one mark on the left paper', () => {
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const stage = workspace.slice(workspace.indexOf('<div className="workspace-stage desktop-workspace-stage">'));
    expect(stage.slice(0, stage.indexOf('</div>'))).toContain('<PaperSyncMark />');
    const css = source('src/styles/paper-sync-mark.css');
    const corner = rule(css, '.paper-sync-mark');
    expect(corner).toContain('left: 16px;');
    expect(corner).toContain('bottom: calc(16px + var(--glass-tray-padding));');
    expect(corner).toContain('width: var(--glass-round-size);');
  });

  it('is sand, one mark at a time: a cloud, the cloud as loose grains, or the danger seal', () => {
    const mark = source('src/renderer/features/sync-status/PaperSyncMark.tsx');
    const names = [...mark.matchAll(/<BrushIcon\s+name="([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(['cloud', 'cloud', 'status-warning']);
    expect(mark).not.toMatch(/lock|glass/);
    const css = source('src/styles/paper-sync-mark.css');
    expect(css).not.toContain('.glass');
    expect(rule(css, ".paper-sync-mark[data-state='problem'] .paper-sync-mark__mark")).toContain('hsl(var(--destructive))');
    expect(rule(css, '.paper-sync-mark__glyph--loose.brush-icon')).toContain('radial-gradient');
    // Whole fades, never drawn along a path.
    expect(rule(css, '.paper-sync-mark__glyph.brush-icon')).toContain('opacity var(--motion-sand-fade) ease-out');
    expect(css).not.toContain('--sweep');
  });

  it('breathes while syncing and blinks while retrying, on the motion tokens, and stills for reduced motion', () => {
    const css = source('src/styles/paper-sync-mark.css');
    expect(rule(css, ".paper-sync-mark[data-state='syncing'] .paper-sync-mark__glyph.is-on")).toContain('var(--motion-sync-breathe)');
    expect(rule(css, ".paper-sync-mark[data-state='retrying'] .paper-sync-mark__glyph.is-on")).toContain('var(--motion-sync-blink)');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
    // Nothing animates for an empty corner.
    expect(css).not.toMatch(/data-state='none'\][^{]*\{[^}]*animation/);
  });

  it('steps a transfer aside while the author types, and nothing that needs them', () => {
    const mark = source('src/renderer/features/sync-status/PaperSyncMark.tsx');
    expect(mark).toContain("const fadedForTyping = typing && state.kind === 'syncing';");
    expect(mark).toContain('useAuthorTyping(SYNC_MARK_TYPING_SETTLE_MS)');
    expect(rule(source('src/styles/paper-sync-mark.css'), '.paper-sync-mark[data-typing]')).toContain('opacity: 0;');
  });

  it('explains itself in the shared hover card, with its ways out as rows', () => {
    const mark = source('src/renderer/features/sync-status/PaperSyncMark.tsx');
    expect(mark).toContain('<HoverCardShell');
    expect(mark).toContain('placement="top-center"');
    expect(mark).toContain('actions={groups}');
    expect(mark).toContain('useHoverPreview<null>()');
    const actions = source('src/renderer/features/sync-status/sync-status-actions.ts');
    expect(actions).toContain("events.emit('settings:open', { railId: 'account' })");
    expect(actions).toContain('productSyncRuntimeControl.retryActivation()');
    expect(source('src/renderer/sync/production-runtime.ts')).toContain("events.on('sync:activation-retry', reload)");
  });

  it('leaves transfers off the desktop bell and keeps problems on it until they resolve', () => {
    const shell = source('src/renderer/shells/desktop/DesktopAppShell.tsx');
    expect(shell).toContain('useNotificationFeed({ transfers: false });');
    expect(shell).toContain('useSyncProblemNotifications();');
    expect(source('src/renderer/shells/mobile/desk/MobileDesk.tsx')).toContain('useNotificationFeed();');
    const pill = source('src/renderer/components/notifications/NotificationPill.tsx');
    expect(pill).toContain('const syncProblem = items.some((n) => n.syncProblem);');
    expect(pill).toMatch(/if \(syncProblem\) \{\s*iconColor = 'hsl\(var\(--destructive\)\)';\s*iconEl = <BrushIcon name="status-warning"/);
    expect(pill).toContain('{!n.syncProblem && (');
    expect(pill).toContain('const ordered = [...items.filter((n) => n.syncProblem), ...items.filter((n) => !n.syncProblem)];');
  });

  it('floats a second bell under the left toggle while a problem lasts with the sidebar closed', () => {
    const toggles = source('src/renderer/components/workspaceChrome/WindowControlButtons.tsx');
    expect(toggles).toContain('const shown = leftClosed && problem;');
    expect(toggles).toContain('<NotificationPill opens="down-start" floating />');
    const pill = source('src/renderer/components/notifications/NotificationPill.tsx');
    expect(pill).toContain("const drawsCenter = centerOpen && (centerOwner === owner || (centerOwner === null && !floating));");
    expect(pill).toContain("workspace-sidebar-toggle--floating glass--rest");
    const css = source('src/styles/desktop-shell.css');
    expect(rule(css, '.workspace-sync-bell[data-shown]')).toContain('opacity: 1;');
  });

  it('is written down in the design system', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('## 稿纸角同步记号');
    expect(docs).toContain('`PaperSyncMark`');
    expect(docs).toContain('SYNC_MARK_TYPING_SETTLE_MS');
    expect(docs).toContain('paper-sync-mark.acceptance.test.ts');
  });
});
