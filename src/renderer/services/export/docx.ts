/**
 * DOCX writer.
 *
 * Strategy: minimal but faithful — heading levels, paragraphs, lists,
 * blockquotes, code blocks, basic marks (bold/italic/underline/strike).
 * No table support yet (Tiptap StarterKit doesn't ship tables in this
 * project's setup). Entity links degrade to their resolved labels.
 *
 * The `docx` library is heavy (~600 KB) so we keep this file lazy-loaded
 * by the facade.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  type IParagraphOptions,
} from 'docx';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { BookInput, ExportContext, ExportResult, FormatWriter } from './types';

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
}

function collectInlineRuns(node: PMNode, ctx: ExportContext): InlineRun[] {
  const runs: InlineRun[] = [];
  node.descendants((child) => {
    if (!child.isText) return true;
    const marks = child.marks;
    const run: InlineRun = { text: child.text ?? '' };
    for (const m of marks) {
      if (m.type.name === 'bold') run.bold = true;
      else if (m.type.name === 'italic') run.italics = true;
      else if (m.type.name === 'underline') run.underline = true;
      else if (m.type.name === 'strike') run.strike = true;
      else if (m.type.name === 'entityLink' || m.type.name === 'link') {
        // Treat as plain — DOCX hyperlinks would need a relationship part,
        // which adds complexity without obvious value for offline drafts.
        const targetKind = m.attrs?.targetKind;
        const targetId = m.attrs?.targetId;
        if (targetKind && targetId && ctx.resolveLabel) {
          run.text = ctx.resolveLabel(targetKind, targetId);
        }
      }
    }
    runs.push(run);
    return false; // text node has no children
  });
  return runs;
}

function runsToTextRuns(runs: InlineRun[]): TextRun[] {
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italics,
        underline: r.underline ? {} : undefined,
        strike: r.strike,
      }),
  );
}

// We build "paragraph specs" first so wrapping blocks (blockquote, list)
// can decorate each child with extra options (indent, bullet, numbering)
// without us having to inspect a constructed Paragraph after the fact —
// `Paragraph` doesn't expose its options publicly.
type ParaSpec = Omit<IParagraphOptions, 'children'> & { children: TextRun[] };

function blockToSpecs(node: PMNode, ctx: ExportContext, listDepth = 0): ParaSpec[] {
  const t = node.type.name;
  switch (t) {
    case 'paragraph': {
      const attrs = node.attrs as { textAlign?: string } | null;
      return [
        {
          alignment: mapAlign(attrs?.textAlign),
          children: runsToTextRuns(collectInlineRuns(node, ctx)),
        },
      ];
    }
    case 'heading': {
      const attrs = node.attrs as { level?: number } | null;
      const level = Math.max(1, Math.min(6, Number(attrs?.level) || 1));
      const headingLevel = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ][level - 1];
      return [
        {
          heading: headingLevel,
          children: runsToTextRuns(collectInlineRuns(node, ctx)),
        },
      ];
    }
    case 'blockquote': {
      const out: ParaSpec[] = [];
      node.forEach((child) => {
        for (const spec of blockToSpecs(child, ctx, listDepth)) {
          out.push({ ...spec, indent: { left: 720 } });
        }
      });
      return out;
    }
    case 'bulletList': {
      const out: ParaSpec[] = [];
      node.forEach((item) => {
        item.forEach((inner) => {
          for (const spec of blockToSpecs(inner, ctx, listDepth + 1)) {
            out.push({ ...spec, bullet: { level: listDepth } });
          }
        });
      });
      return out;
    }
    case 'orderedList': {
      const out: ParaSpec[] = [];
      node.forEach((item) => {
        item.forEach((inner) => {
          for (const spec of blockToSpecs(inner, ctx, listDepth + 1)) {
            out.push({ ...spec, numbering: { reference: 'ordered', level: listDepth } });
          }
        });
      });
      return out;
    }
    case 'codeBlock': {
      const text = node.textContent;
      return text.split('\n').map((line) => ({
        children: [new TextRun({ text: line, font: 'JetBrains Mono' })],
      }));
    }
    case 'horizontalRule':
      return [{ children: [new TextRun('────────')] }];
    default: {
      const out: ParaSpec[] = [];
      node.forEach((child) => out.push(...blockToSpecs(child, ctx, listDepth)));
      return out;
    }
  }
}

function blockToParagraphs(node: PMNode, ctx: ExportContext): Paragraph[] {
  return blockToSpecs(node, ctx).map((spec) => new Paragraph(spec));
}

function mapAlign(textAlign: string | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (textAlign) {
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
      return AlignmentType.RIGHT;
    case 'justify':
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

// ImageRun is imported for completeness even though the StarterKit setup
// in this project doesn't render images yet. Re-export keeps tree-shake
// happy if we add image support later.
export const _docxRuntime = { ImageRun };

export const writeDocx: FormatWriter = async (
  book: BookInput,
  ctx: ExportContext,
): Promise<ExportResult> => {
  const children: Paragraph[] = [];

  // Title page.
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: book.title, bold: true, size: 48 })],
    }),
  );
  if (book.author) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: book.author, italics: true, size: 24 })],
      }),
    );
  }
  children.push(new Paragraph({ children: [new TextRun('')] }));

  for (const chapter of book.chapters) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        children: [new TextRun({ text: chapter.title, bold: true })],
      }),
    );
    for (const p of blockToParagraphs(chapter.doc, ctx)) children.push(p);
  }

  const doc = new Document({
    creator: book.author ?? 'Drifting',
    title: book.title,
    description: 'Generated by Drifting',
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBlob(doc);
  return {
    blob: buffer,
    filename: `${sanitizeFilename(book.title)}.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
};
