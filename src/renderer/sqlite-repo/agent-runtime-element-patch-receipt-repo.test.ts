import { describe, expect, it } from 'vitest';

import type {
  AgentRuntimeElementPatchSnapshot,
  PersistedAgentRuntimeElementPatchReceipt,
} from '../domain/agent-runtime-element-patch-receipt';
import {
  elementPatchRevision,
  hashElementPatchValue,
} from '../lib/agent/runtime/element-patch-revision';
import {
  assertAgentRuntimeElementPatchReceiptIntegrity,
  type AgentRuntimeElementPatchReceiptEffectProvenance,
} from './agent-runtime-element-patch-receipt-repo';

const AT = '2026-07-30T00:00:00.000Z';

function snapshot(
  overrides: Partial<AgentRuntimeElementPatchSnapshot> = {},
): AgentRuntimeElementPatchSnapshot {
  return {
    id: 'patch-1',
    projectId: 'project-1',
    elementId: 'element-1',
    sourceNodeId: 'chapter-1',
    sourceBlockId: null,
    sourceBlockText: null,
    textAnchorJson: null,
    invalidatedAt: null,
    title: '旧标题',
    contentJson: '{"type":"doc","content":[]}',
    orderKey: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

async function receipt(input: {
  effectId: string;
  idempotencyKey: string;
  direction: 'forward' | 'inverse';
  toolName: 'create_element_patch' | 'update_element_patch';
  expectedRevision: string | null;
  postimage: AgentRuntimeElementPatchSnapshot | null;
}): Promise<PersistedAgentRuntimeElementPatchReceipt> {
  const postimageHash = input.postimage
    ? await hashElementPatchValue(input.postimage)
    : null;
  return {
    id: `agent-element-patch-receipt:${input.effectId}:${input.direction}`,
    effectId: input.effectId,
    commandId: `agent-element-patch:${input.idempotencyKey}`,
    direction: input.direction,
    projectId: 'project-1',
    sessionId: 'session-1',
    toolName: input.toolName,
    patchId: 'patch-1',
    expectedRevision: input.expectedRevision,
    resultRevision: postimageHash
      ? `element-patch:${postimageHash}`
      : null,
    postimage: input.postimage,
    postimageHash,
    createdAt: AT,
  };
}

function provenance(input: {
  effectId: string;
  idempotencyKey: string;
  toolName: 'create_element_patch' | 'update_element_patch';
  expectedRevision: string;
  preimage: AgentRuntimeElementPatchSnapshot | null;
  create: Record<string, unknown> | null;
  update: Record<string, unknown> | null;
}): AgentRuntimeElementPatchReceiptEffectProvenance {
  const payload = {
    kind: 'element_patch_command',
    commandId: `agent-element-patch:${input.idempotencyKey}`,
    effectId: input.effectId,
    toolName: input.toolName,
    projectId: 'project-1',
    elementId: 'element-1',
    patchId: 'patch-1',
    expectedEntityKind:
      input.toolName === 'create_element_patch'
        ? 'element_patch_set'
        : 'element_patch',
    expectedRevision: input.expectedRevision,
    create: input.create,
    update: input.update,
    preimage: input.preimage,
    reviewSnapshot: {
      version: 1,
      effectId: input.effectId,
      reviewId: `agent-review:${input.effectId}`,
      mode: 'approve',
    },
  };
  return {
    id: input.effectId,
    projectId: 'project-1',
    sessionId: 'session-1',
    toolName: input.toolName,
    idempotencyKey: input.idempotencyKey,
    preimage: input.preimage,
    forward: payload,
    inverse: payload,
  };
}

describe('agent runtime element patch receipt integrity', () => {
  it('accepts correctly paired create and update forward/inverse receipts', async () => {
    const createHash = await hashElementPatchValue([]);
    const createRevision = `element-patch-set:${createHash}`;
    const created = snapshot({
      title: '新补丁',
      contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
    });
    const createProvenance = provenance({
      effectId: 'effect-create',
      idempotencyKey: 'create-key',
      toolName: 'create_element_patch',
      expectedRevision: createRevision,
      preimage: null,
      create: {
        id: created.id,
        projectId: created.projectId,
        elementId: created.elementId,
        sourceNodeId: created.sourceNodeId,
        title: created.title,
        contentJson: created.contentJson,
      },
      update: null,
    });
    const createForward = await receipt({
      effectId: 'effect-create',
      idempotencyKey: 'create-key',
      direction: 'forward',
      toolName: 'create_element_patch',
      expectedRevision: createRevision,
      postimage: created,
    });
    const createInverse = await receipt({
      effectId: 'effect-create',
      idempotencyKey: 'create-key',
      direction: 'inverse',
      toolName: 'create_element_patch',
      expectedRevision: createForward.resultRevision,
      postimage: null,
    });
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        createForward,
        createProvenance,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        createInverse,
        createProvenance,
        createForward,
      ),
    ).resolves.toBeUndefined();

    const before = snapshot();
    const expectedRevision = await elementPatchRevision(before);
    const after = snapshot({
      title: '新标题',
      contentJson: '{"type":"doc","content":[{"type":"text"}]}',
      updatedAt: '2026-07-30T00:01:00.000Z',
    });
    const updateProvenance = provenance({
      effectId: 'effect-update',
      idempotencyKey: 'update-key',
      toolName: 'update_element_patch',
      expectedRevision,
      preimage: before,
      create: null,
      update: {
        title: after.title,
        contentJson: after.contentJson,
      },
    });
    const updateForward = await receipt({
      effectId: 'effect-update',
      idempotencyKey: 'update-key',
      direction: 'forward',
      toolName: 'update_element_patch',
      expectedRevision,
      postimage: after,
    });
    const restored = snapshot({ updatedAt: '2026-07-30T00:02:00.000Z' });
    const updateInverse = await receipt({
      effectId: 'effect-update',
      idempotencyKey: 'update-key',
      direction: 'inverse',
      toolName: 'update_element_patch',
      expectedRevision: updateForward.resultRevision,
      postimage: restored,
    });
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        updateForward,
        updateProvenance,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        updateInverse,
        updateProvenance,
        updateForward,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a result revision that is not derived from its postimage', async () => {
    const before = snapshot();
    const expectedRevision = await elementPatchRevision(before);
    const after = snapshot({ title: '新标题' });
    const effect = provenance({
      effectId: 'effect-revision',
      idempotencyKey: 'revision-key',
      toolName: 'update_element_patch',
      expectedRevision,
      preimage: before,
      create: null,
      update: { title: '新标题' },
    });
    const forged = await receipt({
      effectId: 'effect-revision',
      idempotencyKey: 'revision-key',
      direction: 'forward',
      toolName: 'update_element_patch',
      expectedRevision,
      postimage: after,
    });
    forged.resultRevision = `element-patch:${await hashElementPatchValue({
      forged: true,
    })}`;

    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(forged, effect),
    ).rejects.toMatchObject({ code: 'PATCH_RECEIPT_INTEGRITY' });
  });

  it('rejects forged update preimages and inverse postimages', async () => {
    const before = snapshot();
    const expectedRevision = await elementPatchRevision(before);
    const after = snapshot({ title: '新标题' });
    const effect = provenance({
      effectId: 'effect-forged-update',
      idempotencyKey: 'forged-update-key',
      toolName: 'update_element_patch',
      expectedRevision,
      preimage: snapshot({ title: '伪造旧标题' }),
      create: null,
      update: { title: '新标题' },
    });
    const forward = await receipt({
      effectId: 'effect-forged-update',
      idempotencyKey: 'forged-update-key',
      direction: 'forward',
      toolName: 'update_element_patch',
      expectedRevision,
      postimage: after,
    });
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(forward, effect),
    ).rejects.toMatchObject({ code: 'PATCH_RECEIPT_INTEGRITY' });

    const validEffect = provenance({
      effectId: 'effect-inverse',
      idempotencyKey: 'inverse-key',
      toolName: 'update_element_patch',
      expectedRevision,
      preimage: before,
      create: null,
      update: { title: '新标题' },
    });
    const validForward = await receipt({
      effectId: 'effect-inverse',
      idempotencyKey: 'inverse-key',
      direction: 'forward',
      toolName: 'update_element_patch',
      expectedRevision,
      postimage: after,
    });
    const forgedInverse = await receipt({
      effectId: 'effect-inverse',
      idempotencyKey: 'inverse-key',
      direction: 'inverse',
      toolName: 'update_element_patch',
      expectedRevision: validForward.resultRevision,
      postimage: snapshot({
        title: '没有恢复',
        updatedAt: '2026-07-30T00:02:00.000Z',
      }),
    });
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        forgedInverse,
        validEffect,
        validForward,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_RECEIPT_INTEGRITY' });
  });

  it('rejects create inverses carrying a postimage or a mismatched forward', async () => {
    const setRevision = `element-patch-set:${await hashElementPatchValue([])}`;
    const created = snapshot({ title: '新补丁' });
    const effect = provenance({
      effectId: 'effect-create-inverse',
      idempotencyKey: 'create-inverse-key',
      toolName: 'create_element_patch',
      expectedRevision: setRevision,
      preimage: null,
      create: {
        id: created.id,
        projectId: created.projectId,
        elementId: created.elementId,
        sourceNodeId: created.sourceNodeId,
        title: created.title,
        contentJson: created.contentJson,
      },
      update: null,
    });
    const forward = await receipt({
      effectId: 'effect-create-inverse',
      idempotencyKey: 'create-inverse-key',
      direction: 'forward',
      toolName: 'create_element_patch',
      expectedRevision: setRevision,
      postimage: created,
    });
    const forgedInverse = await receipt({
      effectId: 'effect-create-inverse',
      idempotencyKey: 'create-inverse-key',
      direction: 'inverse',
      toolName: 'create_element_patch',
      expectedRevision: forward.resultRevision,
      postimage: created,
    });
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        forgedInverse,
        effect,
        forward,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_RECEIPT_INTEGRITY' });

    const deletedInverse = await receipt({
      effectId: 'effect-create-inverse',
      idempotencyKey: 'create-inverse-key',
      direction: 'inverse',
      toolName: 'create_element_patch',
      expectedRevision: 'element-patch:sha256:'.padEnd(85, '0'),
      postimage: null,
    });
    await expect(
      assertAgentRuntimeElementPatchReceiptIntegrity(
        deletedInverse,
        effect,
        forward,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_RECEIPT_INTEGRITY' });
  });
});
