import { Type, type Static } from '@sinclair/typebox';

import {
  OPAQUE_ID_SCHEMA,
  POSITIVE_SAFE_INTEGER_SCHEMA,
  SAFE_UNSIGNED_INTEGER_SCHEMA,
  SHA256_SCHEMA,
  type Sha256,
} from './primitives';
import { assertSchema } from './validation';

export const PROVIDER_KINDS = ['memory', 'local-folder', 'google-drive', 'hosted'] as const;
export const SYNC_OBJECT_KINDS = [
  'segment',
  'genesis',
  'checkpoint',
  'snapshot-commit',
  'blob',
] as const;

const opaqueProviderStringSchema = Type.String({
  minLength: 1,
  maxLength: 8192,
  pattern: '^[^\\u0000]+$',
});

const localObjectRefSchema = Type.String({
  minLength: 10,
  maxLength: 521,
  pattern: '^syncobj:[A-Za-z0-9._~-]{2,512}$',
});

export const PROVIDER_KIND_SCHEMA = Type.Union([
  Type.Literal('memory'),
  Type.Literal('local-folder'),
  Type.Literal('google-drive'),
  Type.Literal('hosted'),
]);
export const SYNC_OBJECT_KIND_SCHEMA = Type.Union([
  Type.Literal('segment'),
  Type.Literal('genesis'),
  Type.Literal('checkpoint'),
  Type.Literal('snapshot-commit'),
  Type.Literal('blob'),
]);
export const PROVIDER_CURSOR_SCHEMA = opaqueProviderStringSchema;
export const PROVIDER_PAGE_TOKEN_SCHEMA = opaqueProviderStringSchema;
export const PROVIDER_OBJECT_ID_SCHEMA = opaqueProviderStringSchema;
export const PROVIDER_GENERATION_REF_SCHEMA = opaqueProviderStringSchema;
export const LOCAL_OBJECT_REF_SCHEMA = localObjectRefSchema;

declare const providerCursorBrand: unique symbol;
declare const providerPageTokenBrand: unique symbol;
declare const providerObjectIdBrand: unique symbol;
declare const providerGenerationRefBrand: unique symbol;
declare const localObjectRefBrand: unique symbol;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type SyncObjectKind = (typeof SYNC_OBJECT_KINDS)[number];
export type ProviderCursor = string & { readonly [providerCursorBrand]: true };
export type ProviderPageToken = string & { readonly [providerPageTokenBrand]: true };
export type ProviderObjectId = string & { readonly [providerObjectIdBrand]: true };
export type ProviderGenerationRef = string & { readonly [providerGenerationRefBrand]: true };
export type LocalObjectRef = string & { readonly [localObjectRefBrand]: true };

function opaqueString<T>(schema: typeof opaqueProviderStringSchema, value: string, label: string): T {
  assertSchema(schema, value, label);
  return value as T;
}

export function createProviderCursor(value: string): ProviderCursor {
  return opaqueString<ProviderCursor>(PROVIDER_CURSOR_SCHEMA, value, 'ProviderCursor');
}

export function createProviderPageToken(value: string): ProviderPageToken {
  return opaqueString<ProviderPageToken>(PROVIDER_PAGE_TOKEN_SCHEMA, value, 'ProviderPageToken');
}

export function createProviderObjectId(value: string): ProviderObjectId {
  return opaqueString<ProviderObjectId>(PROVIDER_OBJECT_ID_SCHEMA, value, 'ProviderObjectId');
}

export function createProviderGenerationRef(value: string): ProviderGenerationRef {
  return opaqueString<ProviderGenerationRef>(PROVIDER_GENERATION_REF_SCHEMA, value, 'ProviderGenerationRef');
}

export function createLocalObjectRef(value: string): LocalObjectRef {
  return opaqueString<LocalObjectRef>(LOCAL_OBJECT_REF_SCHEMA, value, 'LocalObjectRef');
}

export const PROVIDER_BINDING_SCHEMA = Type.Object(
  {
    bindingId: OPAQUE_ID_SCHEMA,
    syncGenerationId: OPAQUE_ID_SCHEMA,
    accountRef: Type.Union([OPAQUE_ID_SCHEMA, Type.Null()]),
    secretRef: Type.Union([OPAQUE_ID_SCHEMA, Type.Null()]),
    authorityGeneration: POSITIVE_SAFE_INTEGER_SCHEMA,
  },
  { additionalProperties: false },
);

export const PROVIDER_GENERATION_SCHEMA = Type.Object(
  {
    bindingId: OPAQUE_ID_SCHEMA,
    syncGenerationId: OPAQUE_ID_SCHEMA,
    generationRef: PROVIDER_GENERATION_REF_SCHEMA,
  },
  { additionalProperties: false },
);

export const REMOTE_OBJECT_SCHEMA = Type.Object(
  {
    objectId: PROVIDER_OBJECT_ID_SCHEMA,
    objectKind: SYNC_OBJECT_KIND_SCHEMA,
    logicalKeyId: OPAQUE_ID_SCHEMA,
    storedSha256: SHA256_SCHEMA,
    sizeBytes: SAFE_UNSIGNED_INTEGER_SCHEMA,
  },
  { additionalProperties: false },
);

export const REMOTE_OBJECT_CHANGE_SCHEMA = Type.Union([
  Type.Object(
    { kind: Type.Literal('present'), object: REMOTE_OBJECT_SCHEMA },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('removed'),
      objectId: PROVIDER_OBJECT_ID_SCHEMA,
      logicalKeyId: Type.Union([OPAQUE_ID_SCHEMA, Type.Null()]),
    },
    { additionalProperties: false },
  ),
]);

export const INVENTORY_PAGE_SCHEMA = Type.Object(
  {
    objects: Type.Array(REMOTE_OBJECT_SCHEMA),
    nextPageToken: Type.Optional(PROVIDER_PAGE_TOKEN_SCHEMA),
  },
  { additionalProperties: false },
);

export const CHANGE_PAGE_SCHEMA = Type.Object(
  {
    changes: Type.Array(REMOTE_OBJECT_CHANGE_SCHEMA),
    nextPageToken: Type.Optional(PROVIDER_PAGE_TOKEN_SCHEMA),
    newCursor: Type.Optional(PROVIDER_CURSOR_SCHEMA),
  },
  { additionalProperties: false },
);

export const UPLOAD_RESULT_SCHEMA = Type.Object(
  {
    status: Type.Union([Type.Literal('created'), Type.Literal('already-present')]),
    object: REMOTE_OBJECT_SCHEMA,
  },
  { additionalProperties: false },
);

export const DOWNLOAD_RESULT_SCHEMA = Type.Object(
  {
    destinationRef: LOCAL_OBJECT_REF_SCHEMA,
    storedSha256: SHA256_SCHEMA,
    sizeBytes: SAFE_UNSIGNED_INTEGER_SCHEMA,
  },
  { additionalProperties: false },
);

export type ProviderBinding = Static<typeof PROVIDER_BINDING_SCHEMA>;
export type ProviderGeneration = Omit<Static<typeof PROVIDER_GENERATION_SCHEMA>, 'generationRef'> & {
  generationRef: ProviderGenerationRef;
};
export type RemoteObject = Omit<Static<typeof REMOTE_OBJECT_SCHEMA>, 'objectId'> & {
  objectId: ProviderObjectId;
};
export type RemoteObjectChange =
  | { kind: 'present'; object: RemoteObject }
  | { kind: 'removed'; objectId: ProviderObjectId; logicalKeyId: string | null };

export interface ObjectIdentity {
  generation: ProviderGeneration;
  objectKind: SyncObjectKind;
  logicalKeyId: string;
}

export interface InventoryInput {
  generation: ProviderGeneration;
  pageToken?: ProviderPageToken;
}

export interface InventoryPage {
  objects: readonly RemoteObject[];
  nextPageToken?: ProviderPageToken;
}

export interface ChangeInput {
  generation: ProviderGeneration;
  cursor: ProviderCursor;
  pageToken?: ProviderPageToken;
}

export interface ChangePage {
  changes: readonly RemoteObjectChange[];
  nextPageToken?: ProviderPageToken;
  newCursor?: ProviderCursor;
}

export interface UploadResult {
  status: 'created' | 'already-present';
  object: RemoteObject;
}

export interface DownloadResult {
  destinationRef: LocalObjectRef;
  storedSha256: Sha256;
  sizeBytes: number;
}

export interface TransferProgress {
  readonly transferredBytes: number;
  readonly totalBytes: number;
}

export interface ObjectLogProvider {
  readonly kind: ProviderKind;

  openGeneration(binding: ProviderBinding): Promise<ProviderGeneration>;
  captureStartCursor(generation: ProviderGeneration): Promise<ProviderCursor>;
  listInventory(input: InventoryInput): Promise<InventoryPage>;
  listChanges(input: ChangeInput): Promise<ChangePage>;
  statImmutable(input: ObjectIdentity): Promise<RemoteObject | null>;
  uploadImmutable(input: {
    generation: ProviderGeneration;
    sourceRef: LocalObjectRef;
    objectKind: SyncObjectKind;
    logicalKeyId: string;
    storedSha256: Sha256;
    sizeBytes: number;
    transferId: string;
    signal: AbortSignal;
    onProgress?: (progress: TransferProgress) => void;
  }): Promise<UploadResult>;
  downloadImmutable(input: {
    generation: ProviderGeneration;
    objectId: ProviderObjectId;
    destinationRef: LocalObjectRef;
    expectedStoredSha256: Sha256;
    transferId: string;
    signal: AbortSignal;
    onProgress?: (progress: TransferProgress) => void;
  }): Promise<DownloadResult>;
}
