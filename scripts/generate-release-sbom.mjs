import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const outputArgument = process.argv.slice(2).find((argument) => argument !== '--');
const output = path.resolve(root, outputArgument ?? 'dist/release/sbom.spdx.json');
const metadataBufferBytes = 64 * 1024 * 1024;
const cargo = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: metadataBufferBytes,
  }),
);
const npm = JSON.parse(
  execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: metadataBufferBytes,
  }),
);
const packages = new Map();

function addPackage(ecosystem, name, version, license, homepage) {
  if (!name || !version) return;
  const key = `${ecosystem}:${name}@${version}`;
  if (packages.has(key)) return;
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  packages.set(key, {
    SPDXID: `SPDXRef-Package-${id}`,
    name,
    versionInfo: version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: license || 'NOASSERTION',
    ...(homepage ? { homepage } : {}),
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:${ecosystem}/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
      },
    ],
  });
}

for (const item of cargo.packages ?? []) {
  addPackage('cargo', item.name, item.version, item.license, item.homepage);
}
function walkNpm(node) {
  for (const [name, dependency] of Object.entries(node?.dependencies ?? {})) {
    addPackage('npm', name, dependency.version, dependency.license, dependency.homepage);
    walkNpm(dependency);
  }
}
for (const project of npm) walkNpm(project);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const documentNamespace = `https://drifting.app/sbom/${packageJson.version}/${crypto.randomUUID()}`;
const rootId = 'SPDXRef-Drifting';
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `Drifting-${packageJson.version}`,
  documentNamespace,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ['Tool: Drifting generate-release-sbom.mjs'],
  },
  packages: [
    {
      SPDXID: rootId,
      name: 'Drifting',
      versionInfo: packageJson.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'AGPL-3.0-or-later',
      licenseDeclared: 'AGPL-3.0-or-later',
      homepage: 'https://drifting.app',
    },
    ...[...packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
  ],
  relationships: [...packages.values()].map((item) => ({
    spdxElementId: rootId,
    relationshipType: 'DEPENDS_ON',
    relatedSpdxElement: item.SPDXID,
  })),
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`${output}\n`);
