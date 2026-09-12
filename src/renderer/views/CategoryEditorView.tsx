import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilterChip } from '../components/ui/FilterChip';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useParams } from 'react-router-dom';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { useDataStoreFields } from '../store/use-data-store-fields';
import { requestConfirmation } from '../store/confirmation-store';
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
import { FieldReviewStrip } from '../components/editor/FieldReview';
import { useFieldReview } from '../hooks/useFieldReview';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
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
import { useAuthStore } from '../store/auth';

const log = loglevel.getLogger('CategoryEditorView');
log.setLevel(loglevel.levels.ERROR);

const CATEGORY_COLORS = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
];

type ElementFilter = 'all' | 'used' | 'unused';

export function CategoryEditorView({
  categoryIdOverride,
}: { categoryIdOverride?: string } = {}) {
  const { t } = useTranslation();
  const { isCommandActive, isVisible } = useEditorSurfaceLifecycle();
  const params = useParams<{ projectId: string; categoryId: string }>();
  const projectId = params.projectId;
  const categoryId = categoryIdOverride ?? params.categoryId;
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const canPromoteOnEdit = useCanPromoteOnEdit(categoryId);
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required');
  if (!userId) throw new Error('User must be authenticated');

  const { bookElementCategories, bookElements } = useDataStoreFields('bookElementCategories', 'bookElements');
  useBookElement({ projectId, userId });
  const categoryUsecases = useElementCategory({ projectId, userId });
  const { leaveDeletedEntity, navigateToElement, navigateToCategory } = useProjectNavigation();

  // Redirect if category param is missing. Fall back to the active tab / empty
  // editor rather than the dashboard (no auto-opened dashboard tab, ever).
  useEffect(() => {
    if (!categoryId) leaveDeletedEntity();
  }, [categoryId, leaveDeletedEntity]);

  const curCategory = useMemo(() => {
    if (!categoryId) return null;
    return bookElementCategories.find((cat) => cat.id === categoryId) || null;
  }, [bookElementCategories, categoryId]);

  // Elements belonging to this category.
  const cEls = useMemo(() => {
    if (!categoryId) return [];
    return bookElements.filter((el) => el.categoryId === categoryId);
  }, [bookElements, categoryId]);

  const [elementFilter, setElementFilter] = useState<ElementFilter>('all');
  const [pendingComment, setPendingComment] = useState<EditorCommentRequest | null>(null);
  const stickyNoteRail = useEntityStickyNoteRail('category', categoryId);
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
  const filteredEls = cEls.filter((e) => {
    if (elementFilter === 'all') return true;
    // No per-element mention count in schema yet — treat any saved summary
    // or contentJson change as "used". Replace with real mention count when
    // a reference-projection aggregate lands.
    const hasContent =
      (e.summary && e.summary.length > 0) ||
      (e.contentJson && e.contentJson !== '{}' && e.contentJson !== '');
    return elementFilter === 'used' ? hasContent : !hasContent;
  });
  const usedCount = cEls.filter((e) =>
    (e.summary && e.summary.length > 0) ||
    (e.contentJson && e.contentJson !== '{}' && e.contentJson !== ''),
  ).length;

  // Name editing
  const [nameDraft, setNameDraft] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isComposingName, setIsComposingName] = useState(false);
  const currentName = curCategory?.name ?? '';
  const displayedName = isEditingName ? nameDraft : currentName;

  const commitName = async () => {
    if (!curCategory) return;
    const next = nameDraft.trim();
    if (!next || next === curCategory.name) return;
    promoteCurrentTab();
    try {
      await categoryUsecases.updateCategory(curCategory.id, { name: next });
    } catch (error) {
      log.error('Failed to update category name:', error);
    }
  };

  const commitColor = async (color: string) => {
    if (!curCategory || color === curCategory.color) return;
    promoteCurrentTab();
    await categoryUsecases.updateCategory(curCategory.id, { color });
  };

  const commitTemplate = useCallback(
    (templateJson: string) => {
      if (!curCategory || templateJson === curCategory.elementTemplateJson) return;
      promoteCurrentTab();
      void categoryUsecases.updateCategory(curCategory.id, { elementTemplateJson: templateJson });
    },
    [curCategory, categoryUsecases, promoteCurrentTab],
  );

  const commitTemplateKv = useCallback(
    (nextJson: string) => {
      if (!curCategory || nextJson === curCategory.elementTemplateKvJson) return;
      promoteCurrentTab();
      void categoryUsecases.updateCategory(curCategory.id, {
        elementTemplateKvJson: nextJson,
      });
    },
    [curCategory, categoryUsecases, promoteCurrentTab],
  );

  // Review of the agent's template-kv edits (the only non-prose field the agent
  // writes on a category). Reject writes the old value back via the usecase.
  const fieldReview = useFieldReview(
    'category',
    categoryId,
    projectId,
    { templateKvJson: curCategory?.elementTemplateKvJson },
    {
      templateKvJson: (v) => {
        if (curCategory) void categoryUsecases.updateCategory(curCategory.id, { elementTemplateKvJson: v });
      },
    },
  );

  const { ydoc, ydocError } = useEntityYjsDoc({
    kind: 'category',
    entityId: curCategory?.id ?? '',
    projectId,
    seedContentJson: curCategory?.contentJson ?? null,
  });

  // Scratch body (contentJson) — TipTap editor for category notes.
  const handlePersist = useCallback(
    (_ed: Editor, { pmJson }: EditorPersistDerived) => {
      if (!curCategory) return;
      if (pmJson === curCategory.contentJson) return;
      if (isCommandActive && canPromoteOnEdit()) promoteCurrentTab();
      void categoryUsecases.updateCategory(curCategory.id, { contentJson: pmJson });
    },
    [
      curCategory,
      canPromoteOnEdit,
      categoryUsecases,
      isCommandActive,
      promoteCurrentTab,
    ],
  );
  const { editor, outline, ready: editorReady } = useEntityEditor({
    sourceKind: 'category',
    sourceId: curCategory?.id ?? '',
    projectId,
    content: curCategory?.contentJson ?? null,
    documentMode: 'yjs',
    ydoc,
    onPersist: handlePersist,
    placeholder: t('categoryEditor.scratchPlaceholder'),
    typewriterScrolling: true,
    onAddCommentRequest: handleAddCommentRequest,
    selectionKey: curCategory
      ? editorTabSelectionKey(projectId, { entityType: 'category', id: curCategory.id })
      : null,
    editable: Boolean(ydoc),
  });
  useReportEditorSurfaceReady(Boolean(curCategory && (editorReady || ydocError)));

  // TOC framework anchors in document order: 概述 → 札记 (with its body headings
  // nested as sub-structure) → 元素模版 → 字段模版 → 元素清单. Sections carry no
  // ordinal — order is the only ranking. 元素清单 is omitted when the category has
  // no elements.
  const frameworkItems: OutlineEntry[] = [
    { id: 'cat-overview', level: 2, kind: 'section', text: t('categoryEditor.sections.overview') },
    { id: 'cat-scratch', level: 2, kind: 'section', text: t('categoryEditor.sections.scratchShort'), children: nestHeadings(outline) },
    { id: 'cat-template', level: 2, kind: 'section', text: t('categoryEditor.sections.elementTemplateShort') },
    { id: 'cat-template-kv', level: 2, kind: 'section', text: t('categoryEditor.sections.templateKv') },
  ];
  if (cEls.length > 0) {
    frameworkItems.push({ id: 'cat-elements', level: 2, kind: 'section', text: t('categoryEditor.sections.elements') });
  }
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Surface agent edits to this category's body (ticks + reveal/approve).
  useAgentChangeMarks(scrollEl, 'category', categoryId, isVisible);
  const outlineIds = [...frameworkItems.map((item) => item.id), ...outline.map((heading) => heading.id)];

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!curCategory) return;
      if (action === 'deleteCategory') {
        const confirmed = await requestConfirmation(
          t('categoryEditor.deleteConfirm', { name: curCategory.name }),
        );
        if (!confirmed) return;
        try {
          await categoryUsecases.deleteCategory(curCategory.id);
          leaveDeletedEntity();
        } catch (error) {
          log.error('Failed to delete category:', error);
          alert(t('categoryEditor.alerts.deleteFailed'));
        }
      }
    },
    [curCategory, categoryUsecases, leaveDeletedEntity, t],
  );

  // Pending-action consumer — see NodeEditorView for the queue rationale.
  const pendingEntityAction = useUiStore((s) => s.pendingEntityAction);
  const consumeEntityAction = useUiStore((s) => s.consumeEntityAction);
  useEffect(() => {
    if (!isCommandActive) return;
    if (!curCategory) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('category', curCategory.id);
    if (queued) void handleContextAction(queued);
  }, [
    isCommandActive,
    curCategory,
    pendingEntityAction,
    consumeEntityAction,
    handleContextAction,
  ]);

  if (!curCategory) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'hsl(var(--ink-4))' }}>
        {t('categoryEditor.loading')}
      </div>
    );
  }

  const categoryColor = curCategory.color || 'hsl(var(--accent))';

  return (
    <div className="editor-shell" style={{ height: '100%', position: 'relative' }}>
      <EditorTopBar
        editorType={'category'}
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
          <>
            <span>{t('categoryEditor.meta.elements', { count: cEls.length })}</span>
          </>
        }
      >
        <EditorCrumb
          dotColor={curCategory.color || 'hsl(var(--accent))'}
          dropdown={
            bookElementCategories.length === 0 ? (
              <div className="crumb-dropdown__empty">{t('categoryEditor.empty.noCategories')}</div>
            ) : (
              bookElementCategories.map((cat) => {
                const isActive = cat.id === curCategory.id;
                return (
                  <div
                    key={cat.id}
                    className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                    onClick={() => { if (!isActive) navigateToCategory(cat.id); }}
                  >
                    <span className="crumb-dropdown__dot" style={{ background: cat.color || 'hsl(var(--accent))' }} />
                    <span>{cat.name}</span>
                  </div>
                );
              })
            )
          }
        >
          <span>{curCategory.name}</span>
        </EditorCrumb>
      </EditorTopBar>

      <div className="editor-body">
        <EditorOutlineRail
          title={`${curCategory.name} · OUTLINE`}
          items={frameworkItems}
          scrollspyIds={outlineIds}
          onItemClick={(id) => {
            scrollToOutlineAnchor(id, scrollEl);
          }}
        />
        <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
          <div className="editor__spread">
          <article
            className="page page--entity"
            style={{ ['--c-color' as string]: categoryColor } as React.CSSProperties}
          >
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">{t('categoryEditor.folio')}</span>
              <span className="page__folio-line" style={{ color: categoryColor, fontWeight: 600 }}>
                {curCategory.name}
              </span>
              <span className="page__folio-line">{t('categoryEditor.meta.elements', { count: cEls.length })}</span>
            </div>

            {/* 一 · 概述 */}
            <section id="cat-overview">
              <div className="elem-hero">
                <div
                  className="elem-portrait elem-portrait--category"
                  style={{ ['--c-color' as string]: categoryColor } as React.CSSProperties}
                >
                  <span className="elem-portrait__hint">◆ {curCategory.name}</span>
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
                    placeholder={t('categoryEditor.untitled')}
                  />

                  <div className="elem-hero__facts">
                    <div className="elem-hero__fact-k">{t('categoryEditor.labels.elementCount')}</div>
                    <div className="elem-hero__fact-v">{t('categoryEditor.meta.items', { count: cEls.length })}</div>
                    <div className="elem-hero__fact-k">{t('storylineEditor.labels.color')}</div>
                    <div className="elem-hero__fact-v">
                      <div className="col-pick">
                        {CATEGORY_COLORS.map((c) => (
                          <div
                            key={c}
                            className={`col-pick__sw${c === curCategory.color ? ' col-pick__sw--active' : ''}`}
                            style={{ ['--c' as string]: c } as React.CSSProperties}
                            onClick={() => void commitColor(c)}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* DEFERRED: aliases, description, scope (sentence). Need
                      schema additions before these can render. */}
                </div>
              </div>
            </section>

            {/* 札记 — free-form notes (TipTap body). Leads the sections, right
                under the hero; its H1/H2/H3 headings nest under this anchor in
                the TOC. */}
            <h2 id="cat-scratch" className="page__scene">
              <span className="page__scene-title">{t('categoryEditor.sections.scratch')}</span>
            </h2>
            <div className="elem-body">
              {ydocError ? <EditorDocumentLoadError /> : <EditorContent editor={editor} />}
            </div>

            {/* 元素模版 — TipTap doc seeded into newly-created elements under
                this category. Editing here only affects future elements;
                existing element bodies are untouched. */}
            <h2 id="cat-template" className="page__scene">
              <span className="page__scene-title">{t('categoryEditor.sections.elementTemplate')}</span>
              <span className="page__scene-meta">{t('categoryEditor.meta.elementTemplate')}</span>
            </h2>
            <div className="elem-body">
              <ElementTemplateEditor
                key={curCategory.id}
                templateJson={curCategory.elementTemplateJson}
                onPersist={commitTemplate}
                placeholder={t('categoryEditor.elementTemplatePlaceholder')}
              />
            </div>

            {/* 字段模版 — KV template seeded into new elements under this
                category. Existing elements stay untouched when this changes
                (same contract as the TipTap template above). */}
            <h2 id="cat-template-kv" className="page__scene">
              <span className="page__scene-title">{t('categoryEditor.sections.templateKv')}</span>
              <span className="page__scene-meta">{t('categoryEditor.meta.templateKv')}</span>
            </h2>
            <div className="elem-body">
              <FieldReviewStrip
                changes={fieldReview.templateKvChanges}
                onAccept={fieldReview.accept}
                onReject={fieldReview.reject}
              />
              <KvEditor
                key={`cat-tpl-kv-${curCategory.id}`}
                valueJson={curCategory.elementTemplateKvJson}
                onPersist={commitTemplateKv}
                variant="template"
                suppressKeys={new Set(fieldReview.templateKvChanges.map((c) => c.field?.key ?? ''))}
                emptyHint={t('categoryEditor.empty.noTemplateFields')}
              />
            </div>

            {/* 元素清单 — elements in this category (omitted when none). */}
            {cEls.length > 0 && (
              <>
                <h2 id="cat-elements" className="page__scene">
                  <span className="page__scene-title">{t('categoryEditor.sections.elements')}</span>
                  <span className="page__scene-meta">{t('categoryEditor.meta.items', { count: cEls.length })}</span>
                </h2>

                <div className="mgr-toolbar">
                  <div className="mgr-toolbar__chips">
                    {([
                      ['all',    t('storylineEditor.filters.all'),     cEls.length],
                      ['used',   t('categoryEditor.filters.used'),   usedCount],
                      ['unused', t('categoryEditor.filters.unused'),   cEls.length - usedCount],
                    ] as const).map(([k, label, n]) => (
                      <FilterChip
                        key={k}
                        shape="square"
                        active={elementFilter === k}
                        count={`· ${n}`}
                        onClick={() => setElementFilter(k)}
                      >
                        {label}
                      </FilterChip>
                    ))}
                  </div>
                  {/* DEFERRED: search / sort / batch / + new element */}
                </div>

                <div className="mgr-list">
                  {filteredEls.map((e) => {
                    const role = e.summary || '';
                    return (
                      <div
                        key={e.id}
                        className="mgr-row"
                        style={{ ['--s-color' as string]: categoryColor } as React.CSSProperties}
                        onClick={() => navigateToElement(e.id)}
                      >
                        <div className="mgr-row__status" style={{ background: categoryColor }} />
                        <div className="mgr-row__num">e.{e.id.slice(0, 4)}</div>
                        <div className="mgr-row__body">
                          <div className="mgr-row__title">
                            <span className="mgr-row__title-mark">◆</span>
                            <span>{e.name || t('common.untitled')}</span>
                          </div>
                          <div className={`mgr-row__summary${role ? '' : ' mgr-row__summary--empty'}`}>
                            {role || t('categoryEditor.empty.noRole')}
                          </div>
                        </div>
                        <div className="mgr-row__wc">
                          <span className="mgr-row__wc-v">{role ? '·' : '—'}</span>
                          <span className="mgr-row__wc-k">{t('categoryEditor.labels.role')}</span>
                        </div>
                        <div className="mgr-row__open" title={t('categoryEditor.actions.openElement')}>→</div>
                      </div>
                    );
                  })}
                  {filteredEls.length === 0 && (
                    <div className="mgr-empty">{t('categoryEditor.empty.noFilteredElements')}</div>
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
            targetKind="category"
            targetId={curCategory.id}
            pendingRequest={pendingComment}
            onPendingRequestChange={setPendingComment}
          />
        )}
        <EditorReviewLayer
          projectId={projectId}
          entityType="category"
          id={curCategory.id}
          scrollEl={scrollEl}
          visibleCommentIds={marginNotes ? stickyNoteRail.itemIds : undefined}
        />
      </div>
    </div>
  );
}
