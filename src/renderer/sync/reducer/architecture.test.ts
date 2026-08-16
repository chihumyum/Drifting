import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(process.cwd(), 'src/renderer');
const allowed = new Set([
  path.join(rendererRoot, 'sync/journal/repository.ts'),
  path.join(rendererRoot, 'sync/reducer/sqlite-materializer.ts'),
]);

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(absolute));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      if (!entry.name.includes('.test.') && !entry.name.includes('.spec.')) files.push(absolute);
    }
  }
  return files;
}

describe('SQLite reducer architecture', () => {
  it('makes the typed reducer the only production remote receipt path', () => {
    for (const file of productionTypeScriptFiles(rendererRoot)) {
      if (allowed.has(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /\b(?:stageRemoteChangeSetInTransaction|completeRemoteApplyInTransaction|recordRemoteApplyInTransaction)\b/u,
      );
    }
  });

  it('does not let the SQLite metadata adapter own provider or native APIs', () => {
    const source = fs.readFileSync(
      path.join(rendererRoot, 'sync/reducer/sqlite-materializer.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/ObjectLogProvider|Google|OAuth|@tauri-apps|uploadImmutable/u);
  });
});
