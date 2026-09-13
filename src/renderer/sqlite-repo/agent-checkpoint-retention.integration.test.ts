import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCheckpointFixture, observeCheckpointQueries, checkpointDatabaseHash } from '../performance/agent-checkpoint-fixture';
import { recoverAgentRuntimeSnapshot } from '../lib/agent/runtime/recovery';

let directory: string; let fixture: Awaited<ReturnType<typeof openCheckpointFixture>>;
beforeEach(async () => { fixture = undefined!; directory = await mkdtemp(path.join(tmpdir(), 'drifting-checkpoint-retention-')); fixture = await openCheckpointFixture(path.join(directory, 'synthetic.db'), 6, true); });
afterEach(async () => { if (fixture) { expect(fixture.gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]); await fixture.close(); } await rm(directory, { recursive: true, force: true }); });

describe('checkpoint retention across real SQLite commits', () => {
  it('keeps the latest two actual anchors across failed-turn gaps', async () => {
    expect(await fixture.fullOrdinals()).toEqual([2, 4]); const next = await fixture.prepareMixed(); await next.commit();
    expect(await fixture.fullOrdinals()).toEqual([4, 6]);
    const snapshot = (await fixture.repository.loadRecoverySnapshot(fixture.session.id))!;
    expect((await recoverAgentRuntimeSnapshot(snapshot)).providerHistory.slice(-4)).toEqual(next.mixed.history);
  });
  it('uses the partial anchor index for both recovery reads and commit compaction', async () => {
    const observed = observeCheckpointQueries(fixture);
    await fixture.fullOrdinals(); const next = await fixture.prepareMixed(); await next.commit(); observed.restore();
    expect(observed.reads.length).toBeGreaterThan(2);
    for (const read of observed.reads) {
      expect(read.rows).toBeLessThanOrEqual(2);
      expect(read.plan.some(line => line.includes('idx_agent_runtime_checkpoint_full_anchor'))).toBe(true);
    }
  });
  it('acknowledges a transport retry whose original checkpoint is retained as a digest', async () => {
    const before = checkpointDatabaseHash(fixture.gateway); await fixture.persistence.commitTurn(fixture.firstInput!);
    expect(checkpointDatabaseHash(fixture.gateway)).toBe(before);
  });
  for (const point of ['compaction', 'lifecycle', 'commit'] as const) it(`rolls back new messages, new checkpoint and old-anchor compaction on ${point} failure`, async () => {
    const next = await fixture.prepareMixed(); const before = checkpointDatabaseHash(fixture.gateway);
    if (point === 'commit') {
      const commit = fixture.gateway.commit.bind(fixture.gateway); let reached = false; let faulted = false;
      const execute = fixture.gateway.execute.bind(fixture.gateway);
      fixture.gateway.execute = async (...args) => { const result = await execute(...args); if (/^update "agent_runtime_checkpoint"/i.test(args[0])) reached = true; return result; };
      fixture.gateway.commit = async id => { if (reached && !faulted) { faulted = true; throw new Error('Synthetic root commit failure'); } await commit(id); };
    } else fixture.gateway.failNextExecute(sql => point === 'compaction' ? /^update "agent_runtime_checkpoint"/i.test(sql) : /^update "agent_runtime_turn"/i.test(sql));
    await expect(next.commit()).rejects.toThrow(); expect(checkpointDatabaseHash(fixture.gateway)).toBe(before);
    await next.commit(); expect(await fixture.fullOrdinals()).toEqual([4, 6]);
  });
  it('keeps malformed checkpoint payloads visible so recovery fails closed', async () => {
    fixture.gateway.database.prepare('UPDATE agent_runtime_checkpoint SET context_json=? WHERE through_turn_ordinal=4').run('{invalid');
    await expect(fixture.repository.loadRecoverySnapshot(fixture.session.id)).rejects.toThrow();
  });
  it('does not fall back to the older anchor when the newest checkpoint hash is corrupted', async () => {
    fixture.gateway.database.prepare('UPDATE agent_runtime_checkpoint SET context_hash=? WHERE through_turn_ordinal=4').run('sha256:corrupt');
    await expect(recoverAgentRuntimeSnapshot((await fixture.repository.loadRecoverySnapshot(fixture.session.id))!)).rejects.toThrow();
  });
});
