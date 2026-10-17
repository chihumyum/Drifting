import { useMemo } from 'react';
import { useAgentActivityStore, type ActivityMark } from '../store/agent-activity-store';
import { useAgentEditStore, type PendingEntityEdits, type AgentAddedEntity } from '../store/agent-edit-store';

/** Includes persisted editor presentation after a renderer reload. */
export function collectAgentUnreadMarks(
  touched: Record<string, ActivityMark>,
  pending: Record<string, PendingEntityEdits>,
  additions: Record<string, AgentAddedEntity>,
): Record<string, ActivityMark> {
  const marks = { ...touched };
  for (const [key, entry] of Object.entries(pending)) {
    if (entry.changes.length > 0) {
      marks[key] = { entityType: entry.entityType, id: entry.id, op: 'write' };
    }
  }
  for (const [key, entry] of Object.entries(additions)) {
    marks[key] = { entityType: entry.entityType, id: entry.id, op: 'create' };
  }
  return marks;
}

export function useAgentUnreadMarks() {
  const touched = useAgentActivityStore((state) => state.touched);
  const pending = useAgentEditStore((state) => state.pending);
  const additions = useAgentEditStore((state) => state.additions);
  return useMemo(() => collectAgentUnreadMarks(touched, pending, additions), [touched, pending, additions]);
}
