// The Node side of the promo recording rig (rig.swift): builds the binary when
// its source is newer, starts it, and sends it one command at a time.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
export const BIN_DIRECTORY = path.join(root, 'out', 'promo-recording', 'bin');

/** Compiles a Swift tool of this directory into out/promo-recording/bin when its source changed. */
export function buildSwiftTool(name: 'rig' | 'compose'): string {
  const source = path.join(here, `${name}.swift`);
  const binary = path.join(BIN_DIRECTORY, `promo-${name}`);
  if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
    mkdirSync(BIN_DIRECTORY, { recursive: true });
    console.log(`[promo] compiling ${path.relative(root, source)}`);
    execFileSync('swiftc', ['-O', '-parse-as-library', '-suppress-warnings', source, '-o', binary], { stdio: 'inherit' });
  }
  return binary;
}

/**
 * Node's monotonic seconds. The rig stamps with the host time clock, which
 * stops while the Mac sleeps and this one does not: `Rig.syncClock` measures
 * the difference, and `Rig.now` reads the rig's clock.
 */
const nodeNow = () => Number(process.hrtime.bigint()) / 1e9;

type Reply = Record<string, unknown> & { id: number; ok?: boolean; error?: string };

export class Rig {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  private exited = false;

  constructor(binary: string, eventLog: string) {
    this.child = spawn(binary, ['--log', eventLog], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let reply: Reply;
      try { reply = JSON.parse(line) as Reply; } catch { return; }
      const waiter = this.waiting.get(reply.id);
      if (!waiter) return;
      this.waiting.delete(reply.id);
      if (reply.error) waiter.reject(new Error(`rig: ${reply.error}`));
      else waiter.resolve(reply);
    });
    this.child.stderr.on('data', (chunk) => process.stderr.write(`[rig] ${chunk}`));
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const waiter of this.waiting.values()) waiter.reject(new Error(`The rig exited (${code})`));
      this.waiting.clear();
    });
  }

  private offset = 0;

  /** Measures the rig's clock against Node's from the quickest of a few round trips. */
  async syncClock(): Promise<{ offset: number; roundTrip: number }> {
    let best = { offset: 0, roundTrip: Infinity };
    for (let index = 0; index < 8; index += 1) {
      const before = nodeNow();
      const { t } = await this.send('hello') as Reply & { t: number };
      const after = nodeNow();
      if (after - before < best.roundTrip) best = { offset: t - (before + after) / 2, roundTrip: after - before };
    }
    this.offset = best.offset;
    return best;
  }

  /** The rig's clock (host time seconds), as its events and frames are stamped. */
  now(): number {
    return nodeNow() + this.offset;
  }

  send(cmd: string, input: Record<string, unknown> = {}): Promise<Reply> {
    if (this.exited) return Promise.reject(new Error('The rig has exited'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...input })}\n`);
    });
  }

  async quit(): Promise<void> {
    if (this.exited) return;
    try { await this.send('quit'); } catch { /* it exits as it answers */ }
  }
}
