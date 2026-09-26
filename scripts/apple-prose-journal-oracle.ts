import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as Y from 'yjs';

import { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendYjsUpdateMutation } from '../src/renderer/sync/journal/yjs-update';
import {
  compareSyncTotalOrder,
  decodeSyncChangeSetV1,
  encodeSyncChangeSetV1,
  nextLocalHlc,
  sha256Bytes,
  type Hlc,
  type SyncChangeSetV1,
  type SyncTotalOrderV1,
} from '../src/renderer/sync/protocol';

/** Wire differential only: the production builder and codec are the oracle.
 * This does not substitute for authored SQLite transactions or process recovery.
 * Run with pnpm exec tsx --conditions=import scripts/apple-prose-journal-oracle.ts.
 */
interface WireInput {
  projectId: string;
  projectSyncId: string;
  syncGenerationId: string;
  writerId: string;
  writerEpoch: string;
  deviceSeq: number;
  hlc: Hlc;
  docId: string;
  incarnation: number;
  update: number[];
}

function byteArray(value: unknown, label: string): Uint8Array {
  assert(Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    `${label} must be an array of bytes`);
  return new Uint8Array(value);
}

async function expected(input: WireInput) {
  const builder = new SyncChangeBuilder();
  appendYjsUpdateMutation(builder, input.docId, byteArray(input.update, 'update'));
  // The database resolves lifecycle ownership before finalization. Supply its
  // result explicitly here to isolate wire encoding from persistence behavior.
  await builder.normalizeTargetIncarnations(() => [input.incarnation]);
  const finalized = await builder.finalize();
  const changeSet: SyncChangeSetV1 = {
    protocol: 'drifting.sync.changeset', protocolVersion: 1, payloadVersion: 1,
    projectId: input.projectId, projectSyncId: input.projectSyncId,
    syncGenerationId: input.syncGenerationId,
    changeSetId: `${input.writerId}:${input.writerEpoch}:${input.deviceSeq}`,
    writerId: input.writerId, writerEpoch: input.writerEpoch,
    deviceSeq: input.deviceSeq, hlc: input.hlc,
    mutations: finalized.mutations.map(({ mutation }) => ({ ...mutation })),
  };
  const encodedBytes = encodeSyncChangeSetV1(changeSet);
  const decoded = await decodeSyncChangeSetV1(encodedBytes);
  assert(decoded.ok, 'Production encoder output failed the production decoder');
  assert.deepEqual(decoded.value, changeSet);
  return {
    payloadCbor: Array.from(finalized.mutations[0].payloadCbor),
    payloadSha256: finalized.mutations[0].mutation.payloadSha256,
    encodedBytes: Array.from(encodedBytes),
    encodedSha256: await sha256Bytes(encodedBytes),
    changeSet: JSON.parse(JSON.stringify(changeSet, (_key, value: unknown) =>
      value instanceof Uint8Array ? Array.from(value) : value)) as unknown,
  };
}

function updateWithText(text: string): Uint8Array {
  const document = new Y.Doc();
  document.clientID = 420;
  document.getText('body').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(document);
  document.destroy();
  return bytes;
}

function updateWithLength(length: number): Uint8Array {
  for (let count = 1; count <= length; count += 1) {
    const bytes = updateWithText('x'.repeat(count));
    if (bytes.length === length) return bytes;
  }
  throw new Error(`Cannot construct a valid Yjs update of length ${length}`);
}

function inputFor(update: Uint8Array, overrides: Partial<WireInput> = {}): WireInput {
  return {
    projectId: 'synthetic-native-project', projectSyncId: 'synthetic-native-project-sync',
    syncGenerationId: 'synthetic-native-generation', writerId: 'synthetic-writer', writerEpoch: 'synthetic-epoch',
    deviceSeq: 1, hlc: { wallMs: 1_790_291_200_000, counter: 0 },
    docId: 'node-content:合成节点', incarnation: 0, update: Array.from(update), ...overrides,
  };
}

async function fixture() {
  const inputs: Array<{ name: string; input: WireInput }> = [
    { name: 'synthetic-unicode', input: inputFor(updateWithText('灯塔👩🏽‍🚀e\u{301}𠮷')) },
    { name: 'valid-empty-update', input: inputFor(new Uint8Array([0, 0]), { deviceSeq: 2 }) },
    ...[23, 24, 255, 256].map((length) => ({
      name: `update-byte-length-${length}`,
      input: inputFor(updateWithLength(length), { deviceSeq: length, incarnation: length,
        hlc: { wallMs: 1_790_291_200_000, counter: length } }),
    })),
    { name: 'maximum-safe-integers', input: inputFor(updateWithText('界限'), {
      deviceSeq: Number.MAX_SAFE_INTEGER, incarnation: Number.MAX_SAFE_INTEGER,
      hlc: { wallMs: Number.MAX_SAFE_INTEGER, counter: Number.MAX_SAFE_INTEGER },
    }) },
  ];
  const hlcInputs = [
    { name: 'wall-advances', previous: { wallMs: 23, counter: 255 }, nowMs: 24 },
    { name: 'same-wall', previous: { wallMs: 24, counter: 23 }, nowMs: 24 },
    { name: 'wall-moves-backward', previous: { wallMs: 256, counter: 255 }, nowMs: 23 },
    { name: 'last-safe-counter', previous: { wallMs: Number.MAX_SAFE_INTEGER, counter: Number.MAX_SAFE_INTEGER - 1 }, nowMs: 0 },
  ];
  const orderInputs: Array<{ name: string; value: SyncTotalOrderV1 }> = [
    { name: 'base', value: { hlc: { wallMs: 24, counter: 0 }, writerId: 'writer-A', writerEpoch: 'epoch-A', deviceSeq: 1, mutationIndex: 0 } },
    { name: 'lower-wall', value: { hlc: { wallMs: 23, counter: 255 }, writerId: 'writer-z', writerEpoch: 'epoch-z', deviceSeq: 256, mutationIndex: 24 } },
    { name: 'higher-counter', value: { hlc: { wallMs: 24, counter: 1 }, writerId: 'writer-0', writerEpoch: 'epoch-0', deviceSeq: 1, mutationIndex: 0 } },
    { name: 'lower-writer', value: { hlc: { wallMs: 24, counter: 0 }, writerId: 'writer-0', writerEpoch: 'epoch-A', deviceSeq: 1, mutationIndex: 0 } },
    { name: 'higher-epoch', value: { hlc: { wallMs: 24, counter: 0 }, writerId: 'writer-A', writerEpoch: 'epoch-a', deviceSeq: 1, mutationIndex: 0 } },
    { name: 'higher-sequence', value: { hlc: { wallMs: 24, counter: 0 }, writerId: 'writer-A', writerEpoch: 'epoch-A', deviceSeq: 24, mutationIndex: 0 } },
    { name: 'higher-mutation-index', value: { hlc: { wallMs: 24, counter: 0 }, writerId: 'writer-A', writerEpoch: 'epoch-A', deviceSeq: 1, mutationIndex: 1 } },
  ];
  const overflow = { previous: { wallMs: 24, counter: Number.MAX_SAFE_INTEGER }, nowMs: 23 };
  assert.throws(() => nextLocalHlc(overflow.previous, overflow.nowMs), RangeError);
  const sourceFiles = ['scripts/apple-prose-journal-oracle.ts', 'package.json', 'pnpm-lock.yaml',
    'src/renderer/sqlite-repo/yjs-repo.ts', 'src/renderer/lib/yjs-doc-id.ts'];
  for (const directory of ['src/renderer/sync/journal', 'src/renderer/sync/protocol']) {
    for (const entry of await readdir(directory)) {
      if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) sourceFiles.push(`${directory}/${entry}`);
    }
  }
  sourceFiles.sort();
  const sourceFingerprint = createHash('sha256').update(JSON.stringify(await Promise.all(sourceFiles.map(async (file) => ({
    path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
  }))))).digest('hex');
  return {
    schemaVersion: 1,
    kind: 'apple_native_prose_journal_wire_oracle',
    provenance: 'synthetic-only; generated by production TypeScript builder, RFC 8949 codec, hash, HLC and total-order functions',
    sourceFingerprint,
    sourceFiles,
    cases: await Promise.all(inputs.map(async (entry) => ({ ...entry, expected: await expected(entry.input) }))),
    hlc: hlcInputs.map((entry) => ({ ...entry, expected: nextLocalHlc(entry.previous, entry.nowMs) })),
    rejectedHlc: [{ name: 'counter-overflow', ...overflow, errorName: 'RangeError' }],
    order: { inputs: orderInputs, expected: [...orderInputs].sort((left, right) => compareSyncTotalOrder(left.value, right.value)).map(({ name }) => name) },
  };
}

// Optional Rust output verification uses the same cases input but keeps the
// candidate wire fields at the top level: { cases: [{ name, input, encodedBytes,
// payloadCbor?, payloadSha256?, encodedSha256? }] }. No database is modified.
interface Candidate {
  name: string;
  input: WireInput;
  encodedBytes: number[];
  payloadCbor?: number[];
  payloadSha256?: string;
  encodedSha256?: string;
}

async function main() {
  const args = process.argv.slice(2);
  for (const arg of args) assert(arg === '--check' || /^(?:--output=|--check=|--verify=).+/u.test(arg), `Unknown argument: ${arg}`);
  const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const check = args.includes('--check') || Boolean(option('check'));
  const verify = option('verify');
  if (verify) {
    assert(!check && !option('output'), '--verify cannot be combined with --check or --output');
    const candidates = JSON.parse(await readFile(verify, 'utf8')) as { cases: Candidate[] };
    assert(Array.isArray(candidates.cases) && candidates.cases.length > 0, 'No Rust candidate wire cases');
    for (const candidate of candidates.cases) {
      const bytes = byteArray(candidate.encodedBytes, 'encodedBytes');
      const decoded = await decodeSyncChangeSetV1(bytes);
      assert(decoded.ok, `${candidate.name}: production decoder rejected candidate`);
      const oracle = await expected(candidate.input);
      assert.deepEqual(candidate.encodedBytes, oracle.encodedBytes, `${candidate.name}: changeset wire mismatch`);
      for (const field of ['payloadCbor', 'payloadSha256', 'encodedSha256'] as const) {
        if (candidate[field] !== undefined) assert.deepEqual(candidate[field], oracle[field], `${candidate.name}: ${field} mismatch`);
      }
    }
    console.log(JSON.stringify({ status: 'passed', verified: candidates.cases.map(({ name }) => name) }));
    return;
  }
  const output = option('check') ?? option('output') ?? 'docs/apple-native/fixtures/prose-journal-v1.json';
  const generated = await fixture();
  if (check) {
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), generated, 'Prose journal oracle fixture is stale');
  } else {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(generated, null, 2)}\n`);
  }
  console.log(JSON.stringify({ status: 'passed', mode: check ? 'check' : 'generate', output, cases: generated.cases.length }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
