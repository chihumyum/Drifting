/** Canonical authored node seed. Membership is journaled as a separate OR-set. */
export function buildNodeCreateSyncPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...payload };
}
