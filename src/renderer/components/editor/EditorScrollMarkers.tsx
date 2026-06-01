import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentTargetKind } from '../../domain/comment';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';

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
}

interface Tick {
  key: string;
  frac: number;
  cls: string;
  blockId: string;
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
}: EditorScrollMarkersProps) {
  const comments = useDataStore((s) => s.comments);
  // Unread agent-changed blocks for this entity (node only — elements track
  // coarsely as structural, with no per-block ticks). A tick drops once its
  // block has been read, matching the gutter fade in useAgentChangeMarks.
  const touched = useAgentActivityStore((s) => s.touched);
  const agentEntry = targetKind === 'node' ? touched[entityKey('node', targetId)] : undefined;
  // Stable key (block uuids carry no commas) so the array identity only changes
  // when the unread set does — keeps the recompute effect from churning.
  const agentBlocksKey = agentEntry
    ? [...agentEntry.spots.blocks]
        .filter((b) => !agentEntry.seen.blocks.has(b))
        .sort()
        .join(',')
    : '';
  const agentBlocks = useMemo(
    () => (agentBlocksKey ? agentBlocksKey.split(',') : []),
    [agentBlocksKey],
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

    for (const c of comments) {
      if (
        c.projectId !== projectId ||
        c.targetKind !== targetKind ||
        c.targetId !== targetId ||
        c.targetBlockId === null ||
        c.status === 'converted'
      ) {
        continue;
      }
      const block = scrollEl.querySelector(blockSelector(c.targetBlockId)) as HTMLElement | null;
      if (!block) continue; // orphan — no anchor on the rail
      const cls =
        c.status === 'resolved'
          ? 'editor__scrollmap-tick--resolved'
          : c.kind === 'todo'
            ? 'editor__scrollmap-tick--todo'
            : 'editor__scrollmap-tick--note';
      next.push({
        key: `c:${c.id}`,
        frac: fracOf(block),
        cls,
        blockId: c.targetBlockId,
        title: c.kind === 'todo' ? '跳到 TODO' : '跳到批注',
      });
    }

    if (agentBlocks) {
      for (const blockId of agentBlocks) {
        const block = scrollEl.querySelector(blockSelector(blockId)) as HTMLElement | null;
        if (!block) continue;
        next.push({
          key: `a:${blockId}`,
          frac: fracOf(block),
          cls: 'editor__scrollmap-tick--agent',
          blockId,
          title: '跳到改动处',
        });
      }
    }

    next.sort((a, b) => a.frac - b.frac);
    if (!sameTicks(ticksRef.current, next)) {
      ticksRef.current = next;
      setTicks(next);
    }
  }, [scrollEl, comments, projectId, targetKind, targetId, agentBlocks]);

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

  const jump = (blockId: string) => {
    const block = scrollEl?.querySelector(blockSelector(blockId)) as HTMLElement | null;
    block?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="editor__scrollmap" aria-hidden="true">
      {ticks.map((t) => (
        <button
          key={t.key}
          type="button"
          tabIndex={-1}
          className={`editor__scrollmap-tick ${t.cls}`}
          style={{ top: `${(t.frac * 100).toFixed(3)}%` }}
          title={t.title}
          onClick={() => jump(t.blockId)}
        />
      ))}
    </div>
  );
}
