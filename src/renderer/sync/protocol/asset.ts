import { Type, type Static } from '@sinclair/typebox';

import type { SyncChangeSetV1, SyncMutationV1 } from './change-set';
import {
  OPAQUE_ID_SCHEMA,
  POSITIVE_SAFE_INTEGER_SCHEMA,
  SHA256_SCHEMA,
} from './primitives';
import { compareUtf8Bytewise } from './order';
import { validateSchema, type ProtocolValidationResult } from './validation';

export const PROJECT_ASSET_OWNER_V1_SCHEMA = Type.Object(
  {
    kind: Type.Union([Type.Literal('library-item'), Type.Literal('element-portrait')]),
    id: OPAQUE_ID_SCHEMA,
  },
  { additionalProperties: false },
);

export const PROJECT_ASSET_BIND_PAYLOAD_V1_SCHEMA = Type.Object(
  {
    blobId: SHA256_SCHEMA,
    sourceSha256: SHA256_SCHEMA,
    sourceMime: Type.String({ minLength: 1, maxLength: 255 }),
    sourceSizeBytes: POSITIVE_SAFE_INTEGER_SCHEMA,
    kind: Type.Union([Type.Literal('image'), Type.Literal('pdf')]),
    width: Type.Union([POSITIVE_SAFE_INTEGER_SCHEMA, Type.Null()]),
    height: Type.Union([POSITIVE_SAFE_INTEGER_SCHEMA, Type.Null()]),
    createdAt: Type.String({ minLength: 1, maxLength: 64 }),
    owner: PROJECT_ASSET_OWNER_V1_SCHEMA,
  },
  { additionalProperties: false },
);

export const PROJECT_ASSET_UNBIND_PAYLOAD_V1_SCHEMA = Type.Object(
  { owner: PROJECT_ASSET_OWNER_V1_SCHEMA },
  { additionalProperties: false },
);

export type ProjectAssetOwnerV1 = Static<typeof PROJECT_ASSET_OWNER_V1_SCHEMA>;
export type ProjectAssetBindPayloadV1 = Static<typeof PROJECT_ASSET_BIND_PAYLOAD_V1_SCHEMA>;
export type ProjectAssetUnbindPayloadV1 = Static<typeof PROJECT_ASSET_UNBIND_PAYLOAD_V1_SCHEMA>;

export type ParsedProjectAssetMutationV1 =
  | { readonly action: 'asset.bind'; readonly payload: ProjectAssetBindPayloadV1 }
  | { readonly action: 'asset.unbind'; readonly payload: ProjectAssetUnbindPayloadV1 };

export function parseProjectAssetMutationV1(
  mutation: Pick<SyncMutationV1, 'action' | 'target' | 'payload'>,
): ProtocolValidationResult<ParsedProjectAssetMutationV1> {
  if (mutation.target.family !== 'asset' || mutation.target.kind !== 'project-asset') {
    return {
      ok: false,
      issues: [{ path: '/target', message: 'asset mutation target must be project-asset' }],
    };
  }
  if (mutation.action === 'asset.bind') {
    const result = validateSchema(PROJECT_ASSET_BIND_PAYLOAD_V1_SCHEMA, mutation.payload);
    return result.ok
      ? { ok: true, value: { action: mutation.action, payload: result.value } }
      : result;
  }
  if (mutation.action === 'asset.unbind') {
    const result = validateSchema(PROJECT_ASSET_UNBIND_PAYLOAD_V1_SCHEMA, mutation.payload);
    return result.ok
      ? { ok: true, value: { action: mutation.action, payload: result.value } }
      : result;
  }
  return {
    ok: false,
    issues: [{ path: '/action', message: 'project-asset target requires asset.bind or asset.unbind' }],
  };
}

/** Fail-closed dependency extraction used by every segment publisher. */
export function requiredBlobIdsForChangeSet(changeSet: SyncChangeSetV1): readonly string[] {
  const blobIds = new Set<string>();
  for (const mutation of changeSet.mutations) {
    if (mutation.action !== 'asset.bind' && mutation.action !== 'asset.unbind') continue;
    const parsed = parseProjectAssetMutationV1(mutation);
    if (!parsed.ok) {
      const detail = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
      throw new TypeError(`invalid project asset mutation: ${detail}`);
    }
    if (parsed.value.action === 'asset.bind') {
      const issues = validateProjectAssetBindSemantics(parsed.value.payload);
      if (issues.length > 0) {
        const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        throw new TypeError(`invalid project asset mutation: ${detail}`);
      }
      blobIds.add(parsed.value.payload.blobId);
    }
  }
  return [...blobIds].sort(compareUtf8Bytewise);
}

/** Image dimensions are required; PDF dimensions are intentionally absent. */
export function validateProjectAssetBindSemantics(
  payload: ProjectAssetBindPayloadV1,
): readonly { path: string; message: string }[] {
  const issues: Array<{ path: string; message: string }> = [];
  if (payload.blobId !== payload.sourceSha256) {
    issues.push({ path: '/blobId', message: 'must equal sourceSha256 in protocol v1' });
  }
  if (payload.kind === 'image' && (payload.width === null || payload.height === null)) {
    issues.push({ path: '/width', message: 'image assets require width and height' });
  }
  if (payload.kind === 'pdf' && (payload.width !== null || payload.height !== null)) {
    issues.push({ path: '/width', message: 'PDF assets require null width and height' });
  }
  return issues;
}
