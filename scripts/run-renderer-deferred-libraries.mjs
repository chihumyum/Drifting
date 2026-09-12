import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import CDP from 'chrome-remote-interface';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const baseline = process.argv.includes('--baseline');
const output = `docs/renderer-performance/acceptance/f7-libraries-${baseline ? 'baseline' : 'deferred'}.json`;
const fingerprint = () => createHash('sha256').update(referenceEvidenceFingerprint(root))
  .update(readFileSync(new URL('./renderer-deferred-libraries.ts', import.meta.url)))
  .update(readFileSync(new URL('./run-renderer-deferred-libraries.mjs', import.meta.url)))
  .update(readFileSync(path.join(root, 'vite.renderer.config.ts'))).digest('hex');
const target = (id) => id.endsWith('/pdfjs-dist/legacy/build/pdf.mjs') ? 'pdf' : (id.endsWith('/jszip/lib/index.js') || id.endsWith('/jszip/dist/jszip.min.js')) ? 'zip' : null;
const counts = (evaluations, key) => evaluations.filter((item) => item === key).length;

function validate(report) {
  assert.equal(report.kind, 'renderer_deferred_libraries'); assert.equal(report.status, 'passed');
  assert.equal(report.mode, baseline ? 'baseline' : 'deferred');
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  for (const key of ['pdf', 'zip']) {
    assert.equal(counts(report.initial.evaluated, key), baseline ? 1 : 0, `Initial evaluation: ${key}`);
    assert.equal(report.chunks.some((chunk) => chunk.initial && chunk.targets.includes(key)), baseline);
    assert.equal(report.initial.parsed.some((file) => report.chunks.find((chunk) => chunk.file === file)?.targets.includes(key)), baseline);
  }
  assert.equal(counts(report.afterPdf.evaluated, 'pdf'), 1);
  assert.equal(counts(report.afterPdf.evaluated, 'zip'), baseline ? 1 : 0);
  assert.equal(counts(report.afterArchive.evaluated, 'zip'), 1);
  assert.equal(report.pdf.length, 3);
  for (const sample of report.pdf) {
    assert.equal(sample.width, 120); assert.equal(sample.height, 60); assert.equal(sample.mime, 'image/jpeg');
    assert(sample.pixel[0] > 240 && sample.pixel[1] < 15 && sample.pixel[2] < 15 && sample.pixel[3] === 255);
    assert(sample.sourceIntact && sample.sourceBytes > 400 && sample.sizeBytes > 100);
  }
  assert.deepEqual(report.archive.files, ['README.md', 'index.md']);
  assert.equal(report.archive.valid, true);
  if (!baseline) {
    assert.match(report.fixture.pdfSha256, /^[0-9a-f]{64}$/);
    assert(report.workerStarts >= 5, `Worker observation: ${JSON.stringify(report.workerLifecycle)}`); assert.equal(report.workersRemaining, 0);
    assert(report.workerAssets.length > 0 && report.workerUrls.length > 0);
    assert(report.workerUrls.every((url) => report.workerAssets.some((asset) => asset.file === url)));
    assert.equal(report.invalidPdf.rejected, true); assert.equal(report.recoveredPdf.sourceIntact, true);
    assert.equal(report.recoveredPdf.width, 120); assert(report.recoveredPdf.pixel[0] > 240);
    assert.equal(report.tests.length, 43);
    assert(report.tests.every((test) => test.status === 'passed' && test.durationMs >= 0));
  }
  assert.equal(report.acceptance.fullAppPerformance, 'not-run'); assert.equal(report.acceptance.nativeOrDevice, 'not-run');
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  if (!baseline) assert.equal(report.source.fingerprint, fingerprint(), 'Deferred-library evidence is stale.');
  console.log('Deferred-library evidence is valid; browser module loading is separate from native startup acceptance.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  assert(chrome, 'Set DRIFTING_PERF_CHROME to Chromium.');
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-deferred-libraries-'));
  const profile = path.join(temporary, 'profile'); const outDir = path.join(temporary, 'dist');
  const sourceFingerprint = fingerprint();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let server; let browser; let client;
  const chunks = []; const workerAssets = []; let tests = [];
  try {
    if (!baseline) {
      const jsonPath = path.join(temporary, 'tests.json');
      execFileSync('pnpm', ['exec', 'vitest', 'run',
        'src/renderer/lib/pdf-thumbnail.test.ts', 'src/renderer/features/library/pdf-preview-document.test.ts',
        'src/renderer/services/export/relational-markdown.acceptance.test.ts', 'src/renderer/platform/tauri.test.ts',
        '--reporter=json', `--outputFile=${jsonPath}`], { stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
      const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
      assert(result.success && result.numFailedTests === 0 && result.numPendingTests === 0);
      tests = result.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration })));
    }
    Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000' });
    await build({ root, configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'warn',
      plugins: [{
        name: 'deferred-library-observation', enforce: 'pre',
        transform(code, id) {
          if (id === path.join(root, 'src/renderer/main.tsx')) return `import ${JSON.stringify(path.join(root, 'scripts/renderer-deferred-libraries.ts'))};\n${code}`;
          const key = target(id);
          if (key) return `;(globalThis.__DEFERRED_LIBRARY_EVALUATIONS__ ??= []).push(${JSON.stringify(key)});\n${code}`;
        },
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.push({ file: item.fileName, entry: item.isEntry, htmlEntry: item.facadeModuleId === path.join(root, 'index.html'), bytes: Buffer.byteLength(item.code), imports: item.imports, targets: [...new Set(Object.keys(item.modules).map(target).filter(Boolean))] });
          else if (/pdf\.worker.*\.mjs$/.test(item.fileName)) workerAssets.push({ file: item.fileName, bytes: Buffer.byteLength(item.source) });
        },
      }], build: { outDir, emptyOutDir: true } });
    const initialFiles = new Set();
    function visit(file) { if (initialFiles.has(file)) return; initialFiles.add(file); for (const imported of chunks.find((chunk) => chunk.file === file)?.imports ?? []) visit(imported); }
    for (const chunk of chunks.filter((chunk) => chunk.htmlEntry)) visit(chunk.file);
    for (const chunk of chunks) chunk.initial = initialFiles.has(chunk.file);
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let launchError; browser.on('error', (error) => { launchError = error; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 200 && !existsSync(portFile); attempt += 1) { if (launchError || browser.exitCode !== null) throw new Error('Chromium failed to start.'); await delay(100); }
    assert(existsSync(portFile), 'Chromium timed out.');
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    client = await CDP({ port, target: await CDP.New({ port }) });
    await client.Page.enable(); await client.Runtime.enable(); await client.Debugger.enable(); await client.Network.enable();
    // Dedicated workers are not consistently reported by page-level Target
    // discovery. Observe actual native Worker construction/termination calls
    // without substituting parsing, message delivery or document behavior.
    await client.Page.addScriptToEvaluateOnNewDocument({ source: `
      globalThis.__PDF_WORKER_LIFECYCLE__ = [];
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          const entry = { url: new URL(String(url), location.href).pathname.slice(1), terminated: false };
          this.__evidenceEntry = entry;
          globalThis.__PDF_WORKER_LIFECYCLE__.push(entry);
        }
        terminate() { this.__evidenceEntry.terminated = true; return super.terminate(); }
      };
    ` });
    const origin = server.resolvedUrls.local[0]; const parsed = new Set(); const requested = new Set();
    const workers = new Map();
    const observeWorker = ({ targetInfo }) => { if (targetInfo.type === 'worker' && targetInfo.url.startsWith(origin)) workers.set(targetInfo.targetId, targetInfo.url.slice(origin.length)); };
    client.Target.targetCreated(observeWorker); client.Target.targetInfoChanged(observeWorker);
    await client.Target.setDiscoverTargets({ discover: true });
    client.Debugger.scriptParsed(({ url }) => { if (url.startsWith(origin)) parsed.add(url.slice(origin.length)); });
    client.Network.requestWillBeSent(({ request }) => { if (request.url.startsWith(origin)) requested.add(new URL(request.url).pathname.slice(1)); });
    const evaluate = async (expression) => { const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url: origin }); await loaded;
    for (let attempt = 0; attempt < 100 && !(await evaluate('Boolean(window.__DEFERRED_LIBRARIES__)')); attempt += 1) await delay(50);
    assert(await evaluate('Boolean(window.__DEFERRED_LIBRARIES__)'));
    const snapshot = async () => ({ evaluated: await evaluate('globalThis.__DEFERRED_LIBRARY_EVALUATIONS__ ?? []'), parsed: [...parsed].sort(), requested: [...requested].sort(), workerCount: await evaluate('globalThis.__PDF_WORKER_LIFECYCLE__.length') });
    const initial = await snapshot();
    const pdf = [await evaluate('window.__DEFERRED_LIBRARIES__.pdf()')];
    pdf.push(...await evaluate('Promise.all([window.__DEFERRED_LIBRARIES__.pdf(), window.__DEFERRED_LIBRARIES__.pdf()])'));
    const afterPdf = await snapshot();
    const fixture = !baseline ? await evaluate('window.__DEFERRED_LIBRARIES__.fixture()') : undefined;
    const invalidPdf = !baseline ? await evaluate('window.__DEFERRED_LIBRARIES__.invalidPdf()') : undefined;
    const recoveredPdf = !baseline ? await evaluate('window.__DEFERRED_LIBRARIES__.pdf()') : undefined;
    const archive = await evaluate('window.__DEFERRED_LIBRARIES__.archive()');
    const decoded = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,zipfile,io; z=zipfile.ZipFile(io.BytesIO(bytes(json.load(sys.stdin)))); names=sorted(z.namelist()); assert "Drifting" in z.read("README.md").decode(); print(json.dumps({"files":names,"valid":z.testzip() is None}))'], { input: JSON.stringify(archive.bytes), encoding: 'utf8' }));
    const afterArchive = await snapshot();
    const workerLifecycle = (await evaluate('globalThis.__PDF_WORKER_LIFECYCLE__')).filter((entry) => /pdf\.worker.*\.mjs$/.test(entry.url));
    const workersRemaining = workerLifecycle.filter((entry) => !entry.terminated).length;
    assert.equal(sourceFingerprint, fingerprint(), 'Source changed during measurement.');
    const report = {
      schemaVersion: 1, kind: 'renderer_deferred_libraries', status: 'passed', mode: baseline ? 'baseline' : 'deferred', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: sourceFingerprint, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) },
      environment: { platform: process.platform, node: process.version, browser: (await client.Browser.getVersion()).product },
      chunks, initial, afterPdf, afterArchive, pdf, fixture, invalidPdf, recoveredPdf,
      workerAssets, workerUrls: [...new Set(workerLifecycle.map((entry) => entry.url))].sort(), workerStarts: workerLifecycle.length, workersRemaining, workerLifecycle, cdpWorkerTargets: workers.size, tests,
      archive: { filename: archive.filename, sizeBytes: archive.bytes.length, elapsedMs: archive.elapsedMs, ...decoded },
      acceptance: { moduleLoading: 'passed', syntheticPdfRendering: 'passed', archiveRoundTrip: 'passed', fullAppPerformance: 'not-run', nativeOrDevice: 'not-run' },
      limitations: [
        'This builds the actual production renderer entry/config with two library evaluation counters and a synthetic invocation API added only by the acceptance build. Module ownership, static closure, browser requests and parsed scripts are recorded separately.',
        'The plain browser has no native bridge, author database or account. Full app readiness/errors and native startup latency are not acceptance claims. Native event/bootstrap order is not replaced by the fixture.',
        'PDF calls exercise the actual engine/worker and JPEG canvas output; ZIP bytes are validated independently by Python zipfile. An acceptance-only native Worker subclass records real construction/terminate calls. Zero remaining means all observed workers received terminate, not an OS process-memory measurement. Page-level CDP target observations are supplementary. No private files are read or exported.',
        'Document lifetime tests use controlled native reads and module-load promises, while rendering/worker checks use the real browser engine. Retry after document failure is verified; this is not a failed module-fetch retry claim.',
        'One first call and two concurrent repeated PDF calls are diagnostics, not p95 budgets. This does not test failed chunk retrieval, offline native resource paths, physical devices or input continuity.',
      ],
    };
    validate(report); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, initialJsBytes: chunks.filter((chunk) => chunk.initial).reduce((sum, chunk) => sum + chunk.bytes, 0), initial: initial.evaluated, source: report.source }));
  } finally {
    if (client) await client.close();
    if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let i = 0; i < 30 && browser.exitCode === null; i += 1) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise((resolve) => browser.once('exit', resolve)); } }
    if (server) await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
}
