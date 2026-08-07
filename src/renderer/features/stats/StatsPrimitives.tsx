import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

// ─────────────────────────────────────────────────────────────────────────────
// Small shared bits

// Draggable separator between the content / agent columns in dual-column mode.
// Visually just a 1px hairline (same weight as a normal column border, no
// filled bar / backdrop). The element is wider for a comfortable grab target
// but transparent, with negative margins so it nets ~1px of layout width —
// the columns sit flush against the hairline.
export function StatsSection({
  title,
  topBorder,
  children,
}: {
  title: string;
  topBorder?: boolean;
  children: ReactNode;
}) {
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

/** Navigable row shared by act, element, and storyline statistics. */
export function StatsLinkRow({
  name,
  color,
  meta,
  onOpen,
  title,
}: {
  name: string;
  color?: string;
  meta?: string;
  onOpen: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
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

export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
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
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: '100%',
          background: color || 'hsl(var(--accent))',
          transition: 'width 0.25s ease',
        }}
      />
    </div>
  );
}

export function MetaGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '6px 12px' }}>
      {children}
    </div>
  );
}

export function MetaK({ children }: { children: ReactNode }) {
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
