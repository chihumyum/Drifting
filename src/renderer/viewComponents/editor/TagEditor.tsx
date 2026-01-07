import { useState, useEffect, useCallback } from 'react';
import log from 'loglevel';
log.setLevel(log.levels.ERROR);
import { X, Plus } from 'lucide-react';
import { useNodeTagUsecases } from '../../hooks/useNodeTagUsecases';
import { useBookElementUsecases } from '../../hooks/useBookElementUsecases';
import { useAppStore } from '../../store';
import type { NodeTag } from '../../domain/story_stage';

type TagType = 'node' | 'element';

interface TagEditorProps {
  type: TagType;
  entityId: string; // nodeId or elementId
  projectId?: string;
}
/*
  Tag Editor Component used in NodeEditorView and ElementEditorView
*/
export function TagEditor({ type, entityId, projectId = 'default-project' }: TagEditorProps) {
  const nodeTagUsecases = useNodeTagUsecases();
  const elementUsecases = useBookElementUsecases();
  const bookElements = useAppStore(state => state.bookElements);
  const [allTags, setAllTags] = useState<NodeTag[]>([]);
  const [entityTags, setEntityTags] = useState<NodeTag[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const loadTags = useCallback(async () => {
    try {
      if (type === 'node') {
        const [all, entity] = await Promise.all([
          nodeTagUsecases.loadTags(projectId),
          nodeTagUsecases.getTagsForNode(entityId, projectId),
        ]);
        setAllTags(all);
        setEntityTags(entity);
      } else if (type === 'element') {
        // For elements, we use the element's tags from the element data
        const element = bookElements.find(el => el.id === entityId);
        if (element) {
          // Get all available tags
          const allNodeTags = await nodeTagUsecases.loadTags(projectId);
          setAllTags(allNodeTags);
          // Element tags are stored as tag IDs array
          const elementTags = allNodeTags.filter(tag => 
            element.tags?.includes(tag.id)
          );
          setEntityTags(elementTags);
        }
      }
    } catch (error) {
      log.error('Failed to load tags:', error);
    }
  }, [type, entityId, projectId, nodeTagUsecases, bookElements]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const handleAddTag = async (tagId: string) => {
    try {
      if (type === 'node') {
        await nodeTagUsecases.addTagToNode(entityId, tagId, projectId);
      } else if (type === 'element') {
        const element = bookElements.find(el => el.id === entityId);
        if (element) {
          const updatedTags = [...(element.tags || []), tagId];
          await elementUsecases.updateElement(entityId, {
            tags: updatedTags,
          });
        }
      }
      await loadTags();
      setShowDropdown(false);
    } catch (error) {
      log.error('Failed to add tag:', error);
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    try {
      if (type === 'node') {
        await nodeTagUsecases.removeTagFromNode(entityId, tagId, projectId);
      } else if (type === 'element') {
        const element = bookElements.find(el => el.id === entityId);
        if (element) {
          const updatedTags = (element.tags || []).filter((id: string) => id !== tagId);
          await elementUsecases.updateElement(entityId, {
            tags: updatedTags,
          });
        }
      }
      await loadTags();
    } catch (error) {
      log.error('Failed to remove tag:', error);
    }
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;

    try {
      if (type === 'node') {
        await nodeTagUsecases.createAndAddTagToNode(entityId, {
          projectId,
          name: newTagName.trim(),
          color: generateRandomColor(),
        });
      } else if (type === 'element') {
        // Create tag and add to element
        const newTag = await nodeTagUsecases.createTag({
          projectId,
          name: newTagName.trim(),
          color: generateRandomColor(),
        });
        
        const element = bookElements.find(el => el.id === entityId);
        if (element) {
          const updatedTags = [...(element.tags || []), newTag.id];
          await elementUsecases.updateElement(entityId, {
            tags: updatedTags,
          });
        }
      }
      setNewTagName('');
      setIsCreating(false);
      await loadTags();
    } catch (error) {
      log.error('Failed to create tag:', error);
    }
  };

  const generateRandomColor = () => {
    const colors = [
      '#b89968', '#6b9080', '#a3b18a', '#bc6c25',
      '#588157', '#8b7355', '#7a9e9f', '#946b54',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  };

  const availableTags = allTags.filter(
    tag => !entityTags.some(nt => nt.id === tag.id)
  );

  return (
    <div
      style={{
        padding: '12px 16px',
        borderTop: '1px solid rgba(213, 213, 213, 0.3)',
        background: '#fefdfb',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#5a4a3a',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        Tags
      </div>

      {/* Current Tags */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          marginBottom: 8,
        }}
      >
        {entityTags.map((tag) => (
          <div
            key={tag.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 12,
              background: tag.color || '#b89968',
              color: '#fff',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <span>{tag.name}</span>
            <button
              onClick={() => handleRemoveTag(tag.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                width: 14,
                height: 14,
                border: 'none',
                background: 'rgba(255, 255, 255, 0.3)',
                borderRadius: '50%',
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.5)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.3)';
              }}
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>

      {/* Add Tag Button / Dropdown */}
      {!isCreating && !showDropdown && (
        <button
          onClick={() => setShowDropdown(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 12px',
            border: '1px dashed rgba(184, 153, 104, 0.4)',
            borderRadius: 6,
            background: 'transparent',
            color: '#b89968',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(184, 153, 104, 0.05)';
            e.currentTarget.style.borderColor = '#b89968';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.4)';
          }}
        >
          <Plus size={14} />
          <span>Add Tag</span>
        </button>
      )}

      {/* Tag Selection Dropdown */}
      {showDropdown && (
        <div
          style={{
            position: 'relative',
            border: '1px solid rgba(184, 153, 104, 0.3)',
            borderRadius: 6,
            background: '#fff',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {availableTags.length > 0 ? (
            availableTags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => handleAddTag(tag.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '8px 12px',
                  border: 'none',
                  background: 'transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f5f0e8';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: tag.color || '#b89968',
                    marginRight: 8,
                  }}
                />
                <span style={{ fontSize: 13, color: '#2a1a0a' }}>{tag.name}</span>
              </button>
            ))
          ) : (
            <div
              style={{
                padding: '12px',
                fontSize: 12,
                color: '#999',
                textAlign: 'center',
              }}
            >
              No available tags
            </div>
          )}
          
          <button
            onClick={() => {
              setShowDropdown(false);
              setIsCreating(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              borderTop: '1px solid rgba(213, 213, 213, 0.3)',
              background: 'transparent',
              color: '#b89968',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f5f0e8';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <Plus size={14} />
            <span>Create New Tag</span>
          </button>
          
          <button
            onClick={() => setShowDropdown(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              padding: '6px',
              border: 'none',
              borderTop: '1px solid rgba(213, 213, 213, 0.3)',
              background: 'transparent',
              color: '#999',
              fontSize: 11,
              cursor: 'pointer',
              transition: 'background 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f5f0e8';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Create New Tag Input */}
      {isCreating && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCreateTag();
              } else if (e.key === 'Escape') {
                setNewTagName('');
                setIsCreating(false);
              }
            }}
            placeholder="Tag name..."
            autoFocus
            style={{
              flex: 1,
              padding: '6px 10px',
              border: '1px solid rgba(184, 153, 104, 0.3)',
              borderRadius: 4,
              fontSize: 12,
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = '#b89968';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.3)';
            }}
          />
          <button
            onClick={handleCreateTag}
            disabled={!newTagName.trim()}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: 4,
              background: newTagName.trim() ? '#b89968' : '#ccc',
              color: '#fff',
              fontSize: 12,
              fontWeight: 500,
              cursor: newTagName.trim() ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              if (newTagName.trim()) {
                e.currentTarget.style.background = '#a58858';
              }
            }}
            onMouseLeave={(e) => {
              if (newTagName.trim()) {
                e.currentTarget.style.background = '#b89968';
              }
            }}
          >
            Create
          </button>
          <button
            onClick={() => {
              setNewTagName('');
              setIsCreating(false);
            }}
            style={{
              padding: '6px 12px',
              border: '1px solid #ddd',
              borderRadius: 4,
              background: 'transparent',
              color: '#666',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f5f5f5';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
