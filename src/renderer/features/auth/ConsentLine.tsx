import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HoverCardShell, type HoverActionGroup } from '../../components/ui/HoverCard';
import { APP_CONFIG } from '../../lib/config';
import { platform } from '../../platform';
import { useHoverPreview } from '../entities/hover/entity-hover-card-model';

/** Stands where the sentence names what is agreed to; never part of a translation. */
const CONSENT_TERMS_SLOT = '\u0000';

/**
 * What going on agrees to, in one line: the last line of the first-run
 * welcome, which every author passes whether they sign in or go on locally.
 * The line only names it; the items wait in a hover card on those words: the
 * fault reports this build sends (docs/crash-reports.md), and the service's
 * terms and privacy policy as rows that open them. The card opens downward,
 * clear of the ways on above the line. A press opens it too, for a finger or
 * the keyboard. The sign-in flow has no such line: its sign-up form names the
 * terms in its own sentence, as it always has.
 */
export function ConsentLine() {
  const { t } = useTranslation();
  const hover = useHoverPreview<null>();
  const cardId = useId();
  const [fromKeyboard, setFromKeyboard] = useState(false);
  const [before, after = ''] = t('auth.legal.consent', { terms: CONSENT_TERMS_SLOT }).split(CONSENT_TERMS_SLOT);
  const opens = (key: 'terms' | 'privacy', url: string) => ({
    key,
    label: t(`auth.legal.${key}`),
    icon: { brush: 'arrow-out' as const },
    onSelect: () => void platform.material.openExternal(url),
  });
  const documents: HoverActionGroup[] = [{
    key: 'documents',
    actions: [
      // A service without published terms has no row for them.
      ...(APP_CONFIG.TERMS_URL ? [opens('terms', APP_CONFIG.TERMS_URL)] : []),
      opens('privacy', APP_CONFIG.PRIVACY_URL),
    ],
  }];
  return (
    <p className="first-run-welcome__note">
      {before}
      <button
        type="button"
        className="first-run-welcome__terms"
        aria-expanded={hover.preview !== null}
        aria-describedby={hover.preview ? cardId : undefined}
        onMouseEnter={(event) => hover.onEnter(null, event.currentTarget)}
        onMouseLeave={hover.onLeave}
        onClick={(event) => {
          // A click without a pointer came from the keyboard: its rows take focus.
          setFromKeyboard(event.detail === 0);
          hover.open(null, event.currentTarget);
        }}
      >
        {t('auth.legal.consentTerms')}
      </button>
      {after}
      {hover.preview && (
        <HoverCardShell
          id={cardId}
          anchor={hover.preview.anchor}
          placement="bottom-start"
          width={280}
          label={t('auth.legal.consentTerms')}
          pointer={hover.card}
          actions={documents}
          autoFocus={fromKeyboard}
          onDismiss={hover.dismiss}
        >
          <div className="hover-card__text">{t('preAlphaGuide.crashReports')}</div>
        </HoverCardShell>
      )}
    </p>
  );
}
