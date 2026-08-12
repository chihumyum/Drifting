/**
 * Canonical wire-only storyline signal for node CREATE requests.
 *
 * `mainStorylineId` is no longer a `book_node` column, but the server still
 * consumes it while creating the primary `node_storyline_link`. Current
 * producers send either a storyline id or an explicit null; the server keeps
 * omission compatibility only for durable rows written by older producers.
 */
export function buildNodeCreateSyncPayload(
  payload: Record<string, unknown>,
  mainStorylineId: string | null,
): Record<string, unknown> {
  return { ...payload, mainStorylineId };
}

/**
 * Upgrade durable outbox rows written by older or incomplete producers.
 * Preserve an explicit id/null and only default a genuinely absent signal.
 */
export function normalizeNodeCreateSyncPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'mainStorylineId')) {
    return payload;
  }
  return buildNodeCreateSyncPayload(payload ?? {}, null);
}
