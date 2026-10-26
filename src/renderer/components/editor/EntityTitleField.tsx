import type { TextareaHTMLAttributes } from 'react';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import { isComposingEnter, stripTitleNewlines } from './entity-title-input';

type EntityTitleFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'value'> & {
  value: string;
};

/**
 * Entity page title: a single logical line that wraps across the page width
 * instead of being clipped like an `<input>`. Enter never inserts a newline
 * (callers commit on it), pasted newlines become spaces, and Enter while an
 * IME is composing is left to the IME.
 */
export function EntityTitleField({ value, onChange, onKeyDown, ...props }: EntityTitleFieldProps) {
  const ref = useAutosizeTextArea(value);
  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      value={value}
      onChange={(event) => {
        const field = event.currentTarget;
        const stripped = stripTitleNewlines(field.value);
        if (stripped !== field.value) {
          const caret = field.selectionStart;
          field.value = stripped;
          field.setSelectionRange(caret, caret);
        }
        onChange?.(event);
      }}
      onKeyDown={(event) => {
        if (isComposingEnter(event)) return;
        if (event.key === 'Enter') event.preventDefault();
        onKeyDown?.(event);
      }}
    />
  );
}
