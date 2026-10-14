import { loadLocationResolver } from '../../../lib/agent/location-link-catalog';
import { parseLocationHref } from '../../../lib/location-link';
import { openEntityLinkTarget } from '../../editor/open-entity-link';
import type { WorkspaceNavigator } from './workspace-target';

export type OpenLocationResult = { ok: true } | { ok: false; error: string };

/**
 * Open a drifting: location link that is not stored in a document (an Agent
 * chat message, an operating-system deep link). Its lines resolve against the
 * current prose; when they no longer exist the entity itself still opens.
 */
export async function openLocationHref(
  navigator: Pick<WorkspaceNavigator, 'projectId' | 'open'>,
  href: string,
  load: typeof loadLocationResolver = loadLocationResolver,
): Promise<OpenLocationResult> {
  const parsed = parseLocationHref(href);
  const resolver = parsed ? await load(navigator.projectId, { hrefs: [href] }) : undefined;
  const resolution = resolver?.resolve(href);
  if (!parsed || !resolver || !resolution) return { ok: false, error: `${href} is not a location link` };
  if (resolution.ok) {
    openEntityLinkTarget(navigator.open, resolution.attrs);
    return { ok: true };
  }
  const entity = resolver.entity(parsed);
  if (!('error' in entity)) navigator.open({ entityType: entity.kind, id: entity.id });
  return { ok: false, error: resolution.error };
}
