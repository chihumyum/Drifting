import { useEffect, useRef, useState, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { useParams } from 'react-router-dom';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { useDataStore } from '../store/data-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { createEmptyTiptapDoc, parseTiptapDocJson } from '../utils/tiptap-doc';
import { X, Eye } from 'lucide-react';
import loglevel from 'loglevel';
import { useAuthStore } from '../store/auth';

const log = loglevel.getLogger('CategoryEditorView');
log.setLevel(loglevel.levels.ERROR);

export function CategoryEditorView() {
  const { projectId, categoryId } = useParams<{ projectId: string; categoryId: string }>();
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) {
    log.error('Project ID is missing in params');
    throw new Error('Project ID is required');
  }
  if (!userId) {
    log.error('User ID is missing in auth store');
    throw new Error('User must be authenticated');
  }
  const { bookElementCategories, bookElements } = useDataStore();
  // TODO: allow delete element from this view
  const { updateElement } = useBookElement({
    projectId: projectId,
    userId: userId,
  });
  const categoryUsecases = useElementCategory({
    projectId: projectId,
    userId: userId,
  });
  const { navigateToHome, navigateToElement, navigateToCategory } = useProjectNavigation();

  const [showElementsModal, setShowElementsModal] = useState(false);
  const [editingNameCategoryId, setEditingNameCategoryId] = useState<string | null>(null);
  const [categoryNameDraft, setCategoryNameDraft] = useState('');

  const isContentLoadedRef = useRef(false);
  const loadedCategoryIdRef = useRef<string | null>(null);

  // Redirect if category is missing from params.
  useEffect(() => {
    if (!projectId) {
      log.error('Project ID is missing');
      return;
    }
    if (!categoryId) {
      navigateToHome();
    }
  }, [categoryId, navigateToHome, projectId]);

  const curCategory = useMemo(() => {
    if (!categoryId) return null;
    return bookElementCategories.find((cat) => cat.id === categoryId) || null;
  }, [bookElementCategories, categoryId]);

  // Get elements belonging to this category
  const categoryElements = useMemo(() => {
    if (!categoryId) return [];
    return bookElements.filter((el) => el.categoryId === categoryId);
  }, [bookElements, categoryId]);
  const isEditingCategoryName = curCategory ? editingNameCategoryId === curCategory.id : false;
  const isReservedCategory = curCategory?.name === 'others';

  // Initialize editor
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
        link: false, // 禁用 StarterKit 自带的 link，使用自定义配置
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: 'text-blue-600 underline cursor-pointer',
        },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      createDefaultSlashMenu(),
    ],
    content: createEmptyTiptapDoc(),
    autofocus: 'end',
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[200px] px-4 py-3',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!isContentLoadedRef.current) {
        log.debug('Skipping save: content not yet loaded');
        return;
      }

      const json = ed.getJSON();
      const contentJson = JSON.stringify(json);
      if (contentJson === curCategory?.descriptionJson) return;

      if (curCategory) {
        void handleSaveContent(contentJson);
      }
    },
  });

  // Load content into editor
  useEffect(() => {
    if (!editor || !curCategory) return;
    if (loadedCategoryIdRef.current === curCategory.id) return;
    if (editor.isDestroyed) return;

    const content = parseTiptapDocJson(curCategory.descriptionJson, (error) => {
      log.error('Failed to parse category description:', error);
    });
    try {
      isContentLoadedRef.current = false;
      editor.commands.setContent(content, { emitUpdate: false });
    } catch (error) {
      log.error('Failed to load category description into editor:', error);
      isContentLoadedRef.current = false;
      return;
    }

    loadedCategoryIdRef.current = curCategory.id;
    isContentLoadedRef.current = true;
  }, [editor, curCategory]);

  // Save category description
  const handleSaveContent = async (content: string) => {
    if (!curCategory) return;
    await categoryUsecases.updateCategory(curCategory.id, {
      descriptionJson: content,
    });
  };

  const handleStartNameEdit = () => {
    if (!curCategory || isReservedCategory) return;
    setEditingNameCategoryId(curCategory.id);
    setCategoryNameDraft(curCategory.name);
  };

  const handleCancelNameEdit = () => {
    setEditingNameCategoryId(null);
    setCategoryNameDraft('');
  };

  const handleSaveName = async () => {
    if (!curCategory || editingNameCategoryId !== curCategory.id || isReservedCategory) return;

    const nextName = categoryNameDraft.trim();
    if (!nextName || nextName === curCategory.name) {
      handleCancelNameEdit();
      return;
    }

    try {
      await categoryUsecases.updateCategory(curCategory.id, {
        name: nextName,
      });
    } catch (error) {
      log.error('Failed to update category name:', error);
    } finally {
      handleCancelNameEdit();
    }
  };

  const handleContextAction = async (action: string) => {
    if (!curCategory) return;

    if (action === 'deleteCategory') {
      const confirmed = window.confirm(
        `Delete category "${curCategory.name}"?\n\nAll elements in this category will be moved to "others".`,
      );
      if (!confirmed) return;

      try {
        // Move all elements in this category to "others"
        for (const element of categoryElements) {
          await updateElement(element.id, { categoryId: 'others' });
        }
        // Delete the category
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
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#999',
        }}
      >
        Loading category...
      </div>
    );
  }

  return (
    <div
      className="editor-shell"
      style={{
        height: '100%',
        background: 'rgba(251, 249, 243, 1)',
        overflow: 'hidden',
      }}
    >
      <EditorTopBar
        editorType="category"
        onMenuAction={handleContextAction}
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
                    onClick={() => {
                      if (!isActive) navigateToCategory(cat.id);
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
          <span>{curCategory.name}</span>
        </EditorCrumb>
      </EditorTopBar>

      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: '20px 32px',
          borderBottom: '1px solid rgba(200, 190, 220, 0.25)',
          background: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
          {/* TODO: make this editable */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            {curCategory.color && (
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: curCategory.color,
                  boxShadow: `0 2px 8px ${curCategory.color}40`,
                }}
              />
            )}
            {isEditingCategoryName ? (
              <input
                type="text"
                value={categoryNameDraft}
                onChange={(event) => setCategoryNameDraft(event.target.value)}
                onBlur={() => {
                  void handleSaveName();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === 'Escape') {
                    handleCancelNameEdit();
                  }
                }}
                onFocus={(event) => event.target.select()}
                autoFocus
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: 'rgba(0, 0, 0, 0.85)',
                  margin: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  padding: 0,
                }}
              />
            ) : (
              <h1
                onDoubleClick={handleStartNameEdit}
                title={isReservedCategory ? 'Reserved category' : 'Double-click to rename'}
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: 'rgba(0, 0, 0, 0.85)',
                  margin: 0,
                  cursor: isReservedCategory ? 'default' : 'text',
                }}
              >
                {curCategory.name}
              </h1>
            )}
          </div>

          {/* Element count */}
          <div
            style={{
              padding: '4px 12px',
              borderRadius: 12,
              background: 'rgba(102, 126, 234, 0.1)',
              color: 'rgba(102, 126, 234, 0.9)',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {categoryElements.length} {categoryElements.length === 1 ? 'element' : 'elements'}
          </div>
        </div>

        {/* View elements button */}
        <button
          onClick={() => setShowElementsModal(true)}
          className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid var(--accent-border, #e8dcc8)',
            color: '#5a4a3a',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Eye size={16} />
          View All Elements
        </button>
      </div>

      {/* Editor Content */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '32px',
        }}
      >
        <div
          style={{
            maxWidth: 800,
            margin: '0 auto',
            background: 'white',
            borderRadius: 12,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
            border: '1px solid rgba(200, 190, 220, 0.25)',
            minHeight: 400,
          }}
        >
          {/* Tiptap Editor */}
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* Elements Modal */}
      {showElementsModal && (
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
            padding: 40,
          }}
          onClick={() => setShowElementsModal(false)}
        >
          <div
            style={{
              background: 'white',
              borderRadius: 16,
              maxWidth: 900,
              width: '100%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '24px 32px',
                borderBottom: '1px solid rgba(200, 190, 220, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: 'rgba(0, 0, 0, 0.85)',
                    margin: '0 0 4px 0',
                  }}
                >
                  Elements in "{curCategory.name}"
                </h2>
                <p
                  style={{
                    fontSize: 14,
                    color: 'rgba(0, 0, 0, 0.5)',
                    margin: 0,
                  }}
                >
                  {categoryElements.length} {categoryElements.length === 1 ? 'element' : 'elements'}{' '}
                  found
                </p>
              </div>
              <button
                onClick={() => setShowElementsModal(false)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  border: 'none',
                  background: 'rgba(0, 0, 0, 0.05)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Content */}
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '24px 32px',
              }}
            >
              {categoryElements.length === 0 ? (
                <div
                  style={{
                    padding: '40px 20px',
                    textAlign: 'center',
                    color: 'rgba(0, 0, 0, 0.4)',
                    fontSize: 14,
                  }}
                >
                  No elements in this category yet.
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                    gap: 16,
                  }}
                >
                  {categoryElements.map((el) => (
                    <div
                      key={el.id}
                      onClick={() => {
                        setShowElementsModal(false);
                        navigateToElement(el.id);
                      }}
                      className="bg-paper shadow-paper"
                      style={{
                        padding: '16px',
                        borderRadius: 12,
                        border: '1px solid var(--accent-border, #e8dcc8)',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.boxShadow = '0 4px 12px rgba(139, 111, 71, 0.12)';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.boxShadow = '0 2px 8px rgba(139, 111, 71, 0.06)';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 600,
                          color: '#3a2a1a',
                          marginBottom: 8,
                        }}
                      >
                        {el.name}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'rgba(0, 0, 0, 0.5)',
                        }}
                      >
                        {new Date(el.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
