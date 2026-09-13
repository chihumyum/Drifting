import type { Emitter } from 'mitt';
import type { BookElement } from '../../domain/book-element';
import { events, type AppEvents } from '../../lib/events';

/** Route one application subscription to the currently attached project owners. */
export function createProjectElementCreatedRegistry(bus: Pick<Emitter<AppEvents>, 'on' | 'off'>) {
  type Owner = { receive(element: BookElement): void };
  const projects = new Map<string, Set<Owner>>();
  let owners = 0;
  const receive = ({ element }: AppEvents['element:element-created']) => {
    const project = projects.get(element.projectId);
    if (!project) return;
    // A callback can detach another owner. A detached owner must not receive
    // this event, and an owner attached during delivery waits for the next one.
    for (const owner of [...project]) if (project.has(owner)) owner.receive(element);
  };
  return {
    attach(projectId: string, callback: Owner['receive']): () => void {
      const owner = { receive: callback };
      const project = projects.get(projectId) ?? new Set<Owner>();
      project.add(owner); projects.set(projectId, project);
      if (owners++ === 0) bus.on('element:element-created', receive);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        project.delete(owner);
        if (project.size === 0) projects.delete(projectId);
        if (--owners === 0) bus.off('element:element-created', receive);
      };
    },
  };
}

export const editorElementCreatedRegistry = createProjectElementCreatedRegistry(events);
