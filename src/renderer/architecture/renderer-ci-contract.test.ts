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
  agentTranscript: { ingress: { eventWork: { flatMaterializations: number } }[] };
  agentBackground: { measurements: { ingressWork: { flatMaterializations: number }; scheduled: { timers: number }; checks: { foregroundFlushesTail: boolean } }[] };
  agentRecovery: { measurements: { work: { groupedMessageVisits: number }[] }[] };
  agentJournal: { checks: { passed: boolean }[] };
  storyGraphUnplaced: { measurements: { initialWork: { chips: number }; openWork: { chips: number }; checks: { currentTitleAndPrimary: boolean; cancelledDrag: boolean } }[] };
  graphDriftCards: { implementation?: string; measurements: { closedWork: { elementCards: number }; hoverWork: { storyShell: number; storyCards: number; storyWrappers: number } | null; checks: { visualDropSettles: boolean | null; closeAndReopen: boolean; reverseAndCrossSource: boolean | null; sourceSlotInvalidation: boolean | null } }[] };
  storyGraphCards: { measurements: { mountWork: { groupingVisits: number }; popoverWork: { tiles: number }; checks: { reassignedPrimaryLane: boolean } }[] };
  superElementCards: { measurements: { focusWork: { elements: number }; wheelWork: { bands: number }; checks: { chapterPairUsesLatestSource: boolean } }[] };
  agentHistory: { measurements: { rowElements: number }[] };
  agentPanel: { streaming: { composer: number } };
  mobileAgentPanel: { measurements: { lateNavigation: number }[] };
  editorSuggestions?: unknown;
  workspaceGeneration?: { profiles: { comments: { targets: number }; metrics: { names: number }; checks: { changedGenerationReleasesRecords: boolean }; incoherentCommits: number }[] };
};
const fixture = () => JSON.parse(readFileSync(path.join(root, 'docs/renderer-performance/acceptance/f2-projection-generation-browser.json'), 'utf8')) as Report;
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
    const transcript = fixture(); transcript.agentTranscript.ingress[0].eventWork.flatMaterializations = 6000;
    const recovery = fixture(); recovery.agentRecovery.measurements[0].work[0].groupedMessageVisits = 20000;
    const journal = fixture(); journal.agentJournal.checks[0].passed = false;
    const background = fixture(); background.agentBackground.measurements[0].ingressWork.flatMaterializations = 6000;
    const timers = fixture(); timers.agentBackground.measurements[0].scheduled.timers = 6000;
    const returning = fixture(); returning.agentBackground.measurements[0].checks.foregroundFlushesTail = false;
    const cards = fixture(); cards.superElementCards.measurements[2].focusWork.elements = 100000;
    const bands = fixture(); bands.superElementCards.measurements[2].wheelWork.bands = 1;
    const staleCard = fixture(); staleCard.superElementCards.measurements[0].checks.chapterPairUsesLatestSource = false;
    const storyGrouping = fixture(); storyGrouping.storyGraphCards.measurements[2].mountWork.groupingVisits = 255000;
    const storyTiles = fixture(); storyTiles.storyGraphCards.measurements[2].popoverWork.tiles = 100000;
    const storyLane = fixture(); storyLane.storyGraphCards.measurements[0].checks.reassignedPrimaryLane = false;
    const hiddenDrifts = fixture(); hiddenDrifts.graphDriftCards.measurements[5].closedWork.elementCards = 5000;
    const driftShell = fixture(); driftShell.graphDriftCards.measurements[2].hoverWork!.storyShell = 20;
    const driftCards = fixture(); driftCards.graphDriftCards.measurements[2].hoverWork!.storyCards = 100000;
    const driftWrappers = fixture(); driftWrappers.graphDriftCards.measurements[2].hoverWork!.storyWrappers = 100000;
    const driftLegacy = fixture(); delete driftLegacy.graphDriftCards.implementation;
    const driftReverse = fixture(); driftReverse.graphDriftCards.measurements[2].checks.reverseAndCrossSource = false;
    const driftSlots = fixture(); driftSlots.graphDriftCards.measurements[2].checks.sourceSlotInvalidation = false;
    const driftCleanup = fixture(); driftCleanup.graphDriftCards.measurements[2].checks.closeAndReopen = false;
    const inapplicableDrag = fixture(); inapplicableDrag.graphDriftCards.measurements[3].checks.visualDropSettles = true;
    const hiddenChapters = fixture(); hiddenChapters.storyGraphUnplaced.measurements[2].initialWork.chips = 5000;
    const repeatedChapters = fixture(); repeatedChapters.storyGraphUnplaced.measurements[2].openWork.chips = 100000;
    const staleChapter = fixture(); staleChapter.storyGraphUnplaced.measurements[0].checks.currentTitleAndPrimary = false;
    const chapterDrag = fixture(); chapterDrag.storyGraphUnplaced.measurements[0].checks.cancelledDrag = false;
    for (const report of [scans, legacy, leak, failed, panel, mobile, history, transcript, recovery, journal, background, timers, returning, cards, bands, staleCard, storyGrouping, storyTiles, storyLane, hiddenDrifts, driftShell, driftCards, driftWrappers, driftLegacy, driftReverse, driftSlots, driftCleanup, inapplicableDrag, hiddenChapters, repeatedChapters, staleChapter, chapterDrag]) expect(validate(report).status).not.toBe(0);
  });
  it('rejects missing generation coverage, broad target rebuilds and stale authority reuse', () => {
    const missing = fixture(); delete missing.workspaceGeneration;
    expect(validate(missing).output).toContain('missing current contract workspaceGeneration');
    const comments = fixture(); comments.workspaceGeneration!.profiles[2].comments.targets = 2000;
    const metrics = fixture(); metrics.workspaceGeneration!.profiles[2].metrics.names = 2000;
    const stale = fixture(); stale.workspaceGeneration!.profiles[0].checks.changedGenerationReleasesRecords = false;
    const mixed = fixture(); mixed.workspaceGeneration!.profiles[0].incoherentCommits = 1;
    for (const report of [comments, metrics, stale, mixed]) expect(validate(report).status).not.toBe(0);
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
