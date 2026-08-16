/**
 * useEntityYjsDoc — single entry point for wiring a TipTap editor to a Yjs
 * document for one of the 5 core domain entities.
 *
 * Every editor that owns a prose Y.Doc goes through this hook. It encapsulates:
 *   - docId construction (kind:entityId, see lib/yjs-doc-id)
 *   - Y.Doc lifecycle + local sqlite persistence (useYjsDoc inside useYjsSync)
 *   - authored update journaling for the owning Project Sync generation (useYjsSync)
 *   - first-load seed from contentJson when no Yjs state exists yet
 *   - userId / ydocReady gating so the returned ydoc is only non-undefined
 *     when it's safe to bind a Tiptap Collaboration extension to it
 *
 * Editor views must not reach into useYjsSync / useYjsDoc /
 * yjs-local-durability.service directly. If the Yjs path needs a fix, it lives
 * behind this one hook plus the layers it delegates to. That contract is
 * load-bearing — the alternative
 * was four near-identical Yjs setups in four editor views.
 */
import { useCallback } from 'react';
import type * as Y from 'yjs';

import { useAuthStore } from '../store/auth';
import { useYjsSync } from './useYjsSync';
import { makeDocId, type DocKind } from '../lib/yjs-doc-id';

/**
 * Projection seeding must be byte-stable across every renderer path.
 * The General Agent can commit the first Yjs update while navigation is also
 * opening the same chapter. Random Y.Doc client ids would make those two
 * equivalent seeds merge as two copies of the manuscript.
 */
export async function createEntitySeedUpdate(
  seedContentJson: string,
): Promise<Uint8Array> {
  const { createYjsProseSeedState } = await import(
    '../lib/agent/runtime/yjs-prose-command'
  );
  return createYjsProseSeedState(seedContentJson);
}

export interface UseEntityYjsDocOptions<K extends DocKind> {
  kind: K;
  entityId: string;
  projectId: string;
  /**
   * Seed JSON string from the entity's body column (node_content.contentJson,
   * element.contentJson, storylines.contentJson, element_category.contentJson).
   * Used to seed the Y.Doc when this local replica has no Yjs state for the
   * entity. The seed update is persisted and journaled before its snapshot.
   *
   * Pass `null` for entities without a seed body.
   */
  seedContentJson: string | null;
}

export interface UseEntityYjsDocResult {
  /**
   * The live Y.Doc, or `undefined` until userId is known + initial load done.
   * Pass directly to `useEntityEditor({ ydoc })`. Tiptap's Collaboration
   * extension binds to ydoc once it's defined; before that the editor mounts
   * in "no-Yjs" mode and is rebuilt as soon as ydoc resolves.
   */
  ydoc: Y.Doc | undefined;
  ydocReady: boolean;
  /** Initial SQLite/Yjs replay failure. A failed document is never editable. */
  ydocError: Error | null;
}

export function useEntityYjsDoc<K extends DocKind>({
  kind,
  entityId,
  projectId,
  seedContentJson,
}: UseEntityYjsDocOptions<K>): UseEntityYjsDocResult {
  const userId = useAuthStore((s) => s.user?.id);

  // Convert the entity's contentJson seed into Yjs ops on first load. Only
  // runs when useYjsDoc finds zero local Yjs state. Remote restore must finish
  // before a project is exposed, so an active session never races a hidden
  // provider pull with this deterministic seed.
  const seedFromContentJson = useCallback(
    async (apply: (mutator: (ydoc: Y.Doc) => void) => void) => {
      if (!seedContentJson || seedContentJson === '{}') return;
      try {
        const [Y, update] = await Promise.all([
          import('yjs'),
          createEntitySeedUpdate(seedContentJson),
        ]);
        apply((targetDoc) => {
          Y.applyUpdate(targetDoc, update);
        });
      } catch (error) {
        // Non-empty seed prose is user data. Treat a parse/schema conversion
        // failure as a load error instead of silently replacing it with an
        // empty Y.Doc and then persisting that blank state as authoritative.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to decode seed prose for ${kind}:${entityId}: ${detail}`);
      }
    },
    [entityId, kind, seedContentJson],
  );

  const { ydoc, isReady, error } = useYjsSync({
    docId: makeDocId(kind, entityId),
    userId: userId ?? '',
    projectId,
    // No onMaterialize: the editor's onPersist path (useEntityEditor →
    // editor.onUpdate → caller's onPersist) already writes the materialized
    // contentJson via the domain transaction path. Doing it from here too
    // would double the writes for the same value.
    seedFromContentJson: userId ? seedFromContentJson : undefined,
  });

  return {
    ydoc: userId && isReady ? ydoc : undefined,
    ydocReady: isReady,
    ydocError: error,
  };
}
