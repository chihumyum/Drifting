/** Synthetic language controls; no project, account, database or manuscript reads. */
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguagePanel } from '../src/renderer/features/settings/panels/BasicPreferencePanels';
import { UserMenu } from '../src/renderer/components/topBars/UserMenu';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import { setI18nLocale, i18next } from '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/materials.css';
import '../src/styles/ui-controls.css';
import '../src/styles/settings.css';
import '../src/styles/desktop-typography.css';
import '../src/styles/interface-fonts.css';

const root = document.documentElement;
root.dataset.shellMode = 'desktop';
document.body.style.overflow = 'auto';
function Fixture() {
  const uiLocale = useSettingsStore(state => state.uiLocale);
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => setI18nLocale(uiLocale), [uiLocale]);
  return <main style={{ padding: 24, maxWidth: 800, margin: 'auto' }}>
    <LanguagePanel registerRef={() => {}} />
    <div style={{ marginTop: 20 }} id="sample">
      <h2>{t('manuscriptExport.title')}</h2>
      <p>{t('markdownShare.proseOnly')}</p>
      <button>{t('common.cancel')}</button> <button>{t('markdownShare.retry')}</button>
    </div>
    <textarea id="synthetic-prose" defaultValue="Synthetic Ω 雨. This draft must survive a language change." style={{ width: '100%', marginTop: 20 }} />
    <button id="account-trigger" ref={trigger} onClick={() => setOpen(value => !value)}>Drifting</button>
    <UserMenu triggerRef={trigger} open={open} onClose={() => setOpen(false)} scope="shelf" />
  </main>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
const api = {
  ready: () => !!document.querySelector('#language .ui-select'),
  locale: () => useSettingsStore.getState().uiLocale,
  language: () => i18next.language,
};
Object.assign(window, { __INTERFACE_LOCALES__: api });
