import { spawnSync } from 'node:child_process';
const options = process.argv.slice(2);
for (const [script, extra] of [
  ['benchmark-database-transport.ts', ['--portable']],
  ['benchmark-rust-cold-prose.ts', []],
  ['benchmark-rust-search-corpus.ts', []],
  ['benchmark-rust-archive.ts', []],
  ['benchmark-rust-export.ts', []],
]) {
  const result = spawnSync(process.execPath, ['--expose-gc', '--conditions=import', '--import=tsx', `scripts/${script}`, ...extra, ...options], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
