// The token is safe to keep in an immutable RunState. The membership collection
// is private and never exposed as a React snapshot or a persisted journal cursor.
declare const scopeBrand: unique symbol;
export type AgentChatJournalScope = Readonly<{ [scopeBrand]: true }>;

const memberships = new WeakMap<AgentChatJournalScope, Set<string>>();

/** A run owns one scope across continuations and transport rebinding. */
export function createAgentChatJournalScope(eventIds: Iterable<string> = []): AgentChatJournalScope {
  const scope = Object.freeze({}) as AgentChatJournalScope;
  memberships.set(scope, new Set(eventIds));
  return scope;
}

export function hasAgentChatJournalEvent(scope: AgentChatJournalScope, eventId: string): boolean {
  return memberships.get(scope)?.has(eventId) ?? false;
}

/** Commit only after a projection succeeds, before publishing its new snapshot. */
export function rememberAgentChatJournalEvent(scope: AgentChatJournalScope, eventId: string): void {
  const membership = memberships.get(scope);
  if (!membership) throw new Error('Unknown Agent chat journal scope');
  membership.add(eventId);
}

// No count-based eviction: durable and transient IDs can still be replayed
// during this run. Dropping the run/recovery generation drops its token and
// permits collection. Retained conversations still use O(events) memory.
