import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAutosizeTextArea } from '../hooks/useAutosizeTextArea';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useNavigate, useParams } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { commentBelongsToEntity, commentIdsRelatedToEntity } from '../domain/comment';
import { useSettingsStore } from '../store/settings-store';
import { useBookElement } from '../usecase/useBookElement';
import { ElementNameConflictError } from '../domain/book-element';
import { useElementCategory } from '../usecase/useElementCategory';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { CommentRail } from '../components/editor/CommentRail';
import { EditorReviewLayer } from '../components/editor/EditorReviewLayer';
import { EditorOutlinePanel, nestHeadings, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { KvEditor } from '../components/editor/KvEditor';
import { FieldReview, FieldReviewStrip } from '../components/editor/FieldReview';
import { useFieldReview } from '../hooks/useFieldReview';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useAgentChangeMarks } from '../hooks/useAgentChangeMarks';
import { ReferencesPanel } from '../components/editor/ReferencesPanel';
import { PatchesSection } from '../components/editor/PatchesSection';
import { ArcSection } from '../components/editor/ArcSection';
import { EvolveSection } from '../components/editor/EvolveSection';
import loglevel from 'loglevel';
import { useAuthStore } from '../store/auth';
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

const log = loglevel.getLogger('ElementEditorView');
log.setLevel(loglevel.levels.ERROR);

export function ElementEditorView({
  elementIdOverride,
}: { elementIdOverride?: string } = {}) {
  const navigate = useNavigate();
  const { leaveDeletedEntity } = useProjectNavigation();
  const params = useParams<{ elementId: string; projectId: string }>();
  const projectId = params.projectId;
  const elementId = elementIdOverride ?? params.elementId;
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const canPromoteOnEdit = useCanPromoteOnEdit(elementId);
  const userId = useAuthStore((state) => state.user?.id);
  // Per-slice selectors instead of `useDataStore()` (no selector) so this large
  // view only re-renders when a slice it actually uses changes — not on every
  // unrelated store mutation (storylines, relations, bookNodes, …).
  const bookElements = useDataStore((s) => s.bookElements);
  const bookElementCategories = useDataStore((s) => s.bookElementCategories);
  const comments = useDataStore((s) => s.comments);
  const entityRelations = useDataStore((s) => s.entityRelations);

  const elementUsecases = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { updateElement } = elementUsecases;

  const curElement = elementId ? bookElements.find((e) => e.id === elementId) ?? null : null;

  const [editingCategory, setEditingCategory] = useState(false);
  const [nameValue, setNameValue] = useState(curElement?.name || '');
  const [summaryValue, setSummaryValue] = useState(curElement?.summary || '');
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [pendingComment, setPendingComment] = useState<EditorCommentRequest | null>(null);
  // Clear the cell's "M" once the user opens this element (coarse — element
  // writes arrive as structural changes; see useAgentChangeMarks).
  useAgentChangeMarks(scrollEl, 'element', elementId);
  const [marginNotes, setMarginNotes] = useEntityMarginNotes('element', elementId);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const setEntityLinkInteractive = useSettingsStore((state) => state.setEntityLinkInteractive);
  const toggleEntityLinkInteractive = useCallback(
    () => setEntityLinkInteractive(!entityLinkInteractive),
    [entityLinkInteractive, setEntityLinkInteractive],
  );

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

  // Counts via target_* OR a relation edge, so the rail opens for relation-only
  // notes too (mirrors CommentRail's loose filter).
  const relatedCommentIds = useMemo(
    () => commentIdsRelatedToEntity(entityRelations, projectId ?? '', 'element', elementId ?? ''),
    [entityRelations, projectId, elementId],
  );
  const commentCount = useMemo(
    () =>
      comments.filter(
        (comment) =>
          comment.projectId === (projectId ?? '') &&
          comment.status !== 'converted' &&
          commentBelongsToEntity(comment, 'element', elementId ?? '', relatedCommentIds),
      ).length,
    [elementId, comments, projectId, relatedCommentIds],
  );
  const toggleComments = useCallback(() => {
    // The rail can always be toggled — with no comments it just shows an empty
    // column, so the user can open it to add the first note.
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

  const { ydoc } = useEntityYjsDoc({
    kind: 'element',
    entityId: curElement?.id ?? '',
    projectId: projectId ?? '',
    legacyContent: curElement?.contentJson ?? null,
  });

  const handlePersist = useCallback(
    (_ed: Editor, { pmJson }: EditorPersistDerived) => {
      if (!elementId) return;
      if (pmJson === curElement?.contentJson) return;
      if (canPromoteOnEdit()) promoteCurrentTab();
      void updateElement(elementId, { contentJson: pmJson });
    },
    [elementId, curElement?.contentJson, canPromoteOnEdit, updateElement, promoteCurrentTab],
  );

  const { editor, outline } = useEntityEditor({
    sourceKind: 'element',
    sourceId: curElement?.id ?? '',
    projectId: projectId ?? '',
    content: curElement?.contentJson ?? null,
    ydoc,
    onPersist: handlePersist,
    placeholder: '故事发生时，这个元素是什么？',
    onAddCommentRequest: handleAddCommentRequest,
    selectionKey:
      projectId && curElement
        ? editorTabSelectionKey(projectId, { entityType: 'element', id: curElement.id })
        : null,
  });

  // Outline = framework anchors (overview / 字段 / 传) plus headings
  // extracted live from the body editor. Built before the early return below
  // so the scrollspy hook always runs (Rules of Hooks).
  const frameworkItems: OutlineEntry[] = [
    { id: 'el-overview', level: 2, kind: 'section', num: '一', text: '概述' },
    { id: 'el-kv', level: 2, kind: 'section', num: '二', text: '字段 · facts' },
    { id: 'el-bio', level: 2, kind: 'section', num: '三', text: '传 · biography' },
  ];
  const bodyOutlineItems: OutlineEntry[] = nestHeadings(outline);
  // Scrollspy needs the FLAT id list (framework anchors + every heading),
  // not just the nested tree's roots.
  const outlineIds = [...frameworkItems.map((i) => i.id), ...outline.map((h) => h.id)];
  const activeOutlineId = useOutlineScrollspy(scrollEl, outlineIds);

  const commitName = async () => {
    if (!elementId) return;
    const next = nameValue.trim();
    if (!next || next === curElement?.name) return;
    promoteCurrentTab();
    try {
      await updateElement(elementId, { name: next });
    } catch (err) {
      if (err instanceof ElementNameConflictError) {
        alert(
          `无法重命名："${next}" 已被元素「${err.conflictingElement.name}」使用（名字或别名冲突）。`,
        );
        setNameValue(curElement?.name ?? '');
        return;
      }
      throw err;
    }
  };

  // Aliases editor — chip list + inline draft input. Conflict surfacing
  // mirrors commitName: ElementNameConflictError → alert + abort.
  const [aliasDraft, setAliasDraft] = useState('');
  const writeAliases = async (next: string[]) => {
    if (!elementId) return;
    promoteCurrentTab();
    try {
      await updateElement(elementId, { aliases: next });
    } catch (err) {
      if (err instanceof ElementNameConflictError) {
        alert(
          `无法添加别名："${err.conflictingName}" 已被元素「${err.conflictingElement.name}」使用。`,
        );
        return;
      }
      throw err;
    }
  };
  const addAlias = async () => {
    const trimmed = aliasDraft.trim();
    setAliasDraft('');
    if (!trimmed || !curElement) return;
    // Idempotent local check — don't bother round-tripping if it's already in
    // this element's own list (the project-wide uniqueness check would not
    // catch self-overlap because we exclude self in the conflict scan).
    if (curElement.aliases.some((a) => a.trim().toLowerCase() === trimmed.toLowerCase())) {
      return;
    }
    await writeAliases([...curElement.aliases, trimmed]);
  };
  const removeAlias = async (idx: number) => {
    if (!curElement) return;
    const next = curElement.aliases.filter((_, i) => i !== idx);
    await writeAliases(next);
  };
  // 概要 textarea 自动增高，去掉固定 rows 的裁切
  const summaryRef = useAutosizeTextArea(summaryValue);

  const commitSummary = async () => {
    if (!elementId) return;
    if (summaryValue === curElement?.summary) return;
    promoteCurrentTab();
    await updateElement(elementId, { summary: summaryValue });
  };

  const commitKv = useCallback(
    (nextJson: string) => {
      if (!elementId || nextJson === curElement?.kvJson) return;
      promoteCurrentTab();
      void updateElement(elementId, { kvJson: nextJson });
    },
    [elementId, curElement?.kvJson, updateElement, promoteCurrentTab],
  );

  // Review of the agent's non-prose field edits (summary + kv). Reject writes the
  // old value back through the same usecase as a manual edit.
  const fieldReview = useFieldReview(
    'element',
    elementId,
    projectId ?? '',
    { kvJson: curElement?.kvJson },
    {
      summary: (v) => {
        if (elementId) void updateElement(elementId, { summary: v });
      },
      kvJson: (v) => {
        if (elementId) void updateElement(elementId, { kvJson: v });
      },
    },
  );

  const handleCreateNewCategory = async () => {
    if (!newCategoryName.trim() || !elementId) return;
    const created = await createCategory({ name: newCategoryName.trim() });
    await updateElement(elementId, { categoryId: created.id });
    setShowNewCategoryModal(false);
    setNewCategoryName('');
    setEditingCategory(false);
  };

  const applyGroup = async (nextGroup: string | null) => {
    setShowGroupModal(false);
    if (!elementId || !curElement) return;
    if (nextGroup === (curElement.groupName ?? null)) return;
    try {
      await updateElement(elementId, { groupName: nextGroup });
    } catch (error) {
      log.error('Failed to update group:', error);
      alert('Failed to update group. Please try again.');
    }
  };

  const handleSaveGroup = () => {
    const trimmed = groupNameInput.trim();
    void applyGroup(trimmed === '' ? null : trimmed);
  };

  // All distinct groupNames currently used by elements in this element's
  // category — drives the combobox list in the group modal.
  const groupOptions = useMemo(() => {
    if (!curElement) return [];
    const categoryId = curElement.categoryId;
    const names = new Set<string>();
    bookElements.forEach((el) => {
      if (el.categoryId !== categoryId) return;
      if (!el.groupName) return;
      names.add(el.groupName);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [bookElements, curElement]);
  const groupQuery = groupNameInput.trim();
  const filteredGroups = useMemo(() => {
    if (!groupQuery) return groupOptions;
    const q = groupQuery.toLowerCase();
    return groupOptions.filter((g) => g.toLowerCase().includes(q));
  }, [groupOptions, groupQuery]);
  const groupQueryIsExisting = groupQuery !== '' && groupOptions.includes(groupQuery);

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!elementId || !curElement) return;
      if (action === 'deleteElement') {
        const confirmed = window.confirm(`Delete element "${curElement.name}"?`);
        if (!confirmed) return;
        try {
          await elementUsecases.removeElement(elementId);
          leaveDeletedEntity();
        } catch (error) {
          log.error('Failed to delete element:', error);
          alert('Failed to delete element. Please try again.');
        }
      } else if (action === 'categoryPicker') {
        setEditingCategory(true);
      } else if (action === 'groupPicker') {
        setGroupNameInput('');
        setShowGroupModal(true);
      }
    },
    [elementId, curElement, elementUsecases, leaveDeletedEntity, updateElement],
  );

  // Pending-action consumer — see NodeEditorView for the queue rationale.
  const pendingEntityAction = useUiStore((s) => s.pendingEntityAction);
  const consumeEntityAction = useUiStore((s) => s.consumeEntityAction);
  useEffect(() => {
    if (!elementId || !curElement) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('element', elementId);
    if (queued) void handleContextAction(queued);
  }, [
    elementId,
    curElement,
    pendingEntityAction,
    consumeEntityAction,
    handleContextAction,
  ]);

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
  // Element's summary buffer is local + only re-seeds on id change, so sync it
  // explicitly when a summary review resolves (accept → new, reject → old).
  const summaryReviewChange = fieldReview.summaryChange;

  return (
    <div className="editor-shell" style={{ height: '100%', position: 'relative' }}>
      <EditorTopBar
        editorType="element"
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
      >
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

      {/* Editor body: TOC sits OUTSIDE the scroll container as a layout
          sibling — stays put without relying on position:sticky. */}
      <div className="editor-body">
        <EditorOutlinePanel
          title={`${curElement.name || 'ELEMENT'} · OUTLINE`}
          items={frameworkItems}
          secondaryItems={bodyOutlineItems}
          activeId={activeOutlineId}
          onItemClick={(id) => scrollToOutlineAnchor(id, scrollEl)}
          emptyHint="— 用 H1 / H2 / H3 标题构建大纲 —"
        />
        <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
          <div className="editor__spread">
          <article className="page">
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Element</span>
              {currentCategory && (
                <span className="page__folio-line page__folio-line--accent">{currentCategory.name}</span>
              )}
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
                    <span>{(currentCategory?.name || 'ELEMENT').toUpperCase()}</span>
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

                  {/* Aliases chip-list. Inline-styled for now; promote to
                      a proper class in styles/index.css once the visual
                      treatment stabilizes. The styling is intentionally
                      muted — aliases are metadata, not titles. */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      marginTop: 4,
                      marginBottom: 8,
                      alignItems: 'center',
                    }}
                  >
                    {curElement.aliases.map((alias, idx) => (
                      <span
                        key={`${alias}-${idx}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: 'hsl(var(--surface-elev, var(--surface)))',
                          border: '1px solid hsl(var(--rule))',
                          fontFamily: 'var(--font-serif)',
                          fontStyle: 'italic',
                          fontSize: 12,
                          color: 'hsl(var(--ink-2))',
                        }}
                      >
                        {alias}
                        <button
                          type="button"
                          onClick={() => void removeAlias(idx)}
                          title="移除别名"
                          style={{
                            background: 'transparent',
                            border: 0,
                            padding: 0,
                            color: 'hsl(var(--ink-4))',
                            cursor: 'pointer',
                            fontSize: 13,
                            lineHeight: 1,
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={aliasDraft}
                      onChange={(e) => setAliasDraft(e.target.value)}
                      onBlur={() => void addAlias()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void addAlias();
                        }
                        if (e.key === 'Escape') {
                          setAliasDraft('');
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder={curElement.aliases.length === 0 ? '+ 添加别名' : '+ 别名'}
                      style={{
                        background: 'transparent',
                        border: 0,
                        outline: 0,
                        padding: '2px 4px',
                        fontFamily: 'var(--font-serif)',
                        fontStyle: 'italic',
                        fontSize: 12,
                        color: 'hsl(var(--ink-3))',
                        minWidth: 80,
                      }}
                    />
                  </div>

                  {summaryReviewChange ? (
                    <FieldReview
                      change={summaryReviewChange}
                      onAccept={() => {
                        fieldReview.accept(summaryReviewChange);
                        setSummaryValue(summaryReviewChange.newText);
                      }}
                      onReject={() => {
                        fieldReview.reject(summaryReviewChange);
                        setSummaryValue(summaryReviewChange.oldText);
                      }}
                    />
                  ) : (
                    <textarea
                      ref={summaryRef}
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
                      rows={1}
                    />
                  )}

                  {/* DEFERRED: KV facts list (alias / 类目 / 生年 / 首次出场 …)
                      Needs schema migration to add typed fields per category, plus
                      a category-level field definition surface (see CategoryEditor
                      § 字段定义 in design). Once implemented, render here. */}
                </div>
              </div>
            </section>

            {/* 二 · 字段 — element's own KV facts. Seeded at creation
                from the category's elementTemplateKvJson; owned thereafter. */}
            <h2 id="el-kv" className="page__scene">
              <span className="page__scene-num">二</span>
              <span className="page__scene-title">字段 · facts</span>
              <span className="page__scene-meta">alias / 类目 / 生年 / 首次出场 …</span>
            </h2>
            <div className="elem-body">
              <FieldReviewStrip
                changes={fieldReview.kvChanges}
                onAccept={fieldReview.accept}
                onReject={fieldReview.reject}
              />
              <KvEditor
                key={`el-kv-${curElement.id}`}
                valueJson={curElement.kvJson}
                onPersist={commitKv}
                suppressKeys={new Set(fieldReview.kvChanges.map((c) => c.field?.key ?? ''))}
                emptyHint="— 尚无字段。新建元素时若类目模版已定义，会自动填充 —"
              />
            </div>

            <h2 id="el-bio" className="page__scene">
              <span className="page__scene-num">三</span>
              <span className="page__scene-title">记 · 传</span>
            </h2>
            <div className="elem-body">
              <EditorContent editor={editor} />
            </div>

            {/* Manual relations stay in the body (they're authored here, with
                the link picker); 被引用/引用其他 are read-only projections and
                live in the right sidebar's stats panel instead. */}
            {elementId && projectId && (
              <ReferencesPanel
                entityKind="element"
                entityId={elementId}
                projectId={projectId}
                sections={['relations']}
                numStart={4}
              />
            )}
            {elementId && projectId && (
              <PatchesSection elementId={elementId} projectId={projectId} />
            )}
            {elementId && projectId && (
              <ArcSection elementId={elementId} projectId={projectId} />
            )}
            {elementId && projectId && (
              <EvolveSection elementId={elementId} projectId={projectId} />
            )}
          </article>
          {marginNotes && (
            <CommentRail
              projectId={projectId ?? curElement.projectId}
              targetKind="element"
              targetId={elementId}
              scrollEl={scrollEl}
              pendingRequest={pendingComment}
              onPendingRequestChange={setPendingComment}
            />
          )}
          </div>
        </div>
        <EditorReviewLayer
          projectId={projectId ?? curElement.projectId}
          entityType="element"
          id={elementId}
          scrollEl={scrollEl}
          commentsVisible={marginNotes}
        />
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
              value={curElement.categoryId ?? ''}
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

      {showGroupModal && (
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
          onClick={() => setShowGroupModal(false)}
        >
          <div
            style={{
              background: 'hsl(var(--page))',
              border: '1px solid hsl(var(--rule-strong))',
              borderRadius: 8,
              padding: 20,
              minWidth: 360,
              maxWidth: 420,
              boxShadow: '0 18px 50px rgba(28, 24, 19, 0.22)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
              分组 · {currentCategory?.name ?? '未分类'}
            </h3>
            <input
              type="text"
              value={groupNameInput}
              onChange={(e) => setGroupNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSaveGroup();
                }
                if (e.key === 'Escape') setShowGroupModal(false);
              }}
              placeholder="搜索或新建分组…（留空 = 不分组）"
              autoFocus
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid hsl(var(--rule-strong))',
                borderRadius: 4,
                padding: '8px 12px',
                outline: 'none',
                marginBottom: 12,
                background: 'hsl(var(--surface))',
              }}
            />
            <div
              style={{
                maxHeight: 240,
                overflowY: 'auto',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 4,
                background: 'hsl(var(--surface))',
                marginBottom: 12,
              }}
            >
              <button
                type="button"
                onClick={() => void applyGroup(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  background: curElement.groupName == null ? 'hsl(var(--accent) / 0.12)' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid hsl(var(--rule))',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'hsl(var(--ink-3))',
                  fontStyle: 'italic',
                }}
              >
                （不分组）
              </button>
              {filteredGroups.length === 0 && groupQuery === '' && (
                <div style={{ padding: '12px', fontSize: 13, color: 'hsl(var(--ink-4))' }}>
                  此类目下还没有分组。
                </div>
              )}
              {filteredGroups.map((name) => {
                const isCurrent = name === curElement.groupName;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => void applyGroup(name)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      background: isCurrent ? 'hsl(var(--accent) / 0.12)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid hsl(var(--rule))',
                      cursor: 'pointer',
                      fontSize: 14,
                    }}
                  >
                    {name}
                  </button>
                );
              })}
              {groupQuery !== '' && !groupQueryIsExisting && (
                <button
                  type="button"
                  onClick={() => void applyGroup(groupQuery)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 14,
                    color: 'hsl(var(--accent))',
                  }}
                >
                  ＋ 新建分组「{groupQuery}」
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setShowGroupModal(false)}
                className="mgr-toolbar__btn"
              >
                Cancel
              </button>
            </div>
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
