// Generate read-only audit evidence from actual SQLite/Yjs seed libraries.
// Retained fixtures are synthetic and ignored; no desktop window is launched.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHeadlessRendererGlobals } from '../src/dev-cli/headless-globals';
import { SEED_PRESETS } from '../src/dev-cli/seeds/presets';
import type { SeedAuditReport } from '../src/dev-cli/seeds/audit';

async function main(): Promise<void> {
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'src/dev-cli/seed.ts', 'src/dev-cli/seeds/default-project.ts', 'src/dev-cli/seeds/presets.ts',
  'src/dev-cli/seeds/prose.ts', 'src/dev-cli/seeds/materials.ts', 'src/dev-cli/seeds/conversations.ts',
  'src/dev-cli/seeds/audit.ts', 'src/dev-cli/seeds/assets/manifest.json',
  'packages/prose-metrics/src/index.ts', 'scripts/run-seeded-dev.mjs', 'scripts/check-development-seed.ts',
];
const fingerprint = createHash('sha256');
for (const file of files) fingerprint.update(file).update('\0').update(await readFile(path.join(root, file))).update('\0');
const sourceFingerprint = fingerprint.digest('hex');
const args = process.argv.slice(2);
const output = path.join(root, 'docs/dev-cli/acceptance/seed-presets.json');
interface Evidence {
  schemaVersion: 1;
  sourceFingerprint: string;
  validation: string;
  results: Record<string, SeedAuditReport>;
}

if (args.includes('--check')) {
  const evidence = JSON.parse(await readFile(output, 'utf8')) as Evidence;
  if (evidence.schemaVersion !== 1 || evidence.sourceFingerprint !== sourceFingerprint)
    throw new Error('Development seed evidence is stale; run pnpm seed:acceptance');
  for (const [name, preset] of Object.entries(SEED_PRESETS)) {
    const report = evidence.results[name];
    for (const group of ['chapters', 'elements', 'inspirations', 'materialNotes', 'storylines', 'categories', 'todos', 'comments'] as const) {
      const observed = report?.bodies[group], budget = preset[group];
      if (!observed || observed.count !== budget.count || observed.totalWords !== budget.total
        || observed.minWords !== budget.min || observed.maxWords !== budget.max)
        throw new Error(`Development seed evidence failed: ${name}/${group}`);
    }
    if (report.agent.rounds !== preset.conversations.total || report.agent.maxRounds !== preset.conversations.max || report.foreignKeyViolations !== 0)
      throw new Error(`Development seed evidence failed: ${name} runtime/foreign keys`);
  }
  console.log('Source-matched stress/lite SQLite, Yjs and Agent recovery evidence verified; no UI timing claim.');
} else {
  if (args.length) throw new Error('Usage: pnpm seed:acceptance [--check]');
  installHeadlessRendererGlobals();
  const { seedDevelopmentDatabase } = await import('../src/dev-cli/seed');
  const { OfflineProductDatabase } = await import('../src/dev-cli/offline-database');
  const { auditDevelopmentSeed } = await import('../src/dev-cli/seeds/audit');
  const results: Record<string, SeedAuditReport> = {};
  for (const preset of Object.values(SEED_PRESETS)) {
    const directory = path.join(root, '.local-data/seed-preset-acceptance', sourceFingerprint.slice(0, 12), preset.name);
    const databasePath = path.join(directory, 'databases/library.db');
    await seedDevelopmentDatabase({ databasePath, appLocalDataDirectory: path.join(directory, 'app-local-data'), preset: preset.name,
      onProgress: message => console.error(`[${preset.name}] ${message}`) });
    const product = new OfflineProductDatabase(databasePath, { migrate: false });
    await product.open();
    try {
      const [project] = product.gateway.database.prepare('SELECT id FROM project').all() as { id: string }[];
      results[preset.name] = auditDevelopmentSeed(product.gateway.database, project.id, preset);
    } finally { await product.close(); }
  }
  const evidence: Evidence = { schemaVersion: 1, sourceFingerprint,
    validation: 'Actual migrated SQLite, reconstructed Yjs, material initial JSON, verified local asset receipts and canonical Agent checkpoint recovery. No native UI latency, FPS, memory or stability measurement is claimed.', results };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log('Generated docs/dev-cli/acceptance/seed-presets.json from both real seed libraries.');
}

}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
