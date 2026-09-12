import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useDataStore, type WorkspaceDataProjection } from '../store/data-store';
import { useDataStoreFields } from '../store/use-data-store-fields';
import { indexById } from '../lib/immutable-id-index';
import { deriveNodeStorylineState } from '../domain/node-storyline-state';
import { createWorkspaceSharingFixture } from './workspace-fixture';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');

function publish(projectId: string, data: WorkspaceDataProjection, mode: 'loading' | 'refreshing' = 'refreshing') {
  const epoch = useDataStore.getState().requestWorkspaceProjection(projectId, mode);
  if (!useDataStore.getState().commitWorkspaceProjection(projectId, epoch, data)) throw new Error('Synthetic capture rejected');
}

async function membershipScenario() {
  const profiles = [];
  for (const nodes of [100, 1_000, 5_000]) {
    const links = Array.from({ length: nodes }, (_, index) => ['main', 'support'].map((storylineId) => ({
      nodeId: `synthetic-node-${index}`, storylineId, isPrimary: storylineId === 'main',
    }))).flat();
    let scannedSlots = 0;
    const includes = Array.prototype.includes;
    // Each fixture membership is new in its lane, so includes examines every slot.
    Array.prototype.includes = function (this: unknown[], value: unknown, from?: number) {
      scannedSlots += this.length; return includes.call(this, value, from);
    };
    let mapping;
    try { mapping = deriveNodeStorylineState(links); } finally { Array.prototype.includes = includes; }
    const matchesFixture = ['main', 'support'].every((id) => mapping.storylineNodeMapping[id].length === nodes)
      && Object.keys(mapping.primaryStorylineByNode).length === nodes;
    if (!matchesFixture) throw new Error('Membership fixture mismatch');
    const samplesMs = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const start = performance.now(); deriveNodeStorylineState(links); samplesMs.push(performance.now() - start); await frame();
    }
    profiles.push({ nodes, links: links.length, scannedSlots, matchesFixture, fixtureHash: await digest(links), samplesMs, medianMs: median(samplesMs) });
  }
  return { implementation: 'linear-membership-sets', profiles };
}

async function publicationScenario() {
  const previous = useDataStore.getState(); const profiles = [];
  try {
    for (const nodes of [100, 1_000, 5_000]) {
      const projectId = 'synthetic-workspace'; const data = createWorkspaceSharingFixture(projectId, nodes);
      publish(projectId, structuredClone(data), 'loading');
      const samplesMs = []; let reusedNodeRecords = 0; let stableCollections = 0;
      for (let repeat = 0; repeat < 5; repeat++) {
        const captured = structuredClone(data); captured.comments[0].bodyJson = JSON.stringify({ text: `合成评论${repeat}` });
        const before = useDataStore.getState();
        const epoch = before.requestWorkspaceProjection(projectId, 'refreshing');
        const start = performance.now(); before.commitWorkspaceProjection(projectId, epoch, captured); samplesMs.push(performance.now() - start);
        const after = useDataStore.getState();
        reusedNodeRecords = after.bookNodes.filter((node, index) => node === before.bookNodes[index]).length;
        stableCollections = (Object.keys(data) as (keyof WorkspaceDataProjection)[]).filter((key) => before[key] === after[key]).length;
        await frame();
      }
      profiles.push({ nodes, elements: data.bookElements.length, reusedNodeRecords, stableCollections,
        slices: Object.keys(data).length, fixtureHash: await digest(data), samplesMs, medianMs: median(samplesMs) });
    }
    return { implementation: 'share-capture-values', profiles };
  } finally { useDataStore.setState(previous, true); }
}

function subscriptionScenario() {
  const previous = useDataStore.getState(); const projectId = 'synthetic-workspace-subscriptions';
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const fixture = createWorkspaceSharingFixture(projectId); const commits = { fields: 0, records: 0 };
  function Fields() {
    const { bookNodes } = useDataStoreFields('bookNodes', 'bookElements', 'nodeStorylineMapping');
    useLayoutEffect(() => { commits.fields++; }); return createElement('span', null, bookNodes.length);
  }
  function Row({ id }: { id: string }) {
    const node = useDataStore((state) => indexById(state.bookNodes).get(id));
    useLayoutEffect(() => { commits.records++; }); return createElement('span', null, node?.title);
  }
  try {
    publish(projectId, structuredClone(fixture), 'loading');
    flushSync(() => root.render(createElement(Fragment, null, ...Array.from({ length: 20 }, (_, index) => [
      createElement(Fields, { key: `fields-${index}` }), createElement(Row, { key: `row-${index}`, id: `synthetic-node-${index}` }),
    ]).flat())));
    commits.fields = 0; commits.records = 0;
    for (let index = 0; index < 100; index++) {
      const captured = structuredClone(fixture); captured.comments[0].bodyJson = JSON.stringify({ text: `合成评论${index}` });
      flushSync(() => publish(projectId, captured));
    }
    const unrelated = { ...commits }; commits.fields = 0; commits.records = 0;
    const renamed = structuredClone(fixture); renamed.bookNodes[0].title = '合成新标题';
    flushSync(() => publish(projectId, renamed)); const rename = { ...commits };
    if (!container.textContent?.includes('合成新标题')) throw new Error('Rename was not published');
    return { consumers: 20, refreshes: 100, unrelated, rename };
  } finally { flushSync(() => root.unmount()); container.remove(); useDataStore.setState(previous, true); }
}

export async function runWorkspaceProjectionScenarios() {
  return { membership: await membershipScenario(), publication: await publicationScenario(), subscriptions: subscriptionScenario(),
    boundary: 'Production membership derivation and workspace commit with complete synthetic capture-shaped data and real Zustand/React subscribers. SQLite read count, reference parsing, full provider and native recovery are not measured here.' };
}
