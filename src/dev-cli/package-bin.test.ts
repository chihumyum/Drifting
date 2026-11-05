import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error Executable tooling intentionally lives outside the TS graph.
import { packageBinEntry, packageBinInvocation, pnpmInvocation } from '../../scripts/package-bin.mjs';
// @ts-expect-error Executable tooling intentionally lives outside the TS graph.
import { createWorktreePlan } from '../../scripts/run-worktree-dev.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
// The plans below never read the checkout's Agent keys.
const noKeys = { DRIFTING_DEV_AGENT_KEYS: '0' };

describe('developer tools started without a shell (docs/windows.md)', () => {
  it('keeps pnpm exec outside Windows', () => {
    expect(packageBinInvocation('vite', { platform: 'darwin' })).toEqual({ executable: 'pnpm', arguments: ['exec', 'vite'] });
    expect(pnpmInvocation({ platform: 'linux' })).toEqual({ executable: 'pnpm', arguments: [] });
  });

  it.each([
    ['tauri', /node_modules[\\/]@tauri-apps[\\/]cli[\\/]tauri\.js$/u],
    ['vite', /node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/u],
    ['tsx', /node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/u],
    ['vitest', /node_modules[\\/]vitest[\\/]vitest\.mjs$/u],
  ])('runs the installed %s entry script with Node on Windows', (tool, entry) => {
    const invocation = packageBinInvocation(tool, { root, platform: 'win32', nodeExecutable: 'C:\\node\\node.exe' });
    expect(invocation.executable).toBe('C:\\node\\node.exe');
    expect(invocation.arguments).toHaveLength(1);
    expect(invocation.arguments[0]).toMatch(entry);
    expect(existsSync(invocation.arguments[0])).toBe(true);
  });

  it('names a missing package instead of starting nothing', () => {
    expect(() => packageBinEntry('no-such-tool', { root })).toThrow(/no-such-tool is not installed/u);
  });

  it('finds the pnpm that runs the script, then Corepack, then a global install on Windows', () => {
    const nodeExecutable = 'C:\\node\\node.exe';
    const corepack = 'C:\\node\\node_modules\\corepack\\dist\\pnpm.js';
    const globalPnpm = 'C:\\Users\\synthetic\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs';
    const running = 'C:\\Users\\synthetic\\.cache\\pnpm\\bin\\pnpm.cjs';
    const environment = { npm_execpath: running, APPDATA: 'C:\\Users\\synthetic\\AppData\\Roaming' };
    const resolve = (available: string[], env: Record<string, string> = environment) =>
      pnpmInvocation({ platform: 'win32', environment: env, nodeExecutable, exists: (file: string) => available.includes(file) });
    expect(resolve([running, corepack, globalPnpm])).toEqual({ executable: nodeExecutable, arguments: [running] });
    expect(resolve([corepack, globalPnpm])).toEqual({ executable: nodeExecutable, arguments: [corepack] });
    expect(resolve([globalPnpm])).toEqual({ executable: nodeExecutable, arguments: [globalPnpm] });
    // npm's own entry script is not pnpm.
    expect(resolve([corepack], { npm_execpath: 'C:\\npm\\bin\\npm-cli.js' })).toEqual({ executable: nodeExecutable, arguments: [corepack] });
    expect(resolve(['C:\\pnpm\\pnpm.exe'], { npm_execpath: 'C:\\pnpm\\pnpm.exe' })).toEqual({ executable: 'C:\\pnpm\\pnpm.exe', arguments: [] });
    expect(() => resolve([])).toThrow(/corepack enable/u);
  });

  it('starts an isolated Windows profile through the Tauri CLI entry script of that checkout', () => {
    const windows = createWorktreePlan({ root, platform: 'win32', noWatch: true, baseEnvironment: noKeys });
    expect(windows.command).toBe(process.execPath);
    expect(windows.args[0]).toBe(path.join(realpathSync(root), 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
    expect(windows.args.slice(1)).toEqual(['dev', '--no-watch', '--config', windows.manifest.configPath]);
    const mac = createWorktreePlan({ root, platform: 'darwin', noWatch: true, baseEnvironment: noKeys });
    expect(mac.command).toBe('pnpm');
    expect(mac.args).toEqual(['exec', 'tauri', 'dev', '--no-watch', '--config', mac.manifest.configPath]);
  });
});
