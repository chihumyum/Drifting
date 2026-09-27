import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3f-entity-links.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const specs = [
  { name: 'document-entity-links', crate: 'drifting-document', filter: 'entity_link', required: [
    'entity_link_tests::entity_link_key_matches_y_tiptap_overlapping_mark_hash',
    'entity_link_tests::entity_link_detection_matches_the_renderer_matcher',
    'entity_link_tests::link_entities_is_idempotent_not_undoable_and_keeps_other_targets',
    'entity_link_tests::link_entities_waits_for_drafts_and_uses_renderer_name_collisions',
    'concurrent_draft_tests::entity_link_pass_under_open_input_keeps_a_structural_newline',
  ] },
  { name: 'bridge-entity-links', crate: 'drifting-apple-bridge', filter: 'workspace_tests::links::', required: [
    'workspace_tests::links::workspace_links_chapters_and_element_bodies_and_reports_backlinks',
  ] },
];
// Linked spans typed by the bridge test: [block, from, to, text, target] in
// block-relative UTF-16 units; targets are labelled by element name or chapter title.
const documents = [
  { name: 'chapter-0', sourceKind: 'node', blocks: 2, linkKeys: 3, selfSpansWithoutExclusion: 0, links: [
    [0, 0, 2, '林凯', 'element:林凯'], [0, 3, 5, '北塔', 'element:北塔'], [1, 0, 2, '阿凯', 'element:林凯'],
    [1, 4, 6, '归航', 'node:归航'], [1, 8, 10, '林凯', 'element:林凯'],
  ] },
  { name: 'chapter-1', sourceKind: 'node', blocks: 1, linkKeys: 1, selfSpansWithoutExclusion: 0, links: [
    [0, 0, 2, '林凯', 'element:林凯'],
  ] },
  { name: 'element-body', sourceKind: 'element', blocks: 1, linkKeys: 1, selfSpansWithoutExclusion: 1, links: [
    [0, 4, 6, '北塔', 'element:北塔'],
  ] },
];
const backlinks = { element: 'element:林凯', status: 'passed', chapters: [
  { chapter: 'node:初航', spans: 3, blocks: 2, first: { location: 0, length: 2 } },
  { chapter: 'node:归航', spans: 1, blocks: 1, first: { location: 0, length: 2 } },
] };
const omittedExtensions = ['placeholder', 'agentDiffDecoration', 'entityMentionSuggestion', 'slashMenu'];
const boundaries = {
  source: 'Real native documentLinkEntities and workspaceElements backlinks commands over a synthetic file-backed workspace: two chapters and one element body linked through the C ABI; chapter 1 is closed and read cold for backlinks.',
  agreedGroups: [
    'Every native entityLink decodes through y-prosemirror JSON and the y-tiptap editor decoder under the production chapter schema with exactly {targetKind,targetId,targetBlockId:null}, and y-tiptap serializes the decoded marks to the identical Yjs text deltas, so each key is the overlapping-mark key entityLink--hashOfJSON(mark.toJSON()).',
    'With every entityLink stripped, the production chapter editor extensions bound through Collaboration to a y-tiptap Y.Doc run the real EntityLink auto-detect (flushPendingAutoDetect) over buildEntityAutoDetectTargets with the chapter-self and own-element exclusions and reproduce the native marks and Yjs text attributes in one addToHistory:false transaction that adds no undo step; the exported detectEntityLinkSpans agrees per text node.',
    'The production reference projection (yDocToProsemirrorJSON then projectInlineMentionsFromJson, equal to projectInlineMentionsFromDoc) yields the native per-chapter backlink rows: spans, distinct blocks and the first UTF-16 range in projection coordinates.',
    'The same production editor bound to each native Y.Doc renders the native marks and emits no Yjs update on load or on an auto-detect flush: the renderer does not rewrite native links.',
  ],
  headlessEditor: 'TipTap Editor with the production chapter extensions (useEntityEditor Yjs mode) mounted on a DOM-free view double: state, TipTap composed dispatch and the prosemirror-view plugin-view lifecycle, an inert view.dom and window drag-listener target. Placeholder, AgentDiffDecoration, EntityMentionSuggestion and the slash menu are omitted: they only decorate or react to input.',
  omittedExtensions,
  limitations: [
    'Chapter self-exclusion is applied but not content-exercised (no chapter contains its own title); the element body exercises its own-element exclusion.',
    'The renderer name map takes every live book node title, including drift nodes, in renderer book order; native takes chapter titles only (kind chapter, book_order then id). The fixture has no drift nodes, so drift titles are neither linked natively nor covered here.',
    'Native backlinks scan chapters only; the renderer inline-mention index also counts element bodies and other sources as incoming references.',
    'No name collisions, trashed targets, retroactive linking on element creation or links split by other marks are exported; matcher collisions and draft/composition deferral are document-test evidence.',
    'Synthetic single-process data; no UI, IME, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/)/u.test(name)
      || [
        'scripts/apple-workspace-link-acceptance.mjs', 'scripts/apple-workspace-link-check.ts',
        'src/renderer/lib/extensions/entity-link.ts', 'src/renderer/lib/entity-link-names.ts',
        'src/renderer/lib/retroactive-entity-links.ts', 'src/renderer/domain/entity-kinds.ts',
        'src/renderer/lib/extensions/block-id.ts', 'src/renderer/lib/extensions/paragraph-indent.ts',
        'src/renderer/components/editor/chapter-static-html.ts', 'src/renderer/hooks/useEntityEditor.ts',
        'src/renderer/services/reference-projection.service.ts', 'src/renderer/services/reference-index-repository.ts',
        'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/@tiptap__y-tiptap@3.0.8.patch', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_entity_links');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Entity links evidence is stale; rerun its generator');
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
  const renderer = report.renderer;
  assert.equal(renderer.schemaVersion, 1);
  assert.equal(renderer.status, 'passed');
  assert.match(renderer.inputSha256, /^[a-f0-9]{64}$/u);
  assert.equal(renderer.schema.source, 'getStaticChapterSchema');
  assert(renderer.schema.marks.includes('entityLink'));
  assert.deepEqual(renderer.editor.omittedExtensions, omittedExtensions);
  for (const name of ['collaboration', 'starterKit', 'underline', 'link', 'textAlign', 'blockId', 'paragraphIndent', 'entityLink']) {
    assert(renderer.editor.extensions.includes(name), `Headless editor lacks production extension ${name}`);
  }
  assert(!renderer.editor.extensions.includes('undoRedo'), 'Yjs mode disables StarterKit undoRedo');
  assert.deepEqual(renderer.documents.map(item => item.name), documents.map(item => item.name));
  for (const [index, item] of renderer.documents.entries()) {
    const expected = documents[index];
    for (const key of ['sourceKind', 'blocks', 'linkKeys', 'selfSpansWithoutExclusion', 'links']) {
      assert.deepEqual(item[key], expected[key], `${item.name} ${key}`);
    }
    for (const check of ['decode', 'yjsAttributes', 'pureDetector']) assert.equal(item[check], 'passed');
    assert.deepEqual(item.autoDetect, { status: 'passed', transactions: 1, yjsUpdates: 1, undoSteps: 0 });
    assert.deepEqual(item.convergence, { status: 'passed', yjsUpdates: 0 });
    assert.match(item.stateSha256, /^[a-f0-9]{64}$/u);
    assert.match(item.textSha256, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(renderer.backlinks, backlinks);
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/link-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'entity-links.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native entity links evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/link-acceptance-');
  const before = sources();
  writeFileSync(`${directory}/source-before.json`, `${JSON.stringify(before, null, 2)}\n`);
  function run(name, command, args, extraEnv = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300_000,
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
      { NATIVE_WORKSPACE_LINK_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  assert(existsSync(`${directory}/entity-links.json`), 'The bridge test must export entity-links.json');
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-link-check.ts',
    `--input=${directory}/entity-links.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-link-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Entity links source changed during acceptance');
  const names = ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'entity-links.json', 'renderer.json', 'renderer.log', 'typecheck.log'];
  const report = { schemaVersion: 1, kind: 'native_entity_links', status: 'passed',
    source: { files: before, fingerprint: sha(JSON.stringify(before)) }, toolchain, suites,
    renderer: json(`${directory}/renderer.json`), strictTypeScript: 'passed', boundaries,
    rawEvidence: names.map(name => ({ path: `${directory}/${name}`, sha256: sha(readFileSync(`${directory}/${name}`)) })),
  };
  validate(report);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', suites: suites.map(({ name, passed }) => ({ name, passed })),
    rendererDocuments: report.renderer.documents.length, sourceFingerprint: report.source.fingerprint, rawEvidence: directory }));
}
