import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Mobile V2 M4 editing/search/all-chapters acceptance wiring', () => {
  it('owns paper and Project search without a prose-write path', () => {
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const runtime = source('shells/mobile/MobileAppShell.tsx');
    const overview = source('shells/mobile/workspace/MobileTabOverview.tsx');
    const projectSearch = source('shells/mobile/workspace/useMobileProjectSearch.ts');
    const paperSearch = source('shells/mobile/workspace/mobile-paper-search.ts');
    const regression = fs.readFileSync(
      path.join(repoRoot, 'docs/qa/mobile-search-focus-regression.md'),
      'utf8',
    );

    expect(bar).toContain('<MobileUnifiedSearch');
    expect(bar).toContain('owner?.setQuery(event.target.value)');
    expect(bar).toContain('onProjectSearch(snapshot.query)');
    expect(bar).toContain('seededOwnerRef.current === owner');
    expect(bar.match(/<MobileUnifiedSearchStep/g)).toHaveLength(2);
    expect(bar).toContain('onPointerDown={activateFromPointer}');
    expect(bar).not.toContain('onPointerUp={activateFromPointer}');
    expect(bar).toContain('onPointerDownCapture={preserveSearchFocus}');
    expect(bar).toContain('onMouseDownCapture={preserveSearchFocus}');
    expect(runtime).toContain('projectSearchQuery');
    expect(runtime).toContain('saveActiveEditor().finally');
    expect(overview).toContain('useMobileProjectSearch(searchQuery ?? \'\')');
    expect(overview).toContain('onActivateSearchResult(group.target)');
    expect(projectSearch).toContain('.select({');
    expect(projectSearch).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(paperSearch).toContain('Decoration.inline');
    expect(paperSearch).not.toContain('editor.commands.setTextSelection');
    expect(paperSearch).not.toContain('element?.scrollIntoView');
    expect(paperSearch).toContain("element?.closest<HTMLElement>('.editor-scroll')");
    expect(paperSearch).not.toContain('editor.commands.setContent');
    expect(regression).toContain('从编辑态进入的搜索必须记住编辑态来源');
    expect(regression).toContain('结果切换不应改变搜索输入框焦点或键盘状态');
    expect(regression).toContain('不得改变正文的垂直滚动位置');
  });

  it('keeps formatting in one horizontal accessory row while TOC and comments use sheets', () => {
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const sheet = source('shells/mobile/workspace/MobileBarSheet.tsx');
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(deck).toContain('<MobileBarSheet');
    expect(deck).not.toContain("{ kind: 'bar-sheet', sheet: 'formatting' }");
    expect(sheet).not.toContain('MobileFormattingSheetContent');
    expect(accessory).toContain("data-mode={mode}");
    expect(accessory).toContain('m-editor-accessory__actions');
    expect(accessory).toContain("mode === 'formatting'");
    expect(accessory).toContain('event.preventDefault()');
    expect(accessory).toContain('item.run(editor)');
    expect(css).toContain("[data-bar-sheet='outline'] .editor__toc-rail");
    expect(sheet).toContain("'mobile-outline-sheet-content'");
    expect(sheet).toContain("'mobile-comments-sheet-content'");
    expect(css).toContain('.m-outline-sheet-list__item--l5');
    expect(css).toContain(
      "[data-bar-sheet='comments'] #mobile-comments-sheet-content > .editor__margin",
    );
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('touch-action: pan-x');
  });

  it('bridges Android IME insets when edge-to-edge WebView geometry stays stable', () => {
    const geometry = source('shells/mobile/workspace/mobile-keyboard-geometry.ts');
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const back = source('shells/mobile/workspace/useMobileWorkspaceBack.ts');
    const activity = fs.readFileSync(
      path.join(
        repoRoot,
        'src-tauri/gen/android/app/src/main/java/cc/drifting/client/MainActivity.kt',
      ),
      'utf8',
    );

    expect(activity).toContain('WindowInsetsCompat.Type.ime()');
    expect(activity).toContain("'--mobile-native-keyboard-inset'");
    expect(activity).toContain("'drifting:native-keyboard-geometry'");
    expect(geometry).toContain('Math.max(visualInset, readMobileNativeKeyboardInset())');
    expect(accessory).toContain('MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT');
    expect(back).toContain("resolved.effect === 'blur-editor'");
    expect(back).toContain("resolved.effect === 'focus-editor'");
    expect(back).toContain('editor.view.focus()');
    expect(back.indexOf('editor.view.focus()')).toBeLessThan(
      back.indexOf("latest.dispatch({ type: 'replace'"),
    );
  });

  it('returns a panned iOS visual viewport top edge to the editor scroll range', () => {
    const geometry = source('shells/mobile/workspace/mobile-keyboard-geometry.ts');
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(geometry).toContain('mobileKeyboardViewportOffsetTop');
    expect(geometry).toContain('Math.max(0, visualViewport.offsetTop)');
    expect(geometry).toContain('mobileEditorScrollTopAfterReserveChange');
    expect(accessory).toContain('readMobileKeyboardViewportOffsetTop()');
    expect(deck).toContain("'--m-editor-top-scroll-reserve'");
    expect(deck).toContain('mobileEditorScrollTopAfterReserveChange');
    expect(deck).toContain('mobileEditorLogicalScrollTop');
    expect(css).toContain('padding-top: var(--m-editor-top-scroll-reserve)');
    expect(css).not.toContain('env(safe-area-inset-top) + var(--m-editor-top-scroll-reserve)');
  });

  it('promotes a touch at its caret only after flushing the previous live chapter', () => {
    const view = source('views/AllChaptersEditorView.tsx');
    const row = source('components/editor/VirtualChapterRow.tsx');
    const allChapters = source('shells/mobile/workspace/mobile-all-chapters.ts');

    expect(view).toContain('await saveActiveEditor()');
    expect(view).toContain('createMobileAllChaptersLoader');
    expect(view).toContain('writeMobileAllChaptersPosition');
    expect(view).toContain('createMobileAllChaptersSearchOwner');
    expect(row).toContain('onPointerDown');
    expect(row).toContain('isMobileAllChaptersTap');
    expect(row).toContain('editorTabSelectionKey(projectId');
    expect(row).toContain('IntersectionObserver');
    expect(allChapters).toContain('MOBILE_ALL_CHAPTERS_LOAD_CONCURRENCY = 6');
    expect(allChapters).toContain("caretIntent: 'restore-selection'");
  });

  it('keeps an empty mobile Project writable through the shared chapter use case', () => {
    const chapters = source('components/leftBars/ChapterPanel.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(chapters).toContain("presentation === 'mobile' &&");
    expect(chapters).toContain('onClick={() => void handleCreateNode(null)}');
    expect(chapters).toContain('options?.preview !== false');
    expect(css).toContain('.m-chapter-panel__create > button');
    expect(css).toContain('min-height: 44px');
  });

  it('keeps the editor-scroll and persistent-Back device handoff open', () => {
    const evidence = fs.readFileSync(
      path.join(
        repoRoot,
        'docs/qa/mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md',
      ),
      'utf8',
    );

    expect(evidence).toContain('physical-device acceptance is user-owned and pending');
    expect(evidence).toContain('chapter/storyline/word-count folio');
    expect(evidence).toContain('No Simulator, emulator, native build');
  });
});
