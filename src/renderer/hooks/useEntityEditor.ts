import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import Collaboration from '@tiptap/extension-collaboration';
import type * as Y from 'yjs';
import loglevel from 'loglevel';

import { extractOutline, type OutlineItem } from '../lib/outline';
import { BlockId, isBlockType } from '../lib/extensions/block-id';
import {
  EntityLink,
  entityLinkConfig,
  type AutoDetectTarget,
  type EntityKind,
  type EntityLinkRef,
} from '../lib/extensions/entity-link';
import {
  EntityMentionSuggestion,
  type MentionableEntity,
} from '../lib/extensions/entity-mention-suggestion';
import { createDefaultSlashMenu, type SlashMenuExtraItem } from '../lib/slash-menu';
import { projectInlineMentionsFromDoc } from '../services/reference-projection.service';
import { exportDocToMarkdown } from '../services/markdown-export.service';
import { createInlineMentionRepository } from '../sqlite-repo/inline-mention-repo';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { useAuthStore } from '../store/auth';
import { useBookElement } from '../usecase/useBookElement';
import { useProjectNavigation } from './useProjectNavigation';
import { useRegisterActiveEditor } from './useRegisterActiveEditor';
import { events } from '../lib/events';
import {
  getEditorSelectionSnapshot,
  hasEditorSelectionSnapshot,
  moveEditorSelectionToStart,
  restoreEditorSelectionSnapshot,
  saveEditorSelectionSnapshot,
} from '../lib/editor-selection-memory';
import type { CommentTargetKind } from '../domain/manuscript-comment';

const log = loglevel.getLogger('useEntityEditor');
log.setLevel(loglevel.levels.WARN);

const DEFAULT_DOC: JSONContent = { type: 'doc', content: [] };
const COMMENT_CONTEXT_MENU_CLASS = 'editor-comment-menu';

export interface EditorCommentRequest {
  projectId: string;
  sourceKind: CommentTargetKind;
  sourceId: string;
  targetBlockId: string;
  selectedText: string;
  anchorJson: string;
  clientX: number;
  clientY: number;
}

// Replace editor content with a transaction marked `addToHistory: false` so
// the initial load doesn't enter the undo stack. Without this, Cmd+Z all the
// way back tries to revert to a pre-seed empty doc, which fails the `doc`
// schema's `content: 'block+'` constraint and raises "Invalid content".
function loadDocWithoutHistory(editor: Editor, json: JSONContent): void {
  const docNode = PMNode.fromJSON(editor.schema, json);
  const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, docNode.content);
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

function parseContentJson(content: string | null): JSONContent {
  if (!content) return DEFAULT_DOC;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.type === 'doc' && Array.isArray(parsed.content)) {
      return parsed as JSONContent;
    }
  } catch (error) {
    log.warn('Failed to parse content JSON, falling back to empty doc:', error);
  }
  return DEFAULT_DOC;
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function isCommentTargetKind(kind: EntityKind): kind is CommentTargetKind {
  return kind === 'node' || kind === 'element' || kind === 'storyline' || kind === 'category' || kind === 'patch';
}

function removeCommentContextMenu(): void {
  document.querySelectorAll(`.${COMMENT_CONTEXT_MENU_CLASS}`).forEach((node) => node.remove());
}

function findSelectionBlockId(state: EditorState): string | null {
  const resolved = state.doc.resolve(state.selection.from);
  for (let depth = resolved.depth; depth >= 0; depth--) {
    const node = resolved.node(depth);
    if (!isBlockType(node.type.name)) continue;
    const id = node.attrs?.id as string | null | undefined;
    if (id) return id;
  }
  return null;
}

function openCommentContextMenu(
  request: EditorCommentRequest,
  onAddCommentRequest: (request: EditorCommentRequest) => void,
): void {
  removeCommentContextMenu();
  const menu = document.createElement('div');
  menu.className = COMMENT_CONTEXT_MENU_CLASS;
  menu.style.left = `${request.clientX}px`;
  menu.style.top = `${request.clientY}px`;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '添加批注';
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    removeCommentContextMenu();
    onAddCommentRequest(request);
  });
  menu.appendChild(button);
  document.body.appendChild(menu);

  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) {
      removeCommentContextMenu();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

export interface UseEntityEditorConfig {
  // What this editor is editing — drives projection direction and self-exclusion.
  sourceKind: EntityKind;
  sourceId: string;
  projectId: string;

  // Initial document JSON string from the persisted row. Null = empty doc.
  // Ignored when `ydoc` is provided — Collaboration extension owns content.
  content: string | null;

  // Optional Y.Doc backing this editor. When set, the Collaboration extension
  // binds Tiptap directly to ydoc's default fragment, replacing the legacy
  // content-string load path. The caller is responsible for wiring sync via
  // useYjsSync. The hook still calls onPersist after each edit so chapter
  // word-count / outline derivation continues to work.
  ydoc?: Y.Doc;

  // Fired after every persistable edit. Receives the Editor instance so the
  // caller can derive whatever they need (pmJson, outline, wordCount, etc.).
  onPersist: (editor: Editor) => void;

  // Optional slash menu items beyond the defaults. The `导出 Markdown` item
  // is provided automatically unless `enableMarkdownExport: false`.
  slashExtraItems?: SlashMenuExtraItem[];
  enableMarkdownExport?: boolean;

  // Editor click on an entity-link mark. Defaults to navigation by targetKind.
  onEntityClick?: (ref: EntityLinkRef) => void;

  // Surface options
  autoFocus?: boolean;
  placeholder?: string;
  editorClass?: string;
  minHeight?: string;

  // Optional top-level tab selection key. Popovers / virtualized editors leave
  // this unset so their transient caret positions don't focus newly-opened tabs.
  selectionKey?: string | null;

  // Optional Word-style comment creation entry. The hook only detects the
  // selected block and selected text; persistence/UI lives above it.
  onAddCommentRequest?: (request: EditorCommentRequest) => void;
}

export interface UseEntityEditorResult {
  editor: Editor | null;
  // Live outline derived from the editor's current doc (h1/h2/h3 nodes).
  // Updates on every edit and once on load. Empty array before the editor
  // mounts or when the doc has no headings.
  outline: OutlineItem[];
}

// Single shared hook backing all entity rich-text editors:
//   ChapterEditor, ElementEditorView, PatchEditorCard, CategoryEditorView,
//   StorylineEditorView.
//
// Encapsulates:
//   • the full extension set (StarterKit + Underline + Link + TextAlign
//     + BlockId + EntityLink + EntityMentionSuggestion + SlashMenu
//     + optional Placeholder),
//   • the load pipeline (loadDocWithoutHistory + (editor, sourceId) token
//     sentinel so a useEditor rebuild forces a reload),
//   • the persist pipeline (onUpdate dispatches projection + onPersist),
//   • the entity-link config sync (auto-detect map + enabled flag),
//   • the @-picker (mentionable entities and "+ create element" affordance),
//   • the default `/导出 Markdown` slash item,
//   • the active-editor registry hookup (Cmd+S, Cmd+F bindings).
export function useEntityEditor(config: UseEntityEditorConfig): UseEntityEditorResult {
  const {
    sourceKind,
    sourceId,
    projectId,
    content,
    ydoc,
    onPersist,
    slashExtraItems,
    enableMarkdownExport = true,
    onEntityClick,
    autoFocus,
    placeholder,
    editorClass,
    minHeight,
    selectionKey,
    onAddCommentRequest,
  } = config;

  const sourceRef = useLatestRef({ projectId, sourceKind, sourceId });
  const onPersistRef = useLatestRef(onPersist);
  const slashExtraItemsRef = useLatestRef(slashExtraItems);
  const enableMarkdownExportRef = useLatestRef(enableMarkdownExport);
  const onEntityClickRef = useLatestRef(onEntityClick);
  const selectionKeyRef = useLatestRef(selectionKey ?? null);
  const onAddCommentRequestRef = useLatestRef(onAddCommentRequest);

  const userId = useAuthStore((state) => state.user?.id);
  const editorUndoDepth = useSettingsStore((state) => state.editorUndoDepth);
  const autoElementLinkEnabled = useSettingsStore((state) => state.autoElementLinkEnabled);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);

  const bookElements = useDataStore((state) => state.bookElements);
  const bookNodes = useDataStore((state) => state.bookNodes);

  // Auto-detect: every element name and every chapter title, minus self.
  // Built fresh whenever the entity lists change so plugin config sync below
  // picks up the new map.
  const autoDetectTargets = useMemo(() => {
    const map = new Map<string, AutoDetectTarget>();
    bookElements.forEach((el) => {
      if (sourceKind === 'element' && el.id === sourceId) return;
      if (!el.name) return;
      map.set(el.name, { kind: 'element', id: el.id });
    });
    bookNodes.forEach((n) => {
      if (sourceKind === 'node' && n.id === sourceId) return;
      if (!n.title) return;
      map.set(n.title, { kind: 'node', id: n.id });
    });
    return map;
  }, [bookElements, bookNodes, sourceKind, sourceId]);

  // @-picker source: pulled live from the store so the popover stays in sync.
  const getMentionableEntities = useCallback((): MentionableEntity[] => {
    const state = useDataStore.getState();
    const { sourceKind: currentSourceKind, sourceId: currentSourceId } = sourceRef.current;
    const elements: MentionableEntity[] = state.bookElements
      .filter((el) => !(currentSourceKind === 'element' && el.id === currentSourceId))
      .map((el) => ({ kind: 'element', id: el.id, name: el.name }));
    const nodes: MentionableEntity[] = state.bookNodes
      .filter((n) => !(currentSourceKind === 'node' && n.id === currentSourceId))
      .map((n) => ({ kind: 'node', id: n.id, name: n.title }));
    return [...elements, ...nodes];
  }, [sourceRef]);

  // "+ create element" from picker
  const elementUsecases = useBookElement({ projectId, userId: userId ?? '' });
  const createElement = elementUsecases.createElement;
  const createElementRef = useLatestRef(createElement);
  const handleCreateElementFromPicker = useCallback(
    async (name: string): Promise<{ id: string; name: string } | null> => {
      const categoryId = useDataStore.getState().bookElementCategories[0]?.id;
      if (!categoryId) {
        log.warn('Cannot create element from picker — project has no element categories');
        return null;
      }
      try {
        const created = await createElementRef.current({ categoryId, name });
        return created ? { id: created.id, name: created.name } : null;
      } catch (error) {
        log.error('Failed to create element from picker:', error);
        return null;
      }
    },
    [createElementRef],
  );

  // Default click handler: navigate by target kind. Caller can override.
  const navigation = useProjectNavigation();
  const navigateToElement = navigation.navigateToElement;
  const navigateToNode = navigation.navigateToNode;
  const navigateToStoryline = navigation.navigateToStoryline;
  const navigateToCategory = navigation.navigateToCategory;
  const navigationRef = useLatestRef({
    navigateToElement,
    navigateToNode,
    navigateToStoryline,
    navigateToCategory,
  });
  const handleEntityClick = useCallback(
    (ref: EntityLinkRef) => {
      const override = onEntityClickRef.current;
      if (override) {
        override(ref);
        return;
      }
      const nav = navigationRef.current;
      if (ref.targetKind === 'element') nav.navigateToElement(ref.targetId);
      else if (ref.targetKind === 'node') nav.navigateToNode(ref.targetId);
      else if (ref.targetKind === 'storyline') nav.navigateToStoryline(ref.targetId);
      else if (ref.targetKind === 'category') nav.navigateToCategory(ref.targetId);
      // patch: no default destination yet.
    },
    [navigationRef, onEntityClickRef],
  );

  // Projection: walk the doc, derive inline mentions, replace this source's
  // rows. Debounced so a typing burst writes once.
  const mentionRepoRef = useRef(createInlineMentionRepository());
  const projectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const projectReferences = useCallback(
    (editor: Editor) => {
      if (projectTimeoutRef.current) clearTimeout(projectTimeoutRef.current);
      const source = sourceRef.current;
      if (!source.projectId || !source.sourceId) return;
      if (editor.isDestroyed) return;
      const drafts = projectInlineMentionsFromDoc(editor.state.doc);
      projectTimeoutRef.current = setTimeout(async () => {
        try {
          await mentionRepoRef.current.replaceMentionsFromSource(
            source.projectId,
            source.sourceKind,
            source.sourceId,
            drafts,
          );
          events.emit('references:changed', {
            projectId: source.projectId,
            fromKind: source.sourceKind,
            fromId: source.sourceId,
            targetKeys: drafts.map((draft) => `${draft.toKind}:${draft.toId}`),
          });
        } catch (error) {
          log.error('Failed to project inline references:', error);
        }
      }, 500);
    },
    [sourceRef],
  );

  useEffect(
    () => () => {
      if (projectTimeoutRef.current) clearTimeout(projectTimeoutRef.current);
    },
    [],
  );

  // (editor instance, sourceId) sentinel — see ChapterEditor history for the
  // bug this guards against (useEditor rebuilds yielding a fresh empty
  // editor that would otherwise pass the "already loaded" check and save
  // its empty doc on the next keystroke).
  const loadedTokenRef = useRef<{
    editor: Editor | null;
    projectId: string | null;
    sourceKind: EntityKind | null;
    sourceId: string | null;
  }>({
    editor: null,
    projectId: null,
    sourceKind: null,
    sourceId: null,
  });
  const suppressSelectionSaveRef = useRef(false);

  // Live outline derived from the editor doc. Recomputed on every update and
  // once on load. Cheap because we already have the JSON in hand; if this
  // turns up in a profile, switch to walking the PMNode directly.
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const recomputeOutline = useCallback((editor: Editor) => {
    if (editor.isDestroyed) return;
    try {
      const pmJson = JSON.stringify(editor.getJSON());
      setOutline(extractOutline(pmJson));
    } catch (error) {
      log.warn('Failed to recompute outline:', error);
    }
  }, []);

  // Persistence wrapper: runs projection + outline refresh + caller's onPersist.
  // All gated by the (editor, sourceId) token to avoid initial-load round-trips.
  const persistEditorContent = useCallback(
    (editor: Editor) => {
      projectReferences(editor);
      recomputeOutline(editor);
      onPersistRef.current(editor);
    },
    [onPersistRef, projectReferences, recomputeOutline],
  );

  const saveSelection = useCallback(
    (ed: Editor, options?: { force?: boolean }) => {
      const key = selectionKeyRef.current;
      if (!key || ed.isDestroyed) return;
      if (suppressSelectionSaveRef.current) return;
      const source = sourceRef.current;
      if (
        loadedTokenRef.current.editor !== ed ||
        loadedTokenRef.current.projectId !== source.projectId ||
        loadedTokenRef.current.sourceKind !== source.sourceKind ||
        loadedTokenRef.current.sourceId !== source.sourceId
      ) {
        return;
      }
      if (!options?.force && !ed.isFocused && !hasEditorSelectionSnapshot(key)) return;
      saveEditorSelectionSnapshot(key, ed, true);
    },
    [selectionKeyRef, sourceRef],
  );

  const getSlashItems = useCallback((): SlashMenuExtraItem[] => {
    const items: SlashMenuExtraItem[] = [];
    if (enableMarkdownExportRef.current) {
      items.push({
        id: 'export-md',
        title: '导出 Markdown',
        run: ({ editor }) => {
          const state = useDataStore.getState();
          const md = exportDocToMarkdown(editor.state.doc, {
            resolveLabel: (kind, id) => {
              if (kind === 'element')
                return state.bookElements.find((e) => e.id === id)?.name ?? '';
              if (kind === 'node')
                return state.bookNodes.find((n) => n.id === id)?.title ?? '';
              return '';
            },
          });
          void navigator.clipboard.writeText(md).catch((error) => {
            log.error('Failed to copy markdown to clipboard:', error);
          });
        },
      });
    }
    const extraItems = slashExtraItemsRef.current;
    if (extraItems) items.push(...extraItems);
    return items;
  }, [enableMarkdownExportRef, slashExtraItemsRef]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          bulletList: { keepMarks: true },
          orderedList: { keepMarks: true },
          codeBlock: {},
          // Collaboration ships its own y-undo manager; if StarterKit's
          // undoRedo is left on alongside it, ProseMirror's history plugin
          // collides with the Yjs binding and crashes on first edit.
          undoRedo: ydoc ? false : { depth: editorUndoDepth },
          underline: false,
          link: false,
        }),
        Underline,
        Link.configure({ openOnClick: false, autolink: true }),
        TextAlign.configure({
          types: ['heading', 'paragraph'],
          alignments: ['left', 'center', 'right'],
          defaultAlignment: 'left',
        }),
        ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
        // Collaboration must come AFTER StarterKit so it can swap the doc
        // contents. The default fragment name 'default' matches the one the
        // double-write hook in useYjsSync serializes from.
        ...(ydoc ? [Collaboration.configure({ document: ydoc, field: 'default' })] : []),
        BlockId,
        // These callbacks are registered with ProseMirror and execute later,
        // outside React render. They intentionally read latest-value refs.
        // eslint-disable-next-line react-hooks/refs
        EntityLink.configure({
          autoDetectTargets,
          autoDetectEnabled: autoElementLinkEnabled,
          onClick: handleEntityClick,
        }),
        // eslint-disable-next-line react-hooks/refs
        EntityMentionSuggestion.configure({
          getEntities: getMentionableEntities,
          onCreateElement: handleCreateElementFromPicker,
        }),
        // eslint-disable-next-line react-hooks/refs
        createDefaultSlashMenu({ extraItems: getSlashItems }),
      ],
      content: null,
      autofocus: autoFocus ? 'end' : false,
      editable: true,
      editorProps: {
        attributes: {
          class: editorClass ?? 'prose max-w-none focus:outline-none',
          style: minHeight ? `min-height: ${minHeight}` : '',
          spellcheck: 'false',
        },
        handleDOMEvents: {
          contextmenu: (view, event) => {
            const handler = onAddCommentRequestRef.current;
            if (!handler) return false;
            const source = sourceRef.current;
            if (!source.projectId || !source.sourceId || !isCommentTargetKind(source.sourceKind)) {
              return false;
            }
            const { selection } = view.state;
            if (selection.empty) return false;
            const selectedText = view.state.doc
              .textBetween(selection.from, selection.to, '\n')
              .trim();
            if (!selectedText) return false;
            const targetBlockId = findSelectionBlockId(view.state);
            if (!targetBlockId) return false;

            event.preventDefault();
            event.stopPropagation();
            const request: EditorCommentRequest = {
              projectId: source.projectId,
              sourceKind: source.sourceKind,
              sourceId: source.sourceId,
              targetBlockId,
              selectedText,
              anchorJson: JSON.stringify({
                selectedText,
                selectionFrom: selection.from,
                selectionTo: selection.to,
                createdAt: new Date().toISOString(),
              }),
              clientX: event.clientX,
              clientY: event.clientY,
            };
            openCommentContextMenu(request, handler);
            return true;
          },
        },
      },
      onUpdate: ({ editor: ed }) => {
        const source = sourceRef.current;
        if (!source.sourceId) return;
        // Persist only after this exact editor instance has loaded the
        // current sourceId. Token mismatch happens on freshly-rebuilt editors
        // before the load effect has run — saving then would clobber the row.
        if (
          loadedTokenRef.current.editor !== ed ||
          loadedTokenRef.current.projectId !== source.projectId ||
          loadedTokenRef.current.sourceKind !== source.sourceKind ||
          loadedTokenRef.current.sourceId !== source.sourceId
        ) {
          return;
        }
        persistEditorContent(ed);
        saveSelection(ed);
      },
      onSelectionUpdate: ({ editor: ed }) => {
        saveSelection(ed);
      },
      onBlur: ({ editor: ed }) => {
        saveSelection(ed, { force: true });
      },
    },
    [
      editorUndoDepth,
      placeholder,
      autoFocus,
      editorClass,
      minHeight,
      saveSelection,
    ],
  );

  // Keep the entity-link plugin's mutable config in sync with the latest
  // settings + entity list so auto-detect reacts without rebuilding the editor.
  useEffect(() => {
    entityLinkConfig.autoDetectEnabled = autoElementLinkEnabled;
    entityLinkConfig.autoDetectTargets = autoDetectTargets;
    entityLinkConfig.interactionEnabled = entityLinkInteractive;
  }, [autoElementLinkEnabled, autoDetectTargets, entityLinkInteractive]);

  // Load content into the editor whenever the (editor instance, sourceId)
  // pair changes. Don't depend on `content` — that would re-load on every
  // save round-trip and reset the cursor. Source-of-truth for "what's in the
  // editor" is the editor itself once loaded.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let outlineFrame = 0;
    const source = sourceRef.current;
    if (
      loadedTokenRef.current.editor === editor &&
      loadedTokenRef.current.projectId === source.projectId &&
      loadedTokenRef.current.sourceKind === source.sourceKind &&
      loadedTokenRef.current.sourceId === source.sourceId
    ) {
      return;
    }
    try {
      // ydoc mode: Collaboration owns the document. Don't setContent — that
      // would race the Yjs binding and produce ghost content. Just stamp the
      // loaded token so onUpdate starts firing.
      if (!ydoc) {
        loadDocWithoutHistory(editor, parseContentJson(content));
      }
      loadedTokenRef.current = {
        editor,
        projectId: source.projectId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
      };
      // Seed the reference table from whatever entityLink marks exist in the
      // freshly-loaded doc. onUpdate skips persistence during the initial
      // load; without this kick, references would only populate after the
      // user's next edit.
      projectReferences(editor);
      // Seed the live outline so the left TOC reflects existing headings
      // before the user makes any edits, without synchronously setting React
      // state from the effect body.
      outlineFrame = requestAnimationFrame(() => {
        if (!editor.isDestroyed) {
          recomputeOutline(editor);
        }
      });
      const selectionSnapshot = getEditorSelectionSnapshot(selectionKeyRef.current);
      if (selectionSnapshot) {
        restoreEditorSelectionSnapshot(selectionKeyRef.current, editor);
      } else if (!autoFocus) {
        suppressSelectionSaveRef.current = true;
        moveEditorSelectionToStart(editor);
        editor.commands.blur();
        requestAnimationFrame(() => {
          suppressSelectionSaveRef.current = false;
        });
      }
    } catch (error) {
      log.warn('Failed to load entity editor content:', error);
    }
    return () => {
      if (outlineFrame) cancelAnimationFrame(outlineFrame);
    };
    // content is intentionally NOT in deps — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, projectId, sourceKind, sourceId, projectReferences, recomputeOutline]);

  useEffect(() => {
    return () => {
      removeCommentContextMenu();
      if (!editor || editor.isDestroyed) return;
      saveSelection(editor);
    };
  }, [editor, projectId, sourceKind, sourceId, saveSelection]);

  // Register with the global active-editor registry: Cmd+F finds this
  // instance, Cmd+S runs the same persistence path as onUpdate.
  useRegisterActiveEditor(editor, () => {
    if (!editor || editor.isDestroyed) return;
    const source = sourceRef.current;
    if (!source.sourceId) return;
    if (
      loadedTokenRef.current.editor !== editor ||
      loadedTokenRef.current.projectId !== source.projectId ||
      loadedTokenRef.current.sourceKind !== source.sourceKind ||
      loadedTokenRef.current.sourceId !== source.sourceId
    ) {
      return;
    }
    persistEditorContent(editor);
  });

  return { editor, outline };
}
