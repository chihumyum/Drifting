import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { events } from '../../lib/events';
import type { SnapshotEntityKind } from '../../lib/yjs-doc-id';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { KindMark } from '../../components/ui/KindMark';
import type { KindMarkKind } from '../../components/ui/kind-mark';
import '../../../styles/stats-panel.css';

// ─────────────────────────────────────────────────────────────────────────────
// Small shared bits
//
// The panel is flat type and space, its readouts are sand and a row that
// opens what it names takes the sidebar cell's glass ring (stats-panel.css,
// docs/design-system/components.md 统计面板).

export function StatsSection({
  title,
  topBorder,
  children,
}: {
  title: string;
  topBorder?: boolean;
  children: ReactNode;
}) {
  // Sections are told apart by space alone.
  return (
    <section className={`stats-section${topBorder ? ' stats-section--after' : ''}`}>
      <div className="stats-section__title">{title}</div>
      {children}
    </section>
  );
}

export function StatsRow({
  k,
  v,
  children,
  placeholder,
}: {
  k: string;
  v: string;
  children?: ReactNode;
  placeholder?: boolean;
}) {
  return (
    <div className="stats-row">
      <span className="stats-row__key">{k}</span>
      <span className={`stats-row__value${placeholder ? ' is-placeholder' : ''}`}>{v}</span>
      {children && <div className="stats-row__extra">{children}</div>}
    </div>
  );
}

/** A column of link rows. */
export function StatsLinkList({ children }: { children: ReactNode }) {
  return <div className="stats-links">{children}</div>;
}

/**
 * The colour beside a name: the thing's sand mark (storyline = short dash,
 * element = square seal, category = corner…);
 * an act has no mark of its own and presses a round seal.
 */
export function StatsMark({ kind, color, seed }: { kind?: KindMarkKind; color?: string; seed?: string }) {
  return kind ? <KindMark kind={kind} color={color ?? 'hsl(var(--ink-4))'} seed={seed} /> : null;
}

/** Navigable row shared by act, element, and storyline statistics. */
export function StatsLinkRow({
  name,
  color,
  mark,
  seed,
  meta,
  onOpen,
  title,
}: {
  name: string;
  color?: string;
  /** The kind of thing the row opens, for its sand mark. */
  mark?: KindMarkKind;
  seed?: string;
  meta?: string;
  onOpen: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  // The sidebar cell's grammar: under the pointer a ring of flowing
  // hairline glass in the thing's colour; no wash.
  return (
    <button
      type="button"
      className="stats-link sand-cell"
      onClick={onOpen}
      title={title ?? t('rightSidebar.stats.openEntity', { name })}
      style={color ? ({ '--cell-c': color } as CSSProperties) : undefined}
    >
      <i className="cell-ring" aria-hidden="true" />
      <StatsMark kind={mark} color={color} seed={seed} />
      <span className="stats-link__name">{name}</span>
      {meta && <span className="stats-link__meta">{meta}</span>}
    </button>
  );
}

/** A row in a link list that opens nothing (chapters with no storyline). */
export function StatsStaticRow({ name, meta, mark }: { name: string; meta: string; mark?: KindMarkKind }) {
  return (
    <div className="stats-link is-static">
      <StatsMark kind={mark} />
      <span className="stats-link__name">{name}</span>
      <span className="stats-link__meta">{meta}</span>
    </div>
  );
}

/**
 * One value read against its whole: a dry sand stroke as long as the value
 * over scattered grains for what is left
 * (materials.css `.sand-stroke`, `.sand-track`).
 */
export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  return (
    <div className="sand-track">
      <span className="sand-stroke" style={{ width, '--sand-c': color } as CSSProperties} />
    </div>
  );
}

export interface StackedSegment {
  key: string;
  /** Share of the bar, 0–100. */
  pct: number;
  color: string;
  /** The stroke's colour when it differs (completion is ink). */
  sandColor?: string;
  /** How much sand the stroke holds: a draft is dry, what is still to write
   *  loose grains. */
  density?: 'dry' | 'loose';
  title?: string;
}

/** Parts of a whole side by side: acts, or chapters by writing status. */
export function StackedBar({ segments, marginBottom = 8 }: { segments: StackedSegment[]; marginBottom?: number }) {
  // One stroke per part, laid one after another.
  return (
    <div className="stats-strokes" style={{ marginBottom }}>
      {segments.map((segment) => (
        <span
          key={segment.key}
          title={segment.title}
          className={`sand-stroke${segment.density ? ` sand-stroke--${segment.density}` : ''}`}
          style={{ width: `${segment.pct}%`, '--sand-c': segment.sandColor ?? segment.color } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** A line of small index type under a readout, or the "and N more" after a list. */
export function StatsCaption({ children, more = false }: { children: ReactNode; more?: boolean }) {
  return <div className={`stats-caption${more ? ' stats-caption--more' : ''}`}>{children}</div>;
}

export function MetaGrid({ children }: { children: ReactNode }) {
  return <div className="stats-meta">{children}</div>;
}

export function MetaK({ children }: { children: ReactNode }) {
  return <div className="stats-meta__key">{children}</div>;
}

export function MetaV({ children }: { children: ReactNode }) {
  return <div className="stats-meta__value">{children}</div>;
}

export function DetailValue({ children }: { children: ReactNode }) {
  return <span className="stats-detail">{children}</span>;
}

export function Notes({ children }: { children: ReactNode }) {
  return <div className="stats-note">{children}</div>;
}

export function formatDateTime(input: string | number | Date): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return sameYear ? `${m}/${day} ${hh}:${mm}` : `${d.getFullYear()}/${m}/${day} ${hh}:${mm}`;
}

/**
 * The stats panel's entry into the entity time machine — opens the globally
 * mounted EntitySnapshotHistoryModal. This is the ONLY entry point (the
 * editor / cell context menus deliberately don't carry it). It is a
 * secondary button: the resting glass line, drifting under the pointer.
 */
export function SnapshotEntryButton({
  entityKind,
  entityId,
}: {
  entityKind: SnapshotEntityKind;
  entityId: string;
}) {
  const { t } = useTranslation();
  const open = () => events.emit('snapshot-history:open', { entityKind, entityId });
  return (
    <button
      type="button"
      className="stats-snapshot glass glass--rest glass--small"
      onClick={open}
      title={t('rightSidebar.stats.snapshotTitle')}
    >
      <BrushIcon name="rotate" size={12} />
      {t('rightSidebar.stats.snapshotButton')}
    </button>
  );
}
