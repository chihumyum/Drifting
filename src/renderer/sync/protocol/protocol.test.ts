import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  bytesToHex,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  hashCanonicalCbor,
  hexToBytes,
  sha256Bytes,
} from './canonical-cbor';
import {
  decodeSyncChangeSetV1,
  encodeSyncChangeSetV1,
  SYNC_MUTATION_ACTIONS,
  SYNC_MUTATION_ACTION_SCHEMA,
  SYNC_MUTATION_TARGET_FAMILIES,
  SYNC_MUTATION_TARGET_FAMILY_SCHEMA,
  validateSyncChangeSetV1Invariants,
  type SyncChangeSetV1,
} from './change-set';
import goldenFixtures from './fixtures/protocol-v1.golden.json';
import {
  GOLDEN_CHANGESET_V1,
  GOLDEN_PAYLOAD_V1,
  GOLDEN_SEGMENT_V1,
  GOLDEN_SNAPSHOT_COMMIT_V1,
  GOLDEN_SNAPSHOT_V1,
} from './fixtures/v1-fixtures';
import {
  compareSyncTotalOrder,
  compareUtf8Bytewise,
  nextLocalHlc,
  observeRemoteHlc,
} from './order';
import {
  LOCAL_OBJECT_REF_SCHEMA,
  PROVIDER_KINDS,
  PROVIDER_KIND_SCHEMA,
  PROVIDER_BINDING_SCHEMA,
  SYNC_OBJECT_KINDS,
  SYNC_OBJECT_KIND_SCHEMA,
  createLocalObjectRef,
} from './provider';
import { decodeSegmentV1, encodeSegmentV1 } from './segment';
import {
  decodeSnapshotCommitMarkerV1,
  decodeSnapshotPackageV1,
  encodeSnapshotCommitMarkerV1,
  encodeSnapshotPackageV1,
} from './snapshot';

describe('RFC 8949 deterministic CBOR', () => {
  it('encodes maps deterministically and keeps binary values as CBOR byte strings', () => {
    expect(bytesToHex(encodeCanonicalCbor({ b: 2, data: new Uint8Array([0, 255]), a: 1 }))).toBe(
      'a361610161620264646174614200ff',
    );
    expect(decodeCanonicalCbor(hexToBytes('a164646174614200ff'))).toMatchObject({
      ok: true,
      value: { data: new Uint8Array([0, 255]) },
    });
    expect(bytesToHex(encodeCanonicalCbor(1.5))).toBe('f93e00');
  });

  it('quarantines valid but non-deterministically ordered CBOR', () => {
    const decoded = decodeCanonicalCbor(hexToBytes('a2616202616101'));
    expect(decoded).toMatchObject({
      ok: false,
      disposition: 'quarantine',
      reason: 'non-canonical-cbor',
    });
  });

  it('rejects non-finite numbers, undefined, sparse arrays and malformed hex', () => {
    expect(() => encodeCanonicalCbor({ value: Number.NaN })).toThrow(/finite/u);
    expect(() => encodeCanonicalCbor({ value: undefined } as never)).toThrow(/unsupported/u);
    expect(() => encodeCanonicalCbor(Array(1) as never)).toThrow(/sparse/u);
    expect(() => hexToBytes('ABC')).toThrow(/lowercase/u);
  });
});

describe('UTF-8 and HLC total order', () => {
  it('orders strings by UTF-8 bytes instead of locale collation', () => {
    expect(compareUtf8Bytewise('z', 'é')).toBe(-1);
    expect(compareUtf8Bytewise('😀', '😁')).toBe(-1);
    expect(() => compareUtf8Bytewise('\ud800', '\ufffd')).toThrow(/surrogate/u);
  });

  it('uses every frozen tie-break field in order', () => {
    const base = {
      hlc: { wallMs: 10, counter: 1 },
      writerId: 'writer-a',
      writerEpoch: 'epoch-a',
      deviceSeq: 7,
      mutationIndex: 0,
    };
    expect(compareSyncTotalOrder(base, { ...base, writerEpoch: 'epoch-b' })).toBe(-1);
    expect(compareSyncTotalOrder(base, { ...base, mutationIndex: 1 })).toBe(-1);
    expect(compareSyncTotalOrder(base, base)).toBe(0);
  });

  it('advances local and received clocks monotonically', () => {
    expect(nextLocalHlc({ wallMs: 10, counter: 2 }, 9)).toEqual({ wallMs: 10, counter: 3 });
    expect(observeRemoteHlc({ wallMs: 10, counter: 2 }, { wallMs: 10, counter: 8 }, 9)).toEqual(
      { wallMs: 10, counter: 9 },
    );
    expect(observeRemoteHlc({ wallMs: 10, counter: 2 }, { wallMs: 12, counter: 4 }, 11)).toEqual(
      { wallMs: 12, counter: 5 },
    );
  });
});

describe('versioned change sets and segments', () => {
  it('keeps exported mutation constants and runtime unions in lockstep', () => {
    expect(SYNC_MUTATION_ACTIONS.every((action) => Value.Check(SYNC_MUTATION_ACTION_SCHEMA, action)))
      .toBe(true);
    expect(
      SYNC_MUTATION_TARGET_FAMILIES.every((family) =>
        Value.Check(SYNC_MUTATION_TARGET_FAMILY_SCHEMA, family),
      ),
    ).toBe(true);
    expect(Value.Check(SYNC_MUTATION_ACTION_SCHEMA, 'entity.delete')).toBe(false);
  });

  it('round-trips a complete change set and verifies each payload hash', async () => {
    expect(await hashCanonicalCbor(GOLDEN_PAYLOAD_V1)).toBe(
      GOLDEN_CHANGESET_V1.mutations[0].payloadSha256,
    );
    const decoded = await decodeSyncChangeSetV1(encodeSyncChangeSetV1(GOLDEN_CHANGESET_V1));
    expect(decoded).toMatchObject({ ok: true, value: GOLDEN_CHANGESET_V1 });
  });

  it('quarantines unknown protocol and payload versions without an upconverter', async () => {
    const unknownProtocol = encodeCanonicalCbor({
      ...GOLDEN_CHANGESET_V1,
      protocolVersion: 2,
    });
    await expect(decodeSyncChangeSetV1(unknownProtocol)).resolves.toMatchObject({
      ok: false,
      disposition: 'quarantine',
      reason: 'unsupported-protocol-version',
      observed: 2,
    });

    const unknownPayload = encodeCanonicalCbor({ ...GOLDEN_CHANGESET_V1, payloadVersion: 2 });
    await expect(decodeSyncChangeSetV1(unknownPayload)).resolves.toMatchObject({
      ok: false,
      disposition: 'quarantine',
      reason: 'unsupported-payload-version',
      observed: 2,
    });

    const unknownMutationPayload = structuredClone(GOLDEN_CHANGESET_V1) as unknown as Record<
      string,
      unknown
    >;
    const mutations = unknownMutationPayload.mutations as Array<Record<string, unknown>>;
    mutations[0].payloadVersion = 2;
    await expect(
      decodeSyncChangeSetV1(encodeCanonicalCbor(unknownMutationPayload as never)),
    ).resolves.toMatchObject({
      ok: false,
      disposition: 'quarantine',
      reason: 'unsupported-payload-version',
      path: '/mutations/0/payloadVersion',
      observed: 2,
    });
  });

  it('rejects partial indexes, mismatched action families and payload tampering', async () => {
    const invalid = structuredClone(GOLDEN_CHANGESET_V1) as SyncChangeSetV1;
    invalid.mutations[0].index = 1;
    invalid.mutations[0].target.family = 'set';
    expect(validateSyncChangeSetV1Invariants(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/mutations/0/index' }),
        expect.objectContaining({ path: '/mutations/0/target/family' }),
      ]),
    );
    expect(() => encodeSyncChangeSetV1(invalid)).toThrow(/invariants/u);

    const tampered = structuredClone(GOLDEN_CHANGESET_V1) as SyncChangeSetV1;
    tampered.mutations[0].payload = { field: 'title', value: 'Tampered' };
    await expect(decodeSyncChangeSetV1(encodeSyncChangeSetV1(tampered))).resolves.toMatchObject({
      ok: false,
      reason: 'integrity-mismatch',
      path: '/mutations/0/payloadSha256',
    });
  });

  it('requires one writer epoch, contiguous sequences and sorted blob dependencies', async () => {
    const bytes = encodeSegmentV1(GOLDEN_SEGMENT_V1);
    await expect(decodeSegmentV1(bytes)).resolves.toMatchObject({ ok: true });
    expect(() =>
      encodeSegmentV1({
        ...GOLDEN_SEGMENT_V1,
        header: { ...GOLDEN_SEGMENT_V1.header, requiredBlobIds: ['blob-z', 'blob-a'] },
      }),
    ).toThrow(/requiredBlobIds/u);
  });
});

describe('snapshot packages and commit markers', () => {
  it('verifies canonical authored/reducer sections, Yjs bytes and seed payloads', async () => {
    const bytes = encodeSnapshotPackageV1(GOLDEN_SNAPSHOT_V1);
    await expect(decodeSnapshotPackageV1(bytes)).resolves.toMatchObject({ ok: true });

    const tampered = structuredClone(GOLDEN_SNAPSHOT_V1) as typeof GOLDEN_SNAPSHOT_V1;
    tampered.proseDocuments[0] = {
      ...tampered.proseDocuments[0],
      state: new Uint8Array([9]),
    } as (typeof tampered.proseDocuments)[number];
    await expect(decodeSnapshotPackageV1(encodeSnapshotPackageV1(tampered))).resolves.toMatchObject({
      ok: false,
      reason: 'integrity-mismatch',
      path: '/proseDocuments/0/stateSha256',
    });

    expect(() =>
      encodeSnapshotPackageV1({
        ...GOLDEN_SNAPSHOT_V1,
        frontier: [{ ...GOLDEN_SNAPSHOT_V1.frontier[0]!, segmentHeadHash: null }],
      }),
    ).toThrow(/segmentHeadHash/u);
  });

  it('keeps commit visibility separate from the snapshot body', async () => {
    const snapshotHash = await sha256Bytes(encodeSnapshotPackageV1(GOLDEN_SNAPSHOT_V1));
    const marker = { ...GOLDEN_SNAPSHOT_COMMIT_V1, packageSha256: snapshotHash };
    expect(decodeSnapshotCommitMarkerV1(encodeSnapshotCommitMarkerV1(marker))).toMatchObject({
      ok: true,
      value: marker,
    });
  });
});

describe('opaque provider object boundaries', () => {
  it('keeps provider/object constants and runtime unions in lockstep', () => {
    expect(PROVIDER_KINDS.every((kind) => Value.Check(PROVIDER_KIND_SCHEMA, kind))).toBe(true);
    expect(SYNC_OBJECT_KINDS.every((kind) => Value.Check(SYNC_OBJECT_KIND_SCHEMA, kind))).toBe(true);
    expect(Value.Check(PROVIDER_KIND_SCHEMA, 'per-sync-generation-custom')).toBe(false);
  });

  it('does not allow renderer absolute paths as LocalObjectRef values', () => {
    expect(Value.Check(LOCAL_OBJECT_REF_SCHEMA, 'syncobj:object-0001')).toBe(true);
    expect(Value.Check(LOCAL_OBJECT_REF_SCHEMA, '/tmp/generation/object')).toBe(false);
    expect(createLocalObjectRef('syncobj:object-0001')).toBe('syncobj:object-0001');
    expect(() => createLocalObjectRef('file:///tmp/object')).toThrow(/LocalObjectRef/u);
  });

  it('keeps provider authority out of individual bindings', () => {
    expect(
      Value.Check(PROVIDER_BINDING_SCHEMA, {
        bindingId: 'binding-a',
        syncGenerationId: 'sync-generation-a',
        accountRef: 'account-a',
        secretRef: 'secret-a',
        authorityGeneration: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(PROVIDER_BINDING_SCHEMA, {
        bindingId: 'binding-a',
        providerKind: 'google-drive',
        syncGenerationId: 'sync-generation-a',
        accountRef: 'account-a',
        secretRef: 'secret-a',
        authorityGeneration: 1,
      }),
    ).toBe(false);
  });

});

describe('cross-runtime protocol v1 golden fixtures', () => {
  it('keeps every core envelope byte-for-byte stable', async () => {
    const encoded = new Map<string, Uint8Array>([
      ['change-set-v1', encodeSyncChangeSetV1(GOLDEN_CHANGESET_V1)],
      ['segment-v1', encodeSegmentV1(GOLDEN_SEGMENT_V1)],
      ['snapshot-v1', encodeSnapshotPackageV1(GOLDEN_SNAPSHOT_V1)],
      ['snapshot-commit-v1', encodeSnapshotCommitMarkerV1(GOLDEN_SNAPSHOT_COMMIT_V1)],
    ]);

    expect(goldenFixtures).toMatchObject({
      fixtureVersion: 1,
      encoding: 'rfc8949-deterministic-cbor',
      compression: 'none',
      hash: 'sha256',
    });
    expect(goldenFixtures.fixtures.map((fixture) => fixture.name)).toEqual([...encoded.keys()]);

    for (const fixture of goldenFixtures.fixtures) {
      const bytes = encoded.get(fixture.name);
      expect(bytes, fixture.name).toBeDefined();
      expect(bytesToHex(bytes!), fixture.name).toBe(fixture.cborHex);
      await expect(sha256Bytes(bytes!), fixture.name).resolves.toBe(fixture.sha256);
      expect(decodeCanonicalCbor(hexToBytes(fixture.cborHex)), fixture.name).toMatchObject({
        ok: true,
        value: { protocol: fixture.protocol },
      });
    }
  });
});
