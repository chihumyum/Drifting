// Drifting location links: a file-system-style address for a passage of
// authored prose, modeled on the read-only Markdown projection. Every prose
// entity has a canonical `prose.md` view whose block N occupies line 2N-1.
// read_chapter and exact search share this numbering; the Obsidian disk format
// adapts links and adds metadata/block anchors, so its physical lines differ.
//
//   drifting:chapters/<title | id-<id>>/prose.md#L12-L18      document / Agent form
//   drifting://open/<projectId>/chapters/id-<id>/prose.md#L12  operating-system form
//
// Line numbers are only an input and display coordinate: inserting a paragraph
// above would silently retarget a stored "line 12". A resolved link is stored as
// an entityLink mark with stable entity and block ids, and every reader renders
// the current name and line numbers again (see docs/location-links.md).

export const LOCATION_LINK_SCHEME = 'drifting:';
export const LOCATION_OPEN_PREFIX = 'drifting://open/';

export const LOCATION_GROUPS = ['chapters', 'drifts', 'elements', 'categories', 'storylines'] as const;
export type LocationGroup = (typeof LOCATION_GROUPS)[number];
export type LocationTargetKind = 'node' | 'element' | 'category' | 'storyline';

export interface ParsedLocationHref {
  /** Only the operating-system form names a project. */
  projectId: string | null;
  group: LocationGroup;
  /** Decoded display name, or the entity id when `byId`. */
  reference: string;
  byId: boolean;
  startLine: number | null;
  endLine: number | null;
  /** The drifting: scheme, as opposed to a projection-relative file path. */
  explicit: boolean;
}

/** The entityLink attributes a resolved location link is stored as. */
export interface EntityLocationAttrs {
  targetKind: LocationTargetKind;
  targetId: string;
  targetBlockId: string | null;
  targetEndBlockId: string | null;
}

export interface LocationEntity {
  kind: LocationTargetKind;
  id: string;
  group: LocationGroup;
  name: string;
}

export interface LocationCatalog {
  projectId?: string;
  entities: readonly LocationEntity[];
  /** Ordered top-level block ids of a loaded body; undefined when not loaded. */
  blockIds(kind: LocationTargetKind, id: string): readonly (string | null)[] | undefined;
}

export type LocationResolution =
  | { ok: true; attrs: EntityLocationAttrs; entity: LocationEntity }
  | { ok: false; error: string };

export interface LocationResolver {
  /** Current href for a stored deep link; null when the target entity is gone. */
  format(attrs: EntityLocationAttrs): string | null;
  /** Null when `href` is not a location link at all. */
  resolve(href: string): LocationResolution | null;
  /** Resolve the entity named by a parsed href without consulting lines. */
  entity(parsed: ParsedLocationHref): LocationEntity | { error: string };
}

const GROUP_KIND: Record<LocationGroup, LocationTargetKind> = {
  chapters: 'node',
  drifts: 'node',
  elements: 'element',
  categories: 'category',
  storylines: 'storyline',
};

const GROUP_LABEL: Record<LocationGroup, string> = {
  chapters: 'chapter',
  drifts: 'idea',
  elements: 'element',
  categories: 'category',
  storylines: 'storyline',
};

const BODY_FILE = /^(?:prose|body|index)\.md$/iu;
const LINE_FRAGMENT = /^L(\d+)(?:-L?(\d+))?$/iu;

export function locationGroupKind(group: LocationGroup): LocationTargetKind {
  return GROUP_KIND[group];
}

/** Block N (0-based index) begins on line 2N+1; blank separator lines snap up. */
export function lineToBlockIndex(line: number): number {
  return Math.ceil(line / 2) - 1;
}

export function blockIndexToLine(index: number): number {
  return index * 2 + 1;
}

export function isExplicitLocationHref(href: string): boolean {
  return href.trim().toLowerCase().startsWith(LOCATION_LINK_SCHEME);
}

/**
 * Accepts the drifting: forms and projection-relative paths such as
 * `../../chapters/id-x/prose.md#L3` or `project/elements/id-y/index.md`. Elements
 * may also use the Agent workspace's `elements/<category>/<name>/body.md`.
 */
export function parseLocationHref(href: string): ParsedLocationHref | null {
  const raw = href.trim();
  if (!raw) return null;
  const explicit = isExplicitLocationHref(raw);
  let rest = explicit ? raw.slice(LOCATION_LINK_SCHEME.length) : raw;
  if (!explicit && /^[a-z][a-z0-9+.-]*:/iu.test(rest)) return null;
  const hashAt = rest.indexOf('#');
  const fragment = hashAt >= 0 ? rest.slice(hashAt + 1) : '';
  rest = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  if (rest.includes('?')) return null;

  let segments = rest.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!explicit) while (segments[0] === '..') segments = segments.slice(1);
  if (segments.includes('..')) return null;
  let projectId: string | null = null;
  if (explicit && segments[0] === 'open') {
    if (segments.length < 2) return null;
    projectId = decodeSegment(segments[1]!);
    segments = segments.slice(2);
  }
  if (segments[0] === 'project') segments = segments.slice(1);
  const group = segments[0] as LocationGroup;
  if (!(LOCATION_GROUPS as readonly string[]).includes(group)) return null;
  let middle = segments.slice(1);
  const last = middle[middle.length - 1];
  if (last && BODY_FILE.test(last)) middle = middle.slice(0, -1);
  else if (!explicit) return null; // a bare relative folder is not a projection file
  const allowed = group === 'elements' ? [1, 2] : [1];
  if (!allowed.includes(middle.length)) return null;
  const segment = middle[middle.length - 1]!;

  let startLine: number | null = null;
  let endLine: number | null = null;
  if (fragment) {
    const match = LINE_FRAGMENT.exec(fragment);
    if (!match) return null;
    startLine = Number(match[1]);
    endLine = match[2] === undefined ? null : Number(match[2]);
    if (!Number.isSafeInteger(startLine) || startLine < 1) return null;
    if (endLine !== null && (!Number.isSafeInteger(endLine) || endLine < startLine)) return null;
    if (endLine === startLine) endLine = null;
  }
  const byId = segment.startsWith('id-');
  return {
    projectId,
    group,
    reference: decodeSegment(byId ? segment.slice(3) : segment),
    byId,
    startLine,
    endLine,
    explicit,
  };
}

export function formatLocationHref(input: {
  group: LocationGroup;
  /** Already encoded with {@link locationNameSegment} or {@link locationIdSegment}. */
  segment: string;
  startLine?: number | null;
  endLine?: number | null;
  projectId?: string | null;
}): string {
  const fragment =
    input.startLine == null
      ? ''
      : input.endLine != null && input.endLine > input.startLine
        ? `#L${input.startLine}-L${input.endLine}`
        : `#L${input.startLine}`;
  const prefix = input.projectId
    ? `${LOCATION_OPEN_PREFIX}${encodeURIComponent(input.projectId)}/`
    : LOCATION_LINK_SCHEME;
  return `${prefix}${input.group}/${input.segment}/prose.md${fragment}`;
}

/** The project-relative document form of a parsed href, keeping its reference. */
export function canonicalLocationHref(parsed: ParsedLocationHref): string {
  return formatLocationHref({
    group: parsed.group,
    segment: parsed.byId ? locationIdSegment(parsed.reference) : locationNameSegment(parsed.reference),
    startLine: parsed.startLine,
    endLine: parsed.endLine,
  });
}

/** Same escapes as the Agent workspace paths, plus the URI delimiters. */
export function locationNameSegment(name: string): string {
  return name
    .replaceAll('%', '%25')
    .replaceAll('/', '%2F')
    .replaceAll('\\', '%5C')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F');
}

export function locationIdSegment(id: string): string {
  return `id-${encodeURIComponent(id)}`;
}

/** Readable label for tool output: `chapters/雨夜 L11-L13`. */
export function describeLocationHref(href: string): string | null {
  const parsed = parseLocationHref(href);
  if (!parsed) return null;
  const reference = parsed.byId ? `id-${parsed.reference}` : parsed.reference;
  const lines =
    parsed.startLine == null
      ? ''
      : parsed.endLine == null
        ? ` L${parsed.startLine}`
        : ` L${parsed.startLine}-L${parsed.endLine}`;
  return `${parsed.group}/${reference}${lines}`;
}

export function createLocationResolver(catalog: LocationCatalog): LocationResolver {
  const byKey = new Map<string, LocationEntity>();
  const byGroupName = new Map<string, LocationEntity[]>();
  for (const entity of catalog.entities) {
    byKey.set(entityKey(entity.kind, entity.id), entity);
    const nameKey = `${entity.group}\u0000${entity.name.trim()}`;
    const named = byGroupName.get(nameKey);
    if (named) named.push(entity);
    else byGroupName.set(nameKey, [entity]);
  }

  const segmentFor = (entity: LocationEntity): string => {
    const name = entity.name.trim();
    const unique = byGroupName.get(`${entity.group}\u0000${name}`)?.length === 1;
    // An empty, duplicated or id-shaped title would not resolve back to this
    // entity, so it falls back to the stable projection directory name.
    return name && unique && name === entity.name && !name.startsWith('id-')
      ? locationNameSegment(name)
      : locationIdSegment(entity.id);
  };

  const entity = (parsed: ParsedLocationHref): LocationEntity | { error: string } => {
    const label = GROUP_LABEL[parsed.group];
    if (parsed.projectId && catalog.projectId && parsed.projectId !== catalog.projectId) {
      return { error: `The link points to another project (${parsed.projectId})` };
    }
    if (parsed.byId) {
      const found = byKey.get(entityKey(GROUP_KIND[parsed.group], parsed.reference));
      if (found && found.group === parsed.group) return found;
    }
    const name = parsed.byId ? `id-${parsed.reference}` : parsed.reference;
    const named = byGroupName.get(`${parsed.group}\u0000${name.trim()}`) ?? [];
    if (named.length === 1) return named[0]!;
    if (named.length > 1) {
      return { error: `${named.length} ${label}s are named "${name}"; use the id-<id> path from the projection` };
    }
    return { error: `No ${label} named "${name}"` };
  };

  return {
    entity,
    format(attrs) {
      const target = byKey.get(entityKey(attrs.targetKind, attrs.targetId));
      if (!target) return null;
      const segment = segmentFor(target);
      if (!attrs.targetBlockId) return formatLocationHref({ group: target.group, segment });
      const blocks = catalog.blockIds(target.kind, target.id) ?? [];
      const start = blocks.indexOf(attrs.targetBlockId);
      // The cited paragraph was deleted: the link still opens its entity.
      if (start < 0) return formatLocationHref({ group: target.group, segment });
      const end = attrs.targetEndBlockId ? blocks.indexOf(attrs.targetEndBlockId) : -1;
      return formatLocationHref({
        group: target.group,
        segment,
        startLine: blockIndexToLine(start),
        endLine: end > start ? blockIndexToLine(end) : null,
      });
    },
    resolve(href) {
      const parsed = parseLocationHref(href);
      if (!parsed) return null;
      const found = entity(parsed);
      if ('error' in found) return { ok: false, error: found.error };
      const base = { targetKind: found.kind, targetId: found.id };
      if (parsed.startLine == null) {
        return { ok: true, entity: found, attrs: { ...base, targetBlockId: null, targetEndBlockId: null } };
      }
      const blocks = catalog.blockIds(found.kind, found.id);
      if (!blocks) return { ok: false, error: `The body of "${found.name}" is not available` };
      const totalLines = Math.max(1, blockIndexToLine(blocks.length - 1));
      const lastLine = parsed.endLine ?? parsed.startLine;
      if (blocks.length === 0 || lastLine > totalLines) {
        return { ok: false, error: `"${found.name}" has lines 1–${totalLines}; line ${lastLine} does not exist` };
      }
      const start = lineToBlockIndex(parsed.startLine);
      const end = lineToBlockIndex(lastLine);
      const startId = blocks[start];
      const endId = end > start ? blocks[end] : null;
      if (!startId || endId === undefined) {
        return { ok: false, error: `Line ${parsed.startLine} of "${found.name}" has no stable paragraph id yet` };
      }
      return {
        ok: true,
        entity: found,
        attrs: { ...base, targetBlockId: startId, targetEndBlockId: endId ?? null },
      };
    },
  };
}

/** A stored entityLink attribute bag that carries a paragraph anchor. */
export function entityLocationAttrs(value: unknown): EntityLocationAttrs | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.targetKind;
  if (kind !== 'node' && kind !== 'element' && kind !== 'category' && kind !== 'storyline') return null;
  if (typeof record.targetId !== 'string' || !record.targetId) return null;
  if (typeof record.targetBlockId !== 'string' || !record.targetBlockId) return null;
  return {
    targetKind: kind,
    targetId: record.targetId,
    targetBlockId: record.targetBlockId,
    targetEndBlockId:
      typeof record.targetEndBlockId === 'string' && record.targetEndBlockId ? record.targetEndBlockId : null,
  };
}

/** y-prosemirror stores overlapping marks as `entityLink--<hash>`. */
export function isEntityLinkMarkKey(key: string): boolean {
  return key === 'entityLink' || key.startsWith('entityLink--');
}

/** Top-level block ids of a TipTap document, in order. */
export function contentJsonBlockIds(contentJson: string | unknown): Array<string | null> {
  let doc: unknown = contentJson;
  if (typeof contentJson === 'string') {
    try {
      doc = JSON.parse(contentJson);
    } catch {
      return [];
    }
  }
  const content = (doc as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  return content.map((node) => {
    const id = (node as { attrs?: { id?: unknown } } | null)?.attrs?.id;
    return typeof id === 'string' && id ? id : null;
  });
}

/** Every anchored entityLink in a TipTap document. */
export function contentJsonLocationTargets(contentJson: string | unknown): EntityLocationAttrs[] {
  let doc: unknown = contentJson;
  if (typeof contentJson === 'string') {
    try {
      doc = JSON.parse(contentJson);
    } catch {
      return [];
    }
  }
  const found: EntityLocationAttrs[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as { marks?: unknown; content?: unknown };
    if (Array.isArray(record.marks)) {
      for (const mark of record.marks) {
        const typed = mark as { type?: unknown; attrs?: unknown } | null;
        if (typed?.type !== 'entityLink') continue;
        const attrs = entityLocationAttrs(typed.attrs);
        if (attrs) found.push(attrs);
      }
    }
    if (Array.isArray(record.content)) record.content.forEach(visit);
  };
  visit(doc);
  return found;
}

/** Anchored link texts and their current hrefs, for plain-text reads. */
export function contentJsonLocationLinks(
  contentJson: string | unknown,
  locations: Pick<LocationResolver, 'format'>,
): Array<{ text: string; href: string }> {
  let doc: unknown = contentJson;
  if (typeof contentJson === 'string') {
    try {
      doc = JSON.parse(contentJson);
    } catch {
      return [];
    }
  }
  const links: Array<{ text: string; href: string }> = [];
  let previous: { text: string; href: string } | null = null;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as { type?: unknown; text?: unknown; marks?: unknown; content?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') {
      const attrs = Array.isArray(record.marks)
        ? record.marks
            .map((mark) => ((mark as { type?: unknown })?.type === 'entityLink' ? entityLocationAttrs((mark as { attrs?: unknown }).attrs) : null))
            .find((value) => value !== null) ?? null
        : null;
      const href = attrs ? locations.format(attrs) : null;
      if (!href) {
        previous = null;
      } else if (previous && previous.href === href) {
        previous.text += record.text;
      } else {
        previous = { text: record.text, href };
        links.push(previous);
      }
      return;
    }
    previous = null;
    if (Array.isArray(record.content)) record.content.forEach(visit);
    previous = null;
  };
  visit(doc);
  return links.map((link) => ({ text: link.text, href: readableLocationHref(link.href) }));
}

/** Decoded href for tool output: `drifting:chapters/The Rain/prose.md#L3`. */
export function readableLocationHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/** Destinations of Markdown links that look like location links. */
export function markdownLocationHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) {
    const href = match[1]!;
    if (parseLocationHref(href)) hrefs.push(href);
  }
  return hrefs;
}

function entityKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
