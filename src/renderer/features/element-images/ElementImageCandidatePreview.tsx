import { useTranslation } from 'react-i18next';
import { ModalActions, ModalBody, ModalCard, ModalRoot } from '../../components/ui/Modal';
import type { ImageInboxEntry } from '../../platform';

interface ElementImageCandidatePreviewProps {
  candidate: ImageInboxEntry;
  busy: boolean;
  onClose: () => void;
  onSetPortrait: (candidate: ImageInboxEntry) => void;
  onKeep: (candidate: ImageInboxEntry) => void;
}

/** Full-size look at one candidate with the prompt that produced it. */
export function ElementImageCandidatePreview({
  candidate,
  busy,
  onClose,
  onSetPortrait,
  onKeep,
}: ElementImageCandidatePreviewProps) {
  const { t } = useTranslation();
  const { provenance } = candidate;
  return (
    <ModalRoot onClose={onClose} ariaLabel={t('elementEditor.imageGeneration.candidates')}>
      <ModalCard width="min(920px, 92vw)" className="elem-candidate-preview">
        <ModalBody>
          <img className="elem-candidate-preview__image" src={candidate.fileUrl} alt="" />
          <dl className="elem-candidate-preview__meta">
            <dt>{t('elementEditor.imageGeneration.prompt')}</dt>
            <dd>{provenance.subjectPrompt ?? provenance.prompt}</dd>
            {provenance.styleText && (
              <>
                <dt>{t('elementEditor.imageGeneration.style')}</dt>
                <dd>{provenance.styleText}</dd>
              </>
            )}
            {provenance.extraPrompt && (
              <>
                <dt>{t('elementEditor.imageGeneration.extra')}</dt>
                <dd>{provenance.extraPrompt}</dd>
              </>
            )}
            <dt>{t('elementEditor.imageGeneration.size')}</dt>
            <dd>
              {candidate.width} × {candidate.height} · {provenance.model}
            </dd>
          </dl>
        </ModalBody>
        <ModalActions>
          <button type="button" className="elem-imagegen__button" onClick={onClose}>
            {t('common.close')}
          </button>
          <button
            type="button"
            className="elem-imagegen__button"
            disabled={busy}
            onClick={() => onKeep(candidate)}
          >
            {t('elementEditor.imageGeneration.keep')}
          </button>
          <button
            type="button"
            className="elem-imagegen__button elem-imagegen__button--primary"
            disabled={busy}
            onClick={() => onSetPortrait(candidate)}
          >
            {t('elementEditor.imageGeneration.setPortrait')}
          </button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
