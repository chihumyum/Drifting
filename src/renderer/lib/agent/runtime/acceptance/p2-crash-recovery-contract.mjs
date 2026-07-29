import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export const P2_CRASH_RECOVERY_SCHEMA_VERSION = 1;

const PRODUCT_MIGRATION_SQL = readFileSync(
  new URL('../../../../../../drizzle/0060_agent_runtime_persistence.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

export const P2_CRASH_MARKERS = Object.freeze([
  'after_turn_accepted',
  'after_turn_started',
  'after_partial_assistant',
  'after_tool_call_started',
  'after_tool_call_ready',
  'after_tool_execution_started',
  'after_tool_result_committed',
  'after_final_assistant_delta',
  'after_terminal_journal',
  'after_turn_committed',
]);

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number.');
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

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function runTransaction(db, operation) {
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

function prepareDatabase(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

export function createAcceptanceSchema(db) {
  prepareDatabase(db);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

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
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
  `);
  db.exec(PRODUCT_MIGRATION_SQL);
}

function fixture(seed) {
  const suffix = String(seed).padStart(4, '0');
  return {
    seed,
    projectId: `project-${suffix}`,
    sessionId: `session-${suffix}`,
    turnId: `turn-${suffix}`,
    promptMessageId: `message-${suffix}-user`,
    assistantMessageId: `message-${suffix}-assistant-tool`,
    toolMessageId: `message-${suffix}-tool`,
    finalMessageId: `message-${suffix}-assistant-final`,
    callId: `call-${suffix}`,
    checkpointId: `checkpoint-${suffix}`,
    prompt: `请读取种子 ${seed} 的项目摘要。`,
    partialText: `正在读取项目 ${seed}`,
    finalText: `项目 ${seed} 的摘要读取完成。`,
    baseTimeMs: 1_800_000_000_000 + seed * 100_000,
  };
}

function stageTime(data, stage) {
  return new Date(data.baseTimeMs + stage * 1_000).toISOString();
}

function eventId(turnId, seq) {
  return `${turnId}:${String(seq).padStart(8, '0')}`;
}

function insertEvent(db, data, seq, eventType, payload, stage) {
  const time = stageTime(data, stage);
  db.prepare(`
    INSERT INTO agent_runtime_event (
      event_id, session_id, turn_id, seq, schema_version,
      event_type, payload_json, wall_time_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId(data.turnId, seq),
    data.sessionId,
    data.turnId,
    seq,
    P2_CRASH_RECOVERY_SCHEMA_VERSION,
    eventType,
    canonicalJson(payload),
    data.baseTimeMs + stage * 1_000,
    time,
  );
}

function assistantToolContent(data) {
  return [
    { type: 'text', text: data.partialText },
    {
      type: 'tool_call',
      callId: data.callId,
      name: 'read_project',
      arguments: { projectId: data.projectId },
      rawArguments: canonicalJson({ projectId: data.projectId }),
    },
  ];
}

function completeCanonicalHistory(data) {
  return [
    {
      role: 'user',
      content: data.prompt,
    },
    {
      role: 'assistant',
      content: assistantToolContent(data),
    },
    {
      role: 'tool',
      content: [
        {
          callId: data.callId,
          name: 'read_project',
          ok: true,
          content: `project-${data.seed}-summary`,
        },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: data.finalText }],
    },
  ];
}

const WRITER_STAGES = [
  (db, data) => {
    const time = stageTime(data, 1);
    runTransaction(db, () => {
      db.prepare(`
        INSERT INTO project (id, name, user_id, created_at, updated_at)
        VALUES (?, 'Recovery fixture', 'acceptance-user', ?, ?)
      `).run(data.projectId, time, time);
      db.prepare(`
        INSERT INTO agent_conversation (
          id, project_id, title, created_at, updated_at
        ) VALUES (?, ?, 'Recovery', ?, ?)
      `).run(`conversation-${data.seed}`, data.projectId, time, time);
      db.prepare(`
        INSERT INTO agent_runtime_session (
          id, project_id, route_kind, conversation_id, provider, model,
          provider_epoch, status, created_at, updated_at
        ) VALUES (?, ?, 'chat', ?, 'deepseek', 'deepseek-chat', 1, 'running', ?, ?)
      `).run(data.sessionId, data.projectId, `conversation-${data.seed}`, time, time);
      db.prepare(`
        UPDATE agent_conversation
        SET runtime_session_id = ?, updated_at = ?
        WHERE id = ?
      `).run(data.sessionId, time, `conversation-${data.seed}`);
      db.prepare(`
        INSERT INTO agent_runtime_turn (
          id, session_id, ordinal, status, prompt_message_id,
          accepted_at, updated_at
        ) VALUES (?, ?, 0, 'accepted', ?, ?, ?)
      `).run(data.turnId, data.sessionId, data.promptMessageId, time, time);
      db.prepare(`
        INSERT INTO agent_runtime_message (
          id, session_id, turn_id, ordinal, role, status,
          content_json, created_at, completed_at
        ) VALUES (?, ?, ?, 0, 'user', 'complete', ?, ?, ?)
      `).run(
        data.promptMessageId,
        data.sessionId,
        data.turnId,
        canonicalJson(data.prompt),
        time,
        time,
      );
    });
  },
  (db, data) => {
    const time = stageTime(data, 2);
    runTransaction(db, () => {
      db.prepare(`
        UPDATE agent_runtime_session
        SET status = 'running', updated_at = ?
        WHERE id = ?
      `).run(time, data.sessionId);
      db.prepare(`
        UPDATE agent_runtime_turn
        SET status = 'running', started_at = ?, updated_at = ?
        WHERE id = ?
      `).run(time, time, data.turnId);
      insertEvent(
        db,
        data,
        1,
        'turn_started',
        { prompt: data.prompt },
        2,
      );
    });
  },
  (db, data) => {
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        2,
        'model_iteration_started',
        { iteration: 1 },
        3,
      );
      insertEvent(
        db,
        data,
        3,
        'text_delta',
        { iteration: 1, text: data.partialText },
        3,
      );
    });
  },
  (db, data) => {
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        4,
        'tool_call_started',
        { iteration: 1, callId: data.callId, name: 'read_project' },
        4,
      );
    });
  },
  (db, data) => {
    const time = stageTime(data, 5);
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        5,
        'tool_args_delta',
        {
          iteration: 1,
          callId: data.callId,
          delta: canonicalJson({ projectId: data.projectId }),
        },
        5,
      );
      insertEvent(
        db,
        data,
        6,
        'tool_call_ready',
        {
          iteration: 1,
          callId: data.callId,
          name: 'read_project',
          arguments: { projectId: data.projectId },
        },
        5,
      );
      db.prepare(`
        INSERT INTO agent_runtime_tool_call (
          id, session_id, turn_id, call_id, name, access, status,
          idempotency_key, arguments_json, created_at
        ) VALUES (?, ?, ?, ?, 'read_project', 'read', 'requested', ?, ?, ?)
      `).run(
        `tool-record-${data.seed}`,
        data.sessionId,
        data.turnId,
        data.callId,
        `${data.sessionId}:${data.turnId}:${data.callId}`,
        canonicalJson({ projectId: data.projectId }),
        time,
      );
    });
  },
  (db, data) => {
    const time = stageTime(data, 6);
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        7,
        'model_iteration_completed',
        { iteration: 1, stopReason: 'tool_use' },
        6,
      );
      insertEvent(
        db,
        data,
        8,
        'tool_execution_started',
        { callId: data.callId, name: 'read_project', access: 'read' },
        6,
      );
      db.prepare(`
        UPDATE agent_runtime_tool_call
        SET status = 'running', started_at = ?
        WHERE session_id = ? AND call_id = ?
      `).run(time, data.sessionId, data.callId);
    });
  },
  (db, data) => {
    const time = stageTime(data, 7);
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        9,
        'tool_result',
        {
          callId: data.callId,
          name: 'read_project',
          ok: true,
          content: `project-${data.seed}-summary`,
        },
        7,
      );
      db.prepare(`
        UPDATE agent_runtime_tool_call
        SET status = 'completed', result_json = ?, completed_at = ?
        WHERE session_id = ? AND call_id = ?
      `).run(
        canonicalJson({
          ok: true,
          content: `project-${data.seed}-summary`,
        }),
        time,
        data.sessionId,
        data.callId,
      );
    });
  },
  (db, data) => {
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        10,
        'model_iteration_started',
        { iteration: 2 },
        8,
      );
      insertEvent(
        db,
        data,
        11,
        'text_delta',
        { iteration: 2, text: data.finalText },
        8,
      );
      insertEvent(
        db,
        data,
        12,
        'model_iteration_completed',
        { iteration: 2, stopReason: 'end_turn' },
        8,
      );
    });
  },
  (db, data) => {
    runTransaction(db, () => {
      insertEvent(
        db,
        data,
        13,
        'turn_finished',
        { outcome: 'completed', modelIterations: 2 },
        9,
      );
    });
  },
  (db, data) => {
    const time = stageTime(data, 10);
    runTransaction(db, () => {
      db.prepare(`
        INSERT INTO agent_runtime_message (
          id, session_id, turn_id, ordinal, role, status,
          content_json, created_at, completed_at
        ) VALUES (?, ?, ?, 1, 'assistant', 'complete', ?, ?, ?)
      `).run(
        data.assistantMessageId,
        data.sessionId,
        data.turnId,
        canonicalJson(assistantToolContent(data)),
        time,
        time,
      );
      db.prepare(`
        INSERT INTO agent_runtime_message (
          id, session_id, turn_id, ordinal, role, status,
          content_json, created_at, completed_at
        ) VALUES (?, ?, ?, 2, 'tool', 'complete', ?, ?, ?)
      `).run(
        data.toolMessageId,
        data.sessionId,
        data.turnId,
        canonicalJson([
          {
            callId: data.callId,
            name: 'read_project',
            ok: true,
            content: `project-${data.seed}-summary`,
          },
        ]),
        time,
        time,
      );
      db.prepare(`
        INSERT INTO agent_runtime_message (
          id, session_id, turn_id, ordinal, role, status,
          content_json, created_at, completed_at
        ) VALUES (?, ?, ?, 3, 'assistant', 'complete', ?, ?, ?)
      `).run(
        data.finalMessageId,
        data.sessionId,
        data.turnId,
        canonicalJson([{ type: 'text', text: data.finalText }]),
        time,
        time,
      );
      const history = completeCanonicalHistory(data);
      db.prepare(`
        INSERT INTO agent_runtime_checkpoint (
          id, session_id, through_turn_ordinal, message_count,
          context_json, context_hash, created_at
        ) VALUES (?, ?, 0, 4, ?, ?, ?)
      `).run(
        data.checkpointId,
        data.sessionId,
        canonicalJson(history),
        `sha256:${hashCanonical(history)}`,
        time,
      );
      db.prepare(`
        UPDATE agent_runtime_turn
        SET status = 'completed', ended_at = ?, updated_at = ?
        WHERE id = ?
      `).run(time, time, data.turnId);
      db.prepare(`
        UPDATE agent_runtime_session
        SET status = 'idle', ended_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(time, data.sessionId);
    });
  },
];

export function writeThroughCrashMarker(db, marker, seed) {
  const markerIndex = P2_CRASH_MARKERS.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Unknown crash marker: ${marker}`);
  const data = fixture(seed);
  for (let index = 0; index <= markerIndex; index += 1) {
    WRITER_STAGES[index](db, data);
  }
  return data;
}

function parseContent(row, corruptions) {
  try {
    return JSON.parse(row.content_json);
  } catch {
    corruptions.count += 1;
    return null;
  }
}

function readRows(db, table, orderBy) {
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

function buildCompleteHistory(messages, turns, corruptions) {
  const completedTurnIds = new Set(
    turns
      .filter((turn) => turn.status === 'completed')
      .map((turn) => turn.id),
  );
  const parsed = messages.map((row) => ({
    ...row,
    content: parseContent(row, corruptions),
  }));
  const completeToolMessages = new Map();
  for (const message of parsed) {
    if (message.role !== 'tool' || message.status !== 'complete') continue;
    if (!Array.isArray(message.content) || message.content.length === 0) {
      corruptions.count += 1;
      continue;
    }
    for (const result of message.content) {
      if (typeof result?.callId !== 'string') {
        corruptions.count += 1;
        continue;
      }
      const current = completeToolMessages.get(result.callId) ?? [];
      current.push(message);
      completeToolMessages.set(result.callId, current);
    }
  }

  const assistantCallIds = new Set();
  const history = [];
  for (const message of parsed) {
    if (
      message.status !== 'complete' ||
      !message.turn_id ||
      !completedTurnIds.has(message.turn_id)
    ) {
      continue;
    }
    if (message.role === 'user') {
      history.push({ id: message.id, role: 'user', content: message.content });
      continue;
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const calls = message.content.filter((block) => block?.type === 'tool_call');
    const hasCompleteResults = calls.every((block) => {
      const matches = completeToolMessages.get(block.callId) ?? [];
      return matches.length === 1;
    });
    if (!hasCompleteResults) continue;
    history.push({ id: message.id, role: 'assistant', content: message.content });
    for (const call of calls) assistantCallIds.add(call.callId);
  }

  for (const message of parsed) {
    if (message.role !== 'tool' || message.status !== 'complete') continue;
    if (
      !Array.isArray(message.content) ||
      message.content.length === 0 ||
      !message.content.every(
        (result) =>
          typeof result?.callId === 'string' &&
          assistantCallIds.has(result.callId),
      )
    ) {
      continue;
    }
    history.push({ id: message.id, role: 'tool', content: message.content });
  }

  history.sort((left, right) => {
    const leftMessage = parsed.find((message) => message.id === left.id);
    const rightMessage = parsed.find((message) => message.id === right.id);
    return (leftMessage?.ordinal ?? 0) - (rightMessage?.ordinal ?? 0);
  });
  return history;
}

function nextEventSeq(db, turnId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agent_runtime_event WHERE turn_id = ?')
    .get(turnId);
  return Number(row.max_seq) + 1;
}

function recoveryTime(seed, markerIndex) {
  return new Date(1_900_000_000_000 + seed * 100_000 + markerIndex * 1_000).toISOString();
}

function closeInterruptedTurn(db, session, turn, markerIndex) {
  const events = db
    .prepare(`
      SELECT seq, event_type, payload_json
      FROM agent_runtime_event
      WHERE turn_id = ?
      ORDER BY seq
    `)
    .all(turn.id);
  const started = new Map();
  const settled = new Set();
  for (const event of events) {
    const payload = JSON.parse(event.payload_json);
    if (event.event_type === 'tool_call_started' && typeof payload.callId === 'string') {
      started.set(payload.callId, payload.name ?? 'unknown');
    }
    if (
      (event.event_type === 'tool_result' ||
        event.event_type === 'recovery_tool_interrupted') &&
      typeof payload.callId === 'string'
    ) {
      settled.add(payload.callId);
    }
  }
  let seq = nextEventSeq(db, turn.id);
  const seed = Number(session.id.split('-').at(-1));
  const time = recoveryTime(seed, markerIndex);
  for (const [callId, name] of started) {
    if (settled.has(callId)) continue;
    insertEvent(
      db,
      {
        sessionId: session.id,
        turnId: turn.id,
        baseTimeMs: Date.parse(time),
      },
      seq,
      'recovery_tool_interrupted',
      { callId, name, reason: 'process_terminated' },
      0,
    );
    seq += 1;
  }
  const terminalCount = events.filter((event) => event.event_type === 'turn_finished').length;
  if (terminalCount === 0) {
    insertEvent(
      db,
      {
        sessionId: session.id,
        turnId: turn.id,
        baseTimeMs: Date.parse(time),
      },
      seq,
      'turn_finished',
      {
        outcome: 'failed',
        failureCode: 'PROCESS_INTERRUPTED',
        message: 'The process terminated before the turn committed a terminal state.',
      },
      0,
    );
  }
  db.prepare(`
    UPDATE agent_runtime_message
    SET status = 'interrupted', completed_at = ?
    WHERE turn_id = ? AND status = 'streaming'
  `).run(time, turn.id);
  db.prepare(`
    UPDATE agent_runtime_tool_call
    SET status = 'interrupted', completed_at = ?,
        error_code = 'PROCESS_INTERRUPTED'
    WHERE turn_id = ?
      AND access = 'read'
      AND status IN ('requested', 'running')
  `).run(time, turn.id);
  db.prepare(`
    UPDATE agent_runtime_tool_call
    SET status = 'uncertain', completed_at = ?,
        error_code = 'PROCESS_INTERRUPTED_AFTER_WRITE_START'
    WHERE turn_id = ?
      AND access = 'write'
      AND status = 'running'
  `).run(time, turn.id);
  db.prepare(`
    UPDATE agent_runtime_turn
    SET status = 'interrupted', ended_at = ?,
        error_code = 'PROCESS_INTERRUPTED',
        error_message = 'Agent process stopped before the turn committed.',
        updated_at = ?
    WHERE id = ?
  `).run(time, time, turn.id);
  db.prepare(`
    UPDATE agent_runtime_session
    SET status = 'interrupted', ended_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(time, session.id);
}

function validateRecoveredState(db, markerIndex) {
  const corruptions = { count: 0 };
  const sessions = readRows(db, 'agent_runtime_session', 'id');
  const turns = readRows(db, 'agent_runtime_turn', 'session_id, ordinal, id');
  const messages = readRows(db, 'agent_runtime_message', 'session_id, ordinal, id');
  const events = readRows(db, 'agent_runtime_event', 'turn_id, seq, event_id');
  const toolCalls = readRows(
    db,
    'agent_runtime_tool_call',
    'turn_id, created_at, id',
  );
  const checkpoints = readRows(
    db,
    'agent_runtime_checkpoint',
    'session_id, through_turn_ordinal, id',
  );
  const history = buildCompleteHistory(messages, turns, corruptions);

  let promptLoss = 0;
  for (const turn of turns) {
    if (!turn.prompt_message_id) continue;
    const prompt = messages.find((message) => message.id === turn.prompt_message_id);
    if (
      !prompt ||
      prompt.role !== 'user' ||
      prompt.status !== 'complete'
    ) {
      promptLoss += 1;
    }
  }

  let duplicateTool = 0;
  let orphanTool = 0;
  let doubleTerminal = 0;
  let seqGap = 0;
  for (const turn of turns) {
    const turnEvents = events.filter((event) => event.turn_id === turn.id);
    const starts = new Map();
    const settlements = new Map();
    const executions = new Set();
    let expectedSeq = 1;
    let terminalCount = 0;
    for (const event of turnEvents) {
      if (event.seq !== expectedSeq) seqGap += 1;
      expectedSeq = event.seq + 1;
      let payload;
      try {
        payload = JSON.parse(event.payload_json);
      } catch {
        corruptions.count += 1;
        continue;
      }
      if (event.event_type === 'tool_call_started' && typeof payload.callId === 'string') {
        starts.set(payload.callId, (starts.get(payload.callId) ?? 0) + 1);
      }
      if (
        (event.event_type === 'tool_result' ||
          event.event_type === 'recovery_tool_interrupted') &&
        typeof payload.callId === 'string'
      ) {
        settlements.set(payload.callId, (settlements.get(payload.callId) ?? 0) + 1);
      }
      if (
        event.event_type === 'tool_execution_started' &&
        typeof payload.callId === 'string'
      ) {
        executions.add(payload.callId);
      }
      if (event.event_type === 'turn_finished') terminalCount += 1;
    }
    for (const count of starts.values()) if (count > 1) duplicateTool += count - 1;
    for (const count of settlements.values()) if (count > 1) duplicateTool += count - 1;
    const callIds = new Set([...starts.keys(), ...settlements.keys()]);
    for (const callId of callIds) {
      if ((starts.get(callId) ?? 0) !== 1 || (settlements.get(callId) ?? 0) !== 1) {
        orphanTool += 1;
      }
    }
    const turnToolCalls = toolCalls.filter(
      (toolCall) => toolCall.turn_id === turn.id,
    );
    for (const [callId, count] of starts) {
      const records = turnToolCalls.filter(
        (toolCall) => toolCall.call_id === callId,
      );
      if (records.length > 1) duplicateTool += records.length - 1;
      const shouldHaveProjection =
        executions.has(callId) || records.length > 0;
      if (count !== 1 || (shouldHaveProjection && records.length !== 1)) {
        orphanTool += 1;
      }
      if (
        records.length === 1 &&
        !['completed', 'failed', 'interrupted', 'uncertain'].includes(
          records[0].status,
        )
      ) {
        orphanTool += 1;
      }
    }
    if (terminalCount !== 1) doubleTerminal += Math.abs(terminalCount - 1);
  }

  const historyAssistantCalls = new Map();
  const historyToolResults = new Map();
  for (const message of history) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== 'tool_call') continue;
        historyAssistantCalls.set(
          block.callId,
          (historyAssistantCalls.get(block.callId) ?? 0) + 1,
        );
      }
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const result of message.content) {
        if (typeof result?.callId !== 'string') continue;
        historyToolResults.set(
          result.callId,
          (historyToolResults.get(result.callId) ?? 0) + 1,
        );
      }
    }
  }
  const historyCallIds = new Set([
    ...historyAssistantCalls.keys(),
    ...historyToolResults.keys(),
  ]);
  for (const callId of historyCallIds) {
    const callCount = historyAssistantCalls.get(callId) ?? 0;
    const resultCount = historyToolResults.get(callId) ?? 0;
    if (callCount > 1) duplicateTool += callCount - 1;
    if (resultCount > 1) duplicateTool += resultCount - 1;
    if (callCount !== 1 || resultCount !== 1) orphanTool += 1;
  }

  const partialAssistantInCompleteHistory = history.filter((entry) => {
    const source = messages.find((message) => message.id === entry.id);
    return source?.role === 'assistant' && source.status !== 'complete';
  }).length;

  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  const integrityCheck = integrityRows.map((row) => String(row.integrity_check));
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  if (integrityCheck.length !== 1 || integrityCheck[0] !== 'ok') corruptions.count += 1;
  corruptions.count += foreignKeyViolations;

  for (const checkpoint of checkpoints) {
    try {
      const context = JSON.parse(checkpoint.context_json);
      if (
        !Array.isArray(context) ||
        Number(checkpoint.message_count) !== context.length ||
        checkpoint.context_hash !== `sha256:${hashCanonical(context)}`
      ) {
        corruptions.count += 1;
      }
    } catch {
      corruptions.count += 1;
    }
  }

  const snapshot = {
    schemaVersion: P2_CRASH_RECOVERY_SCHEMA_VERSION,
    marker: P2_CRASH_MARKERS[markerIndex] ?? 'bulk_10k',
    sessions,
    turns,
    messages,
    events,
    toolCalls,
    checkpoints,
    completeHistory: history,
  };
  return {
    canonicalHash: hashCanonical(snapshot),
    snapshot,
    violations: {
      promptLoss,
      duplicateTool,
      orphanTool,
      doubleTerminal,
      seqGap,
      corruptSession: corruptions.count,
      partialAssistantInCompleteHistory,
      foreignKeyViolations,
      integrityFailures:
        integrityCheck.length === 1 && integrityCheck[0] === 'ok' ? 0 : 1,
    },
    integrityCheck,
    completeHistoryLength: history.length,
  };
}

export function recoverAcceptanceDatabase(db, marker) {
  const startedAt = performance.now();
  prepareDatabase(db);
  const markerIndex = P2_CRASH_MARKERS.indexOf(marker);
  if (markerIndex === -1 && marker !== 'bulk_10k') {
    throw new Error(`Unknown recovery marker: ${marker}`);
  }
  runTransaction(db, () => {
    const sessions = readRows(db, 'agent_runtime_session', 'id');
    for (const session of sessions) {
      const turns = db
        .prepare(`
          SELECT *
          FROM agent_runtime_turn
          WHERE session_id = ?
          ORDER BY ordinal, id
        `)
        .all(session.id);
      for (const turn of turns) {
        if (['completed', 'failed', 'aborted', 'interrupted'].includes(turn.status)) continue;
        closeInterruptedTurn(db, session, turn, Math.max(0, markerIndex));
      }
    }
  });
  const result = validateRecoveredState(db, markerIndex);
  return {
    ...result,
    recoveryDurationMs: performance.now() - startedAt,
  };
}

export function seedTenThousandEventDatabase(db, seed = 90_001) {
  createAcceptanceSchema(db);
  const data = fixture(seed);
  WRITER_STAGES[0](db, data);
  WRITER_STAGES[1](db, data);
  const insert = db.prepare(`
    INSERT INTO agent_runtime_event (
      event_id, session_id, turn_id, seq, schema_version,
      event_type, payload_json, wall_time_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const time = stageTime(data, 10);
  runTransaction(db, () => {
    db.prepare(`
      INSERT INTO agent_runtime_message (
        id, session_id, turn_id, ordinal, role, status,
        content_json, created_at, completed_at
      ) VALUES (?, ?, ?, 1, 'assistant', 'complete', ?, ?, ?)
    `).run(
      data.finalMessageId,
      data.sessionId,
      data.turnId,
      canonicalJson([{ type: 'text', text: data.finalText }]),
      time,
      time,
    );
    for (let seq = 2; seq < 10_000; seq += 1) {
      insert.run(
        eventId(data.turnId, seq),
        data.sessionId,
        data.turnId,
        seq,
        P2_CRASH_RECOVERY_SCHEMA_VERSION,
        'diagnostic',
        canonicalJson({ index: seq, seed }),
        data.baseTimeMs + seq,
        new Date(data.baseTimeMs + seq).toISOString(),
      );
    }
    insert.run(
      eventId(data.turnId, 10_000),
      data.sessionId,
      data.turnId,
      10_000,
      P2_CRASH_RECOVERY_SCHEMA_VERSION,
      'turn_finished',
      canonicalJson({ outcome: 'completed', modelIterations: 1 }),
      data.baseTimeMs + 10_000,
      time,
    );
    db.prepare(`
      UPDATE agent_runtime_turn
      SET status = 'completed', started_at = ?, ended_at = ?, updated_at = ?
      WHERE id = ?
    `).run(stageTime(data, 2), time, time, data.turnId);
    db.prepare(`
      UPDATE agent_runtime_session
      SET status = 'idle', ended_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(time, data.sessionId);
  });
}
