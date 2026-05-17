import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useNavigate, useParams } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
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

  const [editingName, setEditingName] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [editingCategory, setEditingCategory] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [summaryValue, setSummaryValue] = useState('');
  const [categoryValue, setCategoryValue] = useState('');
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');


  // Derive curElement from the store at render time. Local edit-state values
  // (nameValue, summaryValue, categoryValue) reset whenever the underlying
  // element id changes — done via the prev-snapshot pattern below to avoid
  // the "setState in effect" anti-pattern.
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
    setCategoryValue(curElement?.categoryId || '');
    // Auto-enter edit mode for newly created elements
    if (curElement?.name === 'New Element') {
      setEditingName(true);
    }
  }

  // No separate reset effect: local input drafts follow the loaded entity id
  // above, while editor content stays owned by useEntityEditor.

  // Persist element content on every editor update (reference projection,
  // mark sync, picker, slash menu, undo depth, Cmd+S registration — all
  // owned by the hook).
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

  const { editor } = useEntityEditor({
    sourceKind: 'element',
    sourceId: curElement?.id ?? '',
    projectId: projectId ?? '',
    content: curElement?.contentJson ?? null,
    onPersist: handlePersist,
    autoFocus: true,
    editorClass: 'prose max-w-none focus:outline-none min-h-[400px]',
  });

  const handleSaveName = async () => {
    if (!elementId || !nameValue.trim()) return;
    promoteCurrentTab();
    await updateElement(elementId, { name: nameValue.trim() });
    setEditingName(false);
  };

  const handleSaveSummary = async () => {
    if (!elementId) return;
    promoteCurrentTab();
    await updateElement(elementId, { summary: summaryValue });
    setEditingSummary(false);
  };

  const handleCreateNewCategory = async () => {
    if (!newCategoryName.trim()) return;

    const created = await createCategory({ name: newCategoryName.trim() });

    // Set the new category
    setCategoryValue(created.id);
    if (elementId) {
      await updateElement(elementId, { categoryId: created.id });
    }

    // Close modal
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
          color: '#999',
        }}
      >
        Select an element to edit
      </div>
    );
  }

  const currentCategory = bookElementCategories.find((cat) => cat.id === curElement.categoryId);

  return (
    <div
      className="editor-shell"
      style={{
        height: '100%',
        position: 'relative',
      }}
    >
      <EditorTopBar
        editorType="element"
        onMenuAction={handleContextAction}
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
                      onClick={() => {
                        navigate(`/project/${projectId}/category/${cat.id}`);
                      }}
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

      {/* Header Section */}
      <div
        style={{
          padding: '60px 80px 24px 80px',
          borderBottom: '1px solid rgba(0, 0, 0, 0.08)',
        }}
      >
        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') {
                  setNameValue(curElement.name);
                  setEditingName(false);
                }
              }}
              onFocus={(e) => e.target.select()}
              autoFocus
              style={{
                width: '100%',
                fontSize: 32,
                fontWeight: 700,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                padding: '8px 0',
                color: 'rgba(0, 0, 0, 0.85)',
              }}
            />
          ) : (
            <h1
              onClick={() => setEditingName(true)}
              style={{
                fontSize: 32,
                fontWeight: 700,
                margin: 0,
                padding: '8px 0',
                cursor: 'pointer',
                color: 'rgba(0, 0, 0, 0.85)',
                transition: 'color 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.6)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.85)';
              }}
            >
              {curElement.name || 'Untitled Element'}
            </h1>
          )}
        </div>

        {/* Summary */}
        <div style={{ marginBottom: 16 }}>
          {editingSummary ? (
            <textarea
              value={summaryValue}
              onChange={(e) => setSummaryValue(e.target.value)}
              onBlur={handleSaveSummary}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSummaryValue(curElement.summary);
                  setEditingSummary(false);
                }
              }}
              autoFocus
              rows={3}
              style={{
                width: '100%',
                fontSize: 15,
                border: '1px solid rgba(0, 0, 0, 0.1)',
                borderRadius: 6,
                outline: 'none',
                padding: '8px 12px',
                color: 'rgba(0, 0, 0, 0.65)',
                resize: 'vertical',
              }}
            />
          ) : (
            <div
              onClick={() => setEditingSummary(true)}
              style={{
                fontSize: 15,
                color: 'rgba(0, 0, 0, 0.65)',
                padding: '8px 12px',
                cursor: 'pointer',
                borderRadius: 6,
                transition: 'background 0.2s ease',
                minHeight: 24,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {curElement.summary || 'Click to add summary...'}
            </div>
          )}
        </div>

        {/* Category */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* Category */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)', marginBottom: 4 }}>
              Category
            </div>
            {editingCategory ? (
              <>
                <select
                  value={categoryValue}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '__new__') {
                      setShowNewCategoryModal(true);
                    } else {
                      setCategoryValue(val);
                      // Auto-save on regular selection
                      if (elementId) {
                        void updateElement(elementId, { categoryId: val });
                      }
                      setEditingCategory(false);
                    }
                  }}
                  onBlur={() => {
                    // Only close if not showing modal
                    if (!showNewCategoryModal && categoryValue !== '__new__') {
                      setEditingCategory(false);
                    }
                  }}
                  autoFocus
                  style={{
                    width: '100%',
                    fontSize: 14,
                    border: '1px solid rgba(0, 0, 0, 0.1)',
                    borderRadius: 6,
                    padding: '6px 10px',
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {bookElementCategories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                  <option value="__new__">+ New Category</option>
                </select>

                {/* New Category Modal */}
                {showNewCategoryModal && (
                  <div
                    style={{
                      position: 'fixed',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      background: 'rgba(0, 0, 0, 0.5)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 1000,
                    }}
                    onClick={() => {
                      setShowNewCategoryModal(false);
                      setNewCategoryName('');
                      setEditingCategory(false);
                    }}
                  >
                    <div
                      style={{
                        background: 'white',
                        borderRadius: 12,
                        padding: 24,
                        minWidth: 320,
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <h3 style={{ margin: '0 0 16px 0', fontSize: 18, fontWeight: 600 }}>
                        New Category
                      </h3>
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
                        placeholder="Category name..."
                        autoFocus
                        style={{
                          width: '100%',
                          fontSize: 14,
                          border: '1px solid rgba(0, 0, 0, 0.2)',
                          borderRadius: 6,
                          padding: '8px 12px',
                          outline: 'none',
                          marginBottom: 16,
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => {
                            setShowNewCategoryModal(false);
                            setNewCategoryName('');
                            setEditingCategory(false);
                          }}
                          style={{
                            padding: '6px 16px',
                            borderRadius: 6,
                            border: '1px solid rgba(0, 0, 0, 0.2)',
                            background: 'white',
                            cursor: 'pointer',
                            fontSize: 14,
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCreateNewCategory}
                          className="bg-accent hover:bg-accent-hover text-paper transition-colors"
                          style={{
                            padding: '6px 16px',
                            borderRadius: 6,
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 14,
                            fontWeight: 600,
                          }}
                        >
                          Create
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div
                onClick={() => setEditingCategory(true)}
                className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
                style={{
                  fontSize: 14,
                  color: '#5a4a3a',
                  padding: '6px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'inline-block',
                  border: '1px solid var(--accent-border, #e8dcc8)',
                }}
              >
                {bookElementCategories.find((cat) => cat.id === curElement.categoryId)?.name ??
                  curElement.categoryId}
              </div>
            )}
          </div>

        </div>

        {/* References Panel — incoming + outgoing inline mentions plus manual relations */}
        {elementId && projectId && (
          <div className="mt-4">
            <ReferencesPanel entityKind="element" entityId={elementId} projectId={projectId} />
          </div>
        )}

        {/* Patches Section — author addendum anchored to chapters / blocks */}
        {elementId && projectId && (
          <div className="mt-4">
            <PatchesSection elementId={elementId} projectId={projectId} />
          </div>
        )}
      </div>

      {/* Editor Content */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '32px 80px',
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Right Vertical Buttons */}
    </div>
  );
}
