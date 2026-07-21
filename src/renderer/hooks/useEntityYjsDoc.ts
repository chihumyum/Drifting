/**
 * useEntityYjsDoc — single entry point for wiring a TipTap editor to a Yjs
 * document for one of the 5 core domain entities.
 *
 * Every editor that wants live multi-device collaboration goes through this
 * hook. It encapsulates:
 *   - docId construction (kind:entityId, see lib/yjs-doc-id)
 *   - Y.Doc lifecycle + local sqlite persistence (useYjsDoc inside useYjsSync)
 *   - server push/pull cycle (useYjsSync)
 *   - first-load seed from pre-Yjs contentJson (handles existing rows on a
 *     fresh device — see seedFromLegacy)
 *   - userId / ydocReady gating so the returned ydoc is only non-undefined
 *     when it's safe to bind a Tiptap Collaboration extension to it
 *
 * Editor views must not reach into useYjsSync / useYjsDoc / yjs-sync.service
 * directly. If the Yjs path needs a fix, it lives behind this one hook plus
 * the layers it delegates to. That contract is load-bearing — the alternative
 * was four near-identical Yjs setups in four editor views.
 */
import { useCallback } from 'react';
import type * as Y from 'yjs';

import { useAuthStore } from '../store/auth';
import { useYjsSync } from './useYjsSync';
import { makeDocId, type DocKind } from '../lib/yjs-doc-id';

export interface UseEntityYjsDocOptions<K extends DocKind> {
  kind: K;
  entityId: string;
  projectId: string;
  /**
   * Pre-Yjs JSON string from the entity's body column (node_content.contentJson,
   * element.contentJson, storylines.contentJson, element_category.contentJson).
   * Used to seed the Y.Doc on a fresh device that has never seen this entity
   * via Yjs. Skipped if the server already has Yjs ops (pull-first logic in
   * useYjsDoc).
   *
   * Pass `null` for entities that never had a pre-Yjs body.
   */
  legacyContent: string | null;
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
  legacyContent,
}: UseEntityYjsDocOptions<K>): UseEntityYjsDocResult {
  const userId = useAuthStore((s) => s.user?.id);

  // Convert the entity's legacy contentJson into Yjs ops on first load. Only
  // runs when useYjsDoc finds zero local Yjs state AND the server's pull
  // returns nothing — see useYjsDoc.load. The pull-first behavior is what
  // prevents the "seed + pull = duplicate content" bug.
  const seedFromLegacy = useCallback(
    async (apply: (mutator: (ydoc: Y.Doc) => void) => void) => {
      if (!legacyContent || legacyContent === '{}') return;
      try {
        const [
          { getSchema },
          { prosemirrorJSONToYDoc },
          Y,
          StarterKit,
          Underline,
          Link,
          TextAlign,
          { BlockId },
          { EntityLink },
        ] = await Promise.all([
          import('@tiptap/core'),
          import('y-prosemirror'),
          import('yjs'),
          import('@tiptap/starter-kit').then((m) => m.default),
          import('@tiptap/extension-underline').then((m) => m.default),
          import('@tiptap/extension-link').then((m) => m.default),
          import('@tiptap/extension-text-align').then((m) => m.default),
          import('../lib/extensions/block-id'),
          import('../lib/extensions/entity-link'),
        ]);
        // Build a minimal schema that matches the editor's extensions. We
        // disable underline + link inside StarterKit and re-add them so the
        // schema isn't built with duplicated mark specs.
        const schema = getSchema([
          StarterKit.configure({ underline: false, link: false }),
          Underline,
          Link,
          TextAlign,
          BlockId,
          EntityLink,
        ] as never);
        const json = JSON.parse(legacyContent);
        const seeded = prosemirrorJSONToYDoc(schema, json, 'default');
        const update = Y.encodeStateAsUpdate(seeded);
        apply((targetDoc) => {
          Y.applyUpdate(targetDoc, update);
        });
      } catch (error) {
        // Non-empty legacy prose is user data. Treat a parse/schema conversion
        // failure as a load error instead of silently replacing it with an
        // empty Y.Doc and then persisting that blank state as authoritative.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to decode legacy prose for ${kind}:${entityId}: ${detail}`);
      }
    },
    [entityId, kind, legacyContent],
  );

  const { ydoc, isReady, error } = useYjsSync({
    docId: makeDocId(kind, entityId),
    userId: userId ?? '',
    projectId,
    // No onMaterialize: the editor's onPersist path (useEntityEditor →
    // editor.onUpdate → caller's onPersist) already writes the materialized
    // contentJson via the entity-sync mutation log. Doing it from here too
    // would double the writes for the same value.
    seedFromLegacy: userId ? seedFromLegacy : undefined,
  });

  return {
    ydoc: userId && isReady ? ydoc : undefined,
    ydocReady: isReady,
    ydocError: error,
  };
}
