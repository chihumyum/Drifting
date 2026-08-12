#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const coreDir = path.resolve(path.dirname(scriptPath), '..');
const outputDir = await mkdtemp(path.join(tmpdir(), 'drifting-frontend-release-'));
const forbidden = [
  '__DRIFTING_FRONTEND_DEBUG_V1__',
  'VITE_DRIFTING_FRONTEND_DEBUG_TOKEN',
  '/renderer/next',
  '127.0.0.1:4318',
];

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(target)));
    else output.push(target);
  }
  return output;
}

try {
  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      pnpmExecutable,
      [
        'exec',
        'vite',
        'build',
        '--config',
        'vite.renderer.config.ts',
        '--outDir',
        outputDir,
        '--emptyOutDir',
      ],
      {
        cwd: coreDir,
        env: {
          ...process.env,
          VITE_API_BASE_URL: 'https://api.drifting.cc',
          VITE_REQUIRE_AUTH: 'true',
          VITE_AI_TRANSPORT: 'proxy',
        },
        stdio: 'inherit',
      },
    );
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    child.once('error', reject);
  });
  if (code !== 0) throw new Error(`Release renderer build failed with code ${code}`);
  for (const file of await filesUnder(outputDir)) {
    if (!/\.(?:js|html|css)$/u.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const marker of forbidden) {
      if (source.includes(marker)) {
        throw new Error(`Release renderer contains frontend Debug marker ${marker} in ${file}`);
      }
    }
  }
  process.stdout.write(
    'Release renderer contains no frontend Debug registry, token, bridge, or loopback marker.\n',
  );
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
