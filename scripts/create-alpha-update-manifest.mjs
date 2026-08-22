import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const required = (key) => {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const version = required('--version');
if (!/^0\.1\.\d+-alpha\.\d+$/u.test(version)) throw new Error('Alpha version is invalid');
const url = new URL(required('--url'));
if (url.protocol !== 'https:') throw new Error('Updater artifact URL must use HTTPS');
const signature = fs.readFileSync(required('--signature-file'), 'utf8').trim();
if (!signature) throw new Error('Updater signature is empty');
const notesFile = values.get('--notes-file');
const output = path.resolve(required('--output'));
const manifest = {
  version,
  notes: notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : '',
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': { signature, url: url.toString() },
  },
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
