import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuthStore } from '../../store/auth';
import { events } from '../../lib/events';
import { platform } from '../../platform';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

// v4 keeps onboarding focused on the product's active trust boundaries.
const GUIDE_VERSION = 'v4';

export function PreAlphaOnboardingDialog() {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const storageKey = userId ? `drifting.alpha-guide.${GUIDE_VERSION}:${userId}` : null;
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
  const openSyncAndData = () => {
    dismiss();
    queueMicrotask(() => events.emit('settings:open', { railId: 'sync' }));
  };

  return (
    <ModalRoot
      onClose={dismiss}
      ariaLabel={t('preAlphaGuide.title')}
      closeOnBackdrop={false}
      dismissOnEscape={false}
    >
      <ModalCard className="pre-alpha-guide-modal" width={560}>
        <ModalHeader kicker="PUBLIC ALPHA" title={t('preAlphaGuide.title')} />
        <ModalBody>
          <p style={{ margin: 0, color: 'hsl(var(--ink-2))', lineHeight: 1.7 }}>
            {t('preAlphaGuide.intro')}
          </p>
          <div
            style={{
              margin: '20px 0',
              padding: '16px 18px',
              borderRadius: 2,
              background: 'hsl(var(--page))',
            }}
          >
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
              <li>{t('preAlphaGuide.localData')}</li>
              <li>{t('preAlphaGuide.sync')}</li>
              <li>{t('preAlphaGuide.byok')}</li>
            </ul>
          </div>
          <p style={{ margin: '0 0 20px', color: 'hsl(var(--ink-2))', lineHeight: 1.65 }}>
            {t('preAlphaGuide.settingsHint')}
          </p>
        </ModalBody>
        <ModalActions>
          <Button
            variant="ghost"
            onClick={() =>
              void platform.material.openExternal('https://drifting.app/quick-start')
            }
          >
            {t('preAlphaGuide.quickGuide')}
          </Button>
          <Button variant="default" onClick={openSyncAndData}>
            {t('preAlphaGuide.openDrive')}
          </Button>
          <Button
            className="pre-alpha-guide-modal__continue"
            variant="primary"
            onClick={dismiss}
            autoFocus
          >
            {t('preAlphaGuide.continueLocal')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
