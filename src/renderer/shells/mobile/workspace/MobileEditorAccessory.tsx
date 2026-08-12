import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Pilcrow,
  Quote,
  Strikethrough,
  Type,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getActiveEditor, subscribeActiveEditor } from '../../../lib/active-editor';
import {
  getBlockFormatItems,
  getInlineFormatItems,
  type BlockFormatItem,
} from '../../../lib/slash-menu';
import { readMobileKeyboardInset } from './mobile-keyboard-geometry';

interface AccessoryAction {
  item: BlockFormatItem;
  icon: LucideIcon;
  label: string;
}

const ICON_BY_ACTION: Record<string, LucideIcon> = {
  paragraph: Pilcrow,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  blockquote: Quote,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  strike: Strikethrough,
};

const KEY_BY_ACTION: Record<string, string> = {
  paragraph: 'paragraph',
  h1: 'heading1',
  h2: 'heading2',
  h3: 'heading3',
  blockquote: 'blockquote',
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
};

const KEYBOARD_INSET_THRESHOLD = 72;

export function MobileEditorAccessory({
  onEditingStateChange,
}: {
  onEditingStateChange?: (editing: boolean) => void;
}) {
  const { t } = useTranslation();
  const editor = useSyncExternalStore(subscribeActiveEditor, getActiveEditor, () => null);
  const [focusedEditor, setFocusedEditor] = useState<Editor | null>(() => {
    const current = getActiveEditor();
    return current?.isFocused ? current : null;
  });
  const [expanded, setExpanded] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [, setRevision] = useState(0);
  const editing = Boolean(editor && !editor.isDestroyed && focusedEditor === editor);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let cancelled = false;

    const syncFocus = () => {
      const focused = editor.isFocused;
      setFocusedEditor((current) => (focused ? editor : current === editor ? null : current));
      if (!focused) {
        setExpanded(false);
        setKeyboardInset(0);
      }
      setRevision((revision) => revision + 1);
    };
    const syncFormat = () => setRevision((revision) => revision + 1);

    queueMicrotask(() => {
      if (!cancelled) syncFocus();
    });
    editor.on('focus', syncFocus);
    editor.on('blur', syncFocus);
    editor.on('selectionUpdate', syncFormat);
    editor.on('transaction', syncFormat);
    return () => {
      cancelled = true;
      editor.off('focus', syncFocus);
      editor.off('blur', syncFocus);
      editor.off('selectionUpdate', syncFormat);
      editor.off('transaction', syncFormat);
    };
  }, [editor]);

  useEffect(() => {
    onEditingStateChange?.(editing);
    return () => onEditingStateChange?.(false);
  }, [editing, onEditingStateChange]);

  useEffect(() => {
    if (!editing) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const syncInset = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setKeyboardInset(readMobileKeyboardInset()));
    };
    syncInset();
    viewport?.addEventListener('resize', syncInset);
    viewport?.addEventListener('scroll', syncInset);
    window.addEventListener('resize', syncInset);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', syncInset);
      viewport?.removeEventListener('scroll', syncInset);
      window.removeEventListener('resize', syncInset);
    };
  }, [editing]);

  const actions = useMemo<AccessoryAction[]>(() => {
    const items = [...getBlockFormatItems(), ...getInlineFormatItems()];
    return items.flatMap((item) => {
      const icon = ICON_BY_ACTION[item.id];
      const key = KEY_BY_ACTION[item.id];
      if (!icon || !key) return [];
      return [
        {
          item,
          icon,
          label: t(`mobileWorkspace.editorAccessory.${key}`, {
            defaultValue: item.title,
          }),
        },
      ];
    });
  }, [t]);

  const keepEditorFocused = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, action: () => void) => {
      // Execute before a mobile browser can move focus from contenteditable to
      // the button. The matching click is ignored; keyboard-triggered clicks
      // still use onClick below (detail === 0).
      event.preventDefault();
      action();
    },
    [],
  );

  if (!editing || !editor || editor.isDestroyed) return null;

  const toggle = () => setExpanded((current) => !current);
  const style = {
    '--m-editor-keyboard-inset': `${keyboardInset}px`,
  } as CSSProperties;
  const keyboardVisible = keyboardInset >= KEYBOARD_INSET_THRESHOLD;

  return createPortal(
    <aside
      className="m-editor-accessory"
      data-expanded={expanded ? 'true' : 'false'}
      data-keyboard={keyboardVisible ? 'true' : 'false'}
      style={style}
      aria-label={t('mobileWorkspace.editorAccessory.label', {
        defaultValue: '编辑样式附件栏',
      })}
    >
      <button
        type="button"
        className="m-editor-accessory__toggle"
        aria-expanded={expanded}
        aria-label={t(
          expanded
            ? 'mobileWorkspace.editorAccessory.collapse'
            : 'mobileWorkspace.editorAccessory.expand',
          { defaultValue: expanded ? '收起格式栏' : '展开格式栏' },
        )}
        onPointerDown={(event) => keepEditorFocused(event, toggle)}
        onClick={(event) => {
          if (event.detail === 0) toggle();
        }}
      >
        <Type size={20} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="m-editor-accessory__actions" role="toolbar">
          {actions.map(({ item, icon: Icon, label }) => (
            <button
              key={item.id}
              type="button"
              className="m-editor-accessory__action"
              aria-label={label}
              aria-pressed={item.isActive?.(editor) ?? false}
              onPointerDown={(event) => keepEditorFocused(event, () => item.run(editor))}
              onClick={(event) => {
                if (event.detail === 0) item.run(editor);
              }}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </aside>,
    document.body,
  );
}
