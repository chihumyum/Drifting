import { Mark, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode, MarkType } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

// Re-export from the canonical vocabulary so callers that already import
// EntityKind from this extension don't need to be rewired. New code should
// reach for `../../domain/entity-kinds` directly.
export type { EntityKind } from '../../domain/entity-kinds';
import type { EntityKind } from '../../domain/entity-kinds';
import { isEntityKind } from '../../domain/entity-kinds';

export interface EntityLinkRef {
  targetKind: EntityKind;
  targetId: string;
  targetBlockId: string | null;
}

// Live state of a mention's target entity, driving both styling and clickability:
//   'alive'   → target exists: full styling + clickable
//   'trashed' → soft-deleted (recoverable): dimmed/desaturated + not clickable
//   'gone'    → hard-deleted or never existed: styling stripped + not clickable
export type EntityLinkTargetState = 'alive' | 'trashed' | 'gone';

// One detectable entity: name → { kind, id }. Both nodes (chapter titles) and
// elements participate; future kinds can be added by extending the union.
export interface AutoDetectTarget {
  kind: EntityKind;
  id: string;
}

export type EntityLinkTargetColorResolver = (
  kind: EntityKind,
  id: string,
) => string | null | undefined;

export interface EntityLinkOptions {
  // Targets eligible for auto-detection, keyed by their display name.
  // Names are matched verbatim. The @-picker covers the more general flow.
  autoDetectTargets: Map<string, AutoDetectTarget>;
  autoDetectEnabled: boolean;
  HTMLAttributes?: Record<string, string>;
  onClick?: (ref: EntityLinkRef) => void;
}

// Mutable shared config so the plugin can react to live changes without
// re-creating the extension. The hook (`useEntityEditor`) updates these
// fields whenever settings or the entity list changes.
export const entityLinkConfig = {
  autoDetectTargets: new Map<string, AutoDetectTarget>(),
  autoDetectEnabled: true,
  // When false, clicks on entity-link marks are ignored (no navigation).
  // Visual styling is gated separately via the `data-entity-link-interactive`
  // attribute on <html> (see editor-preferences.ts and index.css).
  interactionEnabled: true,
  // Resolve a link target's live state. Marks live inside other documents'
  // content JSON, so deleting an entity leaves links behind; clicking a
  // dead one would otherwise navigate to a phantom "untitled" editor. The
  // hook injects a store-backed implementation; the permissive default keeps
  // the extension usable in isolation/tests.
  resolveTargetState: (_kind: EntityKind, _id: string): EntityLinkTargetState => 'alive',
  // Mention colors are presentation-only: resolve them from live stores and
  // editor appearance preferences instead of persisting a stale color snapshot
  // in the entityLink mark itself.
  resolveTargetColor: ((_kind: EntityKind, _id: string) => null) as EntityLinkTargetColorResolver,
  targetColorVersion: 0,
};

export const EntityLinkPluginKey = new PluginKey('entityLink');

// Separate plugin that re-styles links whose target entity is no longer alive:
// soft-deleted targets get dimmed, hard-deleted/missing targets get stripped to
// plain prose. Carried in its own DecorationSet so we can recompute it (a) on
// every doc change and (b) on demand when the known-entity / trashed set shifts
// (an entity deleted or restored while this doc is open). The hook fires the
// on-demand refresh by dispatching a transaction tagged with this key's meta.
export const EntityLinkDanglingPluginKey = new PluginKey<DecorationSet>(
  'entityLinkDangling',
);

const META_FLAG = 'entityLink';

// 'gone' → strip styling (reads as plain prose); 'trashed' → dim/desaturate.
// CSS lives in index.css; both also cover the wrap case via :has().
const DANGLING_CLASS = 'entity-link--dangling';
const TRASHED_CLASS = 'entity-link--trashed';
const ENTITY_LINK_COLOR_PROPERTY = '--entity-link-color';

function safeTargetColor(color: string | null | undefined): string | null {
  const trimmed = color?.trim();
  // Category colors are currently hex values or token-backed hsl() values.
  // Reject declaration delimiters so synced/database content can never escape
  // the custom property's value and inject another inline declaration.
  if (!trimmed || trimmed.length > 128 || /[;{}]/.test(trimmed)) return null;
  return trimmed;
}

function resolveTargetColor(
  kind: EntityKind,
  id: string,
  resolver: EntityLinkTargetColorResolver = entityLinkConfig.resolveTargetColor,
): string | null {
  return safeTargetColor(resolver(kind, id));
}

/**
 * Rebind rendered mentions to their current presentation color without
 * modifying the ProseMirror/Yjs document. Called after editor transactions and
 * by the static all-chapters serializer. Removing the property deliberately
 * restores the target-kind fallback palette.
 */
export function applyEntityLinkTargetColors(
  root: ParentNode,
  resolver: EntityLinkTargetColorResolver = entityLinkConfig.resolveTargetColor,
): void {
  const links = root.querySelectorAll<HTMLElement>(
    '.entity-link[data-target-kind][data-target-id]',
  );
  links.forEach((link) => {
    const targetId = link.getAttribute('data-target-id');
    const rawKind = link.getAttribute('data-target-kind');
    const targetKind = isEntityKind(rawKind) ? rawKind : 'element';
    const color = targetId ? resolveTargetColor(targetKind, targetId, resolver) : null;
    if (link.style.getPropertyValue(ENTITY_LINK_COLOR_PROPERTY) === (color ?? '')) return;
    if (color) link.style.setProperty(ENTITY_LINK_COLOR_PROPERTY, color);
    else link.style.removeProperty(ENTITY_LINK_COLOR_PROPERTY);
  });
}

// Walk the doc and decorate every entity-link span by its target's live state.
// Alive targets are left untouched; clicks on non-alive targets are already
// swallowed by the handleClick guard.
function computeDanglingDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const mark of node.marks) {
      if (mark.type.name !== 'entityLink') continue;
      const targetId = mark.attrs.targetId as string | null;
      if (!targetId) continue;
      const targetKind = (mark.attrs.targetKind as EntityKind) ?? 'element';
      const state = entityLinkConfig.resolveTargetState(targetKind, targetId);
      if (state === 'alive') continue;
      decorations.push(
        Decoration.inline(pos, pos + node.text.length, {
          class: state === 'trashed' ? TRASHED_CLASS : DANGLING_CLASS,
        }),
      );
      break; // one decoration per text node is enough
    }
  });
  return DecorationSet.create(doc, decorations);
}

// ---- Auto-detect (debounced) ------------------------------------------------

// Trailing-debounce window before auto-linking freshly-typed entity names. Keeps
// the name-matching pass OFF the per-keystroke frame: a typing burst links once,
// on pause. Copilot context assembly calls flushPendingAutoDetect() to force it
// synchronously first, so a manual ⇧⌘I right after typing a name still sees it.
// (Copilot auto-runs are themselves debounced ≥3s, so they always see it too.)
const AUTO_DETECT_DEBOUNCE_MS = 500;

interface AutoDetectViewState {
  timer: ReturnType<typeof setTimeout> | null;
}
const autoDetectStates = new WeakMap<EditorView, AutoDetectViewState>();

// One precompiled alternation regex over ALL registered names, rebuilt only when
// the target Map identity changes — the hook swaps in a new Map only when
// names/aliases/titles actually change, never on content edits. Replaces the old
// "new RegExp per name per keystroke" loop. Names sorted longest-first so an
// alias that is a prefix of another ("Mira" vs "Lady Mira") yields the longer
// match at a position. Matching stays verbatim/case-sensitive — CJK-safe (no
// word boundaries, which don't exist between CJK chars).
let cachedMatcherMap: Map<string, AutoDetectTarget> | null = null;
let cachedMatcher: RegExp | null = null;
function getMergedMatcher(): RegExp | null {
  const map = entityLinkConfig.autoDetectTargets;
  if (cachedMatcherMap === map) return cachedMatcher;
  cachedMatcherMap = map;
  const names = Array.from(map.keys())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  cachedMatcher = names.length
    ? new RegExp(names.map(escapeRegExp).join('|'), 'g')
    : null;
  return cachedMatcher;
}

// Walk the whole doc and link any unlinked run matching a registered name.
// Idempotent (skips runs already linked to the same target) so re-running is
// safe. Dispatched addToHistory:false so auto-linking isn't an undo step. Runs
// off the typing frame (debounced) or on demand (flushPendingAutoDetect). Also
// clears any pending debounce timer for this view.
function runAutoDetect(view: EditorView, markType: MarkType): void {
  const st = autoDetectStates.get(view);
  if (st?.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  if (!entityLinkConfig.autoDetectEnabled) return;
  const matcher = getMergedMatcher();
  if (!matcher) return;

  const tr = view.state.tr;
  let modified = false;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    matcher.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const name = match[0];
      const target = entityLinkConfig.autoDetectTargets.get(name);
      if (!target) continue;
      // A PM text node is a uniform mark run, so one check covers it: if it
      // already links to this target, every match inside is already linked.
      const already = node.marks.some(
        (m) =>
          m.type === markType &&
          m.attrs.targetKind === target.kind &&
          m.attrs.targetId === target.id,
      );
      if (already) continue;
      const from = pos + match.index;
      tr.addMark(
        from,
        from + name.length,
        markType.create({ targetKind: target.kind, targetId: target.id, targetBlockId: null }),
      );
      modified = true;
    }
  });
  if (!modified) return;
  tr.setMeta(META_FLAG, true);
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
}

/** A detected entity-name span in a plain string + the entityLink mark attrs. */
export interface EntityLinkSpan {
  from: number;
  to: number;
  attrs: { targetKind: string; targetId: string; targetBlockId: null };
}

/**
 * Pure entity-link detection over a PLAIN string, using the same registered
 * targets + merged matcher as the editor's auto-detect (longest-name-first,
 * verbatim/CJK-safe). For re-linking agent-written prose — which arrives as plain
 * text with no marks — OUTSIDE an editor (the Yjs write path), so the inline-
 * mention projection the relational tools depend on isn't silently dropped.
 * Returns [] when auto-detect is off or no targets are registered.
 */
export function detectEntityLinkSpans(text: string): EntityLinkSpan[] {
  if (!text || !entityLinkConfig.autoDetectEnabled) return [];
  const matcher = getMergedMatcher();
  if (!matcher) return [];
  const spans: EntityLinkSpan[] = [];
  matcher.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const name = match[0];
    const target = entityLinkConfig.autoDetectTargets.get(name);
    if (!target) continue;
    spans.push({
      from: match.index,
      to: match.index + name.length,
      attrs: { targetKind: target.kind, targetId: target.id, targetBlockId: null },
    });
  }
  return spans;
}

/**
 * Force any pending debounced auto-detect to run NOW, synchronously linking
 * freshly-typed entity names. Copilot context assembly calls this before reading
 * entityLink marks off the live doc, so a manual ⇧⌘I fired right after typing a
 * name still sees it as a mentioned element. No-op when nothing new matches.
 */
export function flushPendingAutoDetect(editor: Editor): void {
  if (editor.isDestroyed) return;
  const markType = editor.schema.marks.entityLink;
  if (!markType) return;
  runAutoDetect(editor.view, markType);
}

export const EntityLink = Mark.create<EntityLinkOptions>({
  name: 'entityLink',
  // Don't extend the mark across new typing past its boundary.
  inclusive: false,
  // Don't merge adjacent marks unless attrs match exactly.
  excludes: '',

  addOptions() {
    return {
      autoDetectTargets: new Map(),
      autoDetectEnabled: true,
      HTMLAttributes: {},
      onClick: undefined,
    };
  },

  onCreate() {
    entityLinkConfig.autoDetectTargets = this.options.autoDetectTargets;
    entityLinkConfig.autoDetectEnabled = this.options.autoDetectEnabled;
  },

  addAttributes() {
    return {
      targetKind: {
        default: 'element',
        parseHTML: (el) => (el.getAttribute('data-target-kind') as EntityKind) ?? 'element',
        renderHTML: (attrs) => ({ 'data-target-kind': attrs.targetKind }),
      },
      targetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-target-id'),
        renderHTML: (attrs) =>
          attrs.targetId ? { 'data-target-id': attrs.targetId } : {},
      },
      targetBlockId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-target-block-id'),
        renderHTML: (attrs) =>
          attrs.targetBlockId ? { 'data-target-block-id': attrs.targetBlockId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-target-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const targetKind = (HTMLAttributes['data-target-kind'] as EntityKind | undefined) ?? 'element';
    const targetId = HTMLAttributes['data-target-id'];
    const deepLink = HTMLAttributes['data-target-block-id'] ? ' entity-link--deep' : '';
    const targetColor = targetId ? resolveTargetColor(targetKind, targetId) : null;
    const style = targetColor
      ? `cursor: pointer; ${ENTITY_LINK_COLOR_PROPERTY}: ${targetColor};`
      : 'cursor: pointer;';
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes ?? {}, HTMLAttributes, {
        class: `entity-link entity-link--${targetKind}${deepLink}`,
        style,
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    const markType = this.type;
    const onClick = this.options.onClick;

    return [
      new Plugin({
        key: EntityLinkPluginKey,

        // Auto-detect entity-name matches (element names + chapter titles) and
        // attach an entityLink mark — DEBOUNCED off the typing frame via the
        // plugin view below (see runAutoDetect / AUTO_DETECT_DEBOUNCE_MS). A
        // typing burst links once, on pause, instead of compiling a regex per
        // entity on every keystroke. The picker covers manual / non-name-based
        // mentions. (The old per-transaction CJK "searchPadding" hack is gone:
        // by the time the debounced pass runs, the full name is already in the
        // doc, so a plain whole-doc scan finds it regardless of how it was typed.)
        view(editorView) {
          applyEntityLinkTargetColors(editorView.dom);
          let appliedTargetColorVersion = entityLinkConfig.targetColorVersion;
          autoDetectStates.set(editorView, { timer: null });
          return {
            update(view, prevState) {
              // New/replaced mark DOM is styled by renderHTML, including paste,
              // undo and remote document changes. Existing marks only need a
              // scan when their external appearance changes; ordinary typing
              // must not repeatedly traverse and restyle the whole document.
              const docChanged = view.state.doc !== prevState.doc;
              if (appliedTargetColorVersion !== entityLinkConfig.targetColorVersion) {
                applyEntityLinkTargetColors(view.dom);
                appliedTargetColorVersion = entityLinkConfig.targetColorVersion;
              }
              // React only to doc changes — cheap identity check (PM mints a new
              // doc node on any change); skip selection-only updates.
              if (!docChanged) return;
              if (!entityLinkConfig.autoDetectEnabled) return;
              if (entityLinkConfig.autoDetectTargets.size === 0) return;
              const st = autoDetectStates.get(view);
              if (!st) return;
              if (st.timer) clearTimeout(st.timer);
              st.timer = setTimeout(() => runAutoDetect(view, markType), AUTO_DETECT_DEBOUNCE_MS);
            },
            destroy() {
              const st = autoDetectStates.get(editorView);
              if (st?.timer) clearTimeout(st.timer);
              autoDetectStates.delete(editorView);
            },
          };
        },

        props: {
          handleClick(_view, _pos, event) {
            if (!onClick) return false;
            if (!entityLinkConfig.interactionEnabled) return false;
            const target = event.target as HTMLElement | null;
            if (!target?.classList.contains('entity-link')) return false;

            const targetKind = (target.getAttribute('data-target-kind') as EntityKind) ?? 'element';
            const targetId = target.getAttribute('data-target-id');
            if (!targetId) return false;
            // Non-alive target (soft- or hard-deleted): swallow the click so we
            // don't navigate to a phantom "untitled" editor, but report it
            // handled so the click doesn't also place the caret mid-word.
            if (entityLinkConfig.resolveTargetState(targetKind, targetId) !== 'alive') return true;
            const targetBlockId = target.getAttribute('data-target-block-id');

            onClick({ targetKind, targetId, targetBlockId });
            return true;
          },
        },
      }),

      // Dangling-link decorations. Kept in plugin state so we don't re-walk the
      // whole doc on every keystroke.
      new Plugin<DecorationSet>({
        key: EntityLinkDanglingPluginKey,
        state: {
          init: (_config, state) => computeDanglingDecorations(state.doc),
          apply(tr, value) {
            // A link's target liveness (alive / trashed / gone) only changes
            // when the ENTITY SET changes — never from typing. So on a plain
            // doc change we just MAP the existing decorations through the step
            // (O(decorations), cheap); we recompute the whole set ONLY on the
            // meta-tagged refresh the hook fires when bookElements / bookNodes /
            // trashedEntityIds change. Freshly-typed marks always point at an
            // ALIVE target (auto-detect only links alive ones) and
            // computeDanglingDecorations skips alive targets, so map-not-
            // recompute never misses a new dangling decoration.
            //
            // Caveat (accepted): pasting prose that already carries a link to a
            // since-deleted entity, or undo restoring one, won't be dimmed until
            // the next entity-set change triggers a refresh — a minor cosmetic
            // lag, traded for taking the full-doc walk off the typing frame.
            if (tr.getMeta(EntityLinkDanglingPluginKey)) {
              return computeDanglingDecorations(tr.doc);
            }
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return EntityLinkDanglingPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk the whole editor document and stamp the entityLink mark on every run of
 * text matching any of `target.names`, pointing at the given entity. Used to
 * retroactively link prose written BEFORE the entity existed — the autoDetect
 * plugin above only fires on freshly-typed text, so earlier blocks would stay
 * unlinked otherwise.
 *
 * Verbatim case-sensitive match, mirroring autoDetect so both paths agree on
 * what links. Idempotent: a text run already linked to this exact target is
 * skipped, so re-running (or overlapping with autoDetect) is safe. Dispatched
 * with `addToHistory: false` so retro-linking isn't an undo step.
 */
export function linkEntityInDoc(
  editor: Editor,
  target: { kind: EntityKind; id: string; names: string[] },
): void {
  const markType = editor.schema.marks.entityLink;
  if (!markType) return;
  const names = Array.from(new Set(target.names.map((n) => n.trim()).filter(Boolean)));
  if (names.length === 0) return;

  const tr = editor.state.tr;
  let modified = false;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    // A PM text node is a single uniform mark run, so one check covers it all:
    // if it already links to this target, every match inside is already linked.
    const alreadyLinked = node.marks.some(
      (mark) =>
        mark.type === markType &&
        mark.attrs.targetKind === target.kind &&
        mark.attrs.targetId === target.id,
    );
    if (alreadyLinked) return;
    const text = node.text;
    for (const name of names) {
      const regex = new RegExp(escapeRegExp(name), 'g');
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const from = pos + m.index;
        tr.addMark(
          from,
          from + name.length,
          markType.create({ targetKind: target.kind, targetId: target.id, targetBlockId: null }),
        );
        modified = true;
      }
    }
  });

  if (!modified) return;
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
