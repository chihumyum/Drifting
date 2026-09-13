import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const agentTranscript = process.argv.includes('--agent-transcript');
const agentHistory = agentTranscript || process.argv.includes('--agent-history');
const mobileAgentPanel = agentHistory || process.argv.includes('--mobile-agent-panel');
const inlineCopilot = mobileAgentPanel || process.argv.includes('--inline-copilot');
const suggestions = inlineCopilot || process.argv.includes('--suggestions');
const contextMenus = suggestions || process.argv.includes('--context-menus');
const selectionMemory = contextMenus || process.argv.includes('--selection');
const markers = selectionMemory || process.argv.includes('--markers');
const outline = markers || process.argv.includes('--outline');
const typewriter = outline || process.argv.includes('--typewriter');
const editorSessions = typewriter || process.argv.includes('--sessions');
const harnessFiles = ['scripts/run-renderer-native.mjs', 'scripts/renderer-native-fixture.ts', 'scripts/renderer-native-db.ts', 'scripts/renderer-native-ui.ts'];
const sourcePaths = ['src', 'src-tauri', 'drizzle', 'packages', 'patches', 'vite-plugins', 'vite.renderer.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'tailwind.config.js', 'postcss.config.js'];
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = git('ls-files', '-z', '--', ...sourcePaths).split('\0').filter(Boolean).sort();
const fingerprint = () => sha256([...new Set([...sourceFiles, ...harnessFiles])].sort().map(file => `${file}\0${sha256(readFileSync(path.join(root, file)))}`).join('\n'));
const output = path.resolve(root, process.argv.find(arg => arg.startsWith('--report='))?.slice(9) ?? `docs/renderer-performance/acceptance/${agentTranscript ? 'f4-transcript-native' : agentHistory ? 'f4-history-native' : mobileAgentPanel ? 'f4-mobile-panel-native' : inlineCopilot ? 'f3-inline-copilot-native' : suggestions ? 'f3-suggestions-native' : contextMenus ? 'f3-context-menus-native' : selectionMemory ? 'f3-selection-native' : markers ? 'f3-markers-native' : outline ? 'f3-outline-native' : typewriter ? 'f3-typewriter-native' : editorSessions ? 'f3-editor-sessions-native' : 'f8-native-composition'}.json`);
function validate(report) {
  assert.equal(report.kind, 'renderer_native_composition'); assert.equal(report.status, 'passed');
  assert.equal(report.runs.length, 2);
  for (const run of report.runs) { assert.equal(run.status, 'passed'); assert.equal(run.exitCode, 0); assert.equal(run.uncaughtErrors, 0); }
  for (const name of ['twentyTabsIdentityAndUndo', 'overlaysPreserveRuntimeAndEditor', 'splitDocumentIdentity', 'closedTabsReleaseLiveDocuments', 'projectSwitchAndSqliteRestore']) assert.equal(report.runs[0].checks[name], true, name);
  assert.equal(report.runs[1].checks.restartProse, true);
  if (editorSessions) {
    for (const name of ['hiddenSessionSavedWithoutOutlinePublish', 'hiddenOutlinePrepared', 'plainProseKeepsOutlineStable', 'closedSessionBindingsReleased']) assert.equal(report.runs[0].checks[name], true, name);
    assert(report.runs[0].sessionEvents.length > 40);
  }
  if (typewriter) {
    for (const name of ['typewriterSingleVisibleOwner', 'hiddenYjsWithoutTypewriterWork', 'typewriterScrollAndPreparation', 'typewriterVisibleSplit', 'typewriterClosedOwnersReleased']) assert.equal(report.runs[0].checks[name], true, name);
    assert(report.runs[0].typewriterObservations.length >= 20);
  }
  if (outline) {
    for (const name of ['outlineSingleVisibleOwner', 'hiddenYjsWithoutOutlineMeasurement', 'outlineNavigationAndHiddenPreparation', 'outlineVisibleSplit', 'outlineClosedOwnersReleased']) assert.equal(report.runs[0].checks[name], true, name);
    assert(report.runs[0].outlineObservations.length >= 20);
  }
  if (markers) {
    for (const name of ['markersEmptyOwnersIdle', 'markersSingleVisibleOwner', 'markersRangeAndLocale', 'markerLocalePreservesEditorAndHistory', 'markersHiddenPreparation', 'markersVisibleSplit', 'markersClosedOwnersReleased']) assert.equal(report.runs[0].checks[name], true, name);
    assert(report.runs[0].markerObservations.length >= 20);
    assert.equal(report.persistence.markerFixtureCommentsRemaining, 0);
  }
  if (selectionMemory) {
    for (const name of ['selectionCaptureBounded', 'selectionRetainedAcrossTabs', 'hiddenSelectionTracksYjs', 'selectionVisibleSplitFocus', 'selectionClosedMemoryPruned', 'selectionProjectRestore', 'selectionProjectRestoreFocus']) assert.equal(report.runs[0].checks[name], true, name);
    assert(report.runs[0].selectionObservations.capture >= 200);
    assert(report.runs[0].selectionObservations.prune >= 20);
  }
  if (contextMenus) {
    for (const name of ['menusRepeatedCloseReleases', 'menusHiddenAndStaleActions', 'menusUnrelatedOwnerCleanup', 'menusFormatAndLocale', 'menusSplitCommandOwnership', 'menusClosedOwnersReleased']) assert.equal(report.runs[0].checks[name], true, name);
    assert(report.runs[0].contextMenuObservations.length >= 20);
  }
  if (suggestions) {
    for (const name of ['suggestionsHiddenAndStaleActions', 'suggestionsCurrentCommands', 'suggestionsUnrelatedOwnerCleanup', 'suggestionsCreateElement', 'suggestionsSplitCommandOwnership', 'suggestionsClosedOwnersReleased']) assert.equal(report.runs[0].checks[name], true, name);
    assert.equal(report.runs[1].checks.suggestionCreatedElementRestored, true);
    assert.equal(report.runs[0].createdSuggestionElementId, report.runs[1].createdSuggestionElementId);
    assert.match(report.runs[0].createdSuggestionElementId, /^[a-f0-9-]{36}$/);
    assert.equal(report.persistence.createdSuggestionElements, 1);
    assert(report.runs[0].suggestionObservations.length >= 40);
  }
  if (inlineCopilot) {
    for (const name of ['inlineCopilotLifetime', 'inlineCopilotCommandGates', 'inlineCopilotUnrelatedCleanup', 'inlineCopilotSplitOwnership', 'inlineCopilotClosedOwnersReleased', 'inlineCopilotSpanConflict', 'inlineCopilotHistory', 'inlineCopilotBlockConflict']) assert.equal(report.runs[0].checks[name], true, name);
    assert.equal(report.runs[1].checks.inlineCopilotTransientAfterRestart, true);
  }
  if (mobileAgentPanel) {
    assert.equal(report.runs[0].checks.mobileAgentPanel, true);
    const panel = report.runs[0].mobileAgentPanel;
    assert.equal(panel.verifyRenders, false);
    assert.equal(panel.checks.length, 44);
    assert.deepEqual(panel.measurements.map(item => item.mode), ['sidebar', 'paper']);
    for (const item of panel.measurements) {
      assert.equal(item.streaming, null); assert.equal(item.drafting, null); assert.equal(item.background, null); assert.equal(item.messageRows, null);
      assert.equal(item.lateFeedbackCrossedSession, false); assert.equal(item.lateNavigation, 0); assert.equal(item.duplicateWrites, 1); assert.equal(item.cycles, 100);
    }
  }
  if (agentTranscript) {
    for (const [index, run] of report.runs.entries()) {
      assert.equal(run.checks.agentTranscript, true);
      assert.equal(run.agentTranscript.restart, index === 1);
      assert.equal(run.agentTranscript.messageCount, 3);
      assert.equal(Object.keys(run.agentTranscript.checks).length, index === 0 ? 8 : 4);
      assert(Object.values(run.agentTranscript.checks).every(value => value === true));
    }
  }
  if (agentHistory) {
    assert.equal(report.runs[0].checks.agentHistory, true);
    const history = report.runs[0].agentHistory;
    assert.equal(history.implementation, 'stable-message-blocks'); assert.equal(history.measure, false);
    assert.deepEqual(history.measurements.map(item => [item.surface, item.historyMessages]), [['desktop', 300], ['desktop', 3000], ['mobile', 300], ['mobile', 3000]]);
    for (const item of history.measurements) {
      assert.match(item.fixtureHash, /^[0-9a-f]{64}$/); assert.equal(item.displayUpdates, 20);
      assert.equal(item.rowElements, null); assert.equal(item.updateMs, null); assert.equal(item.medianMs, null); assert.equal(item.p95Ms, null);
      assert.deepEqual(item.checks.map(check => check.id), ['all-history-stays-mounted', 'historical-dom-and-selection-retained', 'tool-detail-dom-and-expansion-retained', 'latest-text-complete']);
      assert(item.checks.every(check => check.passed === true));
    }
  }
  assert.deepEqual(report.runs[0].lifecycle, [
    { projectId: 'native-control-a', mounted: true }, { projectId: 'native-control-a', mounted: false },
    { projectId: 'native-control-b', mounted: true }, { projectId: 'native-control-b', mounted: false },
    { projectId: 'native-control-a', mounted: true },
  ]);
  assert.equal(report.persistence.savedChapters, 1);
  assert.equal(report.persistence.unchangedChapters, 52);
  assert.equal(report.fixture.reproducible, true);
  assert.equal(report.acceptance.physicalIme, 'not-run'); assert.equal(report.acceptance.performanceBudget, 'not-evaluated');
  assert.match(report.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(report).includes(root), 'Report contains a personal path');
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Native evidence is stale');
  console.log('Native composition evidence passed; physical IME and performance budgets remain open.');
  process.exit(0);
}
assert.equal(process.platform, 'darwin', 'Native composition currently requires macOS');
assert.equal(git('ls-files', '--others', '--exclude-standard', '--', ...sourcePaths), '', 'Untracked product source must be accounted for before snapshotting');
const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'drifting-native-acceptance-')));
const source = path.join(temporary, 'source');
const runId = randomBytes(6).toString('hex');
const identifier = `cc.drifting.client.acceptance.r${runId}`;
const token = randomBytes(32).toString('hex');
const productName = `Drifting Acceptance ${runId}`;
const localOutput = path.join(root, '.local-data/renderer-performance');
mkdirSync(localOutput, { recursive: true });
console.log(`Owned native acceptance workspace: ${temporary}`);
// Inherit only toolchain essentials; never load the author's .env.local.
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'DEVELOPER_DIR', 'SDKROOT', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000', CARGO_TARGET_DIR: path.join(root, 'src-tauri/target') });
const run = (command, args, cwd = source) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
let worktree = false; let native; let server; let completed = false;
const reports = []; const observations = [];
try {
  const processes = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
  assert(!processes.split('\n').some(line => /\/Drifting[^/]*\.app\/Contents\/MacOS\//.test(line)), 'Close the existing Drifting app before native acceptance');
  const oldBundle = path.join(root, 'src-tauri/target/debug/bundle/macos/Drifting.app');
  if (existsSync(oldBundle)) {
    const backup = path.join(localOutput, `old-debug-${runId}.app`);
    renameSync(oldBundle, backup); console.log(`Old Debug artifact moved aside: ${backup}`);
  }
  const commit = git('rev-parse', 'HEAD');
  const sourceFingerprint = fingerprint();
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', source, commit], { stdio: 'pipe' }); worktree = true;
  const patch = execFileSync('git', ['-C', root, 'diff', '--binary', 'HEAD', '--', ...sourcePaths]);
  if (patch.length) execFileSync('git', ['-C', source, 'apply', '-'], { input: patch });
  symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  for (const file of harnessFiles) cpSync(path.join(root, file), path.join(source, file));
  const fixtureDir = path.join(temporary, 'fixture');
  const secondFixtureDir = path.join(temporary, 'fixture-reproduction');
  await run(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/renderer-native-fixture.ts', fixtureDir]);
  await run(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/renderer-native-fixture.ts', secondFixtureDir]);
  const fixture = JSON.parse(readFileSync(path.join(fixtureDir, 'fixture.json'), 'utf8'));
  const reproduced = JSON.parse(readFileSync(path.join(secondFixtureDir, 'fixture.json'), 'utf8'));
  assert.deepEqual(reproduced, fixture, 'Independent synthetic fixtures must have identical semantic manifests');
  const inspect = file => JSON.parse(execFileSync(process.execPath, ['--conditions=import', '--import=tsx', '--input-type=module', '-e', 'const mod = await import("./scripts/renderer-native-db.ts"); const inspect = mod.inspectNativeFixture ?? mod.default.inspectNativeFixture; console.log(JSON.stringify(inspect(process.argv[1])))', file], { cwd: source, env, encoding: 'utf8' }));
  const databaseFile = path.join(fixtureDir, 'drifting-library.db');
  const before = inspect(databaseFile);
  let currentResult;
  server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'].includes(origin)) { response.writeHead(403).end(); return; }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.url !== '/report') { response.writeHead(404).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    let body = '';
    try {
      for await (const chunk of request) { body += chunk; assert(body.length <= 65536, 'Oversized report'); }
      const result = JSON.parse(body);
      assert(['progress', 'observation', 'result'].includes(result.kind));
      if (result.kind === 'result') currentResult = result;
      else if (result.kind === 'observation') observations.push(result);
      console.log(`Native ${result.phase}: ${result.step} (${result.kind}${result.status ? `: ${result.status}` : ''})`);
      if (result.status === 'failed') console.error(JSON.stringify(result));
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/report`;
  const securityFile = path.join(source, 'src-tauri/src/secure_storage.rs');
  const security = readFileSync(securityFile, 'utf8');
  const keychainAnchor = 'const KEYCHAIN_SERVICE: &str = "Drifting";';
  assert.equal(security.split(keychainAnchor).length, 2, 'Native credential isolation anchor drifted');
  writeFileSync(securityFile, security.replace(keychainAnchor, `const KEYCHAIN_SERVICE: &str = "Drifting.RendererAcceptance.${runId}";`));
  const baseConfig = JSON.parse(readFileSync(path.join(source, 'src-tauri/tauri.conf.json'), 'utf8'));
  const config = { productName, identifier,
    build: { beforeBuildCommand: 'pnpm exec vite build --config vite.renderer-native.config.ts' },
    app: { security: { csp: baseConfig.app.security.csp.replace("connect-src 'self'", `connect-src 'self' http://127.0.0.1:${server.address().port}`) } },
    bundle: { createUpdaterArtifacts: false },
    plugins: { 'deep-link': { desktop: { schemes: [`drifting-acceptance-${runId}`] } } },
  };
  writeFileSync(path.join(source, 'src-tauri/tauri.acceptance.conf.json'), JSON.stringify(config));
  writeFileSync(path.join(source, 'vite.renderer-native.config.ts'), `
import { mergeConfig } from 'vite';
import base from './vite.renderer.config';
export default (env) => mergeConfig(base(env), {
  define: { __DRIFTING_NATIVE_ACCEPTANCE__: ${JSON.stringify(JSON.stringify({ endpoint, token, projects: fixture.projects, editorSessions, typewriter, outline, markers, selectionMemory, contextMenus, suggestions, inlineCopilot, mobileAgentPanel, agentHistory, agentTranscript }))} },
  plugins: [{ name: 'native-acceptance-only', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/src/renderer/main.tsx')) return 'import "../../scripts/renderer-native-ui";\\n' + code;
    if (${mobileAgentPanel} && id.endsWith('/workspace/MobileAgentTranscript.tsx')) {
      for (const service of ['useBookNode', 'useComment']) {
        const from = "'../../../usecase/" + service + "'";
        if (code.split(from).length !== 2) throw new Error('Mobile Agent write isolation anchor drifted: ' + service);
        code = code.replace(from, "'../../../performance/mobile-agent-output-services'");
      }
      return code;
    }
    if (${editorSessions} && id.endsWith('/features/editor/entity-editor-session.ts')) {
      for (const [anchor, event] of [
        ['this.attached = true;', 'attach'],
        ['this.attached = false;', 'detach'],
        ['this.snapshot = { outline: this.derivedOutline, ready: true };', 'outline'],
        ['this.options.onPersist(this.editor, derived);', 'persist'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Editor session observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceSessionEvent(this, ' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (${typewriter} && id.endsWith('/features/editor/typewriter-scroll.ts')) {
      for (const [anchor, event] of [
        ['this.listening = true;', 'resume'],
        ['this.listening = false;', 'pause'],
        ['const height = this.viewport.clientHeight;', 'tail'],
        ['const caret = this.editor.view.coordsAtPos(this.editor.state.selection.head);', 'align'],
        ['this.alignmentFrame = requestAnimationFrame(this.alignCaret);', 'frame'],
        ['this.attached = false;', 'dispose'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Typewriter observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceTypewriterEvent(this, ' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (${outline} && id.endsWith('/components/editor/outline-viewport.ts')) {
      for (const [anchor, event] of [
        ['this.listening = true;', 'resume'],
        ['this.listening = false;', 'pause'],
        ['const previous = this.snapshot;', 'measure'],
        ['rect = anchor.getBoundingClientRect();', 'anchor'],
        ['this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });', 'frame'],
        ['this.attached = false;', 'dispose'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Outline observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceOutlineEvent(this, ' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (${markers} && id.endsWith('/components/editor/scroll-marker-viewport.ts')) {
      for (const [anchor, event] of [
        ['this.attached = true;', 'attach'],
        ['this.listening = true;', 'resume'],
        ['this.listening = false;', 'pause'],
        ['const rootTop = this.root.getBoundingClientRect().top;', 'measure'],
        ['const top = first.getBoundingClientRect().top;', 'anchor'],
        ['this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });', 'frame'],
        ['this.attached = false;', 'dispose'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Marker observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceMarkerEvent(this, ' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (${selectionMemory} && id.endsWith('/lib/editor-selection-memory.ts')) {
      for (const [anchor, event] of [
        ['const { anchor, head } = editor.state.selection;', 'capture'],
        ['selections.set(key, next);', 'write'],
        ['selections.delete(key);', 'prune'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Selection observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceSelectionEvent(' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (${contextMenus} && id.endsWith('/features/editor/editor-context-menu.ts')) {
      for (const [anchor, event] of [
        ['this.menu = menu; activeMenuSlot.owner = this;', 'open'],
        ['this.menu.remove(); this.menu = null;', 'close'],
        ["this.editor.on('destroy', this.close);", 'bind'],
        ["this.editor.off('destroy', this.close);", 'unbind'],
        ['this.disposed = true; this.enabled = false; this.close();', 'dispose'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Context menu observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceContextMenuEvent(this, ' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (${suggestions} && id.endsWith('/lib/editor-suggestion-interaction.ts')) {
      for (const [anchor, event] of [
        ["view.dom.addEventListener('blur', invalidate);", 'attach'],
        ["view.dom.removeEventListener('blur', invalidate);", 'detach'],
      ]) {
        if (code.split(anchor).length !== 2) throw new Error('Suggestion observation anchor drifted: ' + event);
        code = code.replace(anchor, anchor + '\\nglobalThis.__nativeAcceptanceSuggestionEvent(plugin, editor, pluginKey.key, ' + JSON.stringify(event) + ');');
      }
      return code;
    }
    if (id.endsWith('/app/providers/ProjectRuntimeProvider.tsx')) {
      const anchor = 'const bootKey = \u0060\u0024{userId}:\u0024{projectId}\u0060;';
      if (code.split(anchor).length !== 2) throw new Error('Project runtime instrumentation anchor drifted');
      return code.replace(anchor, anchor + '\\nuseEffect(() => { globalThis.__nativeAcceptanceRuntime(projectId, true); return () => globalThis.__nativeAcceptanceRuntime(projectId, false); }, [projectId]);');
    }
  } }],
});
`);
  const buildStarted = Date.now();
  await run('pnpm', ['exec', 'tauri', 'build', '--debug', '--bundles', 'app', '--no-sign', '--config', 'src-tauri/tauri.acceptance.conf.json']);
  const bundle = path.join(env.CARGO_TARGET_DIR, 'debug/bundle/macos', `${productName}.app`);
  const plist = path.join(bundle, 'Contents/Info.plist');
  const plistValue = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  assert.equal(plistValue('CFBundleIdentifier'), identifier);
  const binary = path.join(bundle, 'Contents/MacOS', plistValue('CFBundleExecutable'));
  assert(statSync(binary).mtimeMs >= buildStarted, 'Refusing an old native binary');
  const artifact = { bundleName: path.basename(bundle), identifier, version: plistValue('CFBundleShortVersionString'), sha256: sha256(readFileSync(binary)), modifiedAt: statSync(binary).mtime.toISOString(), build: 'packaged-debug-native-production-renderer', signed: false,
    instrumentation: ['acceptance-only renderer import', 'ProjectRuntimeProvider lifecycle effect', 'isolated native keychain service', 'isolated app identifier and deep-link scheme', 'loopback report CSP'] };
  if (editorSessions) artifact.instrumentation.push('editor session attach/detach/persist/outline observations');
  if (typewriter) artifact.instrumentation.push('typewriter resume/pause/measure/frame/dispose counts');
  if (outline) artifact.instrumentation.push('outline viewport resume/pause/measure/anchor/frame/dispose counts');
  if (markers) artifact.instrumentation.push('scroll marker attach/resume/pause/measure/anchor/frame/dispose counts');
  if (selectionMemory) artifact.instrumentation.push('selection capture/write/prune counts');
  if (contextMenus) artifact.instrumentation.push('context-menu open/close and owner subscription lifecycle counts');
  if (suggestions) artifact.instrumentation.push('suggestion plugin-view attach/detach lifecycle counts');
  if (agentHistory) artifact.instrumentation.push('desktop/mobile transcript history retention with 300 and 3000 rows; timing and render counters not instrumented');
  if (mobileAgentPanel) artifact.instrumentation.push('mobile Agent components with synthetic auth, journal and deferred local-write ports; renderer counters not instrumented');
  console.log(`Verified fresh artifact: ${binary} (${artifact.sha256})`);
  console.log('Keep the acceptance window visible and foreground in each process; occluded WebKit animation frames may be suspended.');
  for (const phase of ['composition', 'restart']) {
    currentResult = null;
    const launched = Date.now(); let exited = false; let exitCode; let maxRssKiB = 0;
    native = spawn(binary, [], { cwd: temporary, env: { ...env, DRIFTING_DB_DIR: fixtureDir }, stdio: 'inherit' });
    const nativeError = new Promise((_, reject) => native.once('error', reject));
    native.once('exit', code => { exited = true; exitCode = code; });
    await Promise.race([nativeError, (async () => {
      while (!currentResult && !exited && Date.now() - launched < 240000) {
        try { maxRssKiB = Math.max(maxRssKiB, Number(execFileSync('ps', ['-o', 'rss=', '-p', String(native.pid)], { encoding: 'utf8' }).trim())); } catch { /* Process exit is checked below. */ }
        await delay(250);
      }
    })()]);
    assert(currentResult, `Native ${phase} produced no final report; exited=${exited}, code=${exitCode}`);
    assert.equal(currentResult.status, 'passed', JSON.stringify(currentResult));
    assert.equal(currentResult.phase, phase);
    const launchToResultMs = Date.now() - launched;
    // An attended native run uses the real Quit menu/shortcut. This exercises
    // ExitRequested (code=None) and the production shutdown coordinator; an
    // app.exit(0) test command would bypass that persistence path.
    console.log(`Awaiting native Quit: ${productName}. Use its Quit menu or Cmd+Q now.`);
    const quitStarted = Date.now();
    while (!exited && Date.now() - quitStarted < 120000) await delay(100);
    assert(exited && exitCode === 0, 'Native quit must complete its real persistence shutdown and exit');
    native = null;
    reports.push({ ...currentResult, exitCode, shutdown: 'attended native Quit command', launchToResultMs, nativeProcessPeakRssKiB: maxRssKiB, rssIncludesWebKitChildren: false });
  }
  const after = inspect(databaseFile);
  const changed = after.chapters.filter((chapter, index) => chapter.sha256 !== before.chapters[index].sha256);
  assert.equal(changed.length, 1); assert.equal(changed[0].id, fixture.projects[0].nodeIds[0]);
  assert.equal(changed[0].hasSavedMarker, true); assert.equal(changed[0].characters, 5000 + ' NATIVE_ACCEPTANCE_SAVED'.length);
  if (markers) { assert.equal(before.comments, 0); assert.equal(after.comments, 0); }
  assert.equal(after.elements, before.elements + (suggestions ? 1 : 0)); assert.equal(after.relations, before.relations);
  assert.equal(fingerprint(), sourceFingerprint, 'Source changed while native acceptance was running');
  const report = { kind: 'renderer_native_composition', status: 'passed', generatedAt: new Date().toISOString(),
    source: { commit, fingerprint: sourceFingerprint, trackedProductChanges: patch.length > 0 }, artifact,
    environment: { platform: os.platform(), architecture: os.arch(), osRelease: os.release(), cpu: os.cpus()[0].model, totalMemoryBytes: os.totalmem() },
    fixture: { specification: fixture.specification, semanticSha256: fixture.semanticSha256, reproducible: true },
    runs: reports, observations, persistence: { ...(suggestions ? { createdSuggestionElements: after.elements - before.elements } : {}), ...(markers ? { markerFixtureCommentsRemaining: after.comments } : {}), savedChapters: changed.length, unchangedChapters: after.chapters.length - changed.length, integrityCheck: 'ok', foreignKeyCheck: 'ok' },
    acceptance: { fullAppComposition: 'passed', sqliteYjsRestart: 'passed', input: 'synthetic Tiptap commands; product navigation actions and DOM clicks', physicalIme: 'not-run', physicalGestures: 'not-run', performanceBudget: 'not-evaluated', reactCommits: 'not-measured', jsHeap: 'unavailable', memoryReclamation: 'not-measured', deviceMatrix: 'not-run' },
  };
  validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); completed = true;
  console.log(`Native composition report: ${output}`);
} finally {
  if (native?.pid) { native.kill('SIGTERM'); await delay(1000); if (native.exitCode === null) native.kill('SIGKILL'); }
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (worktree) execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', source], { stdio: 'pipe' });
  // Retain failed synthetic artifacts/log context for diagnosis. No personal data.
  if (completed) rmSync(temporary, { recursive: true, force: true });
  else console.error(`Failed acceptance artifacts retained in ${temporary}`);
}
