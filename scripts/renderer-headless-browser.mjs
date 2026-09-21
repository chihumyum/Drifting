import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function resolveHeadlessBrowser(override = process.env.DRIFTING_PERF_CHROME, exists = existsSync) {
  const executable = override ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find(exists);
  if (!executable || !exists(executable)) throw new Error('Set DRIFTING_PERF_CHROME to an installed Chromium executable');
  return executable;
}
export async function withDeadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const exited = child => child.exitCode !== null || child.signalCode !== null || !child.pid;
export async function stopBrowserProcess(child, graceMs = 1500) {
  if (!child || exited(child)) return;
  // Register before kill; a signal exit has a null exitCode but a signalCode.
  let onExit;
  const exit = new Promise(resolve => { onExit = resolve; child.once('exit', onExit); });
  try {
    child.kill('SIGTERM');
    try { await withDeadline(exit, graceMs, 'Browser SIGTERM'); } catch {
      if (!exited(child)) {
        child.kill('SIGKILL');
        await withDeadline(exit, graceMs, 'Browser SIGKILL');
      }
    }
  } finally { child.removeListener('exit', onExit); }
}
export async function launchHeadlessBrowser({ executable = resolveHeadlessBrowser(), profile, launchTimeoutMs = 20000, spawnProcess = spawn }) {
  let stderr = '', spawnError;
  const child = spawnProcess(executable, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  child.on('error', error => { spawnError = error; });
  const diagnostics = () => ({ executable: path.basename(executable), exitCode: child.exitCode, signalCode: child.signalCode,
    stderr: stderr.replaceAll(profile, '<isolated-profile>').replaceAll(path.dirname(profile), '<temporary-directory>') });
  const close = () => stopBrowserProcess(child);
  try {
    const portFile = path.join(profile, 'DevToolsActivePort'); const start = Date.now();
    while (Date.now() - start < launchTimeoutMs) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(`Chromium exited before its debugging endpoint: ${spawnError?.code ?? child.signalCode ?? child.exitCode}`);
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return { child, port, close, diagnostics };
      }
      await delay(50);
    }
    throw new Error('Chromium debugging endpoint timed out');
  } catch (error) {
    await close().catch(cleanupError => { stderr += `\n${cleanupError.message}`; });
    throw new Error(`${error.message}; ${JSON.stringify(diagnostics())}`);
  }
}
export async function closeHeadlessSession({ client, browser, server }) {
  const failures = [];
  const close = async (job, label) => { try { await withDeadline(job(), 5000, label); } catch (error) { failures.push(String(error)); } };
  if (client) await close(() => client.close(), 'CDP close');
  if (browser) await close(() => browser.close(), 'Browser close');
  if (server) await close(() => new Promise((resolve, reject) => {
    server.httpServer.close(error => error ? reject(error) : resolve());
    server.httpServer.closeAllConnections?.();
  }), 'Preview server close');
  if (failures.length) throw new Error(failures.join('; '));
}
