import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Mobile V2 paper and keyboard-accessory interaction correction', () => {
  it('keeps Project Home outside the paper rail and preserves paper swipe exclusions', () => {
    const session = source('shells/mobile/workspace/mobile-workspace-session.ts');
    const hook = source('shells/mobile/workspace/useMobileWorkspaceSession.ts');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const swipe = source('shells/mobile/workspace/mobile-paper-swipe.ts');

    expect(session).not.toContain("'dashboard',");
    expect(hook).not.toContain("entityType: 'dashboard'");
    expect(deck).toContain('mobilePaperSwipeTargetIsExcluded(');
    expect(deck).toContain('false,');
    expect(swipe).toContain('allowInteractiveStart ? ALWAYS_EXCLUDED_SELECTOR');
    expect(swipe).toContain("'input'");
    expect(swipe).toContain("'textarea'");
  });

  it('has only read or keyboard-backed edit states and resets on paper activation', () => {
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');

    expect(controller).toContain('edit mode requires a visible software keyboard');
    expect(controller).toContain("paperMode: { kind: 'edit', accessory: 'navigation' }");
    expect(controller).toContain("keyboard: 'open'");
    expect(controller).not.toContain('editing and a context panel are mutually exclusive');
    expect(accessory).toContain('const editing = editorFocused && softwareKeyboardVisible');
    expect(accessory).toContain('observedKeyboardWhileFocusedRef');
    expect(accessory).toContain('editor.commands.blur()');
    expect(deck).toContain("onWorkspaceUiAction({ type: 'sync-editor', editing: false })");
    expect(deck).toContain('getActiveEditor()?.commands.blur()');
  });

  it('keeps formatting in the accessory row and never opens a formatting sheet', () => {
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const sheet = source('shells/mobile/workspace/MobileBarSheet.tsx');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(accessory).toContain('m-editor-accessory__actions');
    expect(accessory).toContain("mode === 'formatting'");
    expect(accessory).toContain("mode === 'navigation'");
    expect(accessory).toContain("onModeChange?.('formatting')");
    expect(accessory).toContain('onPointerDown={keepEditorFocused}');
    expect(accessory).toContain('onPointerUp={toggle}');
    expect(accessory).toContain('onClick={handleToggleClick}');
    expect(accessory).not.toContain('editor.view.focus();');
    expect(accessory).toContain('role="button"');
    expect(bar).toContain('backPreservesFocusUntilResolution');
    expect(bar).toContain("projection.mode === 'edit' || projection.mode === 'search'");
    expect(bar).toContain("requestMobileWorkspaceBack('visible', {");
    expect(bar).not.toContain('data-debug-id="mobile-dismiss-keyboard"');
    expect(accessory).not.toContain('keepEditorFocused(event, toggle)');
    expect(sheet).not.toContain('MobileFormattingSheetContent');
    expect(deck).not.toContain("sheet: 'formatting'");
    expect(css).not.toContain('.m-format-sheet');
    expect(css).toContain('touch-action: pan-x');
  });

  it('gives the resting paper fixed corner chrome instead of a floating bar', () => {
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    // The folio row owns back/identity/overview/tools; the bar only surfaces
    // for search and the keyboard accessory. No variable-height panels remain.
    expect(deck).toContain('data-debug-id="mobile-paper-folio"');
    expect(deck).toContain('<MobileToolsFace');
    expect(deck).toContain('<MobileTabBar');
    expect(deck).toContain('<MobilePaperStatsSheet');
    expect(bar).not.toContain('MobilePanelPullHandle');
    expect(bar).not.toContain('mobile-open-overview');
    expect(deck).not.toContain('MobileWorkspacePanels');
    expect(css).toContain(".m-unified-bar[data-mode='read']");
    expect(css).not.toContain('.m-panel-pull-handle');
  });
});
