import { createDeferredModule } from '../../lib/deferred-module';
import { loadPanels as loadPreference } from 'virtual:settings-preference';
import { loadPanels as loadIntelligence } from 'virtual:settings-intelligence';
import { loadPanels as loadAgent } from 'virtual:settings-agent';
import { loadPanels as loadControl } from 'virtual:settings-control';

const preference = createDeferredModule(loadPreference);
const intelligence = createDeferredModule(loadIntelligence);
const agent = createDeferredModule(loadAgent);
const control = createDeferredModule(loadControl);

async function read<T>(resource: ReturnType<typeof createDeferredModule<T>>): Promise<T> {
  await resource.load();
  const state = resource.getSnapshot();
  if (state.status === 'ready') return state.value;
  if (state.status === 'error') throw state.error;
  throw new Error('Settings module did not finish loading');
}

/** Retry only failed groups; successful component identities and the editor stay intact. */
export async function loadProjectSettingsPanels(): Promise<typeof import('./settings-panels')> {
  const groups = await Promise.all([read(preference), read(intelligence), read(agent), read(control)]);
  return Object.assign({}, ...groups);
}
