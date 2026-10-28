import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { countWords, extractProseText } from '@drifting/prose-metrics';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { allocateSeedLengths, type SeedPreset, type SeedWordBudget } from './presets';

export interface SeedBodyStatistics {
  count: number;
  totalWords: number;
  minWords: number;
  maxWords: number;
  meanWords: number;
  medianWords: number;
  p95Words: number;
  yjsDocuments: number;
  initialJsonDocuments: number;
  corpusSha256: string;
}

export interface SeedAuditReport {
  preset: string;
  metric: string;
  bodies: Record<string, SeedBodyStatistics>;
  agent: { conversations: number; rounds: number; minRounds: number; maxRounds: number; tools: number; displayMessages: number; checkpoints: number; visibleWords: number; toolResultWords: number };
  assets: { images: number; pdfs: number; sourceBytes: number; verifiedBlobs: number };
  foreignKeyViolations: number;
}

function requireEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`Seed audit ${label}: expected ${expected}, got ${actual}`);
}

/** Read only. Count reconstructed CRDT prose, never JSON bytes or journal copies. */
export function auditDevelopmentSeed(database: DatabaseSync, projectId: string, preset: SeedPreset): SeedAuditReport {
  const groups: Record<string, Array<{ words: number; text: string; yjs: boolean }>> = {};
  const add = (group: string, json: string | null, docId?: string, cachedWords?: number) => {
    let document: Parameters<typeof extractProseText>[0] = json ? JSON.parse(json) : {};
    let yjs = false;
    if (docId) {
      const snapshot = database.prepare('SELECT state_blob AS bytes FROM yjs_snapshots WHERE document_id = ?').get(docId) as { bytes: Uint8Array } | undefined;
      const updates = database.prepare('SELECT update_blob AS bytes FROM yjs_updates WHERE document_id = ? ORDER BY id').all(docId) as { bytes: Uint8Array }[];
      if (snapshot || updates.length) {
        const doc = new Y.Doc();
        try {
          if (snapshot) Y.applyUpdate(doc, snapshot.bytes);
          for (const update of updates) Y.applyUpdate(doc, update.bytes);
          document = yDocToProsemirrorJSON(doc, 'default');
          yjs = true;
        } finally { doc.destroy(); }
      }
    }
    const text = extractProseText(document);
    const words = countWords(text);
    if (cachedWords !== undefined) requireEqual(words, cachedWords, `${group} persisted word count`);
    (groups[group] ??= []).push({ words, text, yjs });
  };
  const nodes = database.prepare('SELECT b.id,b.kind,b.word_count AS words,c.content_json AS json FROM book_node b JOIN node_content c ON c.node_id = b.id WHERE b.project_id = ? AND b.deleted_at IS NULL').all(projectId) as { id: string; kind: string; words: number; json: string }[];
  for (const node of nodes) add(node.kind === 'chapter' ? 'chapters' : 'inspirations', node.json, `node-content:${node.id}`, node.words);
  for (const [table, prefix, group] of [['element', 'element', 'elements'], ['storylines', 'storyline', 'storylines'], ['element_category', 'category', 'categories']]) {
    const rows = database.prepare(`SELECT id,content_json AS json FROM ${table} WHERE project_id = ? AND deleted_at IS NULL`).all(projectId) as { id: string; json: string }[];
    for (const row of rows) add(group, row.json, `${prefix}:${row.id}`);
  }
  const notes = database.prepare("SELECT id,body_json AS json FROM library_item WHERE project_id = ? AND kind = 'text'").all(projectId) as { id: string; json: string }[];
  for (const row of notes) add('materialNotes', row.json, `library-item:${row.id}`);
  const comments = database.prepare('SELECT kind,body_json AS json FROM comment WHERE project_id = ?').all(projectId) as { kind: string; json: string }[];
  for (const row of comments) add(row.kind === 'todo' ? 'todos' : 'comments', row.json);
  const bodies: Record<string, SeedBodyStatistics> = {};
  for (const group of ['chapters', 'elements', 'inspirations', 'materialNotes', 'storylines', 'categories', 'todos', 'comments'] as const) {
    const rows = groups[group] ?? [];
    const budget: SeedWordBudget = preset[group];
    const lengths = rows.map(row => row.words).sort((a, b) => a - b);
    const total = lengths.reduce((sum, value) => sum + value, 0);
    requireEqual(rows.length, budget.count, `${group} count`);
    requireEqual(total, budget.total, `${group} total words`);
    requireEqual(lengths[0], budget.min, `${group} minimum`);
    requireEqual(lengths[lengths.length - 1], budget.max, `${group} maximum`);
    if (group !== 'materialNotes' && group !== 'todos' && group !== 'comments')
      requireEqual(rows.filter(row => row.yjs).length, rows.length, `${group} canonical Yjs bodies`);
    const hash = createHash('sha256');
    for (const row of rows) hash.update(row.text).update('\0');
    bodies[group] = {
      count: rows.length, totalWords: total, minWords: lengths[0], maxWords: lengths[lengths.length - 1],
      meanWords: total / rows.length,
      medianWords: rows.length % 2 ? lengths[(rows.length - 1) / 2] : (lengths[rows.length / 2 - 1] + lengths[rows.length / 2]) / 2,
      p95Words: lengths[Math.ceil(lengths.length * .95) - 1],
      yjsDocuments: rows.filter(row => row.yjs).length, initialJsonDocuments: rows.filter(row => !row.yjs).length,
      corpusSha256: hash.digest('hex'),
    };
  }
  const sessions = database.prepare("SELECT s.id,count(t.id) AS rounds FROM agent_runtime_session s JOIN agent_runtime_turn t ON t.session_id = s.id WHERE s.project_id = ? AND s.provider = 'development-seed' AND t.status = 'completed' GROUP BY s.id").all(projectId) as { id: string; rounds: number }[];
  const conversations = database.prepare("SELECT messages_json AS json FROM agent_conversation WHERE project_id = ? AND title LIKE '示例讨论%'").all(projectId) as { json: string }[];
  const toolCount = Number((database.prepare("SELECT count(*) AS n FROM agent_runtime_tool_call t JOIN agent_runtime_session s ON s.id = t.session_id WHERE s.project_id = ? AND s.provider = 'development-seed' AND t.status = 'completed'").get(projectId) as { n: number }).n);
  const checkpoints = Number((database.prepare("SELECT count(*) AS n FROM agent_runtime_checkpoint c JOIN agent_runtime_session s ON s.id = c.session_id WHERE s.project_id = ? AND s.provider = 'development-seed'").get(projectId) as { n: number }).n);
  const rounds = sessions.map(session => Number(session.rounds));
  requireEqual(conversations.length, preset.conversations.count, 'Agent conversations');
  requireEqual(rounds.reduce((sum, value) => sum + value, 0), preset.conversations.total, 'Agent total rounds');
  requireEqual(Math.min(...rounds), preset.conversations.min, 'Agent minimum rounds');
  requireEqual(Math.max(...rounds), preset.conversations.max, 'Agent maximum rounds');
  const expectedTools = allocateSeedLengths(preset.conversations, 109).reduce((sum, count) => sum + Math.floor((count + 1) / 3), 0);
  requireEqual(toolCount, expectedTools, 'Agent completed tool cards');
  requireEqual(checkpoints, preset.conversations.count, 'Agent final V4 checkpoints');
  let visibleWords = 0, toolResultWords = 0, displayMessages = 0;
  for (const conversation of conversations) {
    const messages = JSON.parse(conversation.json) as { kind: string; text?: string; result?: string }[];
    displayMessages += messages.length;
    for (const message of messages) {
      if (message.kind === 'assistant' || message.kind === 'user') visibleWords += countWords(message.text ?? '');
      if (message.kind === 'tool') toolResultWords += countWords(message.result ?? '');
    }
  }
  const assetRows = database.prepare('SELECT kind,count(*) AS count,sum(source_size_bytes) AS bytes FROM project_asset WHERE project_id = ? GROUP BY kind').all(projectId) as { kind: string; count: number; bytes: number }[];
  const images = assetRows.find(row => row.kind === 'image')?.count ?? 0;
  const pdfs = assetRows.find(row => row.kind === 'pdf')?.count ?? 0;
  requireEqual(images, preset.assetCopies * 4, 'image owners');
  requireEqual(pdfs, preset.assetCopies * 2, 'PDF owners');
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
  requireEqual(foreignKeyViolations, 0, 'foreign keys');
  return {
    preset: preset.name, metric: 'Drifting countWords on reconstructed Yjs or initial material JSON; excludes title, summary, attributes and storage duplicates', bodies,
    agent: { conversations: conversations.length, rounds: rounds.reduce((sum, count) => sum + count, 0), minRounds: Math.min(...rounds), maxRounds: Math.max(...rounds), tools: toolCount, displayMessages, checkpoints, visibleWords, toolResultWords },
    assets: { images, pdfs, sourceBytes: assetRows.reduce((sum, row) => sum + row.bytes, 0),
      verifiedBlobs: Number((database.prepare("SELECT count(*) AS n FROM sync_blob_state WHERE local_state = 'verified'").get() as { n: number }).n) },
    foreignKeyViolations,
  };
}
