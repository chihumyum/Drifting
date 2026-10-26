import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, ImagePlus, Loader2, Maximize2, Sparkles, Trash2 } from 'lucide-react';
import { AnchoredPopover } from '../../components/ui/AnchoredPopover';
import type { ImageInboxEntry } from '../../platform';
import { ElementImageCandidates } from './ElementImageCandidates';
import { ElementImageGenerateForm } from './ElementImageGenerateForm';
import type { useElementImageWorkflow } from './useElementImageWorkflow';

interface ElementImageEntryProps {
  /** Loaded display URL of the element image, when there is one. */
  imageUrl: string | null;
  /** An image is bound even if its URL is still loading or failed. */
  hasImage: boolean;
  busy: boolean;
  error: string | null;
  onViewLarge: () => void;
  onImportFromFile: () => void;
  onRemove: () => void;
  workflow: ReturnType<typeof useElementImageWorkflow>;
}

/**
 * The element image entry in the editor top bar, left of the outline toggle.
 * Every image action lives behind it: the large image, its candidates, file
 * import/replacement, removal and generation. The button shows the image as
 * a thumbnail, a spinner while the Agent generates and the candidate count.
 */
export function ElementImageEntry({
  imageUrl,
  hasImage,
  busy,
  error,
  onViewLarge,
  onImportFromFile,
  onRemove,
  workflow,
}: ElementImageEntryProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'generate'>('main');
  const candidateCount = workflow.candidateProps.candidates.length;
  const generating = workflow.generationState !== 'idle';
  const label = t('elementEditor.imageEntry.label');

  const close = () => {
    setOpen(false);
    setView('main');
  };
  const closeThen = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`editor-bar__icon editor-bar__icon--image${open ? ' editor-bar__icon--active' : ''}${imageUrl ? ' editor-bar__icon--thumb' : ''}`}
        title={generating ? t('elementEditor.imageGeneration.running') : label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {imageUrl ? (
          <img className="editor-bar__thumb" src={imageUrl} alt="" />
        ) : (
          <ImageIcon size={14} />
        )}
        {generating ? (
          <span className="editor-bar__spinner" aria-hidden>
            <Loader2 size={10} />
          </span>
        ) : candidateCount > 0 ? (
          <span className="editor-bar__badge">{candidateCount}</span>
        ) : null}
      </button>
      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-end"
        className="elem-image-menu"
        ariaLabel={label}
      >
        {view === 'generate' ? (
          <ElementImageGenerateForm
            {...workflow.formProps}
            onSubmit={(request) => {
              workflow.formProps.onSubmit(request);
              close();
            }}
            onCancel={() => setView('main')}
          />
        ) : (
          <div className="elem-image-menu__body">
            {imageUrl ? (
              <button
                type="button"
                className="elem-image-menu__art"
                onClick={closeThen(onViewLarge)}
                title={t('elementEditor.portrait.view')}
              >
                <img src={imageUrl} alt="" />
              </button>
            ) : hasImage && !error ? (
              <div className="elem-image-menu__art elem-image-menu__art--pending">
                {t('elementEditor.portrait.loading')}
              </div>
            ) : null}
            {error && (
              <div className="elem-portrait__error" role="alert">
                {error}
              </div>
            )}
            <ElementImageCandidates
              {...workflow.candidateProps}
              onOpenSession={closeThen(workflow.candidateProps.onOpenSession)}
              onPreview={(candidate: ImageInboxEntry) => {
                close();
                workflow.candidateProps.onPreview(candidate);
              }}
            />
            <div className="elem-image-menu__actions">
              <button
                type="button"
                className="elem-image-menu__action"
                onClick={() => {
                  workflow.prepareGenerate();
                  setView('generate');
                }}
              >
                <Sparkles size={14} aria-hidden />
                {t('elementEditor.imageEntry.generate')}
              </button>
              <button
                type="button"
                className="elem-image-menu__action"
                disabled={busy}
                onClick={closeThen(onImportFromFile)}
              >
                <ImagePlus size={14} aria-hidden />
                {t(hasImage ? 'elementEditor.imageEntry.replaceFromFile' : 'elementEditor.imageEntry.addFromFile')}
              </button>
              {imageUrl && (
                <button type="button" className="elem-image-menu__action" onClick={closeThen(onViewLarge)}>
                  <Maximize2 size={14} aria-hidden />
                  {t('elementEditor.portrait.view')}
                </button>
              )}
              {hasImage && (
                <button
                  type="button"
                  className="elem-image-menu__action elem-image-menu__action--danger"
                  disabled={busy}
                  onClick={closeThen(onRemove)}
                >
                  <Trash2 size={14} aria-hidden />
                  {t('elementEditor.imageEntry.remove')}
                </button>
              )}
            </div>
          </div>
        )}
      </AnchoredPopover>
    </>
  );
}
