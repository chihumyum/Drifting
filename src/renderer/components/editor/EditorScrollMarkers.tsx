import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commentBlockIds, commentColorKey, type CommentTargetKind } from '../../domain/comment';
import { useDataStore } from '../../store/data-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { flashBlock } from '../../lib/scroll-to-block';
import { isProseEntityType } from '../../lib/yjs-doc-id';
import type { AgentBlockChange } from '../../lib/agent/block-diff';

/**
 * VSCode-style overview ruler for the manuscript (#comments / #agent-changes).
 * Ticks pinned to the right edge of the scroll viewport mark where comments and
 * unread agent edits sit in the document, so the user can find them without
 * scrolling blind. Position is a fraction of total content height — like a
 * minimap — and is scroll-independent, so it only recomputes on layout change.
 *
 * Lives OUTSIDE .editor-scroll (a child of the positioned .editor-body) so it
 * stays put while the manuscript scrolls underneath. Always mounted — not gated
 * by the comment-rail toggle — so agent ticks show even with the rail closed.
 */
interface EditorScrollMarkersProps {
  scrollEl: HTMLElement | null;
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  /** When the comment rail is closed, comment ticks are hidden (there's no rail
   *  to jump to). Agent-change ticks always show — they're rail-independent. */
  commentsVisible?: boolean;
}

interface Tick {
  key: string;
  frac: number;
  /** Colour class (by comment family or agent op). */
  cls: string;
  /** Lane/position class. Agent ticks sit in one of three VSCode-git-style
   *  lanes (new=left / changed=mid / deleted=right); comment ticks are a
   *  horizontal bar spanning all three. */
  laneCls: string;
  /** Every block the tick covers. Click flashes them all; position is the first.
   *  Comments carry their whole consecutive range; agent changes carry one. */
  blockIds: string[];
  title: string;
}

function blockSelector(blockId: string): string {
  return `[data-block-id="${CSS.escape(blockId)}"]`;
}

function sameTicks(a: Tick[], b: Tick[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].cls !== b[i].cls || Math.abs(a[i].frac - b[i].frac) > 0.001) {
      return false;
    }
  }
  return true;
}

export function EditorScrollMarkers({
  scrollEl,
  projectId,
  targetKind,
  targetId,
  commentsVisible = true,
}: EditorScrollMarkersProps) {
  const { t } = useTranslation();
  const comments = useDataStore((s) => s.comments);
  // Agent-changed blocks for this entity (any prose entity — node / element /
  // storyline / category). Colored by op — new (green) / changed (blue) /
  // deleted (red). Shown in BOTH modes so pending edits are findable in a long
  // body: in auto a tick drops once its reveal has played; in approve once the
  // block is approved/rejected — either way when the edit-store entry clears.
  const pending = useAgentEditStore((s) => s.pending);
  const agentEntry = isProseEntityType(targetKind) ? pending[entityKey(targetKind, targetId)] : undefined;
  const showAgentTicks = !!agentEntry;
  // Stable key so the recompute effect only churns when the change set shifts.
  const agentKey =
    showAgentTicks && agentEntry
      ? agentEntry.changes.map((c) => `${c.op}:${c.blockId}:${c.afterPrevId ?? ''}`).join('|')
      : '';
  const agentChanges = useMemo<AgentBlockChange[]>(
    // Prose blocks only — `field:*` (summary/kv) changes have no prose anchor, so
    // they get no scroll tick (a deleted one would otherwise pin a tick at top).
    () => (showAgentTicks && agentEntry ? agentEntry.changes.filter((c) => !c.field) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentKey],
  );

  const [ticks, setTicks] = useState<Tick[]>([]);
  const ticksRef = useRef<Tick[]>([]);

  const recompute = useCallback(() => {
    if (!scrollEl) {
      if (ticksRef.current.length) {
        ticksRef.current = [];
        setTicks([]);
      }
      return;
    }
    const scrollRect = scrollEl.getBoundingClientRect();
    const scrollTop = scrollEl.scrollTop;
    const scrollHeight = scrollEl.scrollHeight || 1;
    const fracOf = (block: HTMLElement): number => {
      const top = block.getBoundingClientRect().top - scrollRect.top + scrollTop;
      return Math.min(1, Math.max(0, top / scrollHeight));
    };

    const next: Tick[] = [];

    // Comment ticks only when the rail is open — a tick that jumps to a hidden
    // rail is dead. Agent ticks (below) are rail-independent and always show.
    for (const c of commentsVisible ? comments : []) {
      if (
        c.projectId !== projectId ||
        c.targetKind !== targetKind ||
        c.targetId !== targetId ||
        c.targetBlockId === null ||
        c.status === 'converted'
      ) {
        continue;
      }
      // Position the tick at the first present block of the range; clicking
      // flashes the whole range (multi-block comments span several blocks).
      const ids = commentBlockIds(c);
      const firstPresent = ids
        .map((id) => scrollEl.querySelector(blockSelector(id)) as HTMLElement | null)
        .find((el): el is HTMLElement => el != null);
      if (!firstPresent) continue; // orphan — no anchor on the rail
      // Comment ticks span all three lanes (a horizontal bar), coloured by
      // family (manual/shadow/copilot/todo) — muted once resolved.
      const cls =
        c.status === 'resolved'
          ? 'editor__scrollmap-tick--resolved'
          : `editor__scrollmap-tick--c-${commentColorKey(c)}`;
      next.push({
        key: `c:${c.id}`,
        frac: fracOf(firstPresent),
        cls,
        laneCls: 'editor__scrollmap-tick--span',
        blockIds: ids,
        title: c.kind === 'todo'
          ? t('editorScrollMarkers.jumpToTodo')
          : t('editorScrollMarkers.jumpToComment'),
      });
    }

    for (const c of agentChanges) {
      // Deletions have no surviving block — hang their tick on the nearest
      // surviving predecessor (or the very top when they led the chapter).
      const anchorId = c.op === 'deleted' ? c.afterPrevId : c.blockId;
      let frac = 0;
      if (anchorId) {
        const block = scrollEl.querySelector(blockSelector(anchorId)) as HTMLElement | null;
        if (!block) continue;
        frac = fracOf(block);
      }
      // VSCode-git-style lanes: new=left (green), changed=mid (blue),
      // deleted=right (red). A sharp little rectangle in its own column.
      const cls =
        c.op === 'new'
          ? 'editor__scrollmap-tick--agent-new'
          : c.op === 'deleted'
            ? 'editor__scrollmap-tick--agent-deleted'
            : 'editor__scrollmap-tick--agent-changed';
      const laneCls =
        c.op === 'new'
          ? 'editor__scrollmap-tick--lane0'
          : c.op === 'deleted'
            ? 'editor__scrollmap-tick--lane2'
            : 'editor__scrollmap-tick--lane1';
      next.push({
        key: `a:${c.op}:${c.blockId}`,
        frac,
        cls,
        laneCls,
        blockIds: anchorId ? [anchorId] : [],
        title: t('editorScrollMarkers.jumpToChange'),
      });
    }

    next.sort((a, b) => a.frac - b.frac);
    if (!sameTicks(ticksRef.current, next)) {
      ticksRef.current = next;
      setTicks(next);
    }
  }, [scrollEl, comments, projectId, targetKind, targetId, agentChanges, commentsVisible, t]);

  // Recompute on data change + layout change. Fractions are scroll-independent,
  // so we don't listen to `scroll` — only resize and content-height changes.
  useEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    if (!scrollEl) return undefined;
    const on = () => recompute();
    window.addEventListener('resize', on);
    const ro = new ResizeObserver(on);
    ro.observe(scrollEl);
    const page = scrollEl.querySelector('.page');
    if (page) ro.observe(page);
    return () => {
      window.removeEventListener('resize', on);
      ro.disconnect();
    };
  }, [scrollEl, recompute]);

  if (ticks.length === 0) return null;

  // Scroll the first present block into view, then flash EVERY block in the
  // range — so clicking a multi-block comment's tick reveals its whole span,
  // not just the first block.
  const jump = (blockIds: string[]) => {
    if (!scrollEl) return;
    const blocks = blockIds
      .map((id) => scrollEl.querySelector(blockSelector(id)) as HTMLElement | null)
      .filter((el): el is HTMLElement => el != null);
    if (blocks.length === 0) return;
    blocks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    blocks.forEach(flashBlock);
  };

  return (
    <div className="editor__scrollmap" aria-hidden="true">
      {ticks.map((t) => (
        <button
          key={t.key}
          type="button"
          tabIndex={-1}
          className={`editor__scrollmap-tick ${t.cls} ${t.laneCls}`}
          style={{ top: `${(t.frac * 100).toFixed(3)}%` }}
          title={t.title}
          onClick={() => jump(t.blockIds)}
        />
      ))}
    </div>
  );
}
