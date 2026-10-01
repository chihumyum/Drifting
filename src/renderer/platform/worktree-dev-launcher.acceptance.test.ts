import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromFile } from 'vite';

// @ts-expect-error Executable tooling intentionally lives outside the renderer TS graph.
import { createWorktreePlan, parseWorktreeArguments, runWorktreeDev, assertWorktreePortAvailable } from '../../../scripts/run-worktree-dev.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const baseConfig = readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const directories: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'drifting worktree-'));
  directories.push(root);
  mkdirSync(path.join(root, 'src-tauri'));
  writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), baseConfig);
  writeFileSync(path.join(root, 'vite-helper.ts'), 'export const port = 5173;');
  writeFileSync(path.join(root, 'vite.renderer.config.ts'), "import { port } from './vite-helper'; export default () => ({ envDir: true, server: { port, host: true, strictPort: false } });");
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('isolated worktree development', () => {
  it('opts into Hosted with service-scoped isolation and matching renderer, native and CSP configuration', () => {
    const root = fixture();
    writeFileSync(path.join(root, '.env.local'), 'DRIFTING_HOSTED_ORIGIN=https://service.example.test\nVITE_LOCAL_ONLY_MODE=true\n');
    const local = createWorktreePlan({ root, baseEnvironment: {} });
    const hosted = createWorktreePlan({ root, online: true, baseEnvironment: {} });
    const other = createWorktreePlan({ root, online: true, baseEnvironment: { DRIFTING_HOSTED_ORIGIN: 'https://other.example.test' } });
    expect(parseWorktreeArguments(['--online']).online).toBe(true);
    expect(hosted.manifest.mode).toBe('hosted');
    expect(hosted.manifest.profileId).not.toBe(local.manifest.profileId);
    expect(other.manifest.profileId).not.toBe(hosted.manifest.profileId);
    expect(hosted.environment).toMatchObject({ VITE_LOCAL_ONLY_MODE: 'false',
      DRIFTING_HOSTED_ORIGIN: 'https://service.example.test', VITE_API_BASE_URL: 'https://service.example.test' });
    expect(hosted.tauriConfig.app.security.devCsp).toContain('https://service.example.test');
  });
  it('keeps stable profiles per canonical checkout and separates checkouts and instances', () => {
    const root = fixture();
    const a = createWorktreePlan({ root, baseEnvironment: {} });
    const again = createWorktreePlan({ root, baseEnvironment: {} });
    const b = createWorktreePlan({ root: fixture(), baseEnvironment: {} });
    const peer = createWorktreePlan({ root, instance: 'peer', baseEnvironment: {} });
    expect(again.manifest).toEqual(a.manifest);
    for (const other of [b, peer]) {
      for (const field of ['profileId', 'databaseDirectory', 'identifier', 'keychainService', 'cargoTargetDirectory']) {
        expect(other.manifest[field]).not.toBe(a.manifest[field]);
      }
      expect(other.tauriConfig.app.windows[0].dataDirectory).not.toEqual(a.tauriConfig.app.windows[0].dataDirectory);
    }
    const alias = path.join(root, 'checkout-alias');
    symlinkSync(root, alias, 'dir');
    expect(createWorktreePlan({ root: alias, baseEnvironment: {} }).manifest).toEqual(a.manifest);
    expect(path.isAbsolute(a.environment.DRIFTING_DB_DIR)).toBe(true);
  });

  it('refuses shared state aliases instead of following symlinked data directories', () => {
    const root = fixture();
    symlinkSync(fixture(), path.join(root, '.local-data'), 'dir');
    expect(() => createWorktreePlan({ root, baseEnvironment: {} })).toThrow(/refuses a symlink/);
  });

  it('does not let shell or dotenv settings escape isolation or expose secrets in its manifest', () => {
    const root = fixture();
    writeFileSync(path.join(root, '.env.local'), 'DRIFTING_DB_DIR=/synthetic/shared\nVITE_PRIVATE_TOKEN=synthetic-secret\nDRIFTING_MACOS_DEV_SIGNING_IDENTITY=synthetic-signing\n');
    const plan = createWorktreePlan({ root, baseEnvironment: {
      DRIFTING_DB_DIR: '/synthetic/also-shared', CARGO_TARGET_DIR: '/synthetic/target',
      DRIFTING_HOSTED_ORIGIN: 'https://example.test', VITE_LOCAL_ONLY_MODE: 'false',
      TAURI_CONFIG: '{"identifier":"cc.drifting.client"}', TAURI_DEV_HOST: '192.0.2.1',
      CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: '/synthetic/runner',
      VITE_DRIFTING_FRONTEND_DEBUG_URL: 'http://127.0.0.1:4318',
    } });
    expect(plan.environment.DRIFTING_DB_DIR).toBe(plan.manifest.databaseDirectory);
    expect(plan.environment.CARGO_TARGET_DIR).toBe(plan.manifest.cargoTargetDirectory);
    expect(plan.environment.VITE_LOCAL_ONLY_MODE).toBe('true');
    expect(plan.environment.DRIFTING_MACOS_DEV_SIGNING_IDENTITY).toBe('synthetic-signing');
    expect(plan.environment.DRIFTING_MACOS_DEV_CODE_IDENTIFIER).toBe(plan.manifest.identifier);
    expect(plan.environment.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER).toBe(path.join(plan.manifest.worktreeRoot, 'scripts/run-signed-macos-dev.sh'));
    for (const key of ['VITE_PRIVATE_TOKEN', 'DRIFTING_HOSTED_ORIGIN', 'TAURI_CONFIG', 'TAURI_DEV_HOST', 'VITE_DRIFTING_FRONTEND_DEBUG_URL']) expect(plan.environment[key]).toBeUndefined();
    expect(JSON.stringify(plan.manifest)).not.toContain('synthetic-secret');
    expect(JSON.stringify(plan.manifest)).not.toContain('synthetic-signing');
  });

  it('binds frontend URL, port, CSP and a separate WebView store to the same profile', () => {
    const root = fixture();
    const plan = createWorktreePlan({ root, port: 25173, platform: 'darwin', baseEnvironment: {} });
    expect(plan.tauriConfig.build.devUrl).toBe('http://127.0.0.1:25173');
    expect(plan.environment.DRIFTING_VITE_PORT).toBe('25173');
    expect(plan.tauriConfig.app.security.devCsp).toContain('ws://127.0.0.1:25173');
    expect(plan.tauriConfig.app.windows[0].dataStoreIdentifier).toBeUndefined();
    expect(plan.tauriConfig.app.windows[0].incognito).toBe(true);
    expect(plan.tauriConfig.plugins['deep-link'].desktop.schemes).not.toContain('drifting');
    expect(createWorktreePlan({ root, platform: 'linux', baseEnvironment: {} }).tauriConfig.app.windows[0].incognito).toBe(false);
  });

  it('persists different synthetic SQLite contents without cross-checkout or peer writes', () => {
    const root = fixture();
    const plans = [createWorktreePlan({ root }), createWorktreePlan({ root: fixture() }), createWorktreePlan({ root, instance: 'peer' })];
    for (const [index, plan] of plans.entries()) {
      mkdirSync(plan.manifest.databaseDirectory, { recursive: true });
      const db = new DatabaseSync(path.join(plan.manifest.databaseDirectory, 'synthetic.db'));
      try {
        db.exec('CREATE TABLE probe (value TEXT)');
        db.prepare('INSERT INTO probe VALUES (?)').run(`synthetic-${index}`);
      } finally { db.close(); }
    }
    for (const [index, plan] of plans.entries()) {
      const db = new DatabaseSync(path.join(plan.manifest.databaseDirectory, 'synthetic.db'));
      try { expect(db.prepare('SELECT value FROM probe').all()).toEqual([{ value: `synthetic-${index}` }]); }
      finally { db.close(); }
    }
  });

  it('keeps JSON inspection read-only and does not launch or check signing', async () => {
    const root = fixture();
    const output = vi.fn();
    const spawnProcess = vi.fn();
    const prepareSigning = vi.fn();
    const checkPort = vi.fn();
    await runWorktreeDev(['--', '--print-config'], { root, baseEnvironment: {}, output, spawnProcess, prepareSigning, checkPort });
    expect(JSON.parse(output.mock.calls[0][0]).mode).toBe('local-only');
    expect(existsSync(path.join(root, '.local-data'))).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(prepareSigning).not.toHaveBeenCalled();
    expect(checkPort).not.toHaveBeenCalled();
  });

  it('delivers isolated config and environment to Tauri and generates a loadable Vite config', async () => {
    const root = fixture();
    const child = new EventEmitter();
    const signals = new EventEmitter();
    const spawnProcess = vi.fn(() => { setImmediate(() => child.emit('close', 0, null)); return child; });
    await runWorktreeDev(['--instance', 'editor', '--port', '25174', '--no-watch'], {
      root, baseEnvironment: {}, output: vi.fn(), spawnProcess, signals,
      prepareSigning: vi.fn(), checkPort: vi.fn(),
    });
    const plan = createWorktreePlan({ root, instance: 'editor', port: 25174, noWatch: true, baseEnvironment: {} });
    expect(spawnProcess).toHaveBeenCalledWith(plan.command, plan.args, expect.objectContaining({ cwd: plan.manifest.worktreeRoot, env: plan.environment }));
    expect(plan.args).toContain('--no-watch');
    expect(JSON.parse(readFileSync(plan.manifest.configPath, 'utf8'))).toEqual(plan.tauriConfig);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, plan.viteConfigPath, root);
    expect(loaded?.config.envDir).toBe(false);
    expect(loaded?.config.server).toMatchObject({ host: '127.0.0.1', port: 25174, strictPort: true });
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('fails on an occupied port instead of attaching to another frontend', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    try { await expect(assertWorktreePortAvailable(address.port)).rejects.toThrow(/unavailable.*--port/); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    await expect(assertWorktreePortAvailable(address.port)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('stops its owned process group when automation sends SIGTERM', async () => {
    const root = fixture();
    const signals = new EventEmitter();
    const marker = path.join(root, 'synthetic-child-stopped');
    const grandchildSource = `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`;
    const childSource = `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {stdio: ['ignore', 'pipe', 'ignore']}); child.stdout.pipe(process.stdout); setInterval(() => {}, 1000);`;
    let ownedChild: ReturnType<typeof spawn> | undefined;
    const spawnProcess = () => {
      ownedChild = spawn(process.execPath, ['-e', childSource], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      ownedChild.stdout!.once('data', () => signals.emit('SIGTERM'));
      return ownedChild;
    };
    try {
      await runWorktreeDev([], { root, baseEnvironment: {}, signals, spawnProcess, output: vi.fn(), checkPort: vi.fn(), prepareSigning: vi.fn() });
      expect(readFileSync(marker, 'utf8')).toBe('stopped');
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    } finally {
      if (ownedChild?.pid) {
        try { process.kill(-ownedChild.pid, 'SIGKILL'); }
        catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
      }
    }
  });

  it('propagates a failed Tauri launch and removes signal handlers', async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter();
    await expect(runWorktreeDev([], {
      root: fixture(), baseEnvironment: {}, signals, output: vi.fn(), checkPort: vi.fn(), prepareSigning: vi.fn(),
      spawnProcess: () => { setImmediate(() => child.emit('close', 17, null)); return child; },
    })).rejects.toThrow(/exited with 17/);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it.each([['--instance', '../escape'], ['--port', '5173oops'], ['--port', '80'], ['--port', '65536'], ['--config', 'other.json'], ['--instance']])('rejects invalid or isolation-breaking arguments %j', (...args) => {
    expect(() => parseWorktreeArguments(args)).toThrow();
  });
});
