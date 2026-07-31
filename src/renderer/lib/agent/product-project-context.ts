import { parseKv } from '../../domain/kv';
import type { Project } from '../../domain/project';
import type { AgentStartInput } from './protocol';

export type GeneralAgentProjectContext = Pick<
  AgentStartInput,
  'projectName' | 'projectFacts'
>;

/**
 * Assemble author-visible project context only from the canonical project that
 * owns the turn. A stale project store must not leak another book's name/facts,
 * and an opaque project id is never used as a display-name fallback.
 */
export function buildGeneralAgentProjectContext(
  projectId: string,
  project: Project | null,
): GeneralAgentProjectContext {
  if (!project || project.id !== projectId) {
    return { projectFacts: [] };
  }
  return {
    projectName: project.name,
    projectFacts: parseKv(project.kvJson),
  };
}
