/**
 * Claude Agent SDK runtime helpers: locate the native `claude` binary, repair
 * ~/.claude.json before spawning, and build the subprocess environment.
 *
 * The SDK (since 0.2.113) spawns a per-platform native binary shipped as an
 * optional dependency (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`).
 * In dev it lives in node_modules; packaged it must be asar-unpacked.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app } from 'electron';

function platformPkg(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `claude-agent-sdk-darwin-${arch}`;
  if (process.platform === 'win32') return `claude-agent-sdk-win32-${arch}`;
  if (process.platform === 'linux') return `claude-agent-sdk-linux-${arch}`;
  return null;
}

function binaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * Absolute path to the native `claude` executable, or undefined if not found
 * (the SDK would then fall back to its own node_modules auto-discovery).
 */
export function resolveClaudeBinary(): string | undefined {
  const pkg = platformPkg();
  if (!pkg) return undefined;
  const rel = join('node_modules', '@anthropic-ai', pkg, binaryName());

  const candidates: string[] = [join(process.cwd(), rel)];
  try {
    candidates.push(join(app.getAppPath(), rel));
  } catch {
    /* app path unavailable before ready — ignore */
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', rel));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const UTF8_BOM = '﻿';
let configChecked = false;

/**
 * Ensure ~/.claude.json is present and valid JSON before the SDK subprocess
 * reads it. A missing/empty/BOM-prefixed/corrupt file makes the CLI print
 * plain text to stdout, which breaks the SDK's JSON transport. Runs once per
 * process. (Ported from the craft-agents Apache-2.0 project.)
 */
export function ensureClaudeConfig(): void {
  if (configChecked) return;
  configChecked = true;

  const configPath = join(homedir(), '.claude.json');
  try {
    if (!existsSync(configPath)) {
      writeFileSync(configPath, '{}', 'utf-8');
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const content = raw.startsWith(UTF8_BOM) ? raw.slice(1) : raw;
    if (content.trim().length === 0) {
      writeFileSync(configPath, '{}', 'utf-8');
      return;
    }
    JSON.parse(content); // throws if corrupt
    if (raw !== content) {
      // Had a BOM but is otherwise valid — rewrite without it.
      writeFileSync(configPath, content, 'utf-8');
    }
  } catch {
    // Corrupt JSON — reset to a minimal valid file.
    try {
      writeFileSync(configPath, '{}', 'utf-8');
    } catch (err) {
      console.error('[agent] failed to repair ~/.claude.json', err);
    }
  }
}

/**
 * Build the subprocess env for the Claude binary. Forces the OAuth path by
 * removing any API key and injecting the OAuth token.
 */
export function buildAgentEnv(oauthToken: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'drifting/1.0';
  return env;
}
