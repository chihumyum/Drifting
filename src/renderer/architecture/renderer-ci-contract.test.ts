import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
type Report = {
  source: { fingerprintVersion?: number; commit: string; rendererFingerprint: string };
  scenarios: { counts: { fullLinkQueries: number }; transactionMs: { p95: number } }[];
  graphProjection: { results: { samplesMs: number[]; medianMs: number }[] };
  agentEventProcessing: { implementation: string };
  agentDecorations: { checks: { passed: boolean }[] };
  inlineCopilot: { listeners: { remaining: number } };
  agentHistory: { measurements: { rowElements: number }[] };
  agentPanel: { streaming: { composer: number } };
  mobileAgentPanel: { measurements: { lateNavigation: number }[] };
  editorSuggestions?: unknown;
};
const fixture = () => JSON.parse(readFileSync(path.join(root, 'docs/renderer-performance/acceptance/f4-history.json'), 'utf8')) as Report;
function validate(report: Report, flags = ['--deterministic']) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-renderer-contract-'));
  try {
    const file = path.join(temporary, 'report.json');
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, ['scripts/check-renderer-performance.mjs', ...flags, `--report=${file}`], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

describe('ordinary CI renderer evidence', () => {
  it('accepts complete current behavior coverage without requiring historical report provenance', () => {
    expect(validate(fixture()).status).toBe(0);
  });
  it('rejects missing scenarios instead of treating optional historical fields as current coverage', () => {
    const report = fixture(); delete report.editorSuggestions;
    expect(validate(report).output).toContain('missing current contract editorSuggestions');
    expect(validate(report).status).not.toBe(0);
  });
  it('rejects input-wide scans, obsolete implementations, owner leaks and failed behavior', () => {
    const scans = fixture(); scans.scenarios[0].counts.fullLinkQueries = 1;
    const legacy = fixture(); legacy.agentEventProcessing.implementation = 'record-copy';
    const leak = fixture(); leak.inlineCopilot.listeners.remaining = 1;
    const failed = fixture(); failed.agentDecorations.checks[0].passed = false;
    const panel = fixture(); panel.agentPanel.streaming.composer = 20;
    const mobile = fixture(); mobile.mobileAgentPanel.measurements[0].lateNavigation = 1;
    const history = fixture(); history.agentHistory.measurements[1].rowElements = 60020;
    for (const report of [scans, legacy, leak, failed, panel, mobile, history]) expect(validate(report).status).not.toBe(0);
  });
  it('keeps wall-clock budgets out of ordinary CI while preserving measurement validation', () => {
    const report = fixture();
    for (const item of report.graphProjection.results) { item.samplesMs = [10_000, 10_000, 10_000, 10_000, 10_000]; item.medianMs = 10_000; }
    expect(validate(report).status).toBe(0);
    expect(validate(report, []).output).toContain('F5a projection time budget exceeded');
    report.scenarios[0].transactionMs.p95 = -1;
    expect(validate(report).status).not.toBe(0);
  });
  it('rejects stale commit and source evidence even when behavior checks passed', () => {
    const report = fixture(); report.source.fingerprintVersion = 2; report.source.commit = '0'.repeat(40);
    expect(validate(report, ['--deterministic', '--current']).output).toContain('report is from another commit');
    report.source.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    report.source.rendererFingerprint = '0'.repeat(64);
    expect(validate(report, ['--deterministic', '--current']).output).toContain('report is from another source tree');
  });
  it('fingerprints JSON and newly added source files without retaining unrelated evidence files', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-renderer-source-'));
    try {
      execFileSync('git', ['init', '--quiet', temporary]);
      mkdirSync(path.join(temporary, 'src'));
      writeFileSync(path.join(temporary, 'src/messages.json'), '{"text":"synthetic"}');
      execFileSync('git', ['add', 'src'], { cwd: temporary });
      const moduleUrl = pathToFileURL(path.join(root, 'scripts/renderer-performance-source.mjs')).href;
      const fingerprint = () => execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { rendererSourceFingerprint } from ${JSON.stringify(moduleUrl)}; console.log(rendererSourceFingerprint(process.argv[1]));`, temporary], { encoding: 'utf8' });
      const initial = fingerprint();
      writeFileSync(path.join(temporary, 'src/new.ts'), 'export const synthetic = true;');
      const added = fingerprint(); expect(added).not.toBe(initial);
      writeFileSync(path.join(temporary, 'src/messages.json'), '{"text":"changed"}');
      const changed = fingerprint(); expect(changed).not.toBe(added);
      mkdirSync(path.join(temporary, 'docs'));
      writeFileSync(path.join(temporary, 'docs/report.json'), '{}');
      expect(fingerprint()).toBe(changed);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
