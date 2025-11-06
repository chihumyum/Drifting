import { useEffect, useRef, useState, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '../store';
import { useBookElementUsecases } from '../hooks/useBookElementUsecases';
import type { BookElementCategory } from '../domain/book_element';
import { EditorMenuBar } from './Editor/EditorMenuBar';
import { EditorContextMenu } from '../components/EditorContextMenu';
import { X, Eye } from 'lucide-react';

const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [],
});

function getDefaultDoc(): JSONContent {
  return JSON.parse(DEFAULT_DOC_STRING) as JSONContent;
}

export function CategoryEditorView() {
  const navigate = useNavigate();
  const { categoryName } = useParams<{ categoryName: string }>();
  const { bookElements, bookElementCategories } = useAppStore();
  const { _deps, loadInitial, updateElement } = useBookElementUsecases();

  const [category, setCategory] = useState<BookElementCategory | null>(null);
  const [showElementsModal, setShowElementsModal] = useState(false);

  const isContentLoadedRef = useRef(false);

  // Get category data
  useEffect(() => {
    if (!categoryName) {
      navigate('/', { replace: true });
      return;
    }

    const cat = bookElementCategories.find(c => c.name === categoryName);
    if (cat) {
      setCategory(cat);
    } else {
      console.warn('Category not found:', categoryName);
    }
  }, [bookElementCategories, categoryName, navigate]);

  // Get elements belonging to this category
  const categoryElements = useMemo(() => {
    if (!categoryName) return [];
    return bookElements.filter(el => el.category === categoryName);
  }, [bookElements, categoryName]);

  // Initialize editor
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
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
    content: getDefaultDoc(),
    autofocus: 'end',
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[200px] px-4 py-3',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!isContentLoadedRef.current) {
        console.log('Skipping save: content not yet loaded');
        return;
      }

      const json = ed.getJSON();
      const contentJson = JSON.stringify(json);
      if (contentJson === category?.description_json) return;

      if (category) {
        void handleSave(contentJson);
      }
    },
  });

  // Load content into editor
  useEffect(() => {
    if (!editor || !category || isContentLoadedRef.current) return;

    try {
      const content = category.description_json 
        ? JSON.parse(category.description_json) 
        : getDefaultDoc();
      editor.commands.setContent(content);
      isContentLoadedRef.current = true;
    } catch (error) {
      console.error('Failed to parse category description:', error);
      editor.commands.setContent(getDefaultDoc());
      isContentLoadedRef.current = true;
    }
  }, [editor, category]);

  // Save category description
  const handleSave = async (content: string) => {
    if (!category) return;
    
    try {
      await _deps.categoryRepo.update(category.name, {
        description_json: content,
      });
      await loadInitial();
    } catch (error) {
      console.error('Failed to save category description:', error);
    }
  };

  const handleContextAction = async (action: string) => {
    if (!category) return;
    
    if (action === 'deleteCategory') {
      const confirmed = window.confirm(
        `Delete category "${category.name}"?\n\nAll elements in this category will be moved to "others".`
      );
      if (!confirmed) return;
      
      try {
        // Move all elements in this category to "others"
        for (const element of categoryElements) {
          await updateElement(element.id, { category: 'others' });
        }
        
        // Delete the category
        await _deps.categoryRepo.delete(category.name);
        await loadInitial();
        navigate('/editor');
      } catch (error) {
        console.error('Failed to delete category:', error);
        alert('Failed to delete category. Please try again.');
      }
    }
  };

  if (!category) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#999',
      }}>
        Loading category...
      </div>
    );
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(251, 249, 243, 1)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        flexShrink: 0,
        padding: '20px 32px',
        borderBottom: '1px solid rgba(200, 190, 220, 0.25)',
        background: 'white',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
          {/* Back button */}
          <button
            onClick={() => navigate('/')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 6,
              border: '1px solid rgba(0, 0, 0, 0.1)',
              background: 'white',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'white';
            }}
          >
            <X size={18} />
          </button>

          {/* Category name */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            {category.color && (
              <div style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: category.color,
                boxShadow: `0 2px 8px ${category.color}40`,
              }} />
            )}
            <h1 style={{
              fontSize: 24,
              fontWeight: 700,
              color: 'rgba(0, 0, 0, 0.85)',
              margin: 0,
            }}>
              {category.name}
            </h1>
          </div>

          {/* Element count */}
          <div style={{
            padding: '4px 12px',
            borderRadius: 12,
            background: 'rgba(102, 126, 234, 0.1)',
            color: 'rgba(102, 126, 234, 0.9)',
            fontSize: 12,
            fontWeight: 600,
          }}>
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
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '32px',
      }}>
        <div style={{
          maxWidth: 800,
          margin: '0 auto',
          background: 'white',
          borderRadius: 12,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
          border: '1px solid rgba(200, 190, 220, 0.25)',
          minHeight: 400,
        }}>
          {/* Editor Menu Bar */}
          {editor && (
            <div style={{
              borderBottom: '1px solid rgba(200, 190, 220, 0.15)',
              padding: '8px 12px',
            }}>
              <EditorMenuBar editor={editor} />
            </div>
          )}

          {/* Tiptap Editor */}
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* Editor Context Menu */}
      <EditorContextMenu 
        editorType="category"
        onAction={handleContextAction}
      />

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
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{
              padding: '24px 32px',
              borderBottom: '1px solid rgba(200, 190, 220, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div>
                <h2 style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: 'rgba(0, 0, 0, 0.85)',
                  margin: '0 0 4px 0',
                }}>
                  Elements in "{category.name}"
                </h2>
                <p style={{
                  fontSize: 14,
                  color: 'rgba(0, 0, 0, 0.5)',
                  margin: 0,
                }}>
                  {categoryElements.length} {categoryElements.length === 1 ? 'element' : 'elements'} found
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
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.1)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Content */}
            <div style={{
              flex: 1,
              overflow: 'auto',
              padding: '24px 32px',
            }}>
              {categoryElements.length === 0 ? (
                <div style={{
                  padding: '40px 20px',
                  textAlign: 'center',
                  color: 'rgba(0, 0, 0, 0.4)',
                  fontSize: 14,
                }}>
                  No elements in this category yet.
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                  gap: 16,
                }}>
                  {categoryElements.map(el => (
                    <div
                      key={el.id}
                      onClick={() => {
                        setShowElementsModal(false);
                        navigate(`/element/${el.id}`);
                      }}
                      className="bg-paper shadow-paper"
                      style={{
                        padding: '16px',
                        borderRadius: 12,
                        border: '1px solid var(--accent-border, #e8dcc8)',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.boxShadow = '0 4px 12px rgba(139, 111, 71, 0.12)';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.boxShadow = '0 2px 8px rgba(139, 111, 71, 0.06)';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      <div style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: '#3a2a1a',
                        marginBottom: 8,
                      }}>
                        {el.name}
                      </div>
                      <div style={{
                        fontSize: 12,
                        color: 'rgba(0, 0, 0, 0.5)',
                      }}>
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
