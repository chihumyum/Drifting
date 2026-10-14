import { useDataStore } from '../../store/data-store';
import type { ProseEntityType } from '../yjs-doc-id';
import {
  contentJsonBlockIds,
  contentJsonLocationTargets,
  createLocationResolver,
  entityLocationAttrs,
  isEntityLinkMarkKey,
  markdownLocationHrefs,
  parseLocationHref,
  type EntityLocationAttrs,
  type LocationEntity,
  type LocationResolver,
  type LocationTargetKind,
} from '../location-link';
import { getEntityContentJson } from './chapter-prose';
import type { YjsProseBlock, YjsProseNode } from './runtime/yjs-prose-command';

export interface LocationLinkSources {
  /** Stored documents whose anchored links will be rendered. */
  contentJson?: readonly string[];
  blocks?: readonly (readonly YjsProseBlock[])[];
  /** Agent Markdown whose new location links will be resolved. */
  markdown?: readonly string[];
  /** Bare hrefs, e.g. a clicked chat link or an operating-system deep link. */
  hrefs?: readonly string[];
}

type LoadContentJson = (kind: ProseEntityType, id: string) => Promise<string>;

/** Live entities of one project that a location link can address. */
export function projectLocationEntities(projectId: string): LocationEntity[] {
  const state = useDataStore.getState();
  const live = (item: { id: string; projectId: string }) =>
    item.projectId === projectId && !state.trashedEntityIds.has(item.id);
  return [
    ...state.bookNodes.filter(live).map((node): LocationEntity => ({
      kind: 'node', id: node.id, group: node.kind === 'drift' ? 'drifts' : 'chapters', name: node.title,
    })),
    ...state.bookElements.filter(live).map((element): LocationEntity => ({
      kind: 'element', id: element.id, group: 'elements', name: element.name,
    })),
    ...state.bookElementCategories.filter(live).map((category): LocationEntity => ({
      kind: 'category', id: category.id, group: 'categories', name: category.name,
    })),
    ...state.storylines.filter(live).map((storyline): LocationEntity => ({
      kind: 'storyline', id: storyline.id, group: 'storylines', name: storyline.name,
    })),
  ];
}

/**
 * Build the resolver for every location link in `sources`, loading only the
 * cited bodies' current paragraph order. Undefined when nothing cites a
 * location, so ordinary reads and writes stay exactly as before.
 */
export async function loadLocationResolver(
  projectId: string,
  sources: LocationLinkSources,
  loadContentJson: LoadContentJson = (kind, id) => getEntityContentJson(kind, id),
): Promise<LocationResolver | undefined> {
  const anchored = [
    ...(sources.contentJson ?? []).flatMap((json) => contentJsonLocationTargets(json)),
    ...(sources.blocks ?? []).flatMap((blocks) => yjsBlockLocationTargets(blocks)),
  ];
  const hrefs = [
    ...(sources.markdown ?? []).flatMap((markdown) => markdownLocationHrefs(markdown)),
    ...(sources.hrefs ?? []).filter((href) => parseLocationHref(href) !== null),
  ];
  if (anchored.length === 0 && hrefs.length === 0) return undefined;

  const entities = projectLocationEntities(projectId);
  const probe = createLocationResolver({ projectId, entities, blockIds: () => undefined });
  const targets = new Map<string, { kind: LocationTargetKind; id: string }>();
  for (const attrs of anchored) targets.set(key(attrs.targetKind, attrs.targetId), { kind: attrs.targetKind, id: attrs.targetId });
  for (const href of hrefs) {
    const parsed = parseLocationHref(href);
    if (!parsed || parsed.startLine == null) continue;
    const found = probe.entity(parsed);
    if (!('error' in found)) targets.set(key(found.kind, found.id), { kind: found.kind, id: found.id });
  }
  const live = new Set(entities.map((entity) => key(entity.kind, entity.id)));
  const blocks = new Map<string, Array<string | null>>();
  await Promise.all([...targets.values()].map(async (target) => {
    if (!live.has(key(target.kind, target.id))) return;
    blocks.set(key(target.kind, target.id), contentJsonBlockIds(await loadContentJson(target.kind, target.id)));
  }));
  return createLocationResolver({
    projectId,
    entities,
    blockIds: (kind, id) => blocks.get(key(kind, id)),
  });
}

function yjsBlockLocationTargets(blocks: readonly YjsProseBlock[]): EntityLocationAttrs[] {
  const found: EntityLocationAttrs[] = [];
  const visit = (nodes: readonly YjsProseNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.kind === 'element') {
        visit(node.content);
        continue;
      }
      for (const [name, value] of Object.entries(node.marks ?? {})) {
        if (!isEntityLinkMarkKey(name)) continue;
        const attrs = entityLocationAttrs(value);
        if (attrs) found.push(attrs);
      }
    }
  };
  for (const block of blocks) visit(block.content);
  return found;
}

function key(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}
