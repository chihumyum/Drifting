import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutosizeTextArea } from '../hooks/useAutosizeTextArea';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { requestConfirmation } from '../store/confirmation-store';
import { useSettingsStore } from '../store/settings-store';
import { useBookElement } from '../usecase/useBookElement';
import { ElementNameConflictError } from '../domain/book-element';
import { useElementCategory } from '../usecase/useElementCategory';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { DesktopStickyNoteRail as StickyNoteRail } from '../features/comments/desktop/DesktopStickyNoteRail';
import { EditorReviewLayer } from '../components/editor/EditorReviewLayer';
import {
  useEditorSurfaceLifecycle,
  useReportEditorSurfaceReady,
} from '../components/editor/editor-surface-lifecycle-context';
import { EditorOutlineRail } from '../components/editor/EditorOutlineRail';
import { nestHeadings, type OutlineEntry } from '../components/editor/outline-rail-model';
import { KvEditor } from '../components/editor/KvEditor';
import { FieldReview, FieldReviewStrip } from '../components/editor/FieldReview';
import { useFieldReview } from '../hooks/useFieldReview';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useAgentChangeMarks } from '../hooks/useAgentChangeMarks';
import { ReferencesPanel } from '../components/editor/ReferencesPanel';
import { PatchesSection } from '../components/editor/PatchesSection';
import { LibraryItemFullscreenPreview } from '../components/rightBars/MemoMaterialPanel';
import loglevel from 'loglevel';
import { useAuthStore } from '../store/auth';
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
import { assetStoreService } from '../services/asset-store.service';
import type { LibraryItem } from '../domain/library-item';
import { platform } from '../platform';
import { Button } from '../components/ui/Button';
import {
  ModalActions,
  ModalBody,
  ModalCard,
  ModalHeader,
  ModalRoot,
} from '../components/ui/Modal';

const log = loglevel.getLogger('ElementEditorView');
log.setLevel(loglevel.levels.ERROR);

export function ElementEditorView({ elementIdOverride }: { elementIdOverride?: string } = {}) {
  const { t } = useTranslation();
  const { isCommandActive, isVisible } = useEditorSurfaceLifecycle();
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
  const projectAssets = useDataStore((s) => s.projectAssets);
  const elementUsecases = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { updateElement } = elementUsecases;

  const curElement = elementId ? (bookElements.find((e) => e.id === elementId) ?? null) : null;
  const portraitAssetId = curElement?.portraitAssetId ?? null;
  const portraitAsset = useMemo(() => {
    if (!portraitAssetId) return null;
    return projectAssets.find((asset) => asset.id === portraitAssetId) ?? null;
  }, [portraitAssetId, projectAssets]);
  const readyPortraitAssetId = portraitAsset?.id ?? null;

  const [editingCategory, setEditingCategory] = useState(false);
  const [nameValue, setNameValue] = useState(curElement?.name || '');
  const [summaryValue, setSummaryValue] = useState(curElement?.summary || '');
  const [nameDirty, setNameDirty] = useState(false);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [pendingComment, setPendingComment] = useState<EditorCommentRequest | null>(null);
  const [portraitUrlByAssetId, setPortraitUrlByAssetId] = useState<Record<string, string>>({});
  const [portraitPickerBusy, setPortraitPickerBusy] = useState(false);
  const [portraitPreviewOpen, setPortraitPreviewOpen] = useState(false);
  const [portraitErrorState, setPortraitErrorState] = useState<{
    elementId: string | null;
    assetId: string | null;
    message: string;
  } | null>(null);
  const portraitUrl = readyPortraitAssetId
    ? (portraitUrlByAssetId[readyPortraitAssetId] ?? null)
    : null;
  const portraitHasImageSlot = !!readyPortraitAssetId;
  const portraitBusy = portraitPickerBusy;
  const portraitSurfaceLabel = portraitUrl
    ? t('elementEditor.portrait.view')
    : portraitHasImageSlot
      ? t('elementEditor.portrait.loading')
      : t('elementEditor.portrait.import');
  const portraitError =
    portraitErrorState?.elementId === (elementId ?? null) &&
    portraitErrorState.assetId === portraitAssetId
      ? portraitErrorState.message
      : null;
  const portraitPreviewMaterial = useMemo<LibraryItem | null>(() => {
    if (!projectId || !curElement || !portraitAsset || !portraitUrl) return null;
    const now = portraitAsset.createdAt || '1970-01-01T00:00:00.000Z';
    return {
      id: portraitAsset.id,
      projectId,
      title: curElement.name || t('elementEditor.untitled'),
      kind: 'image',
      assetId: portraitAsset.id,
      externalUrl: null,
      bodyJson: null,
      notesJson: null,
      previewImageUrl: null,
      orderKey: 0,
      createdAt: portraitAsset.createdAt || now,
      updatedAt: now,
    };
  }, [projectId, curElement, portraitAsset, portraitUrl, t]);
  // Clear the cell's "M" once the user opens this element (coarse — element
  // writes arrive as structural changes; see useAgentChangeMarks).
  useAgentChangeMarks(scrollEl, 'element', elementId, isVisible);
  const stickyNoteRail = useEntityStickyNoteRail('element', elementId);
  const marginNotes = stickyNoteRail.visible;
  const setMarginNotes = stickyNoteRail.setVisible;
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
  const [syncedElementKey, setSyncedElementKey] = useState({
    routeId: elementId ?? null,
    entityId: curElement?.id ?? null,
    name: curElement?.name ?? '',
    summary: curElement?.summary ?? '',
  });
  if (
    syncedElementKey.routeId !== (elementId ?? null) ||
    syncedElementKey.entityId !== (curElement?.id ?? null) ||
    syncedElementKey.name !== (curElement?.name ?? '') ||
    syncedElementKey.summary !== (curElement?.summary ?? '')
  ) {
    const entityChanged =
      syncedElementKey.routeId !== (elementId ?? null) ||
      syncedElementKey.entityId !== (curElement?.id ?? null);
    setSyncedElementKey({
      routeId: elementId ?? null,
      entityId: curElement?.id ?? null,
      name: curElement?.name ?? '',
      summary: curElement?.summary ?? '',
    });
    if (entityChanged || !nameDirty) {
      setNameDirty(false);
      setNameValue(curElement?.name || '');
    }
    if (entityChanged || !summaryDirty) {
      setSummaryDirty(false);
      setSummaryValue(curElement?.summary || '');
    }
  }

  const { ydoc, ydocError } = useEntityYjsDoc({
    kind: 'element',
    entityId: curElement?.id ?? '',
    projectId: projectId ?? '',
    seedContentJson: curElement?.contentJson ?? null,
  });

  const handlePersist = useCallback(
    (_ed: Editor, { pmJson }: EditorPersistDerived) => {
      if (!elementId) return;
      if (pmJson === curElement?.contentJson) return;
      if (isCommandActive && canPromoteOnEdit()) promoteCurrentTab();
      void updateElement(elementId, { contentJson: pmJson });
    },
    [
      elementId,
      curElement?.contentJson,
      canPromoteOnEdit,
      isCommandActive,
      updateElement,
      promoteCurrentTab,
    ],
  );

  const { editor, outline, ready: editorReady } = useEntityEditor({
    sourceKind: 'element',
    sourceId: curElement?.id ?? '',
    projectId: projectId ?? '',
    content: curElement?.contentJson ?? null,
    documentMode: 'yjs',
    ydoc,
    onPersist: handlePersist,
    placeholder: t('elementEditor.bodyPlaceholder'),
    typewriterScrolling: true,
    onAddCommentRequest: handleAddCommentRequest,
    selectionKey:
      projectId && curElement
        ? editorTabSelectionKey(projectId, { entityType: 'element', id: curElement.id })
        : null,
    editable: Boolean(ydoc),
  });
  useReportEditorSurfaceReady(Boolean(curElement && (editorReady || ydocError)));

  // Outline = framework anchors for every section of the element editor, in
  // document order: 概述 → 记·传 (with its body headings nested as sub-structure)
  // → 字段 → 关联 → 补丁. Sections carry no ordinal — the order is
  // the only ranking. Built before the early return below so the scrollspy hook
  // always runs (Rules of Hooks).
  const frameworkItems: OutlineEntry[] = [
    { id: 'el-overview', level: 2, kind: 'section', text: t('elementEditor.sections.overview') },
    {
      id: 'el-bio',
      level: 2,
      kind: 'section',
      text: t('elementEditor.sections.bio'),
      children: nestHeadings(outline),
    },
    { id: 'el-kv', level: 2, kind: 'section', text: t('elementEditor.sections.facts') },
    {
      id: 'el-relations',
      level: 2,
      kind: 'section',
      text: t('referencesPanel.sections.relations'),
    },
    { id: 'el-patches', level: 2, kind: 'section', text: t('elementEditor.sections.patches') },
  ];
  // Scrollspy needs the FLAT id list (framework anchors + every heading),
  // not just the nested tree's roots.
  const outlineIds = [...frameworkItems.map((item) => item.id), ...outline.map((heading) => heading.id)];
  const { activeId: activeOutlineId, pin: pinOutline } = useOutlineScrollspy(scrollEl, outlineIds);

  const commitName = async () => {
    if (!elementId) return;
    setNameDirty(false);
    const next = nameValue.trim();
    if (!next || next === curElement?.name) return;
    promoteCurrentTab();
    try {
      await updateElement(elementId, { name: next });
    } catch (err) {
      if (err instanceof ElementNameConflictError) {
        alert(
          t('elementEditor.alerts.renameConflict', {
            name: next,
            conflicting: err.conflictingElement.name,
          }),
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
          t('elementEditor.alerts.aliasConflict', {
            name: err.conflictingName,
            conflicting: err.conflictingElement.name,
          }),
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
    setSummaryDirty(false);
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
      alert(t('elementEditor.alerts.groupUpdateFailed'));
    }
  };

  const handleSaveGroup = () => {
    const trimmed = groupNameInput.trim();
    void applyGroup(trimmed === '' ? null : trimmed);
  };

  // Sibling elements in the same category — drives the title-crumb dropdown so
  // the user can jump between elements without leaving the editor. Mirrors the
  // chapter breadcrumb's sibling switcher (chapters in a storyline).
  const siblingElements = useMemo(() => {
    if (!curElement) return [];
    return bookElements
      .filter((el) => el.categoryId === curElement.categoryId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [bookElements, curElement]);

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

  useEffect(() => {
    let canceled = false;
    if (!projectId || !readyPortraitAssetId) {
      return () => {
        canceled = true;
      };
    }
    if (portraitUrl) {
      return () => {
        canceled = true;
      };
    }

    const asset = portraitAsset;
    if (!asset) {
      return () => {
        canceled = true;
      };
    }

    assetStoreService
      .requireVariant(projectId, asset, 'display')
      .then((stored) => {
        if (!canceled) {
          setPortraitUrlByAssetId((prev) => ({ ...prev, [readyPortraitAssetId]: stored.fileUrl }));
          setPortraitErrorState(null);
        }
      })
      .catch((error) => {
        log.error('Failed to load element portrait:', error);
        if (!canceled) {
          setPortraitErrorState({
            elementId: elementId ?? null,
            assetId: readyPortraitAssetId,
            message: t('elementEditor.portrait.loadFailed'),
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [projectId, elementId, portraitAsset, readyPortraitAssetId, portraitUrl, t]);

  const handleImportPortrait = useCallback(async () => {
    if (!projectId || !elementId) return;
    setPortraitErrorState(null);
    let pickedImportPath: string | null = null;
    let ownershipTransferred = false;

    try {
      setPortraitPickerBusy(true);
      const picked = await platform.material.pickFile('image');
      if (!picked.ok) return;
      pickedImportPath = picked.filePath;
      await elementUsecases.setElementPortraitFromLocalFile(elementId, picked.filePath);
      ownershipTransferred = true;
    } catch (error) {
      log.error('Failed to import element portrait:', error);
      setPortraitErrorState({
        elementId,
        assetId: portraitAssetId,
        message: t('elementEditor.portrait.importFailed'),
      });
    } finally {
      if (pickedImportPath && !ownershipTransferred) {
        const deleted = await platform.material.deleteImport(pickedImportPath).catch((error) => {
          log.error('Failed to clean unowned portrait import:', error);
          return null;
        });
        if (deleted && !deleted.ok) {
          log.error('Failed to clean unowned portrait import:', deleted.error);
        }
      }
      setPortraitPickerBusy(false);
    }
  }, [projectId, elementId, portraitAssetId, elementUsecases, t]);

  const handleRemovePortrait = useCallback(async () => {
    if (!projectId || !elementId || !portraitAssetId) return;
    const assetId = portraitAssetId;
    const previousUrl = portraitUrlByAssetId[assetId] ?? null;
    setPortraitErrorState(null);
    setPortraitUrlByAssetId((prev) => {
      const next = { ...prev };
      delete next[assetId];
      return next;
    });

    try {
      await elementUsecases.removeElementPortrait(elementId);
    } catch (error) {
      log.error('Failed to remove element portrait:', error);
      if (previousUrl) {
        setPortraitUrlByAssetId((prev) => ({ ...prev, [assetId]: previousUrl }));
      }
      setPortraitErrorState({
        elementId,
        assetId,
        message: t('elementEditor.portrait.removeFailed'),
      });
    }
  }, [
    projectId,
    elementId,
    portraitAssetId,
    portraitUrlByAssetId,
    elementUsecases,
    t,
  ]);

  const handlePortraitSurfaceClick = useCallback(() => {
    if (portraitBusy) return;
    if (portraitUrl) {
      setPortraitPreviewOpen(true);
      return;
    }
    if (readyPortraitAssetId) return;
    void handleImportPortrait();
  }, [handleImportPortrait, portraitBusy, portraitUrl, readyPortraitAssetId]);

  const handlePortraitSurfaceKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      handlePortraitSurfaceClick();
    },
    [handlePortraitSurfaceClick],
  );

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!elementId || !curElement) return;
      if (action === 'deleteElement') {
        const confirmed = await requestConfirmation(
          t('elementEditor.deleteConfirm', { name: curElement.name }),
        );
        if (!confirmed) return;
        try {
          await elementUsecases.removeElement(elementId);
          leaveDeletedEntity();
        } catch (error) {
          log.error('Failed to delete element:', error);
          alert(t('elementEditor.alerts.deleteFailed'));
        }
      } else if (action === 'categoryPicker') {
        setEditingCategory(true);
      } else if (action === 'groupPicker') {
        setGroupNameInput('');
        setShowGroupModal(true);
      }
    },
    [elementId, curElement, elementUsecases, leaveDeletedEntity, t],
  );

  // Pending-action consumer — see NodeEditorView for the queue rationale.
  const pendingEntityAction = useUiStore((s) => s.pendingEntityAction);
  const consumeEntityAction = useUiStore((s) => s.consumeEntityAction);
  useEffect(() => {
    if (!isCommandActive) return;
    if (!elementId || !curElement) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('element', elementId);
    if (queued) queueMicrotask(() => void handleContextAction(queued));
  }, [
    isCommandActive,
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
        {t('elementEditor.empty.selectElement')}
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
            dotColor={currentCategory.color || 'hsl(var(--accent))'}
            dropdown={
              bookElementCategories.length === 0 ? (
                <div className="crumb-dropdown__empty">{t('elementEditor.empty.noCategories')}</div>
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
                        style={{ background: cat.color || 'hsl(var(--accent))' }}
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
        {curElement.groupName && (
          // Group is display-only context. Switching it here used to MOVE the
          // element between groups, which read as a navigation; relocation now
          // lives only in the 3-dot menu's「Change Group」flow.
          <EditorCrumb>
            <span>{curElement.groupName}</span>
          </EditorCrumb>
        )}
        <EditorCrumb
          dropdown={siblingElements.map((el) => {
            const isActive = el.id === curElement.id;
            return (
              <div
                key={el.id}
                className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                onClick={() => {
                  if (!isActive) navigate(`/project/${projectId}/element/${el.id}`);
                }}
              >
                <span>{el.name || t('elementEditor.untitled')}</span>
              </div>
            );
          })}
        >
          <span className="editor-crumb-title">
            {curElement.name || t('elementEditor.untitled')}
          </span>
        </EditorCrumb>
      </EditorTopBar>

      {/* Mode-controlled semantic TOC beside the native scroll tree. */}
      <div className="editor-body">
        <EditorOutlineRail
          title={`${curElement.name || 'ELEMENT'} · OUTLINE`}
          items={frameworkItems}
          activeId={activeOutlineId}
          onItemClick={(id) => {
            pinOutline(id);
            scrollToOutlineAnchor(id, scrollEl);
          }}
        />
        <div
          className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`}
          ref={setScrollEl}
        >
          <div className="editor__spread">
            <article className="page page--entity">
              <div className="page__folio" aria-hidden="true">
                <span className="page__folio-line">{t('elementEditor.folio')}</span>
                {currentCategory && (
                  <span className="page__folio-line page__folio-line--accent">
                    {currentCategory.name}
                    {curElement.groupName ? ` - ${curElement.groupName}` : ''}
                  </span>
                )}
              </div>

              <section id="el-overview">
                <div className="elem-hero">
                  <div className="elem-portrait-wrap">
                    <div
                      className={`elem-portrait${portraitHasImageSlot ? ' elem-portrait--image' : ''}${portraitBusy ? ' elem-portrait--busy' : ''}`}
                      style={portraitHasImageSlot ? undefined : { background: `${categoryColor}` }}
                      role="button"
                      tabIndex={portraitBusy ? -1 : 0}
                      title={portraitSurfaceLabel}
                      aria-label={portraitSurfaceLabel}
                      onClick={(event) => {
                        if (portraitUrl) event.currentTarget.blur();
                        handlePortraitSurfaceClick();
                      }}
                      onKeyDown={handlePortraitSurfaceKeyDown}
                    >
                      {portraitUrl ? (
                        <img className="elem-portrait__img" src={portraitUrl} alt="" />
                      ) : !portraitHasImageSlot ? (
                        <span className="elem-portrait__hint">
                          {currentCategory
                            ? t('elementEditor.sketchWithCategory', {
                                category: currentCategory.name,
                              })
                            : t('elementEditor.sketch')}
                        </span>
                      ) : null}
                      <div className="elem-portrait__actions">
                        <button
                          type="button"
                          className="elem-portrait__action"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleImportPortrait();
                          }}
                          disabled={portraitBusy}
                          title={t(
                            portraitAsset
                              ? 'elementEditor.portrait.replace'
                              : 'elementEditor.portrait.import',
                          )}
                        >
                          {portraitBusy ? (
                            <Loader2
                              className="elem-portrait__icon elem-portrait__icon--spin"
                              aria-hidden
                            />
                          ) : (
                            <ImagePlus className="elem-portrait__icon" aria-hidden />
                          )}
                          <span>
                            {portraitBusy
                              ? t('elementEditor.portrait.importing')
                              : portraitAsset
                                ? t('elementEditor.portrait.replace')
                                : t('elementEditor.portrait.import')}
                          </span>
                        </button>
                        {portraitAsset && (
                          <button
                            type="button"
                            className="elem-portrait__action elem-portrait__action--icon"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleRemovePortrait();
                            }}
                            disabled={portraitBusy}
                            title={t('elementEditor.portrait.remove')}
                          >
                            <Trash2 className="elem-portrait__icon" aria-hidden />
                          </button>
                        )}
                      </div>
                    </div>
                    {portraitError && (
                      <div className="elem-portrait__error" role="alert">
                        <span>{portraitError}</span>
                      </div>
                    )}
                  </div>
                  <div className="elem-hero__main">
                    <input
                      type="text"
                      className="elem-hero__name"
                      value={nameValue}
                      onChange={(e) => {
                        setNameDirty(true);
                        setNameValue(e.target.value);
                      }}
                      onBlur={() => void commitName()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                        if (e.key === 'Escape') {
                          setNameDirty(false);
                          setNameValue(curElement.name || '');
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder={t('elementEditor.untitled')}
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
                            borderRadius: 1,
                            background: 'hsl(var(--surface-elev, var(--surface)))',
                            border: '1px solid hsl(var(--rule))',
                            fontFamily: 'var(--font-content)',
                            fontStyle: 'normal',
                            fontSize: 12,
                            color: 'hsl(var(--ink-2))',
                          }}
                        >
                          {alias}
                          <button
                            type="button"
                            onClick={() => void removeAlias(idx)}
                            title={t('elementEditor.alias.remove')}
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
                        placeholder={
                          curElement.aliases.length === 0
                            ? t('elementEditor.alias.addFirst')
                            : t('elementEditor.alias.add')
                        }
                        style={{
                          background: 'transparent',
                          border: 0,
                          outline: 0,
                          padding: '2px 4px',
                          fontFamily: 'var(--font-content)',
                          fontStyle: 'normal',
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
                          setSummaryDirty(false);
                          fieldReview.accept(summaryReviewChange);
                          setSummaryValue(summaryReviewChange.newText);
                        }}
                        onReject={() => {
                          setSummaryDirty(false);
                          fieldReview.reject(summaryReviewChange);
                          setSummaryValue(summaryReviewChange.oldText);
                        }}
                      />
                    ) : (
                      <textarea
                        ref={summaryRef}
                        className="elem-hero__summary"
                        value={summaryValue}
                        onChange={(e) => {
                          setSummaryDirty(true);
                          setSummaryValue(e.target.value);
                        }}
                        onBlur={() => void commitSummary()}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setSummaryDirty(false);
                            setSummaryValue(curElement.summary || '');
                            e.currentTarget.blur();
                          }
                        }}
                        placeholder={t('elementEditor.summaryPlaceholder')}
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

              {/* 记·传 — the element's free-form biography (TipTap body). Sits
                directly under the hero so the prose leads; structured 字段
                follow. Its H1/H2/H3 headings nest under this anchor in the TOC. */}
              <h2 id="el-bio" className="page__scene">
                <span className="page__scene-title">{t('elementEditor.sections.bioTitle')}</span>
              </h2>
              <div className="elem-body">
                {ydocError ? <EditorDocumentLoadError /> : <EditorContent editor={editor} />}
              </div>

              {/* 字段 — element's own KV facts. Seeded at creation from the
                category's elementTemplateKvJson; owned thereafter. */}
              <h2 id="el-kv" className="page__scene">
                <span className="page__scene-title">{t('elementEditor.sections.facts')}</span>
                <span className="page__scene-meta">{t('elementEditor.meta.facts')}</span>
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
                  emptyHint={t('elementEditor.empty.noFacts')}
                />
              </div>

              {/* Manual relations stay in the body (they're authored here, with
                the link picker); 被引用/引用其他 are read-only projections and
                live in the right sidebar's stats panel instead. */}
              {elementId && projectId && (
                <div id="el-relations" style={{ scrollMarginTop: 24 }}>
                  <ReferencesPanel
                    entityKind="element"
                    entityId={elementId}
                    projectId={projectId}
                    sections={['relations']}
                  />
                </div>
              )}
              {elementId && projectId && (
                <div id="el-patches" style={{ scrollMarginTop: 24 }}>
                  <PatchesSection elementId={elementId} projectId={projectId} />
                </div>
              )}
            </article>
          </div>
        </div>
        {marginNotes && (
          <StickyNoteRail
            projectId={projectId ?? curElement.projectId}
            targetKind="element"
            targetId={elementId}
            pendingRequest={pendingComment}
            onPendingRequestChange={setPendingComment}
          />
        )}
        <EditorReviewLayer
          projectId={projectId ?? curElement.projectId}
          entityType="element"
          id={elementId}
          scrollEl={scrollEl}
          visibleCommentIds={marginNotes ? stickyNoteRail.itemIds : undefined}
        />
      </div>

      {/* Category picker (triggered from 3-dot menu) */}
      {editingCategory && (
        <ModalRoot
          onClose={() => setEditingCategory(false)}
          ariaLabel={t('elementEditor.category.change')}
        >
          <ModalCard width={360}>
            <ModalHeader
              title={t('elementEditor.category.change')}
              onClose={() => setEditingCategory(false)}
              closeLabel={t('common.close')}
            />
            <ModalBody>
            <select
              value={curElement.categoryId ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__new__') {
                  setEditingCategory(false);
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
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
              <option value="__new__">{t('elementEditor.category.newOption')}</option>
            </select>
            </ModalBody>
          </ModalCard>
        </ModalRoot>
      )}

      {showGroupModal && (
        <ModalRoot
          onClose={() => setShowGroupModal(false)}
          ariaLabel={t('elementEditor.group.title', {
            category: currentCategory?.name ?? t('storyGraph.edge.uncategorized'),
          })}
        >
          <ModalCard width={420}>
            <ModalHeader
              title={t('elementEditor.group.title', {
                category: currentCategory?.name ?? t('storyGraph.edge.uncategorized'),
              })}
              onClose={() => setShowGroupModal(false)}
              closeLabel={t('common.close')}
            />
            <ModalBody>
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
              placeholder={t('elementEditor.group.placeholder')}
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
                  background:
                    curElement.groupName == null ? 'hsl(var(--accent) / 0.12)' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid hsl(var(--rule))',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'hsl(var(--ink-3))',
                  fontStyle: 'italic',
                }}
              >
                {t('elementEditor.group.noGroup')}
              </button>
              {filteredGroups.length === 0 && groupQuery === '' && (
                <div style={{ padding: '12px', fontSize: 13, color: 'hsl(var(--ink-4))' }}>
                  {t('elementEditor.group.empty')}
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
                  {t('elementEditor.group.create', { name: groupQuery })}
                </button>
              )}
            </div>
            </ModalBody>
            <ModalActions>
              <Button variant="default" onClick={() => setShowGroupModal(false)}>
                {t('common.cancel')}
              </Button>
            </ModalActions>
          </ModalCard>
        </ModalRoot>
      )}

      {showNewCategoryModal && (
        <ModalRoot
          onClose={() => {
            setShowNewCategoryModal(false);
            setNewCategoryName('');
            setEditingCategory(false);
          }}
          ariaLabel={t('elementEditor.category.newTitle')}
        >
          <ModalCard width={360}>
            <ModalHeader
              title={t('elementEditor.category.newTitle')}
              onClose={() => {
                setShowNewCategoryModal(false);
                setNewCategoryName('');
                setEditingCategory(false);
              }}
              closeLabel={t('common.close')}
            />
            <ModalBody>
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
              placeholder={t('elementEditor.category.namePlaceholder')}
              autoFocus
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid hsl(var(--rule-strong))',
                borderRadius: 4,
                padding: '8px 12px',
                outline: 'none',
                background: 'hsl(var(--surface))',
              }}
            />
            </ModalBody>
            <ModalActions>
              <Button
                variant="default"
                onClick={() => {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                  setEditingCategory(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateNewCategory}
              >
                {t('elementEditor.category.create')}
              </Button>
            </ModalActions>
          </ModalCard>
        </ModalRoot>
      )}

      {portraitPreviewOpen && portraitPreviewMaterial && (
        <LibraryItemFullscreenPreview
          material={portraitPreviewMaterial}
          onClose={() => setPortraitPreviewOpen(false)}
          onUpdate={() => undefined}
        />
      )}
    </div>
  );
}
