import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { deferredEntryPlugin } from '../vite-plugins/deferred-entry.ts';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';
import { validateTranscriptDisplay } from './transcript-display-contract.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)); process.chdir(root);
const baselineCommit = 'c355d6cfff6e48932cd60d51aff186401bd094f9';
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f4-tree-display.json';
const common = ['scripts/renderer-transcript-display.tsx', 'scripts/renderer-transcript-display.html', 'scripts/run-renderer-transcript-display.mjs', 'scripts/transcript-display-contract.mjs'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function fingerprint(directory) {
  const hash = createHash('sha256').update(referenceEvidenceFingerprint(directory));
  for (const file of common) hash.update(file).update(readFileSync(path.join(root, file)));
  hash.update(readFileSync(path.join(directory, 'vite-plugins/deferred-entry.ts')));
  return hash.digest('hex');
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validateTranscriptDisplay(report);
  if (!process.argv.includes('--historical')) assert.equal(report.after.fingerprint, fingerprint(root), 'Tree display evidence is stale.');
  console.log(process.argv.includes('--historical') ? 'Historical tree display evidence passed; current source was not asserted.' : 'Tree display evidence matches current source; native and whole-app budgets remain open.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-tree-display-acceptance-')); const baseline = path.join(temporary, 'baseline'); let added = false;
  const sourceFingerprint = fingerprint(root); const commit = git('rev-parse', 'HEAD');
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync); assert(chrome);
  async function measure(directory, name) {
    directory = realpathSync(directory); const dist = path.join(temporary, `${name}-dist`); const profile = path.join(temporary, `${name}-profile`);
    let browser, client, server;
    try {
      console.log(`Building ${name} transcript views`);
      await build({ root: directory, configFile: false, envDir: false, logLevel: 'warn', plugins: [{ name: 'tree-display-observation', enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/domain/agent-chat-transcript.ts')) {
            const anchor = '    if (this.cached) return this.cached;'; assert.equal(code.split(anchor).length, 2);
            code = code.replace(anchor, anchor + '\n    globalThis.__TRANSCRIPT_DISPLAY_WORK__.arrays++; globalThis.__TRANSCRIPT_DISPLAY_WORK__.flattenedRows += this.length;');
            const leaf = 'if (depth === 0) visit(tree as readonly AgentChatMessage[], start);';
            if (code.includes('forEachLeaf(')) { assert.equal(code.split(leaf).length, 2); code = code.replace(leaf, 'if (depth === 0) { globalThis.__TRANSCRIPT_DISPLAY_WORK__.leaves++; visit(tree as readonly AgentChatMessage[], start); }'); }
          }
          if (id.endsWith('/features/agent/useAgentMessageBlocks.ts')) {
            const anchor = 'previous.messages[offset]'; assert(code.includes(anchor));
            code = code.replaceAll(anchor, '(globalThis.__TRANSCRIPT_DISPLAY_WORK__.comparisons++, previous.messages[offset])');
          }
          if (id.endsWith('/workspace/MobileAgentTranscript.tsx')) for (const service of ['useBookNode', 'useComment']) code = code.replace(`'../../../usecase/${service}'`, "'../../../performance/mobile-agent-output-services'");
          return { code, map: null };
        },
      }, react(), ...[
        ['virtual:memo-material', 'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx', 'memo-material', 'loadMemoMaterial'],
        ['virtual:graph-ui', 'src/renderer/features/graph/graph-ui-components.ts', 'graph-ui', 'loadGraphUi'],
        ['virtual:story-graph', 'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx', 'story-graph', 'loadStoryGraph'],
        ['virtual:element-graph', 'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx', 'element-graph', 'loadElementGraph'],
      ].map(([id, entry, name, exportName]) => deferredEntryPlugin({ id, entry, name, exportName, attemptParam: 'view-attempt' }))],
      resolve: { alias: { '@': path.join(directory, 'src') } }, build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: path.join(directory, 'scripts/renderer-transcript-display.html') } } });
      server = await preview({ root: directory, configFile: false, envDir: false, logLevel: 'warn', build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0, open: false } });
      browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
      let launchError; browser.on('error', error => { launchError = error; }); const portFile = path.join(profile, 'DevToolsActivePort');
      for (let i = 0; i < 200 && !existsSync(portFile); i++) { if (launchError || browser.exitCode !== null) throw new Error('Headless browser did not start'); await delay(100); }
      assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]); client = await CDP({ port, target: await CDP.New({ port }) });
      await client.Page.enable(); await client.Runtime.enable(); const errors = []; client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.text));
      const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-transcript-display.html` }); await loaded;
      const result = await client.Runtime.evaluate({ expression: 'globalThis.__TRANSCRIPT_DISPLAY__.run()', awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); assert.deepEqual(errors, []);
      return { commit: name === 'before' ? baselineCommit : commit, fingerprint: fingerprint(directory), browser: await client.Browser.getVersion(), profiles: result.result.value };
    } finally {
      if (client) await client.close();
      if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); } }
      if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    }
  }
  try {
    const suites = ['src/renderer/domain/agent-chat-transcript.test.ts', 'src/renderer/features/agent/useAgentMessageBlocks.test.ts', 'src/renderer/features/agent/chat-display-projection.test.ts', 'src/renderer/shells/mobile/workspace/mobile-agent-model.test.ts'];
    const testsPath = path.join(temporary, 'tests.json'); execFileSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${testsPath}`], { stdio: 'pipe' });
    const result = JSON.parse(readFileSync(testsPath, 'utf8')); assert(result.success && result.numPendingTests === 0);
    assert.deepEqual(result.testResults.map(suite => path.relative(realpathSync(root), realpathSync(suite.name))).sort(), [...suites].sort());
    const tests = result.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration ?? 0 })));
    git('worktree', 'add', '--detach', baseline, baselineCommit); added = true; for (const file of common.slice(0, 2)) cpSync(path.join(root, file), path.join(baseline, file)); symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const before = await measure(baseline, 'before'); const after = await measure(root, 'after');
    assert.equal(fingerprint(root), sourceFingerprint, 'Source changed during acceptance.');
    const report = { kind: 'agent_transcript_tree_display', status: 'passed', generatedAt: new Date().toISOString(), before, after, suites, tests,
      acceptance: { actualDesktopAndMobileViews: 'passed', immutableSnapshotAndFallback: 'passed', headlessOnly: true, nativeAndPhysical: 'not-run', fullAppBudget: 'not-measured' },
      limitations: ['Same synthetic trace and mounted desktop/mobile views on both revisions. Twenty synchronous visible commits isolate display cost from journal ingress, frame batching, model and database persistence.', 'Counters are injected only in the disposable browser build; timings include instrumentation and full DOM/layout. No fixed-device latency or heap budget is asserted.', 'Historical DOM, selection, tool expansion, rebuilt snapshot fallback, historical tool updates and terminal output are checked. Mobile output service hooks are synthetic; existing command ownership is verified by the separate renderer regression.', 'Leaf/group traversal remains O(history / 32); desktop usage and mobile evidence aggregation still traverse messages. Explicit persistence, idle turn references and legacy array subscribers can still materialize a complete array. No DOM virtualization is added.'] };
    validateTranscriptDisplay(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ output, source: after.fingerprint, profiles: after.profiles.length, tests: tests.length }));
  } finally { if (added) git('worktree', 'remove', '--force', baseline); rmSync(temporary, { recursive: true, force: true }); }
}
