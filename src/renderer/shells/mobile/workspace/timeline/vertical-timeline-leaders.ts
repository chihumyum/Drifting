import { indexById } from '../../../../lib/immutable-id-index';
import type { VerticalTimelineEntry } from './vertical-timeline-projection';

export interface VerticalTimelineChapterTrack { id: string; trackIndex: number }
export interface VerticalTimelineLeaderLayout {
  gutterWidth: number; trackX0: number; trackStep: number; channelOffset: number; entryOffset: number;
}

/** Entry-to-dot presentation only; dots remain the coordinate authority. */
export function projectVerticalTimelineLeaders(entries: readonly VerticalTimelineEntry[],
  chapters: readonly VerticalTimelineChapterTrack[], layout: VerticalTimelineLeaderLayout) {
  const out: { id: string; bracket: string | null; points: string }[] = [];
  const channel = layout.gutterWidth + layout.channelOffset;
  const left = layout.gutterWidth + layout.entryOffset;
  const chapterById = indexById(chapters);
  for (const entry of entries) {
    if (entry.kind === 'act' || entry.kind === 'marker') continue;
    const first = chapterById.get(entry.ids[0]);
    const dotX = layout.trackX0 + layout.trackStep * (first?.trackIndex ?? 0);
    out.push({ id: entry.id,
      bracket: entry.bracket ? `M${channel - 6},${entry.bracket.fromY} H${channel} V${entry.bracket.toY} H${channel - 6}` : null,
      points: `${dotX},${entry.leader.fromY} ${channel},${entry.leader.fromY} ${channel},${entry.leader.toY} ${left},${entry.leader.toY}` });
  }
  return out;
}
