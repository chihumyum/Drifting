import { create } from 'zustand';
import { platform } from '../platform';
import type { ImageInboxEntry, ImageQuotaSnapshot } from '../platform';

/**
 * Projection of the native generation inbox for the mounted project.
 *
 * Candidates are unsynced local files (see `src-tauri/src/codex_images.rs`),
 * not authored data: keeping one turns it into a material, discarding or
 * letting it expire removes the file. Nothing here is persisted by the store.
 */
interface ImageInboxState {
  projectId: string | null;
  candidates: ImageInboxEntry[];
  loading: boolean;
  error: string | null;
  quota: ImageQuotaSnapshot | null;
  load(projectId: string): Promise<void>;
  addCandidates(projectId: string, entries: ImageInboxEntry[], quota: ImageQuotaSnapshot | null): void;
  removeCandidate(projectId: string, candidateId: string): void;
}

function newestFirst(entries: ImageInboxEntry[]): ImageInboxEntry[] {
  return [...entries].sort(
    (a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id),
  );
}

export const useImageInboxStore = create<ImageInboxState>((set, get) => ({
  projectId: null,
  candidates: [],
  loading: false,
  error: null,
  quota: null,

  async load(projectId) {
    if (get().projectId !== projectId) {
      set({ projectId, candidates: [], quota: null, error: null });
    }
    set({ loading: true });
    try {
      const entries = await platform.imageGeneration.listInbox(projectId);
      if (get().projectId !== projectId) return;
      set({ candidates: newestFirst(entries), loading: false, error: null });
    } catch (error) {
      if (get().projectId !== projectId) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  addCandidates(projectId, entries, quota) {
    if (get().projectId !== projectId) {
      // A background generation finished after the author switched project;
      // its files stay in the inbox and appear when that project loads again.
      return;
    }
    const known = new Set(entries.map((entry) => entry.id));
    set((state) => ({
      candidates: newestFirst([
        ...entries,
        ...state.candidates.filter((candidate) => !known.has(candidate.id)),
      ]),
      quota: quota ?? state.quota,
    }));
  },

  removeCandidate(projectId, candidateId) {
    if (get().projectId !== projectId) return;
    set((state) => ({
      candidates: state.candidates.filter((candidate) => candidate.id !== candidateId),
    }));
  },
}));

export function selectElementCandidates(
  candidates: ImageInboxEntry[],
  elementId: string | null | undefined,
): ImageInboxEntry[] {
  if (!elementId) return [];
  return candidates.filter(
    (candidate) => candidate.target.kind === 'element' && candidate.target.id === elementId,
  );
}
