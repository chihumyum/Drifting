import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilterChip } from '../components/ui/FilterChip';
import { useAutosizeTextArea } from '../hooks/useAutosizeTextArea';
import { useParams } from 'react-router-dom';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useStoryline } from '../usecase/useStoryline';
import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { DesktopStickyNoteRail as StickyNoteRail } from '../features/comments/desktop/DesktopStickyNoteRail';
import { EditorReviewLayer } from '../components/editor/EditorReviewLayer';
import {
  useEditorSurfaceLifecycle,
  useReportEditorSurfaceReady,
} from '../components/editor/editor-surface-lifecycle-context';
import { useAgentChangeMarks } from '../hooks/useAgentChangeMarks';
import { EditorOutlineRail } from '../components/editor/EditorOutlineRail';
import { nestHeadings, type OutlineEntry } from '../components/editor/outline-rail-model';
import { ElementTemplateEditor } from '../components/editor/ElementTemplateEditor';
import { KvEditor } from '../components/editor/KvEditor';
import { FieldReview, FieldReviewStrip } from '../components/editor/FieldReview';
import { useFieldReview } from '../hooks/useFieldReview';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { canonicalWordCount, hasCanonicalWordCount, isChapter } from '../domain/book-node';
import {
  useEntityEditor,
  type EditorCommentRequest,
  type EditorPersistDerived,
} from '../hooks/useEntityEditor';
import { useEntityYjsDoc } from '../hooks/useEntityYjsDoc';
import { EditorDocumentLoadError } from '../components/editor/EditorDocumentLoadError';
import { useEntityStickyNoteRail } from '../hooks/useEntityStickyNoteRail';
import { useCanPromoteOnEdit, usePromoteCurrentTab, useUiStore } from '../store/ui-store';
import { editorTabSelectionKey } from '../lib/editor-selection-memory';
import loglevel from 'loglevel';

const log = loglevel.getLogger('StorylineEditorView');
log.setLevel(loglevel.levels.WARN);

const STORY_COLORS = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
];

type ChapterFilter = 'all' | 'written' | 'unwritten';

export function StorylineEditorView({
  storylineIdOverride,
}: { storylineIdOverride?: string } = {}) {
  const { t } = useTranslation();
  const { isCommandActive, isVisible } = useEditorSurfaceLifecycle();
  const params = useParams<{ projectId: string; storylineId: string }>();
  const projectId = params.projectId;
  const storylineId = storylineIdOverride ?? params.storylineId;
  const user = useAuthStore((state) => state.user);
  if (!projectId) throw new Error('No projectId in params');
  if (!user) throw new Error('No user in auth store');

  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const canPromoteOnEdit = useCanPromoteOnEdit(storylineId);
  const { storylines, bookNodes, storylineNodeMapping } = useDataStore();
  const { navigateToStoryline, leaveDeletedEntity, navigateToNode } = useProjectNavigation();
  const storylineUsecases = useStoryline({ projectId, userId: user.id });

  const currentStoryline = useMemo(() => {
    if (!storylineId) return null;
    return storylines.find((sl) => sl.id === storylineId) ?? null;
  }, [storylineId, storylines]);

  // Chapters belonging to this storyline, sorted by timeline position.
  // `isChapter` narrows bookOrder to a non-nullable number so the sort
  // comparator is a plain subtraction.
  const sNodes = useMemo(() => {
    if (!storylineId) return [];
    const ids = storylineNodeMapping[storylineId] ?? [];
    const byId = new Map(bookNodes.map((n) => [n.id, n]));
    return ids
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n))
      .filter(isChapter)
      .sort((a, b) => a.bookOrder - b.bookOrder);
  }, [bookNodes, storylineId, storylineNodeMapping]);

  const metricsReady = sNodes.every(hasCanonicalWordCount);
  const totalWc = sNodes.reduce((sum, node) => sum + (canonicalWordCount(node) ?? 0), 0);
  const writtenCount = metricsReady
    ? sNodes.filter((node) => (canonicalWordCount(node) ?? 0) > 0).length
    : null;
  const unwrittenCount = writtenCount == null ? null : sNodes.length - writtenCount;

  const [chapterFilter, setChapterFilter] = useState<ChapterFilter>('all');
  const [pendingComment, setPendingComment] = useState<EditorCommentRequest | null>(null);
  const stickyNoteRail = useEntityStickyNoteRail('storyline', storylineId);
  const marginNotes = stickyNoteRail.visible;
  const setMarginNotes = stickyNoteRail.setVisible;
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const setEntityLinkInteractive = useSettingsStore((state) => state.setEntityLinkInteractive);
  const toggleEntityLinkInteractive = useCallback(
    () => setEntityLinkInteractive(!entityLinkInteractive),
    [entityLinkInteractive, setEntityLinkInteractive],
  );
  const commentCount = stickyNoteRail.itemIds.length;
  const toggleComments = useCallback(() => {
    const next = !marginNotes;
    setMarginNotes(next);
    if (!next) setPendingComment(null);
  }, [marginNotes, setMarginNotes]);
  const handleAddCommentRequest = useCallback(
    (request: EditorCommentRequest) => {
      setMarginNotes(true);
      setPendingComment(request);
    },
    [setMarginNotes],
  );
  const filteredNodes = sNodes.filter((n) => {
    if (!metricsReady || chapterFilter === 'all') return true;
    const hasContent = (canonicalWordCount(n) ?? 0) > 0;
    return chapterFilter === 'written' ? hasContent : !hasContent;
  });

  // Name + summary local drafts
  const currentName = currentStoryline?.name ?? '';
  const currentSummary = currentStoryline?.summary ?? '';
  const [nameDraft, setNameDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [isComposingName, setIsComposingName] = useState(false);
  const [isComposingSummary, setIsComposingSummary] = useState(false);
  const displayedName = isEditingName ? nameDraft : currentName;
  const displayedSummary = isEditingSummary ? summaryDraft : currentSummary;

  const commitName = async () => {
    if (!storylineId || nameDraft === currentName) return;
    promoteCurrentTab();
    await storylineUsecases.updateStoryline({ id: storylineId, name: nameDraft });
  };
  // 概要 textarea 自动增高，去掉固定 rows 的裁切
  const summaryRef = useAutosizeTextArea(displayedSummary);

  const commitSummary = async () => {
    if (!storylineId || summaryDraft === currentSummary) return;
    promoteCurrentTab();
    await storylineUsecases.updateStoryline({ id: storylineId, summary: summaryDraft });
  };
  const commitColor = async (color: string) => {
    if (!storylineId || color === currentStoryline?.color) return;
    promoteCurrentTab();
    await storylineUsecases.updateStoryline({ id: storylineId, color });
  };

  // KV persistence: KvEditor strips empty rows, so even an empty list comes
  // back as '[]' and never thrashes. The usecase short-circuits no-op writes
  // by comparing fields, but this is the user-facing trigger.
  const commitKv = useCallback(
    (nextJson: string) => {
      if (!storylineId || nextJson === currentStoryline?.kvJson) return;
      promoteCurrentTab();
      void storylineUsecases.updateStoryline({ id: storylineId, kvJson: nextJson });
    },
    [storylineId, currentStoryline?.kvJson, storylineUsecases, promoteCurrentTab],
  );

  // Review of the agent's non-prose field edits (summary + kv). The summary
  // textarea reads currentSummary live when unfocused, so no buffer sync needed.
  const fieldReview = useFieldReview(
    'storyline',
    storylineId,
    projectId,
    { kvJson: currentStoryline?.kvJson },
    {
      summary: (v) => {
        if (storylineId) void storylineUsecases.updateStoryline({ id: storylineId, summary: v });
      },
      kvJson: (v) => {
        if (storylineId) void storylineUsecases.updateStoryline({ id: storylineId, kvJson: v });
      },
    },
  );

  // Node-content template: TipTap doc seeded into new nodes under this
  // storyline. Persist on every editor update (same as ElementTemplateEditor's
  // contract).
  const commitNodeTemplate = useCallback(
    (templateJson: string) => {
      if (!storylineId || templateJson === currentStoryline?.nodeContentTemplateJson) return;
      promoteCurrentTab();
      void storylineUsecases.updateStoryline({
        id: storylineId,
        nodeContentTemplateJson: templateJson,
      });
    },
    [storylineId, currentStoryline?.nodeContentTemplateJson, storylineUsecases, promoteCurrentTab],
  );

  const { ydoc, ydocError } = useEntityYjsDoc({
    kind: 'storyline',
    entityId: currentStoryline?.id ?? '',
    projectId,
    seedContentJson: currentStoryline?.contentJson ?? null,
  });

  // Scratch body (contentJson) — TipTap editor for free-form notes.
  const handlePersist = useCallback(
    (_ed: Editor, { pmJson }: EditorPersistDerived) => {
      if (!storylineId) return;
      if (pmJson === currentStoryline?.contentJson) return;
      if (isCommandActive && canPromoteOnEdit()) promoteCurrentTab();
      void storylineUsecases.updateStoryline({
        id: storylineId,
        contentJson: pmJson,
      });
    },
    [
      storylineId,
      currentStoryline?.contentJson,
      canPromoteOnEdit,
      isCommandActive,
      storylineUsecases,
      promoteCurrentTab,
    ],
  );
  const { editor, outline, ready: editorReady } = useEntityEditor({
    sourceKind: 'storyline',
    sourceId: currentStoryline?.id ?? '',
    projectId,
    content: currentStoryline?.contentJson ?? null,
    documentMode: 'yjs',
    ydoc,
    onPersist: handlePersist,
    placeholder: t('storylineEditor.scratchPlaceholder'),
    typewriterScrolling: true,
    onAddCommentRequest: handleAddCommentRequest,
    selectionKey: currentStoryline
      ? editorTabSelectionKey(projectId, { entityType: 'storyline', id: currentStoryline.id })
      : null,
    editable: Boolean(ydoc),
  });
  useReportEditorSurfaceReady(Boolean(currentStoryline && (editorReady || ydocError)));

  // TOC framework anchors in document order: 概述 → 札记 (with its body
  // headings nested as sub-structure) → 字段 → 章节模版 → 章节序列. Sections carry
  // no ordinal — order is the only ranking. 章节序列 is omitted when the storyline
  // has no chapters.
  const frameworkItems: OutlineEntry[] = [
    { id: 'sl-overview', level: 2, kind: 'section', text: t('storylineEditor.sections.overview') },
    { id: 'sl-scratch', level: 2, kind: 'section', text: t('storylineEditor.sections.scratchShort'), children: nestHeadings(outline) },
    { id: 'sl-kv', level: 2, kind: 'section', text: t('storylineEditor.sections.facts') },
    { id: 'sl-node-template', level: 2, kind: 'section', text: t('storylineEditor.sections.nodeTemplate') },
  ];
  if (sNodes.length > 0) {
    frameworkItems.push({ id: 'sl-chapters', level: 2, kind: 'section', text: t('storylineEditor.sections.chapters') });
  }
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Surface agent edits to this storyline's body (ticks + reveal/approve).
  useAgentChangeMarks(scrollEl, 'storyline', storylineId, isVisible);
  const { activeId: activeOutlineId, pin: pinOutline } = useOutlineScrollspy(
    scrollEl,
    // Flat id list (framework anchors + every body heading).
    [...frameworkItems.map((item) => item.id), ...outline.map((heading) => heading.id)],
  );

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!storylineId || !currentStoryline) return;
      if (action === 'deleteStoryline') {
        const confirmed = window.confirm(t('storylineEditor.deleteConfirm', { name: currentStoryline.name }));
        if (!confirmed) return;
        try {
          await storylineUsecases.deleteStoryline(storylineId);
          leaveDeletedEntity();
        } catch (error) {
          log.error('Failed to delete storyline:', error);
          alert(t('storylineEditor.alerts.deleteFailed'));
        }
      }
    },
    [storylineId, currentStoryline, storylineUsecases, leaveDeletedEntity, t],
  );

  // Pending-action consumer — see NodeEditorView for the queue rationale.
  const pendingEntityAction = useUiStore((s) => s.pendingEntityAction);
  const consumeEntityAction = useUiStore((s) => s.consumeEntityAction);
  useEffect(() => {
    if (!isCommandActive) return;
    if (!storylineId || !currentStoryline) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('storyline', storylineId);
    if (queued) void handleContextAction(queued);
  }, [
    isCommandActive,
    storylineId,
    currentStoryline,
    pendingEntityAction,
    consumeEntityAction,
    handleContextAction,
  ]);

  if (!currentStoryline) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'hsl(var(--ink-4))' }}>
        {t('storylineEditor.loading')}
      </div>
    );
  }

  const storylineColor = currentStoryline.color || 'hsl(var(--accent))';

  return (
    <div className="editor-shell" style={{ height: '100%', position: 'relative' }}>
      <EditorTopBar
        editorType="storyline"
        onMenuAction={handleContextAction}
        referenceLinkToggle={{
          enabled: entityLinkInteractive,
          onToggle: toggleEntityLinkInteractive,
        }}
        commentToggle={{
          enabled: marginNotes,
          count: commentCount,
          disabled: false,
          onToggle: toggleComments,
        }}
        right={
          <span>{t('storylineEditor.meta.chapters', { count: sNodes.length })}</span>
        }
      >
        <EditorCrumb
          dotColor={currentStoryline.color || 'hsl(var(--accent))'}
          dropdown={
            storylines.length === 0 ? (
              <div className="crumb-dropdown__empty">{t('nodeEditor.empty.noStorylines')}</div>
            ) : (
              storylines.map((s) => {
                const isActive = s.id === storylineId;
                return (
                  <div
                    key={s.id}
                    className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                    onClick={() => navigateToStoryline(s.id)}
                  >
                    <span className="crumb-dropdown__dot" style={{ background: s.color || 'hsl(var(--accent))' }} />
                    <span>{s.name}</span>
                  </div>
                );
              })
            )
          }
        >
          <span>{currentStoryline.name || t('storylineEditor.untitled')}</span>
        </EditorCrumb>
      </EditorTopBar>

      <div className="editor-body">
        <EditorOutlineRail
          title={t('storylineEditor.outlineTitle', { name: currentStoryline.name || 'STORYLINE' })}
          items={frameworkItems}
          activeId={activeOutlineId}
          onItemClick={(id) => {
            pinOutline(id);
            scrollToOutlineAnchor(id, scrollEl);
          }}
        />
        <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
          <div className="editor__spread">
          <article
            className="page page--entity"
            style={{ ['--s-color' as string]: storylineColor } as React.CSSProperties}
          >
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">{t('storylineEditor.folio')}</span>
              <span className="page__folio-line" style={{ color: storylineColor, fontWeight: 600 }}>
                {currentStoryline.name}
              </span>
              <span className="page__folio-line">{t('storylineEditor.meta.chapters', { count: sNodes.length })}</span>
              <span className="page__folio-line">
                {metricsReady
                  ? t('storylineEditor.meta.kWords', { count: (totalWc / 1000).toFixed(1) })
                  : t('common.counting')}
              </span>
            </div>

            {/* 一 · 概述 */}
            <section id="sl-overview">
              <div className="elem-hero">
                <div
                  className="elem-portrait elem-portrait--storyline"
                  style={{ ['--s-color' as string]: storylineColor } as React.CSSProperties}
                >
                  <span className="elem-portrait__hint">{currentStoryline.name}</span>
                </div>
                <div className="elem-hero__main">
                  <input
                    type="text"
                    className="elem-hero__name"
                    value={displayedName}
                    onFocus={() => { setNameDraft(currentName); setIsEditingName(true); }}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onCompositionStart={() => setIsComposingName(true)}
                    onCompositionEnd={(e) => { setIsComposingName(false); setNameDraft(e.currentTarget.value); }}
                    onBlur={() => { setIsEditingName(false); if (!isComposingName) void commitName(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isComposingName) {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                      if (e.key === 'Escape') {
                        setNameDraft(currentName);
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder={t('storylineEditor.untitled')}
                  />

                  {fieldReview.summaryChange ? (
                    <FieldReview
                      change={fieldReview.summaryChange}
                      onAccept={() => fieldReview.accept(fieldReview.summaryChange!)}
                      onReject={() => fieldReview.reject(fieldReview.summaryChange!)}
                    />
                  ) : (
                    <textarea
                      ref={summaryRef}
                      className="elem-hero__summary"
                      value={displayedSummary}
                      onFocus={() => { setSummaryDraft(currentSummary); setIsEditingSummary(true); }}
                      onChange={(e) => setSummaryDraft(e.target.value)}
                      onCompositionStart={() => setIsComposingSummary(true)}
                      onCompositionEnd={(e) => { setIsComposingSummary(false); setSummaryDraft(e.currentTarget.value); }}
                      onBlur={() => { setIsEditingSummary(false); if (!isComposingSummary) void commitSummary(); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setSummaryDraft(currentSummary);
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder={t('storylineEditor.summaryPlaceholder')}
                      rows={1}
                    />
                  )}

                  <div className="elem-hero__facts">
                    <div className="elem-hero__fact-k">{t('storylineEditor.labels.color')}</div>
                    <div className="elem-hero__fact-v">
                      <div className="col-pick">
                        {STORY_COLORS.map((c) => (
                          <div
                            key={c}
                            className={`col-pick__sw${c === currentStoryline.color ? ' col-pick__sw--active' : ''}`}
                            style={{ ['--c' as string]: c } as React.CSSProperties}
                            onClick={() => void commitColor(c)}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* DEFERRED: pov / tense / period / place facts, aliases, themes,
                      keyElements, story arc. All require new schema columns; will
                      surface here once added. */}
                </div>
              </div>
            </section>

            {/* 札记 — free-form notes (TipTap body). Leads the sections, right
                under the hero; its H1/H2/H3 headings nest under this anchor in
                the TOC. */}
            <h2 id="sl-scratch" className="page__scene">
              <span className="page__scene-title">{t('storylineEditor.sections.scratch')}</span>
            </h2>
            <div className="elem-body">
              {ydocError ? <EditorDocumentLoadError /> : <EditorContent editor={editor} />}
            </div>

            {/* 字段 — storyline's own KV facts (seeded from project's storyline
                template at creation, owned thereafter). */}
            <h2 id="sl-kv" className="page__scene">
              <span className="page__scene-title">{t('storylineEditor.sections.facts')}</span>
              <span className="page__scene-meta">{t('storylineEditor.meta.facts')}</span>
            </h2>
            <div className="elem-body">
              <FieldReviewStrip
                changes={fieldReview.kvChanges}
                onAccept={fieldReview.accept}
                onReject={fieldReview.reject}
              />
              <KvEditor
                key={`sl-kv-${currentStoryline.id}`}
                valueJson={currentStoryline.kvJson}
                onPersist={commitKv}
                suppressKeys={new Set(fieldReview.kvChanges.map((c) => c.field?.key ?? ''))}
                emptyHint={t('storylineEditor.empty.noFacts')}
              />
            </div>

            {/* 章节模版 — TipTap doc seeded into new nodes under this
                storyline. Editing only affects future nodes; existing nodes
                are untouched. */}
            <h2 id="sl-node-template" className="page__scene">
              <span className="page__scene-title">{t('storylineEditor.sections.nodeTemplate')}</span>
              <span className="page__scene-meta">{t('storylineEditor.meta.nodeTemplate')}</span>
            </h2>
            <div className="elem-body">
              <ElementTemplateEditor
                key={`sl-node-tpl-${currentStoryline.id}`}
                templateJson={currentStoryline.nodeContentTemplateJson}
                onPersist={commitNodeTemplate}
                placeholder={t('storylineEditor.nodeTemplatePlaceholder')}
              />
            </div>

            {/* 章节序列 — chapters on this storyline (omitted when none). */}
            {sNodes.length > 0 && (
              <>
                <h2 id="sl-chapters" className="page__scene">
                  <span className="page__scene-title">{t('storylineEditor.sections.chapters')}</span>
                  <span className="page__scene-meta">
                    {metricsReady
                      ? t('storylineEditor.meta.chaptersWords', {
                          chapters: sNodes.length,
                          words: (totalWc / 1000).toFixed(1),
                        })
                      : t('common.counting')}
                  </span>
                </h2>

                <div className="mgr-toolbar">
                  <div className="mgr-toolbar__chips">
                    {([
                      ['all',        t('storylineEditor.filters.all'),    sNodes.length],
                      ['written',    t('storylineEditor.filters.written'),    writtenCount],
                      ['unwritten',  t('storylineEditor.filters.unwritten'),    unwrittenCount],
                    ] as const).map(([k, label, n]) => (
                      <FilterChip
                        key={k}
                        shape="square"
                        active={chapterFilter === k}
                        count={`· ${n ?? t('common.counting')}`}
                        disabled={!metricsReady && k !== 'all'}
                        onClick={() => setChapterFilter(k)}
                      >
                        {label}
                      </FilterChip>
                    ))}
                  </div>
                  {/* DEFERRED: search / reorder / batch actions */}
                </div>

                <div className="mgr-list">
                  {filteredNodes.map((n, idx) => {
                    const exactWords = canonicalWordCount(n);
                    const hasContent = (exactWords ?? 0) > 0;
                    // No `status` enum in schema yet — derive from wordCount.
                    // Once a real status field exists, switch the modifier class.
                    const statusMod =
                      exactWords == null || hasContent ? '' : ' mgr-row__status--todo';
                    return (
                      <div
                        key={n.id}
                        className="mgr-row"
                        style={{ ['--s-color' as string]: storylineColor } as React.CSSProperties}
                        onClick={() => navigateToNode(n.id)}
                      >
                        <div className={`mgr-row__status${statusMod}`} />
                        <div className="mgr-row__num">§{String(idx + 1).padStart(2, '0')}</div>
                        <div className="mgr-row__body">
                          <div className="mgr-row__title">
                            <span>{n.title || t('common.untitled')}</span>
                          </div>
                          <div className={`mgr-row__summary${n.summary ? '' : ' mgr-row__summary--empty'}`}>
                            {n.summary || t('storylineEditor.empty.noChapterSummary')}
                          </div>
                          <div className="mgr-row__meta">
                            <span>
                              <b>{exactWords?.toLocaleString() ?? t('common.counting')}</b>
                              {exactWords != null && t('common.words')}
                            </span>
                            <span>
                              {exactWords == null
                                ? t('common.counting')
                                : hasContent
                                  ? t('storylineEditor.filters.written')
                                  : t('storylineEditor.filters.unwritten')}
                            </span>
                          </div>
                        </div>
                        <div className="mgr-row__wc">
                          <span className="mgr-row__wc-v">
                            {exactWords == null ? (
                              t('common.counting')
                            ) : exactWords > 0 ? (
                              <>
                                {(exactWords / 1000).toFixed(1)}
                                <em>k</em>
                              </>
                            ) : (
                              '—'
                            )}
                          </span>
                          {exactWords != null && (
                            <span className="mgr-row__wc-k">{t('common.words')}</span>
                          )}
                        </div>
                        <div className="mgr-row__open" title={t('storylineEditor.actions.openChapter')}>→</div>
                      </div>
                    );
                  })}
                  {filteredNodes.length === 0 && (
                    <div className="mgr-empty">{t('storylineEditor.empty.noFilteredChapters')}</div>
                  )}
                </div>
              </>
            )}

          </article>
          </div>
        </div>
        {marginNotes && (
          <StickyNoteRail
            projectId={projectId}
            targetKind="storyline"
            targetId={currentStoryline.id}
            pendingRequest={pendingComment}
            onPendingRequestChange={setPendingComment}
          />
        )}
        <EditorReviewLayer
          projectId={projectId}
          entityType="storyline"
          id={currentStoryline.id}
          scrollEl={scrollEl}
          visibleCommentIds={marginNotes ? stickyNoteRail.itemIds : undefined}
        />
      </div>
    </div>
  );
}
