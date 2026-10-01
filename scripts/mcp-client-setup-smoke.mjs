#!/usr/bin/env node
// Run after connecting all three clients in the synthetic project UI.
// Reads only the selected MCP entries; never prints client configuration/tokens.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [appData, mode] = process.argv.slice(2);
assert.ok(
  appData && ['installed', 'revoked'].includes(mode),
  'Usage: mcp-client-setup-smoke.mjs <app data directory> installed|revoked',
);
const local = '.local-data/mcp-acceptance';
const registry = JSON.parse(readFileSync(join(appData, 'mcp/grants.json'), 'utf8'));
const checks = [];
const record = (name) => checks.push({ name, status: 'passed' });
const savedPath = join(local, 'oneclick-connections.json');
const readConfig = (installation, remove) =>
  JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import sys,json,tomllib
from pathlib import Path
client,path,name,before,remove=sys.argv[1:]
parse=tomllib.loads if client=='codex' else json.loads
current=parse(Path(path).read_text())
original=parse(Path(before).read_text())
key='mcp_servers' if client=='codex' else 'mcpServers'
entry=current.get(key,{}).pop(name,None)
assert (entry is None) == (remove=='true')
if key not in original and not current.get(key):current.pop(key,None)
assert current==original, 'Unrelated client configuration changed'
print(json.dumps(entry))
`,
        installation.client,
        installation.configPath,
        installation.serverName,
        join(local, `pre-oneclick-${installation.client}.config`),
        String(remove),
      ],
      { encoding: 'utf8' },
    ),
  );

if (mode === 'installed') {
  const grants = registry.grants.filter((grant) => grant.installation);
  assert.equal(grants.length, 3);
  assert.deepEqual(grants.map((grant) => grant.installation.client).sort(), [
    'antigravity',
    'claude_code',
    'codex',
  ]);
  const entries = [];
  for (const grant of grants) {
    const label = grant.installation.client;
    assert.equal(grant.access, 'read');
    assert.equal(grant.allowDangerous, false);
    const config = readConfig(grant.installation, false);
    record(`${label}: scoped entry installed and unrelated settings preserved`);
    const client = new Client({ name: 'Synthetic one-click setup acceptance', version: '1' });
    try {
      await client.connect(
        new StdioClientTransport({ command: config.command, args: config.args, stderr: 'pipe' }),
      );
      assert.equal((await client.listTools()).tools.length, 24);
      record(`${label}: installed command initializes and discovers read-only tools`);
      const overview = await client.callTool({ name: 'get_project_overview', arguments: {} });
      assert.ok(!overview.isError);
      const overviewText = overview.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.equal(JSON.parse(overviewText).name, 'MCP 验收');
      record(`${label}: authorized synthetic project is readable`);
      const denied = await client.callTool({
        name: 'create_chapter',
        arguments: { title: 'Denied synthetic chapter' },
      });
      assert.equal(denied.isError, true);
      record(`${label}: write is denied by native-authorized runtime scope`);
    } finally {
      await client.close();
    }
    entries.push({ id: grant.id, installation: grant.installation, config });
  }
  writeFileSync(savedPath, JSON.stringify(entries), { mode: 0o600 });
} else {
  const entries = JSON.parse(readFileSync(savedPath, 'utf8'));
  for (const entry of entries) {
    const label = entry.installation.client;
    assert.ok(!registry.grants.some((grant) => grant.id === entry.id));
    assert.ok(!existsSync(entry.config.args[2]));
    readConfig(entry.installation, true);
    record(`${label}: revoke removes credential and owned entry while preserving other settings`);
    const client = new Client({ name: 'Synthetic revoked setup acceptance', version: '1' });
    try {
      await assert.rejects(
        client.connect(
          new StdioClientTransport({
            command: entry.config.command,
            args: entry.config.args,
            stderr: 'pipe',
          }),
        ),
      );
      record(`${label}: revoked automatic connection cannot reconnect`);
    } finally {
      await client.close();
    }
  }
}
writeFileSync(
  join(local, `oneclick-${mode}.json`),
  JSON.stringify(
    {
      kind: 'packaged-mac-mcp-client-setup',
      generatedAt: new Date().toISOString(),
      status: 'passed',
      synthetic: true,
      checks,
    },
    null,
    2,
  ) + '\n',
);
if (mode === 'revoked') {
  const runs = ['installed', 'revoked'].map((mode) =>
    JSON.parse(readFileSync(join(local, `oneclick-${mode}.json`), 'utf8')),
  );
  writeFileSync(
    'docs/agent-runtime/acceptance/local-mcp-setup-mac.json',
    JSON.stringify(
      {
        kind: 'packaged-mac-mcp-client-setup',
        generatedAt: new Date().toISOString(),
        status: 'passed',
        synthetic: true,
        runs,
        boundaries: {
          ui: 'actual packaged app buttons clicked through native UI',
          client:
            'installed client configurations parsed; actual stdio commands tested with official MCP SDK',
          clientReload:
            'requires client restart or MCP service reload; current Codex task was not restarted',
          signing: 'local debug app, ad-hoc signed',
        },
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(`One-click ${mode}: ${checks.length} checks passed.`);
