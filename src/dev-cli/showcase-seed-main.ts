// `pnpm release:screenshots` runs this before each launch of its profile:
//   tsx --conditions=import src/dev-cli/showcase-seed-main.ts --db <library.db> --app-local-data <dir> --locale en|zh-CN
// It seeds a new release screenshot library (docs/release-screenshots.md) and
// prints one JSON result line. The promo recording
// (scripts/design-assets/promo-recording) adds `--open-book <name>
// --open-chapter <title> [--open-memory <text>]` for a new, empty book (with
// that Project Memory) in place of the open one.

import { installHeadlessRendererGlobals } from './headless-globals';

const USAGE = 'Usage: showcase-seed-main.ts --db <library.db> --app-local-data <directory> --locale en|zh-CN [--open-book <name> --open-chapter <title> [--open-memory <text>]]';

function option(args: readonly string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(USAGE);
  if (required && !value) throw new Error(USAGE);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const locale = option(args, '--locale');
  if (locale !== 'en' && locale !== 'zh-CN') throw new Error(`Unknown screenshot locale: ${locale}`);
  const openBook = option(args, '--open-book', false);
  const openChapter = option(args, '--open-chapter', false);
  const openMemory = option(args, '--open-memory', false);
  if (Boolean(openBook) !== Boolean(openChapter)) throw new Error(USAGE);
  // Renderer stores read browser storage when their modules load.
  installHeadlessRendererGlobals();
  const { seedShowcaseLibrary } = await import('./seeds/showcase/library');
  const result = await seedShowcaseLibrary({
    databasePath: option(args, '--db')!, appLocalDataDirectory: option(args, '--app-local-data')!, locale,
    ...(openBook && openChapter ? { openBook: { name: openBook, chapterTitle: openChapter, memory: openMemory ?? null } } : {}),
  });
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
