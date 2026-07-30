/**
 * Provider-neutral, persistence-neutral Yjs prose command preparation.
 *
 * The command is deliberately planned against an isolated Y.Doc. It never
 * mutates the live editor document, a closed document snapshot, or a seed
 * document while the model turn is still fallible. The caller can therefore:
 *
 *   1. prepare + journal the deterministic forward/inverse updates;
 *   2. durably enter the write;
 *   3. apply the forward update with the exported CAS guard;
 *   4. persist the projection/outbox and finally publish the tool result.
 *
 * `contentJson` appears only in `projection`: it is a materialized cache for
 * existing readers. A Y.Doc/state update is always the input and source of
 * truth.
 */
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

const DEFAULT_FRAGMENT = 'default';
const COMMAND_ORIGIN = 'agent-runtime:yjs-prose-command';
const APPLY_FORWARD_ORIGIN = 'agent-runtime:yjs-prose-forward';
const APPLY_INVERSE_ORIGIN = 'agent-runtime:yjs-prose-inverse';

export type YjsProseSourceKind = 'live' | 'closed' | 'seed';

export type YjsJsonValue =
  | null
  | boolean
  | number
  | string
  | YjsJsonValue[]
  | { [key: string]: YjsJsonValue };

export interface YjsProseTextNode {
  kind: 'text';
  text: string;
  /**
   * Y.XmlText formatting attributes. TipTap/y-prosemirror stores marks here:
   * `{ bold: {} }`, `{ link: { href: ... } }`,
   * `{ entityLink: { targetKind, targetId, targetBlockId } }`, etc.
   */
  marks?: Readonly<Record<string, YjsJsonValue>>;
}

export interface YjsProseElementNode {
  kind: 'element';
  type: string;
  attrs?: Readonly<Record<string, YjsJsonValue>>;
  content?: readonly YjsProseNode[];
}

export type YjsProseNode = YjsProseTextNode | YjsProseElementNode;

/**
 * A schema-typed top-level prose block. `type` is the Y.XmlElement node name
 * (`paragraph`, `heading`, `blockquote`, …); attrs, nested inline nodes, marks,
 * and inline entity-link attributes are retained without a schema round trip.
 */
export interface YjsProseBlock {
  id: string;
  type: string;
  attrs?: Readonly<Record<string, YjsJsonValue>>;
  content?: readonly YjsProseNode[];
}

export type YjsProseOperation =
  | {
      kind: 'insert';
      afterBlockId: string | null;
      blocks: readonly YjsProseBlock[];
    }
  | {
      kind: 'edit';
      blockId: string;
      block: YjsProseBlock;
    }
  | {
      /**
       * Atomically edit non-contiguous blocks without recreating the untouched
       * blocks between them. This is the command primitive behind the
       * provider-facing `edit_blocks` tool.
       */
      kind: 'edit_many';
      edits: readonly {
        blockId: string;
        block: YjsProseBlock;
      }[];
    }
  | {
      kind: 'remove';
      blockIds: readonly string[];
    }
  | {
      kind: 'replace';
      fromBlockId: string;
      toBlockId: string;
      blocks: readonly YjsProseBlock[];
    }
  | {
      kind: 'append';
      blocks: readonly YjsProseBlock[];
    };

export type YjsProseCommandSource =
  | {
      kind: 'live';
      doc: Y.Doc;
      /**
       * Monotonic durable per-doc revision. Integration contract:
       *
       * - flush `YjsDocumentSession.flushPendingWrites()` first;
       * - read the revision together with the Yjs state;
       * - compare-and-increment it in the same SQLite transaction that appends
       *   the prepared forward update.
       *
       * `YjsRepository.maxUpdateId()` alone is NOT a safe implementation:
       * compaction can prune every covered update row and make it fall back to
       * zero. The repository adapter must expose a counter/snapshot coverage
       * watermark that survives compaction.
       */
      revision: number;
    }
  | {
      kind: 'closed' | 'seed';
      /** Full canonical Yjs state, never a contentJson fallback. */
      stateUpdate: Uint8Array;
      /**
       * Same durable per-doc revision as the live path. A seed may use zero
       * only after an atomic repository read proved that neither a snapshot nor
       * updates exist for the docId.
       */
      revision: number;
    };

export interface YjsProseBaseExpectation {
  revision: number;
  stateVector: Uint8Array;
}

export interface PrepareYjsProseCommandInput {
  commandId: string;
  source: YjsProseCommandSource;
  expectedBase: YjsProseBaseExpectation;
  operation: YjsProseOperation;
}

export interface YjsProseDurableWatermark {
  commandId: string;
  sourceKind: YjsProseSourceKind;
  baseRevision: number;
  baseStateVector: Uint8Array;
  forwardStateVector: Uint8Array;
  inverseStateVector: Uint8Array;
  baseStateHash: string;
  forwardStateHash: string;
  restoredStateHash: string;
  forwardUpdateHash: string;
  inverseUpdateHash: string;
}

export interface YjsProseProjectionPayload {
  fragment: typeof DEFAULT_FRAGMENT;
  /** Existing materialized cache payload; never the command input/truth. */
  contentJson: string;
  document: unknown;
  blocks: readonly YjsProseBlock[];
  allBlockIds: readonly string[];
  affectedBlockIds: readonly string[];
  stateHash: string;
  stateVector: Uint8Array;
}

export interface PreparedYjsProseCommand {
  commandId: string;
  operation: YjsProseOperation;
  forwardUpdate: Uint8Array;
  inverseUpdate: Uint8Array;
  affectedBlockIds: readonly string[];
  projection: YjsProseProjectionPayload;
  durableWatermark: YjsProseDurableWatermark;
}

export interface PortablePreparedYjsProseCommand {
  format: 'drifting.yjs-prose-command';
  schemaVersion: 1;
  commandId: string;
  operation: YjsProseOperation;
  forwardUpdateBase64: string;
  inverseUpdateBase64: string;
  affectedBlockIds: readonly string[];
  projection: {
    fragment: typeof DEFAULT_FRAGMENT;
    contentJson: string;
    document: YjsJsonValue;
    blocks: readonly YjsProseBlock[];
    allBlockIds: readonly string[];
    affectedBlockIds: readonly string[];
    stateHash: string;
    stateVectorBase64: string;
  };
  durableWatermark: {
    commandId: string;
    sourceKind: YjsProseSourceKind;
    baseRevision: number;
    baseStateVectorBase64: string;
    forwardStateVectorBase64: string;
    inverseStateVectorBase64: string;
    baseStateHash: string;
    forwardStateHash: string;
    restoredStateHash: string;
    forwardUpdateHash: string;
    inverseUpdateHash: string;
  };
}

export type YjsProseUpdateDirection = 'forward' | 'inverse';

export class YjsProseCommandError extends Error {
  constructor(
    readonly code:
      | 'INVALID_COMMAND'
      | 'INVALID_PROSE'
      | 'STALE_REVISION'
      | 'STALE_STATE_VECTOR'
      | 'STALE_STATE_HASH'
      | 'INVERSE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'YjsProseCommandError';
  }
}

function invalidCommand(message: string): never {
  throw new YjsProseCommandError('INVALID_COMMAND', message);
}

function invalidProse(message: string): never {
  throw new YjsProseCommandError('INVALID_PROSE', message);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Small deterministic codec for durable JSON. It intentionally avoids
 * `btoa`/`atob` (not uniformly available in Node tests/older WKWebViews) and
 * Node's `Buffer` (not available in Tauri mobile webviews).
 */
function bytesToBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    encoded += BASE64_ALPHABET[(value >>> 18) & 0x3f];
    encoded += BASE64_ALPHABET[(value >>> 12) & 0x3f];
    encoded += hasSecond ? BASE64_ALPHABET[(value >>> 6) & 0x3f] : '=';
    encoded += hasThird ? BASE64_ALPHABET[value & 0x3f] : '=';
  }
  return encoded;
}

function base64ToBytes(value: unknown, path: string): Uint8Array {
  if (typeof value !== 'string') invalidCommand(`${path} must be a base64 string.`);
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalidCommand(`${path} is not canonical base64.`);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index]);
    const second = BASE64_ALPHABET.indexOf(value[index + 1]);
    const third = value[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 2]);
    const fourth = value[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 3]);
    const chunk = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < output.length) output[outputIndex++] = (chunk >>> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (chunk >>> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = chunk & 0xff;
  }
  if (bytesToBase64(output) !== value) invalidCommand(`${path} is not canonical base64.`);
  return output;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function canonicalJsonValue(value: unknown, path: string): YjsJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidCommand(`${path} must not contain a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalJsonValue(source[key], `${path}.${key}`)]),
    );
  }
  return invalidCommand(`${path} contains unsupported ${typeof value}.`);
}

function canonicalRecord(
  value: Readonly<Record<string, YjsJsonValue>> | undefined,
  path: string,
): Record<string, YjsJsonValue> {
  if (!value) return {};
  return canonicalJsonValue(value, path) as Record<string, YjsJsonValue>;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value, 'value'));
}

function assertNonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string') invalidCommand(`${path} must be a string.`);
  const normalized = value.trim();
  if (!normalized) invalidCommand(`${path} must be non-empty.`);
  return normalized;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidCommand(`${path} must be a non-empty string.`);
  }
  return value;
}

function normalizeNode(node: YjsProseNode, path: string): YjsProseNode {
  if (node.kind === 'text') {
    if (typeof node.text !== 'string' || node.text.length === 0) {
      invalidCommand(`${path}.text must be a non-empty string.`);
    }
    const marks = canonicalRecord(node.marks, `${path}.marks`);
    return {
      kind: 'text',
      text: node.text,
      ...(Object.keys(marks).length > 0 ? { marks } : {}),
    };
  }
  if (node.kind !== 'element') invalidCommand(`${path}.kind is unsupported.`);
  const attrs = canonicalRecord(node.attrs, `${path}.attrs`);
  return {
    kind: 'element',
    type: assertNonEmpty(node.type, `${path}.type`),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(node.content
      ? { content: node.content.map((child, index) => normalizeNode(child, `${path}.content[${index}]`)) }
      : {}),
  };
}

function normalizeBlock(block: YjsProseBlock, path: string): YjsProseBlock {
  const id = assertNonEmpty(block.id, `${path}.id`);
  const attrs = canonicalRecord(block.attrs, `${path}.attrs`);
  if ('id' in attrs) invalidCommand(`${path}.attrs.id is reserved; use ${path}.id.`);
  return {
    id,
    type: assertNonEmpty(block.type, `${path}.type`),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(block.content
      ? { content: block.content.map((node, index) => normalizeNode(node, `${path}.content[${index}]`)) }
      : {}),
  };
}

function normalizeBlocks(
  blocks: readonly YjsProseBlock[],
  path: string,
  allowEmpty = false,
): YjsProseBlock[] {
  if (!allowEmpty && blocks.length === 0) {
    invalidCommand(`${path} must contain at least one block.`);
  }
  const normalized = blocks.map((block, index) => normalizeBlock(block, `${path}[${index}]`));
  const ids = new Set<string>();
  for (const block of normalized) {
    if (ids.has(block.id)) invalidCommand(`${path} contains duplicate block id "${block.id}".`);
    ids.add(block.id);
  }
  return normalized;
}

function normalizeOperation(operation: YjsProseOperation): YjsProseOperation {
  switch (operation.kind) {
    case 'insert':
      return {
        kind: 'insert',
        afterBlockId:
          operation.afterBlockId === null
            ? null
            : assertNonEmpty(operation.afterBlockId, 'operation.afterBlockId'),
        blocks: normalizeBlocks(operation.blocks, 'operation.blocks'),
      };
    case 'edit': {
      const blockId = assertNonEmpty(operation.blockId, 'operation.blockId');
      const block = normalizeBlock(operation.block, 'operation.block');
      if (block.id !== blockId) {
        invalidCommand('operation.block.id must equal operation.blockId for a stable edit.');
      }
      return { kind: 'edit', blockId, block };
    }
    case 'edit_many': {
      if (operation.edits.length === 0) {
        invalidCommand('operation.edits must contain at least one edit.');
      }
      const edits = operation.edits.map((edit, index) => {
        const blockId = assertNonEmpty(
          edit.blockId,
          `operation.edits[${index}].blockId`,
        );
        const block = normalizeBlock(
          edit.block,
          `operation.edits[${index}].block`,
        );
        if (block.id !== blockId) {
          invalidCommand(
            `operation.edits[${index}].block.id must equal its blockId.`,
          );
        }
        return { blockId, block };
      });
      if (new Set(edits.map((edit) => edit.blockId)).size !== edits.length) {
        invalidCommand('operation.edits must not target a block twice.');
      }
      return { kind: 'edit_many', edits };
    }
    case 'remove': {
      if (operation.blockIds.length === 0) {
        invalidCommand('operation.blockIds must contain at least one block id.');
      }
      const blockIds = operation.blockIds.map((id, index) =>
        assertNonEmpty(id, `operation.blockIds[${index}]`),
      );
      if (new Set(blockIds).size !== blockIds.length) {
        invalidCommand('operation.blockIds must not contain duplicates.');
      }
      return { kind: 'remove', blockIds };
    }
    case 'replace':
      return {
        kind: 'replace',
        fromBlockId: assertNonEmpty(operation.fromBlockId, 'operation.fromBlockId'),
        toBlockId: assertNonEmpty(operation.toBlockId, 'operation.toBlockId'),
        blocks: normalizeBlocks(operation.blocks, 'operation.blocks', true),
      };
    case 'append':
      return {
        kind: 'append',
        blocks: normalizeBlocks(operation.blocks, 'operation.blocks'),
      };
  }
}

function snapshotText(text: Y.XmlText): YjsProseTextNode[] {
  const result: YjsProseTextNode[] = [];
  for (const [index, delta] of text.toDelta().entries()) {
    if (typeof delta.insert !== 'string') {
      invalidProse(`Unsupported embedded Y.XmlText value at delta ${index}.`);
    }
    if (delta.insert.length === 0) continue;
    const marks = canonicalRecord(
      delta.attributes as Record<string, YjsJsonValue> | undefined,
      `text.delta[${index}].attributes`,
    );
    result.push({
      kind: 'text',
      text: delta.insert,
      ...(Object.keys(marks).length > 0 ? { marks } : {}),
    });
  }
  return result;
}

function snapshotElement(element: Y.XmlElement): YjsProseElementNode {
  const attrs = canonicalRecord(
    element.getAttributes() as Record<string, YjsJsonValue>,
    `${element.nodeName}.attrs`,
  );
  const content: YjsProseNode[] = [];
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) content.push(...snapshotText(child));
    else if (child instanceof Y.XmlElement) content.push(snapshotElement(child));
    else invalidProse(`Unsupported ${child.constructor.name} inside ${element.nodeName}.`);
  }
  return {
    kind: 'element',
    type: element.nodeName,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}

/**
 * Schema-visible canonical block snapshot. This is also the state-hash input:
 * CRDT clocks/tombstones are monotonic and cannot be rewound, while the prose
 * value (block types, ids, attrs, nested nodes and marks) can be restored
 * exactly by a compensating update.
 */
export function snapshotYjsProseBlocks(doc: Y.Doc): YjsProseBlock[] {
  const result: YjsProseBlock[] = [];
  const seen = new Set<string>();
  for (const [index, child] of doc.getXmlFragment(DEFAULT_FRAGMENT).toArray().entries()) {
    if (!(child instanceof Y.XmlElement)) {
      invalidProse(`Top-level prose child ${index} is not a Y.XmlElement.`);
    }
    const element = snapshotElement(child);
    const idValue = element.attrs?.id;
    if (typeof idValue !== 'string' || idValue.trim().length === 0) {
      invalidProse(`Top-level prose block ${index} has no stable string id.`);
    }
    if (seen.has(idValue)) invalidProse(`Duplicate top-level prose block id "${idValue}".`);
    seen.add(idValue);
    const attrs = { ...(element.attrs ?? {}) };
    delete attrs.id;
    result.push({
      id: idValue,
      type: element.type,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(element.content ? { content: element.content } : {}),
    });
  }
  return result;
}

export async function hashYjsProseState(doc: Y.Doc): Promise<string> {
  return sha256Text(canonicalStringify(snapshotYjsProseBlocks(doc)));
}

function createText(node: YjsProseTextNode): Y.XmlText {
  const text = new Y.XmlText();
  text.insert(0, node.text, canonicalRecord(node.marks, 'node.marks'));
  return text;
}

function createElement(node: YjsProseElementNode): Y.XmlElement {
  const element = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(canonicalRecord(node.attrs, 'node.attrs'))) {
    // Yjs' declaration narrows XML attrs to string even though
    // y-prosemirror intentionally stores JSON scalar/object attrs (for
    // example heading level is a number and entityLink is an object).
    element.setAttribute(key, value as string);
  }
  const children = (node.content ?? []).map((child) =>
    child.kind === 'text' ? createText(child) : createElement(child),
  );
  if (children.length > 0) element.insert(0, children);
  return element;
}

function createBlock(block: YjsProseBlock): Y.XmlElement {
  const element = new Y.XmlElement(block.type);
  const attrs: Record<string, YjsJsonValue> = {
    ...canonicalRecord(block.attrs, 'block.attrs'),
    id: block.id,
  };
  for (const key of Object.keys(attrs).sort()) {
    element.setAttribute(key, attrs[key] as string);
  }
  const children = (block.content ?? []).map((node) =>
    node.kind === 'text' ? createText(node) : createElement(node),
  );
  if (children.length > 0) element.insert(0, children);
  return element;
}

/** Test/fixture helper that still builds the same Yjs-native representation. */
export function replaceYjsProseBlocks(doc: Y.Doc, blocks: readonly YjsProseBlock[]): void {
  const normalized = blocks.map((block, index) => normalizeBlock(block, `blocks[${index}]`));
  if (new Set(normalized.map((block) => block.id)).size !== normalized.length) {
    invalidCommand('blocks contain duplicate top-level ids.');
  }
  const fragment = doc.getXmlFragment(DEFAULT_FRAGMENT);
  doc.transact(() => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    if (normalized.length > 0) fragment.insert(0, normalized.map(createBlock));
  }, 'agent-runtime:yjs-prose-fixture');
}

/**
 * Convert a never-opened node_content projection into a full Yjs seed.
 *
 * This deliberately uses the same minimal TipTap schema as
 * `useEntityYjsDoc`. Missing/duplicate top-level ids are deterministically
 * materialized before conversion so an Agent retry prepares the same command
 * instead of inventing fresh UUIDs. Once the first command commits, this seed
 * is persisted as canonical Yjs state and contentJson returns to being only a
 * projection.
 */
export async function createYjsProseSeedState(
  contentJson: string,
): Promise<Uint8Array> {
  let document: Record<string, unknown>;
  const source = contentJson.trim();
  if (!source || source === '{}') {
    document = { type: 'doc', content: [] };
  } else {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return invalidProse('Seed contentJson must contain a ProseMirror document.');
      }
      document = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof YjsProseCommandError) throw error;
      return invalidProse('Seed contentJson is not valid JSON.');
    }
  }
  if (document.type !== 'doc') {
    return invalidProse('Seed contentJson must have type "doc".');
  }
  const rawContent = document.content;
  if (rawContent !== undefined && !Array.isArray(rawContent)) {
    return invalidProse('Seed contentJson.content must be an array.');
  }
  const content = (rawContent ?? []) as unknown[];
  const seen = new Set<string>();
  const normalizedContent: Record<string, unknown>[] = [];
  for (const [index, rawNode] of content.entries()) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      return invalidProse(`Seed top-level block ${index} must be an object.`);
    }
    const node = structuredClone(rawNode) as Record<string, unknown>;
    const attrs =
      node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs)
        ? { ...(node.attrs as Record<string, unknown>) }
        : {};
    const candidate =
      typeof attrs.id === 'string' && attrs.id.trim() ? attrs.id.trim() : null;
    const id =
      candidate && !seen.has(candidate)
        ? candidate
        : await deterministicSeedBlockId(index, node);
    attrs.id = id;
    seen.add(id);
    node.attrs = attrs;
    normalizedContent.push(node);
  }
  document = { ...document, content: normalizedContent };

  try {
    const [
      { getSchema },
      { prosemirrorJSONToYDoc },
      StarterKit,
      Underline,
      Link,
      TextAlign,
      { BlockId },
      { EntityLink },
    ] = await Promise.all([
      import('@tiptap/core'),
      import('y-prosemirror'),
      import('@tiptap/starter-kit').then((module) => module.default),
      import('@tiptap/extension-underline').then((module) => module.default),
      import('@tiptap/extension-link').then((module) => module.default),
      import('@tiptap/extension-text-align').then((module) => module.default),
      import('../../extensions/block-id'),
      import('../../extensions/entity-link'),
    ]);
    const schema = getSchema([
      StarterKit.configure({ underline: false, link: false }),
      Underline,
      Link,
      TextAlign,
      BlockId,
      EntityLink,
    ] as never);
    const seeded = prosemirrorJSONToYDoc(schema, document, DEFAULT_FRAGMENT);
    try {
      // Fail closed now if this projection cannot satisfy the runtime's
      // stable top-level block contract (rather than after mutation journal).
      const blocks = snapshotYjsProseBlocks(seeded);
      const stable = new Y.Doc({ gc: false });
      const clientDigest = (
        await sha256Text(
          canonicalStringify({
            namespace: 'drifting.yjs-prose-seed-client',
            document,
          }),
        )
      ).slice('sha256:'.length);
      stable.clientID = Number.parseInt(clientDigest.slice(0, 8), 16) || 1;
      try {
        replaceYjsProseBlocks(stable, blocks);
        return Y.encodeStateAsUpdate(stable);
      } finally {
        stable.destroy();
      }
    } finally {
      seeded.destroy();
    }
  } catch (error) {
    if (error instanceof YjsProseCommandError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return invalidProse(`Seed contentJson could not be decoded: ${detail}`);
  }
}

async function deterministicSeedBlockId(
  index: number,
  node: Record<string, unknown>,
): Promise<string> {
  const digest = (
    await sha256Text(
      canonicalStringify({
        namespace: 'drifting.yjs-prose-seed',
        index,
        node,
      }),
    )
  ).slice('sha256:'.length);
  const bytes = digest.slice(0, 32).split('');
  // RFC 4122 variant plus a name-derived version nibble. The identifier is
  // deterministic, not a claim that SHA-256 is UUIDv5/SHA-1.
  bytes[12] = '5';
  bytes[16] = (Number.parseInt(bytes[16], 16) & 0x3 | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface PreflightPlan {
  operation: YjsProseOperation;
  affectedBlockIds: string[];
  apply: (fragment: Y.XmlFragment) => void;
}

function blockIndex(ids: readonly string[], id: string, path: string): number {
  const index = ids.indexOf(id);
  if (index < 0) invalidCommand(`${path} block "${id}" was not found.`);
  return index;
}

function assertInsertedIdsAvailable(
  currentIds: readonly string[],
  removedIds: ReadonlySet<string>,
  blocks: readonly YjsProseBlock[],
): void {
  const retained = new Set(currentIds.filter((id) => !removedIds.has(id)));
  for (const block of blocks) {
    if (retained.has(block.id)) {
      invalidCommand(`Inserted block id "${block.id}" already exists outside the replaced range.`);
    }
  }
}

function preflightOperation(baseBlocks: readonly YjsProseBlock[], raw: YjsProseOperation): PreflightPlan {
  const operation = normalizeOperation(raw);
  const ids = baseBlocks.map((block) => block.id);

  switch (operation.kind) {
    case 'insert': {
      const at =
        operation.afterBlockId === null
          ? 0
          : blockIndex(ids, operation.afterBlockId, 'afterBlockId') + 1;
      assertInsertedIdsAvailable(ids, new Set(), operation.blocks);
      return {
        operation,
        affectedBlockIds: operation.blocks.map((block) => block.id),
        apply: (fragment) => fragment.insert(at, operation.blocks.map(createBlock)),
      };
    }
    case 'edit': {
      const at = blockIndex(ids, operation.blockId, 'edit');
      return {
        operation,
        affectedBlockIds: [operation.blockId],
        apply: (fragment) => {
          fragment.delete(at, 1);
          fragment.insert(at, [createBlock(operation.block)]);
        },
      };
    }
    case 'edit_many': {
      const planned = operation.edits.map((edit, index) => ({
        at: blockIndex(ids, edit.blockId, `edit_many.edits[${index}]`),
        edit,
      }));
      return {
        operation,
        affectedBlockIds: planned.map(({ edit }) => edit.blockId),
        apply: (fragment) => {
          // Replacing a top-level Y.XmlElement does not shift later indices,
          // but descending order also makes that invariant explicit if Yjs'
          // list integration changes.
          for (const { at, edit } of [...planned].sort(
            (left, right) => right.at - left.at,
          )) {
            fragment.delete(at, 1);
            fragment.insert(at, [createBlock(edit.block)]);
          }
        },
      };
    }
    case 'remove': {
      const indices = operation.blockIds.map((id) => blockIndex(ids, id, 'remove'));
      if (baseBlocks.length - indices.length < 1) {
        invalidCommand('A prose command must leave at least one top-level block.');
      }
      return {
        operation,
        affectedBlockIds: [...operation.blockIds],
        apply: (fragment) => {
          for (const index of [...indices].sort((left, right) => right - left)) {
            fragment.delete(index, 1);
          }
        },
      };
    }
    case 'replace': {
      const from = blockIndex(ids, operation.fromBlockId, 'replace.fromBlockId');
      const to = blockIndex(ids, operation.toBlockId, 'replace.toBlockId');
      if (from > to) invalidCommand('replace.fromBlockId must be at or before replace.toBlockId.');
      const removed = ids.slice(from, to + 1);
      if (baseBlocks.length - removed.length + operation.blocks.length < 1) {
        invalidCommand('A prose command must leave at least one top-level block.');
      }
      assertInsertedIdsAvailable(ids, new Set(removed), operation.blocks);
      return {
        operation,
        affectedBlockIds: [...new Set([...removed, ...operation.blocks.map((block) => block.id)])],
        apply: (fragment) => {
          fragment.delete(from, to - from + 1);
          fragment.insert(from, operation.blocks.map(createBlock));
        },
      };
    }
    case 'append': {
      assertInsertedIdsAvailable(ids, new Set(), operation.blocks);
      return {
        operation,
        affectedBlockIds: operation.blocks.map((block) => block.id),
        apply: (fragment) => fragment.insert(fragment.length, operation.blocks.map(createBlock)),
      };
    }
  }
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  const updates: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array) => updates.push(copyBytes(update));
  doc.on('update', onUpdate);
  try {
    mutate();
  } finally {
    doc.off('update', onUpdate);
  }
  if (updates.length === 0) {
    invalidCommand('The prose command produced no Yjs update.');
  }
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

function captureSource(source: YjsProseCommandSource): {
  baseDoc: Y.Doc;
  baseStateUpdate: Uint8Array;
  baseStateVector: Uint8Array;
} {
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
    invalidCommand('source.revision must be a non-negative safe integer.');
  }
  if (source.kind === 'live') {
    // Both calls are synchronous: no editor transaction can interleave between
    // the vector and full-state capture on the renderer thread.
    const baseStateVector = Y.encodeStateVector(source.doc);
    const baseStateUpdate = Y.encodeStateAsUpdate(source.doc);
    const baseDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(baseDoc, baseStateUpdate, 'agent-runtime:yjs-prose-capture');
    return { baseDoc, baseStateUpdate, baseStateVector };
  }
  const baseStateUpdate = copyBytes(source.stateUpdate);
  const baseDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(baseDoc, baseStateUpdate, 'agent-runtime:yjs-prose-capture');
  return {
    baseDoc,
    baseStateUpdate,
    baseStateVector: Y.encodeStateVector(baseDoc),
  };
}

async function deterministicClientId(
  commandId: string,
  operation: YjsProseOperation,
  baseStateHash: string,
  occupied: ReadonlyMap<number, number>,
): Promise<number> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonicalStringify({ commandId, operation, baseStateHash }),
    ) as BufferSource,
  );
  let candidate = new DataView(digest).getUint32(0, false);
  if (candidate === 0) candidate = 1;
  while (occupied.has(candidate)) {
    candidate = candidate === 0xffffffff ? 1 : candidate + 1;
  }
  return candidate;
}

function createDocFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, update, 'agent-runtime:yjs-prose-clone');
  return doc;
}

/**
 * Prepare deterministic forward + exact semantic inverse updates on an
 * isolated working Y.Doc. Stale revision/vector checks happen before the
 * command transaction and before any authoritative input can be mutated.
 */
export async function prepareYjsProseCommand(
  input: PrepareYjsProseCommandInput,
): Promise<PreparedYjsProseCommand> {
  const commandId = assertNonEmpty(input.commandId, 'commandId');
  if (!Number.isSafeInteger(input.expectedBase.revision) || input.expectedBase.revision < 0) {
    invalidCommand('expectedBase.revision must be a non-negative safe integer.');
  }
  if (input.source.revision !== input.expectedBase.revision) {
    throw new YjsProseCommandError(
      'STALE_REVISION',
      `Expected revision ${input.expectedBase.revision}, received ${input.source.revision}.`,
    );
  }

  const { baseDoc, baseStateUpdate, baseStateVector } = captureSource(input.source);
  let working: Y.Doc | null = null;
  let validation: Y.Doc | null = null;
  try {
    if (!bytesEqual(baseStateVector, input.expectedBase.stateVector)) {
      throw new YjsProseCommandError(
        'STALE_STATE_VECTOR',
        'The prose state vector changed before command preparation.',
      );
    }

    const baseBlocks = snapshotYjsProseBlocks(baseDoc);
    const plan = preflightOperation(baseBlocks, input.operation);
    const baseStateHash = await hashYjsProseState(baseDoc);
    const clientId = await deterministicClientId(
      commandId,
      plan.operation,
      baseStateHash,
      Y.decodeStateVector(baseStateVector),
    );

    working = createDocFromUpdate(baseStateUpdate);
    working.clientID = clientId;
    const fragment = working.getXmlFragment(DEFAULT_FRAGMENT);
    const undoManager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([COMMAND_ORIGIN]),
      captureTimeout: 0,
    });

    const forwardUpdate = captureUpdate(working, () => {
      working?.transact(() => plan.apply(fragment), COMMAND_ORIGIN);
    });
    const forwardStateVector = Y.encodeStateVector(working);
    const forwardStateHash = await hashYjsProseState(working);
    const blocks = snapshotYjsProseBlocks(working);
    const document = yDocToProsemirrorJSON(working, DEFAULT_FRAGMENT);
    const contentJson = JSON.stringify(document);

    const inverseUpdate = captureUpdate(working, () => {
      if (!undoManager.undo()) invalidCommand('The prose command could not produce an inverse update.');
    });
    const inverseStateVector = Y.encodeStateVector(working);
    const restoredStateHash = await hashYjsProseState(working);
    undoManager.destroy();

    if (restoredStateHash !== baseStateHash) {
      throw new YjsProseCommandError(
        'INVERSE_MISMATCH',
        'The generated inverse update did not restore the exact prose state.',
      );
    }

    // Prove that the serialized deltas, not just the private working document,
    // independently reproduce the forward state and its inverse.
    validation = createDocFromUpdate(baseStateUpdate);
    Y.applyUpdate(validation, forwardUpdate, APPLY_FORWARD_ORIGIN);
    if ((await hashYjsProseState(validation)) !== forwardStateHash) {
      throw new YjsProseCommandError(
        'INVERSE_MISMATCH',
        'The serialized forward update did not reproduce the planned prose state.',
      );
    }
    Y.applyUpdate(validation, inverseUpdate, APPLY_INVERSE_ORIGIN);
    if ((await hashYjsProseState(validation)) !== baseStateHash) {
      throw new YjsProseCommandError(
        'INVERSE_MISMATCH',
        'The serialized inverse update did not restore the base prose state.',
      );
    }

    const affectedBlockIds = [...plan.affectedBlockIds];
    return {
      commandId,
      operation: plan.operation,
      forwardUpdate: copyBytes(forwardUpdate),
      inverseUpdate: copyBytes(inverseUpdate),
      affectedBlockIds,
      projection: {
        fragment: DEFAULT_FRAGMENT,
        contentJson,
        document,
        blocks,
        allBlockIds: blocks.map((block) => block.id),
        affectedBlockIds,
        stateHash: forwardStateHash,
        stateVector: copyBytes(forwardStateVector),
      },
      durableWatermark: {
        commandId,
        sourceKind: input.source.kind,
        baseRevision: input.source.revision,
        baseStateVector: copyBytes(baseStateVector),
        forwardStateVector: copyBytes(forwardStateVector),
        inverseStateVector: copyBytes(inverseStateVector),
        baseStateHash,
        forwardStateHash,
        restoredStateHash,
        forwardUpdateHash: await sha256Bytes(forwardUpdate),
        inverseUpdateHash: await sha256Bytes(inverseUpdate),
      },
    };
  } finally {
    validation?.destroy();
    working?.destroy();
    baseDoc.destroy();
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidCommand(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalidCommand(`${path} must be an array.`);
  return value;
}

function parseStringArray(value: unknown, path: string): string[] {
  const strings = requireArray(value, path).map((item, index) =>
    assertNonEmpty(item, `${path}[${index}]`),
  );
  if (new Set(strings).size !== strings.length) {
    invalidCommand(`${path} must not contain duplicates.`);
  }
  return strings;
}

function parseAttrs(
  value: unknown,
  path: string,
): Record<string, YjsJsonValue> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, path);
  const attrs = canonicalRecord(
    record as Record<string, YjsJsonValue>,
    path,
  );
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function parsePortableNode(value: unknown, path: string): YjsProseNode {
  const record = requireRecord(value, path);
  if (record.kind === 'text') {
    const text = requireText(record.text, `${path}.text`);
    const marks = parseAttrs(record.marks, `${path}.marks`);
    return { kind: 'text', text, ...(marks ? { marks } : {}) };
  }
  if (record.kind === 'element') {
    const type = assertNonEmpty(record.type, `${path}.type`);
    const attrs = parseAttrs(record.attrs, `${path}.attrs`);
    const content =
      record.content === undefined
        ? undefined
        : requireArray(record.content, `${path}.content`).map((node, index) =>
            parsePortableNode(node, `${path}.content[${index}]`),
          );
    return {
      kind: 'element',
      type,
      ...(attrs ? { attrs } : {}),
      ...(content ? { content } : {}),
    };
  }
  return invalidCommand(`${path}.kind must be "text" or "element".`);
}

function parsePortableBlock(value: unknown, path: string): YjsProseBlock {
  const record = requireRecord(value, path);
  const id = assertNonEmpty(record.id, `${path}.id`);
  const type = assertNonEmpty(record.type, `${path}.type`);
  const attrs = parseAttrs(record.attrs, `${path}.attrs`);
  if (attrs && 'id' in attrs) invalidCommand(`${path}.attrs.id is reserved.`);
  const content =
    record.content === undefined
      ? undefined
      : requireArray(record.content, `${path}.content`).map((node, index) =>
          parsePortableNode(node, `${path}.content[${index}]`),
        );
  return {
    id,
    type,
    ...(attrs ? { attrs } : {}),
    ...(content ? { content } : {}),
  };
}

function parsePortableBlocks(
  value: unknown,
  path: string,
  allowEmpty = false,
): YjsProseBlock[] {
  return normalizeBlocks(
    requireArray(value, path).map((block, index) =>
      parsePortableBlock(block, `${path}[${index}]`),
    ),
    path,
    allowEmpty,
  );
}

function parsePortableOperation(value: unknown): YjsProseOperation {
  const record = requireRecord(value, 'operation');
  switch (record.kind) {
    case 'insert':
      return normalizeOperation({
        kind: 'insert',
        afterBlockId:
          record.afterBlockId === null
            ? null
            : assertNonEmpty(record.afterBlockId, 'operation.afterBlockId'),
        blocks: parsePortableBlocks(record.blocks, 'operation.blocks'),
      });
    case 'edit':
      return normalizeOperation({
        kind: 'edit',
        blockId: assertNonEmpty(record.blockId, 'operation.blockId'),
        block: parsePortableBlock(record.block, 'operation.block'),
      });
    case 'edit_many':
      return normalizeOperation({
        kind: 'edit_many',
        edits: requireArray(record.edits, 'operation.edits').map(
          (value, index) => {
            const edit = requireRecord(
              value,
              `operation.edits[${index}]`,
            );
            return {
              blockId: assertNonEmpty(
                edit.blockId,
                `operation.edits[${index}].blockId`,
              ),
              block: parsePortableBlock(
                edit.block,
                `operation.edits[${index}].block`,
              ),
            };
          },
        ),
      });
    case 'remove':
      return normalizeOperation({
        kind: 'remove',
        blockIds: parseStringArray(record.blockIds, 'operation.blockIds'),
      });
    case 'replace':
      return normalizeOperation({
        kind: 'replace',
        fromBlockId: assertNonEmpty(record.fromBlockId, 'operation.fromBlockId'),
        toBlockId: assertNonEmpty(record.toBlockId, 'operation.toBlockId'),
        blocks: parsePortableBlocks(
          record.blocks,
          'operation.blocks',
          true,
        ),
      });
    case 'append':
      return normalizeOperation({
        kind: 'append',
        blocks: parsePortableBlocks(record.blocks, 'operation.blocks'),
      });
    default:
      return invalidCommand('operation.kind is unsupported.');
  }
}

function parseSafeRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidCommand(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

function parseHash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    invalidCommand(`${path} must be a sha256 hash.`);
  }
  return value;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Convert prepared binary deltas/vectors into a canonical JSON/IPC-safe object.
 * This is the value to pass to `canonicalAgentRuntimeJson` for
 * `write_effect.forwardJson` / `inverseJson`; never pass `Prepared...` itself.
 */
export function toPortablePreparedYjsProseCommand(
  prepared: PreparedYjsProseCommand,
): PortablePreparedYjsProseCommand {
  return {
    format: 'drifting.yjs-prose-command',
    schemaVersion: 1,
    commandId: prepared.commandId,
    operation: prepared.operation,
    forwardUpdateBase64: bytesToBase64(prepared.forwardUpdate),
    inverseUpdateBase64: bytesToBase64(prepared.inverseUpdate),
    affectedBlockIds: [...prepared.affectedBlockIds],
    projection: {
      fragment: DEFAULT_FRAGMENT,
      contentJson: prepared.projection.contentJson,
      document: canonicalJsonValue(
        prepared.projection.document,
        'prepared.projection.document',
      ),
      blocks: prepared.projection.blocks,
      allBlockIds: [...prepared.projection.allBlockIds],
      affectedBlockIds: [...prepared.projection.affectedBlockIds],
      stateHash: prepared.projection.stateHash,
      stateVectorBase64: bytesToBase64(prepared.projection.stateVector),
    },
    durableWatermark: {
      commandId: prepared.durableWatermark.commandId,
      sourceKind: prepared.durableWatermark.sourceKind,
      baseRevision: prepared.durableWatermark.baseRevision,
      baseStateVectorBase64: bytesToBase64(
        prepared.durableWatermark.baseStateVector,
      ),
      forwardStateVectorBase64: bytesToBase64(
        prepared.durableWatermark.forwardStateVector,
      ),
      inverseStateVectorBase64: bytesToBase64(
        prepared.durableWatermark.inverseStateVector,
      ),
      baseStateHash: prepared.durableWatermark.baseStateHash,
      forwardStateHash: prepared.durableWatermark.forwardStateHash,
      restoredStateHash: prepared.durableWatermark.restoredStateHash,
      forwardUpdateHash: prepared.durableWatermark.forwardUpdateHash,
      inverseUpdateHash: prepared.durableWatermark.inverseUpdateHash,
    },
  };
}

/** Stable-key JSON form suitable for a durable text/blob column or journal. */
export function serializePreparedYjsProseCommand(
  prepared: PreparedYjsProseCommand,
): string {
  return canonicalStringify(toPortablePreparedYjsProseCommand(prepared));
}

/**
 * Strictly restore a prepared command from either parsed JSON or its serialized
 * string. Binary hashes and cross-field watermarks are verified before the
 * command can reach `applyPreparedYjsProseUpdate`.
 */
export async function deserializePreparedYjsProseCommand(
  serialized: string | unknown,
): Promise<PreparedYjsProseCommand> {
  let value: unknown = serialized;
  if (typeof serialized === 'string') {
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      invalidCommand('Serialized Yjs prose command is not valid JSON.');
    }
  }
  // Reject undefined/functions/non-finite values before shape parsing and
  // normalize every object's key order for stable re-serialization.
  value = canonicalJsonValue(value, 'serialized');
  const root = requireRecord(value, 'serialized');
  if (root.format !== 'drifting.yjs-prose-command' || root.schemaVersion !== 1) {
    invalidCommand('Unsupported Yjs prose command format or schemaVersion.');
  }

  const commandId = assertNonEmpty(root.commandId, 'serialized.commandId');
  const operation = parsePortableOperation(root.operation);
  const affectedBlockIds = parseStringArray(
    root.affectedBlockIds,
    'serialized.affectedBlockIds',
  );
  const forwardUpdate = base64ToBytes(
    root.forwardUpdateBase64,
    'serialized.forwardUpdateBase64',
  );
  const inverseUpdate = base64ToBytes(
    root.inverseUpdateBase64,
    'serialized.inverseUpdateBase64',
  );

  const projectionRecord = requireRecord(root.projection, 'serialized.projection');
  if (projectionRecord.fragment !== DEFAULT_FRAGMENT) {
    invalidCommand(`serialized.projection.fragment must be "${DEFAULT_FRAGMENT}".`);
  }
  const contentJson = assertNonEmpty(
    projectionRecord.contentJson,
    'serialized.projection.contentJson',
  );
  const document = canonicalJsonValue(
    projectionRecord.document,
    'serialized.projection.document',
  );
  let contentDocument: unknown;
  try {
    contentDocument = JSON.parse(contentJson) as unknown;
  } catch {
    invalidCommand('serialized.projection.contentJson is not valid JSON.');
  }
  if (canonicalStringify(contentDocument) !== canonicalStringify(document)) {
    invalidCommand('serialized.projection.contentJson does not match document.');
  }
  const blocks = parsePortableBlocks(
    projectionRecord.blocks,
    'serialized.projection.blocks',
  );
  const allBlockIds = parseStringArray(
    projectionRecord.allBlockIds,
    'serialized.projection.allBlockIds',
  );
  if (!arraysEqual(allBlockIds, blocks.map((block) => block.id))) {
    invalidCommand('serialized.projection.allBlockIds does not match blocks.');
  }
  const projectionAffectedBlockIds = parseStringArray(
    projectionRecord.affectedBlockIds,
    'serialized.projection.affectedBlockIds',
  );
  if (!arraysEqual(affectedBlockIds, projectionAffectedBlockIds)) {
    invalidCommand('Serialized affectedBlockIds disagree.');
  }
  const projectionStateHash = parseHash(
    projectionRecord.stateHash,
    'serialized.projection.stateHash',
  );
  const projectionStateVector = base64ToBytes(
    projectionRecord.stateVectorBase64,
    'serialized.projection.stateVectorBase64',
  );

  const watermarkRecord = requireRecord(
    root.durableWatermark,
    'serialized.durableWatermark',
  );
  if (watermarkRecord.commandId !== commandId) {
    invalidCommand('serialized.durableWatermark.commandId does not match commandId.');
  }
  if (
    watermarkRecord.sourceKind !== 'live' &&
    watermarkRecord.sourceKind !== 'closed' &&
    watermarkRecord.sourceKind !== 'seed'
  ) {
    invalidCommand('serialized.durableWatermark.sourceKind is unsupported.');
  }
  const baseRevision = parseSafeRevision(
    watermarkRecord.baseRevision,
    'serialized.durableWatermark.baseRevision',
  );
  const baseStateVector = base64ToBytes(
    watermarkRecord.baseStateVectorBase64,
    'serialized.durableWatermark.baseStateVectorBase64',
  );
  const forwardStateVector = base64ToBytes(
    watermarkRecord.forwardStateVectorBase64,
    'serialized.durableWatermark.forwardStateVectorBase64',
  );
  const inverseStateVector = base64ToBytes(
    watermarkRecord.inverseStateVectorBase64,
    'serialized.durableWatermark.inverseStateVectorBase64',
  );
  if (!bytesEqual(projectionStateVector, forwardStateVector)) {
    invalidCommand('Serialized projection and watermark state vectors disagree.');
  }
  const baseStateHash = parseHash(
    watermarkRecord.baseStateHash,
    'serialized.durableWatermark.baseStateHash',
  );
  const forwardStateHash = parseHash(
    watermarkRecord.forwardStateHash,
    'serialized.durableWatermark.forwardStateHash',
  );
  const restoredStateHash = parseHash(
    watermarkRecord.restoredStateHash,
    'serialized.durableWatermark.restoredStateHash',
  );
  const forwardUpdateHash = parseHash(
    watermarkRecord.forwardUpdateHash,
    'serialized.durableWatermark.forwardUpdateHash',
  );
  const inverseUpdateHash = parseHash(
    watermarkRecord.inverseUpdateHash,
    'serialized.durableWatermark.inverseUpdateHash',
  );
  if (
    projectionStateHash !== forwardStateHash ||
    restoredStateHash !== baseStateHash
  ) {
    invalidCommand('Serialized projection and semantic state hashes disagree.');
  }
  if (
    (await sha256Bytes(forwardUpdate)) !== forwardUpdateHash ||
    (await sha256Bytes(inverseUpdate)) !== inverseUpdateHash
  ) {
    invalidCommand('Serialized Yjs update hash verification failed.');
  }

  return {
    commandId,
    operation,
    forwardUpdate,
    inverseUpdate,
    affectedBlockIds,
    projection: {
      fragment: DEFAULT_FRAGMENT,
      contentJson,
      document,
      blocks,
      allBlockIds,
      affectedBlockIds: projectionAffectedBlockIds,
      stateHash: projectionStateHash,
      stateVector: projectionStateVector,
    },
    durableWatermark: {
      commandId,
      sourceKind: watermarkRecord.sourceKind,
      baseRevision,
      baseStateVector,
      forwardStateVector,
      inverseStateVector,
      baseStateHash,
      forwardStateHash,
      restoredStateHash,
      forwardUpdateHash,
      inverseUpdateHash,
    },
  };
}

/**
 * Apply a prepared delta only when both the CRDT state vector and the
 * schema-visible state hash match its expected base. The hash is essential:
 * Yjs delete-only transactions can change a delete set without advancing the
 * state vector.
 */
export async function applyPreparedYjsProseUpdate(
  doc: Y.Doc,
  prepared: PreparedYjsProseCommand,
  direction: YjsProseUpdateDirection,
): Promise<string> {
  const expectedVector =
    direction === 'forward'
      ? prepared.durableWatermark.baseStateVector
      : prepared.durableWatermark.forwardStateVector;
  const expectedHash =
    direction === 'forward'
      ? prepared.durableWatermark.baseStateHash
      : prepared.durableWatermark.forwardStateHash;
  const actualVector = Y.encodeStateVector(doc);
  if (!bytesEqual(actualVector, expectedVector)) {
    throw new YjsProseCommandError(
      'STALE_STATE_VECTOR',
      `Cannot apply ${direction} update to a stale prose state vector.`,
    );
  }
  const actualHash = await hashYjsProseState(doc);
  if (actualHash !== expectedHash) {
    throw new YjsProseCommandError(
      'STALE_STATE_HASH',
      `Cannot apply ${direction} update to a divergent prose state.`,
    );
  }

  Y.applyUpdate(
    doc,
    direction === 'forward' ? prepared.forwardUpdate : prepared.inverseUpdate,
    direction === 'forward' ? APPLY_FORWARD_ORIGIN : APPLY_INVERSE_ORIGIN,
  );
  const resultHash = await hashYjsProseState(doc);
  const wantedHash =
    direction === 'forward'
      ? prepared.durableWatermark.forwardStateHash
      : prepared.durableWatermark.baseStateHash;
  if (resultHash !== wantedHash) {
    throw new YjsProseCommandError(
      'INVERSE_MISMATCH',
      `Applied ${direction} update produced an unexpected prose state.`,
    );
  }
  return resultHash;
}
