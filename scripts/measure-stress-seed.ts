// Real stress library and production functions under Node. This measures CPU,
// allocations and persistence contracts; it cannot certify an App UI journey.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { setImmediate as immediate } from 'node:timers/promises';
import { Session } from 'node:inspector';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { marked } from 'marked';
import { installHeadlessRendererGlobals } from '../src/dev-cli/headless-globals';
// @ts-expect-error Executable ESM tooling.
import { createWorktreePlan } from './run-worktree-dev.mjs';
// @ts-expect-error Executable ESM tooling.
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

async function main() {
  installHeadlessRendererGlobals();
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = path.join(root, 'docs/renderer-performance/acceptance/stress-seed-node-diagnostic.json');
  const sourceFingerprint = () => createHash('sha256').update(rendererSourceFingerprint(root)).update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
      kind: string; status: string; source: { fingerprint: string }; checks: Record<string, boolean>;
      scope: { nativeUi: string }; corpus: { chapters: number; inspirations: number; elements: number; notes: number; canonicalTurns: number; conversations: number };
      samples: Array<{ elapsedMs: number; cpuMs: number; maxTimerLatenessMs: number }>;
      summary: Array<{ name: string; samples: number }>;
      retention: unknown[]; agentRetention: unknown[];
    };
    assert.equal(report.kind, 'stress_seed_node_diagnostic');
    assert.equal(report.status, 'passed-domain-checks-native-ui-not-run');
    assert.equal(report.scope.nativeUi, 'not-run');
    assert.equal(report.source.fingerprint, sourceFingerprint(), 'Diagnostic evidence is stale');
    assert(Object.values(report.checks).every(value => value === true));
    assert.deepEqual([report.corpus.chapters, report.corpus.inspirations, report.corpus.elements, report.corpus.notes, report.corpus.canonicalTurns], [100, 200, 300, 60, 600]);
    assert(report.corpus.conversations >= 24, 'All seeded conversations must remain represented');
    assert(report.samples.every(sample => [sample.elapsedMs, sample.cpuMs, sample.maxTimerLatenessMs].every(value => Number.isFinite(value) && value >= 0)));
    for (const name of ['workspace-full-capture', 'workspace-covered-no-change', 'material-card-markdown-all-60', 'material-search-five-keystrokes',
      'conversation-usage-summary-all', 'largest-conversation-display-projection', 'authored-create-todo', 'authored-replace-20k-chapter', 'authored-replace-20k-one-character']) {
      assert.equal(report.summary.find(row => row.name === name)?.samples, 5, name);
    }
    assert.equal(report.retention.length, 5); assert.equal(report.agentRetention.length, 20);
    assert(!JSON.stringify(report).includes(root), 'Evidence must not include personal paths');
    console.log('Source-matched heavy-seed CPU, retention and persistence evidence passed; native UI remains unaccepted.');
    return;
  }
  const sourcePlan = createWorktreePlan({ root, instance: 'stress-native-audit', baseEnvironment: {} });
  const outputDirectory = path.join(root, '.local-data/stress-seed-diagnostics');
  mkdirSync(outputDirectory, { recursive: true });
  const fixture = mkdtempSync(path.join(outputDirectory, 'run-'));
  const original = new DatabaseSync(path.join(sourcePlan.manifest.databaseDirectory, 'drifting-library.db'), { readOnly: true });
  const copy = path.join(fixture, 'stress.db');
  try { await backup(original, copy); } finally { original.close(); }
  const { OfflineProductDatabase } = await import('../src/dev-cli/offline-database');
  const { captureWorkspaceProjection } = await import('../src/renderer/services/workspace-projection.service');
  const { libraryItemMatchesQuery } = await import('../src/renderer/features/library/library-item-search');
  const { noteMarkdownExcerpt } = await import('../src/renderer/lib/note-markdown');
  const { createAgentConversationRepository } = await import('../src/renderer/sqlite-repo/agent-conversation-repo');
  const { createAgentRuntimePersistenceRepository } = await import('../src/renderer/sqlite-repo/agent-runtime-persistence-repo');
  const { recoverAgentRuntimeSnapshot } = await import('../src/renderer/lib/agent/runtime/recovery');
  const { loadCanonicalAgentChatProjection } = await import('../src/renderer/lib/agent/runtime/recovered-transcript');
  const { executeOfflineWorkspaceTool } = await import('../src/dev-cli/offline-workspace');
  const { countWords, extractProseText } = await import('../packages/prose-metrics/src/index');
  const { createSeedMarkdown } = await import('../src/renderer/services/sample-project/prose');
  const { readProjectStats } = await import('../src/renderer/sqlite-repo/project-stats-repo');
  const { useUiStore } = await import('../src/renderer/store/ui-store');
  for (const logger of Object.values(loglevel.getLoggers())) logger.setLevel('silent');
  const database = new OfflineProductDatabase(copy, { migrate: false });
  await database.open();
  let databaseClosed = false;
  const raw = database.gateway.database;
  const project = raw.prepare('SELECT id,user_id FROM project WHERE deleted_at IS NULL LIMIT 1').get()!;
  const input = { projectId: String(project.id), userId: String(project.user_id) };
  const samples: Array<Record<string, unknown>> = [];
  async function measure<T>(name: string, operation: () => T | Promise<T>, runs = 5) {
    let latest: T | undefined;
    for (let index = 0; index < runs; index++) {
      await immediate();
      globalThis.gc?.();
      const memoryBefore = process.memoryUsage();
      const cpuBefore = process.cpuUsage();
      const start = performance.now();
      let tickAt = start;
      let maxTimerLatenessMs = 0;
      const timer = setInterval(() => {
        const tick = performance.now(); maxTimerLatenessMs = Math.max(maxTimerLatenessMs, tick - tickAt - 2); tickAt = tick;
      }, 2);
      try { latest = await operation(); } catch (error) { clearInterval(timer); throw error; }
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuBefore);
      const memoryAfter = process.memoryUsage();
      const tickStart = performance.now(); await immediate();
      await new Promise(resolve => setTimeout(resolve, 2)); clearInterval(timer);
      const sample = { name, index, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
        postOperationYieldMs: performance.now() - tickStart, maxTimerLatenessMs,
        heapGrowthBytes: memoryAfter.heapUsed - memoryBefore.heapUsed, rssBytes: memoryAfter.rss };
      samples.push(sample);
      console.log(`${name} ${index + 1}/${runs}: ${elapsedMs.toFixed(1)} ms, CPU ${sample.cpuMs.toFixed(1)} ms`);
    }
    return latest!;
  }
  async function profile(name: string, operation: () => unknown | Promise<unknown>) {
    const session = new Session(); session.connect();
    const send = (command: string) => new Promise<Record<string, unknown>>((resolve, reject) => session.post(command as 'Profiler.enable', (error: Error | null, result?: unknown) => error ? reject(error) : resolve((result ?? {}) as Record<string, unknown>)));
    await send('Profiler.enable'); await send('Profiler.start'); await operation();
    const result = await send('Profiler.stop') as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[] } };
    session.disconnect();
    writeFileSync(path.join(fixture, `${name}.cpuprofile`), JSON.stringify(result.profile));
    const counts = new Map<number, number>();
    for (const id of result.profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    return result.profile.nodes.filter(n => counts.has(n.id)).map(n => ({
      function: n.callFrame.functionName || '(anonymous)', samples: counts.get(n.id)!,
      file: n.callFrame.url.startsWith(`file://${root}/`) ? n.callFrame.url.slice(`file://${root}/`.length) : path.basename(n.callFrame.url),
      line: n.callFrame.lineNumber + 1,
    })).sort((a, b) => b.samples - a.samples).slice(0, 25);
  }
  try {
    const cold = await measure('workspace-full-capture', () => captureWorkspaceProjection(input));
    assert(cold);
    assert.equal(cold.data.bookElements.length, 300);
    assert.equal(cold.data.bookNodes.filter(n => n.kind === 'chapter').length, 100);
    assert.equal(cold.data.bookNodes.filter(n => n.kind === 'drift').length, 200);
    await measure('workspace-covered-no-change', () => captureWorkspaceProjection({ ...input, previous: cold }));
    const shelf = await readProjectStats(input.projectId);
    const subscriptions = { wholeStore: 0, nodeUiChanges: 0, elementUiChanges: 0, mutations: 10 };
    const unsubscribe = useUiStore.subscribe((current, previous) => {
      subscriptions.wholeStore++;
      if (current.nodeUi !== previous.nodeUi) subscriptions.nodeUiChanges++;
      if (current.elementUi !== previous.elementUi) subscriptions.elementUiChanges++;
    });
    for (let cycle = 0; cycle < 5; cycle++) {
      useUiStore.getState().setResizingSidebar('right'); useUiStore.getState().setResizingSidebar(null);
    }
    unsubscribe();
    assert.equal(subscriptions.wholeStore, 10); assert.equal(subscriptions.nodeUiChanges, 0); assert.equal(subscriptions.elementUiChanges, 0);
    const notes = cold.data.libraryItems.filter(i => i.kind === 'text');
    assert.equal(notes.length, 60);
    const renderNotes = () => notes.map(note => {
      const markdown = noteMarkdownExcerpt(note.bodyJson).replace(/^> \[!note\]\n/gmu, '');
      const escaped = markdown.replace(/&/gu, '&amp;').replace(/</gu, '&lt;');
      return String(marked.parse(escaped, { breaks: true, gfm: true, async: false })).replace(/==([^=\n<]+)==/gu, '<mark>$1</mark>');
    });
    const html = await measure('material-card-markdown-all-60', renderNotes);
    const queries = ['灯', '灯塔', '灯塔潮', '灯塔潮汐', '无匹配的性能审计测试'];
    await measure('material-search-five-keystrokes', () => queries.map(query => cold.data.libraryItems.filter(item => libraryItemMatchesQuery(item, query)).length));
    const materialProfile = await profile('material-cards', renderNotes);
    const conversations = createAgentConversationRepository();
    const conversationList = await measure('conversation-list', () => conversations.listByProject(input.projectId));
    await measure('conversation-usage-summary-all', () => conversations.usageByProject(input.projectId));
    const chat = raw.prepare('SELECT id,runtime_session_id,length(messages_json) AS chars FROM agent_conversation WHERE deleted_at IS NULL ORDER BY length(messages_json) DESC LIMIT 1').get()!;
    const cached = await measure('largest-conversation-cache-read', () => conversations.get(String(chat.id)));
    assert(cached);
    const runtime = createAgentRuntimePersistenceRepository(database.client);
    const snapshot = await measure('largest-conversation-canonical-snapshot', () => runtime.loadRecoverySnapshot(String(chat.runtime_session_id)));
    assert(snapshot);
    const recovered = await measure('largest-conversation-strict-recovery', () => recoverAgentRuntimeSnapshot(snapshot));
    const recoveryProfile = await profile('canonical-recovery', () => recoverAgentRuntimeSnapshot(snapshot));
    assert.equal(recovered.turns.length, 600);
    const displayed = await measure('largest-conversation-display-projection', () => loadCanonicalAgentChatProjection(String(chat.runtime_session_id), runtime, cached.messages));
    assert(displayed);
    const displayProfile = await profile('canonical-display', () => loadCanonicalAgentChatProjection(String(chat.runtime_session_id), runtime, cached.messages));
    const nodeRows = raw.prepare("SELECT id,kind,word_count FROM book_node WHERE deleted_at IS NULL ORDER BY word_count DESC").all();
    const reconstruct = (node: Record<string, unknown>) => {
      const doc = new Y.Doc();
      const id = `node-content:${node.id}`;
      const snapshot = raw.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id = ?').get(id);
      if (snapshot) Y.applyUpdate(doc, snapshot.state_blob as Uint8Array);
      for (const update of raw.prepare('SELECT update_blob FROM yjs_updates WHERE document_id = ? ORDER BY id').all(id)) Y.applyUpdate(doc, update.update_blob as Uint8Array);
      return doc;
    };
    let retained: Y.Doc[] = [];
    const gc = () => { globalThis.gc?.(); return process.memoryUsage(); };
    const retention = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const before = gc();
      await measure(`twenty-largest-yjs-hydration-cycle-${cycle + 1}`, () => { retained = nodeRows.slice(0, 20).map(reconstruct); }, 1);
      const hydrated = gc();
      const words = retained.map(doc => countWords(extractProseText(yDocToProsemirrorJSON(doc, 'default'))));
      for (const doc of retained) doc.destroy(); retained = [];
      await immediate();
      const after = gc();
      retention.push({ cycle, documents: 20, words: words.reduce((a, b) => a + b, 0), beforeHeapBytes: before.heapUsed, retainedHeapBytes: hydrated.heapUsed, afterDestroyHeapBytes: after.heapUsed,
        beforeRssBytes: before.rss, retainedRssBytes: hydrated.rss, afterDestroyRssBytes: after.rss });
    }
    const agentRetention = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      await measure('agent-reopen-close-soak', async () => {
        const projection = await loadCanonicalAgentChatProjection(String(chat.runtime_session_id), runtime, cached.messages);
        assert.equal(projection?.messages.length, 2600);
      }, 1);
      await immediate();
      const memory = gc();
      agentRetention.push({ cycle, heapBytes: memory.heapUsed, rssBytes: memory.rss });
    }
    const firstChapter = raw.prepare("SELECT id,title FROM book_node WHERE kind='chapter' AND deleted_at IS NULL ORDER BY book_order LIMIT 1").get()!;
    const write = async (toolName: string, args: Record<string, unknown>, index: number) => {
      const result = await executeOfflineWorkspaceTool({ database: database.client, projectId: input.projectId,
        requestId: `stress-diagnostic-${toolName}-${index}`, toolName, arguments: args });
      assert.equal(result.result.ok, true, `Authored ${toolName} failed`);
      return result;
    };
    await measure('authored-create-todo', () => write('create_comment', { targetType: 'chapter', targetName: firstChapter.title, kind: 'todo', body: '合成压力验收待办；此数据仅存在诊断副本。' }, samples.length));
    await write('create_chapter', { title: '压力诊断正文', body: createSeedMarkdown(2000, 600001) }, samples.length);
    let lastBody = '';
    await measure('authored-replace-20k-chapter', () => {
      lastBody = createSeedMarkdown(20000, 600002 + samples.length);
      return write('replace_chapter_body', { chapter: '压力诊断正文', body: lastBody }, samples.length);
    });
    const sparseBodies = [lastBody.replace(/[\u3400-\u9fff]/u, '甲'), lastBody.replace(/[\u3400-\u9fff]/u, '乙')];
    await measure('authored-replace-20k-one-character', () => write('replace_chapter_body', { chapter: '压力诊断正文', body: sparseBodies[samples.length % 2] }, samples.length));
    const writeProfileQueries = { queries: 0, rows: 0, rawValueBytes: 0, tables: {} as Record<string, { queries: number; rows: number; rawValueBytes: number }> };
    const originalQuery = database.gateway.query.bind(database.gateway);
    database.gateway.query = async (sql, parameters, transactionId) => {
      const result = await originalQuery(sql, parameters, transactionId);
      const bytes = result.rows.reduce((total, row) => total + row.reduce<number>((size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8), 0), 0);
      const table = sql.match(/from\s+["`]?([a-z_]+)/iu)?.[1] ?? 'other';
      const entry = writeProfileQueries.tables[table] ?? { queries: 0, rows: 0, rawValueBytes: 0 };
      entry.queries++; entry.rows += result.rows.length; entry.rawValueBytes += bytes; writeProfileQueries.tables[table] = entry;
      writeProfileQueries.queries++; writeProfileQueries.rows += result.rows.length; writeProfileQueries.rawValueBytes += bytes;
      return result;
    };
    const writeProfile = await profile('whole-body-write', () => write('replace_chapter_body', { chapter: '压力诊断正文', body: sparseBodies[1] }, samples.length));
    database.gateway.query = originalQuery;
    const writtenChapter = raw.prepare("SELECT id,word_count FROM book_node WHERE title='压力诊断正文'").get()!;
    const writtenDoc = reconstruct(writtenChapter);
    const durableWords = countWords(extractProseText(yDocToProsemirrorJSON(writtenDoc, 'default'))); writtenDoc.destroy();
    assert.equal(durableWords, 20000); assert.equal(writtenChapter.word_count, 20000);
    const from = raw.prepare('SELECT id,name FROM element WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1').get()!;
    const to = raw.prepare("SELECT id,title FROM book_node WHERE kind='chapter' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM entity_relation r WHERE r.from_id=? AND r.to_id=book_node.id) ORDER BY book_order LIMIT 1").get(from.id)!;
    await write('create_relation', { fromType: 'element', fromName: from.name, toType: 'chapter', toName: to.title, relationType: '出场于' }, samples.length);
    assert(raw.prepare('SELECT id FROM entity_relation WHERE from_id=? AND to_id=?').get(from.id, to.id));
    const foreignKeys = raw.prepare('PRAGMA foreign_key_check').all();
    assert.equal(foreignKeys.length, 0);
    assert.equal(raw.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const summary = [...new Set(samples.map(s => String(s.name)))].map(name => {
      const matching = samples.filter(s => s.name === name);
      const times = matching.map(s => Number(s.elapsedMs)).sort((a, b) => a - b);
      return { name, samples: matching.length, p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1], maxMs: Math.max(...times),
        maxCpuMs: Math.max(...matching.map(s => Number(s.cpuMs))), maxTimerLatenessMs: Math.max(...matching.map(s => Number(s.maxTimerLatenessMs))),
        maxHeapGrowthBytes: Math.max(...matching.map(s => Number(s.heapGrowthBytes))) };
    });
    const expectedTodoCount = Number(raw.prepare("SELECT count(*) AS count FROM comment WHERE kind='todo'").get()!.count);
    await database.close(); databaseClosed = true;
    const reopened = new DatabaseSync(copy, { readOnly: true });
    try {
      assert.equal(reopened.prepare('SELECT word_count FROM book_node WHERE id=?').get(writtenChapter.id)?.word_count, 20000);
      assert.equal(Number(reopened.prepare("SELECT count(*) AS count FROM comment WHERE kind='todo'").get()!.count), expectedTodoCount);
      assert(reopened.prepare('SELECT id FROM entity_relation WHERE from_id=? AND to_id=?').get(from.id, to.id));
      assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { reopened.close(); }
    const report = { kind: 'stress_seed_node_diagnostic', status: 'passed-domain-checks-native-ui-not-run', generatedAt: new Date().toISOString(),
      source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), fingerprint: sourceFingerprint() },
      environment: { platform: platform(), release: release(), architecture: arch(), node: process.version, sqlite: process.versions.sqlite,
        cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), load: loadavg(), explicitGc: typeof globalThis.gc === 'function' },
      scope: { database: 'SQLite backup of isolated synthetic stress profile; original unchanged', nativeUi: 'not-run', browserUi: 'not-run',
        modelNetworkCalls: 0, timings: 'Node production-function diagnostics; excludes native IPC, React commits, browser DOM, layout, painting and physical input' },
      corpus: { chapters: 100, inspirations: 200, elements: 300, notes: notes.length, conversations: conversationList.length, noteHtmlCharacters: html.reduce((n, text) => n + text.length, 0),
        noteHtmlTags: html.reduce((n, text) => n + (text.match(/<[a-z]/gu)?.length ?? 0), 0), cachedChatCharacters: chat.chars,
        chatDisplayMessages: cached.messages.length, canonicalTurns: snapshot.turns.length, projectedMessages: displayed.messages.length },
      summary, samples, retention, agentRetention, subscriptions, shelfStats: { nodes: shelf.nodes, words: shelf.words, chapters: shelf.chapters, inspirations: 200 },
      profiles: { material: materialProfile, recovery: recoveryProfile, display: displayProfile, wholeBodyWrite: writeProfile },
      writeProfileQueries,
      checks: { counts: true, canonicalRecovery: true, authoredTodoWrites: true, authoredChapterWriteAndYjsWords: true, authoredRelation: true, reopen: true, foreignKeys: true, integrity: true },
      limitations: ['Five repetitions per named timing unless a numbered lifecycle cycle. Logical full captures share the OS page cache.',
        'CPU profiles are separate runs with profiler overhead. Node/V8 timing and GC do not establish WKWebView behavior.',
        'Y.Doc destroy/GC is not evidence that React editor sessions, DOM, listeners, assets or native objects release correctly.',
        'The workstation has unrelated CPU activity; wall times are diagnostics, not release budgets. Raw profiles stay in ignored local storage.'] };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Generated ${path.relative(root, output)}`);
  } finally { if (!databaseClosed) await database.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
