import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  applyPreparedYjsProseUpdate,
  createYjsProseSeedState,
  deserializePreparedYjsProseCommand,
  hashYjsProseState,
  prepareYjsProseCommand,
  replaceYjsProseBlocks,
  serializePreparedYjsProseCommand,
  snapshotYjsProseBlocks,
  toPortablePreparedYjsProseCommand,
  type YjsProseBlock,
  type YjsProseCommandSource,
  type YjsProseNode,
  type YjsProseOperation,
} from './yjs-prose-command';

function cloneDoc(source: Y.Doc, gc = false): Y.Doc {
  const clone = new Y.Doc({ gc });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source), 'test-clone');
  return clone;
}

function bytes(bytes: Uint8Array): number[] {
  return [...bytes];
}

function richBlock(id: string, seed: number): YjsProseBlock {
  const variant = seed % 3;
  const richText: YjsProseNode[] = [
    {
      kind: 'text' as const,
      text: `角色${seed}`,
      marks: {
        bold: {},
        entityLink: {
          targetBlockId: seed % 2 === 0 ? `target-block-${seed}` : null,
          targetId: `entity-${seed}`,
          targetKind: seed % 2 === 0 ? 'element' : 'node',
        },
      },
    },
    {
      kind: 'text' as const,
      text: ` crossed scene ${seed}.`,
      marks: {
        italic: {},
        link: {
          class: null,
          href: `https://example.test/${seed}`,
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
          title: `scene-${seed}`,
        },
        underline: {},
      },
    },
  ];

  if (variant === 0) {
    return {
      id,
      type: 'paragraph',
      attrs: { textAlign: seed % 2 === 0 ? 'left' : 'right' },
      content: richText,
    };
  }
  if (variant === 1) {
    return {
      id,
      type: 'heading',
      attrs: { level: (seed % 3) + 1, textAlign: 'center' },
      content: richText,
    };
  }
  return {
    id,
    type: 'blockquote',
    attrs: { 'data-variant': `quote-${seed}` },
    content: [
      {
        kind: 'element',
        type: 'paragraph',
        attrs: { id: `nested-${id}`, textAlign: 'left' },
        content: richText,
      },
    ],
  };
}

function baseBlocks(seed: number): YjsProseBlock[] {
  return Array.from({ length: 4 }, (_, index) =>
    richBlock(`base-${seed}-${index}`, seed * 10 + index),
  );
}

function createDoc(blocks: readonly YjsProseBlock[], clientId = 0x51a7e): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientId;
  replaceYjsProseBlocks(doc, blocks);
  return doc;
}

function expectedAfter(
  before: readonly YjsProseBlock[],
  operation: YjsProseOperation,
): YjsProseBlock[] {
  const result = structuredClone(before) as YjsProseBlock[];
  switch (operation.kind) {
    case 'insert': {
      const at =
        operation.afterBlockId === null
          ? 0
          : result.findIndex((block) => block.id === operation.afterBlockId) + 1;
      result.splice(at, 0, ...(structuredClone(operation.blocks) as YjsProseBlock[]));
      return result;
    }
    case 'edit': {
      const at = result.findIndex((block) => block.id === operation.blockId);
      result.splice(at, 1, structuredClone(operation.block) as YjsProseBlock);
      return result;
    }
    case 'edit_many':
      for (const edit of operation.edits) {
        const at = result.findIndex((block) => block.id === edit.blockId);
        result.splice(at, 1, structuredClone(edit.block) as YjsProseBlock);
      }
      return result;
    case 'remove':
      return result.filter((block) => !operation.blockIds.includes(block.id));
    case 'replace': {
      const from = result.findIndex((block) => block.id === operation.fromBlockId);
      const to = result.findIndex((block) => block.id === operation.toBlockId);
      result.splice(
        from,
        to - from + 1,
        ...(structuredClone(operation.blocks) as YjsProseBlock[]),
      );
      return result;
    }
    case 'append':
      result.push(...(structuredClone(operation.blocks) as YjsProseBlock[]));
      return result;
  }
}

function seededRandom(seed: number): () => number {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function operationFor(seed: number, before: readonly YjsProseBlock[]): YjsProseOperation {
  const random = seededRandom(seed);
  const index = () => Math.floor(random() * before.length);
  switch (seed % 5) {
    case 0:
      return {
        kind: 'insert',
        afterBlockId: random() < 0.25 ? null : before[index()].id,
        blocks: [richBlock(`insert-${seed}`, seed + 1000)],
      };
    case 1: {
      const at = index();
      return {
        kind: 'edit',
        blockId: before[at].id,
        block: richBlock(before[at].id, seed + 2000),
      };
    }
    case 2:
      return {
        kind: 'remove',
        blockIds: [before[index()].id],
      };
    case 3: {
      const first = index();
      const second = index();
      const from = Math.min(first, second);
      const to = Math.max(first, second);
      return {
        kind: 'replace',
        fromBlockId: before[from].id,
        toBlockId: before[to].id,
        blocks: [
          richBlock(`replace-${seed}-a`, seed + 3000),
          richBlock(`replace-${seed}-b`, seed + 3001),
        ],
      };
    }
    case 4:
      return {
        kind: 'append',
        blocks: [
          richBlock(`append-${seed}-a`, seed + 4000),
          richBlock(`append-${seed}-b`, seed + 4001),
        ],
      };
  }
  throw new Error(`Unsupported operation seed ${seed}.`);
}

function sourceFor(kind: 'live' | 'closed' | 'seed', doc: Y.Doc, revision: number): YjsProseCommandSource {
  if (kind === 'live') return { kind, doc, revision };
  return { kind, stateUpdate: Y.encodeStateAsUpdate(doc), revision };
}

describe('Yjs prose command', () => {
  it('prepares deterministic forward/inverse updates and preserves rich block structure exactly', async () => {
    const source = createDoc(baseBlocks(1));
    const sourceHash = await hashYjsProseState(source);
    const sourceUpdate = Y.encodeStateAsUpdate(source);
    const operation: YjsProseOperation = {
      kind: 'replace',
      fromBlockId: 'base-1-1',
      toBlockId: 'base-1-2',
      blocks: [richBlock('replacement-rich', 99)],
    };
    const input = {
      commandId: 'command-rich-replace',
      source: { kind: 'live' as const, doc: source, revision: 17 },
      expectedBase: {
        revision: 17,
        stateVector: Y.encodeStateVector(source),
      },
      operation,
    };

    const first = await prepareYjsProseCommand(input);
    const second = await prepareYjsProseCommand(input);

    expect(bytes(first.forwardUpdate)).toEqual(bytes(second.forwardUpdate));
    expect(bytes(first.inverseUpdate)).toEqual(bytes(second.inverseUpdate));
    expect(first.durableWatermark.forwardUpdateHash).toBe(
      second.durableWatermark.forwardUpdateHash,
    );
    expect(first.durableWatermark.inverseUpdateHash).toBe(
      second.durableWatermark.inverseUpdateHash,
    );
    expect(bytes(Y.encodeStateAsUpdate(source))).toEqual(bytes(sourceUpdate));
    expect(await hashYjsProseState(source)).toBe(sourceHash);

    // Live editor docs use Yjs' default gc=true. The compensating update must
    // therefore remain self-contained even after the forward delete is GC'd.
    const applied = cloneDoc(source, true);
    await applyPreparedYjsProseUpdate(applied, first, 'forward');
    expect(snapshotYjsProseBlocks(applied)).toEqual(
      expectedAfter(snapshotYjsProseBlocks(source), operation),
    );
    expect(first.projection.blocks).toEqual(snapshotYjsProseBlocks(applied));
    expect(first.projection.contentJson).toBe(JSON.stringify(first.projection.document));
    expect(first.affectedBlockIds).toEqual([
      'base-1-1',
      'base-1-2',
      'replacement-rich',
    ]);

    await applyPreparedYjsProseUpdate(applied, first, 'inverse');
    expect(snapshotYjsProseBlocks(applied)).toEqual(snapshotYjsProseBlocks(source));
    expect(await hashYjsProseState(applied)).toBe(sourceHash);
    expect(first.durableWatermark.restoredStateHash).toBe(sourceHash);

    const projected = first.projection.document as {
      content: Array<{
        type: string;
        content?: Array<{
          type: string;
          content?: Array<{ marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }>;
        }>;
      }>;
    };
    const replacement = projected.content.find(
      (block) =>
        block.type === 'paragraph' ||
        (block.type === 'blockquote' && block.content?.[0]?.type === 'paragraph'),
    );
    expect(replacement).toBeDefined();
    expect(first.projection.contentJson).toContain('"entityLink"');
    expect(first.projection.contentJson).toContain('"targetBlockId"');
    expect(first.projection.contentJson).toContain('"underline"');
    source.destroy();
    applied.destroy();
  });

  it('rejects stale revision and state vector before touching the live Y.Doc', async () => {
    const source = createDoc(baseBlocks(2));
    const originalUpdate = bytes(Y.encodeStateAsUpdate(source));
    let sourceUpdates = 0;
    source.on('update', () => {
      sourceUpdates += 1;
    });
    const operation = operationFor(1, snapshotYjsProseBlocks(source));

    await expect(
      prepareYjsProseCommand({
        commandId: 'stale-revision',
        source: { kind: 'live', doc: source, revision: 8 },
        expectedBase: { revision: 7, stateVector: Y.encodeStateVector(source) },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });

    const foreign = createDoc(baseBlocks(3), 0x71234);
    await expect(
      prepareYjsProseCommand({
        commandId: 'stale-vector',
        source: { kind: 'live', doc: source, revision: 8 },
        expectedBase: { revision: 8, stateVector: Y.encodeStateVector(foreign) },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'STALE_STATE_VECTOR' });

    expect(sourceUpdates).toBe(0);
    expect(bytes(Y.encodeStateAsUpdate(source))).toEqual(originalUpdate);
    foreign.destroy();
    source.destroy();
  });

  it('uses vector plus semantic hash as an apply-time CAS guard', async () => {
    const source = createDoc(baseBlocks(4));
    const remove: YjsProseOperation = {
      kind: 'remove',
      blockIds: ['base-4-1'],
    };
    const prepared = await prepareYjsProseCommand({
      commandId: 'delete-only-cas',
      source: { kind: 'live', doc: source, revision: 2 },
      expectedBase: { revision: 2, stateVector: Y.encodeStateVector(source) },
      operation: remove,
    });

    // A delete-only Yjs update can keep the same state vector, so applying the
    // same command twice must be stopped by the semantic state hash.
    const divergentSameVector = cloneDoc(source);
    Y.applyUpdate(divergentSameVector, prepared.forwardUpdate, 'test-diverge');
    expect(bytes(Y.encodeStateVector(divergentSameVector))).toEqual(
      bytes(prepared.durableWatermark.baseStateVector),
    );
    const divergentHash = await hashYjsProseState(divergentSameVector);
    await expect(
      applyPreparedYjsProseUpdate(divergentSameVector, prepared, 'forward'),
    ).rejects.toMatchObject({ code: 'STALE_STATE_HASH' });
    expect(await hashYjsProseState(divergentSameVector)).toBe(divergentHash);

    const staleVector = cloneDoc(source);
    staleVector.transact(() => {
      staleVector.getMap('foreign').set('revision', 1);
    }, 'foreign-update');
    const staleVectorHash = await hashYjsProseState(staleVector);
    await expect(
      applyPreparedYjsProseUpdate(staleVector, prepared, 'forward'),
    ).rejects.toMatchObject({ code: 'STALE_STATE_VECTOR' });
    expect(await hashYjsProseState(staleVector)).toBe(staleVectorHash);

    source.destroy();
    divergentSameVector.destroy();
    staleVector.destroy();
  });

  it('normalizes live, closed, and seed inputs to the same Yjs command path', async () => {
    const source = createDoc(baseBlocks(5));
    const operation = operationFor(4, snapshotYjsProseBlocks(source));
    const expectedBase = { revision: 9, stateVector: Y.encodeStateVector(source) };
    const prepared = await Promise.all(
      (['live', 'closed', 'seed'] as const).map((kind) =>
        prepareYjsProseCommand({
          commandId: 'same-source-all-paths',
          source: sourceFor(kind, source, 9),
          expectedBase,
          operation,
        }),
      ),
    );

    expect(prepared.map((item) => bytes(item.forwardUpdate))).toEqual([
      bytes(prepared[0].forwardUpdate),
      bytes(prepared[0].forwardUpdate),
      bytes(prepared[0].forwardUpdate),
    ]);
    expect(prepared.map((item) => item.projection.blocks)).toEqual([
      prepared[0].projection.blocks,
      prepared[0].projection.blocks,
      prepared[0].projection.blocks,
    ]);
    expect(prepared.map((item) => item.durableWatermark.sourceKind)).toEqual([
      'live',
      'closed',
      'seed',
    ]);

    const emptySeed = new Y.Doc({ gc: false });
    const seeded = await prepareYjsProseCommand({
      commandId: 'empty-yjs-seed',
      source: {
        kind: 'seed',
        stateUpdate: Y.encodeStateAsUpdate(emptySeed),
        revision: 0,
      },
      expectedBase: { revision: 0, stateVector: Y.encodeStateVector(emptySeed) },
      operation: { kind: 'append', blocks: [richBlock('seed-first-block', 42)] },
    });
    expect(seeded.projection.allBlockIds).toEqual(['seed-first-block']);
    expect(seeded.projection.contentJson).toContain('seed-first-block');
    source.destroy();
    emptySeed.destroy();
  });

  it('converts a never-opened contentJson projection into a deterministic rich Yjs seed', async () => {
    const projection = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Alpha',
              marks: [{ type: 'bold' }],
            },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2, id: 'existing-id' },
          content: [{ type: 'text', text: 'Beta' }],
        },
      ],
    });
    const first = await createYjsProseSeedState(projection);
    const second = await createYjsProseSeedState(projection);
    expect(bytes(first)).toEqual(bytes(second));

    const seeded = new Y.Doc({ gc: false });
    Y.applyUpdate(seeded, first);
    const blocks = snapshotYjsProseBlocks(seeded);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'paragraph',
      content: [{ kind: 'text', text: 'Alpha', marks: { bold: {} } }],
    });
    expect(blocks[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(blocks[1].id).toBe('existing-id');
    seeded.destroy();
  });

  it('edits non-contiguous blocks atomically without touching the middle block', async () => {
    const source = createDoc(baseBlocks(7));
    const before = snapshotYjsProseBlocks(source);
    const operation: YjsProseOperation = {
      kind: 'edit_many',
      edits: [
        {
          blockId: before[0].id,
          block: richBlock(before[0].id, 7001),
        },
        {
          blockId: before[3].id,
          block: richBlock(before[3].id, 7003),
        },
      ],
    };
    const prepared = await prepareYjsProseCommand({
      commandId: 'edit-many-non-contiguous',
      source: { kind: 'live', doc: source, revision: 3 },
      expectedBase: {
        revision: 3,
        stateVector: Y.encodeStateVector(source),
      },
      operation,
    });
    expect(prepared.affectedBlockIds).toEqual([
      before[0].id,
      before[3].id,
    ]);
    expect(prepared.projection.blocks[1]).toEqual(before[1]);
    expect(prepared.projection.blocks[2]).toEqual(before[2]);

    const applied = cloneDoc(source);
    await applyPreparedYjsProseUpdate(applied, prepared, 'forward');
    expect(snapshotYjsProseBlocks(applied)).toEqual(
      expectedAfter(before, operation),
    );
    await applyPreparedYjsProseUpdate(applied, prepared, 'inverse');
    expect(snapshotYjsProseBlocks(applied)).toEqual(before);
    source.destroy();
    applied.destroy();
  });

  it('round-trips canonical portable JSON and retains executable forward/inverse deltas', async () => {
    const source = createDoc(baseBlocks(6));
    const sourceHash = await hashYjsProseState(source);
    const prepared = await prepareYjsProseCommand({
      commandId: 'portable-roundtrip',
      source: { kind: 'closed', stateUpdate: Y.encodeStateAsUpdate(source), revision: 23 },
      expectedBase: { revision: 23, stateVector: Y.encodeStateVector(source) },
      operation: operationFor(3, snapshotYjsProseBlocks(source)),
    });

    const portable = toPortablePreparedYjsProseCommand(prepared);
    const portableValues: unknown[] = [portable];
    while (portableValues.length > 0) {
      const value = portableValues.pop();
      expect(value).not.toBeInstanceOf(Uint8Array);
      if (Array.isArray(value)) portableValues.push(...value);
      else if (value && typeof value === 'object') {
        portableValues.push(...Object.values(value));
      }
    }

    const serialized = serializePreparedYjsProseCommand(prepared);
    expect(canonicalAgentRuntimeJson(portable)).toBe(serialized);
    const diskParsed = JSON.parse(serialized) as unknown;
    const restored = await deserializePreparedYjsProseCommand(diskParsed);
    expect(serializePreparedYjsProseCommand(restored)).toBe(serialized);
    expect(bytes(restored.forwardUpdate)).toEqual(bytes(prepared.forwardUpdate));
    expect(bytes(restored.inverseUpdate)).toEqual(bytes(prepared.inverseUpdate));

    const applied = cloneDoc(source, true);
    await applyPreparedYjsProseUpdate(applied, restored, 'forward');
    expect(await hashYjsProseState(applied)).toBe(prepared.projection.stateHash);
    await applyPreparedYjsProseUpdate(applied, restored, 'inverse');
    expect(await hashYjsProseState(applied)).toBe(sourceHash);
    expect(snapshotYjsProseBlocks(applied)).toEqual(snapshotYjsProseBlocks(source));

    const corrupted = JSON.parse(serialized) as {
      forwardUpdateBase64: string;
    };
    corrupted.forwardUpdateBase64 =
      `${corrupted.forwardUpdateBase64.slice(0, -4)}AAAA`;
    await expect(deserializePreparedYjsProseCommand(corrupted)).rejects.toMatchObject({
      code: 'INVALID_COMMAND',
    });
    source.destroy();
    applied.destroy();
  });

  it('survives 500 randomized rich-text insert/edit/remove/replace/append operations with zero data loss', async () => {
    const operationCounts = new Map<YjsProseOperation['kind'], number>();

    for (let seed = 0; seed < 500; seed += 1) {
      const source = createDoc(baseBlocks(seed + 10), 0x100000 + seed);
      const before = snapshotYjsProseBlocks(source);
      const beforeHash = await hashYjsProseState(source);
      const operation = operationFor(seed, before);
      operationCounts.set(operation.kind, (operationCounts.get(operation.kind) ?? 0) + 1);
      const kind = (['live', 'closed', 'seed'] as const)[seed % 3];
      const revision = seed + 100;
      const prepared = await prepareYjsProseCommand({
        commandId: `randomized-command-${seed}`,
        source: sourceFor(kind, source, revision),
        expectedBase: {
          revision,
          stateVector: Y.encodeStateVector(source),
        },
        operation,
      });

      const applied = cloneDoc(source);
      await applyPreparedYjsProseUpdate(applied, prepared, 'forward');
      expect(snapshotYjsProseBlocks(applied), `forward seed ${seed}`).toEqual(
        expectedAfter(before, operation),
      );
      expect(await hashYjsProseState(applied), `forward hash seed ${seed}`).toBe(
        prepared.projection.stateHash,
      );
      await applyPreparedYjsProseUpdate(applied, prepared, 'inverse');
      expect(snapshotYjsProseBlocks(applied), `inverse seed ${seed}`).toEqual(before);
      expect(await hashYjsProseState(applied), `inverse hash seed ${seed}`).toBe(beforeHash);
      source.destroy();
      applied.destroy();
    }

    expect(Object.fromEntries(operationCounts)).toEqual({
      insert: 100,
      edit: 100,
      remove: 100,
      replace: 100,
      append: 100,
    });
  }, 30_000);
});
