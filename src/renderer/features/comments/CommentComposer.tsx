import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { GlassSlider } from '../../components/ui/GlassSlider';

/**
 * A floating composer for a new anchored note or TODO: a region just drawn on
 * an image or PDF, or a passage selected in the prose (portaled, fixed, beside
 * the point it was asked from).
 */
export function CommentComposer({
  anchor,
  label,
  placeholder,
  onSubmit,
  onCancel,
}: {
  anchor: { x: number; y: number };
  label: string;
  placeholder: string;
  onSubmit: (body: string, asTodo: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [asTodo, setAsTodo] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => ({ left: anchor.x + 12, top: anchor.y + 12 }));

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(anchor.x + 12, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(anchor.y + 12, window.innerHeight - height - 12)),
    });
  }, [anchor.x, anchor.y]);

  const submit = () => {
    if (body.trim()) onSubmit(body.trim(), asTodo);
  };
  const textarea = (
    <textarea
      autoFocus
      value={body}
      placeholder={placeholder}
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
        }
      }}
    />
  );
  // A floating layer with a paper field, the note/TODO choice as one of a
  // set, cancel as a text button and save as the primary glass.
  return createPortal(
    <div ref={ref} className="comment-composer comment-composer--float" style={position} role="dialog" aria-label={label}>
      <label className="ui-field ui-field--area comment-composer__field glass glass--rest glass--field">{textarea}</label>
      <div className="comment-composer__actions">
        <GlassSlider
          ariaLabel={t('materialEditor.regions.kindLabel')}
          value={asTodo ? 'todo' : 'note'}
          onChange={(kind) => setAsTodo(kind === 'todo')}
          options={[
            { value: 'note', label: t('materialEditor.regions.kindNote') },
            { value: 'todo', label: t('materialEditor.regions.kindTodo') },
          ]}
        />
        <span className="comment-composer__spacer" />
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="sm" variant="primary" disabled={!body.trim()} onClick={submit}>
          {t('materialEditor.regions.save')}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
