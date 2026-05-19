import { useCallback, useEffect, useMemo, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useParams } from 'react-router-dom';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { useDataStore } from '../store/data-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { EditorOutlinePanel, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { ElementTemplateEditor } from '../components/editor/ElementTemplateEditor';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useEntityEditor } from '../hooks/useEntityEditor';
import { usePromoteCurrentTab } from '../store/ui-store';
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
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required');
  if (!userId) throw new Error('User must be authenticated');

  const { bookElementCategories, bookElements } = useDataStore();
  const { updateElement } = useBookElement({ projectId, userId });
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

  const isReservedCategory = curCategory?.name === 'others';

  // Elements belonging to this category.
  const cEls = useMemo(() => {
    if (!categoryId) return [];
    return bookElements.filter((el) => el.categoryId === categoryId);
  }, [bookElements, categoryId]);

  const [elementFilter, setElementFilter] = useState<ElementFilter>('all');
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
    if (!curCategory || isReservedCategory) return;
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

  // Scratch body (descriptionJson) — TipTap editor for category notes.
  const handlePersist = useCallback(
    (ed: Editor) => {
      if (!curCategory) return;
      const contentJson = JSON.stringify(ed.getJSON());
      if (contentJson === curCategory.descriptionJson) return;
      promoteCurrentTab();
      void categoryUsecases.updateCategory(curCategory.id, { descriptionJson: contentJson });
    },
    [curCategory, categoryUsecases, promoteCurrentTab],
  );
  const { editor, outline } = useEntityEditor({
    sourceKind: 'category',
    sourceId: curCategory?.id ?? '',
    projectId,
    content: curCategory?.descriptionJson ?? null,
    onPersist: handlePersist,
    placeholder: '札记 · scratch——本类目的设计原则、命名约定、AI 候选规则…',
  });

  // Two-block TOC: outer (frameworkItems) = static section anchors —
  // 概述 / 元素模版 / 元素清单 / 札记. Inner (bodyOutlineItems) = headings
  // parsed from the 札记 TipTap body at their natural h1/h2/h3 levels.
  // Rendered as separate groups so the body outline reads as its own
  // hierarchy rather than blurring into the framework.
  const frameworkItems: OutlineEntry[] = [
    { id: 'cat-overview', level: 2, num: '一', text: '概述' },
    { id: 'cat-template', level: 2, num: '二', text: '元素模版' },
  ];
  if (cEls.length > 0) {
    frameworkItems.push({ id: 'cat-elements', level: 2, num: '三', text: '元素清单' });
  }
  frameworkItems.push({
    id: 'cat-scratch',
    level: 2,
    num: cEls.length > 0 ? '四' : '三',
    text: '札记',
  });
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

  const handleContextAction = async (action: string) => {
    if (!curCategory) return;
    if (action === 'deleteCategory') {
      const confirmed = window.confirm(
        `Delete category "${curCategory.name}"?\n\nAll elements in this category will be moved to "others".`,
      );
      if (!confirmed) return;
      try {
        for (const element of cEls) {
          await updateElement(element.id, { categoryId: 'others' });
        }
        await categoryUsecases.deleteCategory(curCategory.id);
        navigateToHome();
      } catch (error) {
        log.error('Failed to delete category:', error);
        alert('Failed to delete category. Please try again.');
      }
    }
  };

  if (!curCategory) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'hsl(var(--ink-4))' }}>
        Loading category…
      </div>
    );
  }

  const categoryColor = curCategory.color || 'hsl(var(--accent))';
  const categoryShortId = curCategory.id.slice(0, 6);

  return (
    <div className="editor-shell" style={{ height: '100%', position: 'relative' }}>
      <EditorTopBar
        editorType="category"
        onMenuAction={handleContextAction}
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
          footLeft={`c.${categoryShortId}`}
          footRight={`${cEls.length} 元素`}
        />
        <div className="editor-scroll" ref={setScrollEl}>
          <div className="editor__spread">
          <article className="page" style={{ ['--c-color' as string]: categoryColor } as React.CSSProperties}>
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Category</span>
              <span className="page__folio-line" style={{ color: categoryColor, fontWeight: 600 }}>
                {curCategory.name}
              </span>
              <span className="page__folio-line">c.{categoryShortId}</span>
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
                    <span>◆ CATEGORY</span>
                    <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
                    <span>c.{categoryShortId}</span>
                  </div>

                  <input
                    type="text"
                    className="elem-hero__name"
                    value={displayedName}
                    disabled={isReservedCategory}
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
                    title={isReservedCategory ? 'Reserved category — cannot rename' : undefined}
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

            {/* 三 · 元素清单 */}
            {cEls.length > 0 && (
              <>
                <h2 id="cat-elements" className="page__scene">
                  <span className="page__scene-num">三</span>
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

            {/* 四 · 札记 — drops to 三 when there are no elements yet, since
                the 元素清单 section above is conditional. */}
            <h2 id="cat-scratch" className="page__scene">
              <span className="page__scene-num">{cEls.length > 0 ? '四' : '三'}</span>
              <span className="page__scene-title">札记 · scratch</span>
            </h2>
            <div className="elem-body">
              <EditorContent editor={editor} />
            </div>
          </article>
          </div>
        </div>
        {/* DEFERRED: right-side margin annotations (no column reserved). */}
      </div>
    </div>
  );
}
