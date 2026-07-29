import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import * as Y from 'yjs';

export const P3_CRASH_SCHEMA_VERSION = 1;
export const P3_CRASH_MARKERS = Object.freeze([
  'before_transaction',
  'after_yjs_before_projection',
  'after_projection_before_outbox',
  'after_outbox_before_result',
]);

const PRODUCT_RUNTIME_SQL = [
  '../../../../../../drizzle/0060_agent_runtime_persistence.sql',
  '../../../../../../drizzle/0061_agent_runtime_write_effect.sql',
]
  .map((relativePath) =>
    readFileSync(new URL(relativePath, import.meta.url), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    ),
  )
  .join('\n');

function canonicalize(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize a non-finite number.');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object') {
    throw new Error(`Cannot canonicalize ${typeof value}.`);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function transact(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function fixture(seed) {
  const suffix = String(seed).padStart(4, '0');
  const baseTimeMs = 1_800_100_000_000 + seed * 100_000;
  return {
    seed,
    projectId: `p3-project-${suffix}`,
    conversationId: `p3-conversation-${suffix}`,
    sessionId: `p3-session-${suffix}`,
    turnId: `p3-turn-${suffix}`,
    messageId: `p3-message-${suffix}`,
    toolCallId: `agent-tool:p3-session-${suffix}:p3-turn-${suffix}:call-${suffix}`,
    callId: `call-${suffix}`,
    idempotencyKey: `p3-session-${suffix}:p3-turn-${suffix}:call-${suffix}`,
    effectId: `agent-write:p3-session-${suffix}:p3-turn-${suffix}:call-${suffix}`,
    docId: `node:p3-node-${suffix}`,
    nodeId: `p3-node-${suffix}`,
    baseText: `base-${suffix}`,
    nextText: `after-${suffix}`,
    baseTimeMs,
  };
}

function at(data, offset) {
  return new Date(data.baseTimeMs + offset * 1_000).toISOString();
}

function proseText(doc) {
  return String(doc.getMap('prose').get('text') ?? '');
}

function loadCanonicalDoc(db, docId) {
  const doc = new Y.Doc({ gc: false });
  const snapshot = db
    .prepare(
      'SELECT state_blob FROM yjs_snapshots WHERE document_id = ? LIMIT 1',
    )
    .get(docId);
  if (snapshot?.state_blob) {
    Y.applyUpdate(doc, new Uint8Array(snapshot.state_blob), 'p3-load-snapshot');
  }
  const updates = db
    .prepare(
      'SELECT update_blob FROM yjs_updates WHERE document_id = ? ORDER BY id',
    )
    .all(docId);
  for (const row of updates) {
    Y.applyUpdate(doc, new Uint8Array(row.update_blob), 'p3-load-update');
  }
  return doc;
}

export function createP3CrashSchema(db, seed) {
  const data = fixture(seed);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE project (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_conversation (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      sdk_session_id TEXT,
      mode TEXT NOT NULL DEFAULT 'byok',
      messages_json TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE yjs_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      update_blob BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_yjs_updates_doc ON yjs_updates(document_id);
    CREATE TABLE yjs_snapshots (
      document_id TEXT PRIMARY KEY NOT NULL,
      state_blob BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(PRODUCT_RUNTIME_SQL);
  db.exec(`
    CREATE TABLE acceptance_prose_projection (
      document_id TEXT PRIMARY KEY NOT NULL,
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE acceptance_sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      update_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, document_id, update_hash)
    );
    CREATE TABLE acceptance_dispatch_attempt (
      effect_id TEXT PRIMARY KEY NOT NULL,
      started_at TEXT NOT NULL
    );
  `);

  const baseDoc = new Y.Doc({ gc: false });
  baseDoc.getMap('prose').set('text', data.baseText);
  const baseState = Y.encodeStateAsUpdate(baseDoc);
  transact(db, () => {
    db.prepare(`
      INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES (?, 'P3 crash fixture', 'acceptance-user', ?, ?)
    `).run(data.projectId, at(data, 0), at(data, 0));
    db.prepare(`
      INSERT INTO agent_conversation (
        id, project_id, title, created_at, updated_at
      ) VALUES (?, ?, 'P3 crash fixture', ?, ?)
    `).run(
      data.conversationId,
      data.projectId,
      at(data, 0),
      at(data, 0),
    );
    db.prepare(`
      INSERT INTO agent_runtime_session (
        id, project_id, route_kind, conversation_id, provider, model,
        provider_epoch, status, created_at, updated_at
      ) VALUES (?, ?, 'chat', ?, 'acceptance', 'deterministic', 0, 'running', ?, ?)
    `).run(
      data.sessionId,
      data.projectId,
      data.conversationId,
      at(data, 0),
      at(data, 0),
    );
    db.prepare(`
      INSERT INTO agent_runtime_turn (
        id, session_id, ordinal, status, prompt_message_id,
        accepted_at, started_at, updated_at
      ) VALUES (?, ?, 0, 'running', ?, ?, ?, ?)
    `).run(
      data.turnId,
      data.sessionId,
      data.messageId,
      at(data, 1),
      at(data, 1),
      at(data, 1),
    );
    db.prepare(`
      INSERT INTO agent_runtime_message (
        id, session_id, turn_id, ordinal, role, status,
        content_json, created_at, completed_at
      ) VALUES (?, ?, ?, 0, 'user', 'complete', ?, ?, ?)
    `).run(
      data.messageId,
      data.sessionId,
      data.turnId,
      canonicalJson(`edit ${data.nodeId}`),
      at(data, 1),
      at(data, 1),
    );
    db.prepare(`
      INSERT INTO agent_runtime_tool_call (
        id, session_id, turn_id, call_id, name, access, status,
        idempotency_key, arguments_json, created_at, started_at
      ) VALUES (?, ?, ?, ?, 'edit_block', 'write', 'running', ?, ?, ?, ?)
    `).run(
      data.toolCallId,
      data.sessionId,
      data.turnId,
      data.callId,
      data.idempotencyKey,
      canonicalJson({ node: data.nodeId, text: data.nextText }),
      at(data, 2),
      at(data, 2),
    );
    db.prepare(`
      INSERT INTO agent_runtime_write_effect (
        id, project_id, route_kind, conversation_id,
        session_id, turn_id, tool_call_id, call_id, tool_name,
        idempotency_key, phase, arguments_json, claimed_at,
        confirmed_at, updated_at
      ) VALUES (
        ?, ?, 'chat', ?, ?, ?, ?, ?, 'edit_block',
        ?, 'confirmed', ?, ?, ?, ?
      )
    `).run(
      data.effectId,
      data.projectId,
      data.conversationId,
      data.sessionId,
      data.turnId,
      data.toolCallId,
      data.callId,
      data.idempotencyKey,
      canonicalJson({ node: data.nodeId, text: data.nextText }),
      at(data, 2),
      at(data, 3),
      at(data, 3),
    );
    db.prepare(`
      INSERT INTO yjs_snapshots (document_id, state_blob, updated_at)
      VALUES (?, ?, ?)
    `).run(data.docId, baseState, at(data, 0));
    db.prepare(`
      INSERT INTO acceptance_prose_projection (
        document_id, content_json, updated_at
      ) VALUES (?, ?, ?)
    `).run(
      data.docId,
      canonicalJson({ text: data.baseText }),
      at(data, 0),
    );
  });
  baseDoc.destroy();
  return data;
}

export function writeThroughP3CrashMarker(db, marker, seed) {
  if (!P3_CRASH_MARKERS.includes(marker)) {
    throw new Error(`Unknown P3 crash marker: ${marker}`);
  }
  const data = fixture(seed);
  if (marker === 'before_transaction') return data;

  transact(db, () => {
    db.prepare(`
      UPDATE agent_runtime_write_effect
      SET phase = 'mutation_started',
          observed_revision_json = ?,
          preimage_json = ?,
          forward_json = ?,
          inverse_json = ?,
          reversibility = 'exact',
          mutation_started_at = ?,
          updated_at = ?
      WHERE id = ? AND phase = 'confirmed'
    `).run(
      canonicalJson({ revision: seed, state: data.baseText }),
      canonicalJson({ text: data.baseText }),
      canonicalJson({ text: data.nextText }),
      canonicalJson({ text: data.baseText }),
      at(data, 4),
      at(data, 4),
      data.effectId,
    );
    db.prepare(`
      INSERT INTO acceptance_dispatch_attempt (effect_id, started_at)
      VALUES (?, ?)
    `).run(data.effectId, at(data, 4));
  });

  const doc = loadCanonicalDoc(db, data.docId);
  const baseVector = Y.encodeStateVector(doc);
  doc.getMap('prose').set('text', data.nextText);
  const forwardUpdate = Y.encodeStateAsUpdate(doc, baseVector);
  if (marker === 'after_yjs_before_projection') {
    doc.destroy();
    return data;
  }

  db.exec('BEGIN IMMEDIATE');
  db.prepare(`
    INSERT INTO yjs_updates (document_id, update_blob, created_at)
    VALUES (?, ?, ?)
  `).run(data.docId, forwardUpdate, at(data, 5));
  db.prepare(`
    UPDATE acceptance_prose_projection
    SET content_json = ?, updated_at = ?
    WHERE document_id = ?
  `).run(
    canonicalJson({ text: data.nextText }),
    at(data, 5),
    data.docId,
  );
  if (marker === 'after_projection_before_outbox') {
    doc.destroy();
    return data;
  }

  const updateHash = createHash('sha256').update(forwardUpdate).digest('hex');
  db.prepare(`
    INSERT INTO acceptance_sync_outbox (
      project_id, document_id, update_hash, created_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    data.projectId,
    data.docId,
    updateHash,
    at(data, 5),
  );
  db.exec('COMMIT');
  doc.destroy();
  return data;
}

function settleInterruptedEffect(db, data) {
  const row = db
    .prepare(
      'SELECT phase FROM agent_runtime_write_effect WHERE id = ? LIMIT 1',
    )
    .get(data.effectId);
  if (!row) throw new Error(`Missing effect ${data.effectId}`);
  if (row.phase === 'claimed' || row.phase === 'confirmed') {
    db.prepare(`
      UPDATE agent_runtime_write_effect
      SET phase = 'failed',
          error_code = 'WRITE_INTERRUPTED_BEFORE_MUTATION',
          error_message = 'Interrupted before mutation start',
          failed_at = ?,
          updated_at = ?
      WHERE id = ? AND phase = ?
    `).run(
      at(data, 8),
      at(data, 8),
      data.effectId,
      row.phase,
    );
    return;
  }
  if (row.phase === 'mutation_started') {
    db.prepare(`
      UPDATE agent_runtime_write_effect
      SET phase = 'uncertain',
          error_code = 'WRITE_EFFECT_UNCERTAIN',
          error_message = 'Interrupted after mutation start',
          uncertain_at = ?,
          updated_at = ?
      WHERE id = ? AND phase = 'mutation_started'
    `).run(at(data, 8), at(data, 8), data.effectId);
  }
}

export function recoverP3CrashDatabase(db, marker, seed) {
  const data = fixture(seed);
  settleInterruptedEffect(db, data);
  // A duplicate/retry is intentionally evaluated after recovery. Terminal
  // failed/uncertain effects return inspection state without dispatching.
  settleInterruptedEffect(db, data);

  const effect = db
    .prepare(
      `SELECT phase, error_code
       FROM agent_runtime_write_effect
       WHERE id = ?`,
    )
    .get(data.effectId);
  const projection = db
    .prepare(
      `SELECT content_json
       FROM acceptance_prose_projection
       WHERE document_id = ?`,
    )
    .get(data.docId);
  const doc = loadCanonicalDoc(db, data.docId);
  const canonicalText = proseText(doc);
  const updateCount = Number(
    db
      .prepare(
        'SELECT count(*) AS value FROM yjs_updates WHERE document_id = ?',
      )
      .get(data.docId).value,
  );
  const outboxCount = Number(
    db
      .prepare(
        'SELECT count(*) AS value FROM acceptance_sync_outbox WHERE document_id = ?',
      )
      .get(data.docId).value,
  );
  const dispatchCount = Number(
    db
      .prepare(
        'SELECT count(*) AS value FROM acceptance_dispatch_attempt WHERE effect_id = ?',
      )
      .get(data.effectId).value,
  );
  const foreignKeyViolations = db
    .prepare('PRAGMA foreign_key_check')
    .all().length;
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const integrityFailures = integrity.filter(
    (row) => row.integrity_check !== 'ok',
  ).length;
  const projectionText = JSON.parse(projection.content_json).text;
  const expectedCommitted = marker === 'after_outbox_before_result';
  const expectedPhase =
    marker === 'before_transaction' ? 'failed' : 'uncertain';
  const expectedDispatches = marker === 'before_transaction' ? 0 : 1;
  const violations = {
    wrongRecoveryPhase: Number(effect.phase !== expectedPhase),
    blindRetry: Number(dispatchCount !== expectedDispatches),
    yjsDurabilityMismatch: Number(
      canonicalText !== (expectedCommitted ? data.nextText : data.baseText),
    ),
    projectionMismatch: Number(
      projectionText !== (expectedCommitted ? data.nextText : data.baseText),
    ),
    outboxMismatch: Number(outboxCount !== (expectedCommitted ? 1 : 0)),
    partialYjsUpdate: Number(updateCount !== (expectedCommitted ? 1 : 0)),
    foreignKeyViolations,
    integrityFailures,
  };
  const snapshot = {
    marker,
    seed,
    phase: effect.phase,
    errorCode: effect.error_code,
    canonicalText,
    projectionText,
    updateCount,
    outboxCount,
    dispatchCount,
  };
  doc.destroy();
  return {
    snapshot,
    snapshotHash: hashCanonical(snapshot),
    violations,
  };
}
