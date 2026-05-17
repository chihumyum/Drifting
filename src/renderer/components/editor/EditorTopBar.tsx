import { MoreVertical } from 'lucide-react';
import {
  Children,
  Fragment,
  ReactNode,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from 'react';

export type EditorType = 'node' | 'element' | 'category' | 'storyline';

/*
  Shared editor top bar:
  - Breadcrumb area on the left, built from <EditorCrumb> children
  - Free-form right slot (word count, counts, etc.)
  - Integrated three-dot menu driven by `editorType` + `onMenuAction`
*/

interface EditorTopBarProps {
  children?: ReactNode;
  right?: ReactNode;
  editorType?: EditorType;
  onMenuAction?: (action: string) => void;
}

export function EditorTopBar({ children, right, editorType, onMenuAction }: EditorTopBarProps) {
  const crumbs = injectSeparators(children);
  const showMenu = Boolean(editorType && onMenuAction);

  return (
    <div className="editor-bar">
      <div className="editor-crumbs">{crumbs}</div>
      <div className="editor-bar__right">
        {right}
        {showMenu && editorType && onMenuAction && (
          <EditorBarMenu editorType={editorType} onAction={onMenuAction} />
        )}
      </div>
    </div>
  );
}

function injectSeparators(children: ReactNode): ReactNode {
  const items = Children.toArray(children).filter(
    (child) => isValidElement(child) || typeof child === 'string',
  );
  return items.map((child, index) => (
    <Fragment key={index}>
      {index > 0 && <span className="editor-bar__sep">›</span>}
      {child}
    </Fragment>
  ));
}

interface EditorCrumbProps {
  children: ReactNode;
  dotColor?: string;
  dropdown?: ReactNode;
  onClick?: () => void;
}

export function EditorCrumb({ children, dotColor, dropdown, onClick }: EditorCrumbProps) {
  const [open, setOpen] = useState(false);
  const className = dotColor ? 'editor-crumb editor-crumb-storyline' : 'editor-crumb';
  const style = dotColor ? ({ ['--crumb-color' as string]: dotColor } as React.CSSProperties) : undefined;

  return (
    <span
      className={className}
      style={style}
      onMouseEnter={() => dropdown && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={onClick}
    >
      {dotColor && <span className="editor-crumb-dot" />}
      {children}
      {open && dropdown && <div className="crumb-dropdown">{dropdown}</div>}
    </span>
  );
}

interface EditorBarMenuProps {
  editorType: EditorType;
  onAction: (action: string) => void;
}

function EditorBarMenu({ editorType, onAction }: EditorBarMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const items = getMenuItems(editorType);
  if (items.length === 0) return null;

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="editor-bar__icon"
        title="More actions"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <MoreVertical size={14} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 200,
            background: '#fefdfb',
            border: '1px solid var(--accent-border, #e8dcc8)',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(42, 26, 10, 0.15)',
            overflow: 'hidden',
            zIndex: 60,
            textTransform: 'none',
            letterSpacing: 'normal',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {items.map((item) => (
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

function getMenuItems(editorType: EditorType) {
  switch (editorType) {
    case 'node':
      return [
        { action: 'editNodeStorylines', label: 'Edit Storylines', color: '#2a1a0a' },
        { action: 'deleteNode', label: 'Delete Node', color: '#c04040' },
      ];
    case 'element':
      return [
        { action: 'categoryPicker', label: 'Change Category', color: '#2a1a0a' },
        { action: 'deleteElement', label: 'Delete Element', color: '#c04040' },
      ];
    case 'category':
      return [{ action: 'deleteCategory', label: 'Delete Category', color: '#c04040' }];
    case 'storyline':
      return [
        { action: 'mergeStoryline', label: 'Merge Into...', color: '#2a1a0a' },
        { action: 'deleteStoryline', label: 'Delete Storyline', color: '#c04040' },
      ];
    default:
      return [];
  }
}
