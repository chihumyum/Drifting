import type { WorkspaceTarget } from './workspace-target';

export function workspaceUrlFor(projectId: string, target: WorkspaceTarget): string | null {
  switch (target.entityType) {
    case 'node':
      return `/project/${projectId}/editor/${target.id}`;
    case 'storyline':
      return `/project/${projectId}/editor/storyline/${target.id}`;
    case 'element':
      return `/project/${projectId}/element/${target.id}`;
    case 'category':
      return `/project/${projectId}/category/${encodeURIComponent(target.id)}`;
    case 'dashboard':
      return `/project/${projectId}/home`;
    case 'all-chapters':
      return `/project/${projectId}/editor/all`;
    default:
      return null;
  }
}

export function workspaceTargetFromPathname(
  projectId: string,
  pathname: string,
): WorkspaceTarget | null {
  const root = `/project/${projectId}`;
  if (!pathname.startsWith(root)) return null;
  const rest = pathname.slice(root.length).replace(/^\/+|\/+$/g, '');
  if (rest === 'home') return { entityType: 'dashboard', id: 'self' };
  if (rest === 'editor/all') return { entityType: 'all-chapters', id: 'self' };
  if (rest.startsWith('editor/storyline/')) {
    return {
      entityType: 'storyline',
      id: decodeURIComponent(rest.slice('editor/storyline/'.length)),
    };
  }
  if (rest.startsWith('editor/')) {
    return { entityType: 'node', id: decodeURIComponent(rest.slice('editor/'.length)) };
  }
  if (rest.startsWith('element/')) {
    return { entityType: 'element', id: decodeURIComponent(rest.slice('element/'.length)) };
  }
  if (rest.startsWith('category/')) {
    return { entityType: 'category', id: decodeURIComponent(rest.slice('category/'.length)) };
  }
  return null;
}
