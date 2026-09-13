import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { BookNodeTable, NodeStorylineLinkTable, EntityRelationTable, TimelineMarkerTable } from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { i18next } from '../lib/i18n';

export interface NativeGraphFixture {
  projectId: string;
  placedId: string;
  unplacedId: string;
  driftIds: string[];
  lineIds: string[];
  typeId: string;
  elementId: string;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor<T>(predicate: () => T | Promise<T>, message: string) {
  const start = performance.now();
  while (performance.now() - start < 12000) { const value = await predicate(); if (value) return value; await pause(50); }
  throw new Error(`Native graph: ${message}`);
}

/** Acceptance-only UI driver: all writes originate in mounted product handlers.
 * SQLite reads are observations, never a replacement for a failed UI write. */
export async function runNativeGraphInteractions(fixture: NativeGraphFixture, restart: boolean) {
  const { projectId, placedId, unplacedId, driftIds, lineIds, typeId, elementId } = fixture;
  const checks: Record<string, boolean> = {};
  const ids = [placedId, unplacedId, ...driftIds];
  const snapshot = async () => {
    const db = getDb();
    const nodes = await db.select({ id: BookNodeTable.id, kind: BookNodeTable.kind, bookOrder: BookNodeTable.bookOrder, narrativeOrder: BookNodeTable.narrativeOrder })
      .from(BookNodeTable).where(and(eq(BookNodeTable.projectId, projectId), inArray(BookNodeTable.id, ids))).orderBy(BookNodeTable.id);
    const links = await db.select({ nodeId: NodeStorylineLinkTable.nodeId, storylineId: NodeStorylineLinkTable.storylineId, isPrimary: NodeStorylineLinkTable.isPrimary })
      .from(NodeStorylineLinkTable).where(inArray(NodeStorylineLinkTable.nodeId, ids)).orderBy(NodeStorylineLinkTable.nodeId, NodeStorylineLinkTable.storylineId);
    const relations = await db.select({ id: EntityRelationTable.id, fromKind: EntityRelationTable.fromKind, fromId: EntityRelationTable.fromId, toKind: EntityRelationTable.toKind, toId: EntityRelationTable.toId, relationTypeId: EntityRelationTable.relationTypeId })
      .from(EntityRelationTable).where(and(eq(EntityRelationTable.projectId, projectId), eq(EntityRelationTable.relationTypeId, typeId))).orderBy(EntityRelationTable.id);
    const markers = await db.select({ id: TimelineMarkerTable.id, narrativeOrder: TimelineMarkerTable.narrativeOrder, label: TimelineMarkerTable.label, driftNodeId: TimelineMarkerTable.driftNodeId })
      .from(TimelineMarkerTable).where(eq(TimelineMarkerTable.projectId, projectId)).orderBy(TimelineMarkerTable.id);
    return { nodes, links, relations, markers };
  };
  const title = (id: string) => useDataStore.getState().bookNodes.find(node => node.id === id)?.title;
  const tile = (id: string) => [...document.querySelectorAll<HTMLElement>('.graph-tile')].find(el => el.querySelector('.graph-tile__title')?.textContent === title(id));
  const drift = (index: number) => [...document.querySelectorAll<HTMLElement>('.drift-card')].find(el => el.querySelector('.drift-card__title')?.textContent === title(driftIds[index]));
  const openGraph = async () => {
    useUiStore.getState().setActiveSuperView('graph');
    await waitFor(() => document.querySelector('.graph-overlay'), 'Story Graph mount');
    document.querySelectorAll<HTMLButtonElement>('.graph-head__view-toggle button')[1].click();
    await waitFor(() => document.querySelector('.graph-overlay[data-view="narrative"]'), 'narrative graph');
    await frames();
  };
  const openDrifts = async () => {
    document.querySelector<HTMLButtonElement>('.drift-panel__tab')?.click();
    await waitFor(() => document.querySelector('.drift-card'), 'drift hand mount'); await pause(600);
  };
  const expectCoordinates = async () => {
    const rows = await snapshot();
    return rows.nodes.find(node => node.id === unplacedId)?.narrativeOrder === 2.5
      && rows.nodes.find(node => node.id === placedId)?.narrativeOrder === 4.25
      && [placedId, unplacedId].every(id => rows.links.filter(link => link.nodeId === id).length === 2
        && rows.links.some(link => link.nodeId === id && link.storylineId === lineIds[1] && link.isPrimary)
        && rows.links.some(link => link.nodeId === id && link.storylineId === lineIds[2] && !link.isPrimary));
  };
  const checkPresentation = async () => {
    await waitFor(() => [placedId, unplacedId].every(id => tile(id)?.closest('[data-storyline-row]')?.getAttribute('data-storyline-row') === lineIds[1]), 'restored primary lanes');
    ensure(document.querySelectorAll('.graph-tile').length === 2, 'Native graph placed chapter count changed');
    await openDrifts();
    await waitFor(() => !drift(0) && drift(1), 'bound drift leaves Story Graph hand');
    ensure(document.querySelector('.graph-axis-track-cell')?.textContent?.includes(title(driftIds[0])!) === true, 'Bound marker lost current drift title');
    await waitFor(() => document.querySelectorAll('.graph-drift-edge').length === 1, 'remaining special drift edge');
    document.querySelector<HTMLButtonElement>('.drift-panel__close')!.click(); await pause(400);
    ensure(document.querySelectorAll('.graph-drift-edge').length === 0, 'Closed drift hand left special geometry');
    ensure((await snapshot()).relations.length === 3, 'Closing hand changed durable relations');
  };
  await openGraph();
  if (!restart) {
    const move = async (source: HTMLElement, toLine: string, order: number, pointerId: number, cancel = false) => {
      source.scrollIntoView({ block: 'nearest', inline: 'nearest' }); await frames();
      const rect = source.getBoundingClientRect();
      const starts = [rect.left + 10, rect.right - 10, rect.left + rect.width / 2]
        .flatMap(clientX => [rect.top + 10, rect.bottom - 10, rect.top + rect.height / 2].map(clientY => ({ clientX, clientY })));
      // Narrative cards may overlap at fractional coordinates. Grab an exposed
      // part of this card and preserve that exact offset through the drop.
      const start = starts.find(point => source.contains(document.elementFromPoint(point.clientX, point.clientY)));
      ensure(start, `Native pointer source not hittable: ${JSON.stringify({ pointerId, starts })}`);
      const grabOffsetX = start.clientX - rect.left;
      source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId, pointerType: 'mouse', ...start }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: start.clientX + 8, clientY: start.clientY + 8, cancelable: true }));
      await frames();
      ensure(document.querySelector('.chapter-lane-pointer-ghost'), 'Native pointer never entered drag state');
      // The retained editor's bottom timeline has the same lane IDs. Resolve
      // geometry only in the active full-screen graph, never the covered view.
      const row = document.querySelector<HTMLElement>(`.graph-overlay [data-storyline-row="${CSS.escape(toLine)}"]`)!;
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); await frames();
      const track = row.querySelector<HTMLElement>('[data-node-container]')!.getBoundingClientRect();
      const clientX = track.left + 24 + order * 32 + grabOffsetX;
      const hitsLane = (y: number) => document.elementFromPoint(clientX, y)?.closest('[data-storyline-row]')?.getAttribute('data-storyline-row') === toLine;
      const top = Math.max(0, track.top) + 2; const bottom = Math.min(innerHeight, track.bottom) - 2;
      // A native window can clip the row center or cover it with the holding
      // popover. Use an actually exposed point, preserving the exact x/order.
      const candidates = [Math.min(bottom, Math.max(top, track.top + track.height / 2))];
      for (let y = top; y <= bottom; y += 4) candidates.push(y);
      const clientY = candidates.find(hitsLane);
      ensure(clientY !== undefined, `Native pointer target not hittable: ${JSON.stringify({ pointerId, clientX, top, bottom, viewport: [innerWidth, innerHeight], hits: candidates.map(y => document.elementFromPoint(clientX, y)?.className) })}`);
      const point = { clientX, clientY };
      // Initial narrative origin is zero for both commits. Cancellation is not a coordinate assertion.
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId, ...point, cancelable: true })); await frames();
      ensure(document.elementFromPoint(point.clientX, point.clientY)?.closest('[data-storyline-row]')?.getAttribute('data-storyline-row') === toLine, 'Native pointer target not hittable');
      window.dispatchEvent(new PointerEvent(cancel ? 'pointercancel' : 'pointerup', { pointerId, ...point }));
      await waitFor(() => !document.querySelector('.chapter-lane-pointer-ghost'), 'pointer cleanup'); await pause(50);
    };
    document.querySelector<HTMLButtonElement>('.graph-head__unplaced-btn')!.click();
    const unplaced = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.graph-head__unplaced-chip')].find(el => el.title === title(unplacedId)), 'unplaced chapter chip');
    await move(unplaced, lineIds[1], 2.5, 901);
    await waitFor(async () => (await snapshot()).nodes.find(node => node.id === unplacedId)?.narrativeOrder === 2.5, 'unplaced drop SQLite commit');
    await waitFor(() => tile(unplacedId), 'unplaced chapter becomes a placed card'); checks.unplacedDrop = true;
    await move(tile(placedId)!, lineIds[1], 4.25, 902);
    await waitFor(expectCoordinates, 'placed drop coordinates and primary membership SQLite commit'); checks.placedDrop = true;
    const beforeCancel = JSON.stringify(await snapshot());
    await move(tile(placedId)!, lineIds[0], 6.5, 903, true);
    ensure(JSON.stringify(await snapshot()) === beforeCancel, 'Cancelled pointer changed SQLite structure'); checks.cancelledDrop = true;
    await openDrifts();
    const createRelation = async (source: HTMLElement, target: HTMLElement, modalSelector: string, reverse = false) => {
      source.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); await frames(); target.click();
      const modal = await waitFor(() => document.querySelector<HTMLElement>(modalSelector), 'relation dialog');
      if (reverse) { modal.querySelector<HTMLButtonElement>('.graph-newedge__swap')!.click(); await frames(); }
      modal.querySelector<HTMLButtonElement>('.relation-type-field__button')!.click();
      const option = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('.relation-type-suggestions__option')].find(el => el.textContent?.includes('Synthetic graph link')), 'compatible graph relation type');
      ensure(option.closest('.relation-type-suggestions')?.parentElement === document.body, 'Relation selector lost its body portal');
      option.click(); await frames();
      const confirm = [...modal.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === i18next.t('storyGraph.edge.create'));
      ensure(confirm && !confirm.disabled, 'Typed relation confirmation disabled'); confirm.click();
      await waitFor(() => !document.querySelector(modalSelector), 'relation dialog close');
    };
    // Directed relations cover a drift as either endpoint; the second uses the swap control.
    await createRelation(drift(0)!, tile(placedId)!, '.graph-newedge');
    await createRelation(drift(1)!, tile(unplacedId)!, '.graph-newedge', true);
    await waitFor(async () => (await snapshot()).relations.length === 2, 'Story Graph relation commits');
    await waitFor(() => document.querySelectorAll('.graph-drift-edge').length === 2, 'both special drift edge directions'); checks.storyRelations = true;
    const source = drift(0)!; const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })); await frames();
    const axis = document.querySelector<HTMLElement>('.graph-axis-track-cell')!; const axisRect = axis.getBoundingClientRect();
    axis.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: axisRect.left + 24 + (6.75 - 1) * 32 }));
    await waitFor(async () => { const rows = (await snapshot()).markers; return rows.length === 1 && rows[0].driftNodeId === driftIds[0] && rows[0].narrativeOrder === 6.75 && rows[0].label === ''; }, 'bound Drift marker SQLite commit');
    await waitFor(() => !drift(0), 'bound drift hidden from hand'); checks.driftMarker = true;
    useUiStore.getState().setActiveSuperView('element');
    await waitFor(() => document.querySelector('.super-element-overlay'), 'Super Element mount');
    await openDrifts();
    const element = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(elementId)}"]`)!;
    await createRelation(element, drift(1)!, '.relation-type-create-modal');
    await waitFor(async () => (await snapshot()).relations.length === 3, 'Super Element relation commit');
    await waitFor(() => document.querySelectorAll('.drift-edge').length === 1, 'Super Element special drift relation'); checks.elementRelation = true;
    useUiStore.getState().setActiveSuperView('none'); await waitFor(() => !document.querySelector('.super-element-overlay'), 'element close');
    await openGraph(); await checkPresentation(); checks.specialEdgesHiddenRetained = true;
  } else {
    ensure(await expectCoordinates(), 'Native restart lost chapter coordinates or memberships'); checks.restoredCoordinates = true;
    const rows = await snapshot();
    ensure(rows.relations.length === 3, 'Native restart lost typed relations'); checks.restoredRelations = true;
    ensure(rows.markers.length === 1 && rows.markers[0].driftNodeId === driftIds[0] && rows.markers[0].narrativeOrder === 6.75, 'Native restart lost bound marker'); checks.restoredMarker = true;
    await checkPresentation(); checks.restoredGraphPresentation = true;
  }
  useUiStore.getState().setActiveSuperView('none'); await waitFor(() => !document.querySelector('.graph-overlay'), 'graph close');
  return { fixture, restart, checks, snapshot: await snapshot(), boundary: 'Synthetic PointerEvent/DragEvent and DOM clicks in fresh native WebKit; production handlers and real SQLite, followed by normal Quit/restart. No physical mouse/touch/IME or performance budget.' };
}
