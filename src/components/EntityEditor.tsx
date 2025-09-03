import { useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEntitiesStore } from '../store/entities';
import { X, Save } from 'lucide-react';

interface EntityEditorProps {
  entityId: string;
  onClose: () => void;
}

export function EntityEditor({ entityId, onClose }: EntityEditorProps) {
  const { entities, updateEntity } = useEntitiesStore();
  const entity = entities.find(e => e.id === entityId);
  
  const [name, setName] = useState(entity?.name || '');
  const [type, setType] = useState(entity?.type || '');
  const [color, setColor] = useState(entity?.color || '#e3f2fd');

  const editor = useEditor({
    extensions: [StarterKit],
    content: entity?.description || '',
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none min-h-[200px] p-4',
      },
    },
  });

  useEffect(() => {
    if (entity && editor) {
      editor.commands.setContent(entity.description || '');
      setName(entity.name);
      setType(entity.type);
      setColor(entity.color || '#e3f2fd');
    }
  }, [entity, editor]);

  const handleSave = () => {
    if (!entity || !editor) return;
    
    updateEntity(entityId, {
      name,
      type,
      color,
      description: editor.getHTML()
    });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  if (!entity) {
    return null;
  }

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div 
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          width: '90%',
          maxWidth: '800px',
          maxHeight: '90vh',
          overflow: 'hidden',
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 24px',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#f8f9fa'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Entity name"
              style={{
                fontSize: '18px',
                fontWeight: 'bold',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                minWidth: '200px'
              }}
            />
            <input
              type="text"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="Type"
              style={{
                fontSize: '14px',
                padding: '4px 8px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                backgroundColor: color,
                minWidth: '100px'
              }}
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{
                width: '32px',
                height: '32px',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            />
          </div>
          
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleSave}
              style={{
                padding: '8px 16px',
                backgroundColor: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '14px'
              }}
            >
              <Save size={16} />
              Save
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '8px',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: '4px'
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          minHeight: '300px'
        }}>
          <div style={{
            padding: '16px',
            fontSize: '14px',
            color: '#666',
            borderBottom: '1px solid #e0e0e0'
          }}>
            Description and Notes
          </div>
          
          {editor && (
            <div style={{ minHeight: '250px' }}>
              <EditorContent 
                editor={editor}
                style={{
                  minHeight: '250px'
                }}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 24px',
          borderTop: '1px solid #e0e0e0',
          backgroundColor: '#f8f9fa',
          fontSize: '12px',
          color: '#666',
          display: 'flex',
          justifyContent: 'space-between'
        }}>
          <span>Press Ctrl/Cmd + S to save, Esc to close</span>
          <span>Entity ID: {entityId}</span>
        </div>
      </div>
    </div>
  );
}