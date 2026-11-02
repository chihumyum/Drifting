/**
 * The shelf's cover styles, in the order the shelf's button turns through
 * them. Sand is drawn as masks coloured in CSS (lib/sand-cover.ts); every
 * other style paints the whole cover (styles/*).
 */
import type { ArtStyle } from './book';
import { bauhaus } from './styles/bauhaus';
import { chars } from './styles/chars';
import { cutout } from './styles/cutout';
import { cyanotype } from './styles/cyanotype';
import { field } from './styles/field';
import { quipu } from './styles/quipu';
import { ridge } from './styles/ridge';
import { rings } from './styles/rings';
import { riso } from './styles/riso';
import { stars } from './styles/stars';
import { strata } from './styles/strata';
import { topo } from './styles/topo';
import { weave } from './styles/weave';

export const COVER_STYLES = [
  'sand',
  'ridge',
  'quipu',
  'weave',
  'topo',
  'cyanotype',
  'rings',
  'field',
  'cutout',
  'riso',
  'stars',
  'strata',
  'bauhaus',
  'chars',
] as const;

export type CoverStyleId = (typeof COVER_STYLES)[number];
export type ArtStyleId = Exclude<CoverStyleId, 'sand'>;

export const DEFAULT_COVER_STYLE: CoverStyleId = 'topo';

export const ART_STYLES: Record<ArtStyleId, ArtStyle> = {
  ridge,
  quipu,
  weave,
  topo,
  cyanotype,
  rings,
  field,
  cutout,
  riso,
  stars,
  strata,
  bauhaus,
  chars,
};

/** Styles that set type: they draw where the page's fonts are, never in a worker. */
export const TYPE_STYLES: ReadonlySet<CoverStyleId> = new Set(['chars']);

export function isCoverStyle(value: unknown): value is CoverStyleId {
  return typeof value === 'string' && (COVER_STYLES as readonly string[]).includes(value);
}

export function nextCoverStyle(style: CoverStyleId): CoverStyleId {
  return COVER_STYLES[(COVER_STYLES.indexOf(style) + 1) % COVER_STYLES.length];
}
