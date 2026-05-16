/**
 * LabelMono — small-caps mono label for section headers, kickers, counters.
 * Used everywhere a Tailwind `label-mono` class isn't convenient.
 */
import type { CSSProperties, ReactNode } from 'react';

interface LabelMonoProps {
  children: ReactNode;
  size?: 'xs' | 'sm';
  tone?: 'ink-3' | 'ink-4' | 'ink-2';
  style?: CSSProperties;
  className?: string;
  title?: string;
}

export function LabelMono({
  children,
  size = 'xs',
  tone = 'ink-3',
  style,
  className,
  title,
}: LabelMonoProps) {
  return (
    <span
      className={className}
      title={title}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: size === 'xs' ? 9.5 : 10.5,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: `hsl(var(--${tone}))`,
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
