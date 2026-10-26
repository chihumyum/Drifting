import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';

import { useEntityYjsDoc } from '../hooks/useEntityYjsDoc';
import { useEntityEditor, type EditorPersistDerived } from '../hooks/useEntityEditor';
import { useLibraryItem } from '../usecase/useLibraryItem';
import { useDataStore } from '../store/data-store';
import { editorTabSelectionKey } from '../lib/editor-selection-memory';
import { noteOnlyExtensions } from '../lib/editor-schema-profile';
import type { SlashMenuExtraItem } from '../lib/slash-menu/default-slash-menu';
import type { LibraryItem } from '../domain/library-item';
import { platform } from '../platform';
import { EditorDocumentLoadError } from '../components/editor/EditorDocumentLoadError';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../components/ui/Modal';
import { MaterialEmbedWithView } from '../features/library/MaterialEmbedView';
import { NoteFileImport } from '../lib/extensions/note-blocks';
import { useStoredLibraryItemVariant } from '../features/library/library-item-media';
import { taskItemAtSelection, useNoteTodoLinks } from './note-todo-links';

const log = loglevel.getLogger('MaterialNotePage');
log.setLevel(loglevel.levels.ERROR);

interface MaterialNotePageProps {
  item: LibraryItem;
  projectId: string;
  userId: string;
  header: ReactNode;
  /** Called on the first authored edit so a preview tab becomes a pinned tab. */
  onAuthoredEdit: () => void;
  onReadyChange: (ready: boolean) => void;
}

/**
 * A note's page: its Yjs document edited with the `note` profile (lists,
 * tasks, tables, code, callouts, embedded materials). The body column is a
 * projection kept for the library list, search and export.
 */
export function MaterialNotePage({
  item,
  projectId,
  userId,
  header,
  onAuthoredEdit,
  onReadyChange,
}: MaterialNotePageProps) {
  const { t } = useTranslation();
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const [embedPickerEditor, setEmbedPickerEditor] = useState<Editor | null>(null);

  const { ydoc, ydocError } = useEntityYjsDoc({
    kind: 'library-item',
    entityId: item.id,
    projectId,
    seedContentJson: item.bodyJson,
  });

  const bodyJson = item.kind === 'text' ? item.bodyJson : null;
  const handlePersist = useCallback(
    (_editor: Editor, { pmJson }: EditorPersistDerived) => {
      if (pmJson === bodyJson) return;
      onAuthoredEdit();
      void libraryItemUsecases.projectNoteBody(item.id, pmJson).catch((error: unknown) => {
        log.error('Failed to project note body:', error);
      });
    },
    [bodyJson, item.id, libraryItemUsecases, onAuthoredEdit],
  );

  const slashItems = useMemo<SlashMenuExtraItem[]>(
    () => [
      { id: 'bullet-list', title: t('materialEditor.slash.bulletList'), run: ({ editor }) => editor.chain().focus().toggleBulletList().run() },
      { id: 'ordered-list', title: t('materialEditor.slash.orderedList'), run: ({ editor }) => editor.chain().focus().toggleOrderedList().run() },
      { id: 'task-list', title: t('materialEditor.slash.taskList'), run: ({ editor }) => editor.chain().focus().toggleTaskList().run() },
      { id: 'table', title: t('materialEditor.slash.table'), run: ({ editor }) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { id: 'code-block', title: t('materialEditor.slash.codeBlock'), run: ({ editor }) => editor.chain().focus().toggleCodeBlock().run() },
      { id: 'callout', title: t('materialEditor.slash.callout'), run: ({ editor }) => editor.chain().focus().toggleCallout().run() },
      { id: 'highlight', title: t('materialEditor.slash.highlight'), run: ({ editor }) => editor.chain().focus().toggleHighlight().run() },
      { id: 'material', title: t('materialEditor.slash.material'), run: ({ editor }) => setEmbedPickerEditor(editor) },
    ],
    [t],
  );
  // Pasted or dropped images/PDFs become materials, embedded where they landed.
  const editorRef = useRef<Editor | null>(null);
  const importFiles = useCallback(
    async (files: File[], position: number) => {
      for (const file of files) {
        try {
          const staged = await platform.material.stageImportBytes(await file.arrayBuffer(), file.name || 'pasted');
          if (!staged.ok) {
            if (!staged.canceled) log.error('Failed to stage pasted file:', staged.error);
            continue;
          }
          const kind = file.type === 'application/pdf' ? 'pdf' : 'image';
          const created = await libraryItemUsecases.createLibraryItem({
            kind,
            title: file.name || t(kind === 'pdf' ? 'materialEditor.embed.pastedPdf' : 'materialEditor.embed.pastedImage'),
            sourcePath: staged.filePath,
          });
          const editor = editorRef.current;
          if (!editor || editor.isDestroyed) continue;
          const at = Math.min(position, editor.state.doc.content.size);
          editor.chain().insertContentAt(at, { type: 'materialEmbed', attrs: { libraryItemId: created.id } }).run();
        } catch (error) {
          log.error('Failed to import pasted file:', error);
        }
      }
    },
    [libraryItemUsecases, t],
  );
  const importFilesRef = useRef(importFiles);
  useEffect(() => {
    importFilesRef.current = importFiles;
  }, [importFiles]);
  const noteExtensions = useMemo(
    () => [
      ...noteOnlyExtensions({ materialEmbed: MaterialEmbedWithView }),
      // ProseMirror calls this later, outside React render; it reads the latest
      // handler through the ref, as useEntityEditor's own callbacks do.
      // eslint-disable-next-line react-hooks/refs
      NoteFileImport.configure({ onFiles: (files, position) => void importFilesRef.current(files, position) }),
    ],
    [],
  );

  const { editor, ready } = useEntityEditor({
    sourceKind: 'library_item',
    sourceId: item.id,
    projectId,
    content: bodyJson,
    documentMode: 'yjs',
    ydoc,
    onPersist: handlePersist,
    placeholder: t('materialEditor.notePlaceholder'),
    editorClass: 'prose max-w-none focus:outline-none note-prose',
    slashExtraItems: slashItems,
    selectionKey: editorTabSelectionKey(projectId, { entityType: 'library_item', id: item.id }),
    editable: Boolean(ydoc),
    profile: 'note',
    noteExtensions,
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const { promoteTaskItem, unlinkTaskItem } = useNoteTodoLinks({ editor, noteId: item.id, projectId, userId });

  useEffect(() => {
    onReadyChange(ready || Boolean(ydocError));
    return () => onReadyChange(false);
  }, [onReadyChange, ready, ydocError]);

  return (
    <div className="editor-scroll">
      <div className="editor__spread">
        <article className="page page--entity material-editor__note-page">
          {header}
          {editor && <NoteTableBar editor={editor} />}
          {editor && <NoteTaskBar editor={editor} onPromote={() => void promoteTaskItem().catch((error: unknown) => log.error('Failed to link TODO:', error))} onUnlink={unlinkTaskItem} />}
          <div className="material-editor__note-body">
            {ydocError ? <EditorDocumentLoadError /> : <EditorContent editor={editor} />}
          </div>
        </article>
      </div>
      {embedPickerEditor && (
        <MaterialEmbedPicker
          projectId={projectId}
          userId={userId}
          onClose={() => setEmbedPickerEditor(null)}
          onPick={(libraryItemId) => {
            embedPickerEditor.chain().focus().insertMaterialEmbed(libraryItemId).run();
            setEmbedPickerEditor(null);
          }}
        />
      )}
    </div>
  );
}

/** Row/column controls while the caret is inside a table. */
function NoteTableBar({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const inTable = useEditorState({ editor, selector: ({ editor: current }) => current?.isActive('table') ?? false });
  if (!inTable) return null;
  const action = (label: string, run: () => boolean) => (
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run()}>
      {label}
    </button>
  );
  return (
    <div className="note-table-bar" role="toolbar" aria-label={t('materialEditor.table.toolbar')}>
      {action(t('materialEditor.table.addRow'), () => editor.chain().focus().addRowAfter().run())}
      {action(t('materialEditor.table.addColumn'), () => editor.chain().focus().addColumnAfter().run())}
      {action(t('materialEditor.table.deleteRow'), () => editor.chain().focus().deleteRow().run())}
      {action(t('materialEditor.table.deleteColumn'), () => editor.chain().focus().deleteColumn().run())}
      {action(t('materialEditor.table.headerRow'), () => editor.chain().focus().toggleHeaderRow().run())}
      {action(t('materialEditor.table.deleteTable'), () => editor.chain().focus().deleteTable().run())}
    </div>
  );
}

/** Links the task item at the caret to a TODO, or shows that it is linked. */
function NoteTaskBar({ editor, onPromote, onUnlink }: { editor: Editor; onPromote: () => void; onUnlink: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null;
      const found = taskItemAtSelection(current);
      if (!found) return null;
      return { linked: typeof found.node.attrs.todoId === 'string', empty: !found.node.textContent.trim() };
    },
  });
  if (!state) return null;
  return (
    <div className="note-table-bar note-task-bar" role="toolbar" aria-label={t('materialEditor.todo.toolbar')}>
      {state.linked ? (
        <>
          <span className="note-task-bar__status">{t('materialEditor.todo.linked')}</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onUnlink}>
            {t('materialEditor.todo.unlink')}
          </button>
        </>
      ) : (
        <button type="button" disabled={state.empty} onMouseDown={(event) => event.preventDefault()} onClick={onPromote}>
          {t('materialEditor.todo.promote')}
        </button>
      )}
    </div>
  );
}

/**
 * Picks an image or PDF to embed. Importing a new file creates an ordinary
 * material first, so the note only ever holds a reference.
 */
function MaterialEmbedPicker({
  projectId,
  userId,
  onClose,
  onPick,
}: {
  projectId: string;
  userId: string;
  onClose: () => void;
  onPick: (libraryItemId: string) => void;
}) {
  const { t } = useTranslation();
  const libraryItems = useDataStore((state) => state.libraryItems);
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const media = libraryItems.filter((candidate) => candidate.kind === 'image' || candidate.kind === 'pdf');

  const importFile = async () => {
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      const picked = await platform.material.pickFile('any');
      if (!picked.ok) {
        if (!picked.canceled) setError(picked.error);
        return;
      }
      const name = picked.filePath.split(/[\\/]/).pop() ?? '';
      const kind = /\.pdf$/iu.test(name) ? 'pdf' : 'image';
      const created = await libraryItemUsecases.createLibraryItem({ kind, title: name, sourcePath: picked.filePath });
      onPick(created.id);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ModalRoot onClose={onClose} ariaLabel={t('materialEditor.embed.pickerTitle')}>
      <ModalCard width="min(560px, 92vw)">
        <ModalHeader title={t('materialEditor.embed.pickerTitle')} onClose={onClose} closeLabel={t('common.close')} />
        <ModalBody>
          <div className="note-embed-picker">
            <button type="button" className="note-embed-picker__import" disabled={importing} onClick={() => void importFile()}>
              {importing ? t('materialEditor.embed.importing') : t('materialEditor.embed.importFile')}
            </button>
            {error && <div className="note-embed-picker__error">{error}</div>}
            {media.length === 0 ? (
              <div className="note-embed-picker__empty">{t('materialEditor.embed.empty')}</div>
            ) : (
              <div className="note-embed-picker__grid">
                {media.map((candidate) => (
                  <EmbedPickerTile key={candidate.id} item={candidate} onPick={() => onPick(candidate.id)} />
                ))}
              </div>
            )}
          </div>
        </ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}

function EmbedPickerTile({ item, onPick }: { item: LibraryItem; onPick: () => void }) {
  const { t } = useTranslation();
  const thumbnail = useStoredLibraryItemVariant(item, 'thumbnail');
  return (
    <button type="button" className="note-embed-picker__tile" onClick={onPick}>
      {thumbnail.fileUrl ? <img src={thumbnail.fileUrl} alt="" draggable={false} /> : <span>{t(`memoMaterial.kind.${item.kind}`)}</span>}
      <span className="note-embed-picker__tile-title">{item.title || t('common.untitled')}</span>
    </button>
  );
}
