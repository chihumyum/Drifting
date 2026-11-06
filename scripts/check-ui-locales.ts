import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { SUPPORTED_LOCALES } from '../src/shared/ui-locales';

const flatten = (object: object, prefix = ''): [string, string][] => Object.entries(object).flatMap(([key, value]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  assert.equal(typeof value === 'string' || (value !== null && typeof value === 'object'), true, path);
  return typeof value === 'string' ? [[path, value]] : flatten(value, path);
});
const tokens = (text: string) => [...text.matchAll(/\{\{([^{}]+)\}\}/gu)].map(match => match[1]).sort();
const canonical = (key: string) => key.replace(/_(?:one|other|many)$/u, '');
async function main() {
const folders = ['src/renderer/locales', 'src/share-web/locales'];
const sources = [
  'scripts/check-ui-locales.ts', 'scripts/generate-startup-locales.mjs', 'public/startup.js',
  'src/shared/ui-locales.ts', 'src/shared/startup-preferences.ts', 'src/shared/locale-format.ts',
  'src/renderer/lib/i18n.ts', 'src/renderer/lib/locale-resources.ts', 'src/share-web/i18n.ts', 'src/renderer/lib/agent/agent-tool-activity.ts',
  'src/renderer/features/settings/panels/BasicPreferencePanels.tsx', 'src/renderer/components/topBars/UserMenu.tsx',
  'src/renderer/store/settings-store.ts', 'src/renderer/features/preference-sync/preference-fields.ts',
  'src/renderer/shells/mobile/desk/MobileDesk.tsx',
  'src/renderer/shells/mobile/standalone/MobileSettingsView.tsx',
  'src/renderer/lib/char-sea/char-sea-text.ts', 'src/renderer/views/shelf/shelf-format.ts',
  'src/styles/interface-fonts.css', 'src/styles/ui-controls.css',
  ...folders.flatMap(folder => SUPPORTED_LOCALES.map(locale => `${folder}/${locale}.json`)),
];
const fingerprint = createHash('sha256');
for (const file of sources) fingerprint.update(file).update('\0').update(readFileSync(file));
const catalogs = [];
for (const folder of folders) {
  const load = (locale: string) => JSON.parse(readFileSync(`${folder}/${locale}.json`, 'utf8'));
  for (const locale of SUPPORTED_LOCALES) {
    const original = new Map(flatten(load(locale === 'zh-CN' ? 'zh-CN' : 'en')));
    const values = new Map(flatten(load(locale)));
    assert.deepEqual([...new Set([...values.keys()].map(canonical))].sort(), [...new Set([...original.keys()].map(canonical))].sort(), `${folder}:${locale} keys`);
    for (const [key, text] of values) {
      const source = original.get(key) ?? original.get(key.replace(/_many$/u, '_other'));
      assert.notEqual(source, undefined, `${locale}:${key} unexpected`);
      if (source!.trim()) assert.notEqual(text.trim(), '', `${locale}:${key} is empty`);
      else assert.equal(text, source, `${locale}:${key} intentionally blank`);
      assert.deepEqual(tokens(text), tokens(source!), `${locale}:${key} interpolation`);
      assert(!/900000\d\d|▁|<unk>/u.test(text), `${locale}:${key} contains translation artifacts`);
    }
    if (folder.includes('renderer')) {
      const instance = createInstance();
      await instance.init({ lng: locale, fallbackLng: false, resources: { [locale]: { translation: load(locale) } } });
      for (const count of [0, 1, 2, 5, 1000000]) {
        for (const key of ['manuscriptExport.chapterCount', 'agentActivity.unviewedChangeCount', 'projectPicker.desk.chaptersUnit']) {
          assert.notEqual(instance.t(key, { count }), key, `${locale}:${key}:${count}`);
        }
      }
    }
    catalogs.push({ surface: folder.includes('renderer') ? 'application' : 'share-reader', locale,
      strings: values.size, placeholderContract: 'passed', keyCoverage: 'complete',
    });
  }
}
const report = { kind: 'nine-language-interface', status: 'passed', sourceSha256: fingerprint.digest('hex'),
  sources, locales: SUPPORTED_LOCALES, catalogs,
  limitations: ['Automated coverage and browser behavior do not constitute native-speaker review.', 'Right-to-left languages are outside this milestone.'],
};
const output = 'docs/qa/interface-locales.json';
if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
else assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report, 'Run pnpm locales:evidence');
console.log(`Verified ${SUPPORTED_LOCALES.length} interface locales and ${catalogs.length} catalogs.`);

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
