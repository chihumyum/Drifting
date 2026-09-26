// Isolated unsigned production Tauri/WKWebView performance collector. Prepared
// builds are not measurements; --build-only never opens a window.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const productPaths = ['src', 'src-tauri', 'crates/drifting-core', 'drizzle', 'packages', 'patches', 'vite-plugins',
  'vite.renderer.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'tailwind.config.js', 'postcss.config.js'];
const seedPaths = ['crates/drifting-prose/Cargo.toml', 'crates/drifting-prose/Cargo.lock', 'crates/drifting-prose/src',
  'crates/drifting-prose/examples/scale-fixture.rs', 'crates/drifting-document/Cargo.toml', 'crates/drifting-document/Cargo.lock',
  'crates/drifting-document/src', 'vendor/yrs'];
const harnessFiles = ['scripts/apple-renderer-performance-runner.mjs', 'scripts/apple-editor-performance-baseline.ts', 'scripts/apple-editor-performance-ui.ts', 'scripts/apple-performance-rustc-wrapper.sh'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const files = () => [...new Set([...git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...productPaths, ...seedPaths).split('\0').filter(Boolean), ...harnessFiles])]
  .filter(file => existsSync(path.join(root, file))).sort();
const fingerprint = () => hash(files().map(file => `${file}\0${hash(readFileSync(path.join(root, file)))}`).join('\n'));
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = path.resolve(root, option('output') ?? '.local-data/apple-native/editor-performance/renderer.json');
const outputStem = path.extname(output) ? output.slice(0, -path.extname(output).length) : output;
const preparedOutput = `${outputStem}.prepared.json`;
const failureOutput = `${outputStem}.failed.json`;
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const environment = () => ({ platform: os.platform(), architecture: os.arch(), osRelease: os.release(),
  osVersion: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() });
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'DEVELOPER_DIR', 'SDKROOT', 'LANG']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { RUSTUP_TOOLCHAIN: '1.96', VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false',
  VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000',
  CARGO_TARGET_DIR: path.join(root, `.local-data/apple-native/renderer-performance-target-${hash(readFileSync(path.join(root, 'scripts/apple-performance-rustc-wrapper.sh'))).slice(0, 12)}`) });
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
});
function processes() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map(row => ({ pid: Number(row[1]), parentPid: Number(row[2]), rssBytes: Number(row[3]) * 1024, command: row[4] }));
}
function validateMeasurement(value, corpus) {
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'apple-editor-performance-renderer');
  assert.equal(value.status, 'passed', value.message); assert.equal(value.corpusSha256, corpus.corpusSha256);
  assert.deepEqual(value.failures, []); assert.equal(value.samples.length, 132);
  const counts = { 'first-document-open': 1, 'committed-edit-paint-opportunity': 30, 'programmatic-scroll': 1, 'warm-document-switch': 10, 'durable-settling': 2 };
  for (const entry of corpus.cases) for (const [phase, count] of Object.entries(counts)) {
    const samples = value.samples.filter(sample => sample.caseId === entry.id && sample.phase === phase);
    assert.equal(samples.length, count, `${entry.id}/${phase}`);
    for (const sample of samples) {
      assert(Number.isFinite(sample.durationMs) && sample.durationMs >= 0);
      assert(Number.isFinite(sample.startedAtMs) && sample.endedAtMs >= sample.startedAtMs);
      assert(Math.abs(sample.durationMs - (sample.endedAtMs - sample.startedAtMs)) < 0.001);
      assert(sample.frameIntervalsMs.every(interval => Number.isFinite(interval) && interval >= 0));
    }
  }
}
function summarize(measurement) {
  const groups = new Map();
  for (const sample of measurement.samples) {
    const retention = sample.phase === 'warm-document-switch'
      ? sample.details.retainedEditor && sample.details.retainedYDoc ? '/retained-editor-and-doc' : '/recreated-editor-or-doc' : '';
    const key = `${sample.caseId}/${sample.phase}${retention}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const stats = values => {
    assert(values.every(value => Number.isFinite(value) && value >= 0));
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return { samples: values.length, medianMs: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      nearestRankP95Ms: values[Math.ceil(values.length * 0.95) - 1], maximumMs: values.at(-1) };
  };
  return Object.fromEntries([...groups].map(([key, rows]) => [key, {
    wrapperDuration: stats(rows.map(row => row.durationMs)),
    wrapperBoundary: 'measure wrapper around operation, including visible DOM assertions; not dispatch latency',
    ...(rows[0].phase === 'committed-edit-paint-opportunity' ? { editMetrics: Object.fromEntries(
      ['dispatchToPaintOpportunityMs', 'dispatchToYjsCommitMs', 'yjsCommitToPaintOpportunityMs']
        .map(metric => [metric, stats(rows.map(row => row.details[metric]))])) } : {}),
  }]));
}
function inspectDatabase(source, file, corpusFile) {
  // Independent Yjs replay after the process has exited, not contentJson.
  const script = `const assert=require('node:assert/strict'), fs=require('node:fs'), crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),Y=require('yjs'),{yDocToProsemirrorJSON}=require('y-prosemirror');
const {getStaticChapterSchema}=require('./src/renderer/components/editor/chapter-static-html.ts');
const corpus=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),db=new DatabaseSync(process.argv[1],{readOnly:true}),schema=getStaticChapterSchema();
try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
assert.equal(db.prepare('SELECT count(*) AS n FROM book_node').get().n,1000);
const cases=corpus.cases.map(entry=>{const doc=new Y.Doc();try {const id='node-content:apple-scale-'+entry.id;
const snapshot=db.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id=?').get(id);if(snapshot)Y.applyUpdate(doc,snapshot.state_blob);
for(const row of db.prepare('SELECT update_blob FROM yjs_updates WHERE document_id=? ORDER BY id').all(id))Y.applyUpdate(doc,row.update_blob);
const prose=schema.nodeFromJSON(yDocToProsemirrorJSON(doc,'default'));prose.check();const plain=prose.textBetween(0,prose.content.size,'\\n');
const sha256=crypto.createHash('sha256').update(plain).digest('hex');assert.equal(sha256,entry.plainTextSha256);assert.deepEqual(JSON.parse(JSON.stringify(prose.toJSON())),entry.proseMirrorJson);
return {id:entry.id,utf16Length:plain.length,plainTextSha256:sha256,semanticUnchanged:true};}finally{doc.destroy();}});
console.log(JSON.stringify({integrityCheck:'ok',foreignKeyCheck:'ok',bookNodes:1000,cases}));}finally{db.close();}`;
  return JSON.parse(execFileSync(process.execPath, ['--import=tsx', '-e', script, file, corpusFile], { cwd: source, env, encoding: 'utf8' }));
}
function bundleFingerprint(bundle) {
  const entries = [];
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(file, `${relative}/`);
      else entries.push(`${relative}\0${entry.isSymbolicLink() ? `link:${readlinkSync(file)}` : hash(readFileSync(file))}`);
    }
  }
  walk(bundle); return hash(entries.join('\n'));
}
function verifyArtifact(prepared) {
  assert(/^cc\.drifting\.client\.editorperf\.r[0-9a-f]{12}$/.test(prepared.identifier), 'Not an isolated performance application');
  const plist = path.join(prepared.bundle, 'Contents/Info.plist');
  const value = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  assert.equal(value('CFBundleIdentifier'), prepared.identifier);
  assert.equal(path.join(prepared.bundle, 'Contents/MacOS', value('CFBundleExecutable')), prepared.binary);
  assert.equal(hash(readFileSync(prepared.binary)), prepared.artifact.sha256, 'Prepared binary changed');
  assert.equal(bundleFingerprint(prepared.bundle), prepared.artifact.bundleSha256, 'Prepared bundle changed');
  assert(statSync(prepared.binary).mtimeMs >= prepared.buildStartedAtMs, 'Refusing stale binary');
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.kind, 'apple-editor-performance-renderer-host'); assert.equal(report.status, 'passed');
  assert.equal(report.source.fingerprint, fingerprint(), 'Renderer performance source changed');
  validateMeasurement(report.measurement, report.corpus);
  assert.equal(report.shutdown.launcherExitCode, 0); assert.equal(report.shutdown.nativeProcessExited, true);
  assert.equal(report.database.integrityCheck, 'ok'); assert.equal(report.database.foreignKeyCheck, 'ok');
  assert.equal(report.database.bookNodes, 1000); assert(report.database.cases.every(entry => entry.semanticUnchanged));
  assert.deepEqual(report.summary, summarize(report.measurement));
  console.log('Current isolated renderer baseline validates; complete P2 budgets, physical input and release gates remain open.');
  process.exit(0);
}
assert.equal(process.platform, 'darwin', 'The packaged renderer collector requires macOS');
let server, prepared, launcher, nativePid, measurement, ownedArtifacts;
const processMemory = [];
try {
  const resume = option('resume');
  if (resume) {
    prepared = JSON.parse(readFileSync(path.resolve(resume), 'utf8'));
    assert.equal(prepared.kind, 'apple-editor-performance-renderer-prepared');
    assert.equal(prepared.sourceProvenance.fingerprint, fingerprint(), 'Prepared source is stale; rebuild before measuring');
    verifyArtifact(prepared);
  }
  const token = prepared?.token ?? randomBytes(32).toString('hex');
  server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'].includes(origin)) { response.writeHead(403).end(); return; }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.url !== '/report') { response.writeHead(404).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    try {
      const parts = []; let bytes = 0;
      for await (const part of request) { bytes += part.length; assert(bytes <= 2 * 1024 * 1024, 'Report exceeds size limit'); parts.push(part); }
      assert.equal(measurement, undefined, 'Duplicate report');
      measurement = JSON.parse(Buffer.concat(parts).toString('utf8'));
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(prepared?.port ?? 0, '127.0.0.1', resolve); });
  const port = server.address().port;
  if (!prepared) {
    const owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'drifting-renderer-scale-')));
    ownedArtifacts = owned;
    const source = path.join(owned, 'source'); mkdirSync(source);
    const sourceFingerprint = fingerprint(), snapshotFiles = files();
    console.log(`Owned renderer benchmark artifacts: ${owned}`);
    for (const file of snapshotFiles) {
      assert(lstatSync(path.join(root, file)).isFile(), `Only ordinary allowlisted source files may be copied: ${file}`);
      assert(!/(^|\/)\.env($|\.)/.test(file), `Refusing environment file: ${file}`);
      const target = path.join(source, file); mkdirSync(path.dirname(target), { recursive: true }); cpSync(path.join(root, file), target);
    }
    symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir');
    env.RUSTC_WRAPPER = path.join(source, 'scripts/apple-performance-rustc-wrapper.sh');
    const corpusFile = path.join(owned, 'corpus.json');
    await run(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/apple-editor-performance-baseline.ts', `--out=${corpusFile}`], source);
    const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
    const fixtureDir = path.join(owned, 'fixture');
    const fixtureTarget = path.join(root, '.local-data/apple-native/rust');
    const fixtureBinary = option('fixture-binary') ?? path.join(fixtureTarget, 'debug/examples/scale-fixture');
    if (!option('fixture-binary')) {
      const previousTarget = env.CARGO_TARGET_DIR; env.CARGO_TARGET_DIR = fixtureTarget;
      try { await run('cargo', ['build', '--manifest-path', 'crates/drifting-prose/Cargo.toml', '--example', 'scale-fixture', '--locked'], source); }
      finally { env.CARGO_TARGET_DIR = previousTarget; }
    }
    await run(fixtureBinary, [corpusFile, 'tauri', 'all', fixtureDir], source);
    const before = inspectDatabase(source, path.join(fixtureDir, 'drifting-library.db'), corpusFile);
    const runId = randomBytes(6).toString('hex'), identifier = `cc.drifting.client.editorperf.r${runId}`, productName = `Drifting Editor Perf ${runId}`;
    const keychainFile = path.join(source, 'src-tauri/src/secure_storage.rs'), keychain = readFileSync(keychainFile, 'utf8');
    const anchor = 'const KEYCHAIN_SERVICE: &str = "Drifting";'; assert.equal(keychain.split(anchor).length, 2);
    writeFileSync(keychainFile, keychain.replace(anchor, `const KEYCHAIN_SERVICE: &str = "Drifting.EditorPerf.${runId}";`));
    const config = { endpoint: `http://127.0.0.1:${port}/report`, token, projectId: 'apple-scale-project', corpusSha256: corpus.corpusSha256,
      cases: corpus.cases.map(entry => ({ id: entry.id, nodeId: `apple-scale-${entry.id}`, utf16Length: entry.utf16Length, paragraphCount: entry.paragraphCount, plainTextSha256: entry.plainTextSha256 })),
      samplesPerCase: corpus.samplesPerCase, warmSwitchSamples: corpus.warmSwitchSamples, scrollSteps: corpus.scrollSteps, editRange: corpus.editRange, editText: corpus.editText };
    const base = JSON.parse(readFileSync(path.join(source, 'src-tauri/tauri.conf.json'), 'utf8'));
    writeJson(path.join(source, 'src-tauri/tauri.editor-performance.conf.json'), { productName, identifier,
      build: { beforeBuildCommand: 'pnpm exec vite build --config vite.editor-performance.config.ts' },
      app: { security: { csp: base.app.security.csp.replace("connect-src 'self'", `connect-src 'self' http://127.0.0.1:${port}`) } },
      bundle: { createUpdaterArtifacts: false }, plugins: { 'deep-link': { desktop: { schemes: [`drifting-editor-perf-${runId}`] } } } });
    writeFileSync(path.join(source, 'vite.editor-performance.config.ts'), `import {mergeConfig} from 'vite';\nimport base from './vite.renderer.config';\nexport default env=>mergeConfig(base(env),{define:{__DRIFTING_EDITOR_PERFORMANCE_CONFIG__:JSON.stringify(${JSON.stringify(config)})},plugins:[{name:'editor-performance-observer',enforce:'pre',transform(code,id){if(id.endsWith('/src/renderer/main.tsx'))return 'import "../../scripts/apple-editor-performance-ui";\\n'+code;}}]});\n`);
    const buildStartedAtMs = Date.now();
    await run('pnpm', ['exec', 'tauri', 'build', '--bundles', 'app', '--no-sign', '--config', 'src-tauri/tauri.editor-performance.conf.json'], source);
    const bundle = path.join(env.CARGO_TARGET_DIR, 'release/bundle/macos', `${productName}.app`), plist = path.join(bundle, 'Contents/Info.plist');
    const value = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
    const binary = path.join(bundle, 'Contents/MacOS', value('CFBundleExecutable'));
    prepared = { schemaVersion: 1, kind: 'apple-editor-performance-renderer-prepared', status: 'built-not-measured',
      owned, source, token, port, identifier, productName, corpusFile, fixtureDir, bundle, binary, buildStartedAtMs,
      sourceProvenance: { commit: git('rev-parse', 'HEAD'), fingerprint: sourceFingerprint, snapshotFiles: snapshotFiles.length,
        includesUntrackedAllowlistedSources: true, stagingModified: false },
      artifact: { bundleName: path.basename(bundle), identifier, version: value('CFBundleShortVersionString'), sha256: hash(readFileSync(binary)), bundleSha256: bundleFingerprint(bundle),
        modifiedAt: statSync(binary).mtime.toISOString(), build: 'packaged-release-production-renderer', signed: false,
        rustcVersion: execFileSync('rustc', ['-vV'], { env, encoding: 'utf8' }).trim(),
        procMacroLinkerWorkaround: { scope: 'host proc-macro crates only; product linker flags unchanged', wrapperSha256: hash(readFileSync(env.RUSTC_WRAPPER)) } },
      environment: environment(), corpus, before, fixtureGenerator: { binarySha256: hash(readFileSync(fixtureBinary)), mode: 'synthetic-corpus-sqlite' } };
    verifyArtifact(prepared); assert.equal(fingerprint(), sourceFingerprint, 'Source changed while preparing the benchmark');
    writeJson(preparedOutput, prepared);
  }
  if (process.argv.includes('--build-only')) {
    console.log(`Verified unsigned Release; no app launched. Resume with --resume=${preparedOutput}`);
  } else {
    assert(!processes().some(row => /\/Drifting[^/]*\.app\/Contents\/MacOS\//.test(row.command)), 'Close other Drifting apps before foreground measurement');
    assert.equal(fingerprint(), prepared.sourceProvenance.fingerprint, 'Source changed before launch');
    const runDir = path.join(prepared.owned, `measurement-${Date.now()}`); mkdirSync(runDir);
    const databaseFile = path.join(runDir, 'drifting-library.db'); cpSync(path.join(prepared.fixtureDir, 'drifting-library.db'), databaseFile);
    const launchRequestedAtMs = Date.now();
    launcher = spawn('/usr/bin/open', ['-n', '-W', prepared.bundle, '--env', `DRIFTING_DB_DIR=${runDir}`,
      '--stdout', path.join(runDir, 'stdout.log'), '--stderr', path.join(runDir, 'stderr.log')], { env, stdio: 'inherit' });
    let launchError; launcher.once('error', error => { launchError = error; });
    const deadline = Date.now() + 10 * 60_000;
    while (!measurement && Date.now() < deadline) {
      assert(!launchError, String(launchError)); assert.equal(launcher.exitCode, null, 'App exited before report');
      const rows = processes(); nativePid ??= rows.find(row => row.command === prepared.binary)?.pid;
      const process = rows.find(row => row.pid === nativePid);
      if (process) processMemory.push({ epochMs: Date.now(), pid: nativePid, rssBytes: process.rssBytes });
      await delay(250);
    }
    assert(measurement, 'No authenticated renderer report; owned logs retained'); assert(nativePid, 'Exact native PID was not observed');
    writeJson(path.join(runDir, 'raw-report.json'), measurement);
    // AppleEvent Quit takes the application's normal ExitRequested/flush path.
    // If scripting is unavailable, the attended user/root can use Cmd+Q instead.
    let quitRequest = 'apple-event';
    try { execFileSync('/usr/bin/osascript', ['-e', `tell application id "${prepared.identifier}" to quit`], { timeout: 15_000, stdio: 'pipe' }); }
    catch { quitRequest = 'attended-menu-required'; console.log(`Use the normal Quit menu or Cmd+Q: ${prepared.productName}`); }
    const quitDeadline = Date.now() + 120_000;
    while (launcher.exitCode === null && Date.now() < quitDeadline) await delay(100);
    assert.equal(launcher.exitCode, 0, 'Normal Quit must complete; no forced termination is accepted');
    assert(!processes().some(row => row.pid === nativePid), 'Native process remains live');
    const database = inspectDatabase(prepared.source, databaseFile, prepared.corpusFile);
    validateMeasurement(measurement, prepared.corpus);
    assert.equal(fingerprint(), prepared.sourceProvenance.fingerprint, 'Source changed during measurement');
    const report = { schemaVersion: 1, kind: 'apple-editor-performance-renderer-host', status: 'passed', generatedAt: new Date().toISOString(),
      source: prepared.sourceProvenance, artifact: prepared.artifact, fixtureGenerator: prepared.fixtureGenerator, environment: environment(), corpus: prepared.corpus,
      launchRequestedAtMs, measurement, summary: summarize(measurement), database,
      processMemory: { scope: 'main Tauri process RSS only; WebKit helper processes and JS heap are separate and not included', intervalMs: 250, samples: processMemory },
      shutdown: { request: quitRequest, launcherExitCode: launcher.exitCode, nativeProcessExited: true, nativeExitCode: null },
      acceptance: { fullP2PerformanceBudgets: 'not-accepted', physicalInputAndIme: 'not-run', coldFilesystem: 'not-controlled', signedRelease: 'not-run' },
      limitations: ['One unsigned packaged Release process on the reported host; no fixed-hardware qualification.',
        'Programmatic product editor transactions and two animation-frame callbacks measure paint opportunity, not physical input-to-photon latency.',
        'Main-process RSS excludes WebKit helpers; compare scopes before using it against a native-process memory measurement.',
        'Warm switch rows are grouped by observed Editor/Y.Doc retention; recreation is not labeled retained-view switching.',
        'LaunchServices supplies wrapper exit status, not the native process exit code. Normal Quit plus independent SQLite/Yjs replay are verified.'] };
    writeJson(output, report); console.log(`Renderer baseline recorded: ${output}`);
  }
} catch (error) {
  writeJson(failureOutput, { schemaVersion: 1, kind: 'apple-editor-performance-renderer-host-failure', status: 'failed',
    generatedAt: new Date().toISOString(), message: String(error), owned: prepared?.owned ?? ownedArtifacts ?? null,
    source: prepared?.sourceProvenance ?? { fingerprint: fingerprint() }, measurement: measurement ?? null,
    shutdown: 'not-accepted', processMemory });
  throw error;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (launcher?.exitCode === null) console.error('Measured app remains live; close it using its normal Quit action. No forced exit was performed.');
  if (prepared) console.log(`Owned artifacts retained: ${prepared.owned}`);
}
