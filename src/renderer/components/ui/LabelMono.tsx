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
      className={[
        'label-mono',
        `label-mono--${size}`,
        `label-mono--${tone}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={title}
      style={style}
    >
      {children}
    </span>
  );
}
