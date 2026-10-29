import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { events } from '../../lib/events';
import type { SnapshotEntityKind } from '../../lib/yjs-doc-id';
import { getPlatformRuntime } from '../../platform/runtime';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { KindMark } from '../../components/ui/KindMark';
import type { KindMarkKind } from '../../components/ui/kind-mark';
import '../../../styles/stats-panel.css';

// ─────────────────────────────────────────────────────────────────────────────
// Small shared bits
//
// On the desktop the panel is flat type and space, its readouts are sand and
// a row that opens what it names takes the sidebar cell's glass ring
// (stats-panel.css, docs/design-system/components.md 统计面板). The paused
// mobile shell keeps the inline fallback each primitive carries.

/** Whether the panel wears sand and glass: everywhere but the mobile shell. */
const sandPanel = () => !getPlatformRuntime().isMobileShell;

export function StatsSection({
  title,
  topBorder,
  children,
}: {
  title: string;
  topBorder?: boolean;
  children: ReactNode;
}) {
  if (sandPanel()) {
    // Sections are told apart by space alone.
    return (
      <section className={`stats-section${topBorder ? ' stats-section--after' : ''}`}>
        <div className="stats-section__title">{title}</div>
        {children}
      </section>
    );
  }
  return (
    <section
      style={{
        padding: topBorder ? '14px 0 16px' : '0 0 16px',
        borderTop: topBorder ? '1px solid hsl(var(--rule))' : 'none',
        borderBottom: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'hsl(var(--ink-3))',
        }}
      >
        <span>{title}</span>
      </div>
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
  if (sandPanel()) {
    return (
      <div className="stats-row">
        <span className="stats-row__key">{k}</span>
        <span className={`stats-row__value${placeholder ? ' is-placeholder' : ''}`}>{v}</span>
        {children && <div className="stats-row__extra">{children}</div>}
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: '4px 12px',
        padding: '6px 0',
        borderBottom: '1px dotted hsl(var(--rule))',
        fontSize: 12,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'hsl(var(--ink-3))',
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          color: placeholder ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-1))',
          fontStyle: placeholder ? 'italic' : 'normal',
        }}
      >
        {v}
      </span>
      {children && <div style={{ gridColumn: '1 / -1', marginTop: 2 }}>{children}</div>}
    </div>
  );
}

/** A column of link rows. */
export function StatsLinkList({ children }: { children: ReactNode }) {
  if (sandPanel()) return <div className="stats-links">{children}</div>;
  return <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

/**
 * The colour beside a name. On the desktop it is the thing's sand mark
 * (storyline = short dash, element = square seal, category = corner…);
 * an act has no mark of its own and presses a round seal.
 */
export function StatsMark({ kind, color, seed }: { kind?: KindMarkKind; color?: string; seed?: string }) {
  if (sandPanel()) {
    return kind ? <KindMark kind={kind} color={color ?? 'hsl(var(--ink-4))'} seed={seed} /> : null;
  }
  return <Dot color={color} />;
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
  /** The kind of thing the row opens, for its sand mark on the desktop. */
  mark?: KindMarkKind;
  seed?: string;
  meta?: string;
  onOpen: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  if (sandPanel()) {
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
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen();
      }}
      title={title ?? t('rightSidebar.stats.openEntity', { name })}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 2px',
        borderBottom: '1px dotted hsl(var(--rule))',
        fontSize: 12,
        minWidth: 0,
        cursor: 'pointer',
        transition: 'background 0.12s',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'hsl(var(--rule) / 0.3)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <Dot color={color} />
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          color: 'hsl(var(--ink-1))',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {name}
      </span>
      {meta && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'hsl(var(--ink-3))',
            flexShrink: 0,
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
}

/** A row in a link list that opens nothing (chapters with no storyline). */
export function StatsStaticRow({ name, meta, mark }: { name: string; meta: string; mark?: KindMarkKind }) {
  if (sandPanel()) {
    return (
      <div className="stats-link is-static">
        <StatsMark kind={mark} />
        <span className="stats-link__name">{name}</span>
        <span className="stats-link__meta">{meta}</span>
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 2px',
        borderBottom: '1px dotted hsl(var(--rule))',
        fontSize: 12,
      }}
    >
      <Dot color="hsl(var(--ink-4))" />
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          color: 'hsl(var(--ink-3))',
          flex: 1,
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-3))',
        }}
      >
        {meta}
      </span>
    </div>
  );
}

/**
 * One value read against its whole. On the desktop it is a dry sand stroke
 * as long as the value over scattered grains for what is left
 * (materials.css `.sand-stroke`, `.sand-track`).
 */
export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  if (sandPanel()) {
    return (
      <div className="sand-track">
        <span className="sand-stroke" style={{ width, '--sand-c': color } as CSSProperties} />
      </div>
    );
  }
  return (
    <div
      style={{
        height: 4,
        background: 'hsl(var(--rule))',
        borderRadius: 2,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width,
          height: '100%',
          background: color || 'hsl(var(--accent))',
          transition: 'width 0.25s ease',
        }}
      />
    </div>
  );
}

export interface StackedSegment {
  key: string;
  /** Share of the bar, 0–100. */
  pct: number;
  color: string;
  /** The stroke's colour on the desktop when it differs (completion is ink). */
  sandColor?: string;
  /** How much sand the stroke holds on the desktop: a draft is dry, what is
   *  still to write loose grains. */
  density?: 'dry' | 'loose';
  /** Mobile fallback: the segment's strength. */
  opacity?: number;
  title?: string;
}

/** Parts of a whole side by side: acts, or chapters by writing status. */
export function StackedBar({ segments, marginBottom = 8 }: { segments: StackedSegment[]; marginBottom?: number }) {
  if (sandPanel()) {
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
  return (
    <div
      style={{
        display: 'flex',
        height: 5,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'hsl(var(--rule))',
        marginBottom,
      }}
    >
      {segments.map((segment) => (
        <div
          key={segment.key}
          title={segment.title}
          style={{ width: `${segment.pct}%`, background: segment.color, opacity: segment.opacity }}
        />
      ))}
    </div>
  );
}

/** A line of small index type under a readout, or the "and N more" after a list. */
export function StatsCaption({ children, more = false }: { children: ReactNode; more?: boolean }) {
  if (sandPanel()) {
    return <div className={`stats-caption${more ? ' stats-caption--more' : ''}`}>{children}</div>;
  }
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: more ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-3))',
        ...(more ? { padding: '6px 2px 0' } : { lineHeight: 1.7 }),
      }}
    >
      {children}
    </div>
  );
}

export function MetaGrid({ children }: { children: ReactNode }) {
  if (sandPanel()) return <div className="stats-meta">{children}</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '6px 12px' }}>
      {children}
    </div>
  );
}

export function MetaK({ children }: { children: ReactNode }) {
  if (sandPanel()) return <div className="stats-meta__key">{children}</div>;
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'hsl(var(--ink-4))',
        paddingTop: 1,
      }}
    >
      {children}
    </div>
  );
}

export function MetaV({ children }: { children: ReactNode }) {
  if (sandPanel()) return <div className="stats-meta__value">{children}</div>;
  return (
    <div
      style={{
        fontSize: 12,
        color: 'hsl(var(--ink-2))',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {children}
    </div>
  );
}

export function DetailValue({ children }: { children: ReactNode }) {
  if (sandPanel()) return <span className="stats-detail">{children}</span>;
  return (
    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontStyle: 'italic' }}>
      {children}
    </span>
  );
}

export function Dot({ color }: { color?: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: 2,
        background: color || 'hsl(var(--ink-3))',
        display: 'inline-block',
      }}
    />
  );
}

export function Notes({ children }: { children: ReactNode }) {
  if (sandPanel()) return <div className="stats-note">{children}</div>;
  return (
    <div
      style={{
        fontFamily: 'var(--font-sans)',
        fontStyle: 'italic',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'hsl(var(--ink-2))',
        padding: '8px 10px',
        background: 'hsl(var(--ink-1) / 0.03)',
        borderRadius: 'var(--radius-xs)',
      }}
    >
      {children}
    </div>
  );
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
 * editor / cell context menus deliberately don't carry it). On the desktop
 * it is a secondary button: the resting glass line, drifting under the pointer.
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
  if (sandPanel()) {
    return (
      <button
        type="button"
        className="stats-snapshot glass glass--rest"
        onClick={open}
        title={t('rightSidebar.stats.snapshotTitle')}
      >
        <BrushIcon name="rotate" size={12} />
        {t('rightSidebar.stats.snapshotButton')}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      title={t('rightSidebar.stats.snapshotTitle')}
      style={{
        width: '100%',
        marginTop: 14,
        padding: '7px 10px',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 4,
        background: 'transparent',
        color: 'hsl(var(--ink-2))',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.06em',
        cursor: 'pointer',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--rule) / 0.3)';
        e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'hsl(var(--ink-2))';
      }}
    >
      <BrushIcon name="rotate" size={10} inline /> {t('rightSidebar.stats.snapshotButton')}
    </button>
  );
}
