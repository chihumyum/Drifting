/**
 * Snapshot history — the entity "time machine" capture path.
 *
 * `maybeCaptureSnapshotHistory(docId, stateBlob, reason)` is called wherever
 * the Yjs layer already materializes a full-state snapshot (useYjsDoc's
 * periodic/unload snapshot, the agent's closed-doc writes, the sync pull).
 * It turns those moments into a durable, versioned trail:
 *
 *   - at most one capture per entity per 15 min ('periodic'; 'close' and
 *     'restore' bypass the interval, only the changed-check applies)
 *   - skipped entirely when the state is byte-identical to the latest row
 *   - each row stores the full Yjs state + a contentJson preview + a JSON bag
 *     of the entity's restorable metadata fields at capture time
 *   - rows are thinned Time-Machine style (≤24h: one per hour; older: one per
 *     day) and dropped after 30 days
 *   - synced paid users also push the capture to the server's entity_snapshot
 *     table (fire-and-forget; the local row is the source of truth for the UI)
 *
 * Failures NEVER propagate — this rides the editor's write path.
 */
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import loglevel from 'loglevel';
import { parseDocId, type ProseEntityType } from '../lib/yjs-doc-id';
import {
  createEntitySnapshotRepository,
  type EntitySnapshotRepository,
} from '../sqlite-repo/entity-snapshot-repo';
import { useDataStore } from '../store/data-store';
import { isSyncEnabled } from '../lib/config';
import { canUseFeature } from '../lib/feature-access';
import { apiClient } from '../lib/axios-config';

// Local copy of yjs-sync.service's uint8ToBase64 — importing it would create a
// service-level cycle (yjs-sync's pull path calls back into this service).
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const log = loglevel.getLogger('snapshot-history');
log.setLevel(loglevel.levels.WARN);

const CAPTURE_MIN_INTERVAL_MS = 15 * 60_000;
const RETENTION_DAYS = 30;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type CaptureReason = 'periodic' | 'close' | 'restore';

/** The restorable metadata fields snapshotted alongside the prose body. */
export interface SnapshotMeta {
  // node
  title?: string;
  writingStatus?: string;
  // element / storyline / category
  name?: string;
  aliases?: string[];
  groupName?: string | null;
  kvJson?: string;
  elementTemplateKvJson?: string;
  // shared
  summary?: string;
}

function docKindToEntityKind(kind: ReturnType<typeof parseDocId>): ProseEntityType | null {
  if (!kind) return null;
  return kind.kind === 'node-content' ? 'node' : kind.kind;
}

/** Look up the entity's projectId + restorable metadata from the data store.
 *  Returns null when the entity isn't loaded (foreign project / just deleted) —
 *  in that case we skip the capture rather than write an orphan row. */
function entityMeta(
  entityKind: ProseEntityType,
  entityId: string,
): { projectId: string; meta: SnapshotMeta } | null {
  const s = useDataStore.getState();
  switch (entityKind) {
    case 'node': {
      const n = s.bookNodes.find((x) => x.id === entityId);
      return n
        ? {
            projectId: n.projectId,
            meta: { title: n.title, summary: n.summary, writingStatus: n.writingStatus },
          }
        : null;
    }
    case 'element': {
      const e = s.bookElements.find((x) => x.id === entityId);
      return e
        ? {
            projectId: e.projectId,
            meta: {
              name: e.name,
              summary: e.summary,
              aliases: e.aliases,
              groupName: e.groupName,
              kvJson: e.kvJson,
            },
          }
        : null;
    }
    case 'storyline': {
      const sl = s.storylines.find((x) => x.id === entityId);
      return sl
        ? { projectId: sl.projectId, meta: { name: sl.name, summary: sl.summary, kvJson: sl.kvJson } }
        : null;
    }
    case 'category': {
      const c = s.bookElementCategories.find((x) => x.id === entityId);
      return c
        ? {
            projectId: c.projectId,
            meta: { name: c.name, elementTemplateKvJson: c.elementTemplateKvJson },
          }
        : null;
    }
  }
}

function blobsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Render the state blob into TipTap JSON for the history UI's preview. */
async function stateToContentJson(stateBlob: Uint8Array): Promise<string | null> {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stateBlob, 'load');
    const { yDocToProsemirrorJSON } = await import('y-prosemirror');
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } catch (err) {
    log.warn('snapshot preview render failed', err);
    return null;
  } finally {
    doc.destroy();
  }
}

/**
 * Time-Machine thinning over an entity's rows (newest first): within the last
 * 24h keep the newest row per hour; older keep the newest per day. Returns the
 * ids to delete. The newest row overall always survives (first in its bucket).
 */
export function computeThinningVictims(
  rows: { id: string; createdAt: string }[],
  nowMs: number,
): string[] {
  const victims: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const t = Date.parse(row.createdAt);
    if (Number.isNaN(t)) continue;
    const age = nowMs - t;
    const bucket =
      age < DAY_MS ? `h:${Math.floor(t / HOUR_MS)}` : `d:${Math.floor(t / DAY_MS)}`;
    if (seen.has(bucket)) victims.push(row.id);
    else seen.add(bucket);
  }
  return victims;
}

/** Fire-and-forget cloud copy (synced + paid only — server enforces too). */
function pushToCloud(row: {
  id: string;
  projectId: string;
  entityKind: ProseEntityType;
  entityId: string;
  stateBlob: Uint8Array;
  contentJson: string | null;
  metaJson: string | null;
}): void {
  if (!isSyncEnabled() || !canUseFeature('snapshot')) return;
  void apiClient
    .post('/api/snapshots', {
      id: row.id,
      projectId: row.projectId,
      entityKind: row.entityKind,
      entityId: row.entityId,
      stateBlobBase64: uint8ToBase64(row.stateBlob),
      contentJson: row.contentJson,
      metaJson: row.metaJson,
    })
    .catch((err) => log.warn(`snapshot cloud push failed for ${row.entityKind}:${row.entityId}`, err));
}

// One in-flight capture chain per process — captures are rare (15-min gated)
// and serializing them keeps the dedup read-modify-write race-free.
let captureChain: Promise<void> = Promise.resolve();

export function maybeCaptureSnapshotHistory(
  docId: string,
  stateBlob: Uint8Array,
  reason: CaptureReason = 'periodic',
): void {
  // Copy now — the caller's buffer may be reused after this returns.
  const blob = new Uint8Array(stateBlob);
  captureChain = captureChain
    .then(() => captureOnce(docId, blob, reason))
    .catch((err) => log.warn(`snapshot capture failed for ${docId}`, err));
}

async function captureOnce(docId: string, stateBlob: Uint8Array, reason: CaptureReason): Promise<void> {
  const parsed = parseDocId(docId);
  const entityKind = docKindToEntityKind(parsed);
  if (!parsed || !entityKind) return;
  const entityId = parsed.entityId;
  const found = entityMeta(entityKind, entityId);
  if (!found) return;

  const repo = createEntitySnapshotRepository();
  const latest = await repo.getLatestForEntity(entityKind, entityId);
  if (latest) {
    if (blobsEqual(latest.stateBlob, stateBlob)) return; // nothing new
    if (
      reason === 'periodic' &&
      Date.now() - Date.parse(latest.createdAt) < CAPTURE_MIN_INTERVAL_MS
    ) {
      return; // too soon — the next periodic snapshot will catch it
    }
  }

  const row = {
    id: uuidv7(),
    projectId: found.projectId,
    entityKind,
    entityId,
    stateBlob,
    contentJson: await stateToContentJson(stateBlob),
    metaJson: JSON.stringify(found.meta),
    createdAt: new Date().toISOString(),
  };
  await repo.insert(row);
  log.info(`captured snapshot ${entityKind}:${entityId} (${reason}, ${stateBlob.byteLength}B)`);

  pushToCloud(row);
  await cleanup(repo, entityKind, entityId);
}

async function cleanup(
  repo: EntitySnapshotRepository,
  entityKind: ProseEntityType,
  entityId: string,
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString();
    await repo.deleteOlderThan(cutoff);
    const rows = await repo.listForEntity(entityKind, entityId);
    const victims = computeThinningVictims(rows, Date.now());
    if (victims.length) await repo.deleteByIds(victims);
  } catch (err) {
    log.warn('snapshot cleanup failed', err);
  }
}
