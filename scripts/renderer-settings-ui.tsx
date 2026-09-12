import { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { DesktopStandaloneSettingsView } from '../src/renderer/features/settings/desktop/DesktopStandaloneSettingsView';
import { DesktopSettingsModal } from '../src/renderer/features/settings/desktop/DesktopSettingsModal';
import { MobileSettingsView } from '../src/renderer/shells/mobile/standalone/MobileSettingsView';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/settings.css';

const observations = { mounts: 0, unmounts: 0, location: '' };
const api = { observations, navigate: (_path: string) => {}, modal: (_open: boolean) => {}, locale: () => useSettingsStore.getState().uiLocale };
export function Sentinel() {
  useEffect(() => { observations.mounts++; return () => { observations.unmounts++; }; }, []);
  return <textarea id="synthetic-draft" defaultValue="Synthetic unsaved draft" />;
}
export function Fixture() {
  const navigate = useNavigate(); const location = useLocation();
  const [modal, setModal] = useState(false);
  useLayoutEffect(() => {
    api.navigate = (path) => navigate(path, { state: { from: '/' } }); api.modal = setModal;
    observations.location = location.pathname + location.search;
  }, [navigate, location.pathname, location.search]);
  const mobile = new URLSearchParams(window.location.search).has('mobile');
  return <><Sentinel /><Routes>
    <Route path="/" element={<button id="open-settings" onClick={() => api.navigate('/settings?section=language')}>Open settings</button>} />
    <Route path="/settings" element={mobile ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />} />
  </Routes><DesktopSettingsModal isOpen={modal} onClose={() => setModal(false)} initialRailId="language" /></>;
}
Object.assign(window, { __SETTINGS_UI__: api });
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
