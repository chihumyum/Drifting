import { Fragment, useLayoutEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useDataStore } from '../store/data-store';
import { useDataStoreFields } from '../store/use-data-store-fields';
import { selectEntityLinkNames, buildEntityAutoDetectTargets, releaseEntityLinkNames } from '../lib/entity-link-names';
import { buildEntityLinkColorSignature, DEFAULT_ENTITY_LINK_KIND_COLORS } from '../lib/entity-link-appearance';
import { indexById } from '../lib/immutable-id-index';
import { createWorkspaceSharingFixture } from './workspace-fixture';

/** Actual shared hooks and editor target derivation, driven through complete
 * capture-shaped publications. SQLite/provider/physical input are separate. */
export function runWorkspaceGenerationScenario() {
  const saved = useDataStore.getState(); const profiles = [];
  for (const consumers of [1, 5, 20]) {
    const projectId = 'synthetic-generation-project'; const fixture = createWorkspaceSharingFixture(projectId, 100);
    let data = structuredClone(fixture); let generation = 'synthetic-generation-1';
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const counts = { names: 0, targets: 0, colors: 0, fields: 0, records: 0 };
    let incoherentCommits = 0; let coherentCommits = 0;
    const readNames = () => selectEntityLinkNames(useDataStore.getState());
    function Names() {
      const selected = useDataStore(selectEntityLinkNames);
      const targets = useMemo(() => { counts.targets++; return buildEntityAutoDetectTargets(selected, 'node', 'synthetic-node-0'); }, [selected]);
      useLayoutEffect(() => { counts.names++; }); return <span>{targets.size}</span>;
    }
    function Colors() {
      const signature = useDataStore(state => buildEntityLinkColorSignature(state, 'contextual', DEFAULT_ENTITY_LINK_KIND_COLORS));
      useLayoutEffect(() => { counts.colors++; }); return <span>{signature.length}</span>;
    }
    function Fields() {
      const selected = useDataStoreFields('bookNodes', 'bookElements', 'primaryStorylineByNode', 'nodeStorylineMapping');
      useLayoutEffect(() => { counts.fields++; }); return <span>{selected.bookNodes.length}</span>;
    }
    function Record() {
      const node = useDataStore(state => indexById(state.bookNodes).get('synthetic-node-0'));
      useLayoutEffect(() => { counts.records++; }); return <span>{node?.wordCount}</span>;
    }
    function Combined() {
      const selected = useDataStoreFields('workspaceProjectId', 'workspaceProjectionGeneration', 'bookNodes', 'bookElements', 'primaryStorylineByNode', 'nodeStorylineMapping', 'entityRelations');
      const names = useDataStore(selectEntityLinkNames);
      useLayoutEffect(() => {
        coherentCommits++;
        if (names.projectId !== selected.workspaceProjectId || names.generation !== selected.workspaceProjectionGeneration ||
          JSON.stringify(names.nodes) !== JSON.stringify(selected.bookNodes.map(({ id, title }) => ({ id, title }))) ||
          JSON.stringify(names.elements) !== JSON.stringify(selected.bookElements.map(({ id, name, aliases }) => ({ id, name, aliases })))) incoherentCommits++;
        for (const [id, primary] of Object.entries(selected.primaryStorylineByNode)) if (primary && !selected.nodeStorylineMapping[id]?.includes(primary)) incoherentCommits++;
        if (selected.bookNodes.some(node => node.projectId !== selected.workspaceProjectId)) incoherentCommits++;
      });
      return <span>{names.projectId}</span>;
    }
    const reset = () => { for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0; };
    const request = (project = projectId, mode: 'loading' | 'refreshing' = 'refreshing') => { let epoch = 0; flushSync(() => { epoch = useDataStore.getState().requestWorkspaceProjection(project, mode); }); return epoch; };
    const commit = (epoch: number, next = data, project = projectId, source = generation) => { let accepted = false; flushSync(() => { accepted = useDataStore.getState().commitWorkspaceProjection(project, epoch, next, undefined, source); }); return accepted; };
    try {
      commit(request(projectId, 'loading'));
      flushSync(() => root.render(<Fragment>{Array.from({ length: consumers }, (_, i) => <Fragment key={i}><Names /><Colors /><Fields /><Record /></Fragment>)}<Combined /></Fragment>));
      reset();
      for (let i = 0; i < 100; i++) { data = structuredClone(data); data.comments[0].bodyJson = JSON.stringify({ text: `Synthetic comment ${i}` }); commit(request()); }
      const comments = { ...counts }; reset();
      for (let i = 0; i < 100; i++) { data = structuredClone(data); data.bookNodes[0].wordCount = i + 1; commit(request()); }
      const metrics = { ...counts }; reset();
      const beforeRename = readNames(); const renaming = request(); const pendingRenameStable = readNames() === beforeRename;
      data = structuredClone(data); data.bookNodes[0].title = 'Synthetic committed rename'; commit(renaming);
      const rename = { ...counts }; reset();
      data = structuredClone(data); data.storylines[1].color = '#987654'; data.primaryStorylineByNode['synthetic-node-0'] = 'support'; data.entityRelations[0].toId = 'synthetic-node-1'; commit(request());
      const membership = { ...counts }; reset();
      const beforeGeneration = useDataStore.getState(); const oldNames = readNames(); const epoch = request();
      const pendingGenerationStable = readNames() === oldNames; generation = 'synthetic-generation-2'; data = structuredClone(data); commit(epoch);
      const generationChange = { ...counts }; const next = useDataStore.getState();
      const changedGenerationReleasesRecords = next.bookNodes !== beforeGeneration.bookNodes && next.bookNodes[0] !== beforeGeneration.bookNodes[0];
      const changedGenerationReleasesNames = readNames() !== oldNames;
      reset(); const failedNames = readNames(); const failed = request(); flushSync(() => useDataStore.getState().failWorkspaceProjection(projectId, failed, 'Synthetic failure'));
      commit(request()); const failure = { ...counts }; const failedRefreshRetainsNames = readNames() === failedNames;
      const stale = request(); const other = createWorkspaceSharingFixture('synthetic-other-project', 100); other.bookNodes[0].title = 'Other project';
      commit(request('synthetic-other-project', 'loading'), other, 'synthetic-other-project', 'other-generation');
      const otherNames = readNames(); const staleRejected = !commit(stale) && readNames() === otherNames;
      commit(request(projectId, 'loading')); const returnedNames = readNames();
      const staleABARejected = !commit(stale) && readNames() === returnedNames;
      const clear = request(); flushSync(() => useDataStore.getState().clearWorkspaceProjection(projectId, clear));
      const missingClearsNames = readNames().projectId === null && readNames().nodes.length === 0 && readNames().elements.length === 0;
      flushSync(() => root.unmount());
      const beforeUnmounted = JSON.stringify(counts); useDataStore.getState().setComments([]);
      profiles.push({ consumers, nodes: fixture.bookNodes.length, elements: fixture.bookElements.length, refreshes: 100, comments, metrics, rename, membership, generationChange, failure,
        checks: { pendingRenameStable, pendingGenerationStable, changedGenerationReleasesRecords, changedGenerationReleasesNames,
          failedRefreshRetainsNames, staleRejected, staleABARejected, missingClearsNames, coherentSnapshots: incoherentCommits === 0, unmountedDoesNotRender: beforeUnmounted === JSON.stringify(counts) },
        coherentCommits, incoherentCommits });
    } finally { flushSync(() => root.unmount()); container.remove(); releaseEntityLinkNames(projectId); useDataStore.setState(saved, true); }
  }
  return { build: 'production-React-isolated-Chromium', profiles,
    boundary: 'Complete synthetic capture-shaped publications, real Zustand hooks, shared name/color selectors and per-editor target construction. Full provider, SQLite, native input and device timing budgets are not measured here.' };
}
