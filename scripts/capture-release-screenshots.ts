#!/usr/bin/env node
/**
 * Release screenshots of the macOS desktop app (docs/release-screenshots.md).
 *
 *   pnpm release:screenshots [--locale en|zh-CN] [--theme light|dark] [--background]
 *                            [--position <x>,<y>] [--output <dir>] [--keep-open]
 *
 * For each interface language: reseeds the isolated `release-screenshots`
 * profile with the synthetic screenshot library (src/dev-cli/seeds/showcase),
 * launches its Debug build with the frontend debug bridge, drives
 * scripts/release-screenshots-scenes.js (the shelf, the workspace on one
 * chapter, the element overview in 关系) and captures the real window pixels
 * of each scene in each theme with `screencapture -l`. Writes the PNGs and a
 * manifest under out/screenshots/<version>/.
 *
 * WebKit renders nothing in a window other windows cover, so the window is
 * brought to the front for each capture (traffic lights lit, as an author sees
 * them) and the app that was in front is given its place back at the end.
 * --background leaves focus alone: the window must then stay visible where it
 * is (or at --position), and its traffic lights are grey. --keep-open leaves
 * the last language's app running for a look around.
 */
import { execFileSync, spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFrontendDebugDaemon } from '../src/dev-cli/frontend-debug/daemon';
// @ts-expect-error Executable ESM tooling.
import { assertWorktreePortAvailable, createWorktreePlan, parseWorktreeArguments, runWorktreeDev } from './run-worktree-dev.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const INSTANCE = 'release-screenshots';
const LIBRARY = 'drifting-library.db';
/** Wide enough for the English element overview's header in one line. */
const WINDOW = { width: 1600, height: 1000 };
const LOCALES = ['en', 'zh-CN'] as const;
const THEMES = ['light', 'dark'] as const;
type Locale = (typeof LOCALES)[number];
type Theme = (typeof THEMES)[number];

/** The chapter each workspace shot opens, and the chapters open beside it as tabs (1-based). */
const WORKSPACE: Record<Locale, { chapter: number; tabs: number[] }> = {
  en: { chapter: 1, tabs: [2, 3, 18] },
  'zh-CN': { chapter: 1, tabs: [2, 3, 5] },
};

interface Options {
  locales: Locale[]; themes: Theme[]; background: boolean; position: [number, number] | null;
  output: string; keepOpen: boolean;
}

function parseArguments(args: string[]): Options {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const options: Options = {
    locales: [...LOCALES], themes: [...THEMES], background: false, position: null,
    output: path.join(root, 'out', 'screenshots', version), keepOpen: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === '--') continue;
    else if (argument === '--background') options.background = true;
    else if (argument === '--keep-open') options.keepOpen = true;
    else if (argument === '--output') options.output = path.resolve(value());
    else if (argument === '--locale') {
      const locale = value();
      if (!LOCALES.includes(locale as Locale)) throw new Error(`--locale is one of ${LOCALES.join(', ')}`);
      options.locales = [locale as Locale];
    } else if (argument === '--theme') {
      const theme = value();
      if (!THEMES.includes(theme as Theme)) throw new Error(`--theme is one of ${THEMES.join(', ')}`);
      options.themes = [theme as Theme];
    } else if (argument === '--position') {
      const [x, y] = value().split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('--position is <x>,<y> in screen points');
      options.position = [x, y];
    } else throw new Error(`Unknown argument ${argument}`);
  }
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

// ---------------------------------------------------------------- the window

const osascript = (...lines: string[]) =>
  execFileSync('osascript', lines.flatMap((line) => ['-e', line]), { encoding: 'utf8' }).trim();
const jxa = (source: string, ...args: string[]) =>
  execFileSync('osascript', ['-l', 'JavaScript', '-e', source, ...args], { encoding: 'utf8' }).trim();

/** The app process itself (not its signing wrapper script). */
function appPid(binary: string): number | null {
  const text = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && (match[2] === binary || match[2].startsWith(`${binary} `))) return Number(match[1]);
  }
  return null;
}

interface WindowInfo { id: number; x: number; y: number; width: number; height: number }

/** The app's main window: its largest ordinary window (the others are menu bars and helpers). */
function mainWindow(pid: number): WindowInfo | null {
  const list = JSON.parse(jxa(`ObjC.import('CoreGraphics');
function run(argv) {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
  return JSON.stringify(list.filter((w) => w.kCGWindowOwnerPID === Number(argv[0]) && w.kCGWindowLayer === 0)
    .map((w) => ({ id: w.kCGWindowNumber, x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));
}`, String(pid))) as WindowInfo[];
  return list.filter((w) => w.height > 200).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

function frontmostPid(): number {
  return Number(osascript('tell application "System Events" to get unix id of first process whose frontmost is true'));
}

function bringToFront(pid: number) {
  osascript(`tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`);
}

/** Size the window, and put it where asked (or centred on the main display). */
function placeWindow(pid: number, position: [number, number] | null) {
  const [x, y] = position ?? JSON.parse(jxa(`ObjC.import('AppKit');
const frame = $.NSScreen.screens.objectAtIndex(0).frame;
JSON.stringify([Math.max(0, Math.round((frame.size.width - ${WINDOW.width}) / 2)), Math.max(30, Math.round((frame.size.height - ${WINDOW.height}) / 2))])`)) as [number, number];
  const process = `(first process whose unix id is ${pid})`;
  osascript(
    `tell application "System Events" to set size of window 1 of ${process} to {${WINDOW.width}, ${WINDOW.height}}`,
    `tell application "System Events" to set position of window 1 of ${process} to {${x}, ${y}}`,
  );
}

/** A pointer resting on the window would leave a hover state in the picture: move it just outside. */
function movePointerOff(window: WindowInfo) {
  jxa(`ObjC.import('CoreGraphics');
const at = $.CGEventGetLocation($.CGEventCreate(null));
const w = { x: ${window.x}, y: ${window.y}, width: ${window.width}, height: ${window.height} };
if (at.x >= w.x && at.x <= w.x + w.width && at.y >= w.y && at.y <= w.y + w.height) {
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(w.x + w.width + 24, w.y + w.height / 2), 0));
}
'ok'`);
}

function clickQuit(pid: number): boolean {
  const process = `(first process whose unix id is ${pid})`;
  try {
    const items = osascript(`tell application "System Events" to get name of every menu item of menu 1 of menu bar item 2 of menu bar 1 of ${process}`);
    const quit = items.split(',').map((item) => item.trim()).find((item) => item.startsWith('Quit') || item.startsWith('退出'));
    if (!quit) return false;
    osascript(`tell application "System Events" to click menu item "${quit}" of menu 1 of menu bar item 2 of menu bar 1 of ${process}`);
    return true;
  } catch {
    return false;
  }
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ---------------------------------------------------------------- the library

interface SeededLibrary {
  main: { projectId: string; name: string; chapters: { id: string; title: string }[]; elements: number };
  projects: { projectId: string; name: string }[];
  writingDays: number;
}

/** This profile's own library and app data, removed so the seed starts from nothing. */
function resetProfile(databaseDirectory: string, appLocalDataDirectory: string) {
  if (!path.basename(appLocalDataDirectory).startsWith('cc.drifting.wt.')) {
    throw new Error(`Not an isolated profile's data directory: ${appLocalDataDirectory}`);
  }
  for (const file of [LIBRARY, `${LIBRARY}-wal`, `${LIBRARY}-shm`]) rmSync(path.join(databaseDirectory, file), { force: true });
  for (const entry of ['assets', 'sync-objects', 'markdown-projections', 'markdown-mirror-instance']) {
    rmSync(path.join(appLocalDataDirectory, entry), { recursive: true, force: true });
  }
}

function seedLibrary(databasePath: string, appLocalDataDirectory: string, locale: Locale): SeededLibrary {
  const result = spawnSync('pnpm', ['exec', 'tsx', '--conditions=import', 'src/dev-cli/showcase-seed-main.ts',
    '--db', databasePath, '--app-local-data', appLocalDataDirectory, '--locale', locale], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ') },
  });
  if (result.status !== 0) throw new Error(`Seeding the ${locale} screenshot library failed (exit ${result.status ?? result.signal})`);
  return JSON.parse(result.stdout.trim().split('\n').pop()!) as SeededLibrary;
}

// ---------------------------------------------------------------- one language

interface Shot { file: string; locale: Locale; theme: Theme; scene: string; width: number; height: number; sha256: string }

async function captureLocale(locale: Locale, options: Options, shots: Shot[], keepOpen: boolean) {
  // The bridge first: the launch plan hands its session to the renderer.
  const daemon = await startFrontendDebugDaemon({ platform: 'desktop', port: await freePort() });
  const { host, port, token } = daemon.descriptor;
  const launchArguments = ['--instance', INSTANCE, '--no-watch', '--frontend-debug'];
  const plan = createWorktreePlan({ root, ...parseWorktreeArguments(launchArguments) });
  const { databaseDirectory, appLocalDataDirectory, cargoTargetDirectory, profileDirectory } = plan.manifest;
  let library: SeededLibrary;
  try {
    await assertWorktreePortAvailable(plan.manifest.port);
    resetProfile(databaseDirectory, appLocalDataDirectory);
    console.log(`[screenshots] ${locale}: seeding the library`);
    library = seedLibrary(path.join(databaseDirectory, LIBRARY), appLocalDataDirectory, locale);
  } catch (error) {
    await daemon.close();
    throw error;
  }
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
  const evaluate = async <T>(expression: string): Promise<T> =>
    JSON.parse(String(await command('evaluate', { expression: `JSON.stringify(${expression})` }))) as T;
  const install = () => evaluate<string>(readFileSync(path.join(root, 'scripts/release-screenshots-scenes.js'), 'utf8'));
  const scene = async (name: string, input: Record<string, unknown> = {}) => {
    const id = `${name}-${Date.now()}`;
    await evaluate(`window.__driftingShots.start(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(input)})`);
    for (;;) {
      await sleep(400);
      const job = await evaluate<{ state: string; value?: unknown; error?: string }>(`window.__driftingShots.jobs[${JSON.stringify(id)}]`);
      if (job.state === 'done') return job.value;
      if (job.state === 'error') throw new Error(`${name}: ${job.error}`);
    }
  };

  const binary = path.join(cargoTargetDirectory, 'debug', 'drifting');
  const logPath = path.join(profileDirectory, 'logs', `release-screenshots-${locale}.log`);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w');
  const signals = new EventEmitter();
  console.log(`[screenshots] ${locale}: launching (log ${path.relative(root, logPath)})`);
  const app = runWorktreeDev(launchArguments, {
    root, signals, output: () => undefined,
    spawnProcess: (file: string, args: string[], spawnOptions: SpawnOptions) => spawn(file, args, { ...spawnOptions, stdio: ['ignore', log, log] }),
  }) as Promise<void>;
  let exited = false;
  void app.then(() => { exited = true; }, () => { exited = true; });

  const previousFront = frontmostPid();
  let pid: number | null = null;
  try {
    // A fresh profile compiles Rust first.
    const deadline = Date.now() + 20 * 60_000;
    while (!daemon.status().rendererConnected) {
      if (exited) throw new Error(`The app exited before its renderer connected; see ${logPath}`);
      if (Date.now() > deadline) throw new Error('The renderer did not connect within 20 minutes');
      await sleep(1000);
    }
    pid = appPid(binary);
    if (!pid) throw new Error(`No running ${path.relative(root, binary)}`);
    placeWindow(pid, options.position);

    // Language, the first theme and the guides, then a reload to start clean.
    // Not a polled job: the reload it schedules would take the job table with it.
    await install();
    await command('evaluate', {
      expression: `window.__driftingShots.scenes.prepare(${JSON.stringify({ locale, theme: options.themes[0] })}).then((value) => JSON.stringify(value))`,
    });
    await sleep(1500);
    for (const deadlineAt = Date.now() + 60_000; ;) {
      try {
        if (await evaluate<string>('document.readyState') === 'complete' && await install() === 'installed') break;
      } catch { /* reloading */ }
      if (Date.now() > deadlineAt) throw new Error('The renderer did not come back after its reload');
      await sleep(500);
    }

    mkdirSync(options.output, { recursive: true });
    const capture = async (name: string, theme: Theme) => {
      if (!options.background) {
        bringToFront(pid!);
        await sleep(700);
      }
      const window = mainWindow(pid!);
      if (!window) throw new Error('The app has no window to capture');
      if (!options.background) movePointerOff(window);
      await sleep(300);
      const file = path.join(options.output, `${locale}-${theme}-${name}.png`);
      execFileSync('screencapture', ['-x', '-o', `-l${window.id}`, file]);
      if (!existsSync(file) || statSync(file).size === 0) throw new Error(`screencapture wrote nothing for ${name}`);
      const size = pngSize(file);
      shots.push({ file: path.basename(file), locale, theme, scene: name, ...size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
      console.log(`[screenshots] ${path.relative(root, file)} ${size.width}×${size.height}`);
    };
    const inEachTheme = async (name: string) => {
      for (const [index, theme] of options.themes.entries()) {
        if (index > 0) await scene('theme', { mode: theme });
        await capture(name, theme);
      }
      if (options.themes.length > 1) await scene('theme', { mode: options.themes[0] });
    };

    const chapters = library.main.chapters;
    const { chapter, tabs } = WORKSPACE[locale];
    await scene('shelf', { books: library.projects.length });
    await inEachTheme('shelf');
    await scene('workspace', {
      projectId: library.main.projectId, name: library.main.name,
      chapterId: chapters[chapter - 1].id, tabs: tabs.map((number) => chapters[number - 1].id),
    });
    await inEachTheme('workspace');
    await scene('elements', { count: library.main.elements });
    await inEachTheme('elements');
  } finally {
    if (!options.background && previousFront && previousFront !== pid) {
      try { bringToFront(previousFront); } catch { /* it quit meanwhile */ }
    }
    if (!keepOpen) {
      // Quit through the menu so the app flushes; signal the group only if it is stuck.
      if (!(pid && clickQuit(pid))) signals.emit('SIGTERM');
      await Promise.race([app.catch(() => undefined), sleep(20_000)]);
      if (!exited) {
        try { signals.emit('SIGTERM'); } catch { /* the group already exited */ }
        await app.catch(() => undefined);
      }
      await daemon.close();
    } else {
      console.log(`[screenshots] ${locale}: left running (instance "${INSTANCE}")`);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('Release screenshots capture the macOS desktop app');
  const shots: Shot[] = [];
  const started = Date.now();
  for (const [index, locale] of options.locales.entries()) {
    await captureLocale(locale, options, shots, options.keepOpen && index === options.locales.length - 1);
  }
  const manifest = {
    schemaVersion: 1,
    version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    recordedAt: new Date().toISOString(),
    source: {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    },
    build: 'debug (Rust debug, Vite development renderer)',
    window: { ...WINDOW, focused: !options.background },
    seconds: Math.round((Date.now() - started) / 1000),
    shots,
  };
  writeFileSync(path.join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[screenshots] ${shots.length} screenshots in ${path.relative(root, options.output)} (${manifest.seconds} s)`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
