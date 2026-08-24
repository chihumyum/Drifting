import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Mobile V2 paper and keyboard-accessory interaction correction', () => {
  it('keeps checkout-specific Simulator evidence attached to the correction', () => {
    const evidence = fs.readFileSync(
      path.join(
        repoRoot,
        'docs/qa/mobile-v2-paper-accessory-interaction-repair-simulator-2026-08-24.md',
      ),
      'utf8',
    );

    expect(evidence).toContain('inputPath=synthetic-dom');
    expect(evidence).toContain('physical-device continuous touch');
    expect(evidence).toContain('pointerdown reflow ghost input');
    expect(evidence).toContain('20 files, 105 tests passed');
  });

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

  it('uses a floating pill, split identity/count actions, and pull-only panel entrances', () => {
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(bar).toContain('data-debug-id="mobile-open-paper-stats"');
    expect(bar).toContain('data-debug-id="mobile-open-overview"');
    expect(bar).toContain('<MobilePanelPullHandle');
    expect(deck).toContain('panel="top"');
    expect(deck).toContain('<MobilePaperStatsSheet');
    expect(bar).not.toContain('PanelTop');
    expect(bar).not.toContain('PanelBottom');
    expect(bar).not.toContain('mobile-structure-panel');
    expect(bar).not.toContain('mobile-tools-panel');
    expect(css).toContain('border-radius: 999px');
    expect(css).toContain('.m-panel-pull-handle--top');
    expect(css).toContain('.m-unified-bar > .m-panel-pull-handle--bottom');
  });
});
