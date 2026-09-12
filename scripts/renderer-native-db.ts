import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

export const nativeEditMarker = ' NATIVE_ACCEPTANCE_SAVED';

function plainText(node: { text?: string; content?: Array<Parameters<typeof plainText>[0]> }): string {
  return node.text ?? node.content?.map(plainText).join('') ?? '';
}

/** Independent read-only replay; never uses contentJson as prose truth. */
export function inspectNativeFixture(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const nodes = db.prepare('SELECT id, project_id, title FROM book_node WHERE deleted_at IS NULL ORDER BY project_id, title').all();
    const chapters = nodes.map(node => {
      const doc = new Y.Doc();
      try {
        const id = `node-content:${node.id}`;
        const snapshot = db.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id = ?').get(id);
        if (snapshot) Y.applyUpdate(doc, snapshot.state_blob as Uint8Array);
        for (const row of db.prepare('SELECT update_blob FROM yjs_updates WHERE document_id = ? ORDER BY id').all(id)) {
          Y.applyUpdate(doc, row.update_blob as Uint8Array);
        }
        const text = plainText(yDocToProsemirrorJSON(doc, 'default'));
        return { id: String(node.id), projectId: String(node.project_id), title: String(node.title),
          characters: text.length, sha256: createHash('sha256').update(text).digest('hex'),
          hasSavedMarker: text.endsWith(nativeEditMarker) };
      } finally { doc.destroy(); }
    });
    const elements = db.prepare('SELECT id, project_id, name FROM element WHERE deleted_at IS NULL ORDER BY project_id, name').all();
    const relations = db.prepare('SELECT project_id, from_kind, from_id, to_kind, to_id, relation_type_id FROM entity_relation ORDER BY project_id, from_id, to_id, relation_type_id').all();
    const semanticSha256 = createHash('sha256').update(JSON.stringify({ chapters, elements, relations })).digest('hex');
    return { chapters, elements: elements.length, relations: relations.length, semanticSha256,
      comments: Number(db.prepare('SELECT count(*) AS count FROM comment').get()?.count) };
  } finally { db.close(); }
}
