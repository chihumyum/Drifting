#!/usr/bin/env node
// Real SDK -> packaged app binary -> native socket -> mounted renderer runtime.
// Mutations are restricted to a deliberately named synthetic acceptance project.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [command, connection, mode = 'write'] = process.argv.slice(2);
assert.ok(
  command && connection,
  'Usage: mcp-live-smoke.mjs <app executable> <connection file> [write|read|editor|reconnect|revoked|unmounted]',
);
assert.ok(['write', 'read', 'editor', 'reconnect', 'revoked', 'unmounted'].includes(mode));
const checks = [];
const clients = [];
const record = (name) => checks.push({ name, status: 'passed' });
async function connect() {
  const client = new Client({ name: 'Drifting synthetic MCP acceptance', version: '1' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command,
      args: ['--mcp', '--connection', connection],
      stderr: 'pipe',
    }),
  );
  return client;
}
async function call(client, name, args = {}, success = true) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(result.isError), !success, `${name}: ${JSON.stringify(result.content)}`);
  // Clients such as Claude Code show structuredContent instead of content.
  assert.equal(result.structuredContent, undefined, `${name} must not send structuredContent`);
  return {
    presentation: result._meta?.['cc.drifting/presentation'],
    text: result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'),
  };
}
try {
  if (mode === 'revoked') {
    await assert.rejects(connect());
    record('revoked credential cannot reconnect');
  } else {
    const client = await connect();
    record('official MCP SDK initializes packaged stdio endpoint');
    if (mode === 'unmounted') {
      await assert.rejects(client.listTools(), /authorized project/i);
      record('unmounted or other project is inaccessible');
    } else {
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, mode === 'read' ? 24 : 70);
      assert.ok(tools.some((tool) => tool.name === 'read_tool_result'));
      record('canonical domain definitions and pagination discovered');
      const overview = await call(client, 'get_project_overview');
      assert.equal(
        JSON.parse(overview.text).name,
        'MCP 验收',
        'Only the synthetic MCP acceptance project may be tested',
      );
      record('authorized synthetic project read');
      if (mode === 'read') {
        await call(client, 'create_chapter', { title: 'Denied synthetic chapter' }, false);
        record('read-only grant rejects tool invocation even when called by name');
      } else if (mode === 'editor') {
        const read = await call(client, 'read_chapter', { chapter: 'MCP acceptance chapter' });
        assert.match(JSON.stringify(read), /Local author note/);
        record('MCP sees the live editor author modification');
        await call(client, 'replace_chapter_body', {
          chapter: 'MCP acceptance chapter',
          body: '# Synthetic heading\n\nMCP persisted Chinese prose. 本机验收最终稿。\n\nLocal author note.\n\nExternal agent live update.',
        });
        record('external write committed while the editor is mounted');
      } else if (mode === 'reconnect') {
        const read = await call(client, 'read_chapter', { chapter: 'MCP acceptance chapter' });
        assert.match(JSON.stringify(read), /MCP persisted Chinese prose|本机验收/);
        record('persisted Yjs text readable after app restart');
      } else {
        const title = 'MCP acceptance chapter';
        await call(client, 'create_chapter', {
          title,
          body: 'Initial synthetic prose. 本机验收初稿。',
        });
        record('chapter created through production domain tool');
        await call(client, 'read_chapter', { chapter: title });
        const updated = await call(client, 'replace_chapter_body', {
          chapter: title,
          body: '# Synthetic heading\n\nMCP persisted Chinese prose. 本机验收修订稿。',
        });
        assert.ok(updated.presentation?.review?.id);
        record('prose write carries durable editor review');
        assert.match(
          JSON.stringify(await call(client, 'read_chapter', { chapter: title })),
          /本机验收修订稿/,
        );
        record('committed Yjs prose read back');
        const other = await connect();
        await call(
          other,
          'replace_chapter_body',
          { chapter: title, body: 'Unread overwrite must fail.' },
          false,
        );
        record('fresh external session cannot overwrite unread prose');
        await call(other, 'read_chapter', { chapter: title });
        await call(client, 'replace_chapter_body', {
          chapter: title,
          body: '# Synthetic heading\n\nMCP persisted Chinese prose. 本机验收最终稿。',
        });
        await call(
          other,
          'replace_chapter_body',
          { chapter: title, body: 'Stale overwrite must fail.' },
          false,
        );
        record('concurrent stale external writer rejected');
        await call(client, 'create_inspiration', {
          title: 'MCP disposable inspiration',
          body: 'Synthetic disposable note.',
        });
        await call(client, 'delete_inspiration', { inspiration: 'MCP disposable inspiration' });
        record('explicit destructive grant uses canonical soft delete');
      }
    }
  }
  mkdirSync('.local-data/mcp-acceptance', { recursive: true });
  writeFileSync(
    `.local-data/mcp-acceptance/live-${mode}.json`,
    JSON.stringify(
      {
        kind: 'packaged-mac-mcp-sdk',
        generatedAt: new Date().toISOString(),
        synthetic: true,
        status: 'passed',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`MCP live ${mode}: ${checks.length} checks passed.`);
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}
