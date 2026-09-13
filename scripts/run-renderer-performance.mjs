import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { rendererFingerprintVersion, rendererSourceFingerprint } from './renderer-performance-source.mjs';
import { deferredEntryPlugin } from '../vite-plugins/deferred-entry.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? '.local-data/renderer-performance/latest.json';
const assertInputBudget = process.argv.includes('--assert-input-budget');
const ci = process.argv.includes('--ci');
if (ci && assertInputBudget) throw new Error('CI checks deterministic contracts; run device timing budgets separately');
const chrome = process.env.DRIFTING_PERF_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);
if (!chrome || !existsSync(chrome)) throw new Error('Set DRIFTING_PERF_CHROME to an installed Chromium executable');
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-renderer-perf-'));
const profile = path.join(temporary, 'profile');
const outDir = path.join(temporary, 'dist');
const fingerprint = () => rendererSourceFingerprint(root);
const sourceFingerprint = fingerprint();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let browser;
let server;
let client;
let reportWritten = false;
try {
  await build({
    root, configFile: false, envDir: false, logLevel: 'warn',
    plugins: [{
      name: 'isolated-inline-copilot-services', enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/lib/extensions/entity-link.ts')) {
          const anchors = [
            ['function computeDanglingDecorations(doc: PMNode): DecorationSet {', 'entityLinkPresentationWork.danglingScans++;'],
            ['  doc.descendants((node, pos) => {', 'entityLinkPresentationWork.textNodes += node.isText ? 1 : 0;'],
            ['  const links = root.querySelectorAll<HTMLElement>(', 'entityLinkPresentationWork.colorScans++;'],
          ];
          for (const [anchor, counter] of anchors) {
            if (code.split(anchor).length !== 2) throw new Error(`Entity link presentation instrumentation drifted: ${anchor}`);
            code = anchor.startsWith('  const links') ? code.replace(anchor, counter + '\n' + anchor) : code.replace(anchor, anchor + ' ' + counter);
          }
          return { code: `import { entityLinkPresentationWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/lib/retroactive-entity-links.ts')) {
          const anchors = [
            ['  const names = Array.from(new Set(target.names.map((n) => n.trim()).filter(Boolean)));', 'calls'],
            ['    const alreadyLinked = node.marks.some(', 'textNodes'],
          ];
          for (const [anchor, counter] of anchors) {
            if (code.split(anchor).length !== 2) throw new Error(`Retroactive link instrumentation drifted: ${anchor}`);
            code = code.replace(anchor, `retroactiveLinkWork.${counter}++;\n` + anchor);
          }
          return { code: `import { retroactiveLinkWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/DesktopStoryGraphView.tsx') || id.endsWith('/DesktopSuperElementView.tsx')) {
          const anchors = id.endsWith('/DesktopStoryGraphView.tsx') ? [
            ['export function DesktopStoryGraphView({ graphUi, driftPanel }: GraphViewProps) {', 'graphDriftWork.storyShell++;'],
          ] : [
            ['export function DesktopSuperElementView({ graphUi, driftPanel }: GraphViewProps) {', 'graphDriftWork.elementShell++;'],
          ];
          for (const [anchor, counter] of anchors) {
            if (code.split(anchor).length !== 2) throw new Error(`Graph drift instrumentation drifted: ${anchor}`);
            code = code.replace(anchor, anchor + ' ' + counter);
          }
          return { code: `import { graphDriftWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/StoryGraphUnplacedChapters.tsx')) {
          const anchor = 'nodes.map((node) => {';
          if (code.split(anchor).length !== 2) throw new Error('Unplaced chapter instrumentation drifted');
          return { code: `import { storyGraphUnplacedWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n`
            + code.replace(anchor, anchor + ' storyGraphUnplacedWork.chips++;'), map: null };
        }
        if (id.endsWith('/StoryGraphDriftCards.tsx') || id.endsWith('/SuperElementDriftCards.tsx')) {
          const anchors = id.endsWith('/StoryGraphDriftCards.tsx') ? [
            ['}: DriftCardProps) {', 'storyCards'], ['nodes.map((node, index) => {', 'storyWrappers'],
          ] : [['nodes.map((node) => {', 'elementCards']];
          for (const [anchor, counter] of anchors) {
            if (code.split(anchor).length !== 2) throw new Error(`Drift card instrumentation drifted: ${anchor}`);
            code = code.replace(anchor, anchor + ` graphDriftWork.${counter}++;`);
          }
          return { code: `import { graphDriftWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/StoryGraphLaneRow.tsx') || id.endsWith('/story-graph-layout.ts')) {
          const anchors = id.endsWith('/StoryGraphLaneRow.tsx')
            ? [['}: StoryGraphLaneRowProps) {', 'lanes'], ['const status = node.writingStatus;', 'tiles']]
            : [['for (const node of nodes) {', 'groupingVisits']];
          for (const [anchor, counter] of anchors) {
            if (code.split(anchor).length !== 2) throw new Error(`Story Graph instrumentation drifted: ${anchor}`);
            code = code.replace(anchor, anchor + ` storyGraphCardWork.${counter}++;`);
          }
          return { code: `import { storyGraphCardWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/SuperElementCategoryBox.tsx') || id.endsWith('/SuperElementChapterBand.tsx')) {
          const anchors = id.endsWith('/SuperElementCategoryBox.tsx')
            ? [['}: CategoryBoxProps) {', 'categories'], ['const isLinkSource = linkSourceElementId === element.id;', 'elements']]
            : [['}: ChapterBandProps) {', 'bands']];
          for (const [anchor, counter] of anchors) {
            if (code.split(anchor).length !== 2) throw new Error(`Super Element card instrumentation drifted: ${anchor}`);
            code = code.replace(anchor, anchor + ` superElementCardWork.${counter}++;`);
          }
          return { code: `import { superElementCardWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/runtime/recovery.ts') || id.endsWith('/runtime/recovered-transcript.ts')) {
          const replacements = id.endsWith('/runtime/recovery.ts') ? [
            ['const turnRows = messagesByTurn.get(row.turnId) ?? [];', 'agentRecoveryWork.groupedMessageVisits++; const turnRows = messagesByTurn.get(row.turnId) ?? [];'],
            ['messageById.get(turn.promptMessageId)', '(agentRecoveryWork.promptMessageVisits++, messageById.get(turn.promptMessageId))'],
          ] : [
            ['recoveredTurnById.get(turn.id)', '(agentRecoveryWork.recoveredTurnVisits++, recoveredTurnById.get(turn.id))'],
            ['const visible = visibleUsers[index]!;', 'agentRecoveryWork.visibleUserCandidates++; const visible = visibleUsers[index]!;'],
          ];
          for (const [anchor, replacement] of replacements) {
            if (code.split(anchor).length !== 2) throw new Error(`Recovery instrumentation drifted: ${anchor}`);
            code = code.replace(anchor, replacement);
          }
          return { code: `import { agentRecoveryWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/domain/agent-chat-transcript.ts') || id.endsWith('/runtime/chat-journal-projection.ts')) {
          const tree = id.endsWith('/domain/agent-chat-transcript.ts');
          const anchor = tree ? '  const copy = tree.slice();' : 'const copy = list.slice();';
          if (code.split(anchor).length !== 2) throw new Error('Transcript allocation instrumentation drifted');
          code = code.replace(anchor, anchor + (tree ? ' agentTranscriptWork.copiedTreeNodes++; agentTranscriptWork.copiedTreeSlots += tree.length;' : ' agentTranscriptWork.copiedArraySlots += list.length;'));
          if (tree) {
            const flatten = '    if (this.cached) return this.cached;';
            if (code.split(flatten).length !== 2) throw new Error('Transcript materialization instrumentation drifted');
            code = code.replace(flatten, flatten + '\n    agentTranscriptWork.flatMaterializations++; agentTranscriptWork.flattenedMessages += this.length;');
          } else {
            code = code.replace('append: (list, ...messages) => [...list, ...messages],', 'append: (list, ...messages) => (agentTranscriptWork.copiedArraySlots += list.length, [...list, ...messages]),');
          }
          return { code: `import { agentTranscriptWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        if (id.endsWith('/DesktopAgentTranscript.tsx') || id.endsWith('/MobileAgentTranscript.tsx')) {
          const rowTag = id.endsWith('/DesktopAgentTranscript.tsx') ? '<MessageView key={i}' : '<MobileAgentMessage key={index}';
          if (!code.includes(rowTag)) throw new Error(`Missing history row creation point: ${id}`);
          code = `import { agentHistoryWork } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code.replace(rowTag, rowTag + ' {...(agentHistoryWork.rowElements++, {})}');
        }
        if (id.endsWith('/workspace/MobileAgentPanel.tsx') || id.endsWith('/workspace/MobileAgentTranscript.tsx')) {
          for (const service of ['useBookNode', 'useComment']) {
            code = code.replace(`'../../../usecase/${service}'`, "'../../../performance/mobile-agent-output-services'");
          }
          const anchor = '  const { t } = useTranslation();';
          // The original panel has a ContextChips helper with the same hook;
          // instrument the hook after the exported component signature only.
          const entry = code.indexOf(id.endsWith('MobileAgentPanel.tsx') ? 'function MobileAgentPanel(' : 'function MobileAgentTranscript(');
          const at = code.indexOf(anchor, entry);
          if (at < 0) throw new Error(`Missing mobile Agent render point: ${id}`);
          code = code.slice(0, at) + code.slice(at).replace(anchor, `${anchor}\n  agentPanelRenders.${id.endsWith('MobileAgentPanel.tsx') ? 'panel' : 'transcript'}++;`);
          if (id.endsWith('MobileAgentTranscript.tsx')) {
            const row = code.indexOf('function MobileAgentMessage(');
            const hook = code.indexOf(anchor, row);
            if (row < 0 || hook < 0) throw new Error('Missing mobile Agent message render point');
            code = code.slice(0, hook) + code.slice(hook).replace(anchor, `${anchor}\n  agentMobileRows.renders++;`);
          }
          return { code: `import { agentPanelRenders, agentMobileRows } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n` + code, map: null };
        }
        const counter = id.endsWith('/desktop/DesktopAgentPanel.tsx') ? ['panel', '  const { t } = useTranslation();']
          : id.endsWith('/agent/AgentComposerConfig.tsx') ? ['composer', '  const { t } = useTranslation();']
          : id.endsWith('/agent/AgentMessageViews.tsx') ? ['message', 'export const MessageView = memo(function MessageView({ msg }: { msg: ChatMsg }) {']
          : id.endsWith('/desktop/DesktopAgentTranscript.tsx') ? ['transcript', '  const { t } = useTranslation();'] : null;
        if (counter) {
          if (code.split(counter[1]).length !== 2) throw new Error(`Expected one render instrumentation point: ${id}`);
          return { code: `import { agentPanelRenders } from ${JSON.stringify(path.join(root, 'src/renderer/performance/agent-panel-counters'))};\n`
            + code.replace(counter[1], `${counter[1]}\n  agentPanelRenders.${counter[0]}++;`), map: null };
        }
        if (id.endsWith('/hooks/useCopilot.ts')) {
          for (const service of ['../usecase/useComment', '../lib/copilot/base-block-context', '../lib/copilot/produce-block-section-summary']) {
            const source = `'${service}'`;
            if (code.split(source).length !== 2) throw new Error(`Expected one Copilot run service import: ${service}`);
            code = code.replace(source, "'../performance/copilot-run-services'");
          }
          return { code, map: null };
        }
        if (!id.endsWith('/components/copilot/CopilotInlinePopover.tsx')) return null;
        for (const service of ['inline-edit', 'inline-ask', 'reverse-chapter-summary']) {
          const source = `'../../lib/copilot/${service}'`;
          if (code.split(source).length !== 2) throw new Error(`Expected one popover service import: ${service}`);
          code = code.replace(source, "'../../performance/copilot-inline-services'");
        }
        return { code, map: null };
      },
    }, react(), ...[
      ['virtual:memo-material', 'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx', 'memo-material', 'loadMemoMaterial', 'view-attempt'],
      ['virtual:graph-ui', 'src/renderer/features/graph/graph-ui-components.ts', 'graph-ui', 'loadGraphUi'],
      ['virtual:story-graph', 'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx', 'story-graph', 'loadStoryGraph'],
      ['virtual:element-graph', 'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx', 'element-graph', 'loadElementGraph'],
    ].map(([id, entry, name, exportName, attemptParam = 'graph-attempt']) => deferredEntryPlugin({ id, entry, name, exportName, attemptParam }))],
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-performance.html') } },
  });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
  browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  let launchError;
  browser.on('error', (error) => { launchError = error; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 200 && !existsSync(portFile); attempt++) {
    if (launchError || browser.exitCode !== null) throw new Error('Isolated Chromium did not start');
    await delay(100);
  }
  if (!existsSync(portFile)) throw new Error('Chromium debugging endpoint timed out');
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const target = await CDP.New({ port });
  client = await CDP({ port, target });
  await client.Page.enable();
  await client.Runtime.enable();
  const pageErrors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) => pageErrors.push(exceptionDetails.text));
  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url: `${server.resolvedUrls.local[0]}scripts/renderer-performance.html` });
  await loaded;
  // DOM focus/blur lifecycle tests require the isolated target to be active.
  await client.Page.bringToFront();
  const result = await client.Runtime.evaluate({
    expression: 'window.__DRIFTING_PERFORMANCE_HARNESS__.run()', awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails || pageErrors.length) throw new Error(`Harness failed: ${JSON.stringify(result.exceptionDetails ?? pageErrors)}`);
  if (sourceFingerprint !== fingerprint()) throw new Error('Source changed during measurement; discard this run');
  const report = {
    schemaVersion: 1, kind: 'renderer_performance_run', generatedAt: new Date().toISOString(),
    status: 'measured', source: {
      commit: sourceCommit, rendererFingerprint: sourceFingerprint,
      fingerprintVersion: rendererFingerprintVersion,
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
      build: 'vite-production-isolated-harness',
    },
    ...result.result.value,
    environment: { ...result.result.value.environment, platform: platform(), release: release(), cpu: cpus()[0]?.model,
      memoryBytes: totalmem(), node: process.version, browser: await client.Browser.getVersion(),
      runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null },
    validationMode: ci ? 'deterministic-ci' : 'measurement',
    limitations: [
      'Synthetic ProseMirror transactions in isolated headless Chromium; not native input, IME, or app-wide acceptance.',
      'Animation-frame callback is not a compositor paint measurement.',
      'Timing includes harness wrappers with counters disabled; compare only equivalent environments and fixtures.',
      'Desktop and mobile Agent components use synthetic auth/journal and deferred write ports; real Agent persistence, full-app startup, multi-tab memory, native and physical-device acceptance: NOT RUN.',
    ],
  };
  if (assertInputBudget) {
    report.budgetChecks = report.scenarios.flatMap((scenario) => [
      { id: `${scenario.id}:input-locality`, passed: Object.values(scenario.counts).every((count) => count === 0) },
      { id: `${scenario.id}:transaction-p95`, passed: scenario.transactionMs.p95 <= (scenario.fixture.characters > 20_000 ? 5 : 2) },
    ]);
    if (report.budgetChecks.some((check) => !check.passed)) {
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  reportWritten = true;
  if (ci) execFileSync(process.execPath, [path.join(root, 'scripts/check-renderer-performance.mjs'),
    '--deterministic', '--current', `--report=${path.resolve(output)}`], { stdio: 'inherit' });
  console.log(JSON.stringify({ output, source: report.source, status: report.status, behaviorChecks: report.behaviorChecks, budgetChecks: report.budgetChecks, scenarios: report.scenarios.map(({ id, counts, transactionMs }) => ({ id, counts, transactionP95Ms: transactionMs.p95 })) }, null, 2));
} catch (error) {
  if (!reportWritten) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify({ kind: 'renderer_performance_failure', status: 'failed',
      generatedAt: new Date().toISOString(), source: { commit: sourceCommit, rendererFingerprint: sourceFingerprint,
        fingerprintVersion: rendererFingerprintVersion }, error: String(error) }, null, 2)}\n`);
  }
  throw error;
} finally {
  if (client) await client.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    for (let attempt = 0; attempt < 30 && browser.exitCode === null; attempt++) await delay(100);
    if (browser.exitCode === null) {
      browser.kill('SIGKILL');
      await new Promise((resolve) => browser.once('exit', resolve));
    }
  }
  if (server) await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  rmSync(temporary, { recursive: true, force: true });
}
