/**
 * Preferences cross-device sync.
 *
 * Architecture: the local Zustand settings store is the source of truth for
 * the running app. This service mirrors a whitelist of those fields to the
 * server's `user_preferences` table.
 *
 * Direction:
 *   - pull on boot (and on demand) — server LWW wins iff its updatedAt
 *     is newer than the client's lastPulledAt cursor.
 *   - push on change — debounced batch upsert (~600ms after last write).
 *
 * Why a whitelist: not every Zustand slice should sync. Things like
 * ephemeral UI state (panel widths, recording-shortcut state) belong on
 * one device only. Secret fields (BYOK keys) never come here — they're
 * in the OS keychain.
 *
 * Conflict resolution: LWW per-key. We send patches with the local value,
 * server stamps timestamp, response is the authoritative bag we merge back.
 */
import { apiClient } from '../lib/axios-config';
import { isSyncEnabled } from '../lib/config';
import { useSettingsStore, type CopilotTaskId } from '../store/settings-store';
import loglevel from 'loglevel';

const log = loglevel.getLogger('prefs-sync');
log.setLevel(loglevel.levels.WARN);

const DEBOUNCE_MS = 600;
const CURSOR_KEY = 'preferences-sync.cursor';

// Whitelist of keys to sync. Adding a key is a one-line change; the server
// is schema-agnostic (JSON blob per key).
//
// Group keys by purpose so it's obvious what each one drives.
type SyncableSlice = {
  // appearance
  themeMode: unknown;
  shadowAffectsTheme: unknown;
  // editor typography
  bodyFontSize: unknown;
  lineHeight: unknown;
  paragraphIndent: unknown;
  maxLineWidth: unknown;
  focusLine: unknown;
  entityHighlight: unknown;
  entityLinkInteractive: unknown;
  autosave: unknown;
  autoElementLinkEnabled: unknown;
  // language
  uiLocale: unknown;
  manuscriptLocale: unknown;
  spellcheck: unknown;
  dateFormat: unknown;
  // intelligence (non-secret). aiMode/byokProvider = copilot routing;
  // agentMode = general-agent/shadow routing. The keys themselves never sync.
  modelTier: unknown;
  aiMode: unknown;
  byokProvider: unknown;
  agentMode: unknown;
  uploadFullManuscript: unknown;
  allowWebSearch: unknown;
  requestTimeoutSec: unknown;
  // shadow agent
  orbCorner: unknown;
  surfaceMode: unknown;
  finishNotify: unknown;
  editPermission: unknown;
  agentCreateElements: unknown;
  agentEditTimeline: unknown;
  agentWebSearch: unknown;
  shadowVoice: unknown;
  shadowSystemPrompt: unknown;
  // copilot tasks
  copilotAutoTrigger: unknown;
  copilotMode: unknown;
  copilotTaskConfigs: unknown;
  copilotGenerateSummaries: unknown;
  copilotSummarySectionSize: unknown;
  copilotOutputLangByProject: unknown;
  // sync / privacy
  wifiOnlySync: unknown;
  autoSnapshot: unknown;
  improveModelsWithManuscripts: unknown;
  sendUsageStats: unknown;
  sendCrashLogs: unknown;
};

const SYNC_KEYS: readonly (keyof SyncableSlice)[] = [
  'themeMode',
  'shadowAffectsTheme',
  'bodyFontSize',
  'lineHeight',
  'paragraphIndent',
  'maxLineWidth',
  'focusLine',
  'entityHighlight',
  'entityLinkInteractive',
  'autosave',
  'autoElementLinkEnabled',
  'uiLocale',
  'manuscriptLocale',
  'spellcheck',
  'dateFormat',
  'modelTier',
  'aiMode',
  'byokProvider',
  'agentMode',
  'uploadFullManuscript',
  'allowWebSearch',
  'requestTimeoutSec',
  'orbCorner',
  'surfaceMode',
  'finishNotify',
  'editPermission',
  'agentCreateElements',
  'agentEditTimeline',
  'agentWebSearch',
  'shadowVoice',
  'shadowSystemPrompt',
  'copilotAutoTrigger',
  'copilotMode',
  'copilotTaskConfigs',
  'copilotGenerateSummaries',
  'copilotSummarySectionSize',
  'copilotOutputLangByProject',
  'wifiOnlySync',
  'autoSnapshot',
  'improveModelsWithManuscripts',
  'sendUsageStats',
  'sendCrashLogs',
] as const;

interface PreferenceEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingKeys: Set<keyof SyncableSlice> = new Set();
let unsubscribeStore: (() => void) | null = null;
let started = false;

function readCursor(): string | null {
  try {
    return localStorage.getItem(CURSOR_KEY);
  } catch {
    return null;
  }
}

function writeCursor(iso: string): void {
  try {
    localStorage.setItem(CURSOR_KEY, iso);
  } catch {
    // ignore quota errors — cursor is just an optimisation
  }
}

function snapshotPatches(keys: Iterable<keyof SyncableSlice>) {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const patches: { key: string; value: unknown }[] = [];
  for (const key of keys) {
    if (key in state) {
      patches.push({ key: String(key), value: state[key as string] });
    }
  }
  return patches;
}

async function flush(): Promise<void> {
  if (pendingKeys.size === 0) return;
  const keys = [...pendingKeys];
  pendingKeys = new Set();
  const patches = snapshotPatches(keys);
  if (patches.length === 0) return;
  try {
    const { data } = await apiClient.post<{ entries: PreferenceEntry[] }>(
      '/api/preferences',
      { patches },
    );
    const latest = data.entries.reduce(
      (acc, e) => (e.updatedAt > acc ? e.updatedAt : acc),
      readCursor() ?? '',
    );
    if (latest) writeCursor(latest);
  } catch (err) {
    log.warn('flush failed, will retry on next change', err);
    // Put the keys back so we retry on the next change cycle.
    for (const k of keys) pendingKeys.add(k);
  }
}

function scheduleFlush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flush();
  }, DEBOUNCE_MS);
}

/**
 * Apply server entries to the local Zustand store. Only known setters are
 * called; unknown keys are ignored so older clients don't crash on newer
 * preferences. Calls go through the typed setter functions to keep
 * invariants (clamps etc).
 */
function applyServerEntries(entries: PreferenceEntry[]): void {
  if (entries.length === 0) return;
  const store = useSettingsStore.getState();
  const setterByKey: Record<string, (v: unknown) => void> = {
    themeMode: (v) => store.setThemeMode(v as never),
    shadowAffectsTheme: (v) => store.setShadowAffectsTheme(!!v),
    bodyFontSize: (v) => store.setBodyFontSize(Number(v)),
    lineHeight: (v) => store.setLineHeight(v as never),
    paragraphIndent: (v) => store.setParagraphIndent(v as never),
    maxLineWidth: (v) => store.setMaxLineWidth(Number(v)),
    focusLine: (v) => store.setFocusLine(v as never),
    entityHighlight: (v) => store.setEntityHighlight(!!v),
    entityLinkInteractive: (v) => store.setEntityLinkInteractive(!!v),
    autosave: (v) => store.setAutosave(!!v),
    autoElementLinkEnabled: (v) => store.setAutoElementLinkEnabled(!!v),
    uiLocale: (v) => store.setUiLocale(v as never),
    manuscriptLocale: (v) => store.setManuscriptLocale(v as never),
    spellcheck: (v) => store.setSpellcheck(!!v),
    dateFormat: (v) => store.setDateFormat(v as never),
    modelTier: (v) => store.setModelTier(v as never),
    aiMode: (v) => {
      if (v === 'hosted' || v === 'byok') store.setAiMode(v);
    },
    byokProvider: (v) => {
      if (v === 'deepseek' || v === 'anthropic' || v === 'openai' || v === 'google') {
        store.setByokProvider(v);
      }
    },
    agentMode: (v) => {
      if (v === 'hosted' || v === 'byok') store.setAgentMode(v);
    },
    uploadFullManuscript: (v) => store.setUploadFullManuscript(!!v),
    allowWebSearch: (v) => store.setAllowWebSearch(!!v),
    requestTimeoutSec: (v) => store.setRequestTimeoutSec(Number(v)),
    orbCorner: (v) => store.setOrbCorner(v as never),
    surfaceMode: (v) => store.setSurfaceMode(v as never),
    finishNotify: (v) => store.setFinishNotify(v as never),
    editPermission: (v) => store.setEditPermission(v as never),
    agentCreateElements: (v) => store.setAgentCreateElements(!!v),
    agentEditTimeline: (v) => store.setAgentEditTimeline(!!v),
    agentWebSearch: (v) => store.setAgentWebSearch(!!v),
    shadowVoice: (v) => store.setShadowVoice(v as never),
    shadowSystemPrompt: (v) => store.setShadowSystemPrompt(String(v)),
    copilotAutoTrigger: (v) => store.setCopilotAutoTrigger(!!v),
    copilotMode: (v) => store.setCopilotMode(v as never),
    copilotTaskConfigs: (v) => {
      // Apply each known task's incoming config via setCopilotTaskConfig so
      // unknown keys (old clients, malformed payloads) get filtered safely.
      if (!v || typeof v !== 'object') return;
      const incoming = v as Record<string, { enabled?: unknown; debounceMs?: unknown }>;
      for (const [id, cfg] of Object.entries(incoming)) {
        if (!cfg || typeof cfg !== 'object') continue;
        const patch: { enabled?: boolean; debounceMs?: number } = {};
        if (typeof cfg.enabled === 'boolean') patch.enabled = cfg.enabled;
        if (typeof cfg.debounceMs === 'number' && cfg.debounceMs >= 250) {
          patch.debounceMs = cfg.debounceMs;
        }
        if (Object.keys(patch).length > 0) {
          store.setCopilotTaskConfig(id as CopilotTaskId, patch);
        }
      }
    },
    copilotGenerateSummaries: (v) => store.setCopilotGenerateSummaries(!!v),
    copilotSummarySectionSize: (v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) store.setCopilotSummarySectionSize(Math.floor(n));
    },
    copilotOutputLangByProject: (v) =>
      store.setCopilotOutputLangByProject(
        v && typeof v === 'object' ? (v as Record<string, never>) : {},
      ),
    wifiOnlySync: (v) => store.setWifiOnlySync(!!v),
    autoSnapshot: (v) => store.setAutoSnapshot(!!v),
    improveModelsWithManuscripts: (v) => store.setImproveModelsWithManuscripts(!!v),
    sendUsageStats: (v) => store.setSendUsageStats(!!v),
    sendCrashLogs: (v) => store.setSendCrashLogs(!!v),
  };

  // Suppress the store-subscription bounce-back: temporarily detach the
  // subscriber so applying remote state doesn't queue a push back to the
  // server (which would create a loop and burn updatedAt monotonicity).
  const wasSubscribed = !!unsubscribeStore;
  if (wasSubscribed) {
    unsubscribeStore?.();
    unsubscribeStore = null;
  }
  try {
    for (const entry of entries) {
      const setter = setterByKey[entry.key];
      if (setter) setter(entry.value);
    }
  } finally {
    if (wasSubscribed) subscribeStore();
  }
}

function subscribeStore(): void {
  unsubscribeStore = useSettingsStore.subscribe((next, prev) => {
    for (const key of SYNC_KEYS) {
      // Identity compare is fine for primitives and intentional state
      // replacement (Zustand replaces references on `set`).
      if ((next as unknown as Record<string, unknown>)[key] !== (prev as unknown as Record<string, unknown>)[key]) {
        pendingKeys.add(key);
      }
    }
    if (pendingKeys.size > 0) scheduleFlush();
  });
}

/**
 * Public entry point. Called once on app boot (after auth). Safe to call
 * multiple times — second invocation is a no-op.
 */
export async function startPreferencesSync(): Promise<void> {
  if (started) return;
  if (!isSyncEnabled()) return;
  started = true;

  try {
    const since = readCursor();
    const url = since
      ? `/api/preferences?since=${encodeURIComponent(since)}`
      : '/api/preferences';
    const { data } = await apiClient.get<{ entries: PreferenceEntry[] }>(url);
    applyServerEntries(data.entries);
    const latest = data.entries.reduce(
      (acc, e) => (e.updatedAt > acc ? e.updatedAt : acc),
      since ?? '',
    );
    if (latest) writeCursor(latest);
  } catch (err) {
    log.warn('initial pull failed', err);
  }

  subscribeStore();
}

/** Manual flush — useful before sign-out / app quit. */
export async function flushPreferencesSync(): Promise<void> {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  await flush();
}

/** Tear down on logout so the next user starts clean. */
export function stopPreferencesSync(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  pendingKeys = new Set();
  unsubscribeStore?.();
  unsubscribeStore = null;
  started = false;
}
