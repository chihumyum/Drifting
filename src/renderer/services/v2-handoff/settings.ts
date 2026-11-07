// The author's preferences live in WebView storage, which the 0.2 desktop
// program cannot open. The handoff copies the preference and layout keys
// into the library's handoff stamp. Allowlist only: session tokens, the
// Hosted profile, diagnostics, updater state, the preference-sync ledger and
// transient run state never leave WebView storage (docs/v2-handoff.md).

/** Persisted stores and single-value preferences, by exact key. */
export const V2_HANDOFF_SETTINGS_KEYS: readonly string[] = [
  'settings-storage',
  'shortcuts-storage',
  'ui-storage',
  'sidebar-panel-preferences',
  'recent-entities-storage',
  'project-checkin',
  'project-organize',
  'graph-view-mode',
  'timeline-view',
  'timeline-total-height',
  'timeline-expanded-scale',
  'super-element-view:island-width',
  'super-memo-material:rail-widths',
  'shelf:cover-style',
  'drifting.manuscriptExport.v1',
  'drifting.markdown-folder-guide.v2',
];

/** Per-book or per-chapter layout and seen-guide flags, by key prefix. */
export const V2_HANDOFF_SETTINGS_PREFIXES: readonly string[] = [
  'super-element-view:relate:',
  'super-element-view:viewport:',
  'plot-grid-cell-ratio:',
  'drifting:edge-kind-meta:',
  'drifting.alpha-guide.',
];

export function isV2HandoffSettingsKey(key: string): boolean {
  return V2_HANDOFF_SETTINGS_KEYS.includes(key) || V2_HANDOFF_SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The allowlisted entries of `storage`, or null when storage is unavailable. */
export function captureV2HandoffSettings(
  storage: Storage | null | undefined = globalThis.localStorage,
): Record<string, string> | null {
  if (!storage) return null;
  try {
    const entries: Record<string, string> = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !isV2HandoffSettingsKey(key)) continue;
      const value = storage.getItem(key);
      if (value !== null) entries[key] = value;
    }
    return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    return null;
  }
}
