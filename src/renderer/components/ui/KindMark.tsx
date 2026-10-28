import type { CSSProperties } from 'react';
import type { KindMarkKind } from './kind-mark';

/**
 * The sand mark of each kind of thing that can open as a tab, the same in
 * every list and in the tab dots: chapter = round seal, element = square
 * seal, storyline = short dash, element category = corner, drift = small
 * eddy, drift group = wave, material = upright slip, the whole book = star.
 * Shapes are alpha masks (materials.css `.kind-mark`).
 */
const SHAPE: Record<Exclude<KindMarkKind, 'chapter'>, string> = {
  element: 'square',
  storyline: 'dash',
  category: 'corner',
  drift: 'spiral',
  'drift-group': 'wave',
  material: 'slip',
  all: 'star',
};

/** Chapters press one of six seals, always the same one for the same chapter. */
function sealOf(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  return `blob-${Math.abs(hash) % 6}`;
}

export function KindMark({
  kind,
  color,
  seed = '',
  loose = false,
  hollow = false,
  busy = false,
  title,
  className,
}: {
  kind: KindMarkKind;
  /** Pigment: the storyline's or category's colour; muted ink when it has none. */
  color?: string;
  /** Picks a chapter's seal. */
  seed?: string;
  /** A drift outside any group is drawn fainter. */
  loose?: boolean;
  /** Only the rim of the mark: a tab still in preview. */
  hollow?: boolean;
  /** Agent working on it: the mark takes the accent and pulses. */
  busy?: boolean;
  title?: string;
  className?: string;
}) {
  const shape = kind === 'chapter' ? sealOf(seed) : SHAPE[kind];
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={[
        'kind-mark',
        `kind-mark--${kind}`,
        loose ? 'kind-mark--loose' : '',
        hollow ? 'kind-mark--hollow' : '',
        busy ? 'agent-glyph-busy' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      style={{ '--sand-c': busy ? 'hsl(var(--accent))' : color } as CSSProperties}
    >
      <i className={`sand sand--${shape}`} />
    </span>
  );
}
