/**
 * Export facade.
 *
 * Two save targets:
 *   1. local — saveAs blob via browser anchor download. Works offline,
 *      no server needed.
 *   2. cloud — server mints presigned R2 upload, client PUTs the blob,
 *      then the artifact is available cross-device via a download URL.
 *
 * Format writers are lazy-loaded: importing this index file shouldn't
 * pull in the docx (~600 KB) or epub-gen-memory bundles unless the user
 * actually picks those formats.
 */
import { apiClient } from '../../lib/axios-config';
import type { BookInput, ExportContext, ExportFormat, ExportResult } from './types';

export type { ExportFormat, BookInput, ExportContext } from './types';

async function pickWriter(format: ExportFormat) {
  switch (format) {
    case 'markdown':
      return (await import('./markdown')).writeMarkdown;
    case 'docx':
      return (await import('./docx')).writeDocx;
    case 'epub':
      return (await import('./epub')).writeEpub;
    case 'pdf':
      throw new Error(
        'PDF export should go through Electron `webContents.printToPDF` — implemented as a separate IPC path.',
      );
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown export format: ${_exhaustive as string}`);
    }
  }
}

export async function buildExport(
  book: BookInput,
  format: ExportFormat,
  ctx: ExportContext,
): Promise<ExportResult> {
  const writer = await pickWriter(format);
  return writer(book, ctx);
}

/**
 * Save to disk via a browser anchor click. Works without any server. The
 * Electron-native save dialog can be wired later via an IPC handler if we
 * want a proper "Save As" sheet — keeping the simple path for MVP.
 */
export function saveBlobLocally(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Push to the cloud-archive bucket. The server presigns an R2 upload URL
 * and records the job; the client PUTs the blob directly. We never proxy
 * bytes through the API server.
 */
export async function uploadToCloud(
  projectId: string,
  result: ExportResult,
  format: ExportFormat,
): Promise<{ jobId: string }> {
  const { data: created } = await apiClient.post<{
    jobId: string;
    uploadUrl: string;
    objectKey: string;
    contentType: string;
  }>('/api/export', { projectId, format });

  const put = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': created.contentType },
    body: result.blob,
  });

  if (!put.ok) {
    await apiClient.post(`/api/export/${created.jobId}/fail`, {
      error: `R2 upload failed: ${put.status} ${put.statusText}`,
    });
    throw new Error(`Upload failed: ${put.status}`);
  }

  await apiClient.post(`/api/export/${created.jobId}/complete`, {
    sizeBytes: result.blob.size,
  });
  return { jobId: created.jobId };
}

/** Whether the cloud archive is configured server-side. */
export async function getExportCloudStatus(): Promise<{ configured: boolean; bucket?: string }> {
  try {
    const { data } = await apiClient.get<{ configured: boolean; bucket?: string }>(
      '/api/export/status',
    );
    return data;
  } catch {
    return { configured: false };
  }
}

/** Recent export jobs for the current user. */
export interface ExportJobSummary {
  id: string;
  projectId: string;
  format: ExportFormat;
  status: string;
  sizeBytes: number | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export async function listExportJobs(): Promise<ExportJobSummary[]> {
  const { data } = await apiClient.get<{ jobs: ExportJobSummary[] }>('/api/export');
  return data.jobs;
}

export async function getExportDownloadUrl(jobId: string): Promise<string | null> {
  try {
    const { data } = await apiClient.get<{ url: string }>(`/api/export/${jobId}/download`);
    return data.url;
  } catch {
    return null;
  }
}
