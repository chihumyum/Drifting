import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import CDP from 'chrome-remote-interface';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';
import { aiBrowserChecks, validateDeferredAI } from './renderer-deferred-ai-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); process.chdir(root);
const base = '8f17a6c5963533ea65454d62dbbf33d8ed7e4d6f';
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f7-ai-providers.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const suites = ['src/renderer/architecture/deferred-ai-plugin.test.ts', 'src/renderer/lib/ai/client/providers/deferred-provider.test.ts', 'src/renderer/lib/ai/client/providers/openai.test.ts', 'src/renderer/lib/ai/client/providers/deepseek.test.ts', 'src/renderer/lib/ai/client/build-default-client.test.ts', 'src/renderer/lib/ai/client/llm-client.test.ts', 'src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.test.ts', 'src/renderer/lib/ai/test-provider-connection.test.ts'];
function fingerprint(directory) {
  const digest = createHash('sha256').update(referenceEvidenceFingerprint(directory));
  for (const file of ['vite.renderer.config.ts', ...readdirSync(path.join(directory, 'vite-plugins')).sort().map(name => `vite-plugins/${name}`)]) digest.update(file).update(readFileSync(path.join(directory, file)));
  for (const file of ['scripts/renderer-deferred-ai.ts', 'scripts/renderer-deferred-ai-contract.mjs', 'scripts/run-renderer-deferred-ai.mjs']) digest.update(file).update(readFileSync(path.join(root, file)));
  return digest.digest('hex');
}
const target = id => id.endsWith('/openai/index.mjs') ? 'openai' : id.endsWith('/@google/genai/dist/web/index.mjs') ? 'google' : null;
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validateDeferredAI(report);
  if (!process.argv.includes('--historical')) assert.equal(report.after.source.fingerprint, fingerprint(root), 'AI provider evidence is stale.');
  console.log(process.argv.includes('--historical') ? 'Historical AI provider evidence passed; current source was not asserted.' : 'AI provider evidence matches current source. Native and live-provider acceptance remain open.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync); assert(chrome);
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-ai-provider-acceptance-'));
  const baseline = path.join(temporary, 'baseline'); let added = false;
  const sourceFingerprint = fingerprint(root); const sourceCommit = git('rev-parse', 'HEAD');
  async function measure(directory, label) {
    directory = realpathSync(directory); const current = label === 'after';
    const chunks = []; const outDir = path.join(temporary, `${label}-dist`); const profile = path.join(temporary, `${label}-chrome`);
    let server, browser, client;
    try {
      console.log(`Building ${label} production renderer`);
      await build({ root: directory, configFile: path.join(directory, 'vite.renderer.config.ts'), logLevel: 'warn',
        plugins: [{ name: 'ai-provider-observation', enforce: 'pre',
          transform(code, id) {
            if (id === path.join(directory, 'src/renderer/main.tsx')) return `import ${JSON.stringify(path.join(directory, 'scripts/renderer-deferred-ai.ts'))};\n${code}`;
            const key = target(id); if (key) return `;(globalThis.__AI_SDK_EVALUATIONS__ ??= []).push(${JSON.stringify(key)});\n${code}`;
          },
          generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') chunks.push({ file: chunk.fileName, htmlEntry: chunk.facadeModuleId === path.join(directory, 'index.html'), bytes: Buffer.byteLength(chunk.code), imports: chunk.imports, targets: [...new Set(Object.keys(chunk.modules).map(target).filter(Boolean))] });
          },
        }], build: { outDir, emptyOutDir: true } });
      const initialFiles = new Set(); const visit = file => { if (initialFiles.has(file)) return; initialFiles.add(file); for (const imported of chunks.find(chunk => chunk.file === file)?.imports ?? []) visit(imported); };
      chunks.filter(chunk => chunk.htmlEntry).forEach(chunk => visit(chunk.file)); chunks.forEach(chunk => { chunk.initial = initialFiles.has(chunk.file); });
      server = await preview({ root: directory, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
      browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
      let launchError; browser.on('error', error => { launchError = error; }); const portFile = path.join(profile, 'DevToolsActivePort');
      for (let i = 0; i < 200 && !existsSync(portFile); i++) { if (launchError || browser.exitCode !== null) throw new Error('Headless browser failed to start'); await delay(100); }
      assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      client = await CDP({ port, target: await CDP.New({ port }) });
      await client.Page.enable(); await client.Runtime.enable(); await client.Debugger.enable(); await client.Network.enable();
      const requested = new Set(), parsed = new Set();
      const localPath = url => { try { return new URL(url).pathname.slice(1); } catch { return ''; } };
      client.Network.requestWillBeSent(({ request }) => requested.add(localPath(request.url)));
      client.Debugger.scriptParsed(({ url }) => parsed.add(localPath(url)));
      async function evaluate(expression) { const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; }
      async function until(expression) { for (let i = 0; i < 300; i++) { const value = await evaluate(expression); if (value) return value; await delay(20); } throw new Error(`Browser condition timed out: ${expression}`); }
      const api = (method, ...args) => evaluate(`globalThis.__DEFERRED_AI__.${method}(...${JSON.stringify(args)})`);
      const settled = job => until(`(() => { const job = globalThis.__DEFERRED_AI__.job(${JSON.stringify(job)}); return job.status !== 'pending' && job; })()`);
      const sdkEvaluations = () => evaluate('globalThis.__AI_SDK_EVALUATIONS__ ?? []');
      await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/` });
      await until('Boolean(globalThis.__DEFERRED_AI__)');
      const initial = { requested: [...requested].sort(), parsed: [...parsed].sort(), evaluated: await sdkEvaluations() };
      for (const provider of ['deepseek', 'openai', 'google']) await api('create', provider, `${provider}-stream`);
      const checks = {}; const moduleRequests = [];
      if (current) {
        assert.deepEqual(await sdkEvaluations(), []); checks.constructionIsDeferred = true;
        let paused; let action = 'fail'; const entries = new Map(chunks.flatMap(chunk => chunk.targets.map(key => [chunk.file, key])));
        const interceptionErrors = [];
        client.Fetch.requestPaused(async event => {
          try {
            const kind = entries.get(localPath(event.request.url)); assert(kind, event.request.url);
            moduleRequests.push({ kind, url: localPath(event.request.url) + new URL(event.request.url).search });
            if (action === 'fail') await client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'Failed' });
            else paused = event;
          } catch (error) { interceptionErrors.push(String(error)); }
        });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*provider-attempt=*', requestStage: 'Request' }] });
        for (const [kind, provider] of [['openai', 'deepseek'], ['google', 'google']]) {
          action = 'fail';
          await api('create', provider, `${kind}-failure`);
          const failed = await settled(await api('begin', `${kind}-failure`, provider)); assert.equal(failed.error, 'network'); checks[`${kind}FailureSurfaced`] = true;
          action = 'hold'; paused = undefined;
          await api('create', provider, `${kind}-canceled`); await api('create', provider, `${kind}-active`);
          const canceled = await api('begin', `${kind}-canceled`, provider); const active = await api('begin', `${kind}-active`, provider);
          for (let i = 0; i < 300 && !paused && !interceptionErrors.length; i++) await delay(20);
          assert.deepEqual(interceptionErrors, []); assert(paused);
          await api('cancel', canceled); assert.equal((await settled(canceled)).error, 'aborted'); assert.equal((await api('job', active)).status, 'pending'); checks[`${kind}CancelIsolated`] = true;
          if (kind === 'google') await api('online', false);
          await client.Fetch.continueRequest({ requestId: paused.requestId });
          const completed = await settled(active);
          if (kind === 'google') { assert.equal(completed.error, 'network'); assert(!(await api('calls')).some(call => call.provider === 'google')); checks.offlineDuringGoogleLoad = true; await api('online', true); assert.equal((await settled(await api('begin', `${kind}-active`, provider))).status, 'passed'); }
          else assert.equal(completed.status, 'passed');
          assert(!(await api('calls')).some(call => call.key.includes('canceled') || call.key.includes('mutated')));
          assert((await api('calls')).some(call => call.key === `synthetic-${kind}-active`)); checks[`${kind}SnapshotPreserved`] = true;
          const attempts = moduleRequests.filter(request => request.kind === kind); assert.equal(attempts.length, 2); assert.notEqual(attempts[0].url, attempts[1].url); checks[`${kind}RetryNewKey`] = true;
        }
        await client.Fetch.disable(); assert.deepEqual(interceptionErrors, []);
      }
      const completions = []; const streams = [];
      for (const provider of ['deepseek', 'openai', 'google']) {
        completions.push(await api('factory', provider));
        streams.push(await settled(await api('begin', `${provider}-stream`, provider, true)));
      }
      if (current) {
        checks.factoryCompletion = completions.every(value => value.text === 'OK'); checks.allStreams = streams.every(value => value.status === 'passed' && value.result.map(chunk => chunk.delta).join('') === 'OK');
        const evaluations = await sdkEvaluations(); assert.deepEqual([...evaluations].sort(), ['google', 'openai']); checks.oneSdkEvaluation = true;
        for (const provider of ['deepseek', 'openai', 'google']) await api('factory', provider);
        assert.deepEqual(await sdkEvaluations(), evaluations); assert.equal(moduleRequests.length, 4); checks.cachedReuse = true;
        assert.deepEqual(Object.keys(checks).sort(), [...aiBrowserChecks].sort());
      }
      return { browser: await client.Browser.getVersion(), source: { commit: current ? sourceCommit : base, fingerprint: fingerprint(directory) }, chunks, initial, initialJsBytes: chunks.filter(chunk => chunk.initial).reduce((sum, chunk) => sum + chunk.bytes, 0), checks, moduleRequests, completions, streams, calls: await api('calls') };
    } finally {
      if (client) await client.close();
      if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); } }
      if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    }
  }
  try {
    const testOutput = path.join(temporary, 'tests.json'); execFileSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${testOutput}`], { stdio: 'pipe' });
    const testResult = JSON.parse(readFileSync(testOutput, 'utf8')); assert(testResult.success && testResult.numPendingTests === 0);
    assert.deepEqual(testResult.testResults.map(suite => path.relative(realpathSync(root), realpathSync(suite.name))).sort(), [...suites].sort());
    const tests = testResult.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration ?? 0 })));
    Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000' });
    git('worktree', 'add', '--detach', baseline, base); added = true;
    cpSync(path.join(root, 'scripts/renderer-deferred-ai.ts'), path.join(baseline, 'scripts/renderer-deferred-ai.ts')); symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const before = await measure(baseline, 'before'); const after = await measure(root, 'after');
    assert.equal(fingerprint(root), sourceFingerprint, 'Source changed during acceptance.');
    const adapters = ['deepseek', 'openai', 'google'].map(name => ({ name, before: hash(execFileSync('git', ['show', `${base}:src/renderer/lib/ai/client/providers/${name}.ts`])), after: hash(readFileSync(`src/renderer/lib/ai/client/providers/${name}-runtime.ts`)) }));
    const report = { kind: 'renderer_deferred_ai_providers', status: 'passed', generatedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version, browser: 'headless Chromium; isolated disposable profile' }, before, after, adapters, suites, tests,
      acceptance: { productionModuleLoading: 'passed', syntheticProviderTransport: 'passed', cancellationAndRetry: 'passed', nativeOrDevice: 'not-run', liveProvider: 'not-run', wholeAppStartup: 'not-measured' },
      limitations: ['The actual production renderer entry/config is built with SDK evaluation counters and a synthetic provider invocation API. No native app window or author database is used. Full app readiness is not claimed.', 'Only model-code modules are shared; each provider facade snapshots its own configuration and constructs its own client after demand. The existing Agent runtime, events, credentials and native Responses routes keep their original startup ownership.', 'Real SDK complete/stream calls use intercepted synthetic HTTP/SSE responses and synthetic credentials. No live provider is contacted and no real account conformance is claimed.', 'Four real module fetches are observed: failure then a new same-build URL for each SDK. The graph contract requires every static dependency of each cold SDK entry to already be in the initial closure.', 'Initial JS bytes describe uncompressed static dependency closure for the instrumented production build. Module fetch/parse/evaluation are recorded separately; no p95, heap, native offline upgrade or full-app startup budget is claimed.'] };
    validateDeferredAI(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, checks: Object.keys(after.checks).length, tests: tests.length, initialJsBytes: [before.initialJsBytes, after.initialJsBytes], source: after.source }));
  } finally { if (added) git('worktree', 'remove', '--force', baseline); rmSync(temporary, { recursive: true, force: true }); }
}
