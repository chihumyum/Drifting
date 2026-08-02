import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { P3FileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { AgentPermissionGrantMatch } from '../domain/agent-extension';
import { createAgentExtensionRepository } from './agent-extension-repo';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

describe('Agent extension SQLite authority', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists config and exact grants, deduplicates races, and revokes on config drift', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drifting-extension-'));
    directories.push(directory);
    const path = join(directory, 'agent.sqlite');
    const gateway = new P3FileBackedSqliteGateway(path);
    gateway.database.exec(`
      INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES ('project-a', 'Project A', 'user-a', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')
    `);
    const repository = createAgentExtensionRepository(gateway.client());
    const saved = await repository.saveServer({
      id: 'server-a',
      projectId: 'project-a',
      name: 'Research',
      transport: 'streamable_http',
      enabled: true,
      command: null,
      args: [],
      cwd: null,
      publicEnv: {},
      secretEnv: {},
      url: 'http://127.0.0.1:3210/mcp',
      publicHeaders: {},
      secretHeaders: { Authorization: 'keychain:mcp:authorization' },
      toolPolicy: { search: { access: 'read', approval: 'ask' } },
    });
    expect(saved.configRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(saved.healthStatus).toBe('connecting');

    const match: AgentPermissionGrantMatch = {
      projectId: 'project-a',
      sessionId: 'session-a',
      sourceKind: 'mcp',
      sourceId: 'server-a',
      providerToolName: 'mcp_server_a_search',
      remoteToolName: 'search',
      access: 'read',
      argumentsHash: HASH_A,
      toolDefinitionRevision: HASH_B,
      sourceConfigRevision: saved.configRevision,
    };
    const [first, duplicate] = await Promise.all([
      repository.createGrant({
        ...match,
        scope: 'project',
        createdAt: '2026-08-02T00:01:00.000Z',
      }),
      repository.createGrant({
        ...match,
        scope: 'project',
        createdAt: '2026-08-02T00:01:00.001Z',
      }),
    ]);
    expect(first.id).toBe(duplicate.id);
    await expect(repository.findGrant(match)).resolves.toMatchObject({
      id: first.id,
      status: 'active',
      scope: 'project',
    });
    await expect(
      repository.findGrant({ ...match, argumentsHash: HASH_B }),
    ).resolves.toBeNull();
    await expect(
      repository.findGrant({ ...match, remoteToolName: 'other' }),
    ).resolves.toBeNull();

    const changed = await repository.saveServer({
      ...saved,
      publicHeaders: { 'X-Revision': '2' },
    });
    expect(changed.configRevision).not.toBe(saved.configRevision);
    await expect(repository.findGrant(match)).resolves.toBeNull();
    await expect(repository.listGrants('project-a')).resolves.toMatchObject([
      { id: first.id, status: 'revoked' },
    ]);

    await gateway.close();
    const reopened = new P3FileBackedSqliteGateway(path, false);
    const reopenedRepository = createAgentExtensionRepository(reopened.client());
    await expect(reopenedRepository.listServers('project-a')).resolves.toMatchObject([
      {
        id: 'server-a',
        configRevision: changed.configRevision,
        publicHeaders: { 'X-Revision': '2' },
      },
    ]);
    await expect(reopenedRepository.listGrants('project-a')).resolves.toHaveLength(1);
    await reopened.close();
  });
});
