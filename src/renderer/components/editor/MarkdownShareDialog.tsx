import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Copy, Download, FileText, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../platform';
import type { MarkdownShareDocument, MarkdownShareTarget } from '../../services/export/markdown-share';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';
import '../../../styles/markdown-share.css';

export function MarkdownShareDialog({ target, onClose }: {
  target: MarkdownShareTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<MarkdownShareDocument | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<'copy' | 'save' | null>(null);
  const [feedback, setFeedback] = useState<'copied' | 'saved' | 'failed' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    alive.current = true;
    const previous = window.document.activeElement;
    rootRef.current?.focus();
    return () => {
      alive.current = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void import('../../services/export/markdown-share.service')
      .then(module => module.readMarkdownShare(target, controller.signal))
      .then(result => { if (!controller.signal.aborted) setDocument(result); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [target, attempt]);

  useEffect(() => {
    if (document) textRef.current?.focus();
  }, [document]);

  const run = async (kind: 'copy' | 'save') => {
    if (!document || busy.current) return;
    busy.current = true;
    setAction(kind);
    setFeedback(null);
    try {
      if (kind === 'copy') {
        await navigator.clipboard.writeText(document.markdown);
        if (alive.current) setFeedback('copied');
      } else {
        const result = await platform.sharing.saveMarkdown(document.filename, document.markdown);
        if (alive.current) {
          if (result.ok) setFeedback('saved');
          else if (!result.canceled) setFeedback('failed');
        }
      }
    } catch {
      if (alive.current) setFeedback('failed');
    } finally {
      busy.current = false;
      if (alive.current) setAction(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keep workspace/editor shortcuts outside the read-only Markdown surface.
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && textRef.current) {
      event.preventDefault();
      textRef.current.focus();
      textRef.current.select();
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea') ?? []);
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = window.document.activeElement;
    if (event.shiftKey && (active === first || active === rootRef.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (active === last || active === rootRef.current)) {
      event.preventDefault(); first?.focus();
    }
  };

  return (
    <ModalRoot onClose={onClose} ariaLabel={t('markdownShare.title')} className="markdown-share-root">
      <ModalCard width={800}>
        <div ref={rootRef} tabIndex={-1} className="markdown-share" onKeyDown={handleKeyDown}>
          <ModalHeader title={t('markdownShare.title')} onClose={onClose} closeLabel={t('common.close')}
            subtitle={target.kind === 'book' ? t('markdownShare.wholeBook') : t('markdownShare.currentBody')} />
          <ModalBody className="markdown-share__body">
            <div className="markdown-share__meta">
              <FileText size={15} aria-hidden="true" />
              <strong>{document?.filename ?? `${target.title}.md`}</strong>
              <span>{t('markdownShare.readOnly')}</span>
            </div>
            {document ? (
              <textarea ref={textRef} className="markdown-share__text" readOnly spellCheck={false}
                aria-label={t('markdownShare.preview')} value={document.markdown} />
            ) : (
              <div className="markdown-share__placeholder" role={error ? 'alert' : 'status'}>
                <p>{t(error ? 'markdownShare.loadFailed' : 'markdownShare.loading')}</p>
                {error && <Button onClick={() => { setError(false); setAttempt(value => value + 1); }}><RotateCcw size={14} />{t('markdownShare.retry')}</Button>}
              </div>
            )}
            <div className="markdown-share__caption">
              <span>{t('markdownShare.proseOnly')}</span>
              {document && <span>{t('markdownShare.characters', { count: document.markdown.length })}</span>}
            </div>
          </ModalBody>
          <ModalActions>
            <span className="markdown-share__feedback" role={feedback === 'failed' ? 'alert' : 'status'}>
              {feedback && t(`markdownShare.${feedback}`)}
            </span>
            <Button disabled={!document || action !== null} onClick={() => void run('save')}>
              <Download size={14} />{t(action === 'save' ? 'markdownShare.saving' : 'markdownShare.save')}
            </Button>
            <Button variant="primary" disabled={!document || action !== null} onClick={() => void run('copy')}>
              <Copy size={14} />{t(action === 'copy' ? 'markdownShare.copying' : 'markdownShare.copy')}
            </Button>
          </ModalActions>
        </div>
      </ModalCard>
    </ModalRoot>
  );
}
