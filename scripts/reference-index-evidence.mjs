import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function referenceEvidenceFingerprint(root) {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const files = [];
  const visit = (directory, pattern) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, pattern);
      else if (pattern.test(file)) files.push(path.relative(root, file));
    }
  };
  visit(path.join(root, 'src/renderer'), /\.(ts|tsx|css)$/);
  visit(path.join(root, 'src/styles'), /\.css$/);
  visit(path.join(root, 'drizzle'), /\.(sql|json)$/);
  for (const file of readdirSync(path.join(root, 'scripts'))) {
    if (/^(run-)?reference-index-/.test(file)) files.push(`scripts/${file}`);
  }
  files.push('vitest.config.ts', 'vitest.shared.ts', 'package.json', 'pnpm-lock.yaml', 'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json', 'tailwind.config.js');
  return hash(files.sort().map((file) => `${file}\0${hash(readFileSync(path.join(root, file)))}`).join('\n'));
}
