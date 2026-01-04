import { MoreVertical } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

export type EditorType = 'node' | 'element' | 'category' | 'thread';

interface EditorContextMenuProps {
  editorType: EditorType;
  onAction: (action: string) => void;
}

export function EditorContextMenu({ editorType, onAction }: EditorContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const getMenuItems = () => {
    switch (editorType) {
      case 'node':
        return [
          { action: 'deleteNode', label: '🗑️ Delete Node', color: '#c04040' },
          { action: 'threadPicker', label: '🔀 Manage Threads', color: '#2a1a0a' },
        ];
      case 'element':
        return [
          { action: 'categoryPicker', label: '📁 Change Category', color: '#2a1a0a' },
          { action: 'deleteElement', label: '🗑️ Delete Element', color: '#c04040' },
        ];
      case 'category':
        return [
          { action: 'deleteCategory', label: '🗑️ Delete Category', color: '#c04040' },
        ];
      case 'thread':
        return [
          { action: 'deleteThread', label: '🗑️ Delete Thread', color: '#c04040' },
          { action: 'mergeThread', label: '🔀 Merge Into...', color: '#2a1a0a' },
        ];
      default:
        return [];
    }
  };

  const menuItems = getMenuItems();

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: 80,
        right: 320,
        zIndex: 150,
      }}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          border: '1px solid var(--accent-border, #e8dcc8)',
          borderRadius: 8,
          background: isOpen ? 'var(--accent, #b89968)' : '#fefdfb',
          color: isOpen ? '#fefdfb' : '#5a4a3a',
          cursor: 'pointer',
          transition: 'all 0.2s',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
        }}
        onMouseEnter={(e) => {
          if (!isOpen) {
            e.currentTarget.style.background = '#f5f0e8';
          }
        }}
        onMouseLeave={(e) => {
          if (!isOpen) {
            e.currentTarget.style.background = '#fefdfb';
          }
        }}
      >
        <MoreVertical size={18} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            right: 0,
            minWidth: 200,
            background: '#fefdfb',
            border: '1px solid var(--accent-border, #e8dcc8)',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(42, 26, 10, 0.15)',
            overflow: 'hidden',
          }}
        >
          {menuItems.map((item) => (
            <button
              key={item.action}
              onClick={() => {
                onAction(item.action);
                setIsOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '12px 16px',
                border: 'none',
                background: 'transparent',
                color: item.color,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = item.color === '#c04040' ? '#fff0f0' : '#f5f0e8';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
