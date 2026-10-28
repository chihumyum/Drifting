import { useTranslation } from 'react-i18next';
import type { ImageInboxEntry } from '../../platform';
import { BrushIcon } from '../../components/ui/BrushIcon';

export type ElementImageGenerationState = 'idle' | 'starting' | 'running';

interface ElementImageCandidatesProps {
  candidates: ImageInboxEntry[];
  generation: ElementImageGenerationState;
  /** Candidate currently being kept or discarded. */
  busyCandidateId: string | null;
  error: string | null;
  onOpenSession: () => void;
  onSetPortrait: (candidate: ImageInboxEntry) => void;
  onKeep: (candidate: ImageInboxEntry) => void;
  onDiscard: (candidate: ImageInboxEntry) => void;
  onPreview: (candidate: ImageInboxEntry) => void;
}

/**
 * Unsynced generation candidates for one element, shown in the top bar image
 * popover. Each can become the element image (also kept as a material), be
 * kept as a material, or be discarded.
 */
export function ElementImageCandidates({
  candidates,
  generation,
  busyCandidateId,
  error,
  onOpenSession,
  onSetPortrait,
  onKeep,
  onDiscard,
  onPreview,
}: ElementImageCandidatesProps) {
  const { t } = useTranslation();
  if (candidates.length === 0 && generation === 'idle' && !error) return null;

  return (
    <section className="elem-candidates" aria-label={t('elementEditor.imageGeneration.candidates')}>
      <div className="elem-candidates__head">
        <span className="elem-candidates__title">{t('elementEditor.imageGeneration.candidates')}</span>
        {generation !== 'idle' && (
          <button type="button" className="elem-candidates__status" onClick={onOpenSession}>
            <BrushIcon name="loader" size={12} className="elem-portrait__icon elem-portrait__icon--spin" />
            {t(
              generation === 'starting'
                ? 'elementEditor.imageGeneration.starting'
                : 'elementEditor.imageGeneration.running',
            )}
          </button>
        )}
        {candidates.length > 0 && (
          <span className="elem-candidates__hint">{t('elementEditor.imageGeneration.candidatesHint')}</span>
        )}
      </div>
      {error && (
        <div className="elem-portrait__error" role="alert">
          {error}
        </div>
      )}
      {candidates.length > 0 && (
        <ul className="elem-candidates__list">
          {candidates.map((candidate) => {
            const busy = busyCandidateId === candidate.id;
            const disabled = busyCandidateId !== null;
            return (
              <li key={candidate.id} className="elem-candidates__item" aria-busy={busy}>
                <button
                  type="button"
                  className="elem-candidates__thumb"
                  onClick={() => onPreview(candidate)}
                  title={candidate.provenance.subjectPrompt ?? candidate.provenance.prompt}
                >
                  <img src={candidate.fileUrl} alt="" loading="lazy" />
                </button>
                <div className="elem-candidates__actions">
                  <button
                    type="button"
                    className="elem-candidates__action"
                    disabled={disabled}
                    onClick={() => onSetPortrait(candidate)}
                  >
                    {busy ? (
                      <BrushIcon name="loader" size={12} className="elem-portrait__icon elem-portrait__icon--spin" />
                    ) : null}
                    {t('elementEditor.imageGeneration.setPortrait')}
                  </button>
                  <button
                    type="button"
                    className="elem-candidates__action"
                    disabled={disabled}
                    onClick={() => onKeep(candidate)}
                  >
                    {t('elementEditor.imageGeneration.keep')}
                  </button>
                  <button
                    type="button"
                    className="elem-candidates__action"
                    disabled={disabled}
                    onClick={() => onDiscard(candidate)}
                    title={t('elementEditor.imageGeneration.discard')}
                    aria-label={t('elementEditor.imageGeneration.discard')}
                  >
                    <BrushIcon name="close" size={12} className="elem-portrait__icon" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
