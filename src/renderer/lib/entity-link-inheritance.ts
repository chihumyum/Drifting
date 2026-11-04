import { isEntityLinkMarkKey } from './location-link';

type Attributes = Readonly<Record<string, unknown>> | undefined;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

/**
 * The entity links that text written between `before` and `after` in place of
 * `replaced` keeps: those carried by the characters on both sides and by every
 * replaced character. A character respelled inside a linked name stays in the
 * link (安娜蒂 → 安纳蒂 is still one link); text written at a link's edge, or
 * in place of text that was outside it, never joins it.
 *
 * Arguments are Yjs formatting attributes (a text node's marks), keyed the way
 * y-prosemirror stores them (`entityLink` or `entityLink--<hash>`).
 */
export function entityLinksInside(
  before: Attributes,
  after: Attributes,
  replaced: readonly Attributes[],
): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  if (!before || !after) return inherited;
  for (const [key, value] of Object.entries(before)) {
    if (!isEntityLinkMarkKey(key) || value === null || value === undefined) continue;
    const link = canonical(value);
    const carries = (attributes: Attributes) => attributes !== undefined && canonical(attributes[key]) === link;
    if (carries(after) && replaced.every(carries)) inherited[key] = value;
  }
  return inherited;
}
