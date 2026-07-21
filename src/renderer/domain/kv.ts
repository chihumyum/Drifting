// Shared KV (key/value) facts shape used across Project / Storyline /
// BookElement and the *_template_kv_json fields on Project / Storyline /
// BookElementCategory. Stored on entities as a JSON-stringified array so
// row ordering is preserved and duplicate keys (mid-edit) don't collide.
//
// Always JSON-serialize via stringifyKv / parseKv so callers don't have to
// guess what a malformed legacy row should look like — parseKv treats any
// non-array / non-object input as an empty list.

export interface KvEntry {
  key: string;
  value: string;
}

export type KvList = KvEntry[];

export const EMPTY_KV_JSON = '[]';

export function parseKv(raw: string | null | undefined): KvList {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const key = typeof (row as KvEntry).key === 'string' ? (row as KvEntry).key : '';
        const value = typeof (row as KvEntry).value === 'string' ? (row as KvEntry).value : '';
        return { key, value };
      })
      .filter((row): row is KvEntry => row !== null);
  } catch {
    return [];
  }
}

export function stringifyKv(list: KvList): string {
  // Drop fully-empty rows so the persisted shape stays clean — users tend to
  // leave a trailing blank row in the editor and we don't want it round-tripped.
  const cleaned = list.filter((row) => row.key.trim() !== '' || row.value.trim() !== '');
  return JSON.stringify(cleaned);
}

// Default KV seeded into a freshly-created Project. The user can add to /
// remove from this list freely after creation. These project-level facts double
// as writing-agent governing metadata (style/voice/length constraints), so the
// keys (文风 / 写作人称 / 章节目标字数) are seeded here as ready-to-fill prompts.
export function defaultProjectKvList(): KvList {
  return [
    { key: '本书目标', value: '' },
    { key: '文风', value: '' },
    { key: '写作人称', value: '' },
    { key: '章节目标字数', value: '' },
    { key: '写法', value: '' },
    { key: '对标作品', value: '' },
  ];
}

export function defaultProjectKvJson(): string {
  return stringifyKv(defaultProjectKvList());
}
