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
    expect(accessory).toMatch(/<span\s+role="button"[\s\S]*?className="m-editor-accessory__toggle"/u);
    expect(accessory).not.toMatch(/<button[\s\S]{0,160}m-editor-accessory__toggle/u);
    expect(accessory).not.toContain('editor.view.focus();');
    expect(accessory).not.toContain('queueMicrotask(refocusEditor);');
    expect(accessory).toContain('onPointerUp={toggle}');
    expect(accessory).toContain('onClick={handleToggleClick}');
    expect(bar.match(/data-debug-id="mobile-unified-back"/g)).toHaveLength(2);
    expect(bar).toContain('backPreservesEditorFocus');
    expect(bar).toContain("const backPreservesEditorFocus = projection.mode === 'edit'");
    expect(bar).toContain("preflightDom: projection.mode !== 'edit'");
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
    const styles = document('src/styles/mobile-workspace.css');

    expect(bar).toContain('focus({ preventScroll: true })');
    expect(bar).not.toMatch(/<input[\s\S]{0,160}\sautoFocus(?:=|\s|>)/u);
    expect(bar).toContain('readMobileKeyboardViewportOffsetTop()');
    expect(bar).toMatch(
      /data-debug-id="mobile-open-search"[\s\S]*?if \(projection\.mode === 'edit'\) event\.preventDefault\(\)/u,
    );
    expect(controller).toContain('paperMode: READ_MODE');
    expect(styles).toContain(
      ".m-workspace[data-controller-paper-mode='edit'][data-controller-keyboard='open']",
    );
    expect(styles).toContain(
      ".m-workspace[data-controller-transient='search'][data-controller-keyboard='open']",
    );
    expect(deck).toContain("workspaceUi.transient.kind === 'search'");
    expect(deck).toContain('keyboardViewportOffsetTop');
    expect(styles).not.toContain(
      ".m-workspace[data-controller-keyboard='open'] .m-paper-deck__content",
    );
  });

  it('uses one 144px close snap zone for top and bottom panel handles', () => {
    const gesture = source('shells/mobile/workspace/mobile-panel-gesture.ts');
    const handle = source('shells/mobile/workspace/MobilePanelPullHandle.tsx');

    expect(gesture).toContain('const CLOSE_SNAP_PX = 144');
    expect(gesture).toContain('CLOSE_SNAP_PX / Math.max(1, gesture.viewportHeightPx)');
    expect(gesture).toContain('if (extent <= closeEdge)');
    expect(handle.match(/viewportHeightPx: Math\.max\(1, window\.innerHeight\)/g)).toHaveLength(2);
  });

  it('keeps the product contract and device-handoff boundary attached', () => {
    const editing = document('docs/mobile-v2/editing-comments-search-and-all-chapters.md');
    const panels = document('docs/mobile-v2/unified-bar-rails-and-paper-swipe.md');
    const evidence = document(
      'docs/qa/mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md',
    );

    expect(editing).toContain('keyboard-dismiss Chevron.');
    expect(panels).toContain('Releases at 144 CSS pixels');
    expect(evidence).toContain('No Simulator, emulator, native build');
    expect(evidence).toContain('physical-device acceptance is user-owned and pending');
  });
});
