import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { createDefaultSlashMenu } from '../../lib/slash-menu';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '../../store';
import { useBookElementUsecases } from '../../hooks/useBookElementUsecases';
import type { BookElement } from '../../domain/book_element';
import { EditorMenuBar } from './EditorMenuBar';
import { RightVerticalButtons } from '../../components/RightVerticalButtons';
import { X } from 'lucide-react';

const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [],
});

function getDefaultDoc(): JSONContent {
  return JSON.parse(DEFAULT_DOC_STRING) as JSONContent;
}

export function ElementEditorView() {
  const navigate = useNavigate();
  const { elementId } = useParams<{ elementId: string }>();
  const { bookElements, bookElementCategories } = useAppStore();

  const { updateElement, loadInitial, _deps } = useBookElementUsecases();
  const { categoryRepo } = _deps;
  const [curElement, setCurElement] = useState<BookElement | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [editingCategory, setEditingCategory] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [summaryValue, setSummaryValue] = useState('');
  const [categoryValue, setCategoryValue] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState('');
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [filteredTags, setFilteredTags] = useState<string[]>([]);

  const isContentLoadedRef = useRef(false);
  const loadedElementIdRef = useRef<string | null>(null);

  // Load elements on mount if not already loaded
  useEffect(() => {
    if (bookElements.length === 0) {
      void loadInitial();
    }
  }, [bookElements.length, loadInitial]);

  // Get element from URL and update current element
  useEffect(() => {
    if (!elementId) {
      navigate('/', { replace: true });
      return;
    }
    
    const element = bookElements.find(e => e.id === elementId) || null;
    setCurElement(element);
    setNameValue(element?.name || '');
    setSummaryValue(element?.summary_json || '');
    setCategoryValue(element?.category || 'others');
    setTags(element?.tags || []);
  }, [bookElements, elementId, navigate]);

  // Load content when elementId changes
  useEffect(() => {
    if (!elementId || !curElement) return;

    isContentLoadedRef.current = false;
    loadedElementIdRef.current = null;
    
    // Content is already in the element
    isContentLoadedRef.current = true;
    loadedElementIdRef.current = elementId;
  }, [elementId, curElement]);

  // Tiptap editor setup
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
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
        class: 'prose max-w-none focus:outline-none min-h-[400px]',
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
      if (contentJson === curElement?.content_json) return;
      
      if (elementId) {
        void updateElement(elementId, {
          content_json: contentJson,
        });
      }
    },
  });

  // Update editor content when element changes
  useEffect(() => {
    if (!editor || !curElement) return;

    const contentJson = curElement.content_json;
    if (!contentJson) {
      editor.commands.setContent(getDefaultDoc());
      return;
    }

    try {
      const json = JSON.parse(contentJson) as JSONContent;
      const currentJson = editor.getJSON();
      const currentString = JSON.stringify(currentJson);
      
      if (contentJson !== currentString) {
        editor.commands.setContent(json);
      }
    } catch (error) {
      console.error('Failed to parse element content', error);
      editor.commands.setContent(getDefaultDoc());
    }
  }, [editor, curElement]);

  const handleSaveName = async () => {
    if (!elementId || !nameValue.trim()) return;
    await updateElement(elementId, { name: nameValue.trim() });
    setEditingName(false);
  };

  const handleSaveSummary = async () => {
    if (!elementId) return;
    await updateElement(elementId, { summary_json: summaryValue });
    setEditingSummary(false);
  };

  const handleCreateNewCategory = async () => {
    if (!newCategoryName.trim()) return;
    
    // Create new category using the category repository
    const { categoryRepo } = _deps;
    await categoryRepo.create(newCategoryName.trim());
    
    // Reload categories
    await loadInitial();
    
    // Set the new category
    setCategoryValue(newCategoryName.trim());
    if (elementId) {
      await updateElement(elementId, { category: newCategoryName.trim() });
    }
    
    // Close modal
    setShowNewCategoryModal(false);
    setNewCategoryName('');
    setEditingCategory(false);
  };

  // Get all existing tags from all elements
  const getAllExistingTags = useCallback((): string[] => {
    const allTags = new Set<string>();
    bookElements.forEach(el => {
      el.tags?.forEach(tag => allTags.add(tag));
    });
    return Array.from(allTags);
  }, [bookElements]);

  // Filter tags based on input - support any language, not just lowercase
  useEffect(() => {
    if (!newTagInput.trim()) {
      setFilteredTags([]);
      return;
    }
    
    const existingTags = getAllExistingTags();
    const input = newTagInput.trim();
    const filtered = existingTags
      .filter(tag => tag.startsWith(input) && !tags.includes(tag))
      .slice(0, 5); // Limit to 5 suggestions
    
    setFilteredTags(filtered);
  }, [newTagInput, tags, getAllExistingTags]);

  const handleAddTag = async (tagToAdd?: string) => {
    if (!elementId) return;
    const trimmedTag = (tagToAdd || newTagInput).trim();
    if (!trimmedTag || tags.includes(trimmedTag)) return; // Avoid duplicates
    
    const updatedTags = [...tags, trimmedTag];
    setTags(updatedTags);
    setNewTagInput('');
    setFilteredTags([]);
    await updateElement(elementId, { tags: updatedTags });
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!elementId) return;
    const updatedTags = tags.filter(t => t !== tagToRemove);
    setTags(updatedTags);
    await updateElement(elementId, { tags: updatedTags });
  };

  if (!elementId || !curElement) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        color: '#999',
      }}>
        Select an element to edit
      </div>
    );
  }

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column',
      height: '100%',
      position: 'relative',
    }}>
      {/* Header Section */}
      <div style={{
        padding: '60px 80px 24px 80px',
        borderBottom: '1px solid rgba(0, 0, 0, 0.08)',
      }}>
        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') {
                  setNameValue(curElement.name);
                  setEditingName(false);
                }
              }}
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
              onMouseEnter={e => {
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.6)';
              }}
              onMouseLeave={e => {
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
              onChange={e => setSummaryValue(e.target.value)}
              onBlur={handleSaveSummary}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setSummaryValue(curElement.summary_json);
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
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {curElement.summary_json || 'Click to add summary...'}
            </div>
          )}
        </div>

        {/* Category and Tags */}
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
                  onChange={e => {
                    const val = e.target.value;
                    if (val === '__new__') {
                      setShowNewCategoryModal(true);
                    } else {
                      setCategoryValue(val);
                      // Auto-save on regular selection
                      if (elementId) {
                        void updateElement(elementId, { category: val });
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
                  <option value="others">Others</option>
                  {bookElementCategories.map(cat => (
                    <option key={cat.id} value={cat.name}>
                      {cat.name}
                    </option>
                  ))}
                  <option value="__new__">+ New Category</option>
                </select>
                
                {/* New Category Modal */}
                {showNewCategoryModal && (
                  <div style={{
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
                    <div style={{
                      background: 'white',
                      borderRadius: 12,
                      padding: 24,
                      minWidth: 320,
                      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
                    }}
                    onClick={e => e.stopPropagation()}
                    >
                      <h3 style={{ margin: '0 0 16px 0', fontSize: 18, fontWeight: 600 }}>
                        New Category
                      </h3>
                      <input
                        type="text"
                        value={newCategoryName}
                        onChange={e => setNewCategoryName(e.target.value)}
                        onKeyDown={e => {
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
                          className="bg-button"
                          style={{
                            padding: '6px 16px',
                            borderRadius: 6,
                            border: 'none',
                            color: 'rgba(0, 0, 0, 0.75)',
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
                className="bg-button"
                style={{
                  fontSize: 14,
                  color: 'rgba(0, 0, 0, 0.75)',
                  padding: '6px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'inline-block',
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.opacity = '0.8';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                {curElement.category || 'others'}
              </div>
            )}
          </div>

          {/* Tags */}
          <div style={{ flex: 2, position: 'relative' }}>
            <div style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)', marginBottom: 4 }}>
              Tags
            </div>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              position: 'relative',
            }}>
              {tags.map(tag => (
                <span
                  key={tag}
                  className="bg-button"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 13,
                    color: 'rgba(0, 0, 0, 0.75)',
                  }}
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      color: 'rgba(0, 0, 0, 0.5)',
                    }}
                    title="Remove tag"
                  >
                    <X size={14} />
                  </button>
                </span>
              ))}
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <input
                  type="text"
                  value={newTagInput}
                  onChange={e => setNewTagInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleAddTag();
                    } else if (e.key === 'Escape') {
                      setNewTagInput('');
                      setFilteredTags([]);
                    }
                  }}
                  onBlur={() => {
                    // Delay to allow clicking on suggestions
                    setTimeout(() => setFilteredTags([]), 200);
                  }}
                  placeholder={tags.length === 0 ? 'Add tags...' : '+'}
                  style={{
                    minWidth: 100,
                    border: '1px solid rgba(0, 0, 0, 0.1)',
                    borderRadius: 4,
                    outline: 'none',
                    fontSize: 13,
                    padding: '4px 8px',
                    background: 'white',
                  }}
                />
                
                {/* Tag suggestions dropdown - positioned relative to input */}
                {filteredTags.length > 0 && (
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: 4,
                    background: 'white',
                    border: '1px solid rgba(0, 0, 0, 0.1)',
                    borderRadius: 6,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
                    zIndex: 100,
                    minWidth: 200,
                    maxWidth: 300,
                    maxHeight: 150,
                    overflow: 'auto',
                  }}>
                    {filteredTags.map(tag => (
                      <div
                        key={tag}
                        onClick={() => void handleAddTag(tag)}
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          fontSize: 13,
                          transition: 'background 0.15s ease',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        {tag}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Editor Content */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '32px 80px',
      }}>
        <EditorContent editor={editor} />
      </div>

      {/* Editor Menu Bar */}
      <EditorMenuBar editor={editor} />
      
      {/* Right Vertical Buttons */}
      <RightVerticalButtons />
    </div>
  );
}
