import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');
const document = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('Mobile format-level toggle and panel close snap correction', () => {
  it('uses persistent Back to collapse formatting and shows Format only at navigation level', () => {
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const backRequest = source('shells/mobile/workspace/mobile-workspace-back.ts');
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');
    const styles = document('src/styles/mobile-workspace.css');

    expect(accessory).toContain('data-debug-id="mobile-toggle-formatting"');
    expect(accessory).toMatch(/\{mode === 'navigation' && \([\s\S]*?mobile-toggle-formatting/u);
    expect(accessory).toContain('onClick={() => onModeChange?.(\'formatting\')}');
    expect(accessory).not.toContain('onPointerDown=');
    expect(accessory).not.toContain('onPointerUp=');
    expect(accessory).not.toContain('editor.view.focus();');
    expect(source('shells/mobile/workspace/MobileUnifiedBackAction.tsx')).toContain('useInputPreservingActions');
    expect(bar).toContain('backPreservesFocusUntilResolution');
    expect(bar).toContain("projection.mode === 'edit' || projection.mode === 'search'");
    expect(bar).toContain(
      "preflightDom: projection.mode !== 'edit' && projection.mode !== 'search'",
    );
    expect(backRequest).toContain('if (preflightDom)');
    expect(controller).toContain("return resolution('editor-accessory'");
    expect(controller).toContain("paperMode: { kind: 'edit', accessory: 'navigation' }");
    expect(styles).toMatch(/\.m-editor-accessory__toggle \{[\s\S]*?touch-action: none;/u);
    expect(bar).not.toContain('data-debug-id="mobile-dismiss-keyboard"');
  });

  it('keeps Search input ownership separate from editor focus and paper geometry', () => {
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');
    const back = source('shells/mobile/workspace/useMobileWorkspaceBack.ts');
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const styles = document('src/styles/mobile-workspace.css');

    expect(bar).toContain('focus({ preventScroll: true })');
    expect(bar).not.toMatch(/<input[\s\S]{0,160}\sautoFocus(?:=|\s|>)/u);
    expect(bar).not.toContain(
      'onKeyboardViewportOffsetTopChange(readMobileKeyboardViewportOffsetTop())',
    );
    // Search and Agent share the persistent toolbar with editor input ownership.
    expect(bar).not.toContain('mobile-open-search');
    const face = source('shells/mobile/workspace/MobilePaperToolsBar.tsx');
    expect(face).not.toContain('onOpenSearch');
    expect(bar).toContain("['search', Search,");
    expect(controller).toContain('paperMode: READ_MODE');
    expect(controller).toContain("type: 'open-search'");
    expect(controller).toContain('returnTo: state.toolReturnTo ?? state.paperMode');
    expect(controller).toContain("keyboard: state.keyboard");
    expect(controller).toContain("returnToEditing ? 'focus-editor' : 'none'");
    expect(back).toContain("resolved.effect === 'focus-editor'");
    expect(back).toContain('editor.view.focus()');
    expect(back).not.toContain('commands.focus');
    expect(accessory).not.toContain('onKeyboardViewportOffsetTopChange?.(0)');
    expect(styles).toContain(
      ".m-workspace[data-controller-paper-mode='edit'][data-controller-keyboard='open']",
    );
    expect(styles).toContain(
      ".m-workspace[data-controller-transient='search'][data-controller-keyboard='open']",
    );
    expect(deck).toContain("workspaceUi.transient.kind === 'search'");
    expect(deck).toContain('keyboardViewportOffsetTop');
    expect(styles).toContain('.m-unified-search__step');
    expect(styles).toMatch(/\.m-unified-search__step \{[\s\S]*?touch-action: none;/u);
    expect(styles).not.toContain(
      ".m-workspace[data-controller-keyboard='open'] .m-paper-deck__content",
    );
  });

  it('keeps the device-handoff boundary attached', () => {
    const evidence = document(
      'docs/qa/mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md',
    );

    expect(evidence).toContain('No Simulator, emulator, native build');
    expect(evidence).toContain('closed 2026-08-26');
    expect(evidence).toContain('## Acceptance record — 2026-08-26');
  });
});
