/**
 * Two-way chapters and drifts in the project Markdown folder
 * (docs/markdown-mirror.md).
 *
 * Writing: each authored file is rendered straight from the persisted Yjs
 * state, and that state is recorded as the file's base. The native writer
 * replaces a file only when it still holds the bytes the ledger expects.
 *
 * Reading: a file whose bytes differ from the ledger was edited outside
 * Drifting and is merged by `ingestAuthoredFile`. Bytes equal to a pending
 * write are Drifting's own and only confirm it.
 */
import * as Y from 'yjs';

import { renderWorkspaceProseFile } from '../../lib/agent/runtime/workspace-prose-file';
import {
  createYjsProseSeedState,
  snapshotYjsProseBlocks,
} from '../../lib/agent/runtime/yjs-prose-command';
import { proseDocId } from '../../lib/yjs-doc-id';
import { platform } from '../../platform';
import type {
  MarkdownProjectionDocument,
  MarkdownProjectionEntry,
  MarkdownProjectionWriteResult,
} from '../../platform/contracts';
import { createMarkdownMirrorRepository } from '../../sqlite-repo/markdown-mirror-repo';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import type { LocalRelationalMarkdownSource } from '../export/relational-markdown.local-source';
import { renderAuthoredFile } from './authored-file';
import { ingestAuthoredFile, parseBaseFields, type MirrorBaseFields, type MirrorIngestResult } from './ingest';
import { flagOverlappingEdits } from './overlap-todo';

/** A file younger than this may still be mid-save; the next scan reads it. */
const SETTLE_MS = 400;

export interface AuthoredRender {
  docId: string;
  nodeId: string;
  path: string;
  text: string;
  sha256: string;
  state: Uint8Array;
  fieldsJson: string;
}

export interface MirrorIssue {
  path: string;
  reason: string;
  /** The prose document of the file, to name and open its chapter. */
  docId: string;
}

export interface MirrorScanResult {
  merged: number;
  issues: MirrorIssue[];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function nodeIdOf(docId: string): string | null {
  return docId.startsWith('node-content:') ? docId.slice('node-content:'.length) : null;
}

const ISSUE_REASONS: Record<Extract<MirrorIngestResult, { kind: 'skipped' }>['reason'], string> = {
  frontmatter: 'frontmatter',
  identity: 'identity',
  empty: 'empty',
  lineage: 'lineage',
  missing: 'missing',
  unconfirmed: 'unconfirmed',
};
const RELEASED = new Set<string>(['identity', 'empty', 'lineage']);

export interface MarkdownMirror {
  /** Merge authored files edited outside Drifting. `force` hashes every file. */
  scan(directory: string, options?: { force?: boolean }): Promise<MirrorScanResult>;
  /** Authored entries for a capture, with the hash each file is expected to hold. */
  prepare(
    source: LocalRelationalMarkdownSource,
    documents: readonly MarkdownProjectionDocument[],
    directory: string,
  ): Promise<{ entries: MarkdownProjectionEntry[]; renders: AuthoredRender[] }>;
  /** Confirm what reached disk; conflicted files stay for the next scan. */
  settle(renders: readonly AuthoredRender[], directory: string, result: MarkdownProjectionWriteResult): Promise<void>;
  /** Runs `work` alone: scans and captures never interleave their ledger updates. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  dispose(): void;
}

export function createMarkdownMirror(projectId: string): MarkdownMirror {
  const ledger = () => createMarkdownMirrorRepository();
  // Persisted state per document, keyed by revision, so a capture re-reads
  // only bodies that changed.
  const cache = new Map<string, { version: string; state: Uint8Array; body: string }>();
  // Last stat seen per path; an unchanged stat skips reading the file.
  const seen = new Map<string, { size: number; modifiedMs: number }>();
  // Unresolved problems by path, reported until that file merges.
  const issues = new Map<string, { reason: string; docId: string }>();
  let queue: Promise<unknown> = Promise.resolve();

  // Summaries leave out the Yjs states: a scan reads them only for a file
  // that actually changed.
  const rowsFor = async (directory: string) =>
    (await ledger().listSummaries(projectId)).filter(
      (row) => row.directory === directory && nodeIdOf(row.docId) !== null,
    );

  const readState = async (docId: string, contentJson: string, version: string) => {
    const cached = cache.get(docId);
    if (cached?.version === version) return cached;
    const doc = new Y.Doc({ gc: false });
    try {
      const repo = createYjsRepository();
      const snapshot = await repo.getSnapshot(docId);
      if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'load');
      const updates = await repo.listUpdates(docId);
      for (const update of updates) Y.applyUpdate(doc, update.updateBlob, 'load');
      // A body never opened in an editor has no Yjs state yet: render from
      // the deterministic seed the editor would adopt.
      if (!snapshot && updates.length === 0) Y.applyUpdate(doc, await createYjsProseSeedState(contentJson), 'seed');
      const entry = {
        version,
        state: Y.encodeStateAsUpdate(doc),
        body: renderWorkspaceProseFile(snapshotYjsProseBlocks(doc)),
      };
      cache.set(docId, entry);
      return entry;
    } finally {
      doc.destroy();
    }
  };

  const scan: MarkdownMirror['scan'] = async (directory, options = {}) => {
    const rows = await rowsFor(directory);
    const result: MirrorScanResult = { merged: 0, issues: [] };
    const report = () => ({ ...result, issues: [...issues].map(([path, issue]) => ({ path, ...issue })) });
    if (rows.length === 0) return report();
    const paths = new Set<string>();
    for (const row of rows) {
      paths.add(row.path);
      if (row.pendingPath) paths.add(row.pendingPath);
    }
    const files = await platform.markdownProjection.read(
      projectId,
      [...paths].map((path) => ({
        path,
        knownSize: options.force ? null : (seen.get(path)?.size ?? null),
        knownModifiedMs: options.force ? null : (seen.get(path)?.modifiedMs ?? null),
        force: options.force ?? false,
      })),
    );
    const byPath = new Map(files.map((file) => [file.path, file]));
    const now = Date.now();
    for (const row of rows) {
      const pending = row.pendingPath ? byPath.get(row.pendingPath) : undefined;
      if (row.pendingSha256 && pending?.sha256 === row.pendingSha256) {
        // Drifting wrote these bytes before it could confirm them.
        await ledger().confirmPending(projectId, row.docId);
        seen.set(pending.path, { size: pending.size, modifiedMs: pending.modifiedMs });
        continue;
      }
      // Never confirmed on disk: there is no base to merge against yet.
      if (!row.fileSha256) continue;
      const file = byPath.get(row.path);
      if (!file?.exists || !file.changed) continue;
      if (file.error || file.text === null || file.sha256 === null) {
        issues.set(row.path, { reason: file.error ?? 'unreadable', docId: row.docId });
        if (file.error === 'encoding' || file.error === 'too-large') await ledger().release(projectId, row.docId);
        continue;
      }
      if (file.sha256 === row.fileSha256) {
        seen.set(row.path, { size: file.size, modifiedMs: file.modifiedMs });
        issues.delete(row.path);
        continue;
      }
      if (now - file.modifiedMs < SETTLE_MS) continue;
      const full = await ledger().get(projectId, row.docId);
      if (!full) continue;
      const nodeId = nodeIdOf(row.docId)!;
      const outcome = await ingestAuthoredFile({ projectId, nodeId, row: full, text: file.text, sha256: file.sha256 });
      if (outcome.kind === 'deferred') continue;
      seen.set(row.path, { size: file.size, modifiedMs: file.modifiedMs });
      if (outcome.kind === 'skipped') {
        issues.set(row.path, { reason: ISSUE_REASONS[outcome.reason], docId: row.docId });
        // A malformed header waits for the author to fix it. Edits that can
        // never merge are kept aside, and the file is written afresh.
        if (RELEASED.has(outcome.reason)) await ledger().release(projectId, row.docId);
      }
      if (outcome.kind !== 'skipped') issues.delete(row.path);
      if (outcome.kind === 'merged') {
        result.merged += 1;
        await flagOverlappingEdits({ projectId, nodeId, path: row.path, overlapped: outcome.overlapped });
      }
    }
    return report();
  };

  const prepare: MarkdownMirror['prepare'] = async (source, documents, directory) => {
    const graph = source.books[0]!.graph;
    const contentById = new Map(graph.nodeContents.map((content) => [content.nodeId, content.contentJson ?? '{}']));
    const pathByKey = new Map(documents.map((document) => [document.key, document.path]));
    const rows = new Map((await rowsFor(directory)).map((row) => [row.docId, row]));
    const nodes = graph.nodes.filter((node) => !node.deletedAt && pathByKey.has(`node:${node.id}`));
    const docIds = nodes.map((node) => proseDocId('node', node.id));
    const revisions = new Map(
      (await createYjsRepository().listRevisions(docIds)).map((entry) => [entry.docId, entry.revision]),
    );
    const renders: AuthoredRender[] = [];
    for (const node of nodes) {
      const docId = proseDocId('node', node.id);
      const contentJson = contentById.get(node.id) ?? '{}';
      const revision = revisions.get(docId) ?? 0;
      const { state, body } = await readState(docId, contentJson, revision > 0 ? `r${revision}` : `seed:${contentJson}`);
      const row = rows.get(docId);
      const fields: MirrorBaseFields = {
        status: node.writingStatus as MirrorBaseFields['status'],
        summary: node.summary,
        extra: row ? parseBaseFields(row.baseFieldsJson).extra : '',
      };
      const text = renderAuthoredFile({ id: node.id, title: node.title, fields, extra: fields.extra, body });
      renders.push({
        docId,
        nodeId: node.id,
        path: pathByKey.get(`node:${node.id}`)!,
        text,
        sha256: await sha256(text),
        state,
        fieldsJson: JSON.stringify(fields),
      });
    }
    const entries: MarkdownProjectionEntry[] = [];
    for (const render of renders) {
      const row = rows.get(render.docId);
      const confirmed = row?.fileSha256 || null;
      if (!(row && confirmed === render.sha256 && row.path === render.path)) {
        await ledger().setPending(projectId, render.docId, directory, {
          sha256: render.sha256,
          path: render.path,
          state: render.state,
          fieldsJson: render.fieldsJson,
        });
      }
      entries.push({
        path: render.path,
        text: render.text,
        authored: true,
        expectedSha256: row && row.path === render.path ? confirmed : null,
      });
    }
    return { entries, renders };
  };

  const settle: MarkdownMirror['settle'] = async (renders, directory, result) => {
    const conflicts = new Set(result.conflicts);
    const rows = new Map((await rowsFor(directory)).map((row) => [row.docId, row]));
    for (const render of renders) {
      const row = rows.get(render.docId);
      if (!row?.pendingSha256 || row.pendingSha256 !== render.sha256) continue;
      if (conflicts.has(render.path)) await ledger().clearPending(projectId, render.docId);
      else await ledger().confirmPending(projectId, render.docId);
    }
    // A chapter deleted in Drifting no longer has a file to read back.
    const rendered = new Set(renders.map((render) => render.docId));
    for (const docId of rows.keys()) {
      if (!rendered.has(docId)) await ledger().remove(projectId, docId);
    }
  };

  return {
    scan,
    prepare,
    settle,
    exclusive<T>(work: () => Promise<T>) {
      const run = queue.then(work, work);
      queue = run.catch(() => undefined);
      return run;
    },
    dispose() {
      cache.clear();
      seen.clear();
      issues.clear();
    },
  };
}
