import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The design system's documents read as one: a contract may live in any of them. */
export function designSystemDocs(): string {
  const directory = resolve(process.cwd(), 'docs/design-system');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => readFileSync(resolve(directory, name), 'utf8'))
    .join('\n\n');
}
