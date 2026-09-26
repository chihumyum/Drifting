import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/generate-apple-fixtures.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/check-yrs-vendor.mjs'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-yrs-diagnostic.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-document-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-binding-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-prose-durability-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-original-operation-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-native-authoring-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-workspace-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-remote-prose-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-workspace-remote-acceptance.mjs', '--check'], { stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/apple-device-prerequisite-diagnostic.mjs', '--check'], { stdio: 'pipe' });
const read = path => readFileSync(path, 'utf8');
const inventory = JSON.parse(read('docs/apple-native/inventory.json'));
const ids = new Set(inventory.entries.map(entry => entry.id));
assert.equal(ids.size, inventory.entries.length, 'Duplicate inventory ID');
for (const entry of inventory.entries) {
  assert(entry.sources.length && entry.target && entry.acceptance.length && entry.status && entry.milestone, entry.id);
  assert(['retain-rust', 'port-business', 'replace-library', 'rebuild-ui'].includes(entry.strategy), entry.id);
  for (const source of entry.sources) assert(existsSync(source), `Missing inventory source: ${source}`);
  for (const dependency of entry.dependencies) assert(ids.has(dependency), `Unknown dependency: ${dependency}`);
  for (const decision of entry.decisionTask?.split('/') ?? []) assert(inventory.decisionTasks[decision], `Untracked decision: ${decision}`);
}
const surfaces = [
  ...readdirSync('src-tauri/src').filter(file => file.endsWith('.rs')).map(file => `src-tauri/src/${file}`),
  ...readdirSync('src/renderer/features', { withFileTypes: true }).filter(file => file.isDirectory()).map(file => `src/renderer/features/${file.name}`),
];
const coverage = surfaces.map(source => {
  const owners = inventory.entries.filter(entry => entry.sources.includes(source)).map(entry => entry.id);
  assert(owners.length, `New source surface needs migration disposition: ${source}`);
  return { source, owners };
});
const version = read('crates/drifting-core/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1];
assert.equal(version, JSON.parse(read('package.json')).version, 'Core migration marker version must match client');
assert.equal(version, read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1]);
const core = read('crates/drifting-core/src/database.rs');
assert(!/\btauri\b/.test(core), 'Database engine must be independent of Tauri');
assert(core.includes('include_dir!("$CARGO_MANIFEST_DIR/../../drizzle")'));
assert(read('src-tauri/src/database.rs').includes('pub use drifting_core::database::'));
const apple = read('native/apple/project.yml');
assert(!/DEVELOPMENT_TEAM:\s*"?[A-Za-z0-9]/.test(apple), 'Signing identity must remain local');
assert(apple.includes('cc.drifting.native-lab.macos') && apple.includes('cc.drifting.native-lab.ios'));
const capabilities = JSON.parse(read(inventory.agentCapabilitySource));
const sourceFiles = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
  .filter(file => file && existsSync(file) && (
    /^(crates\/|vendor\/yrs\/|native\/apple\/|docs\/apple-native\/|drizzle\/)/.test(file) || ['scripts/apple-workspace-remote-acceptance.mjs', 'scripts/apple-workspace-remote-check.ts', 'scripts/apple-remote-prose-acceptance.mjs', 'scripts/apple-remote-prose-wire-check.ts', 'scripts/apple-workspace-acceptance.mjs', 'scripts/apple-workspace-wire-check.ts', 'scripts/apple-binding-acceptance.mjs', 'scripts/apple-structure-oracle.ts', 'scripts/apple-outline-oracle.ts', 'scripts/apple-quote-history-oracle.ts', 'scripts/apple-comment-oracle.ts', 'scripts/check-yrs-vendor.mjs', 'scripts/apple-yrs-diagnostic.mjs', 'scripts/generate-yrs-provenance.mjs', 'scripts/apple-prose-journal-oracle.ts', 'scripts/apple-prose-durability-acceptance.mjs', 'scripts/apple-original-operation-oracle.ts', 'scripts/apple-original-body-archive-oracle.ts', 'scripts/apple-original-operation-acceptance.mjs', 'scripts/apple-native-authoring-acceptance.mjs', 'scripts/apple-native-journal-oracle.ts', 'scripts/apple-native-journal-wire-check.ts', 'scripts/apple-native-authoring-wire-check.ts', 'scripts/apple-native-event-order-oracle.ts', 'scripts/apple-editor-performance-baseline.ts', 'scripts/apple-editor-performance-ui.ts', 'scripts/apple-native-editor-performance.mjs', 'scripts/apple-renderer-performance-runner.mjs'].includes(file)
    || ['AGENTS.md', '.github/workflows/ci.yml', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/database.rs', 'src-tauri/src/native_capabilities.rs', 'scripts/check-apple-migration.mjs', 'scripts/apple-native.mjs', 'scripts/apple-native-acceptance.mjs', 'scripts/apple-document-acceptance.mjs', 'scripts/generate-apple-fixtures.mjs', 'scripts/apple-performance-rustc-wrapper.sh', 'scripts/apple-renderer-performance-diagnostic.mjs', 'scripts/apple-device-prerequisite-diagnostic.mjs', 'scripts/apple-system-ime-acceptance.mjs', inventory.agentCapabilitySource].includes(file)
  ) && !file.startsWith('docs/apple-native/acceptance/')).sort();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sources = sourceFiles.map(path => ({ path, sha256: sha256(readFileSync(path)) }));
const report = { schemaVersion: 1, kind: 'apple_native_migration_inventory',
  scope: 'P0 surface mapping and P1 source ownership; does not certify behavior or UI',
  entries: inventory.entries.length, coverage,
  agentCapabilities: { source: inventory.agentCapabilitySource, sha256: sha256(JSON.stringify(capabilities)) },
  source: { fingerprint: sha256(JSON.stringify(sources)),
    // Keep prose in the complete source inventory without invalidating native
    // build/UI evidence when only an upstream note or migration guide changes.
    runtimeFingerprint: sha256(JSON.stringify(sources.filter(file => !file.path.endsWith('.md')
      && (!file.path.startsWith('docs/') || file.path.startsWith('docs/apple-native/fixtures/'))))), files: sources },
  openDecisions: inventory.decisionTasks };
const output = 'docs/apple-native/acceptance/inventory.json';
if (process.argv.includes('--write')) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
else assert.deepEqual(JSON.parse(read(output)), report, 'Inventory/source evidence is stale: run pnpm apple:inventory');
console.log(`Apple migration: ${inventory.entries.length} capability groups, ${coverage.length} native/feature surfaces mapped; source ownership checked.`);
