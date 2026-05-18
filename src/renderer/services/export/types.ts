/**
 * Shared types for the export pipeline. One format = one writer.
 *
 * The writer takes a "book" — an ordered list of chapter sections with
 * ProseMirror nodes — and produces a Blob in the target format. The
 * facade (../export.service.ts) hands the blob to either:
 *   - Electron's saveDialog (download to disk), or
 *   - R2 presigned upload (cross-device archive).
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EntityLabelResolver } from '../markdown-export.service';

export type ExportFormat = 'markdown' | 'docx' | 'epub' | 'pdf';

export interface ChapterInput {
  id: string;
  title: string;
  /** Tiptap/ProseMirror document for this chapter. */
  doc: PMNode;
}

export interface BookInput {
  title: string;
  author?: string;
  language?: string; // BCP-47, e.g. 'zh-CN', 'en'
  chapters: ChapterInput[];
}

export interface ExportContext {
  /** Resolves entity-link target IDs to display labels in body text. */
  resolveLabel: EntityLabelResolver;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  mimeType: string;
}

export type FormatWriter = (book: BookInput, ctx: ExportContext) => Promise<ExportResult>;
