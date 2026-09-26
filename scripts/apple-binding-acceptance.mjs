import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/apple-native/acceptance/p2b-binding.json';
const directory = '.local-data/apple-native/binding';
const searchCases = [
  'AppKit project search reads live and cold chapter text without changing owners or history',
  'AppKit search revalidates anchored Unicode matches and preserves other pane selection and history',
  'AppKit search guards queued and marked input and discards superseded query results',
];
const workspaceCases = [
  'Workspace tabs retain chapter owners views selections and independent history',
  'Workspace split panes share one chapter owner and preserve independent selections after closing one pane',
  'Workspace close guards retain queued marked and failed-save input through retry and cold reopen',
];
const prefixDeletionCases = [
  'AppKit queued Enter after partial remote prefix deletion preserves two views, comments, history and reopen',
  'AppKit queued Enter after complete remote prefix deletion preserves two views, comments, history and reopen',
];
const partialQuoteCase = 'AppKit partial quote deletion preserves queued typing, two-view selections, comments, suffix history and reopen';
const relocationCases = [
  'AppKit refused relocation history preserves remote formatting and keeps both views editable',
  'AppKit late original prefix after partial quote deletion converges across two views history duplicate delivery and reopen',
  'AppKit late original prefix after quote join converges across two views history duplicate delivery and reopen',
  'AppKit mixed late prefix and safe suffix after partial quote deletion preserve two views selections item identity history and reopen',
  'AppKit mixed late prefix and safe suffix after quote join preserve two views selections item identity history and reopen',
  'AppKit interleaved Unicode prefix and safe suffix clocks after partial quote deletion preserve two views selections item identity history and reopen',
  'AppKit interleaved Unicode prefix and safe suffix clocks after quote join preserve two views selections item identity history and reopen',
];
const remoteBlockCases = [
  'AppKit stored but unapplied remote update preserves marked input and shared recovery status',
  'AppKit stored but unapplied remote update preserves queued input and blocks history, retry compaction and reopen',
];
const remoteRecoveryCases = [
  'AppKit durable dependency recovery bypasses held local jobs then drains exact queued input through history and reopen',
  'AppKit durable dependency recovery preserves marked branch until native commit and keeps remote text through history and reopen',
];
const styleCases = [
  'AppKit outline resolves current heading identity without moving passive views or authoring history',
  'AppKit outline survives prefix edits history and reopening while guarding marked input',
  'AppKit native multiblock formatting shares styles selection one-step history and persisted structure',
  'AppKit heading levels body reset and container refusal preserve links comments and usable input',
  'AppKit incremental style matches full reference at every UTF-16 position',
  'AppKit local Unicode styling uses one-block path and authoritative no-op skip',
  'AppKit composition commit and cancellation clear temporary text-system styling',
  'AppKit bold link italic strike and comment boundaries retain full-reference attributes',
  'AppKit remote format-only styling refreshes unchanged text',
  'AppKit structural style fallback matches full reference',
  'AppKit comment-only projection refresh removes stale highlights',
  'AppKit revision and selection-only refresh skips styling',
  'Canonical-equivalent text replacement retains exact scalar and UTF-16 identity',
  'AppKit canonical replacement refreshes passive views and history',
  'AppKit canonical composition commits as one exact undo unit',
  'Remote canonical text refresh and SQLite reopen retain exact storage ranges',
];
const run = (command, args, env = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000, env: { ...process.env, ...env },
});
const sourceFiles = () => [...new Set(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
  .filter(file => file && existsSync(file) && (/^(crates\/|vendor\/yrs\/|native\/apple\/|drizzle\/)/.test(file)
    || ['scripts/apple-binding-acceptance.mjs', 'scripts/apple-quote-history-oracle.ts',
      'src/renderer/components/editor/chapter-static-html.ts', 'src/renderer/lib/extensions/block-id.ts',
      'src/renderer/lib/extensions/paragraph-indent.ts', 'src/renderer/lib/extensions/entity-link.ts',
      'src/renderer/domain/entity-kinds.ts', 'src/renderer/lib/retroactive-entity-links.ts',
      'docs/apple-native/fixtures/document-v1.json', 'package.json', 'pnpm-lock.yaml'].includes(file))).sort();
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(JSON.stringify(sourceFiles().map(path => ({ path, hash: hash(readFileSync(path)) }))));
const report = { schemaVersion: 1, kind: 'apple_native_p2b_first_binding', status: 'running', generatedAt: new Date().toISOString(),
  scope: 'Headless Swift coordinator, Rust ABI, SQLite and programmatic AppKit text input',
  source: { commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty: Boolean(run('git', ['status', '--porcelain']).trim()), fingerprint: fingerprint() },
  cases: [], limits: { fullP2b: 'incomplete', physicalIME: 'not-run', remoteDuringComposition: 'programmatic AppKit shared queue tested, including overlap and immediate continued input; physical IME not-run; UIKit marked text recorded separately in native report',
    crossBlockEditing: 'sibling, scoped blockquote boundaries and right-parent-preserving quote join tested; complex unselected suffix relocation remains rejected', commentReanchor: 'sibling split, undo/redo, SQLite reopen and native highlight tested; production sync open',
    crashAndCompaction: 'separate-durability-report', multipleViews: 'shared owner, authored branches, overlapping composition, continued-input and refresh races, CRDT selection epochs/history, detach/draft recovery and save retry tested; copied/redone sibling text lineage tested; disjoint-block structural drafts and same-paragraph Enter with pure remote prefix deletion tested; other same-block structural concurrency open', simulator: 'separate-native-report', signedDistribution: 'not-run' },
};
if (process.argv.includes('--check')) {
  const previous = JSON.parse(readFileSync(output));
  assert.equal(previous.status, 'passed');
  assert(previous.cases.length >= 71);
  for (const name of searchCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing search gate: ${name}`);
  for (const name of workspaceCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing workspace gate: ${name}`);
  assert(previous.cases.some(entry => entry.name === 'AppKit safe quote join preserves native suffix editing, history and reopen'));
  for (const name of styleCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing style gate: ${name}`);
  for (const name of prefixDeletionCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing prefix-deletion gate: ${name}`);
  assert(previous.cases.some(entry => entry.name === partialQuoteCase && entry.status === 'passed'), 'Missing partial quote deletion gate');
  for (const name of relocationCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing relocation gate: ${name}`);
  for (const name of remoteBlockCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing remote block gate: ${name}`);
  for (const name of remoteRecoveryCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing remote recovery gate: ${name}`);
  assert.equal(previous.source.fingerprint, report.source.fingerprint, 'P2b binding evidence is stale: run pnpm apple:binding:acceptance');
  console.log('P2b binding evidence matches its source inputs.');
  process.exit(0);
}
try {
  assert.equal(process.platform, 'darwin', 'AppKit binding acceptance requires macOS');
  mkdirSync(directory, { recursive: true });
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = `${arch}-apple-darwin`;
  writeFileSync(`${directory}/rust.log`, run('cargo', ['build', '--locked', '--manifest-path', 'crates/drifting-apple-bridge/Cargo.toml', '--target', target],
    { CARGO_TARGET_DIR: `${process.cwd()}/.local-data/apple-native/rust`, MACOSX_DEPLOYMENT_TARGET: '14.0' }));
  writeFileSync(`${directory}/swift.log`, run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    '-I', 'native/apple/FFI', '-L', `.local-data/apple-native/rust/${target}/debug`, '-ldrifting_apple_bridge', '-liconv', '-framework', 'AppKit',
    'native/apple/Shared/LabCore.swift', 'native/apple/Shared/DocumentBinding.swift', 'native/apple/Shared/DocumentStore.swift', 'native/apple/Shared/DocumentStyle.swift',
    'native/apple/macOS/NativeDocumentView.swift', 'native/apple/macOS/MacChapterWorkspace.swift', 'native/apple/Tests/BindingAcceptance.swift', 'native/apple/Tests/MultiViewAcceptance.swift', 'native/apple/Tests/SelectionAcceptance.swift', 'native/apple/Tests/DraftTransportAcceptance.swift', 'native/apple/Tests/InputQueueAcceptance.swift', 'native/apple/Tests/NativeHistoryAcceptance.swift', 'native/apple/Tests/PartialQuoteHistoryAcceptance.swift', 'native/apple/Tests/RemoteBlockAcceptance.swift', 'native/apple/Tests/RemoteRecoveryAcceptance.swift', 'native/apple/Tests/RelocationAcceptance.swift', 'native/apple/Tests/StyleAcceptance.swift', 'native/apple/Tests/TextIdentityAcceptance.swift', 'native/apple/Tests/FormattingAcceptance.swift', 'native/apple/Tests/OutlineAcceptance.swift', 'native/apple/Tests/WorkspaceTabsAcceptance.swift', 'native/apple/Shared/WorkspaceOutline.swift', 'native/apple/Shared/WorkspaceSearch.swift', 'native/apple/Tests/SearchAcceptance.swift', '-o', `${directory}/binding-acceptance`]));
  const result = run(`${directory}/binding-acceptance`, []);
  writeFileSync(`${directory}/result.log`, result);
  const test = JSON.parse(result.trim().split('\n').at(-1));
  assert.equal(test.status, 'passed'); assert(test.cases.length >= 71);
  for (const name of searchCases) assert(test.cases.includes(name), `Missing search gate: ${name}`);
  for (const name of workspaceCases) assert(test.cases.includes(name), `Missing workspace gate: ${name}`);
  for (const name of styleCases) assert(test.cases.includes(name), `Missing style gate: ${name}`);
  for (const name of prefixDeletionCases) assert(test.cases.includes(name), `Missing prefix-deletion gate: ${name}`);
  assert(test.cases.includes(partialQuoteCase), 'Missing partial quote deletion gate');
  for (const name of remoteBlockCases) assert(test.cases.includes(name), `Missing remote block gate: ${name}`);
  for (const name of remoteRecoveryCases) assert(test.cases.includes(name), `Missing remote recovery gate: ${name}`);
  for (const name of relocationCases) assert(test.cases.includes(name), `Missing relocation gate: ${name}`);
  report.cases = test.cases.map(name => ({ name, status: 'passed' }));
  assert.equal(fingerprint(), report.source.fingerprint, 'Binding inputs changed during acceptance');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message.replaceAll(process.cwd(), '<repository>'); process.exitCode = 1;
} finally {
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${output}`);
  if (report.failure) console.error(report.failure);
}
