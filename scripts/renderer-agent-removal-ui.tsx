import { StrictMode, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
// The isolated build exposes this existing component; product exports are unchanged.
import { AgentUsageSection } from '../src/renderer/features/settings/panels/AgentSettingsPanel';
import { ConfirmationDialog } from '../src/renderer/components/modals/ConfirmationDialog';
import { useAgentChatStore } from '../src/renderer/store/agent-chat-store';
import { useProjectStore } from '../src/renderer/store/project-store';
import { i18next as i18n } from '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/settings.css';

const rows = new Map(['p', 'q'].map(projectId => [projectId, [1, 2].map(index => ({ id: `${projectId}${index}`, title: `Synthetic ${projectId}${index}`, updatedAt: '2026-09-13', deletedAt: null as string | null, inputTokens: 10, outputTokens: 2, costUsd: 0.1, turns: 1 }))]));
const calls = { lists: [] as string[], deletes: [] as string[], clears: [] as string[] };
let heldListProject: string | null = null; let releaseList: (() => void) | null = null;
let finish: ((success: boolean) => void) | null = null;
async function mutation(ids: string[]) {
  const success = await new Promise<boolean>(resolve => { finish = resolve; }); finish = null;
  if (!success) throw new Error('Synthetic removal failure');
  const receipt = [];
  for (const [projectId, values] of rows) for (const row of values) if (ids.includes(row.id)) { row.deletedAt = '2026-09-13'; receipt.push({ id: row.id, projectId, deletedAt: row.deletedAt }); }
  return receipt;
}
function project(id: string) { useProjectStore.getState().setCurrentProject({ id, userId: 'synthetic', name: 'Synthetic', summary: '', kvJson: '[]', storylineTemplateKvJson: '[]', createdAt: '2026-09-13', updatedAt: '2026-09-13' }); }
const api = {
  calls, project, open: (_value: boolean) => {}, release: (success: boolean) => { if (!finish) throw new Error('No pending mutation'); finish(success); },
  pending: () => Boolean(finish), text: () => document.body.textContent ?? '',
  ports: {
    usageByProject: async (id: string) => { calls.lists.push(id); if (id === heldListProject) await new Promise<void>(resolve => { releaseList = resolve; }); return rows.get(id)!.map(row => ({ ...row })); },
    listByProject: async (id: string) => rows.get(id)?.filter(row => !row.deletedAt) ?? [],
    softDelete: async (id: string) => { calls.deletes.push(id); return mutation([id]); },
    softDeleteAllByProject: async (id: string) => { calls.clears.push(id); return mutation(rows.get(id)!.filter(row => !row.deletedAt).map(row => row.id)); },
  },
  async run() {
    const wait = async (check: () => boolean, label: string) => { for (let index = 0; index < 200; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(label); };
    const pulse = async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); };
    const assert = (condition: boolean, label: string) => { if (!condition) throw new Error(label); };
    const button = (text: string, within: ParentNode = document) => { const element = [...within.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text); if (!element) throw new Error(`Missing button ${text}`); return element; };
    const remove = (id: string) => { const span = [...document.querySelectorAll('span')].find(node => node.textContent === `Synthetic ${id}`); if (!span) throw new Error(`Missing row ${id}`); span.parentElement!.querySelector('button')!.click(); };
    const clear = () => button(i18n.t('settings.agentUsage.clearHistory')).click();
    const confirm = async () => { await wait(() => Boolean(document.querySelector('[role="dialog"]')), 'confirmation missing'); button(i18n.t('common.confirm'), document.querySelector('[role="dialog"]')!).click(); };
    await wait(() => api.text().includes('Synthetic p1'), 'StrictMode history did not mount');
    assert(calls.lists.filter(id => id === 'p').length >= 2, 'StrictMode effect replay not exercised');
    remove('p1'); await wait(api.pending, 'delete did not reach store'); await pulse(); assert(api.text().includes('Synthetic p1'), 'optimistic delete hid row');
    api.release(false); await pulse(); assert(api.text().includes('Synthetic p1'), 'failed delete hid row');
    remove('p1'); await wait(api.pending, 'second delete missing'); api.release(true);
    await wait(() => !api.text().includes('Synthetic p1'), 'successful delete stayed visible');
    assert(api.text().includes('Synthetic p2') && [...document.querySelectorAll('div')].some(node => node.textContent?.trim() === '24'), 'usage spend disappeared');
    clear(); await wait(() => Boolean(document.querySelector('[role="dialog"]')), 'clear confirmation missing'); heldListProject = 'q'; project('q');
    await wait(() => Boolean(releaseList), 'q list did not pause'); await pulse(); assert(!api.text().includes('Synthetic p2'), 'old project rows stayed actionable'); heldListProject = null; releaseList!(); releaseList = null;
    await wait(() => api.text().includes('Synthetic q1'), 'project q missing'); await confirm(); await pulse(); assert(calls.clears.length === 0, 'old confirmation cleared a new project');
    project('p'); await wait(() => api.text().includes('Synthetic p2'), 'project p missing');
    clear(); await confirm(); await wait(api.pending, 'clear did not reach store'); assert(calls.clears[0] === 'p', 'clear used bound chat project');
    project('q'); await wait(() => api.text().includes('Synthetic q1'), 'q after pending clear missing'); api.release(true); await pulse();
    assert(api.text().includes('Synthetic q1') && api.text().includes('Synthetic q2'), 'late clear changed q rows');
    assert(useAgentChatStore.getState().activeConvId === 'q-active', 'late clear reset q conversation');
    clear(); await wait(() => Boolean(document.querySelector('[role="dialog"]')), 'close confirmation missing'); api.open(false); await pulse(); await confirm(); await pulse();
    assert(calls.clears.length === 1, 'closed section executed pending confirmation'); api.open(true); await pulse();
    assert(api.text().includes('Synthetic q1'), 'reopened section did not recover');
    return { strictEffectReplay: true, pendingAndFailedDeletePreservesRows: true, committedUsageRetained: true,
      confirmationProjectOwnership: true, pendingProjectRowsIsolated: true, explicitClearProject: true, lateClearPreservesNewView: true, closeAndReopen: true };
  },
};
Object.assign(globalThis, { __AGENT_REMOVAL_UI__: api });
project('p'); useAgentChatStore.setState({ boundProjectId: 'q', activeConvId: 'q-active' });
export function Fixture() { const [open, setOpen] = useState(true); useLayoutEffect(() => { api.open = setOpen; }, []); return <><div style={{ display: open ? 'block' : 'none' }}><AgentUsageSection open={open} /></div><ConfirmationDialog /></>; }
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
