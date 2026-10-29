#!/usr/bin/env node
/**
 * Cost of one authored keystroke write on the heavy stress seed, without the app.
 *
 *   pnpm perf:keystroke [--instance <name> | --snapshot <dir>] [--keys <n>] [--label <name>]
 *
 * Copies the post-seed library that `pnpm perf:stress` keeps for its instance
 * (run that once first), or the library in --snapshot, opens the copy with Node's SQLite and appends `--keys`
 * one-character Yjs updates to the long chapter through the same authored write
 * path the editor uses: journal change-set, reducer, domain kernel validation
 * and Yjs persistence. It prints the milliseconds of every write and the median
 * after the first five (the first one loads the reducer state cold), and with
 * --label writes them to .local-data/perf-stress/keystroke-<label>.json.
 *
 * Node's V8 is not the app's JavaScriptCore and SQLite runs in-process rather
 * than over IPC, so compare runs of this command with each other, not with
 * frame timings from perf:stress.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq, like } from 'drizzle-orm';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { proseDocId } from '../src/renderer/lib/yjs-doc-id';
import { BookNodeTable, ProjectTable } from '../src/renderer/schema/drizzle';
import { createYjsRepository } from '../src/renderer/sqlite-repo/yjs-repo';
import { createAuthoredTransactionRunner } from '../src/renderer/sync/journal/authored-transaction';
import { createAuthoredYjsUpdateWriter } from '../src/renderer/sync/journal/yjs-update';
// @ts-expect-error Executable ESM tooling.
import { createWorktreePlan, parseWorktreeArguments } from './run-worktree-dev.mjs';
// @ts-expect-error Executable ESM tooling.
import { LOCAL_LIBRARY_DATABASE } from './run-seeded-dev.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = '潮汐灯塔';
const LONG_CHAPTER = '第007章';

function parseArguments(args: string[]): { instance: string; snapshot: string; keys: number; label: string } {
  const options = { instance: 'perf-stress', snapshot: '', keys: 60, label: '' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--instance') options.instance = args[++index] ?? '';
    else if (argument === '--snapshot') options.snapshot = path.resolve(args[++index] ?? '');
    else if (argument === '--keys') options.keys = Number(args[++index]);
    else if (argument === '--label') options.label = args[++index] ?? '';
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.instance || !Number.isInteger(options.keys) || options.keys < 10) {
    throw new Error('Usage: pnpm perf:keystroke [--instance <name> | --snapshot <dir>] [--keys <n ≥ 10>] [--label <name>]');
  }
  return options;
}

/** The first text run of a ProseMirror-shaped Yjs fragment. */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) {
      const found = firstText(child);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const snapshot = options.snapshot || path.join(
    createWorktreePlan({ root, ...parseWorktreeArguments(['--instance', options.instance, '--no-watch']) }).manifest.profileDirectory,
    'perf-stress-seed',
  );
  if (!existsSync(path.join(snapshot, LOCAL_LIBRARY_DATABASE))) {
    throw new Error(options.snapshot
      ? `No ${LOCAL_LIBRARY_DATABASE} in ${options.snapshot}`
      : `No post-seed library for instance "${options.instance}"; run pnpm perf:stress once first`);
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-perf-keystroke-'));
  const gateway = (() => {
    cpSync(snapshot, directory, { recursive: true });
    return new ProductFileBackedSqliteGateway(path.join(directory, LOCAL_LIBRARY_DATABASE), false);
  })();
  try {
    const db = gateway.client();
    const [project] = (await db.select().from(ProjectTable)).filter((row) => row.name.includes(PROJECT));
    if (!project) throw new Error(`The seed has no project named ${PROJECT}`);
    const [chapter] = await db.select().from(BookNodeTable)
      .where(and(eq(BookNodeTable.projectId, project.id), like(BookNodeTable.title, `${LONG_CHAPTER}%`)));
    if (!chapter) throw new Error(`The seed has no chapter ${LONG_CHAPTER}`);
    const docId = proseDocId('node', chapter.id);

    const doc = new Y.Doc();
    const repository = createYjsRepository(db);
    const stored = await repository.getSnapshot(docId);
    if (stored) Y.applyUpdate(doc, stored.stateBlob);
    for (const row of await repository.listUpdates(docId)) Y.applyUpdate(doc, row.updateBlob);
    const text = firstText(doc.getXmlFragment('default'));
    if (!text) throw new Error(`${LONG_CHAPTER} has no text`);

    const write = createAuthoredYjsUpdateWriter(createAuthoredTransactionRunner({
      database: () => db,
      identity: async () => ({
        installationId: 'perf-keystroke-installation',
        createWriterIdentity: () => ({ writerId: 'perf-keystroke-writer', writerEpoch: 'perf-keystroke-epoch' }),
      }),
      clock: () => {
        const nowMs = Date.now();
        return { nowMs, nowIso: new Date(nowMs).toISOString() };
      },
      syncGenerationIds: {
        createSyncGenerationId: () => 'perf-keystroke-generation',
        createProjectSyncId: () => 'perf-keystroke-project-sync',
      },
    }));

    const writes: number[] = [];
    for (let index = 0; index < options.keys; index += 1) {
      let update: Uint8Array | null = null;
      const capture = (next: Uint8Array) => { update = next; };
      doc.on('update', capture);
      text.insert(0, '潮');
      doc.off('update', capture);
      const started = performance.now();
      await write(project.id, docId, update!);
      writes.push(Math.round((performance.now() - started) * 10) / 10);
    }
    const steady = writes.slice(5).sort((left, right) => left - right);
    const median = steady[Math.floor(steady.length / 2)]!;
    const p95 = steady[Math.min(steady.length - 1, Math.floor(steady.length * 0.95))]!;
    console.log(`[perf:keystroke] ${options.keys} writes to ${LONG_CHAPTER} (ms): ${writes.join(' ')}`);
    console.log(`[perf:keystroke] first ${writes[0]} ms, then median ${median} ms, p95 ${p95} ms`);
    if (options.label) {
      const output = path.join(root, '.local-data', 'perf-stress', `keystroke-${options.label}.json`);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, label: options.label, keys: options.keys, firstMs: writes[0], medianMs: median, p95Ms: p95, writesMs: writes }, null, 2)}\n`);
      console.log(`[perf:keystroke] report ${path.relative(root, output)}`);
    }
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
