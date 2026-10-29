#!/usr/bin/env node
/**
 * Heavy-seed interaction baseline for the macOS desktop app.
 *
 *   pnpm perf:stress [--release] [--foreground] [--wait-idle <seconds>] [--inject-css <file>]
 *                    [--instance <name>] [--label <name>]
 *   pnpm perf:stress --compare <a.json> <b.json>
 *
 * Launches an isolated, synthetic stress-seed instance (a Debug development
 * build, or with --release a Rust release binary and production renderer from
 * `dev:worktree --release-perf`), drives scripts/perf-stress-journeys.js
 * through the frontend debug bridge, samples CPU and RSS of the app's native and
 * WebContent processes around every journey, quits through the app's Quit menu
 * and writes a JSON report under .local-data/perf-stress/.
 *
 * The instance database is restored to its post-seed snapshot before each run,
 * so runs start from the same library. Frame timing is only comparable while
 * the window is frontmost: --foreground brings it forward before each journey
 * and takes the screen for the whole run (about four minutes); without it the
 * report keeps CPU, RSS and completion times, and marks frames unfocused.
 * --wait-idle starts only once nobody has touched the keyboard or pointer for
 * that long, and abandons the run if someone does meanwhile. --inject-css
 * applies an experimental stylesheet before the journeys, for A/B runs.
 */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, release as osRelease, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFrontendDebugDaemon } from '../src/dev-cli/frontend-debug/daemon';
// @ts-expect-error Executable ESM tooling.
import { createWorktreePlan, parseWorktreeArguments, runWorktreeDev } from './run-worktree-dev.mjs';
// @ts-expect-error Executable ESM tooling.
import { LOCAL_LIBRARY_DATABASE, parseSeededArguments, runSeededDev } from './run-seeded-dev.mjs';
// @ts-expect-error Executable ESM tooling.
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = '潮汐灯塔';
const LONG_CHAPTER = '第007章';
const TAB_CHAPTERS = ['第006章', '第009章', '第010章', '第011章', '第016章', '第020章', '第021章', '第022章', '第025章', '第027章', '第029章', '第032章'];

/** The journeys, in order. `sidebars` journeys change the layout the later ones run in. */
const JOURNEYS: ReadonlyArray<readonly [string, string, Record<string, unknown>?]> = [
  ['enter-local-mode', 'enterLocalMode', { project: PROJECT }],
  ['open-project', 'openProject', { name: PROJECT }],
  ['idle-project-home', 'idle', { ms: 4000 }],
  ['open-long-chapter', 'openChapter', { prefix: LONG_CHAPTER }],
  ['idle-editor', 'idle', { ms: 4000 }],
  ['type-end', 'typing', { n: 30, interval: 120, text: '潮' }],
  ['type-middle', 'typing', { n: 30, interval: 120, text: '汐', position: 'middle' }],
  ['scroll-chapter', 'scroll', { ms: 3000, step: 40 }],
  ['open-sidebars', 'sidebars', { open: true }],
  ['type-end-sidebars', 'typing', { n: 30, interval: 120, text: '潮' }],
  ['sidebar-panels', 'sidebarPanels', {}],
  ['open-12-tabs', 'openTabs', { prefixes: TAB_CHAPTERS }],
  ['switch-tabs-sidebars', 'switchTabs', { count: 12 }],
  ['close-sidebars', 'sidebars', { open: false }],
  ['switch-tabs', 'switchTabs', { count: 12 }],
  ['global-search', 'search', { query: '修船厂', moves: 10 }],
  ['whole-book', 'wholeBook'],
  ['super-views', 'superViews'],
  ['close-tabs', 'closeTabs', { max: 30 }],
  ['idle-after-close', 'idle', { ms: 4000 }],
];

const REQUIRED = new Set(['enter-local-mode', 'open-project', 'open-long-chapter']);

interface Options {
  release: boolean; foreground: boolean; instance: string; label: string; output: string; keepState: boolean;
  waitIdle: number; injectCss: string;
}

function parseArguments(args: string[]): Options | { compare: [string, string] } {
  const options = { release: false, foreground: false, instance: 'perf-stress', label: '', output: '', keepState: false, waitIdle: 0, injectCss: '' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--compare') return { compare: [args[index + 1], args[index + 2]] as [string, string] };
    if (argument === '--release') options.release = true;
    else if (argument === '--foreground') options.foreground = true;
    else if (argument === '--keep-state') options.keepState = true;
    else if (argument === '--wait-idle') options.waitIdle = Number(args[++index]);
    else if (argument === '--inject-css') options.injectCss = path.resolve(args[++index] ?? '');
    else if (argument === '--instance' || argument === '--label' || argument === '--output') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2) as 'instance' | 'label' | 'output'] = value;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  options.label ||= `${options.release ? 'release' : 'debug'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  options.output ||= path.join(root, '.local-data', 'perf-stress', `${options.label}.json`);
  return options;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------- processes

interface ProcessSample { pid: number; cpuSeconds: number; rssMB: number }

function cpuSeconds(value: string): number {
  let rest = value.trim(); let days = 0;
  if (rest.includes('-')) { const [d, r] = rest.split('-'); days = Number(d); rest = r; }
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function processes(): Array<{ pid: number; started: number; cpuSeconds: number; rssMB: number; command: string }> {
  const text = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,lstart=,time=,rss=,command='], { encoding: 'utf8' });
  return text.split('\n').filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), started: Date.parse(match[2]), cpuSeconds: cpuSeconds(match[3]), rssMB: Math.round(Number(match[4]) / 1024), command: match[5] };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
}

/** The app binary, and the WebContent process launched with it (WebKit does not name its client). */
function findAppProcesses(binary: string) {
  const rows = processes();
  const app = rows.find((row) => row.command === binary || row.command.startsWith(`${binary} `));
  if (!app) return null;
  const candidates = rows.filter((row) => row.command.endsWith('/com.apple.WebKit.WebContent')
    && row.started >= app.started - 2000 && row.started <= app.started + 120_000);
  return { app, candidates };
}

function sample(pid: number): ProcessSample | null {
  const row = processes().find((candidate) => candidate.pid === pid);
  return row ? { pid, cpuSeconds: row.cpuSeconds, rssMB: row.rssMB } : null;
}

/** Seconds since the last keyboard or pointer input on this Mac. */
function userIdleSeconds(): number {
  const text = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8' });
  const match = text.match(/"HIDIdleTime" = (\d+)/);
  return match ? Number(match[1]) / 1e9 : 0;
}

function bringToFront(pid: number) {
  execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], { stdio: 'ignore' });
}

function clickQuit(pid: number) {
  const items = execFileSync('osascript', ['-e', `tell application "System Events" to get name of every menu item of menu 1 of menu bar item 2 of menu bar 1 of (first process whose unix id is ${pid})`], { encoding: 'utf8' });
  const quit = items.split(',').map((item) => item.trim()).find((item) => item.startsWith('Quit'));
  if (!quit) throw new Error('No Quit item in the application menu');
  execFileSync('osascript', ['-e', `tell application "System Events" to click menu item "${quit}" of menu 1 of menu bar item 2 of menu bar 1 of (first process whose unix id is ${pid})`], { stdio: 'ignore' });
}

// ---------------------------------------------------------------- database snapshot

/** Restore the post-seed library, or take that snapshot on the first run. */
function prepareDatabase(databaseDirectory: string, snapshotDirectory: string, keepState: boolean): 'restored' | 'snapshotted' | 'kept' {
  const files = [LOCAL_LIBRARY_DATABASE, `${LOCAL_LIBRARY_DATABASE}-wal`, `${LOCAL_LIBRARY_DATABASE}-shm`];
  if (!existsSync(snapshotDirectory)) {
    mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    for (const file of files) if (existsSync(path.join(databaseDirectory, file))) copyFileSync(path.join(databaseDirectory, file), path.join(snapshotDirectory, file));
    return 'snapshotted';
  }
  if (keepState) return 'kept';
  for (const file of files) rmSync(path.join(databaseDirectory, file), { force: true });
  for (const file of readdirSync(snapshotDirectory)) copyFileSync(path.join(snapshotDirectory, file), path.join(databaseDirectory, file));
  return 'restored';
}

// ---------------------------------------------------------------- bridge

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if ('compare' in parsed) { compareReports(...parsed.compare); return; }
  const options = parsed;
  if (process.platform !== 'darwin') throw new Error('perf:stress measures the macOS desktop app');
  if (options.waitIdle > 0) {
    console.log(`[perf:stress] waiting until nobody has used this Mac for ${options.waitIdle} s`);
    while (userIdleSeconds() < options.waitIdle) await sleep(15_000);
  }

  const daemon = await startFrontendDebugDaemon({ platform: 'desktop', port: await freePort() });
  const { host, port, token } = daemon.descriptor;
  const command = async (name: string, input: Record<string, unknown> = {}) => {
    const response = await fetch(`http://${host}:${port}/command`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: name, input }), signal: AbortSignal.timeout(70_000),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `bridge ${response.status}`);
    const { result } = body;
    return result && typeof result === 'object' && 'value' in result ? (result as { value: unknown }).value : result;
  };
  const evaluate = async <T>(expression: string): Promise<T> => JSON.parse(String(await command('evaluate', { expression: `JSON.stringify(${expression})` }))) as T;

  const launchArguments = ['--instance', options.instance, '--no-watch', '--frontend-debug', ...(options.release ? ['--release-perf'] : [])];
  const plan = createWorktreePlan({ root, ...parseWorktreeArguments(parseSeededArguments(launchArguments).launchArguments) });
  const binary = path.join(plan.manifest.cargoTargetDirectory, options.release ? 'release' : 'debug', 'drifting');
  const snapshotDirectory = path.join(plan.manifest.profileDirectory, 'perf-stress-seed');
  mkdirSync(path.dirname(options.output), { recursive: true });
  const logPath = options.output.replace(/\.json$/, '.log');
  const log = openSync(logPath, 'w');
  let database = 'kept';
  const signals = new EventEmitter();
  console.log(`[perf:stress] ${options.release ? 'release' : 'debug'} instance "${options.instance}", log ${path.relative(root, logPath)}`);
  const app = runSeededDev(launchArguments, {
    root,
    output: () => undefined,
    launch: (args: string[], context: Record<string, unknown>) => {
      database = prepareDatabase(plan.manifest.databaseDirectory, snapshotDirectory, options.keepState);
      return runWorktreeDev(args, { ...context, signals, output: () => undefined,
        spawnProcess: (file: string, spawnArgs: string[], spawnOptions: SpawnOptions) => spawn(file, spawnArgs, { ...spawnOptions, stdio: ['ignore', log, log] }) });
    },
  }) as Promise<void>;
  let exited = false;
  void app.then(() => { exited = true; }, () => { exited = true; });

  const report: Record<string, unknown> = {};
  try {
    // A release build compiles the renderer first; a fresh profile compiles Rust.
    const deadline = Date.now() + 20 * 60_000;
    while (!daemon.status().rendererConnected) {
      if (exited) throw new Error(`The app exited before its renderer connected; see ${logPath}`);
      if (Date.now() > deadline) throw new Error('The renderer did not connect within 20 minutes');
      await sleep(1000);
    }
    const found = findAppProcesses(binary);
    if (!found) throw new Error(`No running ${path.relative(root, binary)}`);
    await evaluate(readFileSync(path.join(root, 'scripts/perf-stress-journeys.js'), 'utf8'));
    if (options.injectCss) {
      await evaluate(`(() => { const style = document.createElement('style'); style.dataset.perfStressExperiment = '1'; style.textContent = ${JSON.stringify(readFileSync(options.injectCss, 'utf8'))}; document.head.append(style); return 'injected'; })()`);
    }
    const runStarted = Date.now();
    let webPid: number | null = found.candidates.length === 1 ? found.candidates[0].pid : null;
    const results: Array<Record<string, unknown>> = [];
    for (const [name, journey, input] of JOURNEYS) {
      // Someone came back to the Mac: stop rather than fight them for the screen.
      if (options.waitIdle > 0 && userIdleSeconds() < Math.min(options.waitIdle, (Date.now() - runStarted) / 1000)) {
        throw new Error('Input on this Mac during the run; abandoned');
      }
      if (options.foreground) { bringToFront(found.app.pid); await sleep(400); }
      // Several WebContent processes may start with the app: keep the busiest.
      if (webPid === null && results.length > 0) {
        const busiest = findAppProcesses(binary)?.candidates.sort((a, b) => b.cpuSeconds - a.cpuSeconds)[0];
        webPid = busiest?.pid ?? null;
      }
      const before = { at: Date.now(), native: sample(found.app.pid), web: webPid === null ? null : sample(webPid) };
      await evaluate(`window.__driftingPerf.start(${JSON.stringify(name)}, ${JSON.stringify(journey)}, ${JSON.stringify(input ?? {})})`);
      let job: { state: string; value?: unknown; error?: string };
      do { await sleep(500); job = await evaluate(`window.__driftingPerf.jobs[${JSON.stringify(name)}]`); } while (job.state === 'running');
      const after = { at: Date.now(), native: sample(found.app.pid), web: webPid === null ? null : sample(webPid) };
      const seconds = (after.at - before.at) / 1000;
      const cpu = (from: ProcessSample | null, to: ProcessSample | null) => (from && to ? {
        cpuSeconds: Math.round((to.cpuSeconds - from.cpuSeconds) * 100) / 100,
        cpuPercent: Math.round(((to.cpuSeconds - from.cpuSeconds) / seconds) * 1000) / 10, rssMB: to.rssMB,
      } : null);
      const entry = { name, journey, seconds: Math.round(seconds * 10) / 10, native: cpu(before.native, after.native), web: cpu(before.web, after.web),
        ...(job.state === 'done' ? { result: job.value } : { error: job.error }) };
      results.push(entry);
      console.log(`[perf:stress] ${name}: ${job.state === 'done' ? 'ok' : `error ${job.error?.split('\n')[0]}`} (${entry.seconds} s)`);
      // Later journeys need the project and its long chapter.
      if (job.state !== 'done' && REQUIRED.has(name)) throw new Error(`${name} failed: ${job.error}`);
    }
    // Quit through the menu, so the flush-before-quit barrier is part of the run.
    const quitAt = Date.now();
    clickQuit(found.app.pid);
    while (sample(found.app.pid) && Date.now() - quitAt < 15_000) await sleep(100);
    const quitSeconds = (Date.now() - quitAt) / 1000;
    Object.assign(report, {
      schemaVersion: 1,
      label: options.label,
      build: options.release ? 'release (Rust release, production renderer)' : 'debug (Rust debug, Vite development renderer, React Strict Mode)',
      recordedAt: new Date().toISOString(),
      foreground: options.foreground,
      ...(options.injectCss ? { injectedCss: readFileSync(options.injectCss, 'utf8') } : {}),
      database,
      seed: 'stress',
      source: {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
        rendererFingerprint: createHash('sha256').update(rendererSourceFingerprint(root)).digest('hex'),
      },
      machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), darwin: osRelease() },
      webContentCandidates: found.candidates.length,
      quitSeconds: Math.round(quitSeconds * 100) / 100,
      journeys: results,
    });
  } finally {
    // After Quit the launcher exits by itself; signal its group only if it is stuck.
    await Promise.race([app.catch(() => undefined), sleep(15_000)]);
    if (!exited) {
      try { signals.emit('SIGTERM'); } catch { /* the group already exited */ }
      await app.catch(() => undefined);
    }
    await daemon.close();
  }
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[perf:stress] report ${path.relative(root, options.output)}`);
  printSummary(report);
}

// ---------------------------------------------------------------- summary

type Journey = { name: string; seconds: number; native: { cpuPercent: number; rssMB: number } | null; web: { cpuPercent: number; rssMB: number } | null; result?: unknown; error?: string };

/** One row per headline number, shared by the summary and --compare. */
function headline(report: { journeys: Journey[] }): Array<[string, string]> {
  const by = (name: string) => report.journeys.find((journey) => journey.name === name);
  // A value inside one journey's result, e.g. at('switch-tabs', 'visibleMs', 'p50').
  const at = (name: string, ...keys: string[]): unknown => keys.reduce<unknown>((value, key) =>
    (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), by(name)?.result);
  const ms = (value: unknown) => (typeof value === 'number' ? `${Math.round(value)} ms` : '—');
  const pct = (name: string, side: 'native' | 'web') => { const value = by(name)?.[side]?.cpuPercent; return typeof value === 'number' ? `${value}%` : '—'; };
  const peak = (side: 'native' | 'web') => `${Math.max(0, ...report.journeys.map((journey) => journey[side]?.rssMB ?? 0))} MB`;
  return [
    ['open project (visible / worst frame)', `${ms(at('open-project', 'visibleMs'))} / ${ms(at('open-project', 'frames', 'max'))}`],
    ['open 20k chapter (visible / worst frame)', `${ms(at('open-long-chapter', 'visibleMs'))} / ${ms(at('open-long-chapter', 'frames', 'max'))}`],
    ['typing key→2nd frame p50 / p95', `${ms(at('type-end', 'keyToSecondFrame', 'p50'))} / ${ms(at('type-end', 'keyToSecondFrame', 'p95'))}`],
    ['typing with sidebars p95', ms(at('type-end-sidebars', 'keyToSecondFrame', 'p95'))],
    ['typing CPU native / web', `${pct('type-end', 'native')} / ${pct('type-end', 'web')}`],
    ['scroll chapter worst frame', ms(at('scroll-chapter', 'frames', 'max'))],
    ['open left / right sidebar worst frame', `${ms(at('open-sidebars', '展开左侧栏', 'frames', 'max'))} / ${ms(at('open-sidebars', '展开右侧栏', 'frames', 'max'))}`],
    ['open tab p50 / last three', `${ms(at('open-12-tabs', 'visibleMs', 'p50'))} / ${((at('open-12-tabs', 'last') as unknown[] | undefined) ?? []).map(ms).join(', ')}`],
    ['switch tab p50 / p95 (sidebars open)', `${ms(at('switch-tabs-sidebars', 'visibleMs', 'p50'))} / ${ms(at('switch-tabs-sidebars', 'visibleMs', 'p95'))}`],
    ['switch tab p50 / p95 (sidebars closed)', `${ms(at('switch-tabs', 'visibleMs', 'p50'))} / ${ms(at('switch-tabs', 'visibleMs', 'p95'))}`],
    ['switch tab worst frame p50 (closed)', ms(at('switch-tabs', 'frameMax', 'p50'))],
    ['search keystroke p50', ms(at('global-search', 'typing', 'visibleMs', 'p50'))],
    ['whole book open / fast scroll p95', `${ms(at('whole-book', 'open', 'visibleMs'))} / ${ms(at('whole-book', 'fast', 'frames', 'p95'))}`],
    ['super views worst frame (graph / elements / materials)', ['storyGraph', 'elementPanorama', 'materialWorkbench'].map((view) => ms(at('super-views', view, 'frames', 'max'))).join(' / ')],
    ['close tab p50 / last', `${ms(at('close-tabs', 'visibleMs', 'p50'))} / ${ms(at('close-tabs', 'lastMs'))}`],
    ['idle CPU native / web (editor open)', `${pct('idle-editor', 'native')} / ${pct('idle-editor', 'web')}`],
    ['peak RSS native / web', `${peak('native')} / ${peak('web')}`],
    ['errors', String(report.journeys.filter((journey) => journey.error).length)],
  ];
}

function printSummary(report: Record<string, unknown>) {
  const rows = headline(report as { journeys: Journey[] });
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, value] of rows) console.log(`  ${name.padEnd(width)}  ${value}`);
  if (!report.foreground) console.log('  (not --foreground: frame numbers come from a throttled background window)');
}

function compareReports(a: string, b: string) {
  const [left, right] = [a, b].map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const rows = headline(left).map(([name, value], index) => [name, value, headline(right)[index][1]]);
  const width = Math.max(...rows.map(([name]) => name.length));
  const widthA = Math.max(left.label.length, ...rows.map(([, value]) => value.length));
  console.log(`  ${''.padEnd(width)}  ${left.label.padEnd(widthA)}  ${right.label}`);
  for (const [name, x, y] of rows) console.log(`  ${name.padEnd(width)}  ${x.padEnd(widthA)}  ${y}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
