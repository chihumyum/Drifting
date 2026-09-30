import { useEffect, useSyncExternalStore, type ComponentType } from 'react';
import { createDeferredModule } from '../../lib/deferred-module';
import { AppearancePanel, LanguagePanel } from './panels/BasicPreferencePanels';
import { SettingsLoadStatus } from './SettingsLoadStatus';
import { hostedAccountSettingsEnabled } from './hosted-settings-policy';

type DeferredPanelId = 'account' | 'editor' | 'models' | 'copilot' | 'keys' | 'sync' | 'updates' | 'privacy' | 'about';
export type StandalonePanelId = 'appearance' | 'language' | DeferredPanelId;
type PanelContent = ComponentType<{ id: DeferredPanelId }>;
const REGISTER_NOOP = () => undefined;

// Cache code per feature group. Basic preferences have no asynchronous gate;
// selecting Sync must not import model credentials, Agent UI or the workspace.
const editor = createDeferredModule<PanelContent>(async () => {
  const { EditorPanel } = await import('./panels/PreferenceSettingsPanels');
  return function EditorContent() { return <EditorPanel registerRef={REGISTER_NOOP} />; };
});
const intelligence = createDeferredModule<PanelContent>(async () => {
  const { ModelsPanel, CopilotPanel } = await import('./panels/IntelligenceSettingsPanels');
  return function IntelligenceContent({ id }) {
    return id === 'models'
      ? <ModelsPanel credentialsActive registerRef={REGISTER_NOOP} />
      : <CopilotPanel credentialsActive registerRef={REGISTER_NOOP} />;
  };
});
const controls = createDeferredModule<PanelContent>(async () => {
  const { AccountPanel, KeysPanel, SyncPanel, UpdatePanel, PrivacyPanel, AboutPanel } = await import('./panels/AccountControlSettingsPanels');
  return function ControlContent({ id }) {
    switch (id) {
      case 'account': return <AccountPanel registerRef={REGISTER_NOOP} />;
      case 'keys': return <KeysPanel registerRef={REGISTER_NOOP} />;
      case 'sync': return <SyncPanel registerRef={REGISTER_NOOP} projectImportEnabled={false} />;
      case 'updates': return <UpdatePanel registerRef={REGISTER_NOOP} />;
      case 'privacy': return <PrivacyPanel registerRef={REGISTER_NOOP} />;
      case 'about': return <AboutPanel registerRef={REGISTER_NOOP} />;
      default: return null;
    }
  };
});
const panelModules = { account: controls, editor, models: intelligence, copilot: intelligence,
  keys: controls, sync: controls, updates: controls, privacy: controls, about: controls };

function DeferredStandalonePanel({ id }: { id: DeferredPanelId }) {
  const resource = panelModules[id];
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { if (state.status === 'idle') void resource.load(); }, [resource, state.status]);
  if (state.status === 'ready') {
    const Content = state.value;
    return <Content id={id} />;
  }
  // A standalone settings route owns no project/editor session. Reloading only
  // on explicit retry clears failed JS/CSS dependency entries as well as the
  // entry module, retaining the selected URL and persisted preferences.
  return <SettingsLoadStatus failed={state.status === 'error'} retry={() => window.location.reload()} />;
}

export function StandaloneSettingsPanel({ id }: { id: StandalonePanelId }) {
  if (id === 'appearance') return <AppearancePanel registerRef={REGISTER_NOOP} />;
  if (id === 'language') return <LanguagePanel registerRef={REGISTER_NOOP} />;
  if (id === 'account' && !hostedAccountSettingsEnabled()) return null;
  return <DeferredStandalonePanel id={id} />;
}
