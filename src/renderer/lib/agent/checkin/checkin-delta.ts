/**
 * What changed in a project since a moment in time, for the Project Home
 * check-in. Durable revision provenance names the prose documents that changed
 * and who changed them; the newest local snapshot at or before that moment is
 * the baseline, and the persisted Yjs state is the current text. The result is
 * a bounded, model-readable digest — never a write path.
 */
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { getDb } from '../../db';
import {
  EntitySnapshotHistoryTable,
  YjsDocumentRevisionProvenanceTable,
  yjsSnapshots,
  yjsUpdates,
} from '../../../schema/drizzle';
import { useDataStore } from '../../../store/data-store';
import { parseDocId, type ProseEntityType } from '../../yjs-doc-id';
import { computeBlockChanges, diffTokens } from '../block-diff';
import { docToPlainText } from '../serialize';

export type CheckinChangeSource = 'user' | 'agent' | 'remote';

export interface CheckinChangedDocument {
  /** Short handle the model uses to point a card at this object. */
  ref: string;
  entityType: ProseEntityType;
  entityId: string;
  /** Chapter, idea, element, storyline or element category. */
  objectKind: 'chapter' | 'idea' | 'element' | 'storyline' | 'category';
  title: string;
  lastChangedAt: string;
  revisions: Record<CheckinChangeSource, number>;
  /** False when the object is new or has no local snapshot before `since`. */
  hasBaseline: boolean;
  /** Bounded plain-text digest of the changed passages. */
  digest: string;
}

const TRACKED_SOURCES: readonly CheckinChangeSource[] = ['user', 'agent', 'remote'];
const DEFAULT_MAX_DOCUMENTS = 8;
const DOCUMENT_DIGEST_CHARACTERS = 3_000;
const PASSAGE_CHARACTERS = 360;
const NEW_DOCUMENT_HEAD = 1_400;
const NEW_DOCUMENT_TAIL = 500;
/** LCS cells above this fall back to before/after excerpts. */
const MAX_TOKEN_DIFF_CELLS = 2_000_000;

interface ProjectObject {
  entityType: ProseEntityType;
  objectKind: CheckinChangedDocument['objectKind'];
  title: string;
}

function liveProjectObjects(projectId: string): Map<string, ProjectObject> {
  const state = useDataStore.getState();
  const objects = new Map<string, ProjectObject>();
  const live = (value: { projectId: string; deletedAt?: string | null }) =>
    value.projectId === projectId && !value.deletedAt;
  for (const node of state.bookNodes) {
    if (!live(node)) continue;
    objects.set(`node:${node.id}`, {
      entityType: 'node',
      objectKind: node.kind === 'drift' ? 'idea' : 'chapter',
      title: node.title || node.summary || '',
    });
  }
  for (const element of state.bookElements) {
    if (live(element)) {
      objects.set(`element:${element.id}`, {
        entityType: 'element',
        objectKind: 'element',
        title: element.name,
      });
    }
  }
  for (const storyline of state.storylines) {
    if (live(storyline)) {
      objects.set(`storyline:${storyline.id}`, {
        entityType: 'storyline',
        objectKind: 'storyline',
        title: storyline.name,
      });
    }
  }
  for (const category of state.bookElementCategories) {
    if (live(category)) {
      objects.set(`category:${category.id}`, {
        entityType: 'category',
        objectKind: 'category',
        title: category.name,
      });
    }
  }
  return objects;
}

function entityForDoc(docId: string): { entityType: ProseEntityType; entityId: string } | null {
  const parsed = parseDocId(docId);
  if (!parsed) return null;
  return {
    entityType: parsed.kind === 'node-content' ? 'node' : parsed.kind,
    entityId: parsed.entityId,
  };
}

interface ChangedDocRow {
  docId: string;
  entityType: ProseEntityType;
  entityId: string;
  object: ProjectObject;
  lastChangedAt: string;
  revisions: Record<CheckinChangeSource, number>;
}

async function changedDocuments(projectId: string, sinceIso: string): Promise<ChangedDocRow[]> {
  const provenance = YjsDocumentRevisionProvenanceTable;
  const rows = await getDb()
    .select({
      docId: provenance.docId,
      sourceKind: provenance.sourceKind,
      count: sql<number>`count(*)`,
      lastAt: sql<string>`max(${provenance.createdAt})`,
    })
    .from(provenance)
    .where(
      and(
        gt(provenance.createdAt, sinceIso),
        inArray(provenance.sourceKind, [...TRACKED_SOURCES]),
      ),
    )
    .groupBy(provenance.docId, provenance.sourceKind);
  const objects = liveProjectObjects(projectId);
  const byDoc = new Map<string, ChangedDocRow>();
  for (const row of rows) {
    const entity = entityForDoc(row.docId);
    const object = entity ? objects.get(`${entity.entityType}:${entity.entityId}`) : undefined;
    if (!entity || !object) continue;
    const current =
      byDoc.get(row.docId) ??
      {
        docId: row.docId,
        ...entity,
        object,
        lastChangedAt: row.lastAt,
        revisions: { user: 0, agent: 0, remote: 0 },
      };
    current.revisions[row.sourceKind as CheckinChangeSource] += Number(row.count) || 0;
    if (row.lastAt > current.lastChangedAt) current.lastChangedAt = row.lastAt;
    byDoc.set(row.docId, current);
  }
  return [...byDoc.values()].sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt));
}

/** Cheap probe: did any tracked prose in this project change after `since`? */
export async function hasCheckinDelta(projectId: string, sinceIso: string): Promise<boolean> {
  return (await changedDocuments(projectId, sinceIso)).length > 0;
}

async function currentContentJson(docId: string): Promise<string | null> {
  const db = getDb();
  const [snapshot] = await db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId));
  const updates = await db
    .select({ updateBlob: yjsUpdates.updateBlob })
    .from(yjsUpdates)
    .where(eq(yjsUpdates.docId, docId))
    .orderBy(yjsUpdates.id);
  if (!snapshot && updates.length === 0) return null;
  const doc = new Y.Doc();
  try {
    if (snapshot) Y.applyUpdate(doc, toBytes(snapshot.stateBlob), 'load');
    for (const update of updates) Y.applyUpdate(doc, toBytes(update.updateBlob), 'load');
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

async function baselineContentJson(
  entityType: ProseEntityType,
  entityId: string,
  sinceIso: string,
): Promise<string | null> {
  const history = EntitySnapshotHistoryTable;
  const [row] = await getDb()
    .select({ contentJson: history.contentJson })
    .from(history)
    .where(
      and(
        eq(history.entityKind, entityType),
        eq(history.entityId, entityId),
        lte(history.createdAt, sinceIso),
      ),
    )
    .orderBy(desc(history.createdAt))
    .limit(1);
  return row?.contentJson ?? null;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  const buffer = value as { type?: string; data?: number[] } | null;
  if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) return Uint8Array.from(buffer.data);
  throw new Error('Unsupported Yjs blob format');
}

function clip(text: string, limit = PASSAGE_CHARACTERS): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

/** One changed paragraph as inline `[-removed-]{+added+}` with clipped context. */
export function describeChangedPassage(oldText: string, newText: string): string {
  if (oldText.length * newText.length > MAX_TOKEN_DIFF_CELLS) {
    return `原：${clip(oldText)}\n  现：${clip(newText)}`;
  }
  const parts: string[] = [];
  for (const segment of diffTokens(oldText, newText)) {
    if (segment.kind === 'equal') {
      const text = segment.text.replace(/\s+/gu, ' ');
      parts.push(text.length > 60 ? `${text.slice(0, 24)}…${text.slice(-24)}` : text);
    } else if (segment.kind === 'del') {
      parts.push(`[-${clip(segment.text, 200)}-]`);
    } else {
      parts.push(`{+${clip(segment.text, 200)}+}`);
    }
  }
  return clip(parts.join(''), PASSAGE_CHARACTERS * 2);
}

/** Bounded digest of the block-level changes between two document versions. */
export function digestDocumentChanges(baselineJson: string | null, currentJson: string): string {
  if (!baselineJson) {
    const text = docToPlainText(currentJson).trim();
    if (!text) return '（正文为空）';
    if (text.length <= NEW_DOCUMENT_HEAD + NEW_DOCUMENT_TAIL) return text;
    return `${text.slice(0, NEW_DOCUMENT_HEAD)}\n……\n${text.slice(-NEW_DOCUMENT_TAIL)}`;
  }
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const change of computeBlockChanges(baselineJson, currentJson)) {
    const line =
      change.op === 'new'
        ? `+ ${clip(change.newText)}`
        : change.op === 'deleted'
          ? `- ${clip(change.oldText)}`
          : `~ ${describeChangedPassage(change.oldText, change.newText)}`;
    if (!line.replace(/^[+~-]\s*/u, '').trim()) continue;
    if (used + line.length > DOCUMENT_DIGEST_CHARACTERS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '（只有格式或空白变化）';
  if (omitted > 0) lines.push(`（另有 ${omitted} 处改动未列出）`);
  return lines.join('\n');
}

/**
 * The prose objects changed after `sinceIso`, newest first, each with a
 * bounded digest. Objects outside this project, trashed objects and system
 * revisions are skipped.
 */
export async function collectCheckinDelta(
  projectId: string,
  sinceIso: string,
  maxDocuments = DEFAULT_MAX_DOCUMENTS,
): Promise<CheckinChangedDocument[]> {
  const changed = (await changedDocuments(projectId, sinceIso)).slice(0, maxDocuments);
  const documents: CheckinChangedDocument[] = [];
  for (const row of changed) {
    const current = await currentContentJson(row.docId);
    if (!current) continue;
    const baseline = await baselineContentJson(row.entityType, row.entityId, sinceIso);
    documents.push({
      ref: `c${documents.length + 1}`,
      entityType: row.entityType,
      entityId: row.entityId,
      objectKind: row.object.objectKind,
      title: row.object.title,
      lastChangedAt: row.lastChangedAt,
      revisions: row.revisions,
      hasBaseline: baseline !== null,
      digest: digestDocumentChanges(baseline, current),
    });
  }
  return documents;
}
