import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import Collaboration from '@tiptap/extension-collaboration';
import type * as Y from 'yjs';
import loglevel from 'loglevel';

import { extractOutline, serializeOutline, type OutlineItem } from '../lib/outline';
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
import { createInlineMentionRepository } from '../sqlite-repo/inline-mention-repo';
import type { EditorView } from '@tiptap/pm/view';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../store/copilot-inline-store';
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
import type { CommentTargetKind } from '../domain/comment';

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

function openCommentContextMenu(
  request: EditorCommentRequest,
  onAddCommentRequest: (request: EditorCommentRequest) => void,
  onCopilot?: () => void,
): void {
  removeCommentContextMenu();
  const menu = document.createElement('div');
  menu.className = COMMENT_CONTEXT_MENU_CLASS;
  menu.style.left = `${request.clientX}px`;
  menu.style.top = `${request.clientY}px`;

  const addButton = (label: string, onClick: () => void): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      removeCommentContextMenu();
      onClick();
    });
    menu.appendChild(button);
  };

  addButton('添加批注', () => onAddCommentRequest(request));
  // Same entry point as ⇧⌘I — run Copilot on the selection (chapter editors).
  if (onCopilot) addButton('Copilot 修改', onCopilot);

  document.body.appendChild(menu);

  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) {
      removeCommentContextMenu();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

/** How many blocks before/after the invocation region to pull in as context. */
const INLINE_CONTEXT_WINDOW = 3;

/**
 * Resolve the inline-Copilot invocation context from the current editor
 * selection. With a non-empty selection the target IS the selection; with a
 * bare caret it's the enclosing block (so ⇧⌘I works mid-typing).
 *
 * Context is gathered around the WHOLE invocation region, not just its first
 * block: `nearbyContext` = up to INLINE_CONTEXT_WINDOW blocks before the first
 * covered block + after the last; `segmentSummaries` = the rolling segment
 * summaries overlapping that window. `blockContext` (enclosing paragraph) is
 * only set for a PARTIAL within-one-block selection, where the surrounding
 * sentence adds something the target span alone doesn't — for multi-block or
 * whole-block targets it's left empty (the target already spans full blocks).
 *
 * Returns null only if the caret isn't inside any id-bearing block.
 */
function buildInlineCopilotCtx(
  view: EditorView,
  projectId: string,
  nodeId: string,
  coords: { clientX: number; clientY: number },
): CopilotInlineCtx | null {
  const { selection, doc } = view.state;

  // All blocks in document order.
  const blocks: { id: string; text: string }[] = [];
  doc.descendants((node) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (id) blocks.push({ id, text: node.textContent.replace(/\s+/g, ' ').trim() });
    return false;
  });
  if (blocks.length === 0) return null;
  const indexById = new Map(blocks.map((b, i) => [b.id, i]));

  // Enclosing block of the caret / selection start.
  const resolved = doc.resolve(selection.from);
  let encId: string | null = null;
  let encText = '';
  let blockStart = 0;
  let blockEnd = 0;
  for (let depth = resolved.depth; depth >= 0; depth--) {
    const node = resolved.node(depth);
    if (!isBlockType(node.type.name)) continue;
    encId = (node.attrs?.id as string | null | undefined) ?? null;
    encText = node.textContent.replace(/\s+/g, ' ').trim();
    blockStart = resolved.before(depth) + 1;
    blockEnd = blockStart + node.content.size;
    break;
  }
  if (!encId) return null;

  // Selection block ids (Task 6) + the block-index range the run covers.
  const selectionBlockIds: string[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node) => {
      const bid = node.attrs?.id as string | null | undefined;
      if (isBlockType(node.type.name) && bid) selectionBlockIds.push(bid);
      return true;
    });
  }
  const selText = selection.empty
    ? ''
    : doc.textBetween(selection.from, selection.to, '\n').trim();
  const mode: 'selection' | 'block' = selText.length > 0 ? 'selection' : 'block';

  const coveredIds =
    mode === 'selection' && selectionBlockIds.length > 0 ? selectionBlockIds : [encId];
  const coveredIdxs = coveredIds
    .map((id) => indexById.get(id))
    .filter((i): i is number => i !== undefined);
  const firstIdx = coveredIdxs.length ? Math.min(...coveredIdxs) : (indexById.get(encId) ?? 0);
  const lastIdx = coveredIdxs.length ? Math.max(...coveredIdxs) : firstIdx;
  const coveredSet = new Set(coveredIds);

  // Enclosing paragraph only when a partial selection lives inside one block.
  const singleBlockPartial =
    mode === 'selection' && firstIdx === lastIdx && selText !== blocks[firstIdx]?.text;
  const blockContext = singleBlockPartial ? encText : '';

  // Nearby: window of blocks before the first / after the last covered block.
  const windowStart = Math.max(0, firstIdx - INLINE_CONTEXT_WINDOW);
  const windowEnd = Math.min(blocks.length - 1, lastIdx + INLINE_CONTEXT_WINDOW);
  const nearbyParts: string[] = [];
  for (let i = windowStart; i <= windowEnd; i++) {
    if (i >= firstIdx && i <= lastIdx) continue; // skip the covered region itself
    const b = blocks[i]!;
    if (!coveredSet.has(b.id) && b.text) nearbyParts.push(b.text);
  }

  // Segment summaries overlapping the window — the local narrative arc.
  const windowIds = new Set<string>();
  for (let i = windowStart; i <= windowEnd; i++) windowIds.add(blocks[i]!.id);
  const segmentSummaries = useDataStore
    .getState()
    .blockSections.filter(
      (s) => s.chapterId === nodeId && s.blockIds.some((b) => windowIds.has(b)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.summary)
    .filter((s) => s.trim().length > 0);

  return {
    nodeId,
    projectId,
    mode,
    from: mode === 'selection' ? selection.from : blockStart,
    to: mode === 'selection' ? selection.to : blockEnd,
    selectedText: mode === 'selection' ? selText : (blocks[firstIdx]?.text ?? encText),
    blockContext,
    nearbyContext: nearbyParts.join('\n\n'),
    segmentSummaries,
    selectionBlockIds,
    clientX: coords.clientX,
    clientY: coords.clientY,
  };
}

/**
 * Pre-computed data passed to onPersist alongside the editor instance. The
 * heavy work (JSON serialize, outline parse) is done once inside the hook so
 * each callsite doesn't redundantly re-walk the doc.
 */
export interface EditorPersistDerived {
  pmJson: string;
  outline: OutlineItem[];
  outlineJson: string;
}

export interface UseEntityEditorConfig {
  // What this editor is editing — drives projection direction and self-exclusion.
  sourceKind: EntityKind;
  sourceId: string;
  projectId: string;

  // Optional element this content lives under (patches on element X pass
  // X.id here). Used to extend self-exclusion past sourceKind/sourceId so
  // a patch on Mira doesn't auto-link its own "Mira" / alias mentions
  // back to Mira's element page. Apply to both the auto-detect map and
  // the @-picker.
  parentElementId?: string;

  // Initial document JSON string from the persisted row. Null = empty doc.
  // Ignored when `ydoc` is provided — Collaboration extension owns content.
  content: string | null;

  // Optional Y.Doc backing this editor. When set, the Collaboration extension
  // binds Tiptap directly to ydoc's default fragment, replacing the legacy
  // content-string load path. The caller is responsible for wiring sync via
  // useYjsSync. The hook still calls onPersist after each edit so chapter
  // word-count / outline derivation continues to work.
  ydoc?: Y.Doc;

  // Fired after every persistable edit. Receives the editor plus pre-computed
  // derived data (pmJson string, parsed outline, serialized outlineJson) so
  // callers don't redundantly re-walk the doc. Callers add entity-specific
  // extras (e.g. wordCount for chapters) and forward to their own persist
  // helpers.
  onPersist: (editor: Editor, derived: EditorPersistDerived) => void;

  // Optional slash menu items beyond the defaults.
  slashExtraItems?: SlashMenuExtraItem[];

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

  // Enable the Cmd+Shift+I inline-Copilot popover for this editor. Only chapter
  // editors set this (Copilot is chapter-scoped); the popover itself is
  // mounted by the caller (ChapterEditor) and keys off the same nodeId.
  enableInlineCopilot?: boolean;
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
//   • the active-editor registry hookup (Cmd+S, Cmd+F bindings).
export function useEntityEditor(config: UseEntityEditorConfig): UseEntityEditorResult {
  const {
    sourceKind,
    sourceId,
    projectId,
    parentElementId,
    content,
    ydoc,
    onPersist,
    slashExtraItems,
    onEntityClick,
    autoFocus,
    placeholder,
    editorClass,
    minHeight,
    selectionKey,
    onAddCommentRequest,
    enableInlineCopilot = false,
  } = config;

  const sourceRef = useLatestRef({ projectId, sourceKind, sourceId, parentElementId });
  const onPersistRef = useLatestRef(onPersist);
  const slashExtraItemsRef = useLatestRef(slashExtraItems);
  const onEntityClickRef = useLatestRef(onEntityClick);
  const selectionKeyRef = useLatestRef(selectionKey ?? null);
  const onAddCommentRequestRef = useLatestRef(onAddCommentRequest);
  const enableInlineCopilotRef = useLatestRef(enableInlineCopilot);

  const userId = useAuthStore((state) => state.user?.id);
  const editorUndoDepth = useSettingsStore((state) => state.editorUndoDepth);
  const autoElementLinkEnabled = useSettingsStore((state) => state.autoElementLinkEnabled);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);

  const bookElements = useDataStore((state) => state.bookElements);
  const bookNodes = useDataStore((state) => state.bookNodes);

  // Auto-detect: every element name + alias, and every chapter title, minus
  // self. Built fresh whenever the entity lists change so plugin config
  // sync below picks up the new map. Aliases register as additional keys
  // pointing at the SAME element id — so "Lady Mira" and "Mira" both
  // auto-link to Mira.
  //
  // Map key conflicts (alias colliding with another entity's name): last
  // write wins. App-layer uniqueness enforcement in useBookElement
  // (ElementNameConflictError) prevents this for elements, so a real
  // conflict here can only arise between an element name/alias and a
  // chapter title — accepted for now (chapter wins because chapters are
  // registered after elements below).
  const autoDetectTargets = useMemo(() => {
    const map = new Map<string, AutoDetectTarget>();
    bookElements.forEach((el) => {
      // Skip the element being edited (direct self), and also skip the
      // element this content lives under (a patch on Mira shouldn't
      // auto-link "Mira" back to Mira). Excluding the whole iteration
      // drops both `name` and every alias for that element in one shot.
      if (sourceKind === 'element' && el.id === sourceId) return;
      if (parentElementId && el.id === parentElementId) return;
      const target = { kind: 'element' as const, id: el.id };
      if (el.name) map.set(el.name, target);
      for (const alias of el.aliases) {
        if (alias) map.set(alias, target);
      }
    });
    bookNodes.forEach((n) => {
      if (sourceKind === 'node' && n.id === sourceId) return;
      if (!n.title) return;
      map.set(n.title, { kind: 'node', id: n.id });
    });
    return map;
  }, [bookElements, bookNodes, sourceKind, sourceId, parentElementId]);

  // @-picker source: pulled live from the store so the popover stays in sync.
  const getMentionableEntities = useCallback((): MentionableEntity[] => {
    const state = useDataStore.getState();
    const {
      sourceKind: currentSourceKind,
      sourceId: currentSourceId,
      parentElementId: currentParentElementId,
    } = sourceRef.current;
    const elements: MentionableEntity[] = state.bookElements
      .filter(
        (el) =>
          !(currentSourceKind === 'element' && el.id === currentSourceId) &&
          !(currentParentElementId && el.id === currentParentElementId),
      )
      .map((el) => ({ kind: 'element', id: el.id, name: el.name, aliases: el.aliases }));
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
  // pmJson / outline are computed once here and handed to onPersist so callers
  // don't redo the walk. Caller adds entity-specific extras (e.g. wordCount).
  // All gated by the (editor, sourceId) token to avoid initial-load round-trips.
  const persistEditorContent = useCallback(
    (editor: Editor) => {
      projectReferences(editor);
      recomputeOutline(editor);
      const pmJson = JSON.stringify(editor.getJSON());
      const outline = extractOutline(pmJson);
      const outlineJson = serializeOutline(outline);
      onPersistRef.current(editor, { pmJson, outline, outlineJson });
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
    const extraItems = slashExtraItemsRef.current;
    return extraItems ? [...extraItems] : [];
  }, [slashExtraItemsRef]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          // Novel-writing surface: no code or lists. Disabling the nodes/marks
          // also strips their input rules (`- `, `1. `, ``` ``` ```) and keymaps
          // (Mod-Shift-7/8, Mod-e, Mod-Alt-c), so there's no way to create them.
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          code: false,
          codeBlock: false,
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
        // @tiptap/extension-collaboration (v3.19+) ships its own
        // collab-aware undo/redo: registers y-prosemirror's yUndoPlugin +
        // Mod-z / Mod-y / Shift-Mod-z keymaps. So when ydoc is set we both
        // (a) disable StarterKit's `undoRedo` above (it would race the Yjs
        // binding) and (b) NOT add a second yUndoPlugin — Collaboration's
        // built-in one is the only one we want. The Y.UndoManager is scoped
        // to the local ySyncPlugin origin, so Cmd+Z only reverts this user's
        // edits, never a peer's.
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
        handleKeyDown: (view, event) => {
          // Cmd/Ctrl+Shift+I → inline Copilot popover. The Shift is what keeps
          // it off Mod+I (italic). Only for editors that opted in (chapter
          // editors), and only while the Copilot master switch is on (it gates
          // manual AND auto). Works with or without a selection (no selection →
          // current block).
          if (event.key !== 'i' && event.key !== 'I') return false;
          if (!(event.metaKey || event.ctrlKey) || event.altKey || !event.shiftKey) {
            return false;
          }
          if (!enableInlineCopilotRef.current) return false;
          if (!useSettingsStore.getState().copilotEnabled) return false;
          const source = sourceRef.current;
          if (source.sourceKind !== 'node' || !source.projectId || !source.sourceId) {
            return false;
          }
          const c = view.coordsAtPos(view.state.selection.from);
          const ctx = buildInlineCopilotCtx(view, source.projectId, source.sourceId, {
            clientX: c.left,
            clientY: c.bottom,
          });
          if (!ctx) return false;
          event.preventDefault();
          useCopilotInlineStore.getState().open(ctx);
          return true;
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

            // Resolve the enclosing block once, so we can grab both its id
            // and its plain-text snapshot in a single walk. The snapshot
            // lets the card render the selection in context AND survives
            // the block being edited or deleted (see CommentRail orphan
            // handling).
            const resolved = view.state.doc.resolve(selection.from);
            let blockId: string | null = null;
            let blockText = '';
            let blockStartInDoc = 0;
            for (let depth = resolved.depth; depth >= 0; depth--) {
              const node = resolved.node(depth);
              if (!isBlockType(node.type.name)) continue;
              const id = node.attrs?.id as string | null | undefined;
              if (!id) continue;
              blockId = id;
              blockText = node.textContent;
              blockStartInDoc = resolved.before(depth) + 1;
              break;
            }
            if (!blockId) return false;

            // Map doc-relative selection offsets into blockText-relative ones.
            // Direct subtraction works for plain prose; inline atoms (entity
            // links etc.) can shift positions, so we sanity-check against
            // the actual slice and fall back to indexOf if it doesn't match.
            let blockSelectionFrom = selection.from - blockStartInDoc;
            let blockSelectionTo = selection.to - blockStartInDoc;
            if (blockText.slice(blockSelectionFrom, blockSelectionTo) !== selectedText) {
              const idx = blockText.indexOf(selectedText);
              if (idx >= 0) {
                blockSelectionFrom = idx;
                blockSelectionTo = idx + selectedText.length;
              } else {
                blockSelectionFrom = -1;
                blockSelectionTo = -1;
              }
            }

            event.preventDefault();
            event.stopPropagation();
            const request: EditorCommentRequest = {
              projectId: source.projectId,
              sourceKind: source.sourceKind,
              sourceId: source.sourceId,
              targetBlockId: blockId,
              selectedText,
              anchorJson: JSON.stringify({
                selectedText,
                selectionFrom: selection.from,
                selectionTo: selection.to,
                createdAt: new Date().toISOString(),
                blockText,
                blockSelectionFrom,
                blockSelectionTo,
              }),
              clientX: event.clientX,
              clientY: event.clientY,
            };
            // Chapter editors also offer "Copilot 修改" — same entry as ⇧⌘I,
            // run on the selection. Build the inline ctx from the live view.
            const onCopilot =
              enableInlineCopilotRef.current &&
              source.sourceKind === 'node' &&
              useSettingsStore.getState().copilotEnabled
                ? () => {
                    const ctx = buildInlineCopilotCtx(view, source.projectId, source.sourceId, {
                      clientX: event.clientX,
                      clientY: event.clientY,
                    });
                    if (ctx) useCopilotInlineStore.getState().open(ctx);
                  }
                : undefined;
            openCommentContextMenu(request, handler, onCopilot);
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
      // Rebuild the editor when ydoc flips between undefined and a real
      // instance — useYjsDoc starts with isReady=false (no ydoc passed yet)
      // and the caller flips to the real Y.Doc once load completes. Without
      // this dep the Collaboration extension would never attach.
      ydoc,
    ],
  );

  // Keep the entity-link plugin's mutable config in sync with the latest
  // settings + entity list so auto-detect reacts without rebuilding the editor.
  useEffect(() => {
    entityLinkConfig.autoDetectEnabled = autoElementLinkEnabled;
    entityLinkConfig.autoDetectTargets = autoDetectTargets;
    entityLinkConfig.interactionEnabled = entityLinkInteractive;
    // Read the store live at click time so a link whose target was just
    // deleted (its mark still embedded in this doc's content) is treated as
    // dangling and ignored instead of opening a phantom "untitled" editor.
    entityLinkConfig.targetExists = (kind, id) => {
      const state = useDataStore.getState();
      switch (kind) {
        case 'element':
          return state.bookElements.some((e) => e.id === id);
        case 'node':
          return state.bookNodes.some((n) => n.id === id);
        case 'storyline':
          return state.storylines.some((s) => s.id === id);
        case 'category':
          return state.bookElementCategories.some((c) => c.id === id);
        default:
          // Kinds we don't track here (e.g. patch) stay navigable.
          return true;
      }
    };
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
