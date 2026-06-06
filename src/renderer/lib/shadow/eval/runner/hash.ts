/**
 * Stable content hash — key-sorted stringify → djb2 (same hash family as
 * shadow-rules' hashRuleContent). No `canonicalize` dependency (the repo has none).
 * Hashing the RESOLVED EvalProject (incl. vault-read prose) means a bodySource
 * manuscript edit changes the hash — closing the "vault md silently changed" gap.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function contentHash(v: unknown): string {
  const s = stableStringify(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}
