import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectTable } from '../renderer/schema/drizzle';
import { installHeadlessRendererGlobals } from './headless-globals';
import { DEV_CLI_TABLE_MODEL_COVERAGE } from './manifest';
import { OfflineProductDatabase } from './offline-database';
import {
  describeOfflineWorkspaceTools,
  executeOfflineWorkspaceTool,
  inspectWorkspaceDatabase,
} from './offline-workspace';
import { loadScenario, runScenario } from './scenario';

const directories: string[] = [];
const PROJECT_ID = 'cli-project';
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('offline workspace CLI runtime', () => {
  it('executes canonical read and write tools with durable receipts and Yjs authority', async () => {
    installHeadlessRendererGlobals();
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-dev-cli-'));
    directories.push(directory);
    const product = new OfflineProductDatabase(path.join(directory, 'fixture.db'), {
      migrate: true,
    });
    await product.open();
    try {
      const at = '2026-08-13T00:00:00.000Z';
      await product.client.insert(ProjectTable).values({
        id: PROJECT_ID,
        userId: 'cli-user',
        name: 'CLI Book',
        summary: '',
        kvJson: '[]',
        storylineTemplateKvJson: '[]',
        createdAt: at,
        updatedAt: at,
      });

      const empty = await executeOfflineWorkspaceTool({
        database: product.client,
        projectId: PROJECT_ID,
        toolName: 'list_chapters',
        arguments: {},
        requestId: 'read-empty',
      });
      expect(empty.result).toMatchObject({ ok: true });

      const created = await executeOfflineWorkspaceTool({
        database: product.client,
        projectId: PROJECT_ID,
        toolName: 'create_chapter',
        arguments: { title: '第一章', body: '最初的潮声。', summary: '开端' },
        requestId: 'create-chapter',
      });
      expect(created.result).toMatchObject({ ok: true });

      const chapter = await executeOfflineWorkspaceTool({
        database: product.client,
        projectId: PROJECT_ID,
        toolName: 'read_chapter',
        arguments: { chapter: '第一章' },
        requestId: 'read-chapter',
      });
      expect(chapter.result, JSON.stringify(chapter.result)).toMatchObject({ ok: true });

      const replaced = await executeOfflineWorkspaceTool({
        database: product.client,
        projectId: PROJECT_ID,
        toolName: 'replace_chapter_body',
        arguments: { chapter: '第一章', body: '新的潮声覆盖旧岸。' },
        requestId: 'replace-chapter',
      });
      expect(replaced.result, JSON.stringify(replaced.result)).toMatchObject({ ok: true });

      const scalar = (sql: string) => {
        const row = product.gateway.database.prepare(sql).get() as Record<string, unknown>;
        return Number(Object.values(row)[0] ?? 0);
      };
      expect(
        scalar("SELECT count(*) FROM book_node WHERE title = '第一章' AND deleted_at IS NULL"),
      ).toBe(1);
      expect(scalar('SELECT count(*) FROM yjs_snapshots')).toBeGreaterThan(0);
      expect(
        scalar("SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'result_committed'"),
      ).toBe(2);
      expect(scalar('SELECT count(*) FROM agent_runtime_entity_write_receipt')).toBeGreaterThan(0);

      const inspection = (await inspectWorkspaceDatabase(
        product.client,
        product.gateway.database,
        PROJECT_ID,
      )) as { tableCount: number; tables: Array<{ table: string; projectRows: number | null }> };
      expect(inspection.tableCount).toBe(Object.keys(DEV_CLI_TABLE_MODEL_COVERAGE).length);
      expect(inspection.tables.find((table) => table.table === 'book_node')?.projectRows).toBe(1);

      const description = await describeOfflineWorkspaceTools(
        product.client,
        PROJECT_ID,
        'replace_chapter_body',
      );
      expect(description).toMatchObject({
        count: 1,
        tools: [{ name: 'replace_chapter_body', access: 'write' }],
      });
    } finally {
      await product.close();
    }
  });

  it('runs the checked-in chapter lifecycle scenario end to end', async () => {
    installHeadlessRendererGlobals();
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-dev-cli-scenario-'));
    directories.push(directory);
    const product = new OfflineProductDatabase(path.join(directory, 'scenario.db'), {
      migrate: true,
    });
    await product.open();
    try {
      const at = '2026-08-13T00:00:00.000Z';
      await product.client.insert(ProjectTable).values({
        id: PROJECT_ID,
        userId: 'cli-user',
        name: 'CLI Scenario Book',
        summary: '',
        kvJson: '[]',
        storylineTemplateKvJson: '[]',
        createdAt: at,
        updatedAt: at,
      });
      const scenario = await loadScenario(
        fileURLToPath(
          new URL('../../docs/dev-cli/scenarios/chapter-lifecycle.json', import.meta.url),
        ),
      );
      await expect(
        runScenario({
          document: scenario,
          database: product,
          projectId: PROJECT_ID,
          requestId: 'scenario',
        }),
      ).resolves.toMatchObject({ name: 'chapter-lifecycle', steps: 3 });
    } finally {
      await product.close();
    }
  });

  it('launches the package CLI with ESM-only runtime dependencies', async () => {
    installHeadlessRendererGlobals();
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-dev-cli-launch-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'launch.db');
    const product = new OfflineProductDatabase(databasePath, { migrate: true });
    await product.open();
    try {
      const at = '2026-08-13T00:00:00.000Z';
      await product.client.insert(ProjectTable).values({
        id: PROJECT_ID,
        userId: 'cli-user',
        name: 'CLI Launch Book',
        summary: '',
        kvJson: '[]',
        storylineTemplateKvJson: '[]',
        createdAt: at,
        updatedAt: at,
      });
    } finally {
      await product.close();
    }

    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    const launched = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      [
        'dev:cli',
        'workspace',
        'call',
        'get_project_overview',
        '--project',
        PROJECT_ID,
        '--db',
        databasePath,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: environment,
        timeout: 30_000,
      },
    );

    expect(launched.status, `${launched.stdout}\n${launched.stderr}`).toBe(0);
    const jsonLine = launched.stdout
      .split('\n')
      .find((line) => line.startsWith('{"ok"'));
    expect(jsonLine, launched.stdout).toBeTruthy();
    expect(JSON.parse(jsonLine ?? '{}')).toMatchObject({
      ok: true,
      command: 'workspace call get_project_overview',
      data: { result: { ok: true, data: { name: 'CLI Launch Book' } } },
    });
  });
});
