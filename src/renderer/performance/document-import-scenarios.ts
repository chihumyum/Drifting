import JSZip from 'jszip';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { parseDocx } from '../services/import/docx';
import { parseMarkdown, parseTxt } from '../services/import/markdown';

/** Real importers and editor schema, entirely synthetic source documents. */
export async function runDocumentImportScenarios() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>合成章节</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>正文 &amp; 安全导入</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  const docx = await parseDocx(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'synthetic.docx'));
  const markdown = await parseMarkdown(new File(['# 合成章节\n\n**正文 & 安全导入**'], 'synthetic.md'));
  const text = await parseTxt(new File(['第一段\n换行\n\n第二段'], 'synthetic.txt'));
  const hasMark = (node: JSONContent, type: string): boolean => Boolean(node.marks?.some(mark => mark.type === type) || node.content?.some(child => hasMark(child, type)));
  let corruptRejected = false;
  try { await parseDocx(new File(['synthetic invalid zip'], 'broken.docx')); } catch { corruptRejected = true; }
  const checks = {
    docxTitleAndUnicode: docx.guessedTitle === '合成章节' && JSON.stringify(docx.doc).includes('正文 & 安全导入'),
    docxBold: hasMark(docx.doc, 'bold'),
    markdownHeadingAndBold: markdown.doc.content?.[0]?.type === 'heading' && hasMark(markdown.doc, 'bold'),
    plainTextParagraphsAndBreaks: text.doc.content?.length === 2 && text.doc.content[0].content?.some(node => node.type === 'hardBreak'),
    corruptDocxRejected: corruptRejected,
    importedEditorUndoRedo: true,
  };
  for (const parsed of [docx, markdown, text]) {
    const editor = new Editor({ extensions: [StarterKit], content: parsed.doc });
    try {
      const before = JSON.stringify(editor.getJSON());
      editor.commands.insertContent(' synthetic edit');
      const after = JSON.stringify(editor.getJSON());
      checks.importedEditorUndoRedo &&= before !== after && editor.commands.undo() && JSON.stringify(editor.getJSON()) === before
        && editor.commands.redo() && JSON.stringify(editor.getJSON()) === after;
    } finally { editor.destroy(); }
  }
  if (!Object.values(checks).every(Boolean)) throw new Error(`Document import regression: ${JSON.stringify(checks)}`);
  return { checks, fixtures: 'Synthetic minimal DOCX, Markdown, plain text and corrupt ZIP; no native file picker or author documents.' };
}
