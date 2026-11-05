// `pnpm release:screenshots` runs this before each launch of its profile:
//   tsx --conditions=import src/dev-cli/showcase-seed-main.ts --db <library.db> --app-local-data <dir> --locale en|zh-CN
// It seeds a new release screenshot library (docs/release-screenshots.md) and
// prints one JSON result line. The promo recording
// (scripts/design-assets/promo-recording) seeds its shelf with it too.

import { installHeadlessRendererGlobals } from './headless-globals';

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('Usage: showcase-seed-main.ts --db <library.db> --app-local-data <directory> --locale en|zh-CN');
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const locale = option(args, '--locale');
  if (locale !== 'en' && locale !== 'zh-CN') throw new Error(`Unknown screenshot locale: ${locale}`);
  // Renderer stores read browser storage when their modules load.
  installHeadlessRendererGlobals();
  const { seedShowcaseLibrary } = await import('./seeds/showcase/library');
  const result = await seedShowcaseLibrary({
    databasePath: option(args, '--db'), appLocalDataDirectory: option(args, '--app-local-data'), locale,
    // The promo recording's shelf also carries the 阿Q正传 sample it opens.
    withAQ: args.includes('--with-a-q'),
  });
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
