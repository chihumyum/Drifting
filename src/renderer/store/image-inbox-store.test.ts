import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageInboxEntry } from '../platform';

const listInbox = vi.fn<(projectId: string) => Promise<ImageInboxEntry[]>>();
vi.mock('../platform', () => ({
  platform: { imageGeneration: { listInbox: (projectId: string) => listInbox(projectId) } },
}));

const { selectElementCandidates, useImageInboxStore } = await import('./image-inbox-store');

function entry(id: string, elementId: string, createdAtMs: number, projectId = 'project-1'): ImageInboxEntry {
  return {
    id,
    projectId,
    target: { kind: 'element', id: elementId },
    createdAtMs,
    mime: 'image/png',
    width: 1024,
    height: 1536,
    sizeBytes: 1,
    filePath: `/inbox/${id}.png`,
    fileUrl: `asset://${id}`,
    provenance: {
      provider: 'chatgpt-subscription',
      model: 'gpt-image-2',
      prompt: 'p',
      subjectPrompt: null,
      styleText: null,
      extraPrompt: null,
      conversationId: null,
      generationId: null,
      imagegenRequestId: null,
    },
  };
}

describe('image inbox store', () => {
  beforeEach(() => {
    listInbox.mockReset();
    useImageInboxStore.setState({ projectId: null, candidates: [], loading: false, error: null, quota: null });
  });

  it('loads the project inbox newest first and filters by element', async () => {
    listInbox.mockResolvedValue([entry('a', 'e1', 1), entry('b', 'e2', 3), entry('c', 'e1', 2)]);
    await useImageInboxStore.getState().load('project-1');
    const { candidates } = useImageInboxStore.getState();
    expect(candidates.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(selectElementCandidates(candidates, 'e1').map((c) => c.id)).toEqual(['c', 'a']);
    expect(selectElementCandidates(candidates, null)).toEqual([]);
  });

  it('merges generated candidates, keeps the latest quota and ignores another project', async () => {
    listInbox.mockResolvedValue([entry('a', 'e1', 1)]);
    await useImageInboxStore.getState().load('project-1');
    const quota = { limit: 'imagegen_premium', usedPercent: 2, windowMinutes: 1440, resetsAtMs: 9 };
    useImageInboxStore.getState().addCandidates('project-1', [entry('b', 'e1', 5)], quota);
    useImageInboxStore.getState().addCandidates('project-2', [entry('x', 'e1', 9, 'project-2')], null);
    const state = useImageInboxStore.getState();
    expect(state.candidates.map((c) => c.id)).toEqual(['b', 'a']);
    expect(state.quota).toEqual(quota);

    useImageInboxStore.getState().removeCandidate('project-1', 'a');
    expect(useImageInboxStore.getState().candidates.map((c) => c.id)).toEqual(['b']);
  });

  it('drops a stale load that finishes after the project changed', async () => {
    let resolveFirst!: (entries: ImageInboxEntry[]) => void;
    listInbox.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    listInbox.mockResolvedValueOnce([entry('p2', 'e1', 1, 'project-2')]);
    const first = useImageInboxStore.getState().load('project-1');
    await useImageInboxStore.getState().load('project-2');
    resolveFirst([entry('p1', 'e1', 1)]);
    await first;
    expect(useImageInboxStore.getState().candidates.map((c) => c.id)).toEqual(['p2']);
  });
});
