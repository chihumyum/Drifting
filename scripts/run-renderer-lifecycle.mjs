import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { launchHeadlessBrowser, closeHeadlessSession, withDeadline } from './renderer-headless-browser.mjs';
import { rendererFingerprintVersion, rendererSourceFingerprint } from './renderer-performance-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? '.local-data/renderer-performance/lifecycle.json';
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-lifecycle-'));
const outDir = path.join(temporary, 'dist');
const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  rendererFingerprint: rendererSourceFingerprint(root), fingerprintVersion: rendererFingerprintVersion,
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) };
let browser, client, server, reportWritten = false;
const write = report => { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); reportWritten = true; };
try {
  const nodeEditor = readFileSync('src/renderer/views/NodeEditorView.tsx', 'utf8');
  const key = nodeEditor.match(/<PlotPlannerDock\s+key=\{([^}]+)\}\s+nodeId=/)?.[1];
  // Template expressions contain a closing brace; parse that supported shape explicitly.
  const templateKey = nodeEditor.match(/<PlotPlannerDock\s+key=\{(`[^`]+`)\}\s+nodeId=/)?.[1];
  if ((!key && !templateKey) || !nodeEditor.includes('<div className="editor-body" key={nodeId}>')) throw new Error('NodeEditor sibling key fixture drifted');
  await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [{
    name: 'source-plot-planner-key', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/performance/lifecycle-harness.tsx')) return;
      const anchor = 'declare const __DRIFTING_PLOT_KEY__: (nodeId: string) => string;';
      if (!code.includes(anchor)) throw new Error('Planner key instrumentation drifted');
      return { code: code.replace(anchor, `const __DRIFTING_PLOT_KEY__ = (nodeId: string) => (${templateKey ?? key});`), map: null };
    },
  }, react()],
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-lifecycle.html') } } });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
  browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
  const target = await withDeadline(CDP.New({ port: browser.port }), 10000, 'Lifecycle target');
  client = await withDeadline(CDP({ port: browser.port, target }), 10000, 'Lifecycle CDP');
  await client.Page.enable(); await client.Runtime.enable();
  const errors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  const load = async () => {
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: `${server.resolvedUrls.local[0]}scripts/renderer-lifecycle.html` });
    await withDeadline(loaded, 15000, 'Lifecycle page load');
  };
  const evaluate = async expression => {
    const result = await withDeadline(client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }), 120000, 'Lifecycle scenario');
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    if (errors.length) throw new Error(errors.join('\n'));
    return result.result.value;
  };
  await load();
  const negativeControl = await evaluate('window.__DRIFTING_LIFECYCLE__.negativeControl()');
  if (!negativeControl.detected) throw new Error('Old duplicate key did not fail the regression detector');
  // Discard the deliberately broken tree before measuring the real source key.
  await load();
  const baseline = await evaluate('window.__DRIFTING_LIFECYCLE__.init()');
  const sample = async cycles => {
    await client.HeapProfiler.collectGarbage();
    return { cycles, ...await client.Memory.getDOMCounters(), ...await client.Runtime.getHeapUsage() };
  };
  const samples = [await sample(0)];
  let batch;
  for (let part = 0; part < 4; part++) {
    batch = await evaluate('window.__DRIFTING_LIFECYCLE__.batch(25)');
    samples.push(await sample(batch.cycles));
    console.log(`[lifecycle] ${batch.cycles}/100 cycles per surface; resources released`);
  }
  // Heap is diagnostic with a coarse runaway guard, not a device timing budget.
  const first = samples[0];
  const checks = {
    duplicateKeyNegativeControl: negativeControl.detected,
    resourcesReturnToBaselineEveryCycle: JSON.stringify(baseline) === JSON.stringify(batch.resources),
    postGcDomBounded: samples.every(s => s.documents <= first.documents && s.nodes <= first.nodes + 40 && s.jsEventListeners <= first.jsEventListeners + 10),
    postGcHeapBounded: samples.every(s => s.usedSize <= first.usedSize + 8 * 1024 * 1024),
  };
  if (rendererSourceFingerprint(root) !== source.rendererFingerprint) throw new Error('Source changed during lifecycle measurement');
  const report = { schemaVersion: 1, kind: 'renderer_lifecycle_run', generatedAt: new Date().toISOString(), source,
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, negativeControl,
    cyclesPerSurface: batch.cycles, warmupCyclesPerSurface: 10, agentHistoryMessages: 300,
    resources: { baseline, final: batch.resources }, samples,
    environment: { platform: platform(), node: process.version, browser: await client.Browser.getVersion() },
    limitations: ['Production React in isolated headless Chromium with synthetic data and persistence callbacks.',
      'Real PlotPlannerDock and transcript components; controlled NodeEditor sibling fixture reads its key from source.',
      'Real editor session/active editor ownership and graph geometry hook; not whole-app routing, Yjs durability, native windows, simulator or device acceptance.',
      'Global listeners, pending timers/frames, observers and Agent store subscriptions must return to their warmed baseline after every surface unmount.',
      'Post-GC DOM growth guard: 40 nodes and 10 listeners; heap growth guard: 8 MiB. These bounded checks do not prove absence of every possible leak.'] };
  write(report);
  if (report.status !== 'passed') throw new Error(`Lifecycle checks failed: ${JSON.stringify(checks)}`);
  console.log(JSON.stringify({ output, checks, resources: report.resources, samples }, null, 2));
} catch (error) {
  if (!reportWritten) write({ schemaVersion: 1, kind: 'renderer_lifecycle_failure', status: 'failed', generatedAt: new Date().toISOString(), source, error: String(error) });
  throw error;
} finally {
  try { await closeHeadlessSession({ client, browser, server }); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
