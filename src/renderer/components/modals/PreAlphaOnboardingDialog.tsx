import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuthStore } from '../../store/auth';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

const GUIDE_VERSION = 'v1';

export function PreAlphaOnboardingDialog() {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const storageKey = userId ? `drifting.pre-alpha-guide.${GUIDE_VERSION}:${userId}` : null;
  const open = Boolean(
    isAuthenticated &&
    storageKey &&
    dismissedKey !== storageKey &&
    localStorage.getItem(storageKey) !== 'seen',
  );

  if (!open || !userId) return null;

  const dismiss = () => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, 'seen');
    setDismissedKey(storageKey);
  };

  return (
    <ModalRoot
      onClose={dismiss}
      ariaLabel={t('preAlphaGuide.title')}
      closeOnBackdrop={false}
      dismissOnEscape={false}
    >
      <ModalCard width={560}>
        <ModalHeader kicker="PRE-ALPHA" title={t('preAlphaGuide.title')} />
        <ModalBody>
        <p style={{ margin: 0, color: 'hsl(var(--ink-2))', lineHeight: 1.7 }}>
          {t('preAlphaGuide.intro')}
        </p>
        <div
          style={{
            margin: '20px 0',
            padding: '16px 18px',
            borderRadius: 12,
            background: 'hsl(var(--page))',
          }}
        >
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
            <li>{t('preAlphaGuide.trial')}</li>
            <li>{t('preAlphaGuide.sync')}</li>
            <li>{t('preAlphaGuide.byok')}</li>
            <li>{t('preAlphaGuide.backup')}</li>
          </ul>
        </div>
        <p style={{ margin: '0 0 20px', color: 'hsl(var(--ink-2))', lineHeight: 1.65 }}>
          {t('preAlphaGuide.settingsHint')}
        </p>
        </ModalBody>
        <ModalActions>
          <Button variant="primary" onClick={dismiss} autoFocus>
            {t('preAlphaGuide.continue')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
