import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
  Undo2,
  Redo2,
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
  readMobileKeyboardViewportOffsetTop,
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
  active,
  mode,
  onModeChange,
  onEditingStateChange,
  onKeyboardInsetChange,
  onKeyboardViewportOffsetTopChange,
}: {
  active: boolean;
  mode: 'navigation' | 'formatting';
  onModeChange?: (mode: 'navigation' | 'formatting') => void;
  onEditingStateChange?: (editing: boolean) => void;
  onKeyboardInsetChange?: (inset: number) => void;
  onKeyboardViewportOffsetTopChange?: (offsetTop: number) => void;
}) {
  const { t } = useTranslation();
  const editor = useSyncExternalStore(subscribeActiveEditor, getActiveEditor, () => null);
  const [focusedEditor, setFocusedEditor] = useState<Editor | null>(() => {
    const current = getActiveEditor();
    return current?.isFocused ? current : null;
  });
  // This component remounts when Search hands focus back to the editor. Seed
  // the still-open IME synchronously; reporting a default false first would
  // immediately collapse the restored edit state back to read.
  const [keyboardInset, setKeyboardInset] = useState(() => readMobileKeyboardInset());
  const [keyboardViewportOffsetTop, setKeyboardViewportOffsetTop] = useState(() =>
    readMobileKeyboardViewportOffsetTop(KEYBOARD_INSET_THRESHOLD),
  );
  const [softwareKeyboardVisible, setSoftwareKeyboardVisible] = useState(() =>
    readMobileSoftwareKeyboardVisible(KEYBOARD_INSET_THRESHOLD),
  );
  const observedKeyboardWhileFocusedRef = useRef(false);
  const [, setRevision] = useState(0);
  const editorFocused = Boolean(editor && !editor.isDestroyed && focusedEditor === editor);
  const editing = editorFocused && softwareKeyboardVisible;
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
          label: t(`mobileWorkspace.editorAccessory.${key}`, { defaultValue: item.title }),
        },
      ];
    });
  }, [t]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let cancelled = false;

    const syncFocus = () => {
      const focused = editor.isFocused;
      setFocusedEditor((current) => (focused ? editor : current === editor ? null : current));
      if (!focused) {
        setKeyboardInset(0);
        setKeyboardViewportOffsetTop(0);
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

  useLayoutEffect(() => {
    // Returning from Agent can focus prose before the native IME reopens. Do
    // not erase the restored accessory level during that opening interval.
    // Unmounting for another input owner is not an editor-blur notification.
    if (editing || !editorFocused) onEditingStateChange?.(editing);
  }, [editing, editorFocused, onEditingStateChange]);

  useEffect(() => {
    onKeyboardInsetChange?.(keyboardInset);
  }, [keyboardInset, onKeyboardInsetChange]);

  useEffect(() => {
    onKeyboardViewportOffsetTopChange?.(keyboardViewportOffsetTop);
  }, [keyboardViewportOffsetTop, onKeyboardViewportOffsetTopChange]);

  useEffect(() => {
    if (!editorFocused) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const syncInset = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setKeyboardInset(readMobileKeyboardInset());
        setKeyboardViewportOffsetTop(readMobileKeyboardViewportOffsetTop());
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
  }, [editorFocused]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    if (!editorFocused) {
      observedKeyboardWhileFocusedRef.current = false;
      return undefined;
    }
    if (softwareKeyboardVisible) {
      observedKeyboardWhileFocusedRef.current = true;
      return undefined;
    }
    if (observedKeyboardWhileFocusedRef.current) {
      editor.commands.blur();
      return undefined;
    }

    // A tap focuses WebKit before visualViewport/native IME geometry catches
    // up. Give the software keyboard one short opening window; if it never
    // appears, remove the caret instead of leaving a stable focus/read hybrid.
    const timer = window.setTimeout(() => {
      if (
        editor.isFocused &&
        !readMobileSoftwareKeyboardVisible(KEYBOARD_INSET_THRESHOLD)
      ) {
        editor.commands.blur();
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [editor, editorFocused, softwareKeyboardVisible]);

  if (!active || !editing || !editor || editor.isDestroyed) return null;

  const historyActions = [
    { id: 'undo', label: t('mobileWorkspace.editorAccessory.undo'), Icon: Undo2,
      run: () => editor.commands.undo(), available: editor.can().undo() },
    { id: 'redo', label: t('mobileWorkspace.editorAccessory.redo'), Icon: Redo2,
      run: () => editor.commands.redo(), available: editor.can().redo() },
  ];
  return (
    <aside
      className="m-editor-accessory"
      data-mode={mode}
      data-keyboard="true"
      aria-label={t('mobileWorkspace.editorAccessory.label', {
        defaultValue: '编辑样式附件栏',
      })}
    >
      {historyActions.filter(({ available }) => available).map(({ id, label, Icon, run }) => (
        <button key={id} type="button" className="m-editor-accessory__action"
          data-debug-id={`mobile-editor-${id}`} aria-label={label}
          disabled={editor.view.composing} onClick={() => { if (!editor.view.composing) run(); }}>
          <Icon size={18} />
        </button>
      ))}
      {mode === 'navigation' && (
        <button type="button" className="m-editor-accessory__toggle"
          data-debug-id="mobile-toggle-formatting" aria-expanded="false"
          aria-label={t('mobileWorkspace.editorAccessory.expand', { defaultValue: '展开格式栏' })}
          onClick={() => onModeChange?.('formatting')}>
          <Type size={18} strokeWidth={1.8} aria-hidden="true" />
          <span>{t('mobileWorkspace.editorAccessory.format', { defaultValue: '格式' })}</span>
        </button>
      )}

      {mode === 'formatting' && (
        <div className="m-editor-accessory__actions" role="toolbar">
          {actions.map(({ item, icon: Icon, label }) => (
            <button
              key={item.id}
              type="button"
              className="m-editor-accessory__action"
              aria-label={label}
              aria-pressed={item.isActive?.(editor) ?? false}
              data-debug-id={`mobile-format-${item.id}`}
              disabled={editor.view.composing}
              onClick={() => { if (!editor.view.composing) item.run(editor); }}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
