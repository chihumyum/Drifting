import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromFile } from 'vite';

// @ts-expect-error Executable tooling intentionally lives outside the renderer TS graph.
import { createWorktreePlan, parseWorktreeArguments, runWorktreeDev, assertWorktreePortAvailable, worktreeAppLocalDataRoot } from '../../../scripts/run-worktree-dev.mjs';
// @ts-expect-error Executable tooling intentionally lives outside the renderer TS graph.
import { isLinkedGitWorktree, shouldIsolateDevelopment } from '../../../scripts/run-desktop-tauri.mjs';
// @ts-expect-error Executable tooling intentionally lives outside the renderer TS graph.
import { LOCAL_LIBRARY_DATABASE, runSeededDev, seededArguments, SEED_INSTANCE, LITE_SEED_INSTANCE } from '../../../scripts/run-seeded-dev.mjs';
// @ts-expect-error Executable tooling intentionally lives outside the renderer TS graph.
import { devAgentKeyEnvironment, devAgentKeyRoots, describeDevAgentKeys } from '../../../scripts/dev-agent-keys.mjs';

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
  it('builds a distinct signed macOS package with embedded assets and a persistent private WebView', async () => {
    const root = fixture();
    const environment = { VITE_SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@errors.example.test/42',
      DRIFTING_HOSTED_ORIGIN: 'https://service.example.test', DRIFTING_SENTRY_PACKAGED_ACCEPTANCE: '1' };
    const plan = createWorktreePlan({ root, buildApp: true, online: true, platform: 'darwin', baseEnvironment: environment });
    const dev = createWorktreePlan({ root, online: true, platform: 'darwin', baseEnvironment: environment });
    expect(plan.manifest.identifier).not.toBe(dev.manifest.identifier);
    expect(plan.manifest.databaseDirectory).toContain(plan.manifest.identifier);
    expect(plan.manifest.appBundlePath).toMatch(/debug\/bundle\/macos\/Drifting Test [a-f0-9]+\.app$/);
    expect(plan.tauriConfig.build).toMatchObject({ devUrl: null, beforeDevCommand: null,
      frontendDist: plan.manifest.frontendDirectory });
    expect(plan.tauriConfig.app.windows[0].incognito).toBe(false);
    expect(plan.tauriConfig.app.security.csp).toContain('https://errors.example.test');
    expect(plan.tauriConfig.bundle.createUpdaterArtifacts).toBe(false);
    expect(plan.args).toEqual(['exec', 'tauri', 'build', '--debug', '--bundles', 'app', '--config', plan.manifest.configPath]);
    expect(plan.environment.DRIFTING_SENTRY_PACKAGED_ACCEPTANCE).toBe('1');
    expect(dev.environment.DRIFTING_SENTRY_PACKAGED_ACCEPTANCE).toBeUndefined();
    expect(parseWorktreeArguments(['--build-app']).buildApp).toBe(true);
    expect(() => createWorktreePlan({ root, buildApp: true, platform: 'linux' })).toThrow(/macOS only/);
  });

  it.each(['darwin', 'win32', 'linux'])('preserves HTML drag ownership in the %s window override', platform => {
    const plan = createWorktreePlan({ root: fixture(), baseEnvironment: {}, platform });
    expect(plan.tauriConfig.app.windows.find((window: { label: string }) => window.label === 'main').dragDropEnabled).toBe(false);
  });

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

  it('enables performance collection only for an explicitly selected development instance', () => {
    const root = fixture();
    const ordinary = createWorktreePlan({ root, baseEnvironment: {} });
    const measured = createWorktreePlan({ root, baseEnvironment: {}, performanceAudit: true });
    expect(parseWorktreeArguments(['--performance-audit']).performanceAudit).toBe(true);
    expect(ordinary.viteConfigSource).not.toContain('nativePerformanceAuditPlugin');
    expect(measured.viteConfigSource).toContain('nativePerformanceAuditPlugin');
    expect(measured.manifest.performanceAuditDirectory).toBe(path.join(measured.manifest.profileDirectory, 'performance-audit'));
    expect(measured.manifest.profileId).toBe(ordinary.manifest.profileId);
    expect(() => createWorktreePlan({ root, buildApp: true, performanceAudit: true, platform: 'darwin' })).toThrow(/development instance/);
  });

  it('hands the renderer the running desktop Frontend Debug bridge only on explicit opt-in', () => {
    const root = fixture();
    const sessionDirectory = path.join(root, '.local-data', 'frontend-debug');
    const writeSession = (session: Record<string, unknown>) => {
      mkdirSync(sessionDirectory, { recursive: true });
      writeFileSync(path.join(sessionDirectory, 'session.json'), JSON.stringify({
        schemaVersion: 1, host: '127.0.0.1', port: 4319, token: 'desktop-token', pid: process.pid,
        platform: 'desktop', transport: 'desktop-renderer-bridge', ...session,
      }));
    };
    expect(parseWorktreeArguments(['--frontend-debug']).frontendDebug).toBe(true);
    expect(() => createWorktreePlan({ root, baseEnvironment: {}, frontendDebug: true })).toThrow(/--platform desktop/);

    writeSession({});
    const ordinary = createWorktreePlan({ root, baseEnvironment: { VITE_DRIFTING_FRONTEND_DEBUG_TOKEN: 'inherited' } });
    const debug = createWorktreePlan({ root, baseEnvironment: {}, frontendDebug: true });
    // Without the flag nothing reaches the renderer, not even an inherited token.
    expect(Object.keys(ordinary.environment).filter((key) => key.startsWith('VITE_DRIFTING_FRONTEND_DEBUG'))).toEqual([]);
    expect(debug.environment).toMatchObject({
      VITE_DRIFTING_FRONTEND_DEBUG: '1',
      VITE_DRIFTING_FRONTEND_DEBUG_TRANSPORT: 'desktop-renderer-bridge',
      VITE_DRIFTING_FRONTEND_DEBUG_URL: 'http://127.0.0.1:4319',
      VITE_DRIFTING_FRONTEND_DEBUG_TOKEN: 'desktop-token',
    });
    // The bridge's port may differ from the default the base CSP allows.
    expect(debug.tauriConfig.app.security.devCsp).toMatch(/connect-src [^;]*http:\/\/127\.0\.0\.1:4319/);
    expect(ordinary.tauriConfig.app.security.devCsp).not.toContain('127.0.0.1:4319');
    expect(debug.manifest.frontendDebug).toEqual({ transport: 'desktop-renderer-bridge', url: 'http://127.0.0.1:4319' });
    expect(JSON.stringify(debug.manifest)).not.toContain('desktop-token');
    expect(debug.manifest.profileId).toBe(ordinary.manifest.profileId);
    expect(() => createWorktreePlan({ root, buildApp: true, frontendDebug: true, platform: 'darwin' })).toThrow(/development instance/);

    writeSession({ platform: 'ios', transport: 'ios-renderer-bridge' });
    expect(() => createWorktreePlan({ root, baseEnvironment: {}, frontendDebug: true })).toThrow(/belongs to ios/);
    writeSession({ pid: 2 ** 22 + 12345 });
    expect(() => createWorktreePlan({ root, baseEnvironment: {}, frontendDebug: true })).toThrow(/no longer running/);
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

  it('starts a development profile connected with the Agent keys from .env, never a packaged app', () => {
    const root = fixture();
    writeFileSync(path.join(root, '.env'), 'DEEPSEEK_API_KEY=synthetic-deepseek-key\n');
    writeFileSync(path.join(root, '.env.local'), 'OPENAI_API_KEY=synthetic-openai-key\nVITE_PRIVATE_TOKEN=synthetic-secret\n');
    const dev = createWorktreePlan({ root, baseEnvironment: {} });
    expect(dev.environment.VITE_DEEPSEEK_API_KEY).toBe('synthetic-deepseek-key');
    expect(dev.environment.VITE_OPENAI_API_KEY).toBe('synthetic-openai-key');
    expect(dev.environment.VITE_PRIVATE_TOKEN).toBeUndefined();
    expect(dev.manifest.agentKeysFromEnv).toEqual(['deepseek', 'openai']);
    expect(JSON.stringify(dev.manifest)).not.toContain('synthetic-deepseek-key');
    expect(describeDevAgentKeys(dev.environment)).toBe('Agent API keys from .env: DeepSeek, OpenAI (development only)');
    expect(describeDevAgentKeys(dev.environment)).not.toContain('synthetic');

    const packaged = createWorktreePlan({ root, buildApp: true, platform: 'darwin', baseEnvironment: {} });
    expect(packaged.environment.VITE_DEEPSEEK_API_KEY).toBeUndefined();
    expect(packaged.manifest.agentKeysFromEnv).toEqual([]);

    const off = createWorktreePlan({ root, baseEnvironment: { DRIFTING_DEV_AGENT_KEYS: '0' } });
    expect(off.environment.VITE_DEEPSEEK_API_KEY).toBeUndefined();
    const shell = createWorktreePlan({ root, baseEnvironment: { DEEPSEEK_AI_API_KEY: 'synthetic-shell-key' } });
    expect(shell.environment.VITE_DEEPSEEK_API_KEY).toBe('synthetic-shell-key');
  });

  it('reads the main checkout\'s .env from a linked worktree that has none of its own', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'drifting keys-'));
    directories.push(root);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git('init', '-q', '-b', 'main', 'main');
    writeFileSync(path.join(root, 'main/README'), 'synthetic');
    git('-C', 'main', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'add', 'README');
    git('-C', 'main', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '-m', 'synthetic');
    git('-C', 'main', 'worktree', 'add', '-q', '../linked');
    writeFileSync(path.join(root, 'main/.env'), 'DEEPSEEK_API_KEY=synthetic-main-deepseek\nOPENAI_API_KEY=synthetic-main-openai\n');
    writeFileSync(path.join(root, 'main/.env.local'), 'OPENAI_API_KEY=synthetic-main-local-openai\n');

    const linked = path.join(root, 'linked');
    const roots = devAgentKeyRoots(linked);
    expect(roots.map((directory: string) => path.basename(directory))).toEqual(['linked', 'main']);
    expect(devAgentKeyEnvironment({ roots, baseEnvironment: {} })).toEqual({
      VITE_DEEPSEEK_API_KEY: 'synthetic-main-deepseek',
      VITE_OPENAI_API_KEY: 'synthetic-main-local-openai',
    });
    // The worktree's own file comes first when it has one.
    writeFileSync(path.join(linked, '.env.local'), 'DEEPSEEK_API_KEY=synthetic-linked-deepseek\n');
    expect(devAgentKeyEnvironment({ roots, baseEnvironment: {} }).VITE_DEEPSEEK_API_KEY).toBe('synthetic-linked-deepseek');
    expect(devAgentKeyRoots(path.join(root, 'main')).map((directory: string) => path.basename(directory))).toEqual(['main']);
  });

  it('hands the Agent keys only to pnpm dev, never to a build', () => {
    const launcher = readFileSync(path.join(repoRoot, 'scripts/run-desktop-tauri.mjs'), 'utf8');
    expect(launcher).toContain("if (command === 'dev') {\n    Object.assign(environment, devAgentKeyEnvironment({ roots: devAgentKeyRoots(repoDir), baseEnvironment: environment }));");
  });

  it('isolates pnpm dev in a linked Git worktree and keeps the main checkout on the shared profile', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'drifting git-'));
    directories.push(root);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git('init', '-q', '-b', 'main', 'main');
    writeFileSync(path.join(root, 'main/README'), 'synthetic');
    git('-C', 'main', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'add', 'README');
    git('-C', 'main', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '-m', 'synthetic');
    git('-C', 'main', 'worktree', 'add', '-q', '../linked');

    expect(isLinkedGitWorktree(path.join(root, 'main'))).toBe(false);
    expect(isLinkedGitWorktree(path.join(root, 'linked'))).toBe(true);
    expect(isLinkedGitWorktree(tmpdir())).toBe(false);
    const linked = () => true;
    expect(shouldIsolateDevelopment({ command: 'dev', environment: {}, linked })).toBe(true);
    expect(shouldIsolateDevelopment({ command: 'dev', environment: { DRIFTING_DEV_SHARED_PROFILE: '1' }, linked })).toBe(false);
    expect(shouldIsolateDevelopment({ command: 'build', environment: {}, linked })).toBe(false);
    expect(shouldIsolateDevelopment({ command: 'dev', environment: {}, linked: () => false })).toBe(false);
  });

  it('seeds the seed instance once its port is free, then launches that same profile', async () => {
    const root = fixture();
    expect(SEED_INSTANCE).toBe('seed-stress-v2');
    expect(existsSync(path.join(repoRoot, 'src/dev-cli/seeds/default-project.json'))).toBe(false);
    const calls: string[] = [];
    const seed = vi.fn(({ databasePath }: { databasePath: string; appLocalDataDirectory: string; preset: string }) => {
      calls.push('seed');
      return { seeded: true, databasePath, projectId: 'synthetic-project' };
    });
    const checkPort = vi.fn(async () => { calls.push('port'); });
    const launch = vi.fn(async (_args: string[], _options: unknown) => { calls.push('launch'); });
    await runSeededDev(['--', '--no-watch'], { root, baseEnvironment: {}, seed, checkPort, launch, output: () => undefined });

    const plan = createWorktreePlan({ root, instance: SEED_INSTANCE, baseEnvironment: {} });
    expect(calls).toEqual(['port', 'seed', 'launch']);
    expect(checkPort).toHaveBeenCalledWith(plan.manifest.port);
    expect(seed.mock.calls[0][0].databasePath).toBe(path.join(plan.manifest.databaseDirectory, LOCAL_LIBRARY_DATABASE));
    expect(seed.mock.calls[0][0].appLocalDataDirectory).toBe(plan.manifest.appLocalDataDirectory);
    expect(seed.mock.calls[0][0].preset).toBe('stress');
    expect(plan.manifest.appLocalDataDirectory).toBe(path.join(worktreeAppLocalDataRoot(), plan.manifest.identifier));
    expect(launch.mock.calls[0][0]).toEqual(['--no-watch', '--instance', SEED_INSTANCE]);

    expect(seededArguments(['--instance', 'demo'])).toEqual(['--instance', 'demo']);
    expect(() => seededArguments(['--online'])).toThrow(/local-only/);
    const printed = vi.fn();
    const printOutput = vi.fn();
    await runSeededDev(['--print-config'], { root, baseEnvironment: {}, seed, checkPort, launch: printed, output: printOutput });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(printed).not.toHaveBeenCalled();
    expect(JSON.parse(printOutput.mock.calls[0][0])).toMatchObject({ seedPreset: 'stress', instance: SEED_INSTANCE });

    await runSeededDev(['--lite', '--no-watch'], { root, baseEnvironment: {}, seed, checkPort, launch, output: () => undefined });
    const litePlan = createWorktreePlan({ root, instance: LITE_SEED_INSTANCE, baseEnvironment: {} });
    expect(seed.mock.calls[1][0]).toMatchObject({ preset: 'lite', databasePath: path.join(litePlan.manifest.databaseDirectory, LOCAL_LIBRARY_DATABASE) });
    expect(litePlan.manifest.profileId).not.toBe(plan.manifest.profileId);
    expect(seededArguments(['--lite'])).toEqual(['--instance', LITE_SEED_INSTANCE]);
  });

  it('resolves native asset roots per platform and keeps instances separate', () => {
    const root = fixture();
    const first = createWorktreePlan({ root, instance: 'seed-a', platform: 'linux', baseEnvironment: { XDG_DATA_HOME: path.join(root, 'xdg') } });
    const second = createWorktreePlan({ root, instance: 'seed-b', platform: 'linux', baseEnvironment: { XDG_DATA_HOME: path.join(root, 'xdg') } });
    expect(first.manifest.appLocalDataDirectory).toBe(path.join(root, 'xdg', first.manifest.identifier));
    expect(first.manifest.appLocalDataDirectory).not.toBe(second.manifest.appLocalDataDirectory);
    expect(worktreeAppLocalDataRoot({ platform: 'win32', environment: { LOCALAPPDATA: path.join(root, 'windows') } })).toBe(path.join(root, 'windows'));
    expect(worktreeAppLocalDataRoot({ platform: 'linux', environment: { XDG_DATA_HOME: 'relative' } })).toBe(worktreeAppLocalDataRoot({ platform: 'linux', environment: {} }));
  });
});
