import type { PlatformRuntimeSnapshot } from '../../platform/runtime';
import type { ProductSyncAuthoritySnapshot } from '../../sync/product-authority-store';
import type { ProductSyncRuntimeSnapshot } from '../../sync/product-runtime-control';
import type { UpdateServiceState } from '../update/update-service';
import type { SanitizedGoogleDriveOperationTrace } from './google-drive-operation-trace';

const SAFE_CODE = /^[A-Za-z0-9._-]{1,128}$/u;

function sanitizedCode(value: string | null): string | null {
  if (!value) return null;
  return SAFE_CODE.test(value) ? value : 'redacted-error';
}

export function createSanitizedDiagnosticSummary(input: {
  runtime: PlatformRuntimeSnapshot;
  authority: ProductSyncAuthoritySnapshot;
  sync: ProductSyncRuntimeSnapshot;
  update: UpdateServiceState;
  googleDriveOperationTraces?: readonly SanitizedGoogleDriveOperationTrace[];
  generatedAt?: string;
}): string {
  const pending = input.sync.diagnostics?.generations.reduce(
    (total, generation) => ({
      changeSets: total.changeSets + generation.pending.pendingChangeSets,
      segments: total.segments + generation.pending.pendingSegments,
      transfers: total.transfers + generation.pending.pendingTransfers,
      gaps: total.gaps + generation.pending.openGaps,
      conflicts: total.conflicts + generation.pending.openConflicts,
      quarantined: total.quarantined + generation.pending.quarantinedObjects,
      failed: total.failed + Number(generation.lastOutcome === 'failed'),
    }),
    { changeSets: 0, segments: 0, transfers: 0, gaps: 0, conflicts: 0, quarantined: 0, failed: 0 },
  ) ?? { changeSets: 0, segments: 0, transfers: 0, gaps: 0, conflicts: 0, quarantined: 0, failed: 0 };
  const errorCodes = [
    sanitizedCode(input.authority.errorCode),
    ...(input.sync.diagnostics?.generations.map((generation) =>
      sanitizedCode(generation.lastErrorCode),
    ) ?? []),
  ].filter((value): value is string => Boolean(value));

  return `${JSON.stringify(
    {
      format: 'drifting.sanitized-diagnostics',
      formatVersion: 2,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      app: {
        version: input.runtime.appInfo?.version ?? 'unknown',
        platform: input.runtime.appInfo?.platform ?? input.runtime.nativePlatform,
        architecture: input.runtime.appInfo?.architecture ?? 'unknown',
        target: input.runtime.target,
      },
      features: input.runtime.capabilities?.featureStatus ?? null,
      sync: {
        authorityStatus: input.authority.status,
        providerMode: input.authority.mode,
        activeProjects: input.authority.activeSyncGenerations,
        readyProjects: input.authority.readySyncGenerations,
        provisioningProjects: input.authority.provisioningSyncGenerations,
        pausedProjects: input.authority.pausedSyncGenerations,
        attentionProjects: input.authority.attentionSyncGenerations,
        runtimeMounted: input.sync.mounted,
        online: input.sync.diagnostics?.online ?? null,
        suspended: input.sync.diagnostics?.suspended ?? null,
        pending,
        errorCodes: [...new Set(errorCodes)].sort(),
        googleDriveOperationTraces: input.googleDriveOperationTraces ?? [],
      },
      updater: {
        phase: input.update.phase,
        candidateVersion: input.update.update?.version ?? null,
        downloadedBytes: input.update.downloadedBytes,
        totalBytes: input.update.totalBytes,
        hasError: input.update.error !== null,
      },
      privacy: {
        automaticUpload: false,
        manuscriptIncluded: false,
        credentialsIncluded: false,
        absolutePathsIncluded: false,
        rawErrorTextIncluded: false,
        nativeErrorChainSanitized: true,
      },
    },
    null,
    2,
  )}\n`;
}
