import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useNavigate, useParams } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { EditorOutlinePanel, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { ReferencesPanel } from '../components/editor/ReferencesPanel';
import { PatchesSection } from '../components/editor/PatchesSection';
import loglevel from 'loglevel';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useEntityEditor } from '../hooks/useEntityEditor';
import { usePromoteCurrentTab } from '../store/ui-store';

const log = loglevel.getLogger('ElementEditorView');
log.setLevel(loglevel.levels.ERROR);

export function ElementEditorView() {
  const navigate = useNavigate();
  const { navigateToHome } = useProjectNavigation();
  const { elementId, projectId } = useParams<{ elementId: string; projectId: string }>();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const userId = useAuthStore((state) => state.user?.id);
  const { bookElements, bookElementCategories } = useDataStore();

  const elementUsecases = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { updateElement } = elementUsecases;

  const [editingCategory, setEditingCategory] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [summaryValue, setSummaryValue] = useState('');
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  // Derive curElement from the store at render time. Local edit-state values
  // (nameValue, summaryValue) reset whenever the underlying element id changes
  // via the prev-snapshot pattern below to avoid the "setState in effect"
  // anti-pattern.
  const navigateIfMissingRef = useRef(false);
  useEffect(() => {
    if (!elementId && !navigateIfMissingRef.current) {
      navigateIfMissingRef.current = true;
      navigate('/', { replace: true });
    }
  }, [elementId, navigate]);

  const curElement = elementId ? bookElements.find((e) => e.id === elementId) ?? null : null;
  const [syncedElementKey, setSyncedElementKey] = useState({
    routeId: elementId ?? null,
    entityId: curElement?.id ?? null,
  });
  if (
    syncedElementKey.routeId !== (elementId ?? null) ||
    syncedElementKey.entityId !== (curElement?.id ?? null)
  ) {
    setSyncedElementKey({
      routeId: elementId ?? null,
      entityId: curElement?.id ?? null,
    });
    setNameValue(curElement?.name || '');
    setSummaryValue(curElement?.summary || '');
  }

  const handlePersist = useCallback(
    (ed: Editor) => {
      if (!elementId) return;
      const contentJson = JSON.stringify(ed.getJSON());
      if (contentJson === curElement?.contentJson) return;
      promoteCurrentTab();
      void updateElement(elementId, { contentJson });
    },
    [elementId, curElement?.contentJson, updateElement, promoteCurrentTab],
  );

  const { editor, outline } = useEntityEditor({
    sourceKind: 'element',
    sourceId: curElement?.id ?? '',
    projectId: projectId ?? '',
    content: curElement?.contentJson ?? null,
    onPersist: handlePersist,
    autoFocus: true,
    placeholder: '记 · 传——写此元素的来历、形貌、心性…',
  });

  // Outline = headings extracted live from the body editor. Built before
  // the early return below so the scrollspy hook always runs (Rules of Hooks).
  const outlineItems: OutlineEntry[] = outline.map<OutlineEntry>((h) => ({
    id: h.id,
    level: h.level,
    text: h.text,
  }));
  const activeOutlineId = useOutlineScrollspy(scrollEl, outlineItems.map((i) => i.id));

  const commitName = async () => {
    if (!elementId) return;
    const next = nameValue.trim();
    if (!next || next === curElement?.name) return;
    promoteCurrentTab();
    await updateElement(elementId, { name: next });
  };
  const commitSummary = async () => {
    if (!elementId) return;
    if (summaryValue === curElement?.summary) return;
    promoteCurrentTab();
    await updateElement(elementId, { summary: summaryValue });
  };

  const handleCreateNewCategory = async () => {
    if (!newCategoryName.trim() || !elementId) return;
    const created = await createCategory({ name: newCategoryName.trim() });
    await updateElement(elementId, { categoryId: created.id });
    setShowNewCategoryModal(false);
    setNewCategoryName('');
    setEditingCategory(false);
  };

  const handleContextAction = async (action: string) => {
    if (!elementId || !curElement) return;
    if (action === 'deleteElement') {
      const confirmed = window.confirm(`Delete element "${curElement.name}"?`);
      if (!confirmed) return;
      try {
        await elementUsecases.removeElement(elementId);
        navigateToHome();
      } catch (error) {
        log.error('Failed to delete element:', error);
        alert('Failed to delete element. Please try again.');
      }
    } else if (action === 'categoryPicker') {
      setEditingCategory(true);
    }
  };

  if (!elementId || !curElement) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'hsl(var(--ink-4))',
        }}
      >
        Select an element to edit
      </div>
    );
  }

  const currentCategory = bookElementCategories.find((cat) => cat.id === curElement.categoryId);
  const categoryColor = currentCategory?.color || 'hsl(var(--accent))';
  const elementShortId = curElement.id.slice(0, 6);

  return (
    <div className="editor-shell" style={{ height: '100%', position: 'relative' }}>
      <EditorTopBar editorType="element" onMenuAction={handleContextAction}>
        {currentCategory && (
          <EditorCrumb
            dotColor={currentCategory.color || '#8A2A1E'}
            dropdown={
              bookElementCategories.length === 0 ? (
                <div className="crumb-dropdown__empty">No categories yet</div>
              ) : (
                bookElementCategories.map((cat) => {
                  const isActive = cat.id === currentCategory.id;
                  return (
                    <div
                      key={cat.id}
                      className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                      onClick={() => navigate(`/project/${projectId}/category/${cat.id}`)}
                    >
                      <span
                        className="crumb-dropdown__dot"
                        style={{ background: cat.color || '#8A2A1E' }}
                      />
                      <span>{cat.name}</span>
                    </div>
                  );
                })
              )
            }
          >
            <span>{currentCategory.name}</span>
          </EditorCrumb>
        )}
        <EditorCrumb>
          <span className="editor-crumb-title">{curElement.name || 'Untitled Element'}</span>
        </EditorCrumb>
      </EditorTopBar>

      {/* Spread layout: TOC | element page | (margin annotations — deferred) */}
      <div className="editor-scroll" ref={setScrollEl}>
        <div className="editor__spread">
          <EditorOutlinePanel
            title={`${curElement.name || 'ELEMENT'} · OUTLINE`}
            items={outlineItems}
            activeId={activeOutlineId}
            onItemClick={scrollToOutlineAnchor}
            footLeft={`e.${elementShortId}`}
            emptyHint="— 用 H1 / H2 / H3 标题构建大纲 —"
          />

          <article className="page">
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Element</span>
              {currentCategory && (
                <span className="page__folio-line page__folio-line--accent">{currentCategory.name}</span>
              )}
              <span className="page__folio-line">e.{elementShortId}</span>
            </div>

            <section id="el-overview">
              <div className="elem-hero">
                <div className="elem-portrait" style={{ background: `${categoryColor}` }}>
                  <span className="elem-portrait__hint">
                    {currentCategory ? `${currentCategory.name} · 速写` : '速写'}
                  </span>
                </div>
                <div className="elem-hero__main">
                  <div className="elem-hero__kicker">
                    <span className="elem-hero__kicker-dot" style={{ background: categoryColor }} />
                    <span>◆ {(currentCategory?.name || 'ELEMENT').toUpperCase()}</span>
                    <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
                    <span>e.{elementShortId}</span>
                  </div>

                  <input
                    type="text"
                    className="elem-hero__name"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onBlur={() => void commitName()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                      if (e.key === 'Escape') {
                        setNameValue(curElement.name || '');
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="Untitled Element"
                  />

                  <textarea
                    className="elem-hero__summary"
                    value={summaryValue}
                    onChange={(e) => setSummaryValue(e.target.value)}
                    onBlur={() => void commitSummary()}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setSummaryValue(curElement.summary || '');
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="一句话角色说明…"
                    rows={2}
                  />

                  {/* DEFERRED: KV facts list (alias / 类目 / 生年 / 首次出场 …)
                      Needs schema migration to add typed fields per category, plus
                      a category-level field definition surface (see CategoryEditor
                      § 字段定义 in design). Once implemented, render here. */}
                </div>
              </div>
            </section>

            <h2 id="el-bio" className="page__scene">
              <span className="page__scene-num">二</span>
              <span className="page__scene-title">记 · 传</span>
            </h2>
            <div className="elem-body">
              <EditorContent editor={editor} />
            </div>

            {/* References + patches kept below the main body. These will move
                into the right margin column once the annotation system lands. */}
            {elementId && projectId && (
              <div style={{ marginTop: 32 }}>
                <ReferencesPanel entityKind="element" entityId={elementId} projectId={projectId} />
              </div>
            )}
            {elementId && projectId && (
              <div style={{ marginTop: 16 }}>
                <PatchesSection elementId={elementId} projectId={projectId} />
              </div>
            )}
          </article>

          {/* DEFERRED: right-side margin annotations. */}
          <div className="editor__margin" aria-hidden="true" />
        </div>
      </div>

      {/* Category picker (triggered from 3-dot menu) */}
      {editingCategory && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(28, 24, 19, 0.32)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setEditingCategory(false)}
        >
          <div
            style={{
              background: 'hsl(var(--page))',
              border: '1px solid hsl(var(--rule-strong))',
              borderRadius: 8,
              padding: 24,
              minWidth: 360,
              boxShadow: '0 18px 50px rgba(28, 24, 19, 0.22)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>Change Category</h3>
            <select
              value={curElement.categoryId}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__new__') {
                  setShowNewCategoryModal(true);
                  return;
                }
                void updateElement(elementId, { categoryId: val });
                setEditingCategory(false);
              }}
              autoFocus
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid hsl(var(--rule-strong))',
                borderRadius: 4,
                padding: '8px 12px',
                outline: 'none',
                cursor: 'pointer',
                background: 'hsl(var(--surface))',
              }}
            >
              {bookElementCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
              <option value="__new__">+ New Category</option>
            </select>
          </div>
        </div>
      )}

      {showNewCategoryModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(28, 24, 19, 0.32)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1001,
          }}
          onClick={() => { setShowNewCategoryModal(false); setNewCategoryName(''); setEditingCategory(false); }}
        >
          <div
            style={{
              background: 'hsl(var(--page))',
              border: '1px solid hsl(var(--rule-strong))',
              borderRadius: 8,
              padding: 24,
              minWidth: 360,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>New Category</h3>
            <input
              type="text"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateNewCategory();
                if (e.key === 'Escape') {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                  setEditingCategory(false);
                }
              }}
              placeholder="Category name…"
              autoFocus
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid hsl(var(--rule-strong))',
                borderRadius: 4,
                padding: '8px 12px',
                outline: 'none',
                marginBottom: 16,
                background: 'hsl(var(--surface))',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setShowNewCategoryModal(false); setNewCategoryName(''); setEditingCategory(false); }}
                className="mgr-toolbar__btn"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateNewCategory}
                className="mgr-toolbar__btn mgr-toolbar__btn--accent"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
