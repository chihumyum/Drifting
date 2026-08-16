import * as Y from 'yjs';

import {
  SYNC_DOMAIN_MANIFEST_V1,
  compareHlc,
  compareUtf8Bytewise,
  decodeCanonicalCbor,
  decodeSnapshotCommitMarkerV1,
  decodeSnapshotPackageV1,
  decodeSyncChangeSetV1,
  encodeCanonicalCbor,
  sha256Bytes,
  type CanonicalCborValue,
  type Hlc,
  type SnapshotCommitMarkerV1,
  type SnapshotPackageV1,
} from '../protocol';
import {
  SNAPSHOT_DOMAIN_TABLE_NAMES_V1,
  proseSeedRows,
  tableMapFromAuthoredState,
  type SnapshotDomainTableNameV1,
} from './domain-catalog';
import {
  AUTHORED_STATE_FORMAT_V1,
  REDUCER_STATE_FORMAT_V1,
  SnapshotRestoreError,
  type AuthoredStatePayloadV1,
  type ReducerStatePayloadV1,
  type SnapshotTableRowsV1,
} from './types';

export interface ValidatedSnapshotV1 {
  readonly package: SnapshotPackageV1;
  readonly marker: SnapshotCommitMarkerV1;
  readonly authored: AuthoredStatePayloadV1;
  readonly reducer: ReducerStatePayloadV1;
  readonly maxChangeSetHlc: Hlc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function parseSection(bytes: Uint8Array, label: string): Record<string, unknown> {
  const decoded = decodeCanonicalCbor(bytes);
  if (!decoded.ok || !isRecord(decoded.value)) {
    throw new SnapshotRestoreError('invalid-package', `${label} is not current deterministic CBOR`);
  }
  return decoded.value;
}

function parseAuthored(bytes: Uint8Array): AuthoredStatePayloadV1 {
  const value = parseSection(bytes, 'authored state');
  if (
    value.format !== AUTHORED_STATE_FORMAT_V1 ||
    value.payloadVersion !== 1 ||
    !Array.isArray(value.tables)
  ) {
    throw new SnapshotRestoreError('schema-mismatch', 'Authored state is not current format v1');
  }
  const tables: SnapshotTableRowsV1[] = value.tables.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.table !== 'string' || !Array.isArray(entry.rows)) {
      throw new SnapshotRestoreError('schema-mismatch', `Authored table ${index} is malformed`);
    }
    const rows = entry.rows.map((row, rowIndex) => {
      if (!isRecord(row)) {
        throw new SnapshotRestoreError('schema-mismatch', `${entry.table} row ${rowIndex} is malformed`);
      }
      return row as Readonly<Record<string, CanonicalCborValue>>;
    });
    return { table: entry.table, rows };
  });
  const actual = tables.map((entry) => entry.table);
  if (
    actual.length !== SNAPSHOT_DOMAIN_TABLE_NAMES_V1.length ||
    actual.some((name, index) => name !== SNAPSHOT_DOMAIN_TABLE_NAMES_V1[index])
  ) {
    throw new SnapshotRestoreError(
      'schema-mismatch',
      'Authored state must contain every current included table exactly once in UTF-8 order',
    );
  }
  for (const table of tables) {
    const policy = SYNC_DOMAIN_MANIFEST_V1.tables.find((entry) => entry.table === table.table);
    if (!policy) throw new SnapshotRestoreError('schema-mismatch', `Unknown authored table ${table.table}`);
    const expected = Object.entries(policy.fields)
      .filter(([, field]) => field.disposition === 'include')
      .map(([name]) => name)
      .sort(compareUtf8Bytewise);
    for (const [index, row] of table.rows.entries()) {
      const fields = Object.keys(row).sort(compareUtf8Bytewise);
      if (fields.length !== expected.length || fields.some((field, fieldIndex) => field !== expected[fieldIndex])) {
        throw new SnapshotRestoreError(
          'schema-mismatch',
          `${table.table} row ${index} does not exactly match the current sync manifest`,
        );
      }
    }
  }
  return { format: AUTHORED_STATE_FORMAT_V1, payloadVersion: 1, tables };
}

const REDUCER_ARRAY_KEYS = [
  'changeSets',
  'mutations',
  'applyReceipts',
  'generationPurges',
  'fieldClocks',
  'setTags',
  'orderRegisters',
  'lifecycles',
  'frontier',
] as const;

function parseReducer(bytes: Uint8Array): ReducerStatePayloadV1 {
  const value = parseSection(bytes, 'reducer state');
  if (value.format !== REDUCER_STATE_FORMAT_V1 || value.payloadVersion !== 1) {
    throw new SnapshotRestoreError('schema-mismatch', 'Reducer state is not current format v1');
  }
  const output: Record<string, readonly Readonly<Record<string, CanonicalCborValue>>[]> = {};
  for (const key of REDUCER_ARRAY_KEYS) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.some((entry) => !isRecord(entry))) {
      throw new SnapshotRestoreError('schema-mismatch', `Reducer state ${key} is malformed`);
    }
    output[key] = entries as readonly Readonly<Record<string, CanonicalCborValue>>[];
  }
  return {
    format: REDUCER_STATE_FORMAT_V1,
    payloadVersion: 1,
    changeSets: output.changeSets,
    mutations: output.mutations,
    applyReceipts: output.applyReceipts,
    generationPurges: output.generationPurges,
    fieldClocks: output.fieldClocks,
    setTags: output.setTags,
    orderRegisters: output.orderRegisters,
    lifecycles: output.lifecycles,
    frontier: output.frontier,
  };
}

function rows(
  authored: AuthoredStatePayloadV1,
  table: SnapshotDomainTableNameV1,
): readonly Readonly<Record<string, CanonicalCborValue>>[] {
  return tableMapFromAuthoredState(authored.tables).get(table) ?? [];
}

function requireString(row: Readonly<Record<string, CanonicalCborValue>>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value) {
    throw new SnapshotRestoreError('reference-invalid', `Expected non-empty ${key}`);
  }
  return value;
}

function optionalString(
  row: Readonly<Record<string, CanonicalCborValue>>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null) return null;
  return requireString(row, key);
}

function uniqueIds(
  authored: AuthoredStatePayloadV1,
  table: SnapshotDomainTableNameV1,
  key = 'id',
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows(authored, table)) {
    const id = requireString(row, key);
    if (ids.has(id)) {
      throw new SnapshotRestoreError('reference-invalid', `${table} repeats ${key} ${id}`);
    }
    ids.add(id);
  }
  return ids;
}

function assertProjectReferences(authored: AuthoredStatePayloadV1, projectId: string): void {
  const projects = rows(authored, 'project');
  if (projects.length !== 1 || projects[0].id !== projectId) {
    throw new SnapshotRestoreError('identity-mismatch', 'Authored project root does not match package identity');
  }
  for (const table of SNAPSHOT_DOMAIN_TABLE_NAMES_V1) {
    if (
      table === 'project' ||
      table === 'node_content' ||
      table === 'node_storyline_link' ||
      table === 'entity_relation_type_endpoint_kind' ||
      table === 'plot_grid_document' ||
      table === 'plot_grid_row' ||
      table === 'plot_grid_column' ||
      table === 'plot_grid_cell'
    ) continue;
    for (const row of rows(authored, table as SnapshotDomainTableNameV1)) {
      if (row.project_id !== projectId) {
        throw new SnapshotRestoreError('reference-invalid', `${table} escapes the package project`);
      }
    }
  }
  const nodeIds = uniqueIds(authored, 'book_node');
  const storylineIds = uniqueIds(authored, 'storylines');
  const elementIds = uniqueIds(authored, 'element');
  const categoryIds = uniqueIds(authored, 'element_category');
  const patchIds = uniqueIds(authored, 'element_patch');
  const commentIds = uniqueIds(authored, 'comment');
  const libraryIds = uniqueIds(authored, 'library_item');
  const relationTypeIds = uniqueIds(authored, 'entity_relation_type');
  const groupIds = uniqueIds(authored, 'drift_group');
  const assetIds = uniqueIds(authored, 'project_asset');
  const plotDocumentIds = uniqueIds(authored, 'plot_grid_document');
  const plotRowIds = uniqueIds(authored, 'plot_grid_row');
  const plotColumnIds = uniqueIds(authored, 'plot_grid_column');
  uniqueIds(authored, 'plot_grid_cell');
  uniqueIds(authored, 'entity_kv_entry');
  uniqueIds(authored, 'book_act');
  uniqueIds(authored, 'timeline_marker');
  uniqueIds(authored, 'agent_memory');
  uniqueIds(authored, 'comment_action');
  uniqueIds(authored, 'entity_relation');
  for (const row of rows(authored, 'node_content')) {
    if (!nodeIds.has(requireString(row, 'node_id'))) throw new SnapshotRestoreError('reference-invalid', 'node_content references a missing node');
  }
  const plotDocumentNodes = new Set<string>();
  for (const row of rows(authored, 'plot_grid_document')) {
    const nodeId = requireString(row, 'node_id');
    if (!nodeIds.has(nodeId) || plotDocumentNodes.has(nodeId)) {
      throw new SnapshotRestoreError('reference-invalid', 'plot_grid_document has an invalid or repeated node');
    }
    plotDocumentNodes.add(nodeId);
  }
  const plotRowDocuments = new Map<string, string>();
  for (const row of rows(authored, 'plot_grid_row')) {
    const id = requireString(row, 'id');
    const documentId = requireString(row, 'document_id');
    if (!plotDocumentIds.has(documentId)) {
      throw new SnapshotRestoreError('reference-invalid', 'plot_grid_row references a missing document');
    }
    plotRowDocuments.set(id, documentId);
  }
  const plotColumnDocuments = new Map<string, string>();
  for (const row of rows(authored, 'plot_grid_column')) {
    const id = requireString(row, 'id');
    const documentId = requireString(row, 'document_id');
    if (!plotDocumentIds.has(documentId)) {
      throw new SnapshotRestoreError('reference-invalid', 'plot_grid_column references a missing document');
    }
    plotColumnDocuments.set(id, documentId);
  }
  for (const row of rows(authored, 'plot_grid_cell')) {
    const documentId = requireString(row, 'document_id');
    const rowId = requireString(row, 'row_id');
    const columnId = requireString(row, 'column_id');
    if (
      !plotRowIds.has(rowId) ||
      !plotColumnIds.has(columnId) ||
      plotRowDocuments.get(rowId) !== documentId ||
      plotColumnDocuments.get(columnId) !== documentId
    ) {
      throw new SnapshotRestoreError('reference-invalid', 'plot_grid_cell references an invalid coordinate');
    }
  }
  for (const row of rows(authored, 'entity_kv_entry')) {
    const ownerKind = requireString(row, 'owner_kind');
    const ownerId = requireString(row, 'owner_id');
    const namespace = requireString(row, 'namespace');
    const validOwner =
      (ownerKind === 'project' &&
        ownerId === projectId &&
        (namespace === 'facts' || namespace === 'storyline-template')) ||
      (ownerKind === 'storyline' && storylineIds.has(ownerId) && namespace === 'facts') ||
      (ownerKind === 'element-category' &&
        categoryIds.has(ownerId) &&
        namespace === 'element-template') ||
      (ownerKind === 'element' && elementIds.has(ownerId) && namespace === 'facts');
    if (!validOwner) {
      throw new SnapshotRestoreError('reference-invalid', 'entity_kv_entry references an invalid owner');
    }
  }
  for (const row of rows(authored, 'node_storyline_link')) {
    if (!nodeIds.has(requireString(row, 'node_id')) || !storylineIds.has(requireString(row, 'storyline_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'node_storyline_link references an entity outside the package');
    }
  }
  for (const row of rows(authored, 'entity_relation_type_endpoint_kind')) {
    if (!relationTypeIds.has(requireString(row, 'relation_type_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'relation endpoint kind references a missing relation type');
    }
  }
  for (const row of rows(authored, 'drift_group')) {
    const parent = optionalString(row, 'parent_group_id');
    if (parent !== null && !groupIds.has(parent)) {
      throw new SnapshotRestoreError('reference-invalid', 'drift_group references a missing parent');
    }
  }
  for (const row of rows(authored, 'book_node')) {
    const group = optionalString(row, 'drift_group_id');
    if (group !== null && (!groupIds.has(group) || row.kind !== 'drift')) {
      throw new SnapshotRestoreError('reference-invalid', 'book_node has an invalid drift group binding');
    }
  }
  for (const row of rows(authored, 'element')) {
    const category = optionalString(row, 'category_id');
    if (category !== null && !categoryIds.has(category)) {
      throw new SnapshotRestoreError('reference-invalid', 'element references a missing category');
    }
    if (row.portrait_asset_id !== null && !assetIds.has(requireString(row, 'portrait_asset_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'element references a missing portrait asset');
    }
  }
  for (const row of rows(authored, 'element_patch')) {
    if (!elementIds.has(requireString(row, 'element_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'element_patch references a missing element');
    }
    const sourceNode = optionalString(row, 'source_node_id');
    if (sourceNode !== null && !nodeIds.has(sourceNode)) {
      throw new SnapshotRestoreError('reference-invalid', 'element_patch references a missing source node');
    }
  }
  for (const row of rows(authored, 'comment_action')) {
    if (!commentIds.has(requireString(row, 'comment_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'comment_action references a missing comment');
    }
  }
  for (const row of rows(authored, 'library_item')) {
    if (row.asset_id !== null && !assetIds.has(requireString(row, 'asset_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'library item references a missing asset');
    }
  }
  const structuralByKind: Readonly<Record<string, ReadonlySet<string>>> = {
    node: nodeIds,
    element: elementIds,
    patch: patchIds,
    category: categoryIds,
    storyline: storylineIds,
    comment: commentIds,
    library_item: libraryIds,
  };
  for (const row of rows(authored, 'entity_relation')) {
    if (!relationTypeIds.has(requireString(row, 'relation_type_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'entity_relation references a missing relation type');
    }
    const from = structuralByKind[requireString(row, 'from_kind')];
    const to = structuralByKind[requireString(row, 'to_kind')];
    if (!from?.has(requireString(row, 'from_id')) || !to?.has(requireString(row, 'to_id'))) {
      throw new SnapshotRestoreError('reference-invalid', 'entity_relation endpoint is missing');
    }
  }
  for (const row of rows(authored, 'comment')) {
    const kind = optionalString(row, 'target_kind');
    const id = optionalString(row, 'target_id');
    if ((kind === null) !== (id === null) || (kind !== null && !structuralByKind[kind]?.has(id!))) {
      throw new SnapshotRestoreError('reference-invalid', 'comment target is invalid');
    }
  }
  for (const table of ['book_act', 'timeline_marker'] as const) {
    for (const row of rows(authored, table)) {
      const drift = optionalString(row, 'drift_node_id');
      if (drift !== null && !nodeIds.has(drift)) {
        throw new SnapshotRestoreError('reference-invalid', `${table} references a missing drift node`);
      }
    }
  }
  for (const row of rows(authored, 'agent_memory')) {
    const kind = optionalString(row, 'target_kind');
    const id = optionalString(row, 'target_id');
    if ((kind === null) !== (id === null) || (kind !== null && !structuralByKind[kind]?.has(id!))) {
      throw new SnapshotRestoreError('reference-invalid', 'agent_memory target is invalid');
    }
  }
}

async function assertAssets(packageValue: SnapshotPackageV1, authored: AuthoredStatePayloadV1): Promise<void> {
  const metadata = new Map(rows(authored, 'project_asset').map((row) => [String(row.id), row]));
  if (metadata.size !== packageValue.assets.length) {
    throw new SnapshotRestoreError('reference-invalid', 'Asset manifest does not cover every project_asset');
  }
  for (const asset of packageValue.assets) {
    const row = metadata.get(asset.assetId);
    if (
      !row ||
      asset.sourceSha256 !== `sha256:${String(row.source_sha256)}` ||
      asset.sizeBytes !== row.source_size_bytes ||
      asset.mimeType !== row.source_mime
    ) {
      throw new SnapshotRestoreError('reference-invalid', `Asset manifest disagrees with ${asset.assetId}`);
    }
  }
}

async function assertProse(packageValue: SnapshotPackageV1, authored: AuthoredStatePayloadV1): Promise<void> {
  const seeds = proseSeedRows(authored.tables);
  if (seeds.size !== packageValue.proseDocuments.length) {
    throw new SnapshotRestoreError('reference-invalid', 'Prose manifest does not cover every prose-capable entity');
  }
  for (const document of packageValue.proseDocuments) {
    const seed = seeds.get(document.documentId);
    if (seed === undefined) throw new SnapshotRestoreError('reference-invalid', `Unknown prose document ${document.documentId}`);
    if (document.mode === 'seed-only') {
      const [expected, actual] = await Promise.all([
        sha256Bytes(encodeCanonicalCbor(seed)),
        sha256Bytes(encodeCanonicalCbor(document.seed)),
      ]);
      if (expected !== actual) {
        throw new SnapshotRestoreError('reference-invalid', `Seed-only prose differs from authored state for ${document.documentId}`);
      }
      continue;
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, document.state, 'sync-restore:validate');
      Y.encodeStateAsUpdate(doc);
    } catch (error) {
      throw new SnapshotRestoreError('invalid-yjs', `Invalid Yjs state for ${document.documentId}`, error);
    } finally {
      doc.destroy();
    }
  }
}

function normalizeBytes(value: CanonicalCborValue | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new SnapshotRestoreError('schema-mismatch', 'Reducer encoded bytes are not a byte string');
}

async function assertReducerIdentity(
  reducer: ReducerStatePayloadV1,
  packageValue: SnapshotPackageV1,
): Promise<Hlc> {
  const changeSetIds = new Set<string>();
  const mutationKeys = new Set<string>();
  const mutationsByKey = new Map<string, Readonly<Record<string, CanonicalCborValue>>>();
  let maxChangeSetHlc: Hlc = { wallMs: 0, counter: 0 };
  for (const row of reducer.changeSets) {
    if (
      row.sync_generation_id !== packageValue.syncGenerationId ||
      row.project_id !== packageValue.projectId ||
      row.project_sync_id !== packageValue.projectSyncId ||
      row.protocol_version !== 1 ||
      row.payload_version !== 1
    ) {
      throw new SnapshotRestoreError('identity-mismatch', 'Reducer journal identity or version differs from the package');
    }
    const changeSetId = requireString(row, 'change_set_id');
    if (changeSetIds.has(changeSetId)) {
      throw new SnapshotRestoreError('reference-invalid', `Reducer repeats change-set ${changeSetId}`);
    }
    changeSetIds.add(changeSetId);
    const bytes = normalizeBytes(row.encoded_bytes);
    const decoded = await decodeSyncChangeSetV1(bytes);
    const storedHash = await sha256Bytes(bytes);
    if (
      !decoded.ok ||
      decoded.value.changeSetId !== changeSetId ||
      decoded.value.projectId !== packageValue.projectId ||
      decoded.value.projectSyncId !== packageValue.projectSyncId ||
      decoded.value.syncGenerationId !== packageValue.syncGenerationId ||
      row.writer_id !== decoded.value.writerId ||
      row.writer_epoch !== decoded.value.writerEpoch ||
      row.device_seq !== decoded.value.deviceSeq ||
      row.hlc_wall_ms !== decoded.value.hlc.wallMs ||
      row.hlc_counter !== decoded.value.hlc.counter ||
      row.apply_state !== 'applied' ||
      row.mutation_count !== decoded.value.mutations.length ||
      `sha256:${String(row.payload_sha256)}` !== storedHash
    ) {
      throw new SnapshotRestoreError('reference-invalid', `Reducer change-set ${changeSetId} bytes disagree with its row`);
    }
    if (compareHlc(maxChangeSetHlc, decoded.value.hlc) < 0) {
      maxChangeSetHlc = decoded.value.hlc;
    }
  }
  for (const row of reducer.mutations) {
    const changeSetId = requireString(row, 'change_set_id');
    const index = row.mutation_index;
    if (!changeSetIds.has(changeSetId) || typeof index !== 'number' || !Number.isSafeInteger(index)) {
      throw new SnapshotRestoreError('reference-invalid', 'Reducer mutation references a missing change-set');
    }
    const key = `${changeSetId}\u0000${index}`;
    if (mutationKeys.has(key)) throw new SnapshotRestoreError('reference-invalid', 'Reducer mutation identity repeats');
    mutationKeys.add(key);
    mutationsByKey.set(key, row);
  }
  const receiptIds = new Set<string>();
  for (const row of reducer.applyReceipts) {
    const changeSetId = requireString(row, 'change_set_id');
    if (row.sync_generation_id !== packageValue.syncGenerationId || !changeSetIds.has(changeSetId)) {
      throw new SnapshotRestoreError('reference-invalid', 'Reducer receipt references a missing change-set');
    }
    receiptIds.add(changeSetId);
  }
  if (receiptIds.size !== changeSetIds.size) {
    throw new SnapshotRestoreError('reference-invalid', 'Reducer checkpoint must retain one receipt per covered change-set');
  }
  const requireMutationSource = (
    row: Readonly<Record<string, CanonicalCborValue>>,
    changeSetKey: string,
    indexKey: string,
  ) => {
    const changeSetId = requireString(row, changeSetKey);
    const index = row[indexKey];
    if (typeof index !== 'number' || !mutationKeys.has(`${changeSetId}\u0000${index}`)) {
      throw new SnapshotRestoreError('reference-invalid', 'Reducer register references a missing source mutation');
    }
  };
  for (const row of reducer.fieldClocks) requireMutationSource(row, 'change_set_id', 'mutation_index');
  if (reducer.generationPurges.length > 1) {
    throw new SnapshotRestoreError('reference-invalid', 'Reducer contains more than one SyncGeneration purge register');
  }
  for (const row of reducer.generationPurges) {
    requireMutationSource(row, 'change_set_id', 'mutation_index');
    const source = mutationsByKey.get(`${String(row.change_set_id)}\u0000${String(row.mutation_index)}`);
    if (
      source?.action !== 'sync-generation.purge' ||
      source.target_family !== 'sync-generation' ||
      source.target_kind !== 'sync-generation' ||
      source.target_id !== packageValue.syncGenerationId
    ) {
      throw new SnapshotRestoreError('reference-invalid', 'SyncGeneration purge register does not reference this SyncGeneration purge mutation');
    }
  }
  for (const row of reducer.orderRegisters) requireMutationSource(row, 'change_set_id', 'mutation_index');
  for (const row of reducer.lifecycles) requireMutationSource(row, 'change_set_id', 'mutation_index');
  for (const row of reducer.setTags) {
    requireMutationSource(row, 'add_change_set_id', 'add_mutation_index');
    if (row.removed_by_change_set_id !== null) {
      requireMutationSource(row, 'removed_by_change_set_id', 'removed_by_mutation_index');
    }
  }
  for (const collection of [reducer.generationPurges, reducer.fieldClocks, reducer.setTags, reducer.orderRegisters, reducer.lifecycles, reducer.frontier]) {
    if (collection.some((row) => row.sync_generation_id !== packageValue.syncGenerationId)) {
      throw new SnapshotRestoreError('identity-mismatch', 'Reducer metadata escapes the package SyncGeneration');
    }
  }
  const frontierByWriter = new Map(
    reducer.frontier.map((row) => [`${String(row.writer_id)}\u0000${String(row.writer_epoch)}`, row]),
  );
  if (frontierByWriter.size !== packageValue.frontier.length) {
    throw new SnapshotRestoreError('reference-invalid', 'Package and reducer frontier sizes differ');
  }
  for (const entry of packageValue.frontier) {
    const row = frontierByWriter.get(`${entry.writerId}\u0000${entry.writerEpoch}`);
    const storedHead = row?.segment_head_sha256 == null ? null : `sha256:${String(row.segment_head_sha256)}`;
    if (!row || row.applied_seq !== entry.appliedSeq || storedHead !== entry.segmentHeadHash) {
      throw new SnapshotRestoreError('reference-invalid', 'Package frontier differs from reducer frontier');
    }
  }
  return maxChangeSetHlc;
}

function decodeFailureCode(reason: string): 'unknown-version' | 'invalid-marker' | 'invalid-package' {
  if (reason === 'unsupported-protocol-version' || reason === 'unsupported-payload-version') return 'unknown-version';
  return 'invalid-package';
}

export async function validateSnapshotForRestoreV1(input: {
  packageBytes: Uint8Array;
  commitMarkerBytes: Uint8Array;
  expected: { projectId: string; projectSyncId: string; syncGenerationId: string };
}): Promise<ValidatedSnapshotV1> {
  const markerResult = decodeSnapshotCommitMarkerV1(input.commitMarkerBytes);
  if (!markerResult.ok) {
    const code = markerResult.reason.includes('version') ? 'unknown-version' : 'invalid-marker';
    throw new SnapshotRestoreError(code, `Snapshot commit marker rejected: ${markerResult.reason}`);
  }
  const packageResult = await decodeSnapshotPackageV1(input.packageBytes);
  if (!packageResult.ok) {
    throw new SnapshotRestoreError(
      decodeFailureCode(packageResult.reason),
      `Snapshot package rejected: ${packageResult.reason}`,
    );
  }
  const marker = markerResult.value;
  const packageValue = packageResult.value;
  const packageHash = await sha256Bytes(input.packageBytes);
  if (
    marker.packageSha256 !== packageHash ||
    marker.snapshotId !== packageValue.snapshotId ||
    marker.snapshotKind !== packageValue.snapshotKind ||
    marker.projectId !== packageValue.projectId ||
    marker.projectSyncId !== packageValue.projectSyncId ||
    marker.syncGenerationId !== packageValue.syncGenerationId ||
    marker.requiredBlobIds.length !== packageValue.requiredBlobIds.length ||
    marker.requiredBlobIds.some((blobId, index) => blobId !== packageValue.requiredBlobIds[index])
  ) {
    throw new SnapshotRestoreError('invalid-marker', 'Commit marker does not bind the supplied package exactly');
  }
  if (
    packageValue.projectId !== input.expected.projectId ||
    packageValue.projectSyncId !== input.expected.projectSyncId ||
    packageValue.syncGenerationId !== input.expected.syncGenerationId
  ) {
    throw new SnapshotRestoreError('identity-mismatch', 'Snapshot identity does not match the staged restore SyncGeneration');
  }
  if (
    packageValue.protocolVersion !== 1 ||
    packageValue.payloadVersion !== 1 ||
    packageValue.domainManifestVersion !== 1 ||
    packageValue.sqliteSchemaVersion !== 1
  ) {
    throw new SnapshotRestoreError('schema-mismatch', 'Only current snapshot/domain/SQLite schema v1 is supported');
  }
  const authored = parseAuthored(packageValue.authoredState.bytes);
  const reducer = parseReducer(packageValue.reducerState.bytes);
  assertProjectReferences(authored, packageValue.projectId);
  await assertAssets(packageValue, authored);
  await assertProse(packageValue, authored);
  const maxChangeSetHlc = await assertReducerIdentity(reducer, packageValue);
  if (reducer.generationPurges.length > 0) {
    throw new SnapshotRestoreError(
      'reference-invalid',
      'A terminally purged SyncGeneration cannot be restored as an active project',
    );
  }
  return { package: packageValue, marker, authored, reducer, maxChangeSetHlc };
}
