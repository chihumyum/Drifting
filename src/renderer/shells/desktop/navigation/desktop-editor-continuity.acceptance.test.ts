import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('desktop editor continuity acceptance', () => {
  it('makes open tabs own persistent surfaces and commits only ready targets', () => {
    const main = source('src/renderer/components/editor/EditorMainArea.tsx');
    const lifecycle = source(
      'src/renderer/components/editor/editor-surface-lifecycle-context.ts',
    );
    const activeEditor = source('src/renderer/hooks/useRegisterActiveEditor.ts');
    const nodeEditor = source('src/renderer/views/NodeEditorView.tsx');

    expect(main).not.toContain("from 'react-router-dom'");
    expect(main).not.toContain('<Outlet />');
    expect(main).toContain('...openTabs.map((tab) => ({ revisionKey: surfaceRevisionKey(tab), tab }))');
    expect(main).toContain('if (ready && isDesired) setCommittedSurface(descriptor);');
    expect(main).toContain('visibility: isVisible ? \'visible\' : \'hidden\'');
    expect(main).toContain('inert={!isInteractive}');
    expect(main).toContain('surface.revisionKey === desiredRevisionKey');
    expect(main).toContain('isPreparing={isDesired}');
    expect(main).toContain('isPreparing={isSurfacePreparing}');
    expect(lifecycle).toContain('isPreparing: boolean;');
    expect(main).toContain(
      '!next.some((surface) => surface.revisionKey === committedSurface.revisionKey)',
    );
    expect(lifecycle).toContain('useLayoutEffect(() => {');
    expect(lifecycle).toContain('reportReady(ready);');
    expect(activeEditor).toContain('if (!isSurfaceActive)');
    expect(activeEditor).toContain('if (surfaceActiveRef.current) setActiveEditor(editor);');
    expect(nodeEditor).toContain('if (isCommandActive && canPromoteOnEdit())');
  });

  it('never reveals an empty JSON editor or a pre-collaboration Yjs editor', () => {
    const entityEditor = source('src/renderer/hooks/useEntityEditor.ts');
    const template = source('src/renderer/components/editor/ElementTemplateEditor.tsx');
    const patch = source('src/renderer/components/editor/PatchEditorCard.tsx');
    const chapter = source('src/renderer/components/editor/ChapterEditor.tsx');
    const allChaptersRow = source('src/renderer/components/editor/VirtualChapterRow.tsx');
    const allChapters = source('src/renderer/views/AllChaptersEditorView.tsx');
    const materialPreview = source(
      'src/renderer/components/rightBars/MaterialPreviewPopover.tsx',
    );
    const loadError = source(
      'src/renderer/components/editor/EditorDocumentLoadError.tsx',
    );

    expect(entityEditor).toContain("documentMode?: 'json' | 'yjs'");
    expect(entityEditor).toContain("documentMode === 'json' ? parseContentJson(content) : null");
    expect(entityEditor).toContain('content: initialContent');
    expect(entityEditor).not.toContain('loadDocWithoutHistory');
    expect(entityEditor).toContain('collaboration?.options.document === ydoc');
    expect(entityEditor).toContain('const ready = canonicalReady && sessionReady && decorationsReady && linksReady;');
    expect(entityEditor).toContain('const linksReady = useEntityLinkConfiguration(editor,');
    expect(entityEditor).toContain('canonicalReady, presentationNeeded: isVisible || isPreparing,');
    expect(source('src/renderer/hooks/useEntityYjsDoc.ts')).toContain(
      'const enabled = Boolean(userId && projectId && entityId)',
    );
    expect(template).toContain('content: initialContent');
    expect(template).not.toContain('content: null');
    expect(patch).toContain('const [titleSnapshot, setTitleSnapshot]');
    expect(chapter).toContain("documentMode: 'yjs'");
    expect(chapter).toContain('onReadyChange?.(ready || Boolean(ydocError))');
    expect(chapter).toContain('<EditorDocumentLoadError />');
    expect(allChaptersRow).toContain('visibility: liveReady ? \'visible\' : \'hidden\'');
    expect(allChaptersRow).toContain('onReadyChange={setLiveReady}');
    expect(allChaptersRow).toContain('onContentReady?.(node.id)');
    expect(allChapters).toContain('useReportEditorSurfaceReady(hasCanonicalProseForCurrentBook)');
    expect(loadError).toContain('data-editor-document-load-error');
    expect(materialPreview).toContain('content: parsePreviewBody(item.bodyJson)');
    expect(materialPreview).not.toContain('content: null');
  });

  it('keeps node editor chrome mounted while only the keyed prose body waits', () => {
    const nodeEditor = source('src/renderer/views/NodeEditorView.tsx');
    const architecture = source('docs/renderer-ui-architecture.md');
    const visibleNode = nodeEditor.slice(
      nodeEditor.indexOf('{nodeId && curNode && ('),
      nodeEditor.indexOf('{conversionTarget && curNode && ('),
    );
    const beforeTopBar = visibleNode.slice(0, visibleNode.indexOf('<EditorTopBar'));
    const proseBody = visibleNode.slice(visibleNode.indexOf('<div className="editor-body"'));

    expect(beforeTopBar).not.toContain('isActiveNodeReady');
    expect(nodeEditor).toContain('loadedNodeContent?.nodeId === nodeId');
    expect(nodeEditor).toContain(
      'setLoadedNodeContent({ nodeId: targetNodeId, content: null, loadError: true });',
    );
    expect(proseBody).toContain('<div className="editor-body" key={nodeId}>');
    // The plot planner dock is the prose body's sibling. If it shared the
    // body's `nodeId` key, React would orphan the dock's DOM on close instead
    // of unmounting it, and every reopen would stack another dock.
    const plannerDock = visibleNode.slice(
      visibleNode.indexOf('<PlotPlannerDock'),
      visibleNode.indexOf('<div className="editor-body"'),
    );
    expect(plannerDock).toContain('key={`plot-planner:${nodeId}`}');
    expect(plannerDock).not.toContain('key={nodeId}');
    expect(proseBody.indexOf('isActiveNodeReady && !isActiveNodeLoadError ? (')).toBeLessThan(
      proseBody.indexOf('<ChapterEditor'),
    );
    expect(proseBody).toContain('<EditorDocumentLoadError />');
    expect(architecture).toContain('keeps editor chrome continuous across node-to-node switches');
    expect(nodeEditor).toContain('onReadyChange={reportReady}');
  });

  it('keeps the create surface until tab activation and creation routes commit', () => {
    const navigator = source(
      'src/renderer/shells/desktop/navigation/useDesktopWorkspaceNavigator.ts',
    );
    const completion = source(
      'src/renderer/shells/desktop/navigation/DesktopCreateCompletionTransition.ts',
    );
    const boundary = source(
      'src/renderer/shells/desktop/navigation/DesktopWorkspaceNavigationBoundary.tsx',
    );
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const shortcuts = source('src/renderer/shells/desktop/useDesktopGlobalShortcuts.ts');
    const routeSync = source('src/renderer/components/editor/useSyncSplitFocusedUrl.ts');
    const createView = source(
      'src/renderer/shells/desktop/entity-create/DesktopUniversalCreateView.tsx',
    );
    const architecture = source('docs/renderer-ui-architecture.md');

    expect(navigator).toContain('pendingCreateTransitionRef.current = {');
    expect(navigator).toContain("if (pending.kind === 'target')");
    expect(navigator).toContain('commitTarget(pending.target, pending.preview);');
    expect(timeline).toContain('if (target) activateLeafTab(target);');
    expect(timeline).toContain('activateLeafTab(leaf);');
    expect(shortcuts).toContain('if (target) navigator.activate(target);');
    expect(routeSync).toContain('navigator.open(target);');

    expect(completion.indexOf('pendingRef.current = { target, pathname };')).toBeLessThan(
      completion.lastIndexOf('navigate(pathname);'),
    );
    const activeCompletion = completion.slice(
      completion.indexOf('if (location.pathname !== pending.pathname)'),
    );
    expect(activeCompletion.indexOf('location.pathname !== pending.pathname')).toBeLessThan(
      activeCompletion.indexOf('state.replaceCreateTabWithEntity(projectId, pending.target);'),
    );
    expect(boundary).toContain(
      '<DesktopCreateCompletionContext.Provider value={completeCreateTab}>',
    );
    expect(createView).toContain('completeCreateTab(target);');
    expect(createView).not.toContain('replaceCreateTabWithEntity');
    expect(architecture).toContain('Every outbound transition from an active');
    expect(architecture).toContain('destination surface reports ready');
  });
});
