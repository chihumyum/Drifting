import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const engineRoot = path.resolve(process.cwd(), 'src/renderer/sync/engine');

function productionFiles(): string[] {
  return fs
    .readdirSync(engineRoot)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(engineRoot, name));
}

function transactionCallbacks(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const callbacks: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction'
    ) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        callbacks.push(callback.body.getText(parsed));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return callbacks;
}

describe('SyncEngine architecture', () => {
  it('keeps provider I/O outside SQLite, Drizzle, Tauri, and renderer domain transactions', () => {
    for (const file of productionFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      if (file.endsWith('sqlite-repository.ts')) {
        expect(source, file).not.toMatch(/ObjectLogProvider|uploadImmutable|downloadImmutable|listChanges/u);
        continue;
      }
      if (file.endsWith('durable-runtime.ts')) {
        // The durable adapter owns both ports, but provider calls must never
        // occur lexically inside one of its SQLite transaction callbacks.
        for (const callback of transactionCallbacks(source, file)) {
          expect(callback, file).not.toMatch(/this\.provider\./u);
        }
        continue;
      }
      expect(source, file).not.toMatch(/from ['"][^'"]*(?:schema|lib\/db|sqlite-repo)[^'"]*['"]/u);
      expect(source, file).not.toMatch(/from ['"]drizzle-orm/u);
      expect(source, file).not.toMatch(/from ['"]@tauri-apps/u);
      expect(source, file).not.toMatch(/\bDbTransaction\b|\.transaction\s*\(/u);
    }
  });

  it('keeps every engine module provider-neutral', () => {
    for (const file of productionFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/google-drive|\bGoogle\b|\bOAuth\b|\bHTTP\b|@tauri-apps/iu);
    }
  });

  it('exposes separate durable and provider cycle operation contracts', () => {
    const source = fs.readFileSync(path.join(engineRoot, 'cycle.ts'), 'utf8');
    const durableBlock = source.slice(
      source.indexOf('export interface DurableCycleOperations'),
      source.indexOf('/** Provider methods'),
    );
    const providerBlock = source.slice(
      source.indexOf('export interface ProviderCycleOperations'),
      source.indexOf('export interface SyncGenerationCycleStatus'),
    );
    expect(durableBlock).not.toMatch(/pull|publish|ObjectLogProvider/u);
    expect(providerBlock).not.toMatch(/transaction|DbTransaction|sqlite|drizzle/ui);
  });
});
