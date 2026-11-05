// How developer scripts start a dependency's command-line tool, and pnpm
// itself, without a shell (docs/windows.md, "Developing on Windows").
//
// Elsewhere they run `pnpm exec <tool>` as before. On Windows the tools are
// `.cmd` shims: Node refuses to spawn those without a shell (EINVAL), and a
// shell would re-split paths that contain spaces. So on Windows Node runs the
// package's own entry script, named by the `bin` field of its package.json.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The package that provides each tool, where the names differ. */
const TOOL_PACKAGES = { tauri: '@tauri-apps/cli' };

/** The entry script of `tool` installed in `root`'s node_modules. */
export function packageBinEntry(tool, { root = repoDir } = {}) {
  const packageName = TOOL_PACKAGES[tool] ?? tool;
  const packageDirectory = path.join(root, 'node_modules', ...packageName.split('/'));
  const manifestPath = path.join(packageDirectory, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${packageName} is not installed in ${root}; run pnpm install --frozen-lockfile`);
  }
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin?.[tool];
  if (typeof entry !== 'string') throw new Error(`${packageName} has no ${tool} executable`);
  return path.join(packageDirectory, entry);
}

/** `{ executable, arguments }` that start `tool`; append the tool's own arguments. */
export function packageBinInvocation(tool, {
  root = repoDir, platform = process.platform, nodeExecutable = process.execPath,
} = {}) {
  if (platform === 'win32') {
    return { executable: nodeExecutable, arguments: [packageBinEntry(tool, { root })] };
  }
  return { executable: 'pnpm', arguments: ['exec', tool] };
}

/**
 * `{ executable, arguments }` that start pnpm. On Windows: the pnpm that runs
 * this script (`npm_execpath` under `pnpm run`), else Corepack's pnpm beside
 * Node, else a global `npm install -g pnpm`.
 */
export function pnpmInvocation({
  platform = process.platform, environment = process.env, nodeExecutable = process.execPath,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') return { executable: 'pnpm', arguments: [] };
  const running = environment.npm_execpath ?? '';
  const runningName = path.win32.basename(running).toLowerCase();
  // The standalone pnpm is a real executable, which Node can spawn directly.
  if (runningName === 'pnpm.exe' && exists(running)) return { executable: running, arguments: [] };
  const candidates = [
    /^pnpm\.[cm]?js$/u.test(runningName) ? running : null,
    path.win32.join(path.win32.dirname(nodeExecutable), 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    environment.APPDATA ? path.win32.join(environment.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') : null,
  ].filter(Boolean);
  const entry = candidates.find((candidate) => exists(candidate));
  if (!entry) {
    throw new Error('Could not find pnpm\'s entry script; enable it with `corepack enable` (docs/windows.md).');
  }
  return { executable: nodeExecutable, arguments: [entry] };
}
