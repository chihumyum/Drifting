import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createServer } from 'vite';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Optional development tooling is native ESM outside the renderer graph.
import { nativePerformanceAuditPlugin } from '../../../scripts/native-performance-audit-plugin.mjs';

describe('native development performance audit', () => {
  it('keeps its control endpoint private and accepts only authenticated bounded telemetry', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'drifting-perf-audit-'));
    const plugin = nativePerformanceAuditPlugin({ directory, origin: 'http://127.0.0.1' });
    const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [plugin], server: { host: '127.0.0.1', port: 0 } });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const endpoint = `http://127.0.0.1:${address.port}/__drifting_performance_audit__`;
      const { token } = JSON.parse(readFileSync(path.join(directory, 'control.json'), 'utf8'));
      expect((await fetch(`${endpoint}/status`)).status).toBe(403);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      expect((await fetch(`${endpoint}/status`, { headers: { ...headers, Origin: 'https://unexpected.example' } })).status).toBe(403);
      expect((await fetch(`${endpoint}/mark`, { method: 'POST', headers, body: JSON.stringify({ marker: 'materials-search-1' }) })).status).toBe(200);
      expect((await fetch(`${endpoint}/mark`, { method: 'POST', headers, body: JSON.stringify({ marker: '/private/path' }) })).status).toBe(400);
      expect((await fetch(`${endpoint}/samples`, { method: 'POST', headers, body: JSON.stringify({ at: 123, dom: { elements: 20 } }) })).status).toBe(200);
      const status = await (await fetch(`${endpoint}/status`, { headers })).json();
      expect(status).toMatchObject({ marker: 'materials-search-1', samples: 1, latest: { dom: { elements: 20 } } });
      expect(JSON.parse(readFileSync(path.join(directory, 'samples.jsonl'), 'utf8'))).toMatchObject({ marker: 'materials-search-1', at: 123 });
      expect(plugin.apply).toBe('serve');
      expect(plugin.transform('app source', '/repo/src/renderer/main.tsx')).toMatch(/^import '\/scripts\/native-performance-audit-probe';/);
      expect(plugin.transform('other source', '/repo/src/renderer/App.tsx')).toBeNull();
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves IPC values/errors without collecting arguments, result text or input keys', async () => {
    const source = readFileSync(new URL('../../../scripts/native-performance-audit-probe.ts', import.meta.url), 'utf8');
    const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
    let now = 0;
    let tick: () => void = () => {};
    const bodies: string[] = [];
    const listeners = new Map<string, () => void>();
    const frames: (() => void)[] = [];
    const failed = new Error('synthetic rejection');
    const tauri = { invoke: async (command: string) => {
      if (command === 'failure') throw failed;
      return ['synthetic-private-result'];
    } };
    const original = tauri.invoke;
    const module = { exports: {} as { installNativePerformanceAudit: (config: object) => void } };
    const context = {
      module, exports: module.exports, window: { __TAURI_INTERNALS__: tauri, addEventListener() {} },
      crypto: { randomUUID: () => 'synthetic-session' }, performance: { now: () => now },
      document: { documentElement: {}, visibilityState: 'visible', hasFocus: () => true, addEventListener(kind: string, callback: () => void) { listeners.set(kind, callback); },
        getElementsByTagName: () => [], querySelectorAll: () => [] },
      MutationObserver: class { observe() {} }, requestAnimationFrame(callback: () => void) { frames.push(callback); },
      setInterval(fn: () => void) { tick = fn; },
      fetch: async (_endpoint: string, options: { body: string }) => { bodies.push(options.body); },
    };
    runInNewContext(code, context);
    module.exports.installNativePerformanceAudit({ endpoint: '/private-collector', token: 'synthetic-token' });
    const instrumented = tauri.invoke;
    module.exports.installNativePerformanceAudit({ endpoint: '/duplicate', token: 'ignored' });
    expect(tauri.invoke).toBe(instrumented);
    expect(tauri.invoke).not.toBe(original);
    expect(await tauri.invoke('rows')).toEqual(['synthetic-private-result']);
    await expect(tauri.invoke('failure')).rejects.toBe(failed);
    now = 2001; tick();
    const data = JSON.parse(bodies[0]);
    expect(data.ipc).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'rows', calls: 1, rows: 1, failures: 0 }),
      expect.objectContaining({ command: 'failure', calls: 1, failures: 1 }),
    ]));
    expect(bodies[0]).not.toContain('synthetic-private-result');
    expect(data.inFlight).toBe(0);
    expect(data.supportedEntries).toEqual([]);
    // A pending input must not turn a background/locked interval into latency.
    await Promise.resolve(); await Promise.resolve();
    listeners.get('keydown')!();
    frames[1]();
    context.document.visibilityState = 'hidden'; listeners.get('visibilitychange')!();
    now = 10000; frames[2]();
    context.document.visibilityState = 'visible'; listeners.get('visibilitychange')!();
    listeners.get('keydown')!(); frames[3]();
    now = 10033; frames[4]();
    now = 12001; tick();
    const resumed = JSON.parse(bodies[1]);
    expect(resumed.inputToTwoRaf).toMatchObject({ count: 1, max: 33 });
    expect(resumed.nativeProcesses).toBeNull();
    expect(bodies[1]).not.toContain('synthetic-private-result');
  });
});
