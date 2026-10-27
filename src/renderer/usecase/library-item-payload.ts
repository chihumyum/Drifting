import type { LibraryItem } from '../domain/library-item';

/** The authored sync payload of a material row (create and full updates). */
export function libraryMutationPayload(item: LibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    assetId: item.assetId,
    externalUrl: item.externalUrl,
    bodyJson: item.bodyJson,
    notesJson: item.notesJson,
    // Absent rather than null when unset: builds before migration 0009 reject
    // any provenanceJson field, so only materials that carry provenance need
    // every device on a current build.
    ...(item.provenanceJson !== null ? { provenanceJson: item.provenanceJson } : {}),
    // Likewise only filed materials and notes with TODOs switched off carry
    // the 0012 fields, so unfiled materials still sync to older builds.
    ...(item.folderId !== null ? { folderId: item.folderId } : {}),
    ...(item.taskTodos ? {} : { taskTodos: false }),
  };
}
