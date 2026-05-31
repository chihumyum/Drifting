#!/usr/bin/env node
/**
 * Fetch the platform-matching Claude Agent SDK native `claude` binary into
 * node_modules — a `pnpm install` replacement for the SDK's per-platform
 * binary package.
 *
 * WHY THIS EXISTS
 * ---------------
 * The SDK ships its CLI as a single ~206MB native executable per platform
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). `pnpm install` OOMs in
 * a worker thread while hashing that file into its content-addressable store
 * (the hash path materialises the 206MB content as a JS string + UTF-8
 * conversion and hits V8's max single-allocation limit — "invalid array
 * length"; raising the heap doesn't help because it's a length cap, not a
 * memory cap, and it's a worker isolate anyway).
 *
 * So we list all 8 binary packages in the workspace root
 * `pnpm.ignoredOptionalDependencies`, which makes pnpm skip fetching/hashing
 * them entirely, and this script downloads + extracts only the one matching
 * the current machine via `npm pack` + `tar` (the big file is never hashed by
 * Node, so there is no OOM).
 *
 * Wired as `postinstall`. Idempotent: skips when the correct-version binary is
 * already present. Run manually with `pnpm run claude:fetch-binary`.
 */
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCOPE = '@anthropic-ai';
const SDK_PKG = 'claude-agent-sdk';

// scripts/fetch-claude-binary.mjs -> 
const coreRoot = join(fileURLToPath(import.meta.url), '..', '..');
const nodeModules = join(coreRoot, 'node_modules');

function log(msg) {
  console.log(`[fetch-claude-binary] ${msg}`);
}

/** glibc vs musl (Alpine). glibcVersionRuntime is only present on glibc. */
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const report =
      typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
    return !(report && report.header && report.header.glibcVersionRuntime);
  } catch {
    return false;
  }
}

function platformPkgName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `${SDK_PKG}-darwin-${arch}`;
  if (process.platform === 'win32') return `${SDK_PKG}-win32-${arch}`;
  if (process.platform === 'linux') return `${SDK_PKG}-linux-${arch}${isMusl() ? '-musl' : ''}`;
  return null;
}

function binaryName() {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const sdkManifest = join(nodeModules, SCOPE, SDK_PKG, 'package.json');
  if (!existsSync(sdkManifest)) {
    log(`${SCOPE}/${SDK_PKG} is not installed; nothing to do.`);
    return;
  }
  const version = readJson(sdkManifest).version;

  const pkg = platformPkgName();
  if (!pkg) {
    log(`unsupported platform ${process.platform}/${process.arch}; skipping.`);
    return;
  }

  const destDir = join(nodeModules, SCOPE, pkg);
  const binPath = join(destDir, binaryName());

  // Idempotent: already present at the matching version?
  if (existsSync(binPath) && existsSync(join(destDir, 'package.json'))) {
    try {
      if (readJson(join(destDir, 'package.json')).version === version) {
        log(`${pkg}@${version} already present; skipping.`);
        return;
      }
      log(`version mismatch; refetching ${pkg}@${version}.`);
    } catch {
      /* unreadable manifest — refetch */
    }
  }

  const spec = `${SCOPE}/${pkg}@${version}`;
  log(`fetching ${spec} …`);
  const tmp = mkdtempSync(join(tmpdir(), 'casdk-'));
  try {
    // `npm pack` downloads the tarball respecting .npmrc registry/auth. It does
    // NOT decompress + hash the inner 206MB file, so it avoids the pnpm OOM.
    execFileSync('npm', ['pack', spec, '--pack-destination', tmp, '--loglevel', 'warn'], {
      stdio: 'inherit',
    });
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no .tgz');

    mkdirSync(destDir, { recursive: true });
    // Tarballs are laid out under `package/…`; strip that leading component.
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', destDir, '--strip-components=1'], {
      stdio: 'inherit',
    });

    if (process.platform !== 'win32') {
      execFileSync('chmod', ['+x', binPath]);
    }
    if (!existsSync(binPath)) {
      throw new Error(`binary missing after extract: ${binPath}`);
    }
    log(`installed ${pkg}@${version}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
