import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3k-word-counts.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const exportNames = ['metrics-after-saves', 'metrics-after-reconcile'];
// Exported nodes: the edited chapter, the untouched chapter and the drift.
const nodeKinds = ['chapter', 'chapter', 'drift'];
const wordCounts = [13, 0, 4];
const basisRevisions = [5, 1, 2];
const touched = [true, false, true];
// Body caches may differ from the renderer's only in key order (equal hash
// and count): the untouched chapter's creation cache uses serde_json's sorted
// keys, and attribute order follows Yjs integration order. Reconcile rewrites
// only the untouched chapter's content_json.
const transitions = [{ from: exportNames[0], to: exportNames[1], journal: 'unchanged', yjs: 'unchanged',
  changedCells: ['node_content.content_json@1'] }];
const journal = { changeSets: 9, mutations: 27,
  perDocument: [{ revision: 5, yjsUpdates: 5 }, { revision: 1, yjsUpdates: 1 }, { revision: 2, yjsUpdates: 2 }] };
const exportTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt', 'sync_entity_lifecycle',
  'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict', 'sync_generation_writer_state',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance', 'book_node', 'node_content',
];
// Synthetic y-prosemirror corpus (scripts/apple-workspace-metrics-check.ts)
// replayed into fresh native DocumentSessions. Native is not required to be
// byte-compatible with the renderer; every accepted difference (mark order,
// attribute key order) is pinned with exact values so any change is visible,
// and an unpinned case must be byte-equal.
const corpusNames = [
  'seed-marks-open-together', 'seed-italic-then-bold-italic', 'seed-marks-close-and-reopen', 'seed-marks-staggered',
  'seed-entity-links-overlap', 'seed-adjacent-links', 'seed-headings-and-outline', 'seed-blockquote-hardbreak-empty',
  'seed-lists-and-code', 'seed-word-count-unicode', 'editor-block-attributes', 'editor-late-id-and-level',
  'editor-mark-applied-later', 'editor-mark-removed-and-reapplied', 'editor-entity-link-added-later',
  'yjs-format-later-same-start', 'concurrent-format-same-start', 'concurrent-format-same-key',
  'concurrent-attributes-two-clients', 'raw-top-level-text-and-empty-text', 'raw-fractional-numbers', 'raw-large-number',
  'raw-integer-like-keys', 'raw-non-ascii-format-key',
];
const marks = (block, run, native, renderer) =>
  ({ kind: 'markOrder', path: `$.content[${block}].content[${run}].marks`, native, renderer });
const keys = (at, native, renderer) => ({ kind: 'keyOrder', path: `$.content${at}.attrs`, native, renderer });
const nativeParagraph = ['id', 'textAlign', 'indent'];
const editorParagraph = ['textAlign', 'id', 'indent'];
const nativeHeading = ['id', 'level', 'textAlign', 'indent'];
const editorHeading = ['textAlign', 'id', 'indent', 'level'];
const corpusDifferences = {
  'seed-italic-then-bold-italic': [marks(0, 1, ['italic', 'bold'], ['bold', 'italic'])],
  'seed-marks-close-and-reopen': [marks(0, 1, ['underline', 'bold'], ['bold', 'underline']),
    marks(0, 2, ['underline', 'bold', 'italic'], ['bold', 'italic', 'underline'])],
  'seed-marks-staggered': [marks(0, 4, ['italic', 'underline', 'strike'], ['italic', 'strike', 'underline'])],
  'seed-entity-links-overlap': [marks(0, 1, ['entityLink:el-a', 'bold', 'entityLink:el-b'], ['bold', 'entityLink:el-a', 'entityLink:el-b'])],
  'editor-block-attributes': [keys('[0]', nativeParagraph, editorParagraph), keys('[1]', nativeHeading, editorHeading),
    keys('[2].content[0]', nativeParagraph, editorParagraph), keys('[3]', nativeParagraph, editorParagraph)],
  'editor-late-id-and-level': [keys('[0]', nativeParagraph, ['textAlign', 'indent', 'id']), keys('[1]', nativeHeading, editorHeading)],
  'editor-mark-applied-later': [keys('[0]', nativeParagraph, editorParagraph),
    marks(0, 1, ['link:https://example.invalid/w', 'bold', 'italic', 'underline'], ['bold', 'italic', 'underline', 'link:https://example.invalid/w'])],
  'editor-mark-removed-and-reapplied': [keys('[0]', nativeParagraph, editorParagraph), marks(0, 0, ['bold', 'italic'], ['italic', 'bold'])],
  'editor-entity-link-added-later': [keys('[0]', nativeParagraph, editorParagraph)],
  'yjs-format-later-same-start': [marks(0, 0, ['bold', 'italic'], ['italic', 'bold'])],
  'concurrent-format-same-key': [marks(0, 0, ['bold', 'underline'], ['underline', 'bold'])],
  'concurrent-attributes-two-clients': [keys('[0]', nativeParagraph, editorParagraph)],
  'raw-integer-like-keys': [keys('[0]', ['id', '10', '2', 'zeta'], ['2', '10', 'id', 'zeta'])],
};
const drawnOutlineIds = { 'seed-headings-and-outline': 2 };
const specs = [
  { name: 'document-metrics', crate: 'drifting-document', filter: 'prose_metrics_tests::', required: [
    'prose_metrics_tests::prose_projection_follows_y_prosemirror_and_prose_metrics',
    'prose_metrics_tests::prose_projection_handles_large_numbers_and_non_ascii_format_keys',
    'prose_metrics_tests::prose_word_count_matches_prose_metrics',
  ] },
  { name: 'core-metrics', crate: 'drifting-core', filter: 'workspace::metrics::tests::', required: [
    'workspace::metrics::tests::workspace_metrics_materialize_reuse_and_stale_revision',
  ] },
  { name: 'bridge-metrics', crate: 'drifting-apple-bridge', filter: 'workspace_tests::metrics::', required: [
    'workspace_tests::metrics::workspace_metrics_follow_saves_reconcile_and_cold_reopen',
  ] },
];
// Scratch harness: a cold native load (DocumentSession::new + apply_remote) of
// each corpus update and its prose_projection. Written under the evidence
// directory with drifting-document's own lockfile.
const harnessManifest = `[package]
name = "drifting-metrics-harness"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
drifting-document = { path = "@DOCUMENT@" }
serde_json = "1"

[workspace]
`;
const harnessMain = `use drifting_document::DocumentSession;
use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input: Value = serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    std::panic::set_hook(Box::new(|_| {}));
    let cases: Vec<Value> = input["cases"].as_array().unwrap().iter().map(|case| {
        let hex = case["updateHex"].as_str().unwrap();
        let bytes: Vec<u8> = (0..hex.len()).step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let outcome = std::panic::catch_unwind(move || {
            let mut session = DocumentSession::new();
            session.apply_remote(&bytes, 1)?;
            session.prose_projection()
        });
        let name = case["name"].clone();
        match outcome {
            Ok(Ok(projection)) => json!({"name": name, "projection": projection}),
            Ok(Err(error)) => json!({"name": name, "error": error}),
            Err(panic) => json!({"name": name, "panic": panic.downcast_ref::<String>().cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()}),
        }
    }).collect();
    std::fs::write(&args[2], serde_json::to_vec_pretty(&json!({"schemaVersion": 1, "cases": cases})).unwrap()).unwrap();
}
`;
const roleDifferences = [
  'Creation body cache: until its body is saved or reconciled, a native chapter keeps its creation cache in serde_json key order (same canonical document, count and hash); the renderer, like native, refuses to reuse it and reconcile rewrites only content_json. Pinned per node with exact key orders.',
  'Block attribute key order (hash-neutral): native writes attributes in schema declaration order (id, level, …, textAlign, indent), while the renderer keeps Yjs attribute integration order: live-editor blocks carry textAlign, id, indent(, level), a key set later (a late block ID) comes last, and integer-like keys come first in JavaScript. Bodies authored in the renderer editor therefore never byte-equal the native cache and each side\'s canReuseCanonicalProjection refuses the other\'s cache (derived rewrite only). Pinned per corpus case with exact key orders.',
];
const exemptions = [
  'A heading without a block ID gets outline_<uuidv7>_<position> from the renderer and outline_native_<position> natively; outline_json is compared byte for byte after that substitution, the drawn IDs are counted per case, and canReuseCanonicalProjection is evaluated with and without it.',
];
const nativeDifferences = [
  'Mark order (accepted; changes content_json and word_count_basis_hash): native lists the marks of each text run in run-boundary order (a mark keeps its place while it stays active) with schema rank (link, bold, code, italic, strike, underline, entityLink) breaking ties among marks opening together. It is deterministic but not byte-compatible with the renderer, whose yDocToProsemirrorJSON follows the raw Yjs format items (y-prosemirror reopens every mark at each seeded run boundary, later formatting at the same start comes first, and Yjs cleans the leading format gap on receive). Native and renderer bodies with such runs therefore differ in content_json and basis hash, and each side\'s canReuseCanonicalProjection refuses the other\'s cache (derived rewrite only). Pinned per corpus case with exact mark orders; for example a seeded paragraph [a{italic}, b{bold,italic}] lists b as [italic, bold] natively and [bold, italic] in the renderer.',
];
const boundaries = {
  source: 'Real native chapter and drift body saves, workspaceMetrics reconcile and cold reopen over a synthetic file-backed workspace, plus a synthetic y-prosemirror corpus replayed into fresh native document sessions.',
  agreedGroups: [
    'Edit a chapter (heading, bold and italic runs, CJK, Latin and emoji) and a drift (CJK and Latin), then save each: the save materializes the body cache, outline and canonical word count at the saved Yjs revision (basis kind yjs, no server sequence) and stamps both updated_at values; an unchanged save rewrites nothing; no save writes an original.',
    'Reconcile projects every live chapter and drift at its current revision without touching updated_at or writing an original: the saved bodies are reused as exact and the untouched chapter\'s creation cache is rewritten in renderer key order. Counts survive cold reopen; an unknown action is refused.',
  ],
  rendererParity: 'For every exported node, the production persistence coordinator (readBase, closed durable state: snapshot then ordered updates) and deriveCanonicalNodeProseProjection (real yjs, y-prosemirror yDocToProsemirrorJSON, @drifting/prose-metrics and serializeOutline(extractOutline)) reproduce the native word_count, basis hash, basis kind and revision exactly, outline_json byte for byte and content_json byte for byte (structurally, with exact pinned key orders otherwise); the production reducer\'s own body-cache projection (snapshot and updates applied in turn) yields the same bytes; and canReuseCanonicalProjection, over the native rows read through the renderer repositories, reuses every saved or reconciled projection. Between the exports the journal, receipts, lifecycle, field clocks, writer state and Yjs rows are identical and only pinned derived cells change; every original of the saves export is a creation original or the one yjs.update of an authored Yjs revision. The corpus (y-prosemirror seed and live-editor schemas, later editor syncs, concurrent peers and raw Yjs structures, including numbers of 1e21 or more and non-ASCII format keys) projects in every fresh native session and matches the renderer\'s word counts and outlines case by case; content bytes and hashes match except for the pinned attribute key order and mark order differences.',
  roleDifferences,
  exemptions,
  nativeDifferences,
  limitations: [
    'The exports hold no drawn outline ID, remote or seed-only body and no concurrent formatting; those are corpus evidence only. The corpus is a scratch harness over drifting-document, not the bridge or the Mac UI.',
    'Saves are checked by journal accounting against authored Yjs revisions; the exports carry no pre-save baseline.',
    'Element, category and storyline body caches remain creation seeds and are not covered; word counts are not transported to or compared with the hosted service.',
    'Synthetic in-process saves and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|packages\/prose-metrics\/src\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-metrics-acceptance.mjs', 'scripts/apple-workspace-metrics-check.ts',
        'src/renderer/services/node-prose-metrics.service.ts', 'src/renderer/lib/outline.ts',
        'src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.ts', 'src/renderer/lib/agent/runtime/yjs-prose-command.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts', 'src/renderer/lib/yjs-doc-id.ts',
        'src/renderer/lib/extensions/block-id.ts', 'src/renderer/lib/extensions/entity-link.ts',
        'src/renderer/lib/extensions/paragraph-indent.ts', 'src/renderer/hooks/useEntityYjsDoc.ts', 'src/renderer/hooks/useEntityEditor.ts',
        'src/renderer/lib/db.ts', 'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validateCorpus(cases) {
  assert.deepEqual(cases.map(item => item.name), corpusNames);
  for (const item of cases) {
    assert.match(item.updateSha256, /^[a-f0-9]{64}$/u);
    assert.equal(item.native, undefined, `${item.name}: native failed to project`);
    const expected = corpusDifferences[item.name] ?? [];
    assert.deepEqual(item.differences, expected, `${item.name}: native/renderer differences changed`);
    const hashNeutral = expected.every(difference => difference.kind === 'keyOrder');
    assert.equal(item.content, expected.length === 0 ? 'equal' : hashNeutral ? 'keyOrder' : 'differs');
    assert.equal(item.basisHash, hashNeutral ? 'equal' : 'differs');
    assert.equal(item.outline, 'equal');
    assert.equal(item.wordCount, 'equal');
    assert(Number.isInteger(item.rendererWordCount) && item.rendererWordCount >= 0);
    assert.equal(item.drawnOutlineIds, drawnOutlineIds[item.name] ?? 0);
    if (expected.length) {
      assert.match(item.nativeContentSha256, /^[a-f0-9]{64}$/u);
      assert.match(item.rendererContentSha256, /^[a-f0-9]{64}$/u);
    }
  }
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_word_counts');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Word-count evidence is stale; rerun its generator');
  assert.equal(report.source.fingerprint, sha(JSON.stringify(report.source.files)));
  assert.deepEqual(report.boundaries, boundaries);
  assert.equal(report.strictTypeScript, 'passed');
  const version = /^rustc (\d+)\.(\d+)\./u.exec(report.toolchain.rustc);
  assert(version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 96));
  assert.match(report.toolchain.cargo, /^cargo \d+\.\d+\./u);
  assert.deepEqual(report.suites.map(suite => suite.name), specs.map(spec => spec.name));
  for (const spec of specs) {
    const suite = report.suites.find(item => item.name === spec.name);
    assert(suite);
    assert.equal(suite.failed, 0);
    assert.equal(suite.passed, spec.required.length);
    assert.deepEqual([...suite.cases].sort(), [...spec.required].sort());
    assert.match(suite.logSha256, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(report.harness, { status: 'passed', cases: corpusNames.length, manifestSha256: sha(harnessManifest),
    mainSha256: sha(harnessMain), logSha256: report.harness.logSha256 });
  assert.match(report.harness.logSha256, /^[a-f0-9]{64}$/u);
  const { renderer } = report;
  assert.equal(renderer.schemaVersion, 1);
  assert.equal(renderer.status, 'passed');
  for (const key of ['inputSha256', 'corpusSha256', 'nativeCorpusSha256']) assert.match(renderer[key], /^[a-f0-9]{64}$/u);
  assert.deepEqual(renderer.exports.map(item => item.name), exportNames);
  for (const [index, item] of renderer.exports.entries()) {
    assert.match(item.databaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.journal, journal);
    assert.deepEqual(item.tables.map(table => table.table), exportTables);
    for (const table of item.tables) {
      assert(Number.isInteger(table.rows) && table.rows >= 0);
      assert.match(table.sha256, /^[a-f0-9]{64}$/u);
    }
    assert.equal(item.nodes.length, nodeKinds.length);
    for (const [ordinal, node] of item.nodes.entries()) {
      // Attribute key order follows Yjs integration order, which depends on
      // random client IDs; any hash-neutral key-order difference is accepted.
      const differences = node.differences;
      assert(differences.every(difference => difference.kind === 'keyOrder'),
        `${nodeKinds[ordinal]} ${index}: only key order may differ`);
      assert.deepEqual(node, {
        kind: nodeKinds[ordinal], wordCount: wordCounts[ordinal], basisKind: 'yjs', basisRevision: basisRevisions[ordinal],
        durableRevision: basisRevisions[ordinal], content: differences.length ? 'keyOrder' : 'equal', differences, outline: 'equal',
        drawnOutlineIds: 0, reducerBodyCache: 'equal', canReuse: differences.length === 0,
        reuseRefusals: differences.length ? ['content_json'] : [], touched: touched[ordinal], stampsAgree: true,
        contentSha256: node.contentSha256, outlineSha256: node.outlineSha256,
      });
      assert.match(node.contentSha256, /^[a-f0-9]{64}$/u);
      assert.match(node.outlineSha256, /^[a-f0-9]{64}$/u);
    }
  }
  assert.deepEqual(renderer.transitions, transitions);
  validateCorpus(renderer.corpus);
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/metrics-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-metrics-wire.json', 'prose-corpus.json', 'native-corpus.json', 'harness-build.log', 'harness.log',
    'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native word-count evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/metrics-acceptance-');
  const before = sources();
  writeFileSync(`${directory}/source-before.json`, `${JSON.stringify(before, null, 2)}\n`);
  function run(name, command, args, extraEnv = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...extraEnv } });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(`${directory}/${name}.log`, log);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${name}: ${log.slice(-9000)}`);
    return log;
  }
  const toolchain = { rustc: run('rustc', 'rustc', ['--version']).trim(), cargo: run('cargo', 'cargo', ['--version']).trim() };
  const suites = specs.map(spec => {
    const log = run(spec.name, 'cargo', ['test', '--locked', '--manifest-path', `crates/${spec.crate}/Cargo.toml`, spec.filter],
      { NATIVE_WORKSPACE_METRICS_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, exports: exportNames.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.database, `${name}.db`);
    return { name, ...item };
  }) };
  writeFileSync(`${directory}/workspace-metrics-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  const tsx = ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-metrics-check.ts'];
  run('corpus', 'pnpm', [...tsx, `--emit-corpus=${directory}/prose-corpus.json`]);
  const harness = `${directory}/harness`;
  mkdirSync(`${harness}/src`, { recursive: true });
  writeFileSync(`${harness}/Cargo.toml`, harnessManifest.replace('@DOCUMENT@', path.resolve('crates/drifting-document').replaceAll('\\', '/')));
  writeFileSync(`${harness}/src/main.rs`, harnessMain);
  copyFileSync('crates/drifting-document/Cargo.lock', `${harness}/Cargo.lock`);
  const target = path.resolve('.local-data/apple-native/metrics-harness-target');
  run('harness-build', 'cargo', ['build', '--offline', '--manifest-path', `${harness}/Cargo.toml`], { CARGO_TARGET_DIR: target });
  const harnessLog = run('harness', path.join(target, 'debug', 'drifting-metrics-harness'),
    [`${directory}/prose-corpus.json`, `${directory}/native-corpus.json`]);
  run('renderer', 'pnpm', [...tsx, `--input=${directory}/workspace-metrics-wire.json`, `--corpus=${directory}/prose-corpus.json`,
    `--native-corpus=${directory}/native-corpus.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-metrics-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Word-count source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-metrics-wire.json', 'prose-corpus.json', 'native-corpus.json', 'corpus.log', 'harness-build.log', 'harness.log',
    'renderer.json', 'renderer.log', 'typecheck.log',
    ...wire.exports.flatMap(item => [`${item.name}.json`, item.database])])];
  const report = { schemaVersion: 1, kind: 'native_word_counts', status: 'passed',
    source: { files: before, fingerprint: sha(JSON.stringify(before)) }, toolchain, suites,
    harness: { status: 'passed', cases: json(`${directory}/native-corpus.json`).cases.length, manifestSha256: sha(harnessManifest),
      mainSha256: sha(harnessMain), logSha256: sha(harnessLog) },
    renderer: json(`${directory}/renderer.json`), strictTypeScript: 'passed', boundaries,
    rawEvidence: names.map(name => ({ path: `${directory}/${name}`, sha256: sha(readFileSync(`${directory}/${name}`)) })),
  };
  validate(report);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', suites: suites.map(({ name, passed }) => ({ name, passed })),
    exports: report.renderer.exports.length, corpus: report.renderer.corpus.length,
    sourceFingerprint: report.source.fingerprint, rawEvidence: directory }));
}
