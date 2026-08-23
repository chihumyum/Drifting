import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
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
import {
  MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT,
  readMobileKeyboardInset,
  readMobileSoftwareKeyboardVisible,
} from './mobile-keyboard-geometry';

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
  expanded,
  onExpandedChange,
  onEditingStateChange,
  onKeyboardStateChange,
  onKeyboardInsetChange,
}: {
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onEditingStateChange?: (editing: boolean) => void;
  onKeyboardStateChange?: (keyboard: 'closed' | 'open') => void;
  onKeyboardInsetChange?: (inset: number) => void;
}) {
  const { t } = useTranslation();
  const editor = useSyncExternalStore(subscribeActiveEditor, getActiveEditor, () => null);
  const [focusedEditor, setFocusedEditor] = useState<Editor | null>(() => {
    const current = getActiveEditor();
    return current?.isFocused ? current : null;
  });
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [softwareKeyboardVisible, setSoftwareKeyboardVisible] = useState(false);
  const [, setRevision] = useState(0);
  const editing = Boolean(editor && !editor.isDestroyed && focusedEditor === editor);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let cancelled = false;

    const syncFocus = () => {
      const focused = editor.isFocused;
      setFocusedEditor((current) => (focused ? editor : current === editor ? null : current));
      if (!focused) {
        setKeyboardInset(0);
        setSoftwareKeyboardVisible(false);
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

  const keyboardVisible = editing && softwareKeyboardVisible;

  useEffect(() => {
    onKeyboardStateChange?.(keyboardVisible ? 'open' : 'closed');
    return () => onKeyboardStateChange?.('closed');
  }, [keyboardVisible, onKeyboardStateChange]);

  useEffect(() => {
    onKeyboardInsetChange?.(keyboardInset);
  }, [keyboardInset, onKeyboardInsetChange]);

  useEffect(
    () => () => {
      onKeyboardInsetChange?.(0);
    },
    [onKeyboardInsetChange],
  );

  useEffect(() => {
    if (!editing) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const syncInset = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setKeyboardInset(readMobileKeyboardInset());
        setSoftwareKeyboardVisible(readMobileSoftwareKeyboardVisible(KEYBOARD_INSET_THRESHOLD));
      });
    };
    syncInset();
    viewport?.addEventListener('resize', syncInset);
    viewport?.addEventListener('scroll', syncInset);
    window.addEventListener('resize', syncInset);
    window.addEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, syncInset);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', syncInset);
      viewport?.removeEventListener('scroll', syncInset);
      window.removeEventListener('resize', syncInset);
      window.removeEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, syncInset);
    };
  }, [editing]);

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

  const toggle = () => onExpandedChange?.(!expanded);
  return (
    <aside
      className="m-editor-accessory"
      data-expanded={expanded ? 'true' : 'false'}
      data-keyboard={keyboardVisible ? 'true' : 'false'}
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

      <span className="m-editor-accessory__label">
        {t('mobileWorkspace.editorAccessory.expand', { defaultValue: '格式' })}
      </span>
    </aside>
  );
}

export function MobileFormattingSheetContent() {
  const { t } = useTranslation();
  const editor = useSyncExternalStore(subscribeActiveEditor, getActiveEditor, () => null);
  const [, setRevision] = useState(0);
  const actions = useMemo<AccessoryAction[]>(() => {
    const items = [...getBlockFormatItems(), ...getInlineFormatItems()];
    return items.flatMap((item) => {
      const icon = ICON_BY_ACTION[item.id];
      const key = KEY_BY_ACTION[item.id];
      if (!icon || !key) return [];
      return [{ item, icon, label: t(`mobileWorkspace.editorAccessory.${key}`, { defaultValue: item.title }) }];
    });
  }, [t]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    const update = () => setRevision((revision) => revision + 1);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor]);

  if (!editor || editor.isDestroyed) {
    return <p className="m-bar-sheet__empty">{t('editorMainArea.emptyHint')}</p>;
  }

  const run = (event: ReactPointerEvent<HTMLButtonElement>, action: () => void) => {
    event.preventDefault();
    action();
  };
  return (
    <div className="m-format-sheet" role="toolbar">
      {actions.map(({ item, icon: Icon, label }) => (
        <button
          key={item.id}
          type="button"
          aria-label={label}
          aria-pressed={item.isActive?.(editor) ?? false}
          onPointerDown={(event) => run(event, () => item.run(editor))}
          onClick={(event) => {
            if (event.detail === 0) item.run(editor);
          }}
        >
          <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
