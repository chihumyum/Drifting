import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';

export function workspaceEvidenceFingerprint(root) {
  const hash = createHash('sha256').update(referenceEvidenceFingerprint(root));
  const files = ['scripts/reference-index-evidence.mjs', 'src-tauri/build.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  const visit = (directory, pattern) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file, pattern);
      else if (pattern.test(file)) files.push(file);
    }
  };
  visit('src-tauri/src', /\.rs$/);
  visit('src/dev-cli', /\.ts$/);
  for (const name of readdirSync(path.join(root, 'scripts'))) if (/^(run-)?workspace-/.test(name)) files.push(`scripts/${name}`);
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
}
