import { sourceErrorFrames } from '../../../scripts/native-performance-audit-probe';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createServer } from 'vite';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Optional development tooling is native ESM outside the renderer graph.
import { nativePerformanceAuditPlugin } from '../../../scripts/native-performance-audit-plugin.mjs';

describe('native development performance audit', () => {
  it('retains only bounded source locations from error stacks', () => {
    const frames = sourceErrorFrames([
      'RangeError: private manuscript and secret-token',
      'privateName@http://127.0.0.1:37510/src/renderer/example.ts?t=secret-token:21:9',
      'privateName@http://127.0.0.1:37510/node_modules/.vite/deps/editor.js?v=secret-token:99:3',
      'http://private.example/src/private.ts:1:2',
      'http://127.0.0.1:37510/assets/manuscript.md:1:2',
    ].join('\n'));
    expect(frames).toEqual(['/src/renderer/example.ts:21:9', '/node_modules/.vite/deps/editor.js:99:3']);
    expect(sourceErrorFrames(Array(50).fill('f@http://127.0.0.1:1/src/editor.ts:2:3').join('\n'))).toHaveLength(8);
  });

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
      expect(plugin.transform('<StrictMode>app source</StrictMode>', '/repo/src/renderer/main.tsx')).toMatch(/^import '\/scripts\/native-performance-audit-probe';/);
      expect(plugin.transform('<StrictMode>app source</StrictMode>', '/repo/src/renderer/main.tsx')).toContain('<AuditProfiler');
      expect(plugin.transform('export function ChapterPanel() {\n  const { t } = useTranslation();\n}', '/repo/src/renderer/components/leftBars/ChapterPanel.tsx')).toContain('__DRIFTING_PERFORMANCE_AUDIT_RENDER__?.("ChapterPanel")');
      expect(plugin.transform('other source', '/repo/src/renderer/App.tsx')).toBeNull();
      expect(plugin.resolveId('@tauri-apps/api/core')).toBe('\0native-performance-audit-tauri-core');
      expect(plugin.load('\0native-performance-audit-tauri-core')).toContain('originalInvoke(command, args, options)');
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
    let previousCommits = 0;
    const hook = { onCommitFiberRoot: (..._args: unknown[]) => { previousCommits++; } };
    const tauri = Object.freeze({ invoke: async (command: string) => {
      if (command === 'failure') throw failed;
      return ['synthetic-private-result'];
    } });
    const original = tauri.invoke;
    const module = { exports: {} as { installNativePerformanceAudit: (config: object) => void } };
    const context = {
      module, exports: module.exports, window: { __TAURI_INTERNALS__: tauri, __REACT_DEVTOOLS_GLOBAL_HOOK__: hook, addEventListener() {} },
      crypto: { randomUUID: () => 'synthetic-session' }, performance: { now: () => now },
      document: { documentElement: {}, visibilityState: 'visible', hasFocus: () => true, addEventListener(kind: string, callback: () => void) { listeners.set(kind, callback); },
        getElementsByTagName: () => [], querySelectorAll: () => [] },
      MutationObserver: class { observe() {} }, requestAnimationFrame(callback: () => void) { frames.push(callback); },
      setInterval(fn: () => void) { tick = fn; },
      fetch: async (_endpoint: string, options: { body: string }) => { bodies.push(options.body); },
    };
    runInNewContext(code, context);
    module.exports.installNativePerformanceAudit({ endpoint: '/private-collector', token: 'synthetic-token' });
    const host = context.window as typeof context.window & { __DRIFTING_PERFORMANCE_AUDIT_INVOKE__: (command: string, operation: () => Promise<unknown>) => Promise<unknown> };
    const instrumented = host.__DRIFTING_PERFORMANCE_AUDIT_INVOKE__;
    module.exports.installNativePerformanceAudit({ endpoint: '/duplicate', token: 'ignored' });
    expect(host.__DRIFTING_PERFORMANCE_AUDIT_INVOKE__).toBe(instrumented);
    expect(tauri.invoke).toBe(original);
    hook.onCommitFiberRoot(1, { current: { tag: 0, type: { name: 'SyntheticComponent' }, actualDuration: 7, actualStartTime: 1, child: null, sibling: null } }, 0, false);
    expect(previousCommits).toBe(1);
    const renderHost = host as typeof host & {
      __DRIFTING_PERFORMANCE_AUDIT_COMMIT__: (id: string, phase: string, ms: number) => void;
      __DRIFTING_PERFORMANCE_AUDIT_RENDER__: (name: string) => void;
    };
    renderHost.__DRIFTING_PERFORMANCE_AUDIT_COMMIT__('app', 'update', 7);
    renderHost.__DRIFTING_PERFORMANCE_AUDIT_RENDER__('ChapterPanel');
    renderHost.__DRIFTING_PERFORMANCE_AUDIT_RENDER__('ChapterPanel');
    expect(await instrumented('rows', () => original('rows'))).toEqual(['synthetic-private-result']);
    await expect(instrumented('failure', () => original('failure'))).rejects.toBe(failed);
    now = 2001; tick();
    const data = JSON.parse(bodies[0]);
    expect(data.ipc).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'rows', calls: 1, rows: 1, failures: 0 }),
      expect.objectContaining({ command: 'failure', calls: 1, failures: 1 }),
    ]));
    expect(bodies[0]).not.toContain('synthetic-private-result');
    expect(data.inFlight).toBe(0);
    expect(data.reactHookAttached).toBe(true);
    expect(data.reactCommits).toMatchObject({ count: 1, max: 7 });
    expect(data.componentRenders).toContainEqual(expect.objectContaining({ name: 'SyntheticComponent', renders: 1, selfMs: 7 }));
    expect(data.renderCalls).toEqual({ ChapterPanel: 2 });
    expect(data.supportedEntries).toEqual([]);
    // A pending input must not turn a background/locked interval into latency.
    await Promise.resolve(); await Promise.resolve();
    listeners.get('keydown')!();
    frames[1]();
    context.document.visibilityState = 'hidden'; context.document.hasFocus = () => true; listeners.get('visibilitychange')!();
    now = 10000; frames[2]();
    tick();
    expect(JSON.parse(bodies[1])).toMatchObject({ visible: false, browserVisible: false, focused: true, activityBasis: 'inactive' });
    await Promise.resolve(); await Promise.resolve();
    context.document.visibilityState = 'visible'; context.document.hasFocus = () => true; listeners.get('visibilitychange')!();
    listeners.get('keydown')!(); frames[3]();
    now = 10033; frames[4]();
    now = 12001; tick();
    const resumed = JSON.parse(bodies[2]);
    expect(resumed.inputToTwoRaf).toMatchObject({ count: 1, max: 33 });
    expect(resumed.nativeProcesses).toBeNull();
    expect(bodies[2]).not.toContain('synthetic-private-result');
  });

  it('excludes focus-only and marker-boundary buckets from native latency conclusions', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'drifting-perf-summary-'));
    const audit = path.join(directory, 'audit');
    mkdirSync(audit);
    mkdirSync(path.join(directory, 'target', 'debug'), { recursive: true });
    writeFileSync(path.join(directory, 'target', 'debug', 'drifting'), 'synthetic binary');
    writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({ cargoTargetDirectory: path.join(directory, 'target') }));
    writeFileSync(path.join(audit, 'source.json'), JSON.stringify({ recordedAt: new Date(0).toISOString() }));
    writeFileSync(path.join(audit, 'markers.jsonl'), JSON.stringify({ marker: 'writing', receivedAt: 1500 }));
    const sample = (at: number, max: number, browserVisible: boolean) => ({ at, receivedAt: at, marker: 'writing', visible: true, browserVisible,
      activityBasis: browserVisible ? 'document-visible' : 'document-focus', startMs: at - 2000, endMs: at,
      ...Object.fromEntries(['frameGaps', 'inputToTwoRaf', 'timerDelay', 'reactCommits', 'longTasks'].map(key => [key, { count: 1, values: [max], max, dropped: 0, over50: 0, over100: 0, over1000: 0 }])),
      dom: { elements: 10, editors: 1 }, mutations: {}, errors: [], componentRenders: [], renderCalls: { ChapterPanel: 2 }, commitErrors: 0, observerMs: 0, snapshotMs: 0 });
    writeFileSync(path.join(audit, 'samples.jsonl'), [sample(2000, 9000, false), sample(3000, 5000, true), sample(5000, 17, true)].map(s => JSON.stringify(s)).join('\n'));
    try {
      const json = execFileSync(process.execPath, [new URL('../../../scripts/native-performance-audit.mjs', import.meta.url).pathname, audit, 'summarize'], { encoding: 'utf8' });
      const report = JSON.parse(json);
      expect(report.observations).toMatchObject({ samples: 3, visibleSamples: 2, focusOnlySamples: 1, comparableSamples: 1 });
      expect(report.phases[0].metrics.frameGaps).toMatchObject({ count: 1, max: 17 });
      expect(report.phases[0].renderCalls).toEqual({ ChapterPanel: 2 });
      expect(json).not.toContain(directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
