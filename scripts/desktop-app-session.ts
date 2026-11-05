/**
 * Launching an isolated Debug build of the macOS desktop app with the frontend
 * debug bridge, and placing, fronting and quitting its window. Shared by the
 * release screenshots (scripts/capture-release-screenshots.ts) and the promo
 * recording (scripts/design-assets/promo-recording/record.ts).
 */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFrontendDebugDaemon } from '../src/dev-cli/frontend-debug/daemon';
// @ts-expect-error Executable ESM tooling.
import { assertWorktreePortAvailable, createWorktreePlan, parseWorktreeArguments, runWorktreeDev } from './run-worktree-dev.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------- the window

export const osascript = (...lines: string[]) =>
  execFileSync('osascript', lines.flatMap((line) => ['-e', line]), { encoding: 'utf8' }).trim();
export const jxa = (source: string, ...args: string[]) =>
  execFileSync('osascript', ['-l', 'JavaScript', '-e', source, ...args], { encoding: 'utf8' }).trim();

/** The app process itself (not its signing wrapper script). */
export function appPid(binary: string): number | null {
  const text = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && (match[2] === binary || match[2].startsWith(`${binary} `))) return Number(match[1]);
  }
  return null;
}

export interface WindowInfo { id: number; x: number; y: number; width: number; height: number }

/** The app's main window: its largest ordinary window (the others are menu bars and helpers). */
export function mainWindow(pid: number): WindowInfo | null {
  const list = JSON.parse(jxa(`ObjC.import('CoreGraphics');
function run(argv) {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
  return JSON.stringify(list.filter((w) => w.kCGWindowOwnerPID === Number(argv[0]) && w.kCGWindowLayer === 0)
    .map((w) => ({ id: w.kCGWindowNumber, x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));
}`, String(pid))) as WindowInfo[];
  return list.filter((w) => w.height > 200).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

export function frontmostPid(): number {
  return Number(osascript('tell application "System Events" to get unix id of first process whose frontmost is true'));
}

export function bringToFront(pid: number) {
  osascript(`tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`);
}

/** Size the window, and put it where asked (or centred on the main display). */
export function placeWindow(pid: number, size: { width: number; height: number }, position: [number, number] | null) {
  const [x, y] = position ?? JSON.parse(jxa(`ObjC.import('AppKit');
const frame = $.NSScreen.screens.objectAtIndex(0).frame;
JSON.stringify([Math.max(0, Math.round((frame.size.width - ${size.width}) / 2)), Math.max(30, Math.round((frame.size.height - ${size.height}) / 2))])`)) as [number, number];
  const process = `(first process whose unix id is ${pid})`;
  osascript(
    `tell application "System Events" to set size of window 1 of ${process} to {${size.width}, ${size.height}}`,
    `tell application "System Events" to set position of window 1 of ${process} to {${x}, ${y}}`,
  );
}

/** A pointer resting on the window would leave a hover state in the picture: move it just outside. */
export function movePointerOff(window: WindowInfo) {
  jxa(`ObjC.import('CoreGraphics');
const at = $.CGEventGetLocation($.CGEventCreate(null));
const w = { x: ${window.x}, y: ${window.y}, width: ${window.width}, height: ${window.height} };
if (at.x >= w.x && at.x <= w.x + w.width && at.y >= w.y && at.y <= w.y + w.height) {
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(w.x + w.width + 24, w.y + w.height / 2), 0));
}
'ok'`);
}

export function clickQuit(pid: number): boolean {
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

// ---------------------------------------------------------------- the app

export interface ProfileManifest {
  databaseDirectory: string;
  appLocalDataDirectory: string;
  cargoTargetDirectory: string;
  profileDirectory: string;
  port: number;
}

export interface DesktopAppSession {
  manifest: ProfileManifest;
  pid: number;
  logPath: string;
  /** A frontend debug bridge command; returns its value. */
  command(name: string, input?: Record<string, unknown>): Promise<unknown>;
  /** Evaluates an expression in the renderer and returns its JSON value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Quits through the menu so the app flushes, signals the group only if it is stuck, and stops the bridge. */
  close(): Promise<void>;
}

/**
 * Starts the bridge, lets `prepare` set up the isolated profile `instance`
 * (it may seed it), launches its Debug build and waits for the renderer. A
 * fresh profile compiles Rust first.
 */
export async function openDesktopApp(options: {
  instance: string;
  tag: string;
  logName: string;
  prepare?(manifest: ProfileManifest): void | Promise<void>;
}): Promise<DesktopAppSession> {
  const daemon = await startFrontendDebugDaemon({ platform: 'desktop', port: await freePort() });
  const { host, port, token } = daemon.descriptor;
  const launchArguments = ['--instance', options.instance, '--no-watch', '--frontend-debug'];
  const plan = createWorktreePlan({ root, ...parseWorktreeArguments(launchArguments) });
  const manifest = plan.manifest as ProfileManifest;
  try {
    await assertWorktreePortAvailable(manifest.port);
    await options.prepare?.(manifest);
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

  const binary = path.join(manifest.cargoTargetDirectory, 'debug', 'drifting');
  const logPath = path.join(manifest.profileDirectory, 'logs', options.logName);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w');
  const signals = new EventEmitter();
  console.log(`[${options.tag}] launching (log ${path.relative(root, logPath)})`);
  const app = runWorktreeDev(launchArguments, {
    root, signals, output: () => undefined,
    spawnProcess: (file: string, args: string[], spawnOptions: SpawnOptions) => spawn(file, args, { ...spawnOptions, stdio: ['ignore', log, log] }),
  }) as Promise<void>;
  let exited = false;
  void app.then(() => { exited = true; }, () => { exited = true; });

  let pid: number | null = null;
  const close = async () => {
    if (!(pid && clickQuit(pid))) signals.emit('SIGTERM');
    await Promise.race([app.catch(() => undefined), sleep(20_000)]);
    if (!exited) {
      try { signals.emit('SIGTERM'); } catch { /* the group already exited */ }
      await app.catch(() => undefined);
    }
    await daemon.close();
  };
  try {
    const deadline = Date.now() + 20 * 60_000;
    while (!daemon.status().rendererConnected) {
      if (exited) throw new Error(`The app exited before its renderer connected; see ${logPath}`);
      if (Date.now() > deadline) throw new Error('The renderer did not connect within 20 minutes');
      await sleep(1000);
    }
    pid = appPid(binary);
    if (!pid) throw new Error(`No running ${path.relative(root, binary)}`);
  } catch (error) {
    await close();
    throw error;
  }
  return { manifest, pid, logPath, command, evaluate, close };
}

/**
 * Installs a scenes script (an IIFE that defines `window[global]` with
 * `start(id, name, input)` and `jobs`) and returns a runner that starts a scene
 * and polls it to completion.
 */
export function sceneRunner(session: DesktopAppSession, scriptPath: string, global: string, read: (file: string) => string) {
  const install = () => session.evaluate<string>(read(scriptPath));
  const run = async <T = unknown>(name: string, input: Record<string, unknown> = {}): Promise<T> => {
    const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await session.evaluate(`window.${global}.start(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(input)})`);
    for (;;) {
      await sleep(120);
      const job = await session.evaluate<{ state: string; value?: unknown; error?: string }>(`window.${global}.jobs[${JSON.stringify(id)}]`);
      if (job.state === 'done') return job.value as T;
      if (job.state === 'error') throw new Error(`${name}: ${job.error}`);
    }
  };
  /** Starts a scene that reloads the page, then waits for the renderer and reinstalls the script. */
  const runReloading = async (name: string, input: Record<string, unknown>) => {
    await session.command('evaluate', {
      expression: `window.${global}.scenes.${name}(${JSON.stringify(input)}).then((value) => JSON.stringify(value))`,
    });
    await sleep(1500);
    for (const deadlineAt = Date.now() + 60_000; ;) {
      try {
        if (await session.evaluate<string>('document.readyState') === 'complete' && await install() === 'installed') return;
      } catch { /* reloading */ }
      if (Date.now() > deadlineAt) throw new Error('The renderer did not come back after its reload');
      await sleep(500);
    }
  };
  return { install, run, runReloading };
}
