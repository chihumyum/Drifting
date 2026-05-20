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
  const rootRef = useRef<HTMLSpanElement>(null);
  const className = dotColor ? 'editor-crumb editor-crumb-storyline' : 'editor-crumb';
  const style = dotColor ? ({ ['--crumb-color' as string]: dotColor } as React.CSSProperties) : undefined;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const active = document.activeElement;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) {
        active.blur();
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open]);

  const handleClick = () => {
    if (dropdown) {
      setOpen((prev) => !prev);
    } else {
      onClick?.();
    }
  };

  return (
    <span ref={rootRef} className={className} style={style} onClick={handleClick}>
      {dotColor && <span className="editor-crumb-dot" />}
      {children}
      {open && dropdown && (
        <div className="crumb-dropdown" onClick={() => setOpen(false)}>
          {dropdown}
        </div>
      )}
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
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) buttonRef.current?.blur();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      buttonRef.current?.blur();
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isOpen]);

  const items = getMenuItems(editorType);
  if (items.length === 0) return null;

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        className="editor-bar__icon"
        title="More actions"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <MoreVertical size={14} />
      </button>

      {isOpen && (
        <div className="editor-bar__menu">
          {items.map((item) => (
            <button
              key={item.action}
              type="button"
              className={`editor-bar__menu-item${item.danger ? ' editor-bar__menu-item--danger' : ''}`}
              onClick={() => {
                onAction(item.action);
                setIsOpen(false);
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

interface MenuItem {
  action: string;
  label: string;
  danger?: boolean;
}

function getMenuItems(editorType: EditorType): MenuItem[] {
  switch (editorType) {
    case 'node':
      return [
        { action: 'editNodeStorylines', label: 'Edit Storylines' },
        { action: 'deleteNode', label: 'Delete Node', danger: true },
      ];
    case 'element':
      return [
        { action: 'categoryPicker', label: 'Change Category' },
        { action: 'deleteElement', label: 'Delete Element', danger: true },
      ];
    case 'category':
      return [{ action: 'deleteCategory', label: 'Delete Category', danger: true }];
    case 'storyline':
      return [
        { action: 'mergeStoryline', label: 'Merge Into...' },
        { action: 'deleteStoryline', label: 'Delete Storyline', danger: true },
      ];
    default:
      return [];
  }
}
