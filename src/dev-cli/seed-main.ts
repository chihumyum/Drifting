// `pnpm dev:seed` runs this before launching the isolated profile:
//   tsx --conditions=import src/dev-cli/seed-main.ts --db <library.db> [--preset stress|lite] [--scenario <file>]
// It prints one JSON result line.

import { installHeadlessRendererGlobals } from './headless-globals';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const databasePath = option(args, '--db');
  if (!databasePath) throw new Error('Usage: seed-main.ts --db <library.db> [--preset stress|lite] [--scenario <file>]');
  // Renderer stores read browser storage when their modules load.
  installHeadlessRendererGlobals();
  const { seedDevelopmentDatabase } = await import('./seed');
  const { seedPreset } = await import('./seeds/presets');
  const result = await seedDevelopmentDatabase({
    databasePath, scenarioPath: option(args, '--scenario'), preset: seedPreset(option(args, '--preset')).name, appLocalDataDirectory: option(args, '--app-local-data'),
    onProgress: message => console.error(message),
  });
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
