import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const rendererFingerprintVersion = 2;

/** Include tracked additions, local additions, JSON and shared source dependencies. */
export function rendererSourceFingerprint(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'src', 'packages', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'scripts/run-renderer-performance.mjs', 'scripts/check-renderer-performance.mjs',
    'scripts/renderer-performance-source.mjs', 'scripts/renderer-performance.html',
    'vite-plugins/deferred-entry.ts',
  ], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file && existsSync(path.join(root, file)));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  return hash([...new Set(files)].sort().map(file => `${file}\0${hash(readFileSync(path.join(root, file)))}`).join('\n'));
}
