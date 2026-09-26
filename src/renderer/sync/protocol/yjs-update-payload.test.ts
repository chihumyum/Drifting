import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { encodeCanonicalCbor } from './canonical-cbor';
import {
  parseYjsUpdatePayload,
  type YjsSourceRetentionProvenanceV1,
} from './yjs-update-payload';

function transactionPayload() {
  const doc = new Y.Doc();
  doc.clientID = 41;
  doc.getText('prose').insert(0, '甲🙂乙');
  const beforeSnapshot = Y.encodeSnapshot(Y.snapshot(doc));
  let update: Uint8Array | undefined;
  doc.once('update', (value: Uint8Array) => { update = new Uint8Array(value); });
  doc.getText('prose').delete(0, 1);
  if (!update) throw new Error('Synthetic delete produced no update');
  const transactionDeletes = [...Y.decodeUpdate(update).ds.clients]
    .sort(([left], [right]) => left - right)
    .flatMap(([client, ranges]) => ranges.map(({ clock, len }) => ({ client, clock, length: len })));
  doc.destroy();
  return {
    update,
    sourceRetentionProvenance: {
      version: 1 as const,
      kind: 'transaction-event' as const,
      beforeSnapshot,
      transactionDeletes,
    },
  };
}

function withProvenance(value: unknown) {
  return { update: Uint8Array.of(0, 0), sourceRetentionProvenance: value };
}

function eventProvenance(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'transaction-event',
    beforeSnapshot: Y.encodeSnapshot(Y.emptySnapshot),
    transactionDeletes: [],
    ...overrides,
  };
}

describe('Yjs update payload transaction evidence', () => {
  it('preserves omitted-provenance legacy bytes and ignores unknown top-level fields without rewriting input', () => {
    const legacy = { update: Uint8Array.of(255, 1) };
    const before = encodeCanonicalCbor(legacy);
    const parsed = parseYjsUpdatePayload(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed).not.toHaveProperty('sourceRetentionProvenance');
    expect(parsed.update).not.toBe(legacy.update);
    expect(encodeCanonicalCbor({ update: parsed.update })).toEqual(before);

    const extended = { ...legacy, future: { preserved: true } };
    const wire = encodeCanonicalCbor(extended);
    expect(parseYjsUpdatePayload(extended)).toEqual(parsed);
    expect(encodeCanonicalCbor(extended)).toEqual(wire);
  });

  it('keeps the existing non-empty byte contract without decoding or imposing a new update size cap', () => {
    const update = new Uint8Array(2 * 1024 * 1024);
    update[0] = 255;
    const parsed = parseYjsUpdatePayload({ update });
    expect(parsed.update).toEqual(update);
    expect(parsed.update).not.toBe(update);
  });

  it.each([null, undefined, [], {}, { update: [] }, { update: new ArrayBuffer(2) }, { update: new Uint8Array() }])(
    'rejects an invalid legacy payload %#',
    (payload) => { expect(() => parseYjsUpdatePayload(payload)).toThrow(TypeError); },
  );

  it('parses actual Yjs transaction bytes and snapshots without claiming authored deletion semantics', () => {
    const payload = transactionPayload();
    const parsed = parseYjsUpdatePayload(payload);
    expect(parsed).toEqual(payload);
    const source = parsed.sourceRetentionProvenance;
    if (source?.kind !== 'transaction-event') throw new Error('Expected transaction-event');
    expect(source.transactionDeletes).toEqual([{ client: 41, clock: 0, length: 1 }]);
    expect(Y.encodeSnapshot(Y.decodeSnapshot(source.beforeSnapshot))).toEqual(source.beforeSnapshot);
    expect(source).not.toHaveProperty('authoredDeletes');
  });

  it('returns independent copies of update, provenance, snapshot, array and every range', () => {
    const payload = transactionPayload();
    const parsed = parseYjsUpdatePayload(payload);
    const expected = transactionPayload();
    const source = parsed.sourceRetentionProvenance;
    if (source?.kind !== 'transaction-event') throw new Error('Expected transaction-event');
    expect(source).not.toBe(payload.sourceRetentionProvenance);
    expect(source.beforeSnapshot).not.toBe(payload.sourceRetentionProvenance.beforeSnapshot);
    expect(source.transactionDeletes).not.toBe(payload.sourceRetentionProvenance.transactionDeletes);
    expect(source.transactionDeletes[0]).not.toBe(payload.sourceRetentionProvenance.transactionDeletes[0]);
    payload.update.fill(254);
    payload.sourceRetentionProvenance.beforeSnapshot.fill(253);
    payload.sourceRetentionProvenance.transactionDeletes[0]!.clock = 7;
    payload.sourceRetentionProvenance.transactionDeletes.push({ client: 42, clock: 0, length: 1 });
    expect(parsed).toEqual(expected);
    Object.assign(source.transactionDeletes[0]!, { clock: 9 });
    expect(payload.sourceRetentionProvenance.transactionDeletes[0]!.clock).toBe(7);
  });

  it('accepts state-transfer evidence only as its own copied exact shape', () => {
    const source: YjsSourceRetentionProvenanceV1 = { version: 1, kind: 'state-transfer' };
    const parsed = parseYjsUpdatePayload(withProvenance(source));
    expect(parsed.sourceRetentionProvenance).toEqual(source);
    expect(parsed.sourceRetentionProvenance).not.toBe(source);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { version: 2, kind: 'state-transfer' },
    { version: '1', kind: 'state-transfer' },
    { version: 1, kind: 'authored-delete' },
    { version: 1, kind: 'state-transfer', transactionDeletes: [] },
    { version: 1, kind: 'state-transfer', beforeSnapshot: undefined },
    eventProvenance({ future: true }),
    { version: 1, kind: 'transaction-event', transactionDeletes: [] },
    { ...eventProvenance(), [Symbol('unknown')]: true },
  ])('rejects present malformed, unknown or over-specified provenance %# instead of downgrading', (source) => {
    expect(() => parseYjsUpdatePayload(withProvenance(source))).toThrow(TypeError);
  });

  it('does not downgrade a malformed inherited provenance field or accept missing own evidence keys', () => {
    const payload = Object.assign(Object.create({ sourceRetentionProvenance: undefined }), {
      update: Uint8Array.of(0, 0),
    });
    expect(() => parseYjsUpdatePayload(payload)).toThrow(/sourceRetentionProvenance/u);
    const inherited = Object.assign(Object.create({ version: 1, kind: 'transaction-event' }), {
      beforeSnapshot: Uint8Array.of(0, 0), transactionDeletes: [],
    });
    expect(() => parseYjsUpdatePayload(withProvenance(inherited))).toThrow(/exactly/u);
  });

  it.each([
    undefined,
    [],
    new Uint8Array(),
    Uint8Array.of(255),
    Uint8Array.of(0, 0, 0), // Valid empty snapshot with unconsumed trailing data.
    Uint8Array.of(128, 0, 0), // Non-minimal encoding of an empty DeleteSet.
    Uint8Array.of(0, 2, 1, 0, 1, 1), // Duplicate state-vector client entries.
    new Uint8Array(1024 * 1024 + 1),
  ])('rejects malformed, non-round-tripping or oversized snapshot %#', (beforeSnapshot) => {
    expect(() => parseYjsUpdatePayload(withProvenance(eventProvenance({ beforeSnapshot })))).toThrow(/beforeSnapshot/u);
  });

  it('accepts exact empty snapshot and boundary clock/client values, preserving adjacent range segmentation', () => {
    const transactionDeletes = [
      { client: 0, clock: 0, length: 1 },
      { client: 0, clock: 1, length: 1 },
      { client: Number.MAX_SAFE_INTEGER, clock: 0xffff_fffe, length: 1 },
    ];
    const parsed = parseYjsUpdatePayload(withProvenance(eventProvenance({ transactionDeletes })));
    expect(parsed.sourceRetentionProvenance).toEqual(eventProvenance({ transactionDeletes }));
  });

  it.each([
    null,
    {},
    [undefined],
    [{ client: 1, clock: 0 }],
    [{ client: 1, clock: 0, length: 1, future: true }],
    [{ client: -1, clock: 0, length: 1 }],
    [{ client: 0.5, clock: 0, length: 1 }],
    [{ client: Number.MAX_SAFE_INTEGER + 1, clock: 0, length: 1 }],
    [{ client: 1, clock: -1, length: 1 }],
    [{ client: 1, clock: 0.5, length: 1 }],
    [{ client: 1, clock: 0x1_0000_0000, length: 1 }],
    [{ client: 1, clock: 0, length: 0 }],
    [{ client: 1, clock: 0, length: -1 }],
    [{ client: 1, clock: 0, length: 0.5 }],
    [{ client: 1, clock: 0, length: Infinity }],
    [{ client: 1, clock: 0xffff_ffff, length: 1 }],
    [{ client: 1, clock: 0, length: 0x1_0000_0000 }],
    [{ client: 2, clock: 0, length: 1 }, { client: 1, clock: 0, length: 1 }],
    [{ client: 1, clock: 2, length: 1 }, { client: 1, clock: 0, length: 1 }],
    [{ client: 1, clock: 0, length: 2 }, { client: 1, clock: 1, length: 1 }],
    [{ client: 1, clock: 0, length: 1 }, { client: 1, clock: 0, length: 1 }],
  ])('rejects invalid, overflowing, unsorted or overlapping delete ranges %#', (transactionDeletes) => {
    expect(() => parseYjsUpdatePayload(withProvenance(eventProvenance({ transactionDeletes })))).toThrow(/transactionDeletes/u);
  });

  it('accepts 100,000 ranges and rejects 100,001 before reading elements', () => {
    const transactionDeletes = Array.from({ length: 100_000 }, (_, clock) => ({ client: 1, clock, length: 1 }));
    const parsed = parseYjsUpdatePayload(withProvenance(eventProvenance({ transactionDeletes })));
    const source = parsed.sourceRetentionProvenance;
    if (source?.kind !== 'transaction-event') throw new Error('Expected transaction-event');
    expect(source.transactionDeletes).toHaveLength(100_000);
    expect(source.transactionDeletes[99_999]).toEqual({ client: 1, clock: 99_999, length: 1 });
    expect(() => parseYjsUpdatePayload(withProvenance(eventProvenance({
      transactionDeletes: new Array(100_001),
    })))).toThrow(/at most 100000/u);
  });
});
