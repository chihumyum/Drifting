import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useAuthStore } from '../../store/auth';

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

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pre-alpha-guide-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'hsl(220 16% 10% / 0.58)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          width: 'min(560px, 100%)',
          borderRadius: 18,
          padding: '28px 30px 24px',
          color: 'hsl(var(--ink))',
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule))',
          boxShadow: '0 24px 80px hsl(220 20% 5% / 0.32)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            padding: '5px 9px',
            borderRadius: 999,
            font: '600 11px/1 var(--font-mono)',
            letterSpacing: '.08em',
            color: 'hsl(var(--accent))',
            background: 'hsl(var(--accent) / 0.1)',
          }}
        >
          PRE-ALPHA
        </div>
        <h2 id="pre-alpha-guide-title" style={{ margin: '16px 0 8px', fontSize: 25 }}>
          {t('preAlphaGuide.title')}
        </h2>
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
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="set-btn set-btn--primary" onClick={dismiss} autoFocus>
            {t('preAlphaGuide.continue')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
