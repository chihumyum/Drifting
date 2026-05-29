import { useCallback, useEffect, useMemo, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useParams } from 'react-router-dom';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { CommentRail } from '../components/editor/CommentRail';
import { EditorOutlinePanel, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { ElementTemplateEditor } from '../components/editor/ElementTemplateEditor';
import { KvEditor } from '../components/editor/KvEditor';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import {
  useEntityEditor,
  type EditorCommentRequest,
  type EditorPersistDerived,
} from '../hooks/useEntityEditor';
import { useEntityYjsDoc } from '../hooks/useEntityYjsDoc';
import { useEntityMarginNotes } from '../hooks/useEntityMarginNotes';
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
  const params = useParams<{ projectId: string; categoryId: string }>();
  const projectId = params.projectId;
  const categoryId = categoryIdOverride ?? params.categoryId;
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const canPromoteOnEdit = useCanPromoteOnEdit(categoryId);
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required');
  if (!userId) throw new Error('User must be authenticated');

  const { bookElementCategories, bookElements, comments } = useDataStore();
  useBookElement({ projectId, userId });
  const categoryUsecases = useElementCategory({ projectId, userId });
  const { navigateToHome, navigateToElement, navigateToCategory } = useProjectNavigation();

  // Redirect if category param is missing.
  useEffect(() => {
    if (!categoryId) navigateToHome();
  }, [categoryId, navigateToHome]);

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
  const [marginNotes, setMarginNotes] = useEntityMarginNotes('category', categoryId);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const setEntityLinkInteractive = useSettingsStore((state) => state.setEntityLinkInteractive);
  const toggleEntityLinkInteractive = useCallback(
    () => setEntityLinkInteractive(!entityLinkInteractive),
    [entityLinkInteractive, setEntityLinkInteractive],
  );
  const commentCount = useMemo(
    () =>
      comments.filter(
        (comment) =>
          comment.projectId === projectId &&
          comment.targetKind === 'category' &&
          comment.targetId === (categoryId ?? '') &&
          comment.status !== 'converted',
      ).length,
    [categoryId, comments, projectId],
  );
  const toggleComments = useCallback(() => {
    if (!marginNotes && commentCount === 0) return;
    const next = !marginNotes;
    setMarginNotes(next);
    if (!next) setPendingComment(null);
  }, [commentCount, marginNotes, setMarginNotes]);
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

  const { ydoc } = useEntityYjsDoc({
    kind: 'category',
    entityId: curCategory?.id ?? '',
    projectId,
    legacyContent: curCategory?.contentJson ?? null,
  });

  // Scratch body (contentJson) — TipTap editor for category notes.
  const handlePersist = useCallback(
    (_ed: Editor, { pmJson }: EditorPersistDerived) => {
      if (!curCategory) return;
      if (pmJson === curCategory.contentJson) return;
      if (canPromoteOnEdit()) promoteCurrentTab();
      void categoryUsecases.updateCategory(curCategory.id, { contentJson: pmJson });
    },
    [curCategory, canPromoteOnEdit, categoryUsecases, promoteCurrentTab],
  );
  const { editor, outline } = useEntityEditor({
    sourceKind: 'category',
    sourceId: curCategory?.id ?? '',
    projectId,
    content: curCategory?.contentJson ?? null,
    ydoc,
    onPersist: handlePersist,
    placeholder: '札记 · scratch——本类目的设计原则、命名约定、AI 候选规则…',
    onAddCommentRequest: handleAddCommentRequest,
    selectionKey: curCategory
      ? editorTabSelectionKey(projectId, { entityType: 'category', id: curCategory.id })
      : null,
  });

  // Two-block TOC: outer (frameworkItems) = static section anchors —
  // 概述 / 元素模版 / 元素清单 / 札记. Inner (bodyOutlineItems) = headings
  // parsed from the 札记 TipTap body at their natural h1/h2/h3 levels.
  // Rendered as separate groups so the body outline reads as its own
  // hierarchy rather than blurring into the framework.
  const CN_NUMS = ['一', '二', '三', '四', '五'] as const;
  const cnums = [...CN_NUMS];
  const sections: { id: string; text: string }[] = [
    { id: 'cat-overview', text: '概述' },
    { id: 'cat-template', text: '元素模版' },
    { id: 'cat-template-kv', text: '字段模版 · template kv' },
  ];
  if (cEls.length > 0) {
    sections.push({ id: 'cat-elements', text: '元素清单' });
  }
  sections.push({ id: 'cat-scratch', text: '札记' });
  const frameworkItems: OutlineEntry[] = sections.map((s, i) => ({
    id: s.id,
    level: 2,
    num: cnums[i],
    text: s.text,
  }));
  const bodyOutlineItems: OutlineEntry[] = outline.map<OutlineEntry>((h) => ({
    id: h.id,
    level: h.level,
    text: h.text,
  }));
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const activeOutlineId = useOutlineScrollspy(
    scrollEl,
    [...frameworkItems, ...bodyOutlineItems].map((i) => i.id),
  );

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!curCategory) return;
      if (action === 'deleteCategory') {
        const confirmed = window.confirm(
          `Delete category "${curCategory.name}"?\n\nElements in this category will move to "未分类" (their categoryId becomes empty).`,
        );
        if (!confirmed) return;
        try {
          await categoryUsecases.deleteCategory(curCategory.id);
          navigateToHome();
        } catch (error) {
          log.error('Failed to delete category:', error);
          alert('Failed to delete category. Please try again.');
        }
      }
    },
    [curCategory, categoryUsecases, navigateToHome],
  );

  // Pending-action consumer — see NodeEditorView for the queue rationale.
  const pendingEntityAction = useUiStore((s) => s.pendingEntityAction);
  const consumeEntityAction = useUiStore((s) => s.consumeEntityAction);
  useEffect(() => {
    if (!curCategory) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('category', curCategory.id);
    if (queued) void handleContextAction(queued);
  }, [curCategory, pendingEntityAction, consumeEntityAction, handleContextAction]);

  if (!curCategory) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'hsl(var(--ink-4))' }}>
        Loading category…
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
          disabled: !marginNotes && commentCount === 0,
          onToggle: toggleComments,
        }}
        right={
          <>
            <span>{cEls.length} 元素</span>
          </>
        }
      >
        <EditorCrumb
          dotColor={curCategory.color || '#8A2A1E'}
          dropdown={
            bookElementCategories.length === 0 ? (
              <div className="crumb-dropdown__empty">No categories yet</div>
            ) : (
              bookElementCategories.map((cat) => {
                const isActive = cat.id === curCategory.id;
                return (
                  <div
                    key={cat.id}
                    className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                    onClick={() => { if (!isActive) navigateToCategory(cat.id); }}
                  >
                    <span className="crumb-dropdown__dot" style={{ background: cat.color || '#8A2A1E' }} />
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
        <EditorOutlinePanel
          title={`${curCategory.name} · OUTLINE`}
          items={frameworkItems}
          secondaryItems={bodyOutlineItems}
          activeId={activeOutlineId}
          onItemClick={(id) => scrollToOutlineAnchor(id, scrollEl)}
          footRight={`${cEls.length} 元素`}
        />
        <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
          <div className="editor__spread">
          <article className="page" style={{ ['--c-color' as string]: categoryColor } as React.CSSProperties}>
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Category</span>
              <span className="page__folio-line" style={{ color: categoryColor, fontWeight: 600 }}>
                {curCategory.name}
              </span>
              <span className="page__folio-line">{cEls.length} 元素</span>
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
                  <div className="elem-hero__kicker">
                    <span className="elem-hero__kicker-dot" style={{ background: categoryColor }} />
                    <span>CATEGORY</span>
                  </div>

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
                    placeholder="Untitled category"
                  />

                  <div className="elem-hero__facts">
                    <div className="elem-hero__fact-k">元素数</div>
                    <div className="elem-hero__fact-v">{cEls.length} 个</div>
                    <div className="elem-hero__fact-k">色标</div>
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

            {/* 二 · 元素模版 — TipTap doc seeded into newly-created elements
                under this category. Editing here only affects future elements;
                existing element bodies are untouched. */}
            <h2 id="cat-template" className="page__scene">
              <span className="page__scene-num">二</span>
              <span className="page__scene-title">元素模版 · template</span>
              <span className="page__scene-meta">新元素的默认骨架</span>
            </h2>
            <div className="elem-body">
              <ElementTemplateEditor
                key={curCategory.id}
                templateJson={curCategory.elementTemplateJson}
                onPersist={commitTemplate}
                placeholder="用 H1 / H2 / H3 写一份默认的元素骨架，新建元素时自动填充…"
              />
            </div>

            {/* 三 · 字段模版 — KV template seeded into new elements under
                this category. Existing elements stay untouched when this
                changes (same contract as the TipTap template above). */}
            <h2 id="cat-template-kv" className="page__scene">
              <span className="page__scene-num">三</span>
              <span className="page__scene-title">字段模版 · template kv</span>
              <span className="page__scene-meta">新元素的默认字段</span>
            </h2>
            <div className="elem-body">
              <KvEditor
                key={`cat-tpl-kv-${curCategory.id}`}
                valueJson={curCategory.elementTemplateKvJson}
                onPersist={commitTemplateKv}
                variant="template"
                emptyHint="— 尚未定义模版字段。可添加如 别名 / 阵营 / 首次出场 等键名 —"
              />
            </div>

            {/* 四 · 元素清单 */}
            {cEls.length > 0 && (
              <>
                <h2 id="cat-elements" className="page__scene">
                  <span className="page__scene-num">四</span>
                  <span className="page__scene-title">元素清单</span>
                  <span className="page__scene-meta">{cEls.length} 个</span>
                </h2>

                <div className="mgr-toolbar">
                  <div className="mgr-toolbar__chips">
                    {([
                      ['all',    '全部',     cEls.length],
                      ['used',   '已填写',   usedCount],
                      ['unused', '未填写',   cEls.length - usedCount],
                    ] as const).map(([k, label, n]) => (
                      <div
                        key={k}
                        className={`mgr-toolbar__chip${elementFilter === k ? ' mgr-toolbar__chip--active' : ''}`}
                        onClick={() => setElementFilter(k)}
                      >
                        <span>{label}</span>
                        <em>· {n}</em>
                      </div>
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
                            <span>{e.name || 'Untitled'}</span>
                          </div>
                          <div className={`mgr-row__summary${role ? '' : ' mgr-row__summary--empty'}`}>
                            {role || '— 尚未填写一句话角色 —'}
                          </div>
                        </div>
                        <div className="mgr-row__wc">
                          <span className="mgr-row__wc-v">{role ? '·' : '—'}</span>
                          <span className="mgr-row__wc-k">role</span>
                        </div>
                        <div className="mgr-row__open" title="打开元素">→</div>
                      </div>
                    );
                  })}
                  {filteredEls.length === 0 && (
                    <div className="mgr-empty">— 此筛选下暂无元素 —</div>
                  )}
                </div>
              </>
            )}

            {/* 札记 — drops one ordinal when there are no elements, since
                the 元素清单 section above is conditional. */}
            <h2 id="cat-scratch" className="page__scene">
              <span className="page__scene-num">{cEls.length > 0 ? '五' : '四'}</span>
              <span className="page__scene-title">札记 · scratch</span>
            </h2>
            <div className="elem-body">
              <EditorContent editor={editor} />
            </div>
          </article>
          {marginNotes && (
            <CommentRail
              projectId={projectId}
              targetKind="category"
              targetId={curCategory.id}
              scrollEl={scrollEl}
              pendingRequest={pendingComment}
              onPendingRequestChange={setPendingComment}
            />
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
