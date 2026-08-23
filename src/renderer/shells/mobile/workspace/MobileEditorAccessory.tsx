import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
  active,
  mode,
  onModeChange,
  onEditingStateChange,
  onKeyboardInsetChange,
}: {
  active: boolean;
  mode: 'navigation' | 'formatting';
  onModeChange?: (mode: 'navigation' | 'formatting') => void;
  onEditingStateChange?: (editing: boolean) => void;
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
    onEditingStateChange?.(editing);
    return () => onEditingStateChange?.(false);
  }, [editing, onEditingStateChange]);

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
    if (!editorFocused) return;
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

  const keepEditorFocused = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    // Prevent the browser from moving focus away from contenteditable, but do
    // not reflow the whole accessory until this pointer gesture has completed.
    // Reflowing on pointerdown lets iOS retarget the remaining gesture at the
    // newly exposed navigation row and can produce a ghost editor input.
    event.preventDefault();
  }, []);

  if (!active || !editing || !editor || editor.isDestroyed) return null;

  const toggle = () => onModeChange?.(mode === 'formatting' ? 'navigation' : 'formatting');
  const run = (event: ReactPointerEvent<HTMLButtonElement>, action: () => void) => {
    event.preventDefault();
    action();
  };
  return (
    <aside
      className="m-editor-accessory"
      data-mode={mode}
      data-keyboard="true"
      aria-label={t('mobileWorkspace.editorAccessory.label', {
        defaultValue: '编辑样式附件栏',
      })}
    >
      <button
        type="button"
        className="m-editor-accessory__toggle"
        aria-expanded={mode === 'formatting'}
        aria-label={t(
          mode === 'formatting'
            ? 'mobileWorkspace.editorAccessory.collapse'
            : 'mobileWorkspace.editorAccessory.expand',
          { defaultValue: mode === 'formatting' ? '收起格式栏' : '展开格式栏' },
        )}
        onPointerDown={keepEditorFocused}
        onClick={toggle}
      >
        <Type size={18} strokeWidth={1.8} aria-hidden="true" />
        <span>{t('mobileWorkspace.editorAccessory.format', { defaultValue: '格式' })}</span>
      </button>

      {mode === 'formatting' && (
        <div className="m-editor-accessory__actions" role="toolbar">
          {actions.map(({ item, icon: Icon, label }) => (
            <button
              key={item.id}
              type="button"
              className="m-editor-accessory__action"
              aria-label={label}
              aria-pressed={item.isActive?.(editor) ?? false}
              onPointerDown={(event) => run(event, () => item.run(editor))}
              onClick={(event) => {
                if (event.detail === 0) item.run(editor);
              }}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
