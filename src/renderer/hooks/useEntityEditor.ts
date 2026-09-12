import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useEditor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import Collaboration from '@tiptap/extension-collaboration';
import type * as Y from 'yjs';
import loglevel from 'loglevel';

import type { OutlineItem } from '../lib/outline';
import { useEntityEditorSession } from '../features/editor/useEntityEditorSession';
import type { EditorPersistDerived } from '../features/editor/entity-editor-session';
export type { EditorPersistDerived } from '../features/editor/entity-editor-session';
import { BlockId, isBlockType } from '../lib/extensions/block-id';
import { ParagraphIndent } from '../lib/extensions/paragraph-indent';
import {
  AgentDiffDecoration,
} from '../lib/extensions/agent-diff-decoration';
import {
  EntityLink,
  isEntityLinkAutoDetectEnabled,
  linkEntityInDoc,
  type EntityKind,
  type EntityLinkRef,
} from '../lib/extensions/entity-link';
import type { BookElement } from '../domain/book-element';
import {
  EntityMentionSuggestion,
  type MentionableEntity,
} from '../lib/extensions/entity-mention-suggestion';
import {
  createDefaultSlashMenu,
  getBlockFormatItems,
  getInlineFormatItems,
  type BlockFormatItem,
  type SlashMenuExtraItem,
} from '../lib/slash-menu';
import { FULL_CHAPTER_CHAR_BUDGET } from '../lib/copilot/adaptive-chapter-context';
import type { EditorView } from '@tiptap/pm/view';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../store/copilot-inline-store';
import { useAuthStore } from '../store/auth';
import { useBookElement } from '../usecase/useBookElement';
import { useProjectNavigation } from './useProjectNavigation';
import { events } from '../lib/events';
import type { CommentTargetKind } from '../domain/comment';
import { useTypewriterScrolling } from './useTypewriterScrolling';
import { useEntityLinkConfiguration } from '../features/editor/useEntityLinkConfiguration';
import { useAgentEditorDecorations } from '../features/editor/useAgentEditorDecorations';
import { useEditorSurfaceLifecycle } from '../components/editor/editor-surface-lifecycle-context';
import { buildEntityAutoDetectTargets, selectEntityLinkNames } from '../lib/entity-link-names';

const log = loglevel.getLogger('useEntityEditor');
log.setLevel(loglevel.levels.WARN);

const DEFAULT_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};
const COMMENT_CONTEXT_MENU_CLASS = 'editor-comment-menu';

export interface EditorCommentRequest {
  projectId: string;
  sourceKind: CommentTargetKind;
  sourceId: string;
  targetBlockId: string;
  /** All top-level blocks the selection spans (incl. targetBlockId), in order —
   *  for a multi-block comment anchor. Single-block selections yield [targetBlockId]. */
  targetBlockIds: string[];
  selectedText: string;
  anchorJson: string;
  clientX: number;
  clientY: number;
}

function parseContentJson(content: string | null): JSONContent {
  if (!content) return DEFAULT_DOC;
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'doc' &&
      Array.isArray(parsed.content)
    ) {
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
  return (
    kind === 'node' ||
    kind === 'element' ||
    kind === 'storyline' ||
    kind === 'category' ||
    kind === 'patch'
  );
}

function removeCommentContextMenu(): void {
  document.querySelectorAll(`.${COMMENT_CONTEXT_MENU_CLASS}`).forEach((node) => node.remove());
}

interface EditorContextMenuOptions {
  // The live editor — drives the「格式」flyout. The block-type commands apply
  // across the whole current selection (multi-block included). Null suppresses
  // the format entry.
  editor: Editor | null;
  clientX: number;
  clientY: number;
  // Comment-family entries. Each is omitted when its handler isn't wired, so a
  // non-commentable-but-editable editor (e.g. a patch body) still gets「格式」.
  onAddComment?: () => void;
  onAddPatch?: () => void;
  onCopilot?: () => void;
  labels: {
    format: string;
    addComment: string;
    addPatch: string;
    copilot: string;
  };
}

// Position a flyout to the right of its parent menu, aligned to the triggering
// row. Flips to the left edge when it would overflow the viewport on the right,
// and clamps vertically so the tail of a long list stays on-screen. Mirrors the
// slash menu's positioner, just simpler (no flip-up animation needed here).
function positionContextFlyout(
  menu: HTMLDivElement,
  row: HTMLElement,
  flyout: HTMLDivElement,
): void {
  const MARGIN = 6;
  const menuRect = menu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const fw = flyout.offsetWidth || 140;
  const fh = flyout.offsetHeight || 160;

  let left = menuRect.right + 2;
  if (left + fw > window.innerWidth - MARGIN) {
    left = menuRect.left - fw - 2; // not enough room on the right → flip left
  }
  let top = rowRect.top - MARGIN; // roughly align the first item with the row
  if (top + fh > window.innerHeight - MARGIN) {
    top = Math.max(MARGIN, window.innerHeight - MARGIN - fh);
  }
  flyout.style.left = `${Math.max(MARGIN, left)}px`;
  flyout.style.top = `${top}px`;
}

// The「格式」row + its hover flyout. The flyout is a CHILD of `menu` (despite
// being positioned outside its box via position:fixed) so it tears down with
// the menu in removeCommentContextMenu() AND counts as "inside" for the
// outside-mousedown close handler. Items reuse the shared format lists, so they
// batch-format every block / the whole selection — and crucially DON'T delete
// the selection the way typing "/" over it would. Two groups: block-type
// transforms (also in the slash menu) and inline marks (flyout-only).
function appendFormatFlyout(menu: HTMLDivElement, editor: Editor, labelText: string): void {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'menu-surface__item has-flyout';
  row.setAttribute('role', 'menuitem');
  const label = document.createElement('span');
  label.textContent = labelText;
  const chevron = document.createElement('span');
  chevron.className = 'editor-comment-menu__chevron';
  chevron.textContent = '›';
  row.append(label, chevron);
  row.addEventListener('mousedown', (event) => event.preventDefault());

  const flyout = document.createElement('div');
  // Reuse the menu class so it inherits the menu chrome + teardown selector.
  flyout.className = `${COMMENT_CONTEXT_MENU_CLASS} menu-surface menu-surface--compact editor-comment-menu__flyout`;
  flyout.setAttribute('role', 'menu');
  flyout.style.display = 'none';
  const addItems = (items: BlockFormatItem[]): void => {
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-surface__item';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.title;
      // Snapshot active state at open time (the menu closes on click, so it
      // never goes stale): bold/heading/etc. already on the selection.
      if (item.isActive?.(editor)) button.classList.add('is-active');
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        removeCommentContextMenu();
        item.run(editor);
      });
      flyout.appendChild(button);
    }
  };
  addItems(getBlockFormatItems());
  const separator = document.createElement('div');
  separator.className = 'menu-surface__separator editor-comment-menu__sep';
  separator.setAttribute('role', 'separator');
  flyout.appendChild(separator);
  addItems(getInlineFormatItems());

  let hideTimer: number | undefined;
  const cancelHide = (): void => {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };
  const show = (): void => {
    cancelHide();
    flyout.style.display = 'flex';
    positionContextFlyout(menu, row, flyout);
  };
  const scheduleHide = (): void => {
    cancelHide();
    hideTimer = window.setTimeout(() => {
      flyout.style.display = 'none';
    }, 140);
  };
  row.addEventListener('mouseenter', show);
  row.addEventListener('mouseleave', scheduleHide);
  flyout.addEventListener('mouseenter', cancelHide);
  flyout.addEventListener('mouseleave', scheduleHide);

  menu.append(row, flyout);
}

function openEditorContextMenu(opts: EditorContextMenuOptions): void {
  removeCommentContextMenu();
  const menu = document.createElement('div');
  menu.className = `${COMMENT_CONTEXT_MENU_CLASS} menu-surface menu-surface--compact`;
  menu.setAttribute('role', 'menu');
  menu.style.left = `${opts.clientX}px`;
  menu.style.top = `${opts.clientY}px`;

  const addButton = (label: string, onClick: () => void): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-surface__item';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      removeCommentContextMenu();
      onClick();
    });
    menu.appendChild(button);
  };

  // 格式 first — it's the always-available, selection-scoped action. The
  // comment-family entries below are conditional on their handlers.
  if (opts.editor) appendFormatFlyout(menu, opts.editor, opts.labels.format);
  if (opts.onAddComment) addButton(opts.labels.addComment, opts.onAddComment);
  // Anchor a new element patch to the selection (chapter editors). Opens a
  // modal to pick the element + author title/body.
  if (opts.onAddPatch) addButton(opts.labels.addPatch, opts.onAddPatch);
  // Same entry point as ⇧⌘I — run Copilot on the selection (chapter editors).
  if (opts.onCopilot) addButton(opts.labels.copilot, opts.onCopilot);

  document.body.appendChild(menu);

  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) {
      removeCommentContextMenu();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

/** How many blocks before/after the invocation region to pull in as context when
 *  the chapter is too large to send whole (see FULL_CHAPTER_CHAR_BUDGET). */
const INLINE_CONTEXT_WINDOW = 5;

/**
 * Resolve the inline-Copilot invocation context from the current editor
 * selection. With a non-empty selection the target IS the selection; with a
 * bare caret it's the enclosing block (so ⇧⌘I works mid-typing).
 *
 * Context is gathered around the WHOLE invocation region, not just its first
 * block, and split by side: `contextBefore` = up to INLINE_CONTEXT_WINDOW
 * blocks before the first covered block (上文), `contextAfter` = up to that
 * many after the last (下文). Keeping them apart lets the prompt place the
 * target between its 上文 and 下文 rather than in one flat blob.
 * `segmentSummaries` = the rolling segment
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

  // All blocks in document order. `isText` distinguishes leaf textblocks
  // (paragraph/heading — editable in place) from containers (blockquote).
  const blocks: {
    id: string;
    kind: string;
    level?: number;
    text: string;
    isText: boolean;
  }[] = [];
  doc.descendants((node) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (id) {
      const level = node.attrs?.level;
      blocks.push({
        id,
        kind: node.type.name,
        level: typeof level === 'number' ? level : undefined,
        text: node.textContent.replace(/\s+/g, ' ').trim(),
        isText: node.isTextblock,
      });
    }
    return false;
  });
  if (blocks.length === 0) return null;
  const indexById = new Map(blocks.map((b, i) => [b.id, i]));

  // Selection block ids (Task 6) + covered text. Computed up front so the
  // enclosing-block resolution below can fall back to the selection.
  const selectionBlockIds: string[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node) => {
      const bid = node.attrs?.id as string | null | undefined;
      if (isBlockType(node.type.name) && bid) selectionBlockIds.push(bid);
      return true;
    });
  }
  const selText = selection.empty ? '' : doc.textBetween(selection.from, selection.to, '\n').trim();
  const mode: 'selection' | 'block' = selText.length > 0 ? 'selection' : 'block';

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
  // Boundary fallback: Cmd+A makes an AllSelection whose `from` is 0 (the doc
  // edge), which resolves to the doc node — not a block — so the loop above
  // leaves encId null. If the selection still covers blocks, anchor on the
  // first covered one so whole-doc runs build a ctx instead of bailing. A null
  // ctx here would let ⇧⌘I fall through to TipTap's Mod-I italic alias.
  if (!encId && selectionBlockIds.length > 0) {
    encId = selectionBlockIds[0];
    const idx = indexById.get(encId);
    if (idx !== undefined) encText = blocks[idx]!.text;
  }
  if (!encId) return null;

  const coveredIds =
    mode === 'selection' && selectionBlockIds.length > 0 ? selectionBlockIds : [encId];
  const coveredIdxs = coveredIds
    .map((id) => indexById.get(id))
    .filter((i): i is number => i !== undefined);
  const firstIdx = coveredIdxs.length ? Math.min(...coveredIdxs) : (indexById.get(encId) ?? 0);
  const lastIdx = coveredIdxs.length ? Math.max(...coveredIdxs) : firstIdx;

  // Enclosing paragraph only when a partial selection lives inside one block.
  const singleBlockPartial =
    mode === 'selection' && firstIdx === lastIdx && selText !== blocks[firstIdx]?.text;
  const blockContext = singleBlockPartial ? encText : '';

  // Whole blocks covered by the target, in doc order — the unit the block-by-
  // block edit pipeline revises and applies in place. Only leaf textblocks
  // (paragraph/heading) are editable; containers (blockquote) are left as-is.
  const targetBlocks = [...coveredIdxs]
    .sort((a, b) => a - b)
    .map((i) => blocks[i]!)
    .filter((b) => b.isText)
    .map((b) => ({
      id: b.id,
      kind: b.kind === 'heading' ? 'heading' : 'paragraph',
      level: b.level,
      text: b.text,
    }));

  // Adaptive context scope. When the whole chapter is small enough, send ALL of
  // it as 上文/下文 — faithful full-chapter context beats a lossy rolling summary
  // (product direction: 内容不多就全 chapter). Only an oversized chapter falls
  // back to a ±INLINE_CONTEXT_WINDOW window + the rolling segment summaries.
  const chapterChars = blocks.reduce((n, b) => n + b.text.length, 0);
  const wholeChapter = chapterChars <= FULL_CHAPTER_CHAR_BUDGET;

  // Nearby context, split by side: a window of blocks strictly BEFORE the
  // first covered block (上文) and strictly AFTER the last (下文). Iterating the
  // two ranges separately both excludes the [firstIdx, lastIdx] target span and
  // keeps each side in document order, so the prompt can show the target
  // sitting between them rather than as one undifferentiated blob.
  const windowStart = wholeChapter ? 0 : Math.max(0, firstIdx - INLINE_CONTEXT_WINDOW);
  const windowEnd = wholeChapter
    ? blocks.length - 1
    : Math.min(blocks.length - 1, lastIdx + INLINE_CONTEXT_WINDOW);
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  for (let i = windowStart; i < firstIdx; i++) {
    const b = blocks[i]!;
    if (b.text) beforeParts.push(b.text);
  }
  for (let i = lastIdx + 1; i <= windowEnd; i++) {
    const b = blocks[i]!;
    if (b.text) afterParts.push(b.text);
  }

  // Segment summaries overlapping the window — the local narrative arc. Skipped
  // when we're already sending the whole chapter (the prose itself supersedes a
  // rolling summary of it).
  const windowIds = new Set<string>();
  for (let i = windowStart; i <= windowEnd; i++) windowIds.add(blocks[i]!.id);
  const segmentSummaries = wholeChapter
    ? []
    : useDataStore
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
    contextBefore: beforeParts.join('\n\n'),
    contextAfter: afterParts.join('\n\n'),
    segmentSummaries,
    selectionBlockIds,
    targetBlocks,
    spanWithinBlock: singleBlockPartial,
    clientX: coords.clientX,
    clientY: coords.clientY,
  };
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
  // JSON-backed editors receive this in their TipTap constructor so an empty
  // editor/placeholder can never paint before the real content is installed.
  content: string | null;

  // Yjs editors must declare their authority even while the Y.Doc is loading.
  // This keeps readiness false until the TipTap instance carrying the actual
  // Collaboration extension has replaced its temporary, never-visible shell.
  documentMode?: 'json' | 'yjs';

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
  // Primary long-form prose surfaces opt in to typewriter scrolling. Embedded
  // patch/template/popover editors stay false so they never move a whole page.
  typewriterScrolling?: boolean;

  // Optional top-level tab selection key. Popovers / virtualized editors leave
  // this unset so their transient caret positions don't focus newly-opened tabs.
  selectionKey?: string | null;

  // Optional Word-style comment creation entry. The hook only detects the
  // selected block and selected text; persistence/UI lives above it.
  onAddCommentRequest?: (request: EditorCommentRequest) => void;

  // Optional "新建补丁" entry on the same selection context menu (chapter
  // editors only). Receives the SAME EditorCommentRequest the comment entry
  // would — the caller derives the patch anchor (chapter/block + text anchor)
  // from it. The hook only adds the menu item; the modal/UI lives above it.
  onAddPatchRequest?: (request: EditorCommentRequest) => void;

  // Enable the Cmd+Shift+I inline-Copilot popover for this editor. Only chapter
  // editors set this (Copilot is chapter-scoped); the popover itself is
  // mounted by the caller (ChapterEditor) and keys off the same nodeId.
  enableInlineCopilot?: boolean;

  // When false, the prose body is read-only (e.g. a locked chapter
  // review). Defaults to true. The caller keys the editor on this so toggling it
  // remounts + re-creates the editor with the new editable state.
  editable?: boolean;
}

export interface UseEntityEditorResult {
  editor: Editor | null;
  /** True only when this exact TipTap instance owns its canonical document. */
  ready: boolean;
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
//   • constructor-time JSON loading plus a canonical-document readiness signal,
//   • a canonical editor session owning persistence, selection and outline presentation,
//   • the entity-link config sync (auto-detect map + enabled flag),
//   • the @-picker (mentionable entities and "+ create element" affordance),
//   • the active-editor registry hookup (Cmd+S, Cmd+F bindings).
export function useEntityEditor(config: UseEntityEditorConfig): UseEntityEditorResult {
  const { t } = useTranslation();
  const {
    sourceKind,
    sourceId,
    projectId,
    parentElementId,
    content,
    documentMode: requestedDocumentMode,
    ydoc,
    onPersist,
    slashExtraItems,
    onEntityClick,
    autoFocus,
    placeholder,
    editorClass,
    minHeight,
    typewriterScrolling = false,
    selectionKey,
    onAddCommentRequest,
    onAddPatchRequest,
    enableInlineCopilot = false,
    editable = true,
  } = config;
  const documentMode = requestedDocumentMode ?? (ydoc ? 'yjs' : 'json');

  const sourceRef = useLatestRef({ projectId, sourceKind, sourceId, parentElementId });
  const slashExtraItemsRef = useLatestRef(slashExtraItems);
  const onEntityClickRef = useLatestRef(onEntityClick);
  const onAddCommentRequestRef = useLatestRef(onAddCommentRequest);
  const onAddPatchRequestRef = useLatestRef(onAddPatchRequest);
  const enableInlineCopilotRef = useLatestRef(enableInlineCopilot);
  const { isCommandActive, isVisible, isPreparing } = useEditorSurfaceLifecycle();
  // Latest editor instance, read inside the (later-firing) contextmenu handler
  // to run「格式」block-transform commands on the live selection. Declared up
  // here because the handler closure lives inside the useEditor config below;
  // assigned once the editor exists (see effect after useEditor).
  const editorRef = useRef<Editor | null>(null);

  const userId = useAuthStore((state) => state.user?.id);
  const editorUndoDepth = useSettingsStore((state) => state.editorUndoDepth);
  const autoElementLinkEnabled = useSettingsStore((state) => state.autoElementLinkEnabled);

  // Name/appearance projections are shared across retained editors. Metric or
  // body updates can change domain arrays without invalidating these selectors.
  const entityNames = useDataStore(selectEntityLinkNames);
  const autoDetectTargets = useMemo(
    () => buildEntityAutoDetectTargets(entityNames, sourceKind, sourceId, parentElementId),
    [entityNames, sourceKind, sourceId, parentElementId],
  );

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

  const getSlashItems = useCallback((): SlashMenuExtraItem[] => {
    const extraItems = slashExtraItemsRef.current;
    return extraItems ? [...extraItems] : [];
  }, [slashExtraItemsRef]);

  const initialContent = documentMode === 'json' ? parseContentJson(content) : null;
  const jsonDocumentKey =
    documentMode === 'json' ? `${projectId}:${sourceKind}:${sourceId}` : null;

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
        ...(placeholder && (documentMode === 'json' || ydoc)
          ? [Placeholder.configure({ placeholder })]
          : []),
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
        // Tab / Shift-Tab block indent. Without this Tab has no binding (lists
        // are disabled, so listKeymap is gone) and the browser default blurs
        // the editor. Always consumes Tab.
        ParagraphIndent,
        // In-place agent-edit diff decorations (approve mode). Inert until
        // useEntityEditor pushes a DecorationSet for node editors (below).
        AgentDiffDecoration,
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
      content: initialContent,
      autofocus: autoFocus ? 'end' : false,
      editable,
      editorProps: {
        attributes: {
          class: editorClass ?? 'prose max-w-none focus:outline-none',
          style: minHeight ? `min-height: ${minHeight}` : '',
          spellcheck: 'false',
        },
        handleKeyDown: (view, event) => {
          // Cmd/Ctrl+Shift+I → inline Copilot popover. NB: TipTap's Italic
          // binds BOTH Mod-i and Mod-I, so ⇧⌘I is also an italic alias —
          // prosemirror-keymap retries shifted single-char keys without Shift
          // and matches Mod-I. We win because editorProps.handleKeyDown runs
          // before the Italic keymap and we swallow the chord below. Only for
          // editors that opted in (chapter editors). Manual ⇧⌘I is always
          // available — it is never gated by the auto-trigger switch. Works
          // with or without a selection (no selection → current block).
          if (event.key !== 'i' && event.key !== 'I') return false;
          if (!(event.metaKey || event.ctrlKey) || event.altKey || !event.shiftKey) {
            return false;
          }
          if (!enableInlineCopilotRef.current) return false;
          const source = sourceRef.current;
          if (source.sourceKind !== 'node' || !source.projectId || !source.sourceId) {
            return false;
          }
          // This is unambiguously the Copilot chord in a chapter editor, so
          // swallow it unconditionally — otherwise a null ctx (e.g. empty doc)
          // would let it fall through to TipTap's Mod-I italic alias, which is
          // exactly what ⇧⌘I must never do here.
          event.preventDefault();
          const c = view.coordsAtPos(view.state.selection.from);
          const ctx = buildInlineCopilotCtx(view, source.projectId, source.sourceId, {
            clientX: c.left,
            clientY: c.bottom,
          });
          if (ctx) useCopilotInlineStore.getState().open(ctx);
          return true;
        },
        handleDOMEvents: {
          contextmenu: (view, event) => {
            // The「格式」entry is available in ANY editable editor, so the menu
            // opens on any non-empty selection — not only commentable ones. The
            // comment / patch / Copilot entries layer on top when their handlers
            // and a commentable source are present (resolved below). Read-only
            // editors fall through to the native browser menu (copy etc.).
            if (!view.editable) return false;
            const { selection } = view.state;
            if (selection.empty) return false;
            const selectedText = view.state.doc
              .textBetween(selection.from, selection.to, '\n')
              .trim();
            if (!selectedText) return false;

            // --- Comment-family entries (require a commentable source) --------
            // Resolve the selection into a comment anchor only when commentable.
            // Any failure here just leaves these undefined (→「格式」-only menu);
            // it never aborts the menu.
            let onAddComment: (() => void) | undefined;
            let onCopilot: (() => void) | undefined;
            let onAddPatch: (() => void) | undefined;
            const handler = onAddCommentRequestRef.current;
            const source = sourceRef.current;
            if (source.projectId && source.sourceId && isCommentTargetKind(source.sourceKind)) {
              // Resolve the enclosing block once, so we can grab both its id
              // and its plain-text snapshot in a single walk. The snapshot
              // lets the card render the selection in context AND survives
              // the block being edited or deleted (see sticky-note orphan
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
              if (blockId) {
                // All top-level blocks the selection spans (in order) — for a
                // multi-block comment anchor. Capture each block's id, original
                // plain text (so the card can show the source on demand even
                // after edits/deletes), and doc-start position (char offsets).
                const spanBlocks: { id: string; text: string; docStart: number }[] = [];
                view.state.doc.forEach((node, offset) => {
                  if (offset + node.nodeSize > selection.from && offset < selection.to) {
                    const id = node.attrs?.id as string | null | undefined;
                    if (id) spanBlocks.push({ id, text: node.textContent, docStart: offset + 1 });
                  }
                });
                if (spanBlocks.length === 0) {
                  spanBlocks.push({ id: blockId, text: blockText, docStart: blockStartInDoc });
                }
                const spanBlockIds = spanBlocks.map((b) => b.id);

                // Map doc-relative selection offsets into blockText-relative
                // ones. Direct subtraction works for plain prose; inline atoms
                // (entity links etc.) can shift positions, so we sanity-check
                // against the actual slice and fall back to indexOf on mismatch.
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

                // Precise text anchor: start = first spanned block + its
                // in-block offset (reuse the validated blockSelectionFrom),
                // end = last spanned block + the selection-end offset within
                // it. Drives the hover highlight + text-level change detection.
                const firstSpan = spanBlocks[0]!;
                const lastSpan = spanBlocks[spanBlocks.length - 1]!;
                const startOffset =
                  blockSelectionFrom >= 0
                    ? blockSelectionFrom
                    : Math.max(
                        0,
                        Math.min(firstSpan.text.length, selection.from - firstSpan.docStart),
                      );
                const endOffset =
                  spanBlocks.length === 1 && blockSelectionTo >= 0
                    ? blockSelectionTo
                    : Math.max(0, Math.min(lastSpan.text.length, selection.to - lastSpan.docStart));

                const request: EditorCommentRequest = {
                  projectId: source.projectId,
                  sourceKind: source.sourceKind,
                  sourceId: source.sourceId,
                  targetBlockId: blockId,
                  targetBlockIds: spanBlockIds,
                  selectedText,
                  anchorJson: JSON.stringify({
                    selectedText,
                    selectionFrom: selection.from,
                    selectionTo: selection.to,
                    createdAt: new Date().toISOString(),
                    blockText,
                    blockSelectionFrom,
                    blockSelectionTo,
                    blockSnapshots: spanBlocks.map((b) => ({ blockId: b.id, blockText: b.text })),
                    textAnchor: {
                      startBlockId: firstSpan.id,
                      startOffset,
                      endBlockId: lastSpan.id,
                      endOffset,
                      text: selectedText,
                    },
                  }),
                  clientX: event.clientX,
                  clientY: event.clientY,
                };
                if (handler) onAddComment = () => handler(request);
                // "Copilot 修改" — same entry as ⇧⌘I, run on the selection.
                // Always manual (never gated by the auto switch). Chapter only.
                onCopilot =
                  enableInlineCopilotRef.current && source.sourceKind === 'node'
                    ? () => {
                        const ctx = buildInlineCopilotCtx(view, source.projectId, source.sourceId, {
                          clientX: event.clientX,
                          clientY: event.clientY,
                        });
                        if (ctx) useCopilotInlineStore.getState().open(ctx);
                      }
                    : undefined;
                // "新建补丁" — chapter editors only (a patch's source is a chapter).
                const patchHandler = onAddPatchRequestRef.current;
                onAddPatch =
                  patchHandler && source.sourceKind === 'node'
                    ? () => patchHandler(request)
                    : undefined;
              }
            }

            // Nothing to show (no editor for「格式」AND not commentable) → let
            // the native menu through.
            if (!editorRef.current && !onAddComment && !onAddPatch && !onCopilot) {
              return false;
            }
            event.preventDefault();
            event.stopPropagation();
            openEditorContextMenu({
              editor: editorRef.current,
              clientX: event.clientX,
              clientY: event.clientY,
              onAddComment,
              onAddPatch,
              onCopilot,
              labels: {
                format: t('entityEditor.contextMenu.format'),
                addComment: t('entityEditor.contextMenu.addComment'),
                addPatch: t('entityEditor.contextMenu.addPatch'),
                copilot: t('entityEditor.contextMenu.copilot'),
              },
            });
            return true;
          },
        },
      },
    },
    [
      editorUndoDepth,
      placeholder,
      autoFocus,
      editorClass,
      minHeight,
      t,
      documentMode,
      jsonDocumentKey,
      // Yjs surfaces remain hidden until the rebuilt instance below carries
      // this exact document's Collaboration extension.
      ydoc,
    ],
  );

  const collaboration = editor?.extensionManager.extensions.find(
    (extension) => extension.name === 'collaboration',
  );
  const canonicalReady =
    documentMode === 'json'
      ? Boolean(editor)
      : Boolean(editor && ydoc && collaboration?.options.document === ydoc);

  const { outline, ready: sessionReady } = useEntityEditorSession(editor, {
    projectId, sourceKind, sourceId, canonicalReady, onPersist, selectionKey, autoFocus,
    presentationNeeded: isVisible || isPreparing, isCommandActive,
  });

  useTypewriterScrolling(editor, typewriterScrolling && canonicalReady, { isVisible, isPreparing });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEntityLinkConfiguration(editor, { autoDetectTargets, autoDetectEnabled: autoElementLinkEnabled });

  const decorationsReady = useAgentEditorDecorations(editor, sourceKind, sourceId, isVisible || isPreparing);
  const ready = canonicalReady && sessionReady && decorationsReady;

  // Retroactively link prose that mentioned an element before it was created.
  // Auto-detect only fires on freshly-typed text, so an element created after
  // its name was already written (e.g. accepting a Copilot element-candidate)
  // would leave those earlier blocks unlinked. createElement emits this event;
  // every mounted editor handles it, so all open chapters pick up the new link
  // — not just whichever editor happened to be active at creation time.
  useEffect(() => {
    if (!editor) return;
    const onElementCreated = ({ element }: { element: BookElement }) => {
      if (editor.isDestroyed || !isEntityLinkAutoDetectEnabled(editor)) return;
      // Mirror the autoDetectTargets exclusions: never self-link the entity (or
      // its parent element) this editor is editing.
      const { sourceKind: sk, sourceId: sid, parentElementId: pid } = sourceRef.current;
      if (sk === 'element' && element.id === sid) return;
      if (pid && element.id === pid) return;
      try {
        linkEntityInDoc(editor, {
          kind: 'element',
          id: element.id,
          names: [element.name, ...element.aliases],
        });
      } catch (err) {
        log.warn('Retroactive entity link failed:', err);
      }
    };
    events.on('element:element-created', onElementCreated);
    return () => events.off('element:element-created', onElementCreated);
  }, [editor, sourceRef]);

  useEffect(() => () => removeCommentContextMenu(), [editor, projectId, sourceKind, sourceId]);

  return { editor, outline, ready };
}
